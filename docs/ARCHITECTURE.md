# JARVIS Architecture

Internal reference for the desktop assistant, its local service mesh, the
retrieval engine, and the Android companion protocol.

Audience: someone modifying the system. For installation and usage, see the
[README](../README.md).

---

## Contents

- [Process model](#process-model)
- [Service lifecycle](#service-lifecycle)
- [IPC surface](#ipc-surface)
- [Voice pipeline](#voice-pipeline)
- [Intent routing](#intent-routing)
- [Retrieval engine](#retrieval-engine)
- [Companion protocol](#companion-protocol)
- [Security model](#security-model)
- [Performance characteristics](#performance-characteristics)
- [Extending the system](#extending-the-system)

---

## Process model

Three cooperating processes plus supervised children.

```
+-----------------------------------------------------------+
|  Electron main            electron.js                      |
|                                                            |
|  Owns: OS integration, service supervision, LAN listeners  |
|  Node.js APIs available. No DOM.                           |
+-----------------------------------------------------------+
        |  contextBridge, preload.js
        |  contextIsolation: true
        v
+-----------------------------------------------------------+
|  Renderer                 src/js/*                         |
|                                                            |
|  Owns: visualizer, voice loop, retrieval, intent routing   |
|  DOM and WebGL available. No Node.js APIs.                 |
+-----------------------------------------------------------+

Supervised children:
  ollama serve            spawned only if 11434 is idle
  uv run stt-server.py    faster-whisper, port 8770
```

### Why this split

The renderer owns retrieval rather than the main process. Retrieval is
latency-coupled to the conversation loop, and crossing the IPC boundary per
query would add serialisation cost to a path already measured in milliseconds.
The tradeoff is that BM25 scoring runs on the render thread, which is why the
inverted index matters: the previous implementation blocked the visualizer for
94ms per query at 5,000 chunks.

Persistence still crosses IPC, because the renderer has no filesystem access.
Writes are debounced by 2 seconds.

---

## Service lifecycle

### Ollama supervision

```
app.whenReady()
    |
    v
startOllamaServer()
    |
    +-- GET /api/tags, 1.5s timeout
    |       |
    |       +-- 200 --> reuse. Do not spawn. Do not kill on quit.
    |       |
    |       +-- fail --> spawn `ollama serve`
    |                        |
    |                        v
    |                   poll /api/tags every 1s, up to 30 attempts
    |                        |
    |                        v
    |                   preloadLocalModel()
    |                   POST /api/generate {keep_alive: "60m"}
    |
    +-- on exit, and not quitting --> respawn after 15s
```

Two invariants:

1. **Only kill what you spawned.** `ollamaProcess` is non-null only when this
   process created the server. An Ollama the user started stays running.
2. **Preload is not optional.** Ollama's default `keep_alive` is 5 minutes.
   Without the 60-minute preload, the first question after any idle period pays
   a multi-second cold load, which reads as a broken assistant.

### STT supervision

The server must be invoked as:

```
uv run --python 3.12 --with faster-whisper --with websockets python -I server/stt-server.py
```

The `-I` flag is load-bearing. Without isolated mode, user site-packages enter
`sys.path` and numpy, ctranslate2, or onnxruntime crash with `0xC0000005`.

Port conflicts exit with code 1 and land in the same respawn path. The retry is
harmless because the second instance exits immediately while another holds 8770.

**Known gap:** `before-quit` does not fire on force-kill, so the Python child is
orphaned and keeps 8770. The next launch then crash-loops every 15 seconds until
the orphan is stopped.

---

## IPC surface

All renderer-to-main communication passes through `preload.js` under
`contextIsolation`. The renderer never receives Node.js primitives.

### Channel categories

| Category | Channels | Notes |
| --- | --- | --- |
| System | `open-app`, `system-command`, `get-os-info`, `get-system-telemetry` | Allowlisted |
| Capture | `capture-screen`, `perform-ocr`, `check-ocr-server` | |
| Memory | `rag-load`, `rag-save`, `log-trajectory` | Debounced writes |
| Phone bridge | `get-phone-bridge-info`, `phone-notification` | |
| Companion | `companion-open-pairing`, `companion-close-pairing`, `companion-devices`, `companion-command` | |
| ADB | `adb-command` | Curated methods only |
| Vault | `secure-cred-set`, `secure-cred-list`, `secure-cred-delete` | No read channel exists |
| Network | `wifi-scan`, `wifi-connect`, `wifi-disconnect`, `wifi-info`, `web-search` | |
| Finance | `watchlist-get`, `watchlist-add`, `watchlist-remove` | Read-only |

### Listener hygiene

Event channels use `createSafeListener`, which returns a disposer:

```js
const createSafeListener = (channel) => (callback) => {
    const handler = (event, ...args) => callback(event, ...args);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
};
```

Without the disposer, repeated subscription leaks handlers across reloads.

### Deliberate omissions

- **No credential read channel.** The vault exposes set, list, and delete. Raw
  values cannot cross into the renderer, so they cannot reach the model or
  conversation memory.
- **No raw ADB passthrough.** `adb-command` rejects the `adb` and `shell`
  methods explicitly. Only curated wrappers are reachable.

---

## Voice pipeline

```
getUserMedia
    |
    v
_pickMicDevice()
    excludes: stereo mix, loopback, vb-audio, voicemeeter
    ranks:    micPreference -> headset -> internal -> first real
    |
    v
AudioContext graph
    source -> highpass 80Hz -> compressor -> analyser -> worklet
    |
    +--> analyser  --> window.jarvisFrequencyData  (visualizer)
    |
    v
capture-processor.js   PCM16 at 16kHz
    |
    v
adaptive noise-floor VAD
    threshold: 3x floor
    preroll:   320ms
    hangover:  1.44s
    cap:       30s
    gate:      suppressed while ttsActive
    |
    v
ws://127.0.0.1:8770   binary frames, then {"type":"end"}
    |
    v
faster-whisper base int8
    |
    v
{"type":"final", "text": "...", "ms": 919}
```

### Two failure modes worth understanding

**The TTS gate must not use `synthesis.speaking`.** Chromium can leave that flag
stuck true indefinitely, which permanently deafens the microphone. An explicit
`ttsActive` flag is used instead, cleared on `onend`, on `onerror`, and by a
word-count-derived safety timeout.

**The gate alone is insufficient.** SAPI audio bypasses Chromium's echo
cancellation, and the tail of an utterance can land after the flag clears.
Conversation logs contained JARVIS's own sentences appearing as user turns. The
text-level echo guard is the actual defence:

```
_rememberSpoken(text)   store word set, 20s window
_isEchoOfSelf(cmd)      drop if >= 60% overlap with anything recent
```

Transcripts under three content words are exempt, since short utterances
overlap by chance.

---

## Intent routing

`jarvis.js` `detectIntent()` matches in a deliberate order. Order is behaviour.

```
1. Phone-targeted        targetsPhone() && routePhoneCommand()
2. Companion status      /(phone|mobile|companion)/ && /(status|online|why)/
3. Companion pairing     "connect to my mobile"
4. System control        open app, shutdown, volume, brightness
5. Wi-Fi                 scan, connect, info
6. Memory                remember, recall
7. Screen                read screen, what is on my display
8. Calendar              reminders, schedule
9. Fallthrough           handleLocalAICommand()
```

Phone routing is checked first because "open chrome on my phone" must not match
the desktop application launcher. The suffix carries the target, so a matcher
that runs earlier and ignores it will silently do the wrong thing.

### The local model path

```
handleLocalAICommand(query)
    |
    +-- checkOllama()  --> unavailable? say so plainly, stop
    |
    +-- imperative prefix? --> routeLocalAction()  JSON mode, temp 0
    |       open_app | open_website | web_search | remember | recall | none
    |
    +-- ragService.recall(query, {rerank: !voice})
    |
    +-- system telemetry, if query mentions this machine
    |
    +-- web search, if query is search-shaped
    |
    v
build messages:
    system prompt + sysContext + memoryContext + webContext
    + last 10 turns, trailing user turn removed
    + current query
    |
    v
generateContentLocal()  streaming
    |
    +-- per chunk: display, then speak each completed sentence
```

### Three prompt-level corrections

Each came from reading actual conversation history, not from theory.

**The user message was sent twice.** `processAICommand` pushes the turn into
memory, then the messages array spread history *and* appended `query`. Gemma
described its input accurately: "the duplicate search query", "I have executed
the repeated command to close Chrome twice". Fixed by popping the trailing user
turn from history, keeping the append, because `query` may have been rewritten
by action routing.

**A literal `[n]` leaked into speech.** The web-search instruction contained the
token `[n]`, which the model copied into answers. Text-to-speech read it aloud as
"and one and two", the microphone transcribed it, and it re-entered as a user
turn. Fixed in the prompt and stripped in both speech paths. `speak()` and
`_speakQueued()` had drifted apart; the streaming path, which is the one Gemma
actually uses, lacked the filter.

**The model narrated actions it never took.** "Executing commands, Sir. Tab
opened, rows closed." It receives no execution feedback, so it pattern-matched an
obedient reply. The system prompt now states it cannot act and must never claim
it did.

---

## Retrieval engine

### Storage model

```js
chunk = {
    id:     "<base36 time>-<hash>",
    text:   "...",          // <= 800 chars, paragraph aligned
    hash:   "<djb2>",       // dedup key
    source: "<origin>",
    ts:     1721000000000,
    vector: [768] | null    // null until an embedder is reachable
}
```

Chunks are append-only. Array index is therefore a stable document id, which is
what allows the inverted index to store integer postings.

### Index structure

```js
_index:    Map<term, {df: number, postings: Map<chunkIdx, tf>}>
_docLen:   Array<number>
_totalLen: number
```

Built once on load, updated incrementally on ingest. Never rebuilt per query.

### BM25

```
score(d, q) = sum over t in q of
    idf(t) * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * |d| / avgdl))

idf(t) = ln(1 + (N - df + 0.5) / (df + 0.5))
k1 = 1.5,  b = 0.75
```

Iteration is over postings, not documents, so only chunks containing a query
term are touched.

**Determinism matters here.** Equal scores are common, and postings-order
traversal ranked them differently between runs. Since rank position drives
faithfulness, the same question could receive a differently ordered context each
time. Both the BM25 sort and the RRF sort tie-break on chunk index.

### Fusion

```
RRF(d) = sum over enabled lists of  weight / (60 + rank(d))

sparse  weight 1.0
dense   weight 1.0
PRF     weight 0.5
```

PRF is a separate list rather than merged into the query. A poor feedback pool
can then dilute the fusion but cannot corrupt the original query's ranking.

### Late sentence selection

After the top 5 passages are chosen, sentences are scored individually:

```
score(s) = sum of idf(t) for unique query terms t in s
score(s) *= 1 + max(0, 3 - position) * 0.08     // lead bias
```

The top 10 sentences form the context. If nothing matches lexically, which
happens on a purely dense hit, the passages are kept whole rather than returning
an empty context.

Scoring is lexical rather than neural. There is no cross-encoder in the
renderer, and a per-sentence embedding round trip costs more latency than it
returns.

### Reranking gate

```
needsRerank = (top1.score - top2.score) / top1.score < 0.15
```

When the gap is wide there is nothing to fix. When it is narrow, rank order is
fragile and worth roughly 4.8 seconds to correct. Opt-in via `{rerank: true}`;
typed input opts in, voice does not.

Failure is non-fatal by construction: timeout, non-200, unparseable JSON, or an
empty order array all return the original ordering.

### Measured baselines

| Property | Value |
| --- | --- |
| BM25 at 5,000 chunks | 0.456 ms |
| Speedup over per-query tokenisation | 230x to 320x |
| Ranking equivalence | top-10 bit-identical |
| Context reduction from sentence selection | 81 percent |
| Rerank gate firing rate | ~50 percent |
| Rerank cost when fired | ~4,800 ms |
| Gemma 3 rerank top-1 on labelled data | 3 of 3 |
| Gemma 3 source routing accuracy | 11 of 12 |
| Gemma 3 single planning call | ~3,024 ms |

The last two explain why agentic retrieval was rejected. Accuracy is adequate;
latency is not. Published A-RAG loops run 5 to 20 steps, which is 15 to 60
seconds before the first spoken word.

---

## Companion protocol

### Transport

The phone dials outward to `ws://<desktop>:8766/ws` with
`X-Jarvis-Token: <bridge token>`. The desktop compares using
`crypto.timingSafeEqual` after a length check.

Outbound-only avoids Doze restrictions, handset address churn, and the need for
a listener on the phone.

### Discovery

```
Desktop advertises:  _jarvis._tcp on port 8765
                     TXT: {ws: "8766", v: "1"}

Phone resolves, filters, and tries each address in turn.
```

Filtering happens on both sides. The desktop ranks interfaces so the Wi-Fi
address precedes virtual adapters; the phone drops `169.254.x` and
`192.168.56.x` outright, since each unreachable candidate costs a five second
connect timeout.

### Pairing

```
POST /pair
    body:  {"model": "...", "android": "..."}
    200:   {"token": "...", "wsPort": 8766}
    403:   {"error": "pairing window is closed"}
```

Open for five minutes, user-initiated. `/apk` shares the same gate.

The phone retries every 10 seconds while unpaired, and re-kicks NSD when nothing
has resolved. Pairing was originally attempted only inside the NSD callback,
which made the flow unusable: the first attempt normally arrives before the user
opens the window, receives 403, and never retried.

### Message format

Command, desktop to phone:

```json
{"id": "<hex>", "action": "open_app_by_name", "params": {"name": "settings"}}
```

Reply, phone to desktop:

```json
{"id": "<hex>", "ok": true, "result": {"package": "com.android.settings"}}
{"id": "<hex>", "ok": false, "error": "no installed app matching 'x'"}
```

Event, phone to desktop, unsolicited:

```json
{"event": "hello", "payload": {"model": "...", "capabilities": {...}}}
```

Commands carry a 20 second timeout. Pending promises are keyed by id and settled
on reply.

### Command reference

| Action | Tier | Parameters | Result |
| --- | --- | --- | --- |
| `ping` | 1 | | `{pong}` |
| `device_info` | 1 | | model, android, sdk, capabilities |
| `capabilities` | 1 | | capability map |
| `battery` | 1 | | `{level, charging}` |
| `clipboard_get` | 1 | | `{text}` |
| `clipboard_set` | 1 | `text` | |
| `tts` | 1 | `text` | |
| `list_apps` | 1 | | launchable packages |
| `open_app_by_name` | 1 | `name` | `{package, label}` |
| `flashlight` | 1 | `on` | `{on}` |
| `volume` | 1 | `percent` or `delta` | `{level, max, percent}` |
| `get_layout` | 2 | | UI tree as JSON |
| `click` | 2 | `x`, `y` | |
| `long_press` | 2 | `x`, `y`, `duration` | |
| `swipe` | 2 | `x1`, `y1`, `x2`, `y2`, `duration` | |
| `input_text` | 2 | `text` | |
| `global` | 2 | `action` | home, back, recents, notifications, lock, screenshot |
| `screenshot` | 2 | `quality` | `{jpeg_base64}` |

Tier 2 commands return a specific, actionable error when the accessibility
service is disabled, rather than failing silently.

### App name resolution

Spoken names are matched against launchable activities, ranked exact, prefix,
contains, then package id. Ranking matters: a bare substring match would let
"play" resolve to "Play Store".

### Screenshots

`AccessibilityService.takeScreenshot()` on API 30 and above, not MediaProjection.
It returns the bitmap directly, requires no foreground service, no
`mediaProjection` service type, and no per-session consent dialog. The
accessibility grant already covers it.

`android.permission.PROJECT_MEDIA` is deliberately absent from the manifest. It
is a signature permission that a normal application cannot hold.

### Asset serving

Visualizer assets load from `https://appassets.androidplatform.net/assets/...`
through `WebViewAssetLoader`, not `file://`.

The page uses `<script type="module">` with an import map. Module scripts are
fetched with CORS semantics, and a `file://` page has an opaque origin, so the
fetch is blocked and the result is a black screen with only a console error.
`allowFileAccess` and `allowContentAccess` are disabled once the loader is in
place.

---

## Security model

### Trust boundaries

```
Untrusted:  LAN peers, web search results, OCR'd document text
Trusted:    local user, main process, spawned services
```

### Controls

| Surface | Control |
| --- | --- |
| Companion WebSocket | Token, constant-time compare, closes 4001 on mismatch |
| Phone bridge | Token in header or query, except pairing routes |
| Pairing routes | Time-boxed window, user-initiated, 403 when closed |
| Application launch | Allowlist |
| ADB | Argument arrays, never string concatenation; raw passthrough disabled |
| Package names | `^[A-Za-z0-9._]+$` |
| Pairing codes | `^\d{6}$` |
| Credentials | DPAPI via `safeStorage`, no read channel |
| Clipboard secrets | Detected in main, masked hint only, never stored |
| Renderer | `contextIsolation` on, no Node.js primitives exposed |

### Residual risk, accepted

- LAN traffic is cleartext. The bridge address is DHCP-assigned and cannot be
  pinned by CIDR, so `network_security_config.xml` permits cleartext.
  Authentication is the shared token. Untrusted networks are out of scope.
- Tier 2 grants the desktop the ability to read and act on any screen, including
  banking applications. This is inherent to accessibility automation and is
  stated plainly in the service description the user must accept.

---

## Performance characteristics

Measured on the development machine, Windows 11, gemma3:4b.

| Operation | Latency |
| --- | --- |
| BM25 at 5,000 chunks | 0.5 ms |
| Full recall, no rerank | ~90 ms |
| Full recall, rerank fired | ~4,800 ms |
| STT, short utterance | 816 to 4,371 ms |
| Time to first spoken word, streaming | 1 to 2 s |
| Time to first spoken word, unstreamed | 5 to 10 s |
| Gemma planning call, JSON mode | ~3,024 ms |
| Companion command round trip | under 100 ms |
| Companion reconnect after desktop restart | 16 to 30 s, backoff |
| Companion app cold start | 1,272 ms |

### Where the time goes

The dominant cost is always local inference. Retrieval is sub-millisecond;
generation is seconds. Optimisation effort belongs on how much text reaches the
model, not on how fast candidates are found. This is why late sentence selection
matters more than any retrieval improvement: an 81 percent context reduction
translates directly into generation time.

---

## Extending the system

### Adding a voice command

1. Add a matcher in `detectIntent()`. Mind the ordering rules above.
2. Add a `case` in the `switch` in `processCommand()`.
3. Implement the handler. If it touches the OS, add an IPC channel rather than
   reaching for Node.js in the renderer.

### Adding a phone command

1. Implement it in `DeviceCommandExecutor.execute()` in Kotlin.
2. If it depends on a permission or hardware, report it in `capabilities()`.
   Probe, do not assume.
3. Add the wire name to `WIRE` and a tool entry in `PHONE_TOOLS` in
   `phoneTools.js`.
4. Add a matcher in `routePhoneCommand()` and a phrasing in `describeResult()`.

Spoken confirmations must be built from values the phone returned. Do not let
the model narrate an outcome it cannot observe.

### Adding a retrieval source

Implement a ranked list of `{i, score}` and fuse it in `recall()`:

```js
fuse(myRanks, 0.5);
```

Weight below 1.0 for derived or lower-confidence evidence. Keep the list
separate rather than merging terms into the query, so a weak source cannot
corrupt the primary ranking.

### Testing without the UI

The bridge exposes token-gated routes for headless driving:

```powershell
$token = (Get-Content "$env:APPDATA\jarvis\phone-bridge.json" -Raw | ConvertFrom-Json).token
$h = @{ "X-Jarvis-Token" = $token }

Invoke-WebRequest -Uri "http://127.0.0.1:8765/pair-window" -Method POST -Headers $h
Invoke-WebRequest -Uri "http://127.0.0.1:8765/companion/devices" -Headers $h

$body = @{ action = "battery"; params = @{} } | ConvertTo-Json
Invoke-WebRequest -Uri "http://127.0.0.1:8765/companion/command" -Method POST -Headers $h -Body $body -ContentType 'application/json'
```

The retrieval engine can be exercised outside Electron by copying
`ragService.js` to a `.mjs` file and stubbing two globals:

```js
global.localStorage = { getItem: () => null, setItem: () => {} };
global.window = { electronAPI: { ragLoad: async () => null, ragSave: async () => {} } };
const { default: rag } = await import('./ragServiceCopy.mjs');
```

This is how the index speedup and context reduction figures in this document
were produced. Prefer measuring over assuming; several entries in the roadmap
this system was built from turned out to be wrong for a 4B local model, and only
benchmarking revealed it.
