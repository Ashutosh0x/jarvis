// Haptic feedback — the part that touches the browser.
//
// Decisions live in hapticIntent.js; this file only performs them. Keeping the
// split means the interesting rules (what reduced-motion gates, how intensity
// scales, what is capped) are tested without a DOM, and what is left here is
// mechanical enough to read.
//
// AUDIO IS SYNTHESIZED, NOT SAMPLED. The obvious design ships six small WAVs
// and fetches them. Oscillators win on every axis that matters here:
//   - no binary assets in the repo or the npm tarball
//   - nothing to fetch, so the first click is not the slow one
//   - intensity is a gain multiplier rather than N pre-rendered volumes
//   - the sound is a handful of numbers in a table, so it is reviewable and
//     testable; a WAV is opaque and can only be checked by listening
// The cost is that a synthesized click is less rich than a designed one. At
// 6-14ms nobody is hearing richness.

import {
    resolvePlan,
    capabilitiesFrom,
    clampIntensity,
    companionEffectFor
} from './hapticIntent.js';

let audioCtx = null;
let capabilities = null;
let reducedMotion = false;
let settings = { enabled: true, intensity: 1 };

/* One AudioContext, created lazily.
   Lazily because a context constructed before a user gesture starts `suspended`
   in Chromium and every sound played into it is silently dropped — the same
   autoplay-policy trap that once made Jarvis mute at startup. Creating it on
   first use means the first use is nearly always inside a real interaction. */
function ctx() {
    if (audioCtx) return audioCtx;
    const Ctor = typeof window !== 'undefined'
        && (window.AudioContext || window.webkitAudioContext);
    if (!Ctor) return null;
    try {
        audioCtx = new Ctor();
    } catch {
        audioCtx = null;      // blocked or unavailable; audio channel stays off
    }
    return audioCtx;
}

function probeCapabilities() {
    const hasAudioContext = typeof window !== 'undefined'
        && !!(window.AudioContext || window.webkitAudioContext);

    const hasVibrate = typeof navigator !== 'undefined'
        && typeof navigator.vibrate === 'function';

    /* THE HONEST BIT. navigator.vibrate is present in Electron because Electron
       is Chromium, and on a desktop it does nothing at all — there is no motor.
       There is no API that reports "a motor exists", so this is inferred from
       the platform instead of asserted: coarse pointer + touch points is the
       signature of a device that actually has one. Desktop therefore reports
       the channel as UNAVAILABLE rather than as working-but-silent. */
    const touchCapable = typeof navigator !== 'undefined'
        && (navigator.maxTouchPoints || 0) > 0;
    const coarsePointer = typeof window !== 'undefined'
        && typeof window.matchMedia === 'function'
        && window.matchMedia('(pointer: coarse)').matches;
    const hasVibrationMotor = hasVibrate && touchCapable && coarsePointer;

    const hasWebHaptics = typeof navigator !== 'undefined'
        && typeof navigator.playHaptics === 'function';

    return capabilitiesFrom({
        hasAudioContext, hasVibrate, hasVibrationMotor, hasWebHaptics
    });
}

function playAudio(spec) {
    const ac = ctx();
    if (!ac || !spec) return;
    /* A context can be suspended by policy after creation too (tab hidden,
       device change). Resuming is best-effort and must never throw into the
       caller — feedback failing is not worth breaking an interaction over. */
    if (ac.state === 'suspended') ac.resume?.().catch(() => {});

    try {
        const now = ac.currentTime;
        const dur = spec.durMs / 1000;

        const osc = ac.createOscillator();
        osc.type = spec.wave;
        osc.frequency.setValueAtTime(spec.freq, now);
        if (spec.sweepTo) {
            /* Exponential, not linear: pitch is perceived logarithmically, so a
               linear ramp sounds like it slows down as it rises. Guarded above
               zero because exponentialRampToValueAtTime throws on 0. */
            osc.frequency.exponentialRampToValueAtTime(
                Math.max(1, spec.sweepTo), now + dur
            );
        }

        const gain = ac.createGain();
        /* Attack over 1ms rather than starting at full gain. A hard start is a
           discontinuity, and a discontinuity is a click ON TOP of the click —
           audible as a thin crackle. Decay to a small non-zero floor for the
           same reason the ramp exists: exponential ramps cannot reach 0. */
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, spec.gain), now + 0.001);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);

        osc.connect(gain).connect(ac.destination);
        osc.start(now);
        osc.stop(now + dur + 0.02);
        /* Explicit teardown: an OscillatorNode is single-use, and leaving the
           connection in place holds the graph node alive. Thousands of clicks a
           session is a real number for a mirror. */
        osc.onended = () => { try { osc.disconnect(); gain.disconnect(); } catch { /* already gone */ } };
    } catch {
        /* Audio is an enhancement. Never let it surface as an error. */
    }
}

function playVisual(element, cssClass) {
    if (!element || !cssClass || !element.classList) return;
    /* Restart the animation if the class is already on. Without this, clicking
       a button twice quickly animates once — the second add is a no-op because
       the class never left. Forcing a reflow between remove and add is the
       standard way to restart a CSS animation. */
    element.classList.remove(cssClass);
    void element.offsetWidth;
    element.classList.add(cssClass);
    const clear = () => element.classList.remove(cssClass);
    element.addEventListener('animationend', clear, { once: true });
    /* Belt and braces: animationend does not fire if the element is hidden
       mid-animation, and a stuck class would freeze it mid-transform. */
    setTimeout(clear, 600);
}

function playVibration(pattern) {
    if (!pattern || !pattern.length) return;
    try { navigator.vibrate(pattern); } catch { /* not supported */ }
}

/* Relay to the phone, which has a real motor and Android's own haptic API.

   NOT YET CONNECTED, AND DELIBERATELY INERT RATHER THAN ACCIDENTALLY SO. The
   desktop half is here and tested; the receiving half is a Kotlin
   HapticHelper in the companion app that does not exist yet. Until it does,
   `sendCompanionHaptic` is absent from the bridge and this is a no-op.

   It is written this way — probe, and report whether it went anywhere — so the
   gap is visible instead of presenting as a buzz that never arrives. Returns
   false when there was nowhere to send it. */
function relayToCompanion(effect) {
    const send = typeof window !== 'undefined'
        && window.electronAPI?.sendCompanionHaptic;
    if (typeof send !== 'function') return false;
    try {
        send(companionEffectFor(effect));
        return true;
    } catch {
        return false;   // the link is down; the local channels already fired
    }
}

export const HapticManager = {
    /**
     * @param {object} opts
     * @param {boolean} [opts.enabled]
     * @param {number}  [opts.intensity] 0..1
     */
    init(opts = {}) {
        settings = {
            enabled: opts.enabled !== false,
            intensity: clampIntensity(opts.intensity ?? 1)
        };
        capabilities = probeCapabilities();

        if (typeof window !== 'undefined' && window.matchMedia) {
            const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
            reducedMotion = mq.matches;
            mq.addEventListener?.('change', (e) => { reducedMotion = e.matches; });
        }
        return capabilities;
    },

    configure(opts = {}) {
        if ('enabled' in opts) settings.enabled = opts.enabled !== false;
        if ('intensity' in opts) settings.intensity = clampIntensity(opts.intensity);
    },

    /** What this machine can actually do. Probed, not assumed. */
    capabilities() {
        if (!capabilities) capabilities = probeCapabilities();
        return capabilities;
    },

    /**
     * Fire one semantic effect.
     * @param {string} effect  see EFFECT_NAMES
     * @param {Element|null} element  the thing that was interacted with
     * @param {{companion?:boolean}} [opts]  also buzz the paired phone
     */
    fire(effect, element = null, opts = {}) {
        if (!capabilities) capabilities = probeCapabilities();

        const plan = resolvePlan(effect, {
            enabled: settings.enabled,
            intensity: settings.intensity,
            reducedMotion,
            capabilities
        });

        if (plan.suppressed) return plan;

        playVisual(element, plan.visual);
        playAudio(plan.audio);
        playVibration(plan.vibrate);
        /* Reported on the plan rather than assumed: the companion half is not
           built yet, so a caller that asked for it should be able to see that
           it did not happen. */
        const relayed = opts.companion ? relayToCompanion(effect) : false;

        return { ...plan, relayed };
    },

    click(el) { return this.fire('click', el); },
    tick(el) { return this.fire('tick', el); },
    toggle(el) { return this.fire('toggle', el); },
    success(el) { return this.fire('success', el); },
    error(el) { return this.fire('error', el); },
    wake(el) { return this.fire('wake', el); },
    notification(el) { return this.fire('notification', el); },
    /* The mirror's own ripple already marks the press point, so this adds only
       the audio confirmation — and asks the phone to buzz, which is the one
       place in Jarvis where a real motor is on the other end. */
    mirrorTap() { return this.fire('mirror-tap', null, { companion: true }); }
};

export default HapticManager;
