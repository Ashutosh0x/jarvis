package com.jarvis.companion.services

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.media.AudioManager
import android.os.BatteryManager
import android.os.Build
import android.speech.tts.TextToSpeech
import android.util.Log
import com.jarvis.companion.network.CommandExecutor
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale

/**
 * Maps wire commands onto Android APIs.
 *
 * Tier 1 actions work with nothing but the app installed. Tier 2 actions need
 * the AccessibilityService enabled and fail with a clear, actionable error
 * when it is not — silently doing nothing is the worst outcome here, because
 * the desktop cannot tell "tapped and nothing happened" from "not authorised".
 */
class DeviceCommandExecutor(
    private val context: Context,
    /** Pushes a visualizer mode change onto the WebView, if the UI is up. */
    private val onVisualizerMode: (String) -> Unit = {}
) : CommandExecutor {

    companion object {
        private const val TAG = "JarvisExec"
        private const val ERR_NO_A11Y =
            "AccessibilityService not enabled. Enable JARVIS Device Control under " +
                "Settings > Accessibility > Installed apps on the phone."
    }

    private var tts: TextToSpeech? = null
    private var ttsReady = false

    private val a11y: JarvisAccessibilityService?
        get() = JarvisAccessibilityService.instance

    fun initTts() {
        if (tts != null) return
        tts = TextToSpeech(context) { status ->
            ttsReady = status == TextToSpeech.SUCCESS
            if (ttsReady) tts?.language = Locale.getDefault()
        }
    }

    fun shutdown() {
        tts?.shutdown()
        tts = null
        ttsReady = false
    }

    override fun deviceInfo(): JSONObject = JSONObject()
        .put("model", "${Build.MANUFACTURER} ${Build.MODEL}")
        .put("android", Build.VERSION.RELEASE)
        .put("sdk", Build.VERSION.SDK_INT)
        .put("accessibility", JarvisAccessibilityService.isEnabled)
        .put("capabilities", capabilities())

    /**
     * What this device can actually do right now.
     *
     * Sent on connect and re-queryable, so the desktop can reason about the
     * phone ("supports screen capture but not silent install") instead of
     * firing commands blindly and interpreting failures after the fact.
     * Values are probed, not assumed — accessibility can be revoked at any
     * time and torch is genuinely absent on some devices.
     */
    private fun capabilities(): JSONObject {
        val a11y = JarvisAccessibilityService.isEnabled
        return JSONObject()
            .put("open_app", true)
            .put("list_apps", true)
            .put("clipboard", true)
            .put("battery", true)
            .put("tts", ttsReady)
            .put("flashlight", hasTorch())
            .put("volume", true)
            // Every one of these routes through the accessibility service.
            .put("ui_automation", a11y)
            .put("screenshot", a11y && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R)
            .put("read_screen", a11y)
            // Honest about the hard platform limit: a non-device-owner app
            // cannot install silently, no matter how it is packaged.
            .put("silent_install", false)
    }

    private fun hasTorch(): Boolean = try {
        val cm = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
        cm.cameraIdList.any {
            cm.getCameraCharacteristics(it)
                .get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true
        }
    } catch (e: Exception) {
        false
    }

    override fun execute(action: String, params: JSONObject, reply: CommandExecutor.Reply) {
        try {
            when (action) {
                /* ---- tier 1 ---- */
                "ping" -> reply.done(true, JSONObject().put("pong", true), null)

                "device_info" -> reply.done(true, deviceInfo(), null)

                "battery" -> reply.done(true, battery(), null)

                "clipboard_get" -> {
                    val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                    val text = cm.primaryClip?.getItemAt(0)?.coerceToText(context)?.toString() ?: ""
                    reply.done(true, JSONObject().put("text", text), null)
                }

                "clipboard_set" -> {
                    val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                    cm.setPrimaryClip(ClipData.newPlainText("JARVIS", params.optString("text")))
                    reply.done(true, null, null)
                }

                "tts" -> {
                    val text = params.optString("text")
                    if (!ttsReady) {
                        reply.done(false, null, "TTS engine not ready")
                    } else {
                        tts?.speak(text, TextToSpeech.QUEUE_ADD, null, "jarvis-${System.nanoTime()}")
                        reply.done(true, null, null)
                    }
                }

                "capabilities" -> reply.done(true, capabilities(), null)

                "list_apps" -> reply.done(true, listApps(), null)

                "flashlight" -> {
                    val on = params.optBoolean("on", true)
                    val cm = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
                    val id = cm.cameraIdList.firstOrNull {
                        cm.getCameraCharacteristics(it)
                            .get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true
                    }
                    if (id == null) {
                        reply.done(false, null, "this device has no controllable torch")
                    } else {
                        cm.setTorchMode(id, on)
                        reply.done(true, JSONObject().put("on", on), null)
                    }
                }

                "volume" -> {
                    val am = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
                    val stream = AudioManager.STREAM_MUSIC
                    val max = am.getStreamMaxVolume(stream)
                    // Accept an absolute percent or a relative step, so both
                    // "set volume to 40 percent" and "turn it up" work.
                    val target = when {
                        params.has("percent") ->
                            (params.optInt("percent") / 100f * max).toInt()
                        params.has("delta") ->
                            am.getStreamVolume(stream) + params.optInt("delta")
                        else -> am.getStreamVolume(stream)
                    }.coerceIn(0, max)
                    am.setStreamVolume(stream, target, 0)
                    reply.done(
                        true,
                        JSONObject()
                            .put("level", target)
                            .put("max", max)
                            .put("percent", Math.round(target * 100f / max)),
                        null
                    )
                }

                /**
                 * Opens an app by human name ("whatsapp", "spotify") rather
                 * than package id — the desktop should not have to know that
                 * WhatsApp is com.whatsapp.
                 */
                "open_app_by_name" -> {
                    val wanted = params.optString("name").trim().lowercase()
                    if (wanted.isEmpty()) {
                        reply.done(false, null, "no app name given")
                    } else {
                        val match = findAppByName(wanted)
                        if (match == null) {
                            reply.done(false, null, "no installed app matching '$wanted'")
                        } else {
                            val intent = context.packageManager.getLaunchIntentForPackage(match.first)
                            if (intent == null) {
                                reply.done(false, null, "'${match.second}' has no launcher activity")
                            } else {
                                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                                context.startActivity(intent)
                                reply.done(
                                    true,
                                    JSONObject().put("package", match.first).put("label", match.second),
                                    null
                                )
                            }
                        }
                    }
                }

                "launch_app" -> {
                    val pkg = params.optString("package")
                    val intent = context.packageManager.getLaunchIntentForPackage(pkg)
                    if (intent == null) {
                        reply.done(false, null, "no launchable activity for '$pkg'")
                    } else {
                        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        context.startActivity(intent)
                        reply.done(true, null, null)
                    }
                }

                "visualizer_mode" -> {
                    onVisualizerMode(params.optString("mode", "sphere"))
                    reply.done(true, null, null)
                }

                /* ---- tier 2: accessibility ---- */
                "get_layout" -> {
                    val svc = a11y ?: return reply.done(false, null, ERR_NO_A11Y)
                    reply.done(true, svc.serializeScreen(), null)
                }

                "click" -> {
                    val svc = a11y ?: return reply.done(false, null, ERR_NO_A11Y)
                    svc.tap(
                        params.optDouble("x", 0.0).toFloat(),
                        params.optDouble("y", 0.0).toFloat()
                    ) { ok -> reply.done(ok, null, if (ok) null else "gesture cancelled") }
                }

                "long_press" -> {
                    val svc = a11y ?: return reply.done(false, null, ERR_NO_A11Y)
                    svc.longPress(
                        params.optDouble("x", 0.0).toFloat(),
                        params.optDouble("y", 0.0).toFloat(),
                        params.optLong("duration", 600L)
                    ) { ok -> reply.done(ok, null, if (ok) null else "gesture cancelled") }
                }

                "swipe" -> {
                    val svc = a11y ?: return reply.done(false, null, ERR_NO_A11Y)
                    svc.swipe(
                        params.optDouble("x1", 0.0).toFloat(),
                        params.optDouble("y1", 0.0).toFloat(),
                        params.optDouble("x2", 0.0).toFloat(),
                        params.optDouble("y2", 0.0).toFloat(),
                        params.optLong("duration", 300L)
                    ) { ok -> reply.done(ok, null, if (ok) null else "gesture cancelled") }
                }

                "input_text" -> {
                    val svc = a11y ?: return reply.done(false, null, ERR_NO_A11Y)
                    val ok = svc.inputText(params.optString("text"))
                    reply.done(ok, null, if (ok) null else "no focused editable field")
                }

                "screenshot" -> {
                    val svc = a11y ?: return reply.done(false, null, ERR_NO_A11Y)
                    svc.screenshot(params.optInt("quality", 70)) { b64, err ->
                        if (b64 != null) {
                            reply.done(true, JSONObject().put("jpeg_base64", b64), null)
                        } else {
                            reply.done(false, null, err)
                        }
                    }
                }

                "global" -> {
                    val svc = a11y ?: return reply.done(false, null, ERR_NO_A11Y)
                    val name = params.optString("action")
                    val ok = svc.globalAction(name)
                    reply.done(ok, null, if (ok) null else "global action '$name' unsupported on API ${Build.VERSION.SDK_INT}")
                }

                else -> reply.done(false, null, "unknown action '$action'")
            }
        } catch (e: Exception) {
            Log.w(TAG, "command '$action' threw", e)
            reply.done(false, null, e.message ?: e.javaClass.simpleName)
        }
    }

    private fun battery(): JSONObject {
        val bm = context.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
        return JSONObject()
            .put("level", bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY))
            .put("charging", bm.isCharging)
    }

    /**
     * Resolves a spoken app name to a package. Ranked exact -> prefix ->
     * contains, because speech-to-text mangles names and "play" should not
     * beat "Play Store" on a bare substring hit.
     *
     * @return (package, label) or null
     */
    private fun findAppByName(wanted: String): Pair<String, String>? {
        val pm = context.packageManager
        val intent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        val entries = pm.queryIntentActivities(intent, 0).map {
            it.activityInfo.packageName to it.loadLabel(pm).toString()
        }

        entries.firstOrNull { it.second.equals(wanted, ignoreCase = true) }?.let { return it }
        entries.firstOrNull { it.second.lowercase().startsWith(wanted) }?.let { return it }
        entries.firstOrNull { it.second.lowercase().contains(wanted) }?.let { return it }
        // Last resort: match the package id itself ("com.whatsapp" or "whatsapp").
        return entries.firstOrNull { it.first.lowercase().contains(wanted) }
    }

    private fun listApps(): JSONObject {
        val pm = context.packageManager
        val arr = JSONArray()
        // Only launchable packages — the full package list is hundreds of
        // system entries the desktop can do nothing useful with.
        val intent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        for (ri in pm.queryIntentActivities(intent, 0)) {
            arr.put(
                JSONObject()
                    .put("package", ri.activityInfo.packageName)
                    .put("label", ri.loadLabel(pm).toString())
            )
        }
        return JSONObject().put("count", arr.length()).put("apps", arr)
    }
}
