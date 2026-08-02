# Feedback (haptics)

Confirmation that something happened, on the channels this machine actually
has.

```js
HapticManager.click(button);     // press
HapticManager.toggle(el);        // state flipped
HapticManager.success(el);       // it worked
HapticManager.error(el);         // it did not
HapticManager.mirrorTap();       // a touch on the mirrored phone
```

## What "haptic" means on a desktop

Nothing vibrates. That is the whole design constraint, and it is measured
rather than assumed:

| Probe | This machine (Windows 11 desktop) |
|---|---|
| `AudioContext` | **available**, and reaches `running` — not suspended |
| `navigator.vibrate` | **present and callable** |
| `navigator.maxTouchPoints` | **0** |
| `(pointer: coarse)` | **false** |
| `navigator.playHaptics` | absent |

`navigator.vibrate` exists because Electron is Chromium. It returns `true` and
moves nothing, because a desktop has no motor. Reporting that as a working
channel is the claimed-success failure this project bans, so
`capabilitiesFrom()` requires a motor *signal* — touch points and a coarse
pointer — before it will call the channel available, and reports
`vibrateCallableButSilent` so a settings panel can explain a greyed-out control
instead of leaving the user guessing.

So on the desktop the real channels are **visual** and **audio**.

## How it is split

| Piece | File | Contains |
|---|---|---|
| Policy — which channels fire, and how they scale | `src/js/services/hapticIntent.js` | pure, no DOM |
| Performance — oscillators, CSS classes, vibrate | `src/js/services/hapticManager.js` | renderer I/O |
| Animations | `src/index.html` | renderer |

Same split as `mirrorIntent.js` / `mirrorService.js`, for the same reason: the
decisions worth testing are all in the policy half, and they are testable
without a browser.

## Decisions worth knowing

**Audio is synthesized, not sampled.** The obvious design ships six small WAVs
and fetches them. Oscillators win on every axis that matters: no binary assets
in the repo or the npm tarball, nothing to fetch so the first click is not the
slow one, intensity is a gain multiplier rather than N pre-rendered volumes, and
the sound is a handful of numbers in a table — reviewable and testable, where a
WAV is opaque and can only be checked by listening. At 6–14 ms nobody is hearing
the richness a designed sample would buy.

**`prefers-reduced-motion` gates the visual channel only.** The obvious
implementation returns early and kills all three. That is wrong, and the reason
is the point of the setting: it is a statement about *motion* — vestibular
comfort — not about feedback. Silencing audio and vibration too strips the
non-visual confirmation from the person who just said they rely less on
animation. Motion off, feedback intact. This is mutation-tested: injecting the
kill-everything bug fails three checks.

**Intensity scales loudness, never duration or pitch.** A quieter click is the
same click. Stretching it at low intensity produces a different, muddier effect
— the user asked for less, not for other. Vibration is the exception and scales
by duration, because `navigator.vibrate` gives no amplitude control; length is
the only lever it has.

**A vibration pulse never rounds down to 0.** `0` in a vibrate pattern means
*stop*. Rounding a quiet pulse to zero would turn "buzz gently" into "cancel the
current vibration" — a different command, not a quieter one.

**Sounds are capped at 150 ms.** Jarvis runs an always-on microphone, and this
project has fixed the same self-echo bug three times (the `[n]` citation loop,
the bare-numeric price echo, TTS bypassing the canceller). A feedback sound is
safe from that class for two reasons worth writing down rather than trusting: it
is a sub-150 ms non-speech transient, so faster-whisper has no phonemes to turn
into words; and it plays through WebAudio in the renderer, which *is* inside
Chromium's echo cancellation, unlike the old SAPI path. Both stop being true if
a sound grows long enough to carry structure, so the length is a bound in code
rather than a matter of taste.

**`mirror-tap` has no visual channel.** `mirrorPanel.js` already paints
`.mirror-cursor` *at the touch point*, with a pinch variant. A second,
unpositioned animation on top of the good one would be worse than nothing. The
ripple marks **where**; the sound marks **that**.

## Measured

Rendered through `OfflineAudioContext` in the real app, which renders
deterministically so the whole waveform is measurable — an `AnalyserNode` read
after the fact captures the decay and reports silence, which is what a first
attempt at this measured before it was corrected.

| Effect | Peak amplitude | Audible |
|---|---|---|
| click | 0.0404 | 6.9 ms |
| tick | 0.0223 | 2.8 ms |
| success | 0.0341 | 44.2 ms |
| error | 0.0332 | 45.4 ms |

All well inside the 150 ms bound. CSS verified separately by enumerating
`document.styleSheets` in the built page: all seven keyframe rules present.

## Not built

**The companion relay is inert, deliberately rather than accidentally.** The
desktop half exists and is tested — `companionEffectFor()` maps the semantic
vocabulary onto Android's (`EFFECT_CLICK`, compositions). The receiving half is
a Kotlin `HapticHelper` in the companion app that does not exist yet. Until it
does, `electronAPI.sendCompanionHaptic` is absent from the bridge and
`relayToCompanion()` returns `false`, which is surfaced on the returned plan as
`relayed: false`. The gap is visible rather than presenting as a buzz that never
arrives.

The phone is the one surface in Jarvis with a real motor on the other end, so
this is the highest-value remaining piece.

**Windows `InputHapticsManager`** is real, needs a haptic trackpad or mouse, and
is a native WinRT binding rather than a renderer API. Out of scope here.

**The Web Haptics API** (`navigator.playHaptics`) is real but is a WICG
incubation, not shipped in any browser as of August 2026. It is wired as a
capability probe so it lights up if it ships, and is never assumed.

## Tests

```
node src/js/services/__tests__/hapticIntent.test.mjs   # 51 checks
```

Runs under `npm test`.
