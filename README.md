# JARVIS - Local-First Desktop Assistant

<p align="center">
  <img src="https://img.shields.io/badge/Electron-47848F?style=for-the-badge&logo=electron&logoColor=white" alt="Electron" />
  <img src="https://img.shields.io/badge/Vite-646CFF?style=for-the-badge&logo=vite&logoColor=white" alt="Vite" />
  <img src="https://img.shields.io/badge/Three.js-000000?style=for-the-badge&logo=three.js&logoColor=white" alt="Three.js" />
  <img src="https://img.shields.io/badge/Node.js-5FA04E?style=for-the-badge&logo=node.js&logoColor=white" alt="Node.js" />
  <img src="https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black" alt="JavaScript" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Ollama-000000?style=for-the-badge&logo=ollama&logoColor=white" alt="Ollama" />
  <img src="https://img.shields.io/badge/Gemma%203-4285F4?style=for-the-badge&logo=google&logoColor=white" alt="Gemma 3" />
  <img src="https://img.shields.io/badge/OpenAI%20Whisper-412991?style=for-the-badge&logo=openai&logoColor=white" alt="faster-whisper" />
  <img src="https://img.shields.io/badge/Python-3776AB?style=for-the-badge&logo=python&logoColor=white" alt="Python" />
  <img src="https://img.shields.io/badge/WebGL-990000?style=for-the-badge&logo=webgl&logoColor=white" alt="WebGL" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Google%20Calendar-4285F4?style=for-the-badge&logo=googlecalendar&logoColor=white" alt="Google Calendar API" />
  <img src="https://img.shields.io/badge/Google%20Meet-00897B?style=for-the-badge&logo=googlemeet&logoColor=white" alt="Google Meet API" />
  <img src="https://img.shields.io/badge/OAuth%202.0%20%2B%20PKCE-EB5424?style=for-the-badge&logo=auth0&logoColor=white" alt="OAuth 2.0 with PKCE" />
  <img src="https://img.shields.io/badge/Web%20Audio-FF3E00?style=for-the-badge&logo=webaudio&logoColor=white" alt="Web Audio API" />
  <img src="https://img.shields.io/badge/npm-CB3837?style=for-the-badge&logo=npm&logoColor=white" alt="npm" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Spotify-1DB954?style=for-the-badge&logo=spotify&logoColor=white" alt="Spotify Web API" />
  <img src="https://img.shields.io/badge/Android-34A853?style=for-the-badge&logo=android&logoColor=white" alt="Android" />
  <img src="https://img.shields.io/badge/Kotlin-7F52FF?style=for-the-badge&logo=kotlin&logoColor=white" alt="Kotlin" />
  <img src="https://img.shields.io/badge/Gradle-02303A?style=for-the-badge&logo=gradle&logoColor=white" alt="Gradle" />
  <img src="https://img.shields.io/badge/OkHttp-3E4348?style=for-the-badge&logo=square&logoColor=white" alt="OkHttp" />
  <img src="https://img.shields.io/badge/WebSocket-010101?style=for-the-badge&logo=socketdotio&logoColor=white" alt="WebSocket" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-Windows%2011-0078D6?style=flat-square&logo=windows&logoColor=white" alt="Platform" />
  <img src="https://img.shields.io/badge/runs-100%25%20offline-success?style=flat-square" alt="Offline" />
  <img src="https://img.shields.io/badge/cloud%20API-none-critical?style=flat-square" alt="No cloud" />
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@ashutosh0x/jarvis"><img src="https://img.shields.io/npm/v/@ashutosh0x/jarvis?style=flat-square&color=CB3837&logo=npm&logoColor=white" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@ashutosh0x/jarvis"><img src="https://img.shields.io/npm/dm/@ashutosh0x/jarvis?style=flat-square&color=CB3837&logo=npm&logoColor=white" alt="npm downloads" /></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A522-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node 22+" />
  <img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License" />
</p>

## Install

```bash
npm install -g @ashutosh0x/jarvis
jarvis
```

Or without installing anything permanently:

```bash
npx @ashutosh0x/jarvis
```

**No API key is required to start.** Web search works out of the box. Every key
you add unlocks a feature, and the app degrades honestly without one rather than
erroring — run `jarvis doctor` to see exactly what is and is not available on
your machine:

```
  Jarvis 0.1.0

  Runtime
    ✓ Node                   v22.14.0
    ✓ Platform               win32 x64
    ✓ Electron               installed
    ✓ Interface built
    ✓ jarvis command         %LOCALAPPDATA%\Jarvis\bin\jarvis.cmd

  Optional services
    · GEMINI_API_KEY         unset — conversational answers disabled
    ✓ Ollama                 http://127.0.0.1:11434
    · SearXNG                unset — using public search providers
```

Everything marked `·` is optional.

### The `jarvis` command

Whichever way you install it, `jarvis` becomes a command you can type in any
terminal. Installing an app normally gives you a Start-menu entry, not a
command, so setup closes that gap itself: it writes a small launcher to a
per-user directory and puts that directory on your PATH.

| | |
|---|---|
| Windows | `%LOCALAPPDATA%\Jarvis\bin\jarvis.cmd`, registered in `HKCU\Environment` |
| macOS / Linux | `~/.local/bin/jarvis`, with a guarded block in your shell rc if that directory is not already on PATH |

```bash
jarvis link      # do it now, if setup could not
jarvis unlink    # undo it completely
jarvis doctor    # shows where the command resolves from
```

What it will not do:

- **No `setx`.** It truncates PATH at 1024 characters and rewrites
  `REG_EXPAND_SZ` as `REG_SZ`, so `%VAR%` entries stop expanding. The registry
  is written directly, preserving the original value kind. (The PATH on the
  machine this was built on is 2,152 characters — `setx` would have destroyed it.)
- **No elevation, no machine-wide change.** `HKCU` only.
- **No second `jarvis`.** If one is already on PATH — `npm i -g` puts one there —
  it is left alone and reported rather than shadowed.
- **No claimed success.** The previous PATH is saved to disk first, the new value
  is read back after writing, and the change is verified against the *stored*
  PATH rather than this process's environment.

A shell inherits its environment when it starts, so **the terminal you ran it
from cannot see the change** — open a new one. Every message says so rather than
implying otherwise.

> The package bundles Electron, so the first install downloads a platform
> binary (~100 MB). That is the price of `npm i -g` producing a working app
> instead of a list of instructions. Prefer a native installer? See
> [releases](https://github.com/Ashutosh0x/jarvis/releases) for signed `.exe`,
> `.dmg`, `.AppImage`, `.deb` and `.rpm` builds, each with a SHA-256 checksum.

### Use the search engine as a library

The search engine has **no Electron dependency and no DOM** — it is plain Node,
independently tested, and installable on its own terms:

```js
import { search } from '@ashutosh0x/jarvis';

const { results, answer, providers } = await search('rust async runtime comparison');
console.log(answer);      // extracted answer, or null
console.log(providers);   // ['crates', 'github', 'hn', …]
```

<details>
<summary><b>Individual exports</b></summary>

```js
import {
  rrfFuse,          // Reciprocal Rank Fusion, k=60
  bm25Search,       // BM25, k1=1.2 b=0.75
  editDistance,     // Damerau-Levenshtein
  isTimeSensitive,  // does this answer change by the hour?
  gatherAll,        // parallel provider fan-out, returns on quorum
  SearchCache,
  hedgedRace,       // race N RPC endpoints, take the first good one
} from '@ashutosh0x/jarvis';

import { stats, rollup } from '@ashutosh0x/jarvis/metrics';
```

**Search** — `search`, `buildProviders`, `detectIntents`, `isTimeSensitive`,
`gatherAll`, `rrfFuse`, `bm25Search`, `rankResults`, `dedupeResults`,
`extractAnswer`, `verifyAnswer`, `providerWeights`, `editDistance`,
`shouldApplyCorrection`, `htmlToText`, `SearchCache`

**Metrics** — `stats`, `windowed`, `rollup`, `rollupByDay`, `pruneRaw`, `makeSample`

**Networking** — `hedgedRace`, `createStickyOrder`, `backoffDelay`,
`createDedup`, `createBlockTracker`, `prioritizeAlerts`

**Market analytics** — `dailyReturns`, `correlation`, `beta`, `peerIndex`,
`realizedVol`, `trailingReturn`, `drawdown`, `PEER_GROUPS`

</details>

The full architecture, feature reference and configuration guide follow below.

---

JARVIS is a desktop assistant whose intelligence runs entirely on your own
machine. Speech recognition, language understanding, retrieval, and vision all
execute locally. No model API keys, no network calls to a model provider, and no
conversation data leaving the device.

Some features ask the outside world for facts it alone has — a share price, a
headline, the state of a blockchain. Those calls send a ticker or an address and
nothing else: no transcript, no memory, no conversation. Everything else works
with the network unplugged.

It presents as a frameless, transparent 3D visualizer that floats above your
desktop, listens continuously, and answers by voice. A companion Android app
extends the same interface and control surface to a paired phone over Wi-Fi,
and a spoken "mirror my phone" puts that phone's live screen on the desktop
with touch and keyboard control.

---

## Contents

- [Install](#install)
- [What makes this different](#what-makes-this-different)
- [Architecture](#architecture)
- [Feature reference](#feature-reference)
- [Calendar and meetings](#calendar-and-meetings)
- [On-chain intelligence](#on-chain-intelligence)
- [Web search](#web-search)
- [Retrieval engine](#retrieval-engine)
- [Evaluation](#evaluation)
- [Android companion](#android-companion)
- [Screen mirror](#screen-mirror)
- [Routing](#routing)
- [Music](#music)
- [Installation](#installation)
- [Running](#running)
- [Configuration](#configuration)
- [Network ports](#network-ports)
- [Troubleshooting](#troubleshooting)
- [Known limits](#known-limits)

---

## What makes this different

Most assistants send your microphone to a datacenter. This one does not.

| Capability | Typical assistant | JARVIS |
| --- | --- | --- |
| Speech to text | Cloud ASR | faster-whisper, local |
| Language model | Hosted API | Gemma 3 via Ollama, local |
| Embeddings | Hosted API | nomic-embed-text, local |
| Vision / screen reading | Cloud vision | Gemma 3 multimodal, local |
| Conversation storage | Provider servers | Local disk only |
| Works without internet | No | Yes, except live data lookups |
| Per-query cost | Metered | Zero |

Outbound traffic is limited to fact lookups that cannot be answered locally:
keyless web search when a query is search-shaped, quote and news endpoints, and
blockchain RPC. Each sends only the subject of the question — a ticker, a
search string, an address. Inference never leaves the machine.

---

## Architecture

### System overview

> **Diagram:** [System overview →](docs/ARCHITECTURE.md#1-system-overview)

| Colour | Layer |
| --- | --- |
| Purple | Renderer. Visualizer, voice loop, retrieval, intent routing |
| Cyan | Electron main. Service supervision, IPC, LAN listeners |
| Green | Local inference. Everything bound to loopback |
| Light green | Android companion, reached over Wi-Fi |
| Red | External network. The single outbound path |
| Amber | Local persistence |

The Electron main process (`electron.js`) supervises every local service and
restarts them on failure. The renderer owns the visualizer, voice loop, and
retrieval.

### Voice pipeline

> **Diagram:** [Voice pipeline →](docs/ARCHITECTURE.md#2-voice-pipeline)

Two feedback loops are load-bearing. The dashed edges back into the VAD and echo
guard are what stop JARVIS transcribing its own voice, and both are required:
the `ttsActive` gate leaks because synthesised audio bypasses Chromium echo
cancellation, so the text-level guard catches what the gate misses.

### Process supervision

> **Diagram:** [Process supervision →](docs/ARCHITECTURE.md#3-process-supervision)

Two invariants are encoded above. **Only kill what you spawned:** an Ollama the
user started is reused and left running on quit. **Preload is not optional:**
Ollama's default `keep_alive` is 5 minutes, so without the 60-minute preload the
first question after any idle period pays a multi-second cold load.

On launch, `electron.js` starts and monitors:

| Service | Behaviour on failure |
| --- | --- |
| Ollama | Reuses an existing instance if one is running; otherwise spawns `ollama serve`, waits for readiness, preloads the model with `keep_alive: 60m`, and auto-respawns after 15s |
| faster-whisper STT | Auto-respawns after 15s; port conflicts exit harmlessly |
| Phone bridge | Token-authenticated HTTP listener |
| Companion bridge | WebSocket server plus mDNS advertisement |
| Downloads watcher | chokidar; new documents are OCR'd and ingested |
| Clipboard monitor | Scans for leaked secrets, reports masked hints only |
| Active window tracker | 10s cadence |
| Finance service | 60s quote cadence |

Services that JARVIS spawns are terminated on quit. Services it merely reused,
such as an Ollama you started yourself, are left running.

---

## Feature reference

### Voice

Open conversation mode. Every transcript is routed and answered; no wake word
is required. Leading "Jarvis" and common mis-hearings are stripped.

- Always-on microphone with adaptive noise-floor VAD
- Deliberate microphone selection, excluding loopback devices such as Stereo Mix
  which would otherwise capture JARVIS listening to itself
- Streaming speech: each completed sentence is spoken during token generation,
  cutting time-to-first-word from roughly 5-10s to 1-2s
- Echo guard using word-overlap against recently spoken text, because the
  synthesis-active flag alone is known to leak
- Self-healing microphone recovery with a 5s watchdog for eventless device death

### Visualizer

- Icosahedron with Perlin-noise vertex displacement driven by live FFT
- Bass, mid, and treble bands weighted separately
- Frequency-mapped colour, with time-based hue cycling when idle
- Transparent frameless window that floats over other applications
- F2 toggles between orb-only and full HUD

### Feedback

> **Full write-up:** [docs/FEEDBACK.md](docs/FEEDBACK.md)

Confirmation on the channels the machine actually has. Nothing vibrates on a
desktop — `navigator.vibrate` is callable in Electron and moves nothing,
because there is no motor — so a press is carried by a short animation and a
synthesized click, and the vibration channel reports itself unavailable rather
than pretending.

- Every heard utterance gets an instant 8 ms acknowledgement, before the answer
  exists. Speech has no click of its own, so the gap before the first word back
  was otherwise indistinguishable from not being heard
- Every unprompted event — a phone notification, a download, a whale transfer,
  a price alert — carries the same rising marker
- Destructive actions get the one effect with a **gap** in it: pulse, pause,
  pulse, falling and low. Every other effect is a single gesture, so it cannot
  be mistaken for a confirmation. A warning falls; a success rises
- Audio is synthesized rather than sampled: no binary assets, nothing to fetch,
  and the sound is a table of numbers that can be reviewed and tested
- `prefers-reduced-motion` gates the animation only. It is a statement about
  motion, not about feedback, and silencing the audio would strip the
  non-visual confirmation from the user who just asked for less movement
- The paired phone has a real motor, and gets the same vocabulary mapped onto
  Android's own haptic API — probed by primitive, not by API level

### System control

- Application launch through an allowlist
- Volume, brightness, media keys, power state
- Wi-Fi scan, connect to saved profiles, disconnect, and measured link
  diagnostics reporting real latency and packet loss
- File operations, clipboard read and write
- Windows Settings deep links
- Live CPU, RAM, uptime, and active window telemetry in the HUD

### Files and folders

Create folders and files by voice, anywhere inside your own user folders.

```
"create a folder called notes on the desktop"
"make a file called todo.txt in documents"
"make a file called shopping list saying milk and eggs"
```

- Parsing is rule-based, never model-driven. These commands write to disk, and
  a model deciding what "create a file called that thing" means is a model
  deciding what to name a file on your Desktop
- Confined to Desktop, Documents, Downloads, Pictures, Videos and Music.
  Containment is checked at a path-separator boundary, so `~/Desktop-evil` is
  not treated as `~/Desktop`
- An existing file is never silently overwritten
- Executable types (`.exe`, `.bat`, `.vbs`) are refused. Source files are not —
  writing `.js` is the point, and a `.js` is only dangerous when something runs
  it, which JARVIS never does
- A name that does not survive sanitising is reported, not replaced with a
  fallback. A file called `untitled` appearing because a name was misheard is
  worse than being told the name was not understood

### Writing code

```
"open vscode and write a binary search in java"
"write a quicksort in python on the desktop"
```

Gemma writes the file contents; the filename, directory and language are fixed
by rule before the model is asked anything. Java and C# get PascalCase names
because those languages resolve the type by filename. The file opens in VS Code
when an editor was named, and VS Code is resolved to the real `Code.exe` rather
than shelling out to the `code` shim.

If the model returns nothing, no file is created — an empty file reported as
success would be a lie.

### Alarms and timers

```
"set a timer for 40 minutes"
"set an alarm for tomorrow at 2:30 pm"
"set an alarm for an hour and a half"
"set a timer for twenty minutes to check the oven"
"cancel the timer"   ·   "what timers do I have"   ·   "stop"
```

- Scheduled to the exact instant rather than polled, so a 30-second timer works
- Persists across restarts, and a missed alarm is announced on return rather
  than silently dropped
- Fires with speech, a synthesised tone and a notification; each is independent,
  so a suspended AudioContext does not suppress the other two
- Repeats every five seconds until dismissed, stopping after two minutes
- An unresolvable time is refused. "Set a timer for the pasta" asks how long
  instead of choosing a duration

> [!NOTE]
> Alarms fire only while JARVIS is running. This is a renderer-side scheduler,
> not an OS-level alarm.

### Calendar and meetings

```
"connect my calendar"
"what are my meetings"        ·   "when is my next meeting"
"schedule a meeting"
"create a meet room"
"I know about the meeting"
```

Scheduling is a conversation. JARVIS asks what to call it, what it is about,
when, how long, and who to invite, then reads the whole thing back before
creating anything:

```
You    schedule a meeting
JARVIS Of course, Sir. What should I call this meeting?
You    project review
JARVIS "Project review". And what is this meeting about?
You    Q3 roadmap and hiring
JARVIS Noted. When should I schedule it, Sir?
You    tomorrow at 3 pm
JARVIS 3:00 PM tomorrow. How long should it run?
You    an hour
JARVIS Anyone to invite? Say their email addresses, or "no one".
You    no one
JARVIS "Project review", 3:00 PM tomorrow for 1 hour, ending 4:00 PM.
       About: Q3 roadmap and hiring. Shall I create it, Sir?
You    yes
JARVIS Creating it now, Sir.
```

- Background awareness escalates rather than repeats: one warning at 30 minutes,
  then 10, 5 and 1, each phrased differently. Eight identical five-minute
  reminders train you to ignore the one that matters
- The calendar is fetched every five minutes, but checked against local clocks
  every twenty seconds, so alert timing does not depend on when a network call
  landed
- A failed poll keeps the last known schedule. Announcing "no meetings today"
  because one fetch failed would be a fabrication
- Spoken email addresses work — "john at example dot com" — and an address that
  cannot be parsed is refused rather than quietly inviting nobody
- The model is asked for exactly one thing: a better title when you gave a
  generic one, which you then confirm. Nothing that lands in your calendar is
  model-decided

> [!IMPORTANT]
> Creating a **Google Meet link** requires a paid Google Workspace account. On a
> personal Gmail the event is created without one — the API returns no link and
> no error — and JARVIS says so rather than implying a link exists.

### Running in the background

```
"start with windows"     ·   "don't start with windows"
"hide yourself"          ·   click the tray icon to bring it back
```

Closing the window hides JARVIS to the tray rather than quitting, so alarms
still fire and meetings are still watched. Only **Quit Jarvis** from the tray
menu actually exits.

- Autostart is registered through the OS login-items API, and starts hidden —
  someone who wanted a window on every boot would not need autostart
- A **single-instance lock** is claimed before anything else. This is not a
  nicety: JARVIS spawns a speech server, a TTS server, a vision server and
  Ollama on fixed ports, and runs a microphone listener and an alarm scheduler.
  Autostart plus a manual launch is the ordinary case on day one, and a second
  instance would fight the first for all of it. Launching again surfaces the
  running window instead
- Autostart can only be registered from an **installed build**. In a
  development run `process.execPath` is `electron.exe`, and registering there
  would put a bare Electron runtime in your startup that launches and shows
  nothing. JARVIS refuses and says so, rather than leaving an entry that looks
  installed and does nothing

### What JARVIS can reach

JARVIS runs as **you**, not as Administrator, and that is deliberate.

Unelevated already covers everything you do day to day: your files, launching
programs, reading the process list and network state, the microphone and the
screen. What it does not cover is writing to `Program Files`, the Windows
directory, or another user's data — none of which JARVIS has a reason to touch.

Running it elevated would mean a misheard word, or anything that reached the
renderer through a web result, inherits Administrator. JARVIS acts on speech
recognition, which mishears; that is the whole reason the file commands are
rule-parsed and the write path is allowlisted in the first place.

To widen its reach, name the directories:

```
JARVIS_EXTRA_ROOTS=D:\Projects;C:\Work
```

Absolute paths, semicolon-separated. A relative entry is dropped with a warning
rather than resolved against the working directory, because a typo'd `Work`
becoming `<cwd>/Work` would grant a directory nobody chose. Point it at a drive
root if you genuinely want that — the difference that matters is that it is
your decision, written down, rather than an implicit consequence of enabling
autostart.

### Screen and documents

- Screen reading through Gemma 3 vision, fully offline. The captured question is
  passed through, so "what error is showing" reaches the model intact
- Optional Unlimited-OCR server for dense text
- Downloads are watched, OCR'd, and ingested into memory automatically
- Your Android screen, live on the desktop with touch and keyboard control —
  see [Screen mirror](#screen-mirror). "take a phone screenshot" grabs the
  current frame and describes it through the same local vision path

### Knowledge

- Hybrid retrieval over local memory, detailed below
- Keyless web search with a three-provider failover chain — DuckDuckGo HTML,
  DuckDuckGo Instant Answer, then Wikipedia — injected as cited context for
  search-shaped queries. The chain exists because the HTML endpoint starts
  serving a captcha once an IP is flagged, which silently emptied every result
- Finance watchlist with crossing alerts. Read-only by design: no order
  placement code exists anywhere in the project

### Markets and quantitative analysis

Every number here is computed by tested code from measured data. The language
model is never asked to calculate a financial figure, because it cannot be
trusted with one and a wrong figure stated confidently is worse than no answer.

- Live quotes with day change, resolved name to ticker
- **Single security** — `src/js/services/quant.js`: annualised return,
  volatility, Sharpe, Sortino, maximum drawdown, beta and alpha against a
  benchmark, correlation, R², historical VaR, expected shortfall, information
  ratio, tracking error, up/down capture, and Black-Scholes pricing with greeks
- **A book of holdings** — `src/js/services/portfolio.js`: covariance,
  risk contribution, risk parity, minimum variance, maximum Sharpe,
  diversification ratio, and portfolio-level VaR and expected shortfall
- **A name against its peers** — `sectorMove.js`: how much of a move the sector
  explains and how much belongs to the company
- SEC filings through a pinned fetch guard, `edgarGuard.js`
- **Disclosure venues beyond EDGAR** — see below
- Headlines from Google News with Bing failover, keyless

Three choices in here are load-bearing rather than incidental.

**VaR is historical simulation, never parametric.** The Gaussian form
(`mu - z*sigma`) is one line shorter and wrong in exactly the situation the
number exists for: return distributions have fat tails, so it understates the
99th percentile precisely when that matters. The implementation reads the
quantile off the observed returns and refuses fewer than 30 observations rather
than resting a 99% loss estimate on a single bad day.

**R² gates the interpretation of beta and alpha.** Measured against the S&P 500
over 250 sessions, Micron's R² is 0.283 — the benchmark explains 28% of its
variance, so its beta of 3.29 and alpha of 170% are weakly determined and are
reported as such. Without that gate the assistant would speak a 170% alpha as
though it meant something.

**Dollar weight is not risk weight.** A 60/40 book is roughly a 94% equity-risk
book, which is arithmetic rather than opinion: it is what `riskContributions()`
returns for those weights, and it is checked against that case in the tests.

---

### Peer and portfolio analysis

Two questions the single-security metrics cannot answer, each with its own
module and voice intent.

`SECTOR_QUERY` — *"decompose Micron's move"*, *"break down the memory sector"*.
The move is split into the part the peer group explains (beta times the sector's
move) and the part that belongs to the company. Measured 29 July 2026: Micron
fell 9.94% while its peer group fell 4.96%; with a beta of 0.91 that leaves
-5.40% as its own, while Western Digital's flat day was +4.77% of relative
strength. Group mode ranks every member by that residual, because the largest
faller is often just the highest beta.

`PORTFOLIO_QUERY` — *"how risky is my watchlist"*, *"what would risk parity
do"*, *"minimum variance weights for MU, SNDK, WDC"*. Holdings are aligned by
date, never by index, because two venues do not share a trading calendar. The
covariance inverse refuses a singular matrix rather than returning the enormous
offsetting weights that a collinear book produces, and a short position in the
minimum-variance solution is surfaced rather than clipped — "hold none" and
"sell short" are different instructions.

Both modules state their limits instead of implying them with a null. A holding
that only listed three weeks ago truncates every other series to match; the
analysis names it and says that dropping it would widen the window.

---

### Disclosure venues beyond EDGAR

The memory industry is mostly not American, so an EDGAR-only assistant answers
"no filings" for half of it and is wrong every time. `edgarGuard.js` carries a
venue registry naming where each issuer's filings actually live, and every
entry records the date it was checked rather than a permanent claim.

| Issuer | Venue | Reachable how |
| --- | --- | --- |
| Micron, Sandisk, Western Digital | SEC EDGAR | Atom feeds, keyless, declared User-Agent |
| SK hynix | Both — SEC since 9 Jul 2026, and DART | 6-K and 424B4 on EDGAR; business reports on DART |
| Samsung Electronics | Korea's DART | Open API, free key required |
| CXMT | Shanghai STAR Market since 27 Jul 2026 | HTML announcements only |
| YMTC | None — privately held | No public filings of any kind |

Probed live on 30 July 2026, because pasted endpoint lists have been wrong
repeatedly in this project:

- **HKEX** publishes real RSS. Two feeds are wired and return 25 parsed items
  each. They are exchange-wide, not per-company.
- **DART** advertises no RSS anywhere. Its Open API is real and returns clean
  JSON, but rejects unregistered callers with `{"status":"010"}`. The key is
  free, so this follows the Alchemy and Helius pattern: dormant without one,
  and it says so rather than failing obscurely.
- **SSE** serves announcements as HTML only — no feed, no public API.
- **SZSE** does not complete a fetch from here at all.

The registry exists because of a specific failure. Its first version asserted
that CXMT was "a private Chinese DRAM maker with no US listing." That was true
when written and false three days later: CXMT listed on the STAR Market on
27 July 2026, rose 466% on debut, and now trades as `688825.SS`. A registry
that hardcodes a company's status will state a falsehood the moment that status
changes, so entries carry a venue and a checked-on date instead.

---

## On-chain intelligence

Read-only by construction. Only a hard allowlist of JSON-RPC read methods is
ever sent; there is no signing code, no transaction construction, and no private
key handling anywhere in the project.

The governing rule is the same one the quant engine follows: **the chain is the
source of truth, and anything the chain cannot prove is not claimed.** An
address with no ENS name stays an address. No exchange or entity is ever named
from a guess.

### Address and contract reads

- Native and ERC-20 balances, gas, nonce, across Ethereum, Arbitrum, Base,
  Optimism, Polygon and BNB Chain
- ENS forward and reverse resolution, implemented from a pure keccak-256 in
  `src/js/services/keccak.js` and verified against public vectors
- Transaction decode: status, native value, and every ERC-20/721 Transfer in the
  receipt, resolved to symbols and exact decimal amounts
- Contract classification through ERC-165 `supportsInterface` and an ERC-20
  probe. Classification only; this is not a vulnerability auditor
- Cross-chain portfolio. With an Alchemy key this returns everything a wallet
  holds, priced; without one it falls back to scanning known tokens per chain
- Solana wallet assets and recent activity through Helius, including native SOL
  balance and USDC/USDT supply

### Real-time whale stream

A websocket subscription to new block headers. Each confirmed block is scanned
for large movements, and everything announced is a fact read out of that block.

> **Diagram:** [Real-time whale stream →](docs/ARCHITECTURE.md#4-real-time-whale-stream)

- **Token flows, not just native.** Most large value on Ethereum moves as
  stablecoins. Sampled over five live blocks: 0-2 native ETH whales versus 16
  token movements
- **Token decimals are verified on chain** with a `decimals()` call before any
  amount is decoded. Reading a 6-decimal token as 18 turns $4M into $4
- **One transaction is one movement.** An arbitrage route through several pools
  emits the same tokens repeatedly; a live drill caught the same 14,050 WETH
  being announced three times. Transfers are now grouped per transaction, the
  source is the address that only sends, the destination the one that only
  receives, and the hop count and any round trip are stated
- **Ranked across assets by measured USD.** 100 ETH has more raw units than
  4,000,000 USDC, so unit ordering picks the wrong headline
- **Stablecoin issuance.** A mint is a Transfer from the zero address and a burn
  is one to it, so supply changes need no label database. Live-verified against
  mainnet: a 5,414,317 USDC mint, and in one hour DAI net +6.9M against USDC net
  -6.0M
- **Address context on both ends**: ENS name, contract or wallet via
  `eth_getCode`, transactions sent, ETH held. The display carries full addresses
  and the transaction hash; speech carries the readable form
- **Operational hardening**: exponential backoff with jitter, 30s heartbeat and
  90s silence detection, gap detection with in-order backfill through the same
  code path as live blocks, and bounded dedup so memory stays flat

### What is deliberately not built

| Asked for | Why not |
| --- | --- |
| Exchange labels ("from Binance") | Not on-chain data. It requires a proprietary attribution database; naming a wallet on a guess is the one thing that would make these alerts untrustworthy. Arkham is supported *with your own key*, and its labels are spoken attributed |
| Wallet classification by the model | A 4B model producing "institutional accumulator" is a confabulated verdict, not analysis |
| Mempool alerts | Pending transactions get dropped and replaced. An alert about a transaction that never lands is misinformation |
| Global Solana whale scanning | Measured: the Helius socket delivers over 200 token-program events in 15 seconds. Filtering that firehose is not something this machine does while also running voice |
| Bitcoin monitoring | A different data source entirely, and none is connected |

### Provider keys

All optional. JARVIS runs keyless and degrades honestly, saying which chains it
can read and why one is missing.

| Key | Unlocks | Without it |
| --- | --- | --- |
| `ALCHEMY_API_KEY` | Full wallet holdings with prices, faster RPC, keyed websocket | Public endpoints, known-token scanning only |
| `HELIUS_API_KEY` | Solana wallets, activity, stablecoin supply | No Solana |
| `DUNE_API_KEY` | Aggregate analytics: top holders, USD-priced flows | Those queries state the key is needed |
| `ARKHAM_API_KEY` | Entity labels, spoken with attribution | Addresses stay addresses |

Networks are **discovered, not assumed**: each candidate endpoint must return
the chain ID it claims before it is used. On the free Alchemy tier this
correctly rejects Optimism and Polygon, which answer 403, rather than failing
later with a confusing error.

Measured provider limits that shape the design: Alchemy's free tier caps
`eth_getLogs` at 10 blocks, 1rpc at 50, and drpc handles a few hundred but
refuses under load. Wide-range log queries are therefore chunked at 50 blocks
across the keyless pool, and any chunk that fails is reported rather than
silently dropped — "nothing happened this hour" and "I could only read half the
hour" are different answers.

### Fund tracing

`src/js/services/tracer.js` implements the deterministic Approximate
Personalized PageRank from the TRacer paper, with its tracing-tendency and
weighted-pollution strategies, plus structural pattern detection (amount
consistency, cycles, consistent chains). It reports pattern presence, never a
verdict. The algorithm is tested and works; live tracing needs address history,
which public RPC cannot enumerate, so it awaits an Etherscan-family key.

---

## Web search

`webSearch.js` (main process) and `src/js/services/webSearchIntent.js`
(renderer) answer questions from the live internet. Split along the process
boundary, not by topic: the renderer cannot fetch these origins because CORS
blocks it, and Rollup cannot take named imports from a CommonJS module.

### Why it exists

There was no web search. `search about elon musk` was classified `TYPE_TEXT` —
the dictation intent — so asking for a search typed the words into whatever
window had focus. Anything that instead reached `AI_COMMAND` was answered by
the local model, which has no network access. It did not decline; it invented:

```
"search about elon musk"       -> "...recognized as a trillionaire in US dollars ."
"list latest vulnerabilities"  -> "According to OpenCVE, Google released Chrome 151
                                   with patches for 382 vulnerabilities"
"latest cve number of chrome"  -> "According to Google's Chrome Releases,
                                   CVE-2026-15905 is the latest critical vulnerability"
```

Those citations are fabricated. A fabricated CVE number is worse than a refusal.

### Pipeline

> **Diagram:** [Pipeline →](docs/ARCHITECTURE.md#5-pipeline)

### Providers are measured, not assumed

HTML scraping was tried first and does not work:

| Endpoint | Result |
| --- | --- |
| `html.duckduckgo.com` | HTTP 202 + challenge page, 0 results |
| `lite.duckduckgo.com` | HTTP 202 + challenge page, 0 results |
| `mojeek.com` | HTTP 200, body is an altcha CAPTCHA |
| `searx.be` | HTTP 200, JSON output disabled |

The first DuckDuckGo query of a session usually succeeds, which makes this
especially deceptive: it looks like it works until it is used twice.

Keyless general open-web search is not available in 2026. Google's Custom Search
JSON API closed to new signups in 2025 and shuts down on 1 Jan 2027; Bing's
Search APIs were retired on 11 Aug 2025; Brave withdrew its free tier. So the
providers below are the keyless endpoints that **are** official, each measured
before being added:

| Provider | Measured | Intent |
| --- | --- | --- |
| DuckDuckGo Instant Answer | 361 ms | general (sourced abstract) |
| Wikipedia | 541 ms | general (encyclopedic) |
| Google News RSS | 642 ms | news, anything current |
| Hacker News (Algolia) | 831 ms | discuss |
| crates.io | 1147 ms | code (Rust) |
| Open Library | 1259 ms | book |
| NVD | 1462 ms | security |
| GitHub repos | 1523 ms | code |
| Stack Overflow | 1555 ms | code, discuss |
| arXiv | 1973 ms | academic |
| npm | 2078 ms | code (JS) |
| Brave | — | general, only with `BRAVE_API_KEY` |

Probed and **rejected**: GitHub code search (HTTP 401, needs auth), Semantic
Scholar (HTTP 429), Reddit (HTTP 403 to datacentre traffic).

### Gather, don't race

Providers here are complementary rather than interchangeable — a Rust question
wants the crates.io entry *and* the GitHub repo *and* the Stack Overflow thread
— so `gatherAll` collects everything that arrives inside the budget instead of
resolving on the first success.

The early exit counts **providers, not results**. Counting results was tried
first and silently destroyed the feature: Google News alone returns six, which
satisfied a result quota instantly and ended the query before any other source
replied — measured as `answered 1: google-news` on every single query, a
first-wins race wearing a gather's clothes.

`rrfFuse` merges the ranked lists by position only (k=60), because GitHub stars,
Stack Overflow votes and news recency cannot be normalised against each other.
Provider weights are derived from the query, after plain RRF put npm's
`uniffi-bindgen-react-native` first for *"best rust crate for async runtime"* —
an off-target index's rank-1 beating a relevant index's rank-2.

### Query understanding

Spelling and entity correction run **concurrently** with the search, so they
cost nothing when nothing needs correcting, and the corrected query is only
re-run when the original returned fewer than three results — and only kept if
it did better. A bad suggestion cannot make results worse.

**Jarvis auto-corrects your spelling.** Mistype a word and it recognises what
you meant, fixes it, and shows you what it searched for — so a typo never
silently returns nothing.

There is no hardcoded dictionary. Building one from the local corpus was tried
and measured useless: 721 feed items yield 2652 "entities" that are almost
entirely filing boilerplate (`Filer`, `Filed`, `AccNo`), and the result knew
none of the terms people actually mistype. Wikipedia's search API knows all of
them, live, and stays current for free.

Two kinds of correction, handled differently:

| Kind | Example | Behaviour |
| --- | --- | --- |
| **Spelling** | `situtational` → situational | corrected silently, shown on screen |
| **Entity** | a misspelt name → the right one | corrected **and spoken aloud** |

The difference matters. Reading "showing results for situational awareness"
aloud after a one-letter typo is noise. But a misheard *name* resolves to a
different person entirely, and answering about someone else without saying so is
indistinguishable from being wrong — so entity corrections are always announced.

Suggestions are never applied blindly. The decision is made locally on
Damerau-Levenshtein distance relative to word length, and a correction is only
kept if it actually returned better results than the original. A bad suggestion
cannot make things worse.

### Latency

Search returns in **46–956 ms** against 31–51 s for the old path, which ran
retrieval plus local generation. Repeat queries are **0 ms** (cached).

Connection warmth was measured rather than assumed. Node 22's default dispatcher
holds pooled connections for at least **120 s** idle — far longer than the ~4 s
commonly quoted — so no custom `undici` dispatcher is needed and none is added:

```
cold (first ever fan-out)   7812 ms
after   0s idle              664 ms
after  60s idle              690 ms
after 120s idle              564 ms
```

Only the cold start is worth removing, so the three **general** origins are
warmed once, 3 s after launch. The eight specialised providers are intent-gated
and left cold. There is no repeating warmer: warmth already survives a session,
and periodic warming would be unsolicited traffic to third parties.

---

## Retrieval engine

`src/js/services/ragService.js` implements hybrid retrieval. Design choices are
evidence-driven and each is traceable to a measurement or a paper.

> **Diagram:** [Retrieval engine →](docs/ARCHITECTURE.md#6-retrieval-engine)

### Components

| Stage | Implementation | Rationale |
| --- | --- | --- |
| Sparse | BM25 over a persistent inverted index, incremental on ingest | Re-tokenising the corpus per query measured 104.8ms at 5k chunks on the render thread |
| Dense | nomic-embed-text through Ollama, cosine similarity | Degrades to BM25-only when no embedder is present |
| Fusion | Reciprocal Rank Fusion, k=60 | Derived from PubHealthBench, where hybrid beat both single-retriever modes. **This did not reproduce locally — see [Retrieval accuracy](#retrieval-accuracy)** |
| Expansion | PRF: top 4 chunks, top 6 non-query terms, fused as a separate list at weight 0.5 | Kept separate so a poor feedback pool can dilute but not corrupt the original ranking |
| Entities | Normalised Levenshtein, threshold 0.25, after exact-match miss | Input is speech-to-text, so names arrive mangled |
| Selection | Late sentence selection, IDF-weighted overlap with lead bias, budget 10 | LongEval's winning system paired plain passages with late sentence selection |
| Reranking | Ambiguity-gated LLM rerank, opt-in | See below |

### Retrieval accuracy

Speed was measured long before accuracy was, which is backwards: a fast ranker
that ranks the wrong passage first is worse than a slow one that does not.
`eval/` now carries a labelled benchmark — 29 questions over 30 documents,
driving the shipped module through ablation switches rather than a
reimplementation of it. Full numbers and method in
[eval/RESULTS.md](eval/RESULTS.md).

| Configuration | P@1 | P@3 | MRR | ms/query |
| --- | ---: | ---: | ---: | ---: |
| lexical only (BM25) | 69.0% | 79.3% | 0.737 | <1 |
| **dense only** | **89.7%** | **100%** | **0.948** | 60 |
| hybrid, as shipped | 72.4% | 93.1% | 0.825 | 61 |
| hybrid + rerank | 72.4% | 93.1% | 0.825 | 3,243 |

**Dense-only beats the shipped hybrid by 17 points at rank 1.** The rationale
for hybrid fusion came from the literature and did not reproduce on this corpus
with this embedding model. Lexical retrieval is in the stack to catch rare
proper nouns; dense matched it there (5/5) and beat it on every other question
type, so its weight in the fusion is diluting a better ranking rather than
protecting against a weakness.

The default has not been changed on that basis, for reasons stated in full in
the results: the benchmark's author also wrote its questions, 29 questions makes
anything under ~7 points a single labelling choice, and BM25 is the only thing
that still works when the embedder is down. But the shipped weighting is
currently **unsupported by the only measurement that exists**, and saying so is
more useful than citing the paper it came from.

Reranking changed no answer on this set while costing 3.2 seconds per query.

### Memory accuracy

The belief store's claims, measured by replaying 12 scripted observations over
6 simulated days (`node eval/memory-eval.mjs`):

| Claim | Result |
| --- | --- |
| A repeated genuine preference becomes durable | 3/3 held |
| A one-off speech mangling never does | 0/2 admitted |
| A changed fact replaces the old value | VS Code durable, Sublime archived |
| Confidence bounded and reported | 83% after 3 observations |
| Provenance retained | 3 records, sources voice and text |

This exercises the state machine — corroboration, decay, competition, revision.
It does not measure how well a 4B model distils facts from real conversation,
nor whether durable beliefs improve the final answer. Both need labelled real
data, and neither is claimed here.

### Measured performance

Inverted index against the previous implementation, top-10 rankings verified
bit-identical at every size:

| Corpus | Before | After | Speedup |
| --- | --- | --- | --- |
| 100 chunks | 1.87 ms | 0.008 ms | 223x |
| 500 chunks | 8.71 ms | 0.037 ms | 238x |
| 2,000 chunks | 37.1 ms | 0.116 ms | 319x |
| 5,000 chunks | 104.8 ms | 0.456 ms | 230x |

Late sentence selection, measured end to end on real document text:

| Metric | Result |
| --- | --- |
| Context size reduction | 81 percent, 11,396 to 2,192 characters |
| Correct evidence position | ranks 1 to 3 |
| Determinism across repeated calls | byte-identical |

### On reranking

Ollama exposes no `/api/rerank` endpoint, so a conventional cross-encoder is not
available. Gemma 3 can rerank correctly, scoring 3 of 3 top-1 on labelled
passages, but a single call costs roughly 3 seconds.

Reranking is therefore gated on ambiguity and is opt-in rather than default:

| Path | Frequency | Latency |
| --- | --- | --- |
| Gate skips, top-1 clearly dominant | ~50 percent | ~90 ms |
| Gate fires, candidates close | ~50 percent | ~4,800 ms |

Typed input opts in. Voice input does not, because roughly 5 seconds of added
silence is unacceptable on the spoken path. Any timeout or malformed response
falls back to lexical order, so reranking is an enhancement and never a
dependency.

### Why not agentic retrieval

A-RAG style agentic retrieval was evaluated and deliberately not adopted.
Benchmarked on this hardware, Gemma 3 routes queries to the correct source with
92 percent accuracy, which is sufficient. The blocker is latency: a single
planning call costs about 3 seconds, and the published agent loops use 5 to 20
steps. That is 15 to 60 seconds of silence before the first word, which does not
work for a voice interface.

---

## Evaluation

```bash
node eval/retrieval-eval.mjs   # ranking accuracy across configurations
node eval/memory-eval.mjs      # belief store: corroboration, revision, garble rejection
```

Both harnesses drive the shipped modules. Results, method, and the caveats that
bound them are in [eval/RESULTS.md](eval/RESULTS.md); the headline numbers are
in [Retrieval accuracy](#retrieval-accuracy) and [Memory accuracy](#memory-accuracy)
above.

The benchmark corpus is synthetic and labelled. It supports comparison between
configurations, since each sees identical data; it does not predict accuracy on
a real user's memory, and it is not presented as doing so.

**What is still unmeasured, and should be:** whether retrieved context and
durable beliefs improve the final *answer*, as opposed to the ranking. That
needs answer-level labels and a judge. The rankings are now measured; the
answers are not, and no claim is made about them.

---

## Android companion

`companion/` contains a Kotlin application that mirrors the visualizer to a
phone and exposes device control back to the desktop.

<p align="left">
  <img src="https://img.shields.io/badge/minSdk-26-3DDC84?style=flat-square&logo=android&logoColor=white" alt="minSdk 26" />
  <img src="https://img.shields.io/badge/targetSdk-35-3DDC84?style=flat-square&logo=android&logoColor=white" alt="targetSdk 35" />
  <img src="https://img.shields.io/badge/Kotlin-2.0.21-7F52FF?style=flat-square&logo=kotlin&logoColor=white" alt="Kotlin 2.0.21" />
  <img src="https://img.shields.io/badge/AGP-8.7.3-02303A?style=flat-square&logo=gradle&logoColor=white" alt="AGP 8.7.3" />
</p>

### The visualizer is copied, not reimplemented

| Asset | Origin | State |
| --- | --- | --- |
| `visualizerModes.js` | `src/js/visualizerModes.js` | byte-identical, SHA-256 verified |
| `three.module.js` | three@0.158.0 | byte-identical |
| Vertex and fragment shaders | `src/index.html` | verbatim |
| `visualizer.js` | `src/js/scripts.js` | renderer, uniforms, and FFT blend preserved |

`visualizerModes.js` still carries `import * as THREE from 'three'`. Rather than
edit the copy, an import map in the host page resolves the bare specifier, so
the file stays identical to the desktop original.

Assets are served through `WebViewAssetLoader` on a virtual https origin rather
than `file://`. WebView blocks ES module scripts from `file://` because the
origin is opaque, which presents as a silent black screen.

### Audio bridge

The desktop fills `window.jarvisFrequencyData` from a WebAudio AnalyserNode. A
WebView cannot obtain microphone access that way, so `AudioFft.kt` reads
`AudioRecord`, applies a Hann window, runs a radix-2 FFT, and writes the same 64
bins natively. Bins use WebAudio's decibel mapping, minus 100 to minus 30 dB
onto 0 to 255. Linear magnitude was tried and leaves the orb nearly static at
speaking volume.

### Pairing

> **Diagram:** [Pairing →](docs/ARCHITECTURE.md#7-pairing)

The phone always dials outward, which avoids Doze restrictions and handset
address churn. Pairing retries every 10 seconds while unpaired, because the
window is usually opened after discovery has already resolved.

`/pair` and `/apk` return 403 once the window closes. That window is the only
thing standing between a network neighbour and the bridge token, so it is short
and user-initiated.

### Capability negotiation

On connect the phone reports what it can actually do, probed rather than
assumed:

```json
{"open_app":true,"list_apps":true,"clipboard":true,"battery":true,
 "tts":true,"flashlight":true,"volume":true,
 "ui_automation":false,"screenshot":false,"read_screen":false,
 "silent_install":false}
```

The desktop reasons about the device instead of firing commands blindly. A
request needing accessibility explains how to enable it rather than failing
opaquely.

### Control tiers

| Tier | Requires | Commands |
| --- | --- | --- |
| 1 | Nothing beyond install | `ping`, `device_info`, `battery`, `clipboard_get`, `clipboard_set`, `tts`, `list_apps`, `open_app_by_name`, `flashlight`, `volume`, `capabilities` |
| 2 | AccessibilityService enabled | `get_layout`, `click`, `long_press`, `swipe`, `input_text`, `global`, `screenshot` |
| 3 | Wireless Debugging enabled | Desktop-side ADB: brightness, volume, keyevents, package management, file transfer, screenrecord |

Tier 3 runs entirely on the desktop through `adbService.js`. The APK is not
involved. All ADB invocations pass argument arrays, never concatenated strings,
and raw shell passthrough is disabled at the IPC boundary.

### Structured phone tools

The desktop reasons; the phone executes. Commands travel as structured intents,
never free-form text:

```
"open settings on my phone"
  -> routePhoneCommand()
  -> {tool: "phone.open_app", parameters: {name: "settings"}}
  -> companion: open_app_by_name
  -> {"package": "com.android.settings", "label": "Settings"}
  -> "Settings is now open on your phone, Sir."
```

Every spoken confirmation is built from what the phone returned. The language
model is deliberately absent from this path, because earlier logs showed it
inventing outcomes when it had no execution feedback.

---

## Screen mirror

> **Full write-up:** [docs/SCREEN-MIRROR.md](docs/SCREEN-MIRROR.md) ·
> **Diagram:** [Screen mirror →](docs/ARCHITECTURE.md#8-screen-mirror)

Your Android screen on the desktop, with touch and keyboard control, from one
spoken sentence.

```
"mirror my phone"          -> panel slides in, phone appears
"stop mirroring"           -> session ends, nothing left on the device
"take a phone screenshot"  -> grabs the current frame and describes it locally
```

`Alt+Shift+M` closes it too, as does the `✕` on the panel.

USB works out of the box; Wi-Fi works once the phone has been paired over
Wireless Debugging. **Nothing is installed on the phone** — the scrcpy server
jar is pushed to `/data/local/tmp` for the session and removed when it ends.

### How it is split

```
phone  --H.264 over adb-->  main process  --IPC-->  renderer  --WebGL-->  canvas
                                 ^                     |
                                 +---- touch/keys -----+
```

| Piece | File | Runs in |
| --- | --- | --- |
| Voice routing, coordinate and key mapping | `src/js/services/mirrorIntent.js` | pure, no I/O |
| scrcpy session, control injection | `mirrorService.js` | main |
| IPC wire | `electron.js`, `preload.js` | main / bridge |
| Decode, draw, input relay | `src/js/components/mirrorPanel.js` | renderer |

The session lives in **main** because it needs a TCP socket to the local ADB
server on `127.0.0.1:5037`, which the renderer cannot open. The decode lives in
the **renderer** because WebCodecs hands frames to WebGL without them entering
JavaScript memory. Decoding in main would mean shipping raw frames over IPC —
1920×1080×4 bytes at 60 fps is about 500 MB/s. What crosses IPC instead is the
compressed elementary stream, roughly 1 MB/s.

### Decisions worth knowing

- **The server jar is pinned to scrcpy 3.3.3, not "latest".** The client
  implements the protocol up to 3.3.3 and scrcpy compares version strings
  exactly, so dropping a 4.x jar in produces a session that dies at handshake
  rather than an upgrade. The SHA-256 is checked on every start and asserted in
  tests, because a substituted jar otherwise just hangs.
- **`maxSize` defaults to 0, meaning device native.** Measured on a 1080×2400
  handset, `maxSize` caps the *longer* edge — the obvious-looking 1920 produced
  **864×1920**, narrower than 1080. At native size the stream measured 4.1 Mbps
  against an 8 Mbps ceiling, so the downscale bought nothing.
- **The panel is sized from the phone, not the other way round.** Width is
  derived from the stage's *measured* height times the device aspect ratio, so
  there are zero letterbox bars in either direction, and rotation refits both
  axes. A 20:9 phone in an 800px-tall window is 360px wide — that is the phone's
  real shape, and the only way to a bigger mirror is a taller Jarvis window.
- **Printable keys are sent as text, not keycodes.** A keycode replays a
  physical key and is resolved through the *device's* layout, so on a phone set
  to anything but the host layout the wrong character appears. Enter, Backspace,
  arrows and modifiers have no text and must be keycodes.
- **Audio is raw PCM, and mutable.** Phone audio out of the speakers can be
  transcribed back as a user turn, so it ships with a mute button and
  `buildMirrorOptions({audio:false})`. Renderer playback goes through Chromium's
  render path and *is* seen by the echo canceller, unlike the SAPI voice that
  bypassed it. Transport is verified; audible content is not — see the doc.
- **Right-click is Back, Escape is Back.** scrcpy convention, and it is what
  makes the mirror usable.

### Measured — Xiaomi M2101K6P (Android 16), USB, 2 Aug 2026

Driven through the shipped modules, not a harness reimplementation.

| | |
| --- | --- |
| Resolution | **1080×2400**, device native |
| Handshake | **1078 ms** cold, **629 ms** warm |
| First frame | **1289 ms** cold, **799 ms** warm |
| Frame rate | **60.5 fps** received; 49 fps presented on a live screen |
| Bitrate | **4.11 Mbps** at native size (ceiling 8 Mbps) |
| Control round trip | back / home / recents / notifications / rotate, **≤1 ms** each |

Picture verified by pixel statistics rather than by looking: mean luma tracked
the device — 60 → 39 when the notification shade was opened over the control
channel, back to 60 on collapse. A frozen surface cannot do that. Cleanup
confirmed after `stop()`: no `app_process` running, jar removed, nothing
installed.

The **LAG badge is not glass-to-glass latency** and does not claim to be. The
device's capture clock and the host's clock have no shared origin, so their
difference is an unknown constant. What the badge shows is arrival delay above
the smallest value seen this session — queueing on top of the fastest path
actually observed. The label says LAG rather than latency for that reason.

### Failure messages

Each is produced by `mirrorService`, not the model, and names the thing you
control:

| Message | Fix |
| --- | --- |
| `no Android device is connected over USB or Wi-Fi ADB` | plug it in, or `adb connect` |
| `your phone has not authorised this computer` | accept the USB debugging prompt |
| `N devices are connected — say which one, or unplug the others` | ambiguity is an error here, never a coin flip |
| `the ADB server is not reachable on port 5037` | `adb start-server` (tried automatically first) |
| `does not match the pinned v3.3.3 build` | `resources/scrcpy-server.jar` was replaced |

---

## Routing

Commands used to be matched by pattern, and every new ability meant another
regex that only recognised the phrasings someone thought of. `"latest trending
meme coin search"` reached the local model — which correctly answered that it
cannot search — because the verb was at the **end**, and no pattern anticipated
that. Adding a pattern fixes that sentence and not the next one.

Capabilities now describe themselves, and the router matches meaning.

### Measured, not assumed

Held-out phrasings, none of which appear in the capability manifests, scored
against the live `nomic-embed-text` embedder:

| Router | Accuracy |
| --- | --- |
| **As shipped** — deterministic, then semantic | **24/24 · 100%** |
| Semantic router alone | 23/24 · 95.8% |
| Regex baseline | 18/24 · 75.0% |

`eval/routing-eval.mjs`. The comparison exists because a smarter architecture is
a hypothesis until it has a number — an earlier causal-graph retrieval layer in
this project was obviously better in principle and measured **worse** than plain
retrieval, 56.6% against 68.8%.

### Blast radius decides the router

```
"empty the recycle bin"
"don't empty the recycle bin"
"what happens if I empty the recycle bin"
```

These are neighbours in embedding space. Cosine similarity has no reliable
signal for negation or interrogation — the content words dominate — while a
regex with a question guard separates them exactly.

A wrong retrieval costs a wasted search. A wrong destructive action costs files.
So capabilities declare their `effects`, and **only read-only ones are reachable
by similarity**; anything that writes or destroys needs a deterministic parse.
Tests route the negated and interrogative forms and assert they cannot reach
anything destructive.

This is not a rejection of semantic routing. It is semantic routing where being
approximately right is good enough, and deterministic parsing kept where it is
not.

### Freshness is the lever

`STATIC` · `DYNAMIC` · `REALTIME`. A local model answering a REALTIME question
is not recalling — the answer postdates its training, so it is generating, which
is the path that produced the fabricated citations this project already guards
against. Freshness catches it *before* the model is asked.

Deliberately lexical rather than model-judged: it runs on every utterance and an
Ollama round trip would slow the fast path; a 4B model is the least reliable
possible judge of its own knowledge age, because it does not know what it does
not know; and a function can be tested against a labelled set where an opinion
can only be spot-checked. Unrecognised questions fall to `DYNAMIC`, which
prefers the network — over-searching costs a request, under-searching costs a
fabricated answer.

A nearest neighbour always exists, so there is a floor (0.55) and a margin
(0.04): below the floor, or within the margin of the runner-up, nothing is
chosen. `"thank you"` routes to nothing. No embedder means no opinion, never a
random capability.

---

## Music

Real-time track resolution through the Spotify Web API, then handed to whatever
can actually play it.

```
"play starboy by the weeknd"     -> track:starboy artist:the weeknd
                                 -> Starboy — The Weeknd, Daft Punk
"play bohemian rhapsody on spotify"
"pause" · "skip this song" · "what's this song"
```

`"X by Y"` becomes a **fielded** query — `track:X artist:Y` — because the plain
string lets a popular artist name outrank the requested track: "play hello by
adele" can otherwise return an Adele song that is not Hello.

### What actually plays it

Search is genuinely live and verified. Playback depends on what is installed,
and Jarvis says which of the three happened rather than reporting "playing" for
all of them:

| Route | Needs | Result |
| --- | --- | --- |
| Web API playback | **Premium** + a running Spotify device | audio starts, nothing opens |
| `spotify:` desktop URI | Spotify desktop installed | plays in the app, no browser |
| `open.spotify.com` | nothing | opens a tab, **off by default** |

The browser fallback is disabled by default, because a tab is not background
playback — it is a window appearing, with still no music until someone presses
play. With no player present Jarvis reports that it found the track and has
nothing to play it with.

> **Free accounts:** the Web API playback endpoint is Premium-only, but the
> desktop URI path works on Free. Installing the Spotify desktop app is what
> turns this into background playback with no browser.
>
> **Not a workaround:** playing the web player inside a hidden Electron window
> would need Widevine, and Electron ships no CDM — it loads and fails on DRM.
> Measured, not assumed.

Tokens live in the same `safeStorage` vault as every other secret (DPAPI on
Windows). None is written to the repository.

---

## Installation

### Download a build

Prebuilt installers for every tagged release are on the
[Releases page](../../releases/latest).

| Platform | Download | Notes |
| --- | --- | --- |
| Windows | `Jarvis-Setup-<version>-x64.exe` | Installer. `Jarvis-Portable-*.exe` needs no install. |
| macOS | `Jarvis-<version>-universal.dmg` | One universal build for Apple Silicon and Intel |
| Linux | `Jarvis-<version>-x64.AppImage` | `chmod +x` and run. `.deb`, `.rpm` and `.tar.gz` are also published. |

Verify what you downloaded:

```bash
sha256sum -c SHA256SUMS --ignore-missing
```

Builds are unsigned unless signing certificates are configured for the
repository. Windows SmartScreen will warn on first run (**More info → Run
anyway**); macOS needs **right-click → Open** the first time, or
`xattr -dr com.apple.quarantine /Applications/Jarvis.app`.

The app checks for updates a minute after launch and every six hours after
that. It never downloads or installs on its own — a voice assistant should not
restart itself mid-sentence. See [docs/RELEASE.md](docs/RELEASE.md) for the
full release process, signing and notarization.

### Prerequisites

| Requirement | Version | Purpose |
| --- | --- | --- |
| Node.js | 18 or higher | Runtime and build |
| Ollama | any current | Local model serving |
| uv | any current | Isolated Python environment for STT |
| JDK | 17 or higher | Companion app only |
| Android SDK | platform 35, build-tools 35 | Companion app only |

### Desktop

```bash
npm install

ollama pull gemma3:4b
ollama pull nomic-embed-text

npm run build
```

Ollama does not need to be running. JARVIS starts it if the port is idle and
preloads the model so the first question does not pay a cold-load penalty.

### Companion app

```bash
cd companion
./gradlew assembleDebug
```

The APK is written to `app/build/outputs/apk/debug/app-debug.apk` and served
automatically during pairing.

---

## Running

```bash
npm run electron
```

This runs the production build from `dist/`. For live reload while editing the
renderer, run the Vite server and the development launcher in separate shells:

```bash
npm run dev
npm run electron:dev
```

Do not use `electron:dev` without `npm run dev` running, as it expects a server
on port 5173.

### Scripts

| Command | Effect |
| --- | --- |
| `npm test` | Every suite, printing the total check count |
| `npm run eval` | Retrieval and memory benchmarks (needs Ollama) |
| `npm run dev` | Vite dev server on port 5173 |
| `npm run build` | Production bundle into `dist/` |
| `npm run electron` | Launch against `dist/` |
| `npm run electron:dev` | Launch against the Vite server |
| `npm run icon` | Regenerate `build/icon.png`, the source for every platform icon |
| `npm run dist` | Package for the current platform into `release/` |
| `npm run dist:win` | Windows: NSIS installer, portable exe, zip |
| `npm run dist:mac` | macOS: universal DMG and zip |
| `npm run dist:linux` | Linux: AppImage, deb, rpm, tar.gz |
| `npm run checksums` | Write `release/SHA256SUMS` |
| `npm run checksums:verify` | Re-hash artifacts and fail on any mismatch |
| `npm run smoke` | Launch the packaged app and assert it starts |
| `npm run electron:build` | Legacy alias for a plain `electron-builder` run |

---

## Configuration

Settings live in browser local storage and are seeded from
`src/js/settings.js`. Relevant defaults:

| Key | Default | Meaning |
| --- | --- | --- |
| `llmProvider` | `gemma-local` | Local inference through Ollama |
| `localOllamaUrl` | `http://localhost:11434` | Ollama endpoint |
| `localModel` | `gemma3:4b` | Generation and vision model |
| `micPreference` | `auto` | `headset`, `internal`, or `auto` |
| `echoCancellation` | `true` | Stops JARVIS hearing itself |
| `noiseSuppression` | `true` | Filters fans and keystrokes |
| `autoGainControl` | `true` | Required for quiet microphones |
| `ocrProvider` | `auto` | Local OCR server when available |

### Environment overrides

The main process cannot read renderer local storage at boot, so these are
available as environment variables:

| Variable | Default |
| --- | --- |
| `JARVIS_OLLAMA_URL` | `http://localhost:11434` |
| `JARVIS_LOCAL_MODEL` | `gemma3:4b` |
| `JARVIS_OCR_URL` | `http://127.0.0.1:10000` |
| `JARVIS_ADB_PATH` | auto-detected |
| `JARVIS_ETH_WS` | keyed endpoint if available, else `wss://ethereum-rpc.publicnode.com` |

### Provider keys and `.env`

Copy `.env.example` to `.env` and fill in whatever you have. Every key is
optional; see [Provider keys](#provider-keys) for what each unlocks. The file is
git-ignored, values are never logged (only the key *names* appear at startup),
and a real environment variable always wins over the file.

```bash
cp .env.example .env
```

```
ALCHEMY_API_KEY=      # EVM RPC, portfolio, prices
HELIUS_API_KEY=       # Solana RPC, assets, activity
# DUNE_API_KEY=       # aggregate analytics
# ARKHAM_API_KEY=     # entity labels, spoken with attribution

GOOGLE_CLIENT_ID=     # Calendar and Meet
GOOGLE_CLIENT_SECRET=
```

### Connecting Google Calendar

One-time setup, then `"connect my calendar"` does the rest.

1. [Google Cloud Console](https://console.cloud.google.com/) -> new project
2. **APIs & Services -> Library** -> enable **Google Calendar API**
   (and **Google Meet API** if you want instant Meet rooms)
3. **OAuth consent screen** -> External -> add yourself as a test user
4. **Credentials -> Create credentials -> OAuth client ID ->
   Application type: Desktop app**
5. Put the client ID and secret in `.env`

Then say **"connect my calendar"**. Your system browser opens Google's real
consent screen; JARVIS receives the code on a loopback port and stores a refresh
token in the app's user-data directory at mode `0600`. The renderer never sees a
token.

The client "secret" is not secret for a desktop app — Google's own installed-app
flow puts it in the binary — which is why the exchange also uses PKCE. See
[OAuth 2.0 for native apps](https://developers.google.com/identity/protocols/oauth2/native-app).

To revoke: **"disconnect my calendar"**, or remove the app at
[myaccount.google.com/permissions](https://myaccount.google.com/permissions).

> [!IMPORTANT]
> Programmatic **Google Meet link** creation requires a paid Google Workspace
> account. With a personal Gmail, events are created normally but without a Meet
> link, and JARVIS tells you so rather than pretending one exists.

At startup the log states exactly what was found and what it can reach:

```
[env] loaded keys: ALCHEMY_API_KEY, HELIUS_API_KEY
[chain] Alchemy verified in 394ms: arbitrum, ethereum, base, bsc | unavailable: optimism, polygon
```

### Credentials

Secrets are held in an Electron `safeStorage` vault backed by Windows DPAPI. The
renderer can set, list, and delete entries but can never read raw values. The
typed command `store key <name> <value>` bypasses the model and conversation
memory entirely. Provider keys can live here instead of `.env`, and the
environment is checked first.

---

## Network ports

All listeners bind locally or to the LAN. None are exposed to the internet.

| Port | Service | Bind | Authentication |
| --- | --- | --- | --- |
| 8765 | Phone bridge HTTP | `0.0.0.0` | Bearer token, except the pairing routes |
| 8766 | Companion WebSocket | `0.0.0.0` | Token in `X-Jarvis-Token`, constant-time compare |
| 8770 | faster-whisper STT | `127.0.0.1` | Loopback only |
| 8771 | Local TTS | `127.0.0.1` | Loopback only |
| 8772 | Vision `llama-server`, optional | `127.0.0.1` | Loopback only |
| 11434 | Ollama | `127.0.0.1` | Loopback only |
| 10000 | Unlimited-OCR, optional | `127.0.0.1` | Loopback only |
| 5173 | Vite dev server | `127.0.0.1` | Development only |

One port is **connected to** rather than listened on: `127.0.0.1:5037`, the ADB
server, used by Tier 3 phone control and by the screen mirror. JARVIS does not
bind it — `adb` owns it, and JARVIS starts the server if it is not already
running.

---


## Troubleshooting

### JARVIS does not speak

Speech is suppressed while a cloud Live session is connected. Without a key that
never happens, so text-to-speech should be active. If the voice list loaded late
the selected voice may be null; check for the `onvoiceschanged` race.

### The microphone stops working mid-session

Usually a Bluetooth profile switch. Speaking to earbuds forces Windows from A2DP
to HFP, which tears down the capture device. The recovery path retries
indefinitely with backoff, watches for `track.onended`, and runs a 5s watchdog
that forces a restart when no frames arrive for 15 seconds.

The stable configuration is laptop microphone for input with earbuds for output.
Full duplex over Bluetooth is inherently fragile on Windows.

### JARVIS transcribes its own voice

The echo guard compares each transcript against recently spoken text by word
overlap and drops matches above 60 percent. If self-talk still appears, confirm
the selected microphone is not a loopback device such as Stereo Mix.

### The STT server will not start

It must run through `uv run --python 3.12 --with faster-whisper --with websockets python -I`.
The `-I` flag is essential. Without it, user site-packages pollute `sys.path`
and numpy or onnxruntime crash with an access violation.

If port 8770 is already held, an orphaned Python process survived a previous
force-kill. `before-quit` does not run on a force-kill, so the child is not
reaped. Identify and stop the process holding the port.

### Companion shows OFFLINE

Confirm both devices share a subnet. A common failure is mDNS advertising a
virtual adapter such as VirtualBox host-only at `192.168.56.1`, which the phone
cannot route to. Interface ranking now deprioritises virtual, Docker, WSL, and
link-local adapters, and the phone tries every advertised address.

Pairing retries every 10 seconds, so opening the window after launching the app
is fine.

### Gradle fails to start

`JAVA_HOME` may point at a stale path. Set it explicitly:

```powershell
$env:JAVA_HOME = "C:\Program Files\Microsoft\jdk-21.0.9.10-hotspot"
```

### The mirror opens black, or will not start

The messages in [Screen mirror](#failure-messages) name the cause directly —
they come from `mirrorService`, not the model, so treat them literally. The two
that are not self-explanatory:

- `does not match the pinned v3.3.3 build` means `resources/scrcpy-server.jar`
  was replaced. A newer scrcpy jar is not an upgrade; the client speaks the
  3.3.3 protocol and the handshake compares version strings exactly.
- A black panel with a healthy-looking session is the decoder never receiving
  scrcpy's `configuration` packet, which carries SPS/PPS. Packets are queued
  from before the handshake and replayed once the decoder exists, so this should
  not recur — if it does, check that the video subscription is opened *before*
  `start()`.

### Answers ignore stored memory

Check `stats()` on the retrieval service. Chunks stored while Ollama was
unavailable have a null vector and are invisible to dense search. Backfill runs
automatically on load once an embedder is reachable.

---

## Known limits

These are deliberate or platform-imposed, not defects.

- **No barge-in.** The microphone is gated while speaking. Synthesised audio
  bypasses Chromium's echo cancellation and would otherwise be transcribed as
  user input.
- **No general open-web index.** Web search federates official keyless APIs
  plus a BM25 pass over already-crawled feeds. It is not a crawler and does not
  try to be: Google indexes hundreds of billions of pages, and a personal
  crawler would spend its time re-fetching what the live providers already
  return. Where a personal index genuinely wins is the narrow set the user
  tracks, which is what the feed poller already collects.
- **Keyless web search has no general provider.** Google's Custom Search JSON
  API shuts down 1 Jan 2027, Bing's Search APIs were retired 11 Aug 2025, and
  Brave dropped its free tier. Without `BRAVE_API_KEY`, coverage is DuckDuckGo's
  abstracts, Wikipedia, Google News and the intent-gated specialised indexes —
  strong on entities, current events, code, papers and CVEs; weak on arbitrary
  open-web pages.
- **Search answers are extractive, never generated.** A spoken answer is a
  sentence lifted from a fetched page and checked against it before speaking.
  Nothing is summarised by a model, because a model summarising search results
  is how the fabricated citations above got in.
- **Radio toggles need administrator rights.** Wi-Fi scanning and connecting to
  saved profiles work at user level; enabling the adapter does not. JARVIS opens
  the relevant Settings page and says so plainly.
- **Silent APK install is impossible.** Android reserves it for device-owner
  applications. Google Play policy separately prohibits self-updating outside
  Play. Delta patching would cut transfer size but cannot remove the install
  prompt. `capabilities.silent_install` reports `false` accordingly.
- **The companion is sideload-only.** Google restricts accessibility APIs to
  genuine accessibility use, so Tier 2 would not survive Play review.
- **LAN traffic is cleartext.** The bridge is plain HTTP and WebSocket on a DHCP
  address that cannot be pinned by CIDR, so `network_security_config.xml`
  permits cleartext. Authentication is the shared bridge token. Do not run this
  on an untrusted network.
- **The orb is cropped in portrait.** The desktop camera sits at `z=14`, which
  assumes a landscape aspect ratio.
- **Nothing vibrates on a desktop.** `navigator.vibrate` is callable in Electron
  and moves nothing, because there is no motor. Feedback is animation plus a
  short synthesized click; the vibration channel reports itself unavailable
  rather than pretending. See [docs/FEEDBACK.md](docs/FEEDBACK.md).
- **The mirror needs USB debugging, and one device.** There is no wireless
  fallback that skips ADB, and with several devices connected JARVIS asks which
  one rather than picking. Ambiguity is an error here, never a coin flip.
- **The scrcpy server jar is pinned, not tracked.** It is upgraded when the
  client library implements a newer protocol, not when scrcpy releases. A
  version bump is a code change with a hash change, by design.
- **Glass-to-glass mirror latency is not measurable from inside the app.** The
  device and host clocks share no origin. The LAG badge reports arrival delay
  above the session's best observed path, which is a real measurement of a
  different thing.
- **No order placement, no signing.** The finance and on-chain modules are
  read-only by construction. No code path anywhere in the project can place a
  trade, sign a transaction, or handle a private key.
- **No entity attribution.** JARVIS will not tell you a wallet belongs to
  Binance or Coinbase, because that fact is not on-chain. It comes from a
  proprietary database, and guessing it is how alerts become untrustworthy. With
  your own Arkham key, labels are used and spoken with attribution.
- **The whale stream is Ethereum only.** Arbitrum's sub-second blocks and
  Solana's event rate — over 200 token-program events in 15 seconds, measured —
  are firehoses this machine cannot filter while also running voice.
- **Address history needs an indexer.** Public RPC cannot enumerate the
  transactions of an address, so the fund tracer is tested against synthetic
  graphs and awaits an Etherscan-family key for live use.
- **Historical log windows are chunked and may be partial.** Free RPC endpoints
  cap `eth_getLogs` ranges between 10 and 50 blocks and rate-limit under load.
  Coverage is reported rather than assumed.

---

Developed by **Ashutosh Kumar Singh** ([Ashutosh0x](https://github.com/Ashutosh0x))
