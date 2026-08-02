// Tests for haptic feedback policy.
//
// The interesting failures in a feedback system are all silent. A wrong plan
// does not throw — it just plays nothing, or plays the wrong thing, and the
// only symptom is "the app feels off". So the things pinned here are the ones
// that have no visible failure mode:
//
//  1. CHANNEL AVAILABILITY. navigator.vibrate exists on desktop and does
//     nothing. Reporting that as a working channel is the claimed-success
//     failure this project bans, so the desktop case is asserted directly.
//  2. REDUCED MOTION SCOPE. It must gate motion and NOT feedback. Killing all
//     three channels is the easy bug and it silently removes the non-visual
//     confirmation from the user most likely to want it.
//  3. BOUNDS. Audio length is what keeps feedback sounds out of the always-on
//     microphone's way; a vibrate pattern of 0 means "cancel", not "quiet".

import {
    resolvePlan,
    capabilitiesFrom,
    clampIntensity,
    scaleAudio,
    scaleVibration,
    companionEffectFor,
    EFFECT_NAMES,
    HAPTIC_LIMITS
} from '../hapticIntent.js';

let pass = 0, fail = 0;
const check = (n, c) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); };

/* --- capabilities --------------------------------------------------------- */
{
    // The desktop Electron case: Chromium exposes vibrate, no motor exists.
    const desktop = capabilitiesFrom({
        hasAudioContext: true, hasVibrate: true, hasVibrationMotor: false
    });
    check('desktop: audio is available', desktop.audio === true);
    check('desktop: visual is always available', desktop.visual === true);
    check('desktop: vibrate is NOT reported as working', desktop.vibrate === false);
    check('desktop: the callable-but-silent case is reported, not hidden',
        desktop.vibrateCallableButSilent === true);

    const phone = capabilitiesFrom({
        hasAudioContext: true, hasVibrate: true, hasVibrationMotor: true
    });
    check('phone: vibrate is available', phone.vibrate === true);
    check('phone: nothing is flagged as silent', phone.vibrateCallableButSilent === false);

    const bare = capabilitiesFrom({});
    check('no probes: audio off', bare.audio === false);
    check('no probes: vibrate off', bare.vibrate === false);
    check('no probes: visual still on', bare.visual === true);

    // Web Haptics is unshipped; it must never be assumed present.
    check('web haptics defaults to absent', bare.webHaptics === false);
    check('web haptics is reported when probed',
        capabilitiesFrom({ hasWebHaptics: true }).webHaptics === true);
}

/* --- reduced motion gates MOTION ONLY ------------------------------------- */
{
    const caps = capabilitiesFrom({
        hasAudioContext: true, hasVibrate: true, hasVibrationMotor: true
    });

    const normal = resolvePlan('success', { capabilities: caps, reducedMotion: false });
    check('normal: visual fires', normal.visual === 'haptic-success');
    check('normal: audio fires', normal.audio !== null);
    check('normal: vibration fires', normal.vibrate !== null);

    const reduced = resolvePlan('success', { capabilities: caps, reducedMotion: true });
    check('reduced motion: visual is suppressed', reduced.visual === null);
    check('reduced motion: audio SURVIVES', reduced.audio !== null);
    check('reduced motion: vibration SURVIVES', reduced.vibrate !== null);
    check('reduced motion: the effect is not suppressed wholesale',
        reduced.suppressed === null);
}

/* --- suppression reports a cause ------------------------------------------ */
{
    const caps = capabilitiesFrom({ hasAudioContext: true });

    check('unknown effect names its reason',
        resolvePlan('nope', { capabilities: caps }).suppressed === 'unknown-effect');
    check('disabled names its reason',
        resolvePlan('click', { capabilities: caps, enabled: false }).suppressed === 'disabled');
    check('zero intensity names its reason',
        resolvePlan('click', { capabilities: caps, intensity: 0 }).suppressed === 'zero-intensity');

    /* mirror-tap has no css channel by design; with audio off and no motor it
       has nothing left, and must say so rather than silently doing nothing. */
    const nothing = resolvePlan('mirror-tap', { capabilities: capabilitiesFrom({}) });
    check('an effect with no available channel reports no-channels',
        nothing.suppressed === 'no-channels');
}

/* --- intensity ------------------------------------------------------------ */
{
    check('clamps above 1', clampIntensity(5) === 1);
    check('clamps below 0', clampIntensity(-2) === 0);
    check('passes through mid-range', clampIntensity(0.4) === 0.4);
    // Non-finite must default LOUD, not silent: a corrupt setting that mutes
    // the feature looks identical to the feature being broken.
    check('NaN defaults to full, not to zero', clampIntensity(NaN) === 1);
    check('undefined defaults to full', clampIntensity(undefined) === 1);
    check('a string number is honoured', clampIntensity('0.5') === 0.5);
}

/* --- audio scaling -------------------------------------------------------- */
{
    const spec = { wave: 'sine', freq: 1000, durMs: 40, gain: 0.08, sweepTo: 1500 };

    const full = scaleAudio(spec, 1);
    const half = scaleAudio(spec, 0.5);

    check('intensity scales gain', Math.abs(half.gain - 0.04) < 1e-9);
    // Duration and pitch must NOT move: a quieter click is the same click.
    check('intensity does not change duration', half.durMs === full.durMs);
    check('intensity does not change pitch', half.freq === full.freq);
    check('the sweep target is preserved', half.sweepTo === 1500);

    const loud = scaleAudio({ ...spec, gain: 10 }, 1);
    check('gain is capped', loud.gain === HAPTIC_LIMITS.AUDIO_MAX_GAIN);

    const long = scaleAudio({ ...spec, durMs: 5000 }, 1);
    check('duration is capped', long.durMs === HAPTIC_LIMITS.AUDIO_MAX_MS);

    // Every shipped effect must already be inside the microphone-safety bound.
    let overLong = [];
    for (const name of EFFECT_NAMES) {
        const plan = resolvePlan(name, {
            capabilities: capabilitiesFrom({ hasAudioContext: true })
        });
        if (plan.audio && plan.audio.durMs > HAPTIC_LIMITS.AUDIO_MAX_MS) overLong.push(name);
    }
    check(`every effect is under the ${HAPTIC_LIMITS.AUDIO_MAX_MS}ms speech-safety bound${overLong.length ? ` — OVER: ${overLong}` : ''}`,
        overLong.length === 0);

    const missing = EFFECT_NAMES.filter((n) => {
        const p = resolvePlan(n, { capabilities: capabilitiesFrom({ hasAudioContext: true }) });
        return !p.audio;
    });
    check(`every effect has an audio channel${missing.length ? ` — MISSING: ${missing}` : ''}`,
        missing.length === 0);
}

/* --- vibration scaling ---------------------------------------------------- */
{
    check('scales by duration', JSON.stringify(scaleVibration([100], 0.5)) === '[50]');

    /* A 0 in a vibrate pattern means STOP. Rounding a quiet pulse down to 0
       would turn "buzz gently" into "cancel the current vibration" — a
       different command, not a quieter one. */
    const tiny = scaleVibration([5], 0.01);
    check('never rounds a pulse down to 0 (0 means cancel)', tiny.every((n) => n >= 1));

    const capped = scaleVibration([300, 300, 300], 1);
    const total = capped.reduce((a, b) => a + b, 0);
    check(`the whole pattern is bounded to ${HAPTIC_LIMITS.VIBRATE_MAX_MS}ms`,
        total <= HAPTIC_LIMITS.VIBRATE_MAX_MS);
    check('bounding truncates rather than distorting the head',
        capped[0] === 300);
}

/* --- the mirror's existing ripple is not doubled -------------------------- */
{
    /* mirrorPanel.js already paints `.mirror-cursor` AT the touch point, with a
       pinch variant. A css channel here would fire a second, unpositioned
       animation on top of the good one. */
    const caps = capabilitiesFrom({ hasAudioContext: true, hasVibrate: true, hasVibrationMotor: true });
    const tap = resolvePlan('mirror-tap', { capabilities: caps });
    check('mirror-tap adds NO visual (the panel already has a positioned ripple)',
        tap.visual === null);
    check('mirror-tap still gives audio confirmation', tap.audio !== null);
}

/* --- companion vocabulary ------------------------------------------------- */
{
    check('success maps across', companionEffectFor('success') === 'success');
    check('error maps across', companionEffectFor('error') === 'error');
    check('toggle folds onto click', companionEffectFor('toggle') === 'click');
    check('mirror-tap folds onto tick', companionEffectFor('mirror-tap') === 'tick');
    // An unknown effect must still buzz. A dropped confirmation reads to the
    // user as a failed action, which is worse than a slightly wrong texture.
    check('an unknown effect falls back rather than dropping',
        companionEffectFor('something-new') === 'tick');

    const unmapped = EFFECT_NAMES.filter((n) => !companionEffectFor(n));
    check(`every effect maps to a companion effect${unmapped.length ? ` — MISSING: ${unmapped}` : ''}`,
        unmapped.length === 0);
}

/* --- register effects ----------------------------------------------------- */
{
    const caps = capabilitiesFrom({
        hasAudioContext: true, hasVibrate: true, hasVibrationMotor: true
    });

    /* A WARNING MUST NOT FEEL LIKE A CONFIRMATION. It precedes a destructive
       action, so it has to be distinguishable from the effect that says "done"
       — by structure, not by volume, because volume is user-configurable. */
    const warn = resolvePlan('warn', { capabilities: caps });
    const success = resolvePlan('success', { capabilities: caps });

    check('warn has a gap in its pattern (pulse, pause, pulse)',
        warn.vibrate.length === 3);
    check('every other effect is a single gesture, so the gap is unique',
        success.vibrate.length !== 3 || success.vibrate[1] < warn.vibrate[1]);

    // Direction carries the meaning: a warning falls, a success rises.
    check('warn sweeps DOWN', warn.audio.sweepTo < warn.audio.freq);
    check('success sweeps UP', success.audio.sweepTo > success.audio.freq);
    check('warn is lower-pitched than success', warn.audio.freq < success.audio.freq);

    /* Fired on every utterance, so it must be the quietest thing here — the
       one effect where being noticeable would make it the sound of the room. */
    const ack = resolvePlan('acknowledge', { capabilities: caps });
    const others = EFFECT_NAMES
        .filter((n) => n !== 'acknowledge')
        .map((n) => resolvePlan(n, { capabilities: caps }))
        .filter((p) => p.audio);
    check('acknowledge is the quietest effect',
        others.every((p) => p.audio.gain >= ack.audio.gain));
    check('acknowledge is brief enough to sit under speech',
        ack.audio.durMs <= 10);
    check('acknowledge adds no animation (it fires while the user is talking)',
        ack.visual === null);

    // Unprompted information should read as "look up", not as "you did it".
    const attention = resolvePlan('attention', { capabilities: caps });
    check('attention rises', attention.audio.sweepTo > attention.audio.freq);
    check('attention is softer than success', attention.audio.gain < success.audio.gain);

    // A warning must not arrive on the phone as an ordinary click.
    check('warn maps to the one Android effect with an internal gap',
        companionEffectFor('warn') === 'double-click');
    check('acknowledge stays a tick on the phone',
        companionEffectFor('acknowledge') === 'tick');
    check('attention maps to notification',
        companionEffectFor('attention') === 'notification');
}

/* --- the table itself ----------------------------------------------------- */
{
    check('the effect vocabulary is non-empty', EFFECT_NAMES.length >= 7);
    check('the names are frozen', Object.isFrozen(EFFECT_NAMES));

    // Every effect needs a vibration pattern for the companion relay path.
    const caps = capabilitiesFrom({ hasVibrate: true, hasVibrationMotor: true });
    const noVibe = EFFECT_NAMES.filter((n) => !resolvePlan(n, { capabilities: caps }).vibrate);
    check(`every effect has a vibration pattern${noVibe.length ? ` — MISSING: ${noVibe}` : ''}`,
        noVibe.length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
