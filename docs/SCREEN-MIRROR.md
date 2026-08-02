# Screen mirror

Live Android screen on the desktop, with touch and keyboard control, from one
spoken sentence.

```
"mirror my phone"        -> panel slides in, phone appears
"stop mirroring"         -> session ends, nothing left on the device
"take a phone screenshot"-> grabs the current frame and describes it locally
```

Also `Alt+Shift+M` to close, and the `✕` on the panel.

## What it needs

| | |
|---|---|
| On the phone | USB debugging enabled, and this computer authorised |
| On the desktop | `adb` on PATH or at `C:\platform-tools\` (already required by Tier 3) |
| Bundled | `resources/scrcpy-server.jar` — scrcpy **3.3.3**, 90,164 bytes |

USB works out of the box. Wi-Fi works once the phone has been paired over
Wireless Debugging (`adb pair`, then `adb connect`); after that the device shows
up as `192.168.x.x:5555` and mirrors with no cable. Nothing is installed on the
phone: the jar is pushed to `/data/local/tmp` for the session and the device is
back to its original state when it ends.

## How it fits together

> **Diagram:** [Screen mirror →](ARCHITECTURE.md#8-screen-mirror)

```
phone  --H.264 over adb-->  main process  --IPC-->  renderer  --WebGL-->  canvas
                                 ^                     |
                                 +---- touch/keys -----+
```

| Piece | File | Runs in |
|---|---|---|
| Voice routing, coordinate + key mapping | `src/js/services/mirrorIntent.js` | pure, no I/O |
| scrcpy session, control injection | `mirrorService.js` | main |
| IPC wire | `electron.js`, `preload.js` | main / bridge |
| Decode, draw, input relay | `src/js/components/mirrorPanel.js` | renderer |
| Panel markup and styling | `src/index.html` | renderer |

### Why the split is where it is

The session lives in the **main** process because it needs a TCP socket to the
local ADB server on 127.0.0.1:5037, and the renderer cannot open one.

The decode lives in the **renderer** because WebCodecs is a browser API and it
hands frames to WebGL without them entering JavaScript memory. Decoding in main
would mean shipping raw frames over IPC — 1920×1080×4 bytes at 60 fps is about
500 MB/s. What crosses IPC instead is the compressed elementary stream: roughly
1 MB/s at the default 8 Mbps, one `Uint8Array` per frame, moved as a single
structured-clone memcpy.

## Decisions worth knowing

**The server jar is pinned to 3.3.3, not "latest".** `@yume-chan/scrcpy`
implements the protocol up to server 3.3.3, and scrcpy compares the client and
server version strings exactly. scrcpy 4.1 exists; dropping its jar in here does
not upgrade anything, it produces a session that dies at handshake. The jar's
SHA-256 is checked on every start, and `mirrorService.test.mjs` asserts both the
pin and the hash — a truncated or substituted jar otherwise just hangs.

**Audio is on, and it is raw PCM.** It shipped off, because Jarvis runs an
always-on microphone and phone audio out of the speakers can be transcribed
back as a user turn — the self-echo class already fixed twice here. It is on by
explicit request, with three mitigations: the mute button in the panel,
`buildMirrorOptions({audio:false})`, and the acoustic echo canceller that
already covers TTS. That last one is the real argument — WebAudio playback in
the renderer goes through Chromium's render path and *is* seen by AEC, unlike
the SAPI voice that bypassed it.

`raw` rather than `opus` because raw is PCM s16le/48 kHz/stereo, about
1.5 Mbps — free on USB or a LAN — and it skips the decoder entirely, so it adds
no codec latency. Opus would save bandwidth that is not scarce at the cost of
the one thing that is.

> **Transport verified, audible content NOT verified.** Measured: `raw`,
> 48000 Hz, 2 channels, 242 chunks / 495,616 samples in 5 s (48 kHz to within
> rounding), worklet loaded, player fed. But every sample measured was silence,
> because this device produced no capturable sound during the test — it is a
> custom AOSP ROM with no `/system/media/audio` at all, and no media session was
> running. Play anything on the phone with the mirror open to confirm the last
> step; the transport underneath it is proven.

**`maxSize` defaults to 0, meaning device native.** Measured on the 1080×2400
M2101K6P: `maxSize` caps the *longer* edge, so the obvious-looking 1920
produced **864×1920** — the setting that reads like "1080p" silently made the
picture narrower than 1080. At native size the stream measured 4.1 Mbps against
an 8 Mbps ceiling, so the downscale bought nothing.

**The video subscription is opened before `start()`, not after.** scrcpy's first
packet is the `configuration` one carrying SPS/PPS, and WebCodecs rejects every
frame with `Decoder not configured` until it arrives — but the decoder cannot be
built until the session reports which codec the device chose. Subscribing after
`start()` returned lost that packet and produced a black canvas with one warning
per frame, indefinitely, while the main process reported a perfectly healthy
session. Packets are now queued from before the handshake and replayed once the
decoder exists; the queue is bounded to one group-of-pictures, since frames older
than the newest keyframe are undecodable from cold anyway. `createPreroll()` in
`mirrorIntent.js`, with tests.

**The panel is sized from the phone, not the other way round.** The panel is
frameless — a black rectangle whose only visible content is the phone — so its
width is derived from the stage's measured height times the device aspect ratio,
giving zero letterbox bars in either direction. The height it works from is
**measured off the stage**, never derived from the window: an earlier version
computed `window.innerHeight - 36` for a top/bottom margin the frameless layout
does not have, and produced a 344px panel where the geometry wanted 360 — the
picture floated with 36px of black above and below it. Verified at 1400×1000,
1200×800 and 900×600: bars are 0 at every size.

A 20:9 phone at 100% of an 800px-tall window is 360px wide. That is the phone's
real shape, not a bug — the only way to a bigger mirror is a taller Jarvis
window. For the same reason **fullscreen adds nothing for a portrait phone on a
landscape monitor**: panel mode already uses the full height, so fullscreen only
centres the same picture on more black. It earns its place on landscape devices
and tablets.

**Rotation resizes the panel in both axes.** The decoder's `sizeChanged` fires
when the encoder restarts at the new resolution; that updates the frame size
(so touch coordinates stay correct) and refits the panel. Sizing only the width
is not enough, and this was measured: a landscape 2400×1080 stream in a
full-height 600px panel drew a 600×270 picture with **530px of black above and
below it**, and since the panel is pure black that dead space reads as a broken
mirror. `panelBoxFor()` now fits both dimensions, so there is nowhere for bars
to be — measured 1104×497 with 0 bars in landscape, 360×800 with 0 bars in
portrait, on a 1200×800 window. Width, height and top animate, so a rotation
glides rather than snaps.

There is **no minimum panel size**. One was written and the tests proved it
unreachable: a width-limited box already equals the space available, and a
height-limited one overflows the moment it grows. The only way to honour a
floor is to stretch the picture, so the aspect fit is the whole rule.

**Printable keys are sent as text, not as keycodes.** A keycode replays a
physical key and is resolved through the *device's* layout, so on a phone set to
anything but the host layout the wrong character appears. Enter, Backspace,
arrows and modifiers have no text and must be keycodes.

**The mirror parser runs above `targetsPhone`.** "mirror to my phone" satisfies
both matchers; `routePhoneCommand` has no mirror tool and returns null, so
without the ordering the command falls through to the model and gets answered
with an apology. `routing.test.mjs` drives the real `detectIntent` and asserts
both directions — the mirror wins its phrasings, and the phone tools keep
theirs.

**Right-click is Back, Escape is Back.** scrcpy convention, and it is what makes
the mirror usable. Closing is the `✕`, `Alt+Shift+M`, or "stop mirroring".

## What the LAG badge means

Glass-to-glass latency **cannot** be measured from inside the app: the device's
capture clock and the host's clock have no shared origin, so their difference is
an unknown constant.

What is measurable is how that difference *moves*. The badge shows arrival delay
above the smallest value seen this session — queueing on top of the fastest path
actually observed. A steady 0–5 ms means frames are arriving as fast as the best
case; a number that climbs and stays up means buffering somewhere. It is a real
measurement of one real thing, and it is not the end-to-end number. The label
says LAG rather than latency for exactly that reason.

FPS is `framesRendered` sampled once a second — frames actually presented, not
frames received.

## Failure messages

Each of these is produced by `mirrorService`, not the model, and names the thing
you control:

| Message | Fix |
|---|---|
| `no Android device is connected over USB or Wi-Fi ADB` | plug it in, or `adb connect` |
| `your phone has not authorised this computer` | accept the USB debugging prompt on the phone |
| `N devices are connected — say which one, or unplug the others` | ambiguity is an error here, never a coin flip |
| `the ADB server is not reachable on port 5037` | `adb start-server` (tried automatically first) |
| `does not match the pinned v3.3.3 build` | `resources/scrcpy-server.jar` was replaced |

## Tests

```
node src/js/services/__tests__/mirrorIntent.test.mjs   # parser, coords, keys
node mirrorService.test.mjs                            # jar integrity, device selection, guards
node src/js/services/__tests__/routing.test.mjs        # placement in the real detectIntent
```

All three run under `npm test`.

## Measured — Xiaomi M2101K6P (Android 16), USB, 2 Aug 2026

Driven through the shipped modules, not a harness reimplementation. The renderer
figures come from Electron's debugging port calling `window.jarvisMirror.open()`
— the same entry point the voice command uses.

| | |
|---|---|
| Resolution | **1080×2400**, device native |
| Codec | h264, WebGL frame renderer, `prefer-hardware` |
| Handshake (`startMs`) | **1078 ms** cold, **629 ms** warm |
| First frame (`firstFrameMs`) | **1289 ms** cold, **799 ms** warm |
| Frame rate | **60.5 fps** received; 49 fps presented on a live screen |
| Bitrate | **4.11 Mbps** at native size (ceiling 8 Mbps) |
| Average frame | 8,485 bytes |
| LAG badge | **1 ms** |
| Control round trip | back / home / recents / notifications / rotate, **≤1 ms** each |
| Device clock drift | pts span 6.08 s vs host span 6.02 s over a 6 s sample |

Picture verified by pixel statistics rather than by looking: the decoder's
snapshot is 1080×2400 with luma 0–255 across 16 buckets, and mean luma tracked
the device — 60 → 39 when the notification shade was opened over the control
channel, back to 60 on collapse. A frozen or blank surface cannot do that.

Cleanup confirmed on the device after `stop()`: no `app_process` left running,
`/data/local/tmp/scrcpy-server.jar` removed, nothing installed
(`pm list packages scrcpy` empty).

Note the WebGL canvas cannot be read back with `drawImage` — the renderer is
constructed with `enableCapture` off, so `preserveDrawingBuffer` is false and a
readback is black by design. Use `snapshot()`, which goes through a separate
`VideoFrame` capture path. A first attempt at verification measured the canvas
and concluded "black screen" when the picture was fine.
