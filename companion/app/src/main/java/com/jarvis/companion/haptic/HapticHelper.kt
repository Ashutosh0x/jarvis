package com.jarvis.companion.haptic

import android.content.Context
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import org.json.JSONObject

/**
 * The phone half of the desktop's feedback vocabulary.
 *
 * WHY THIS EXISTS. On the desktop nothing vibrates — `navigator.vibrate` is
 * callable in Electron and moves nothing, because a PC has no motor. The phone
 * is the only surface in Jarvis with a real one, so a desktop interaction that
 * concerns the phone (a tap on the mirrored screen, a command that succeeded on
 * the device) can be confirmed where it can actually be felt.
 *
 * THREE TIERS, DESCENDING. Android's haptic APIs arrived over several releases
 * and the newer ones have no automatic fallback, so support is checked rather
 * than assumed:
 *
 *   API 30+  VibrationEffect.Composition — primitives with intensity, the only
 *            tier that can express "rising" or "thud" rather than "buzz for N
 *            milliseconds". No fallback of its own; must be probed.
 *   API 29+  VibrationEffect.createPredefined — system-tuned CLICK/TICK, which
 *            the OS maps onto whatever motor this device has.
 *   older    a raw millisecond duration, which is all the platform had.
 *
 * The tier is chosen per call and the one actually used is reported back, so
 * the desktop can tell a rich composition from a crude buzz instead of assuming
 * every phone felt the same thing.
 */
object HapticHelper {

    /** Effects the desktop may ask for. Anything else falls back to a tick. */
    private val KNOWN = setOf(
        "click", "tick", "heavy-click", "double-click",
        "success", "error", "notification"
    )

    private fun vibrator(context: Context): Vibrator =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            (context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager)
                .defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            context.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
        }

    /**
     * True when this device can render compositions AND the specific primitives
     * used below. `arePrimitivesSupported` is the only honest way to ask:
     * composing with an unsupported primitive is silently dropped, so a
     * composition can "succeed" and produce nothing at all.
     */
    private fun supportsComposition(v: Vibrator): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return false
        return try {
            val needed = intArrayOf(
                VibrationEffect.Composition.PRIMITIVE_CLICK,
                VibrationEffect.Composition.PRIMITIVE_TICK,
                VibrationEffect.Composition.PRIMITIVE_QUICK_RISE
            )
            v.arePrimitivesSupported(*needed).all { it }
        } catch (e: Throwable) {
            false
        }
    }

    /** What this phone can actually do — reported in `capabilities()`. */
    fun describe(context: Context): JSONObject {
        val v = vibrator(context)
        val has = try { v.hasVibrator() } catch (e: Throwable) { false }
        return JSONObject()
            .put("vibrator", has)
            .put(
                "tier",
                when {
                    !has -> "none"
                    supportsComposition(v) -> "composition"
                    Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q -> "predefined"
                    else -> "duration"
                }
            )
            .put(
                "amplitudeControl",
                try { v.hasAmplitudeControl() } catch (e: Throwable) { false }
            )
    }

    /**
     * Play one semantic effect.
     *
     * @return the tier actually used, or null when the device has no motor —
     *   never a silent success. A confirmation the user cannot feel is exactly
     *   the failure this whole path exists to avoid, so it is reported rather
     *   than swallowed.
     */
    fun fire(context: Context, rawEffect: String): String? {
        val v = vibrator(context)
        if (!v.hasVibrator()) return null

        val effect = if (rawEffect in KNOWN) rawEffect else "tick"

        if (supportsComposition(v)) {
            composition(v, effect)?.let { v.vibrate(it); return "composition" }
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            v.vibrate(VibrationEffect.createPredefined(predefinedFor(effect)))
            return "predefined"
        }
        @Suppress("DEPRECATION")
        v.vibrate(durationFor(effect))
        return "duration"
    }

    private fun predefinedFor(effect: String): Int = when (effect) {
        "tick" -> VibrationEffect.EFFECT_TICK
        "heavy-click", "notification", "error" -> VibrationEffect.EFFECT_HEAVY_CLICK
        "double-click", "success" -> VibrationEffect.EFFECT_DOUBLE_CLICK
        else -> VibrationEffect.EFFECT_CLICK
    }

    /** Pre-API-29 fallback. Crude by necessity: duration is the only lever. */
    private fun durationFor(effect: String): Long = when (effect) {
        "tick" -> 10L
        "heavy-click", "error" -> 40L
        "success", "notification" -> 30L
        else -> 20L
    }

    /**
     * Compositions for the effects where shape carries meaning.
     *
     * Direction is the whole point: success RISES and error FALLS into a thud,
     * so the two are distinguishable without being explained — the same reason
     * the desktop's success tone sweeps up and its error tone sweeps down.
     * Returns null for effects a predefined constant already renders well;
     * there is nothing to gain from composing a plain click by hand.
     */
    private fun composition(v: Vibrator, effect: String): VibrationEffect? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return null
        return try {
            when (effect) {
                "success" -> VibrationEffect.startComposition()
                    .addPrimitive(VibrationEffect.Composition.PRIMITIVE_QUICK_RISE, 0.7f)
                    .addPrimitive(VibrationEffect.Composition.PRIMITIVE_TICK, 0.5f, 60)
                    .compose()

                "error" -> VibrationEffect.startComposition()
                    .addPrimitive(VibrationEffect.Composition.PRIMITIVE_CLICK, 1.0f)
                    .addPrimitive(VibrationEffect.Composition.PRIMITIVE_CLICK, 0.6f, 90)
                    .compose()

                "notification" -> VibrationEffect.startComposition()
                    .addPrimitive(VibrationEffect.Composition.PRIMITIVE_CLICK, 0.8f)
                    .addPrimitive(VibrationEffect.Composition.PRIMITIVE_TICK, 0.4f, 70)
                    .compose()

                else -> null
            }
        } catch (e: Throwable) {
            null      // an unsupported primitive must not take the command down
        }
    }
}
