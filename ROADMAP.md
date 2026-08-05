# Roadmap

Ordered by what to do first. Every item names a change, not a concern.

**Each claim below was checked against the code before it was written down.**
Where a review item turned out to be already done, or wrong about this
repository, it says so instead of being copied across — a backlog that
mis-describes the code costs more than an empty one.

---

## P0 — Security

The LAN bridge sits in front of file operations, clipboard and app launch. It
is the weakest part of the system.

- [x] **Constant-time compare on the HTTP bearer path.** *Done.* It was a plain
      `!==`, which returns at the first differing byte and leaks the shared
      prefix length. The WebSocket path in `companionBridge.js` already used
      `timingSafeEqual`; the two paths guarded the same secret to different
      standards. `electron.js` now has `constantTimeEqual()`.
- [ ] **TLS on 8765/8766.** Self-signed cert on first run, SHA-256 fingerprint
      in the pairing payload, pinned in the Android client. Then *delete* the
      cleartext exemption from `network_security_config.xml` rather than
      documenting it as a limit.
- [ ] **Per-device tokens with revocation.** One shared token means one sniffed
      token compromises everything, forever. Issue per pairing, keep a device
      list, support revoke and expiry.
- [ ] **Out-of-band pairing code.** The open window is currently the only thing
      protecting `/pair`. Add a 6-digit code shown on the desktop and typed on
      the phone, plus rate limiting and lockout.
- [ ] **Bind to the chosen interface, not `0.0.0.0`,** and keep LAN listeners
      down until the user has paired at least once. Most users never pair a
      phone and should not be listening.
- [ ] **Complete the Electron hardening posture, then state it in the README.**
      Verified present: `contextIsolation: true`, `nodeIntegration: false`.
      Verified **absent**: `sandbox: true`, a renderer CSP,
      `setWindowOpenHandler` deny-all, and a `will-navigate` guard. For an
      app with microphone and screen access this is a gap in the pitch as much
      as in the code.
- [ ] **Write the trust boundary down and enforce it in a test.** Fetched web
      content and OCR'd downloads are attacker-influenced data and must not
      reach intent routing, file writes, ADB or app launch. A test that feeds a
      hostile document through ingest and asserts no action path fires is worth
      more than the prose. `groundingGuard.js` is the model to follow: the rule
      lives in code because the prompt version did not hold.
- [ ] **`safeStorage` beyond Windows.** DPAPI is documented; macOS Keychain and
      Linux libsecret differ, and on Linux `safeStorage` can silently fall back
      to weak encryption. Detect and refuse rather than storing keys under a
      guarantee that is not true on that platform.
- [ ] **Sign the builds.** Azure Trusted Signing, Apple notarization.
      "Right-click → Open" is a stopgap for a toy, not for something holding the
      microphone.
- [ ] **Supply chain.** npm provenance/sigstore attestation on publish,
      `npm audit`/OSV in CI, CycloneDX SBOM beside `SHA256SUMS`.
- [ ] **Fuzz the file-command parser.** Property-test containment against
      Unicode normalization, `CON`/`PRN`/`NUL`, trailing dots and spaces, long
      paths — and the case the existing `Desktop-evil` test does not cover:
      symlinks and NTFS junctions *inside* an allowed root.
- [ ] **Device serials into ADB.** Argument arrays stop shell injection, but a
      serial or app name arriving from speech with leading dashes is parsed by
      ADB as a flag.

## P1 — Act on evidence already collected

- [ ] **Resolve the hybrid-vs-dense contradiction.** 150–300 questions drawn
      from really ingested documents, written by a different process than the
      one that built the system, with bootstrap confidence intervals. A
      17-point gap at n=29 has a CI wide enough to drive a truck through.
- [ ] **Make the fallback structural.** Dense-primary with automatic BM25
      fallback on embedder failure gets both the accuracy and the resilience
      currently being traded for each other.
- [ ] **Kill or replace LLM reranking.** It changed zero answers and costs
      3.2s. A real cross-encoder outside Ollama — `bge-reranker-base`, int8 via
      ONNX Runtime — lands nearer 50–150ms on CPU, which is the version that
      fits on the voice path.
- [ ] **Embedder bake-off.** nomic-embed-text vs bge-m3 vs e5-large-v2 vs
      snowflake-arctic-embed. If dense retrieval carries the system, the
      embedding model matters more than the fusion constant.
- [ ] **Ablate chunking** — size, overlap, semantic vs fixed. Unmeasured, and
      usually worth more than reranking.
- [ ] **Answer-level eval.** 50–100 questions with reference answers, judged
      offline by a larger model as a one-time development step. Measures
      whether retrieval and beliefs improve the *answer* and what the
      hallucination rate is. The highest-value measurement not yet taken.
- [ ] **Measure the belief distiller, not the state machine around it.** Replay
      real anonymized transcripts and score extraction precision/recall.
- [ ] **Routing accuracy as a CI gate.** Freeze a labelled intent set, fail the
      build on regression.

## P2 — Voice, which is the actual product

- [ ] **Barge-in.** The proof is already in this repo: mirror audio through
      Chromium's render path *is* seen by the echo canceller, unlike SAPI. Move
      TTS into the renderer's WebAudio graph and the documented "no barge-in"
      limit becomes solved. Largest single UX gain available.
- [ ] **Piper for TTS** (ONNX, local, cross-platform, ~50ms/sentence). Better
      voices, no SAPI dependency, and it is what enables barge-in.
- [ ] **Demote the word-overlap echo guard to a backstop** once real AEC has
      the TTS signal as reference.
- [ ] **Streaming STT with Silero VAD endpointing.** Partial hypotheses cut
      time-to-first-word and enable early intent classification.
- [ ] **Stop hardcoding `gemma3:4b`.** Detect VRAM, offer a 12B path, measure
      the tradeoff instead of assuming.

## P3 — Scope and structure

- [ ] **Split into packages.** `jarvis-search` is already DOM-free and
      independently tested — it is the most reusable thing here and should
      stand alone. Then `jarvis-rag`, `jarvis-chain`, `jarvis-quant`.
- [ ] **Move finance and chain out of core.** Most exposed to upstream
      breakage, least related to "desktop assistant". Separated, they can go
      stale without taking voice down.
- [ ] **Resolve the `GEMINI_API_KEY` vestige** — remove it and drop `gemini`
      from the keywords, or document the cloud path honestly. `jarvis doctor`
      currently contradicts the headline claim on the same page.
- [ ] **Trim the npm README** and move the depth to a docs site. The material
      is an asset in a place nobody reaches.

## P4 — Resilience and ops

- [ ] **Nightly contract tests against every external provider,** asserting
      response *shape*, not reachability. The CXMT and DuckDuckGo failures both
      generalize to "an endpoint changed and nothing told me".
- [ ] **Runtime staleness on the venue registry** — an entry checked more than
      N days ago degrades its own confidence when spoken.
- [ ] **Persistent provider health scoring** across sessions, not within one.
- [ ] **Reap children properly.** Windows Job Objects and POSIX process groups
      so children die with the parent, plus a pidfile swept on next start. This
      deletes the orphaned-Python-on-8770 troubleshooting entry — a failure
      observed again on 2 Aug 2026, when force-killing Electron left the STT
      and TTS servers holding 8770 and 8771.
- [ ] **Dynamic port allocation with a discovery file** instead of seven fixed
      ports.
- [ ] **Opt-in, local-only crash logs** with manual export. No silent
      telemetry. There is currently no failure visibility at all.

## P5 — Testing breadth

- [ ] **Cross-platform CI matrix.** Every measurement in the README is win32.
      Run tests and smoke on macOS and Linux, or stop claiming them equally.
- [ ] **More Android devices.** One Samsung (One UI diverges hard on
      accessibility), one Pixel, one Android 8–10 device to actually validate
      `minSdk 26`. n=1 Xiaomi is a demo, not a compatibility assertion. The
      haptic tier probe is the immediate case: `HapticHelper` chooses
      composition/predefined/duration per device and has never run on hardware
      that picks anything but the first branch — nor, so far, on any hardware
      at all.
- [ ] **Golden-file tests for scrcpy protocol handling** so the pinned-jar
      upgrade path is mechanical, against a known-good frame capture.

## P6 — Features, after the above

- [ ] **OS-level alarms** via Task Scheduler / launchd / systemd timers so they
      survive app exit.
- [ ] **Base and Arbitrum whale coverage** with topic-filtered `eth_getLogs`
      subscriptions and a value prefilter before decode. The firehose problem
      is unfiltered scanning, not filtered subscription.
- [ ] **Blockscout for the fund tracer** — free and keyless on many chains,
      unblocks live tracing without an Etherscan key.
- [ ] **Turnover and transaction costs** in the risk-parity and min-variance
      output, or the weights are not actionable.
- [ ] **Desktop UI accessibility** — HUD contrast, keyboard-only operation,
      screen-reader labels. A real gap next to how carefully the audio and
      haptic channels were reasoned about.
- [ ] **Configurable persona and locale.** "Sir" should be a setting; STT/TTS
      locale should follow the system.

---

## Globe — shipped in 0.10.0, and what it still owes

Recorded here because each of these is a known gap in something already
shipping, not an idea. What landed: NASA EONET environment events, three
themes, the 11,222-company ranking crawled to disk with 10,995 validated head
offices, on-demand office photographs, and OSM campus polygons via Nominatim.

- [ ] **The company ranking goes stale and cannot refresh itself.** Prices and
      market caps are a snapshot of 5 Aug 2026. The layer is honest about the
      date, but "honest about being stale" is not the same as current. A
      refresh path that spends credits deliberately — on the visible page only,
      not all 113 — is the fix.
- [ ] **226 companies have no coordinate.** They are correctly absent rather
      than approximated, and `data/companies-hq.json` records which and why.
      The 106 name mismatches are the tractable share: a matcher that
      understands legal suffixes across scripts would recover most of them
      without loosening the country check that stops the *Reliance* class of
      error.
- [ ] **The two company answers do not talk to each other.** The crawled layer
      knows where NVIDIA is headquartered; the Places search knows what is in
      an office park in Pune. Neither can answer a question spanning both, and
      joining them needs an identity link that does not exist yet.
- [ ] **`data/` is 10 MB in git and grows with every recrawl.** Fine once,
      wrong as a habit. Either the crawl output moves to a release asset
      fetched on first run, or the file is stored in a form that diffs — the
      current single-line JSON replaces wholesale every time.
- [ ] **The fly-to can still land off-target through the typed-command path.**
      Called directly it is exact; through the intent router it has been
      observed 51–68° off. The world-space quaternion fix was necessary and is
      not sufficient, and the cause is still not found. This is the oldest open
      globe bug.
- [ ] **Labels are thinned but not viewport collision-tested,** so an oblique
      camera angle can still overlap two leader lines.

---

## Windows 11 platform (2026) — assessed, not adopted

- [ ] **`InputHapticsManager`.** Real, and the natural third channel for the
      existing haptic vocabulary. WinRT, so it needs a native binding, and it
      only fires on hardware with a haptic trackpad. Additional channel, never
      the primary one — same posture as the phone relay.
- [ ] **Windows Copilot Library OCR / Phi Silica.** On-device, NPU-backed.
      Would remove the external OCR server dependency. Requires a Copilot+ PC
      with a 40+ TOPS NPU, so it must be probed and fall back — the same
      pattern `hapticIntent.js` already uses for the vibration motor.
- [ ] **Recall / User Activity API.** Registering investigations as timeline
      entries makes Jarvis findable from Windows Search rather than a silo.
      Weigh against the privacy claim: the README's position is that nothing
      leaves the machine, and Recall is a system-wide index. Opt-in only.

### MXC — do not build the safety story on this yet

MXC is **real**: announced at Build 2026, `@microsoft/mxc-sdk` v0.6.1 on npm,
MIT, `github.com/microsoft/mxc`. Policy-driven sandboxing with several
containment backends.

But Microsoft's own repository states that **MXC is not a security boundary
yet**, that the shipped profiles are "overly permissive", and that no MXC
profile should currently be treated as a security boundary. It is in public
preview with schemas and APIs that may change before 1.0.

That inverts the recommendation it arrived with. Adopting MXC *because* it
makes desktop computer-use safe to ship would be building on a guarantee the
vendor explicitly disclaims — the same class of mistake as reporting
`navigator.vibrate` as a working channel because the method exists.

Worth prototyping behind a flag; not worth citing as containment. Revisit at
1.0, when the security-boundary language changes.
