package com.jarvis.companion.services

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Path
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONArray
import org.json.JSONObject

/**
 * Tier 2: UI automation over Wi-Fi with no ADB and no root.
 *
 * Held in a static so the link service can reach it — an AccessibilityService
 * is instantiated by the system, not by us, so there is no other handle to it.
 */
class JarvisAccessibilityService : AccessibilityService() {

    companion object {
        private const val TAG = "JarvisA11y"
        private const val MAX_DEPTH = 40      // guards pathological view trees
        private const val MAX_NODES = 1500    // keeps a dump inside one WS frame

        @Volatile
        var instance: JarvisAccessibilityService? = null
            private set

        val isEnabled: Boolean get() = instance != null
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        Log.i(TAG, "accessibility service connected")
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        // Intentionally passive. Streaming every content-change event over the
        // socket would flood it; the desktop pulls the tree when it needs it.
    }

    override fun onInterrupt() { /* no-op */ }

    override fun onDestroy() {
        instance = null
        super.onDestroy()
    }

    /* ---------------- gestures ---------------- */

    fun tap(x: Float, y: Float, onResult: (Boolean) -> Unit) {
        val path = Path().apply { moveTo(x, y) }
        dispatch(GestureDescription.StrokeDescription(path, 0, 60), onResult)
    }

    fun longPress(x: Float, y: Float, durationMs: Long, onResult: (Boolean) -> Unit) {
        val path = Path().apply { moveTo(x, y) }
        dispatch(GestureDescription.StrokeDescription(path, 0, durationMs), onResult)
    }

    fun swipe(x1: Float, y1: Float, x2: Float, y2: Float, durationMs: Long, onResult: (Boolean) -> Unit) {
        val path = Path().apply {
            moveTo(x1, y1)
            lineTo(x2, y2)
        }
        dispatch(GestureDescription.StrokeDescription(path, 0, durationMs.coerceAtLeast(1)), onResult)
    }

    private fun dispatch(stroke: GestureDescription.StrokeDescription, onResult: (Boolean) -> Unit) {
        val gesture = GestureDescription.Builder().addStroke(stroke).build()
        val ok = dispatchGesture(gesture, object : GestureResultCallback() {
            override fun onCompleted(gestureDescription: GestureDescription?) = onResult(true)
            override fun onCancelled(gestureDescription: GestureDescription?) = onResult(false)
        }, null)
        // dispatchGesture returns false when the service lacks canPerformGestures
        // or the screen is off — the callback never fires in that case.
        if (!ok) onResult(false)
    }

    /* ---------------- global actions ---------------- */

    fun globalAction(name: String): Boolean {
        val action = when (name.lowercase()) {
            "home" -> GLOBAL_ACTION_HOME
            "back" -> GLOBAL_ACTION_BACK
            "recents" -> GLOBAL_ACTION_RECENTS
            "notifications" -> GLOBAL_ACTION_NOTIFICATIONS
            "quick_settings" -> GLOBAL_ACTION_QUICK_SETTINGS
            "split_screen" -> GLOBAL_ACTION_TOGGLE_SPLIT_SCREEN
            "lock" ->
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) GLOBAL_ACTION_LOCK_SCREEN
                else return false
            "screenshot" ->
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) GLOBAL_ACTION_TAKE_SCREENSHOT
                else return false
            else -> return false
        }
        return performGlobalAction(action)
    }

    /* ---------------- screenshot ---------------- */

    /**
     * Captures the screen and returns it base64-encoded as JPEG.
     *
     * Uses the accessibility takeScreenshot API (API 30+) rather than
     * MediaProjection — no foreground service and no per-session consent
     * dialog, since the accessibility grant already covers it.
     */
    fun screenshot(quality: Int, onResult: (base64: String?, error: String?) -> Unit) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            onResult(null, "screenshot requires Android 11 (API 30); this device is API ${Build.VERSION.SDK_INT}")
            return
        }
        try {
            takeScreenshot(
                android.view.Display.DEFAULT_DISPLAY,
                { it.run() },
                object : TakeScreenshotCallback {
                    override fun onSuccess(screenshot: ScreenshotResult) {
                        var bitmap: android.graphics.Bitmap? = null
                        try {
                            val buffer = screenshot.hardwareBuffer
                            bitmap = android.graphics.Bitmap.wrapHardwareBuffer(
                                buffer, screenshot.colorSpace
                            )
                            if (bitmap == null) {
                                onResult(null, "could not wrap hardware buffer")
                                return
                            }
                            // Hardware bitmaps cannot be compressed directly.
                            val soft = bitmap.copy(android.graphics.Bitmap.Config.ARGB_8888, false)
                            val out = java.io.ByteArrayOutputStream()
                            soft.compress(
                                android.graphics.Bitmap.CompressFormat.JPEG,
                                quality.coerceIn(10, 100),
                                out
                            )
                            soft.recycle()
                            buffer.close()
                            onResult(
                                android.util.Base64.encodeToString(out.toByteArray(), android.util.Base64.NO_WRAP),
                                null
                            )
                        } catch (e: Exception) {
                            onResult(null, e.message ?: "screenshot encode failed")
                        } finally {
                            bitmap?.recycle()
                        }
                    }

                    override fun onFailure(errorCode: Int) {
                        // 3 == ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT: the
                        // platform rate-limits to roughly one shot per second.
                        onResult(null, "screenshot failed (code $errorCode)")
                    }
                }
            )
        } catch (e: Exception) {
            onResult(null, e.message ?: "takeScreenshot threw")
        }
    }

    /* ---------------- text entry ---------------- */

    /** Sets text on the currently focused editable node. */
    fun inputText(text: String): Boolean {
        val focused = rootInActiveWindow?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
            ?: return false
        return try {
            val args = Bundle().apply {
                putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
            }
            focused.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
        } finally {
            @Suppress("DEPRECATION")
            focused.recycle()
        }
    }

    /* ---------------- layout scraping ---------------- */

    /**
     * Serialises the active window to JSON. Only nodes that are visible and
     * carry something actionable or readable are emitted — a raw dump of every
     * node is mostly empty layout containers and blows past the frame budget.
     */
    fun serializeScreen(): JSONObject {
        val root = rootInActiveWindow
            ?: return JSONObject().put("error", "no active window")

        val nodes = JSONArray()
        val counter = intArrayOf(0)
        try {
            walk(root, nodes, 0, counter)
        } finally {
            @Suppress("DEPRECATION")
            root.recycle()
        }

        return JSONObject()
            .put("package", root.packageName?.toString() ?: "")
            .put("count", nodes.length())
            .put("truncated", counter[0] >= MAX_NODES)
            .put("nodes", nodes)
    }

    private fun walk(node: AccessibilityNodeInfo?, out: JSONArray, depth: Int, counter: IntArray) {
        if (node == null || depth > MAX_DEPTH || counter[0] >= MAX_NODES) return

        val text = node.text?.toString()
        val desc = node.contentDescription?.toString()
        val id = node.viewIdResourceName

        val interesting = node.isClickable || node.isCheckable || node.isEditable ||
            node.isScrollable || !text.isNullOrBlank() || !desc.isNullOrBlank()

        if (interesting && node.isVisibleToUser) {
            val bounds = Rect().also { node.getBoundsInScreen(it) }
            // Zero-area nodes are laid out but not on screen; clicking their
            // centre would tap the wrong thing.
            if (bounds.width() > 0 && bounds.height() > 0) {
                out.put(
                    JSONObject()
                        .put("cls", node.className?.toString()?.substringAfterLast('.') ?: "")
                        .put("text", text ?: "")
                        .put("desc", desc ?: "")
                        .put("id", id ?: "")
                        .put("clickable", node.isClickable)
                        .put("editable", node.isEditable)
                        .put("scrollable", node.isScrollable)
                        .put("checked", node.isChecked)
                        .put("x", bounds.centerX())
                        .put("y", bounds.centerY())
                        .put("bounds", JSONArray().put(bounds.left).put(bounds.top).put(bounds.right).put(bounds.bottom))
                )
                counter[0]++
            }
        }

        for (i in 0 until node.childCount) {
            val child = node.getChild(i)
            walk(child, out, depth + 1, counter)
            @Suppress("DEPRECATION")
            child?.recycle()
        }
    }
}
