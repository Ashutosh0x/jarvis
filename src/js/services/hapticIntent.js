// Haptic feedback policy — which channels fire, and with what shape.
//
// PURE. No DOM, no AudioContext, no navigator. Everything here is a function
// from (effect name, settings, environment) to a plan, so the decisions can be
// tested without a browser. `hapticManager.js` performs the plan; this file
// decides it. Same split as mirrorIntent.js / mirrorService.js.
//
// WHY A POLICY LAYER AT ALL. "Play a click" is one line. The parts that are
// actually hard are: which channels are even available on this machine, what a
// user preference means for each of them, and what an effect should sound like
// at 40% intensity. Those are decisions, they have edge cases, and they are the
// part worth pinning down in tests.
//
// THE HARDWARE SITUATION, MEASURED RATHER THAN ASSUMED:
//   - navigator.vibrate exists in Electron (it is Chromium) but a desktop PC
//     has no vibration motor, so the call succeeds and nothing happens. It is
//     a real channel on the Android companion and on mobile web, and a silent
//     no-op on the desktop app. Reporting it as "supported" because the method
//     exists would be exactly the kind of claimed-success this project bans.
//   - The Web Haptics API (navigator.playHaptics) is real but is a WICG
//     incubation, not shipped in any browser as of August 2026. It is wired as
//     a capability probe so it lights up if it ships, and is never assumed.
//   - Windows InputHapticsManager is real and needs a haptic trackpad or mouse.
//     Out of scope here: it is a native WinRT binding, not a renderer API.
//
// So on the desktop app the honest primary channels are VISUAL and AUDIO.

/* Effects are named for what happened, not for what they feel like. A caller
   asking for `success` keeps working if the shape of success changes; a caller
   asking for `doubleBuzz` pins the implementation into every call site. */

/** Audio is SYNTHESIZED, not sampled. See ATTACK/DECAY note below. */
const EFFECTS = {
    click: {
        css: 'haptic-click',
        vibrate: [10],
        // A short broadband-ish blip. Square gives it an edge that reads as
        // "mechanical" where a sine reads as "musical".
        audio: { wave: 'square', freq: 2000, durMs: 12, gain: 0.06, sweepTo: 1500 }
    },
    tick: {
        css: 'haptic-tick',
        vibrate: [5],
        audio: { wave: 'sine', freq: 2600, durMs: 6, gain: 0.035 }
    },
    toggle: {
        css: 'haptic-toggle',
        vibrate: [15],
        audio: { wave: 'triangle', freq: 1800, durMs: 14, gain: 0.05, sweepTo: 2200 }
    },
    success: {
        css: 'haptic-success',
        vibrate: [10, 20, 10],
        // Rising interval. Direction carries the meaning: up reads as resolved,
        // down as failed, and that holds without the listener being told.
        audio: { wave: 'sine', freq: 880, durMs: 90, gain: 0.05, sweepTo: 1320 }
    },
    error: {
        css: 'haptic-error',
        vibrate: [20, 10, 20],
        audio: { wave: 'sawtooth', freq: 320, durMs: 110, gain: 0.05, sweepTo: 190 }
    },
    wake: {
        css: 'haptic-wake',
        vibrate: [10, 10, 20, 10, 30],
        audio: { wave: 'sine', freq: 660, durMs: 120, gain: 0.04, sweepTo: 990 }
    },
    notification: {
        css: 'haptic-notification',
        vibrate: [50, 30, 50],
        audio: { wave: 'triangle', freq: 1200, durMs: 70, gain: 0.045, sweepTo: 1600 }
    },
    /* The mirror already paints its own press marker (`.mirror-cursor`, which
       is positioned at the touch point and has a pinch variant), so this effect
       deliberately has NO css channel — adding one would fire a second,
       unpositioned animation on top of the good one. */
    'mirror-tap': {
        css: null,
        vibrate: [5],
        audio: { wave: 'sine', freq: 2400, durMs: 5, gain: 0.03 }
    }
};

export const EFFECT_NAMES = Object.freeze(Object.keys(EFFECTS));

/* Ceilings. Not style — these are the numbers that keep the feature from
   becoming the thing you turn off.

   AUDIO_MAX_MS: Jarvis runs an always-on microphone, and this project has
   fixed the same self-echo bug three times (the `[n]` citation loop, the
   bare-numeric price echo, TTS bypassing the canceller). A feedback sound is
   safe from that class for reasons that are worth writing down rather than
   trusting: it is a sub-150ms non-speech transient, so faster-whisper has no
   phonemes to turn into words, and unlike the old SAPI path it is played
   through WebAudio in the renderer, which IS inside Chromium's echo
   cancellation. Both of those stop being true if a sound gets long enough to
   carry structure, so the length is capped here rather than left to taste. */
export const HAPTIC_LIMITS = Object.freeze({
    AUDIO_MAX_MS: 150,
    AUDIO_MAX_GAIN: 0.12,
    VIBRATE_MAX_MS: 400,
    INTENSITY_MIN: 0,
    INTENSITY_MAX: 1
});

/** Clamp to [0,1]; anything non-finite becomes 1 rather than silently 0. */
export function clampIntensity(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return HAPTIC_LIMITS.INTENSITY_MAX;
    return Math.min(HAPTIC_LIMITS.INTENSITY_MAX, Math.max(HAPTIC_LIMITS.INTENSITY_MIN, n));
}

/**
 * What this machine can actually do, from probes the caller passes in.
 * Taking them as arguments rather than reading globals is what makes this
 * testable — and it forces every capability to be a measured thing.
 *
 * @param {object} env
 * @param {boolean} env.hasAudioContext  a usable Web Audio implementation
 * @param {boolean} env.hasVibrate       navigator.vibrate is a function
 * @param {boolean} env.hasVibrationMotor  a motor is actually present
 * @param {boolean} env.hasWebHaptics    navigator.playHaptics exists (unshipped)
 */
export function capabilitiesFrom(env = {}) {
    const hasVibrate = !!env.hasVibrate;
    /* The distinction that matters. `vibrate` being callable says nothing about
       whether anything moves. Absent an explicit motor signal we assume none,
       because claiming a channel that does nothing is worse than admitting the
       platform has none. */
    const canVibrate = hasVibrate && !!env.hasVibrationMotor;
    return Object.freeze({
        visual: true,                       // CSS is always available
        audio: !!env.hasAudioContext,
        vibrate: canVibrate,
        webHaptics: !!env.hasWebHaptics,
        /* Reported so the settings panel can explain a greyed-out control
           instead of leaving the user to wonder. */
        vibrateCallableButSilent: hasVibrate && !canVibrate
    });
}

/**
 * Resolve one effect into a concrete plan.
 *
 * @returns {{effect:string, visual:string|null, audio:object|null,
 *            vibrate:number[]|null, suppressed:string|null}}
 *   `suppressed` names the reason nothing will happen, so a caller can log a
 *   real cause instead of a silent return.
 */
export function resolvePlan(effect, opts = {}) {
    const none = (reason) => ({
        effect, visual: null, audio: null, vibrate: null, suppressed: reason
    });

    const def = EFFECTS[effect];
    if (!def) return none('unknown-effect');
    if (opts.enabled === false) return none('disabled');

    const intensity = clampIntensity(opts.intensity ?? 1);
    if (intensity === 0) return none('zero-intensity');

    const caps = opts.capabilities || capabilitiesFrom({});

    /* REDUCED MOTION GATES THE VISUAL CHANNEL ONLY.
       The obvious implementation returns early here and kills everything. That
       is wrong, and the reason is the point of the setting: `prefers-reduced-
       motion` is a statement about MOTION — vestibular comfort — not about
       feedback. Silencing the audio and vibration channels too would strip the
       non-visual confirmation from the person who just told us they rely less
       on animation. Motion off, feedback intact. */
    const reduceMotion = !!opts.reducedMotion;

    const audio = (caps.audio && def.audio)
        ? scaleAudio(def.audio, intensity)
        : null;

    const vibrate = (caps.vibrate && def.vibrate)
        ? scaleVibration(def.vibrate, intensity)
        : null;

    const visual = (!reduceMotion && def.css) ? def.css : null;

    if (!visual && !audio && !vibrate) return none('no-channels');
    return { effect, visual, audio, vibrate, suppressed: null };
}

/**
 * Intensity scales LOUDNESS, never duration or pitch.
 * Stretching a click at low intensity turns it into a different, muddier
 * effect; the user asked for less, not for other.
 */
export function scaleAudio(spec, intensity) {
    const i = clampIntensity(intensity);
    const durMs = Math.min(spec.durMs, HAPTIC_LIMITS.AUDIO_MAX_MS);
    const gain = Math.min(spec.gain * i, HAPTIC_LIMITS.AUDIO_MAX_GAIN);
    return Object.freeze({
        wave: spec.wave,
        freq: spec.freq,
        sweepTo: spec.sweepTo ?? null,
        durMs,
        gain
    });
}

/**
 * Vibration scales by DURATION, because a motor has no volume control through
 * this API — length is the only lever `navigator.vibrate` gives you.
 * Never below 1ms: a 0 in a vibrate pattern means "stop", which would turn a
 * quiet pulse into a cancel.
 */
export function scaleVibration(pattern, intensity) {
    const i = clampIntensity(intensity);
    const out = pattern.map((ms) => Math.max(1, Math.round(ms * i)));
    /* Bound the whole pattern, not each entry — a long pattern of legal pulses
       is still a phone buzzing in someone's pocket for a second. */
    let total = 0;
    const capped = [];
    for (const ms of out) {
        if (total >= HAPTIC_LIMITS.VIBRATE_MAX_MS) break;
        const room = HAPTIC_LIMITS.VIBRATE_MAX_MS - total;
        capped.push(Math.min(ms, room));
        total += Math.min(ms, room);
    }
    return capped;
}

/**
 * Map a semantic effect onto the companion app's vocabulary.
 * The phone speaks Android's language (EFFECT_CLICK, compositions); the desktop
 * should not have to know that. Unknown effects fall back to `tick` rather than
 * dropping, because a missing confirmation reads as a failed action.
 */
export function companionEffectFor(effect) {
    switch (effect) {
        case 'success': return 'success';
        case 'error': return 'error';
        case 'notification': return 'notification';
        case 'toggle':
        case 'click': return 'click';
        case 'tick':
        case 'mirror-tap': return 'tick';
        case 'wake': return 'heavy-click';
        default: return 'tick';
    }
}
