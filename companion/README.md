# JARVIS Android Companion

Sends JARVIS to any Android phone on the same Wi-Fi network: the same 3D
visualizer, a persistent link to the desktop, and three tiers of device control.

## Build

```bash
cd companion
./gradlew assembleDebug          # -> app/build/outputs/apk/debug/app-debug.apk
```

Requires JDK 17+ and an Android SDK with platform 35 / build-tools 35.

> **Note:** `JAVA_HOME` on this machine points at a deleted Coursier cache path.
> Until that is fixed, set it for the build:
> ```powershell
> $env:JAVA_HOME = "C:\Program Files\Microsoft\jdk-21.0.9.10-hotspot"
> ```

## Onboarding flow

1. Say *"Jarvis, connect to my mobile"* (or call `window.jarvisCompanion.open()`).
2. Desktop opens a **5-minute pairing window** and shows a QR code.
3. Scan it with the phone camera → lands on `/install` → **Download APK** → install.
4. Open the app. It finds the desktop over mDNS, calls `POST /pair`, receives the
   bridge token, and connects to `ws://<desktop>:8766/ws`.

Nothing is handed out once the pairing window closes — `/pair` and `/apk` both
return 403. That window is the only thing standing between a LAN neighbour and
your bridge token, so it is deliberately short and user-initiated.

## The visualizer is copied, not reimplemented

| Asset | Origin | State |
|---|---|---|
| `visualizerModes.js` | `src/js/visualizerModes.js` | byte-identical |
| `three.module.js` | `node_modules/three@0.158.0` | byte-identical |
| vertex + fragment shaders | `src/index.html` | copied verbatim |
| `visualizer.js` | `src/js/scripts.js` | renderer/uniform/FFT logic preserved; desktop-only parts dropped |

`visualizerModes.js` still contains `import * as THREE from 'three'`. Rather than
edit the copy, the host page declares an **import map** resolving `three` to the
bundled module — so the file stays identical to the desktop original.

### Audio

Desktop fills `window.jarvisFrequencyData` from a WebAudio `AnalyserNode`. A
WebView cannot get mic access that way, so `AudioFft.kt` reads `AudioRecord`,
runs a radix-2 FFT, and writes the same 64 bins through `window.jarvisPushAudio`.
The `animate()` loop is unchanged — it still calls `getByteFrequencyData()`
against a shim whose buffer is already populated natively.

Bins use WebAudio's dB mapping (−100..−30 dB → 0..255), not raw linear
magnitude; with linear magnitude the orb barely moves at speaking volume.

## Structured phone tools

The desktop reasons; the phone executes. Commands are sent as structured
intents (`{tool, parameters}`), never free-form text for the phone to parse:

```
"open settings on my phone"
  -> routePhoneCommand()          src/js/services/phoneTools.js
  -> {tool: 'phone.open_app', parameters: {name: 'settings'}}
  -> companion: open_app_by_name
  -> {"package":"com.android.settings","label":"Settings"}
  -> "Settings is now open on your phone, Sir."
```

Every spoken confirmation is built from what the phone actually returned. The
LLM is deliberately not in this path — earlier conversation logs showed it
inventing outcomes ("Tab opened, rows closed") because it had no execution
feedback.

### Capability negotiation

On connect the phone reports what it can do *right now*, probed rather than
assumed. Verified output from the Xiaomi M2101K6P:

```json
{"open_app":true,"list_apps":true,"clipboard":true,"battery":true,
 "tts":true,"flashlight":true,"volume":true,
 "ui_automation":false,"screenshot":false,"read_screen":false,
 "silent_install":false}
```

Jarvis can then reason about the device instead of firing commands blindly —
a request needing accessibility explains how to enable it rather than failing
opaquely.

## Control tiers

**Tier 1 — no extra permissions.** `ping`, `device_info`, `battery`,
`clipboard_get/set`, `tts`, `list_apps`, `launch_app`, `visualizer_mode`.

**Tier 2 — requires AccessibilityService.** Enable *JARVIS Device Control* under
Settings → Accessibility → Installed apps. Adds `get_layout`, `click`,
`long_press`, `swipe`, `input_text`, `global`, `screenshot`.

**Tier 3 — requires Wireless Debugging.** Runs entirely on the desktop through
`adbService.js`: brightness, volume, keyevents, package management, file
push/pull, screenrecord.

From the desktop renderer:

```js
await window.electronAPI.companionCommand('get_layout', {});
await window.electronAPI.companionCommand('click', { x: 540, y: 1200 });
await window.electronAPI.adbCommand('setBrightnessPercent', [20]);
```

## Corrections to the source design doc

These were wrong in the spec this was built from:

- **`android.permission.PROJECT_MEDIA` is not app-declarable.** It is a
  signature/system permission. Screenshots use `AccessibilityService.takeScreenshot()`
  (API 30+) instead — it returns the bitmap directly, needs no foreground service
  and no per-session consent dialog.
- **Foreground services need a `foregroundServiceType`** plus a matching
  per-type permission on Android 14+, or they throw at runtime.
- **`bonjour` is unmaintained**; this uses `bonjour-service`.
- **Nearby Connections cannot bootstrap the APK** — correct in the doc, and the
  reason onboarding is QR-based.
- **Google AppFunctions / on-device MCP was left unimplemented** — treated as
  unverified rather than built on.

## Self-update is NOT possible the way Chrome does it

A recurring design ask is "the agent installs its own updates, like Chrome."
That does not apply here, and the difference is not a technical gap to close:

- Chrome on Android updates **through the Play Store**, which holds privileges
  no sideloaded app can obtain.
- [Google Play policy](https://support.google.com/googleplay/android-developer/answer/12085295)
  explicitly prohibits apps that self-update outside Play's mechanism.
- Silent install requires **Device Owner** provisioning (a factory-reset
  enterprise flow), not something a consumer phone grants an installed app.

What *is* achievable: the desktop can detect a version mismatch, push the new
APK over the LAN, and hand it to `PackageInstaller` — but Android will always
show a confirmation dialog the user must tap. Delta patching would cut transfer
size; it cannot remove the prompt. `capabilities.silent_install` reports `false`
so Jarvis states this honestly rather than promising a silent update.

## Known limits

- **Play Store distribution is not viable.** Google restricts accessibility APIs
  to genuine accessibility use; this is a sideload-only app.
- **Cleartext LAN traffic.** `network_security_config.xml` permits cleartext
  because the bridge is plain `http://`/`ws://` on a DHCP address that cannot be
  pinned by CIDR. Authentication is the shared bridge token. Do not use this on
  an untrusted network.
- **Import maps need a modern WebView.** Chrome 89+; fine on any Play-updated
  device, but a very old unpatched WebView will render a black screen.
- **Screenshots are rate-limited** by the platform to roughly one per second.
- `compileSdk`/`targetSdk` are 35. Moving to 36 (Android 16) requires AGP 8.9+
  and a newer Gradle.
