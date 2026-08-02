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

## Register: three effects that carry tone

Most of the vocabulary confirms a click. These three exist to say *how* rather
than *that*.

| Effect | Shape | Why |
|---|---|---|
| `warn` | pulse, **pause**, pulse — falling, low | Precedes a destructive action |
| `acknowledge` | the quietest thing here, 8 ms | "Heard you", fired on transcript |
| `attention` | rises, but softer than success | Unprompted information |

**`warn` is the only effect with a gap in it.** Everything else is a single
gesture, so a gap is unlike the rest of the vocabulary and cannot be mistaken
for an ordinary confirmation — which is the entire point of a warning. It is
also the lowest and slowest tone, because a warning that sounds like a success
is worse than no warning. Direction does the work: **a warning falls, a success
rises**, and that holds without the listener being told. On the phone it maps to
`double-click`, the one Android predefined effect with an internal gap.

**`acknowledge` fires on every utterance**, before an answer exists. Speech has
no click of its own, so without it the gap between speaking and the first word
back is indistinguishable from not being heard. It is deliberately the quietest
entry in the table and carries no animation — anything more would become the
sound of the room. Asserted in tests rather than left to judgement: no other
effect may be quieter.

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

## The phone, where there is a real motor

`HapticManager.mirrorTap()` and anything else passing `{companion: true}`
relays to the paired phone. It rides the **existing** authenticated command
channel — `companionCommand('haptic', {effect})` — rather than opening a second
route, so it inherits the same token and the same bounds. No new IPC handler
exists for it.

`preload.js` exposes it fire-and-forget on purpose: it is called from inside
pointer handlers, and a rejected promise from a phone that just disconnected
must never surface as an error in the middle of a click.

### Three tiers, descending

Android's haptic APIs arrived over several releases and the newer ones have no
automatic fallback, so `HapticHelper.kt` probes rather than assumes:

| Tier | Requires | What it can express |
|---|---|---|
| `composition` | API 30+ **and** the specific primitives | rise, fall, thud — shape, not just duration |
| `predefined` | API 29+ | system-tuned CLICK / TICK / HEAVY_CLICK |
| `duration` | anything older | a raw millisecond buzz |

Composition support is checked with `arePrimitivesSupported`, which is the only
honest way to ask: composing with an unsupported primitive is **silently
dropped**, so a composition can "succeed" and produce nothing at all.

`fire()` returns the tier it actually used, and `null` when the device has no
motor — reported back over the wire rather than swallowed, because a
confirmation nobody feels is the exact failure this path exists to prevent. The
tier also appears in `capabilities()`, so the desktop can tell a rich
composition from a plain buzz instead of assuming every phone felt the same
thing.

Success **rises** and error **falls**, matching the desktop's tones, so the two
are distinguishable without being explained.

> **Compiled, not yet felt.** `:app:assembleDebug` is green, `HapticHelper.class`
> is in the APK and `android.permission.VIBRATE` is in the merged manifest — but
> no device was attached when this was written, so nothing has been verified
> vibrating on real hardware. The desktop half is measured; this half is built
> and unproven.

## Not built

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
