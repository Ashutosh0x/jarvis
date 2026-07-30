# Releasing

Every tagged release produces signed-where-possible installers for Windows,
macOS and Linux, publishes them to GitHub Releases with checksums and
auto-update metadata, and verifies the artifacts before anyone can download
them.

## Contents

- [Cutting a release](#cutting-a-release)
- [What gets built](#what-gets-built)
- [Building locally](#building-locally)
- [Code signing](#code-signing)
- [macOS notarization](#macos-notarization)
- [Auto-update](#auto-update)
- [Verifying a download](#verifying-a-download)
- [Troubleshooting](#troubleshooting)

---

## Cutting a release

```bash
npm version 1.2.0 --no-git-tag-version    # updates package.json
git commit -am "release: 1.2.0"
git tag v1.2.0
git push origin master --tags
```

`release.yml` takes it from there. The `verify` job runs first and fails fast on
the two mistakes that are expensive to discover late:

- the tag is not semver (`1.2.3`, or `1.2.3-beta.1`)
- the tag and `package.json` version disagree

That second check matters more than it looks. If they diverge, the published
`latest.yml` advertises a version the installed binary does not report, and
every client re-downloads the same update forever.

Pre-release tags publish as GitHub pre-releases and feed the matching updater
channel, so a beta tester is never silently moved onto stable.

| Tag | Channel | GitHub |
| --- | --- | --- |
| `v1.2.0` | stable | release |
| `v1.2.0-beta.1` | beta | pre-release |
| `v1.2.0-nightly.3` | nightly | pre-release |

---

## What gets built

| Platform | Artifacts |
| --- | --- |
| Windows | `Jarvis-Setup-<version>-x64.exe` (NSIS), `Jarvis-Portable-<version>-x64.exe`, `Jarvis-<version>-x64.zip` |
| macOS | `Jarvis-<version>-universal.dmg`, `Jarvis-<version>-universal.zip` — one universal build for Apple Silicon and Intel |
| Linux | `Jarvis-<version>-x64.AppImage`, `.deb`, `.rpm`, `.tar.gz` |
| All | `SHA256SUMS`, `latest.yml`, `latest-mac.yml`, `latest-linux.yml` |

---

## Building locally

```bash
npm run icon                # regenerate build/icon.png
npm run dist:win            # or dist:mac, dist:linux
npm run checksums           # write release/SHA256SUMS
npm run checksums:verify    # re-hash and compare
npm run smoke               # launch the packaged app and assert it starts
```

You can only build for macOS on macOS — code signing and DMG creation need
Apple tooling. Windows and Linux can cross-build from most hosts, but the CI
matrix builds each on its own runner, which is the configuration actually
tested.

### Two build steps that are not optional

```bash
node scripts/prepare-native-deps.mjs
```

`@napi-rs/canvas` (reached through `pdf-to-img` → `pdfjs-dist`, used for PDF
OCR) declares 11 platform variants as `optionalDependencies`. npm installs only
the host's — correct behaviour — but electron-builder's collector walks the
declared list and dies on the first absent directory:

```
ENOENT: no such file or directory, scandir '.../@napi-rs/canvas-android-arm64'
```

Neither `npmRebuild: false` nor a `files` negation avoids it; the collector
resolves the dependency tree before any file filter applies. The script writes
empty, valid stub packages for the absent ones. Nothing ships in them.

```bash
npm run icon
```

`build/icon.png` is generated, not committed, and is the single source
electron-builder derives `.ico`, `.icns` and the Linux PNG set from. Replace it
with your own ≥1024×1024 square PNG if you have artwork — a build will not
overwrite it, only `npm run icon` does.

---

## Code signing

Signing is **optional everywhere**. With no secrets configured the pipeline
still produces complete, usable, unsigned artifacts — a fork with no
certificate must not have a red release.

### Windows

| Secret | Value |
| --- | --- |
| `CSC_LINK` | base64 of your `.pfx`, or an https URL to it |
| `CSC_KEY_PASSWORD` | its password |

```bash
base64 -w0 certificate.pfx        # paste into the CSC_LINK secret
```

### macOS

| Secret | Value |
| --- | --- |
| `CSC_LINK` | base64 of your Developer ID `.p12` |
| `CSC_KEY_PASSWORD` | its password |

Unsigned builds still install. Windows SmartScreen warns on first run
(**More info → Run anyway**); macOS needs **right-click → Open**, or:

```bash
xattr -dr com.apple.quarantine /Applications/Jarvis.app
```

The release notes say so automatically when `CSC_LINK` is absent.

---

## macOS notarization

Runs from `scripts/notarize.cjs` in electron-builder's `afterSign` hook, and
only when all three secrets are present:

| Secret | Where it comes from |
| --- | --- |
| `APPLE_ID` | your Apple Developer account email |
| `APPLE_APP_SPECIFIC_PASSWORD` | appleid.apple.com → Sign-In and Security → App-Specific Passwords |
| `APPLE_TEAM_ID` | Developer portal → Membership |

Missing any one of them logs which are missing and skips. It takes several
minutes when it does run — Apple's service, not the build.

The Hardened Runtime entitlements are in `build/entitlements.mac.plist`. Each
is present because a feature breaks without it: microphone for the wake word,
`apple-events` for "open chrome", `network.server` for the LAN companion
bridge, JIT for V8.

---

## Auto-update

`electron-updater` reads the `latest*.yml` that electron-builder publishes
beside each release. It is wired in `electron.js` (`startUpdateChecks`) and
checks once a minute after launch, then every six hours.

**Downloads are explicit, never automatic.** This is a voice assistant that may
be mid-sentence; swapping the binary under a running conversation to save one
restart is not a trade worth making. The renderer drives it:

```js
await window.electronAPI.updateStatus();     // { status, version }
await window.electronAPI.updateDownload();   // start the download
await window.electronAPI.updateInstall();    // quit and install
window.electronAPI.onUpdateStatus(state => …);
```

Update checks are skipped entirely when `app.isPackaged` is false, because a
dev run has no feed and would only log a confusing 404.

---

## Verifying a download

```bash
sha256sum -c SHA256SUMS --ignore-missing
```

CI generates `SHA256SUMS` after collecting all three platforms' artifacts and
then **re-verifies it**, failing the release on any mismatch. A checksum file
that is generated and never checked proves only that bytes exist, not that the
bytes published are the bytes built.

---

## Troubleshooting

**`ENOENT ... scandir '@napi-rs/canvas-*'`**
Run `node scripts/prepare-native-deps.mjs` first. See above.

**`configuration.linux.desktop has an unknown property`**
electron-builder 26 nests raw `.desktop` keys under `entry:`. Putting them at
the top level fails schema validation.

**`npm ci` fails with EUSAGE on Linux/macOS**
Known defect: `package-lock.json` is out of sync with `package.json` on
non-Windows — it is missing the platform-gated electron-builder packages.
Windows npm reports the same lockfile as fine, which is why it went unnoticed.
Every workflow uses `npm install` for this reason. Regenerating the lockfile
needs a clean checkout on Linux.

**The installed app crashes immediately**
Almost certainly a missing file in `electron-builder.yml`'s `files` list. The
main process requires eleven sibling CommonJS modules; if one is not packaged,
the app dies at its first `require`. `npm run smoke` catches this — it is the
reason that script exists.

**The app starts but STT/TTS never come up**
The Python servers ship in `extraResources`, not inside the asar, because `uv`
resolves them from disk. Check `resources/server/*.py` exists in the install
directory.
