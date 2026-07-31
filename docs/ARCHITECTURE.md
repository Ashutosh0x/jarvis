# Architecture diagrams

Extracted from the README because npmjs.com does not render mermaid —
on the package page these appeared as raw code. GitHub renders them here.

## 1. System overview

```mermaid
flowchart TB
    MIC(["Microphone"]):::io
    SPK(["Speech out plus visualizer"]):::io

    subgraph REN["Renderer process - DOM and WebGL, no Node APIs"]
        direction TB
        VOICE["voiceService.js<br/>VAD, mic selection, echo guard"]:::renderer
        ROUTER{"jarvis.js<br/>intent router"}:::router
        REGEX["Regex intents<br/>apps, wifi, volume, files"]:::renderer
        PHONE["phoneTools.js<br/>NL to structured intent"]:::renderer
        LLM["toolService.js<br/>chat, vision, JSON routing"]:::renderer
        RAG["ragService.js<br/>hybrid retrieval"]:::renderer
        VIZ["scripts.js<br/>Three.js scene"]:::renderer
    end

    subgraph MAIN["Electron main - electron.js, Node APIs, no DOM"]
        direction TB
        SUP["Service supervisor"]:::main
        IPC["IPC handlers<br/>preload.js bridge"]:::main
        BRIDGE["companionBridge.js<br/>WS server plus mDNS"]:::main
        ADB["adbService.js<br/>tier 3 control"]:::main
    end

    subgraph LOCAL["Local services - loopback only"]
        direction TB
        STT["faster-whisper<br/>port 8770"]:::ai
        OLLAMA["Ollama<br/>port 11434"]:::ai
        GEMMA["Gemma 3<br/>chat and vision"]:::ai
        EMBED["nomic-embed-text<br/>embeddings"]:::ai
        OCR["Unlimited-OCR<br/>port 10000, optional"]:::ai
    end

    subgraph PHONEDEV["Android companion - over Wi-Fi"]
        direction TB
        LINK["LinkService<br/>WebSocket client"]:::android
        EXEC["DeviceCommandExecutor<br/>tier 1 and 2"]:::android
        A11Y["AccessibilityService<br/>UI automation"]:::android
        AVIZ["WebView<br/>copied visualizer"]:::android
    end

    WEB(["DuckDuckGo HTML<br/>only outbound traffic"]):::external
    DISK[("Local disk<br/>rag-store, vault, settings")]:::store

    MIC --> VOICE
    VOICE -->|"PCM16 16kHz"| STT
    STT -->|transcript| ROUTER

    ROUTER --> REGEX
    ROUTER --> PHONE
    ROUTER --> LLM

    LLM --> RAG
    RAG <-->|"dense vectors"| EMBED
    RAG -->|"context block"| LLM
    LLM -->|"streaming tokens"| GEMMA
    GEMMA --> SPK
    EMBED -.-> OLLAMA
    GEMMA -.-> OLLAMA

    REGEX --> IPC
    PHONE --> IPC
    RAG <-->|"persist"| IPC
    IPC --> DISK
    IPC --> ADB
    IPC --> BRIDGE
    IPC -->|"web search"| WEB

    SUP -.->|"spawn and respawn"| STT
    SUP -.->|"spawn or reuse"| OLLAMA
    SUP -.-> OCR

    BRIDGE <-->|"ws 8766, token"| LINK
    LINK --> EXEC
    EXEC --> A11Y
    LINK --> AVIZ
    ADB -.->|"tier 3, optional"| PHONEDEV

    VOICE --> VIZ
    VIZ --> SPK

    classDef io fill:#1f2933,stroke:#7b8794,stroke-width:2px,color:#ffffff
    classDef renderer fill:#5b21b6,stroke:#a78bfa,stroke-width:2px,color:#ffffff
    classDef router fill:#7c2d12,stroke:#fb923c,stroke-width:3px,color:#ffffff
    classDef main fill:#164e63,stroke:#22d3ee,stroke-width:2px,color:#ffffff
    classDef ai fill:#065f46,stroke:#34d399,stroke-width:2px,color:#ffffff
    classDef android fill:#14532d,stroke:#4ade80,stroke-width:2px,color:#ffffff
    classDef external fill:#7f1d1d,stroke:#f87171,stroke-width:2px,color:#ffffff
    classDef store fill:#422006,stroke:#d97706,stroke-width:2px,color:#ffffff

    style REN fill:#2e1065,stroke:#8b5cf6,stroke-width:2px,color:#ffffff
    style MAIN fill:#083344,stroke:#06b6d4,stroke-width:2px,color:#ffffff
    style LOCAL fill:#022c22,stroke:#10b981,stroke-width:2px,color:#ffffff
    style PHONEDEV fill:#052e16,stroke:#22c55e,stroke-width:2px,color:#ffffff
```

## 2. Voice pipeline

```mermaid
flowchart LR
    A(["Microphone"]):::io --> B["_pickMicDevice<br/>excludes loopback<br/>ranks headset, internal"]:::step
    B --> C["AudioContext graph<br/>highpass 80Hz<br/>compressor"]:::step
    C --> D["Analyser<br/>FFT bands"]:::viz
    C --> E["capture-processor<br/>PCM16 16kHz"]:::step
    D -->|"bass, mid, treble"| F["Three.js orb<br/>vertex displacement"]:::viz

    E --> G{"Adaptive VAD<br/>3x noise floor"}:::gate
    G -->|"below threshold"| H["Discard"]:::drop
    G -->|"speech detected"| I["Buffer<br/>320ms preroll<br/>1.44s hangover"]:::step
    I --> J["faster-whisper<br/>ws 8770"]:::ai
    J --> K{"Echo guard<br/>60 percent overlap<br/>with spoken text"}:::gate
    K -->|"self-talk"| L["Drop, show ECHO IGNORED"]:::drop
    K -->|"user speech"| M["processCommand"]:::router
    M --> N["Streaming TTS<br/>speak per sentence"]:::step
    N -.->|"sets ttsActive<br/>gates mic"| G
    N -.->|"_rememberSpoken"| K

    classDef io fill:#1f2933,stroke:#7b8794,stroke-width:2px,color:#ffffff
    classDef step fill:#5b21b6,stroke:#a78bfa,stroke-width:2px,color:#ffffff
    classDef gate fill:#7c2d12,stroke:#fb923c,stroke-width:3px,color:#ffffff
    classDef ai fill:#065f46,stroke:#34d399,stroke-width:2px,color:#ffffff
    classDef viz fill:#0c4a6e,stroke:#38bdf8,stroke-width:2px,color:#ffffff
    classDef drop fill:#450a0a,stroke:#ef4444,stroke-width:2px,color:#ffffff
    classDef router fill:#134e4a,stroke:#2dd4bf,stroke-width:2px,color:#ffffff
```

## 3. Process supervision

```mermaid
stateDiagram-v2
    [*] --> Probe: app.whenReady

    state "Probe port 11434" as Probe
    state "Reuse existing instance" as Reuse
    state "Spawn ollama serve" as Spawn
    state "Poll readiness, 30x1s" as Poll
    state "Preload model" as Preload
    state "Serving" as Serving
    state "Wait 15s" as Wait
    state "Degraded, BM25 only" as Degraded

    Probe --> Reuse: 200 within 1.5s
    Probe --> Spawn: no response

    Reuse --> Preload: never killed on quit
    Spawn --> Poll
    Poll --> Preload: ready
    Poll --> Degraded: all attempts fail

    Preload --> Serving: keep_alive 60m

    Serving --> Wait: process exit
    Wait --> Spawn: still running
    Wait --> [*]: app quitting
    Serving --> [*]: quit, kill only if spawned
    Degraded --> [*]

    classDef probe fill:#374151,stroke:#9ca3af,stroke-width:2px,color:#ffffff
    classDef good fill:#065f46,stroke:#34d399,stroke-width:2px,color:#ffffff
    classDef work fill:#1e3a8a,stroke:#60a5fa,stroke-width:2px,color:#ffffff
    classDef warn fill:#7c2d12,stroke:#fb923c,stroke-width:2px,color:#ffffff
    classDef bad fill:#7f1d1d,stroke:#f87171,stroke-width:2px,color:#ffffff

    class Probe probe
    class Reuse,Serving good
    class Spawn,Poll,Preload work
    class Wait warn
    class Degraded bad
```

## 4. Real-time whale stream

```mermaid
flowchart LR
    WS(["newHeads over wss"]) --> BLK["eth_getBlockByNumber"]
    WS --> LOGS["eth_getLogs<br/>Transfer topic, verified tokens"]
    BLK --> NAT["scanBlockTxs<br/>native transfers >= 100 ETH"]
    LOGS --> TOK["scanTokenLogs<br/>token transfers >= $1M"]
    LOGS --> ISS["scanIssuanceLogs<br/>mints and burns"]
    TOK --> AGG["aggregateTokenWhales<br/>one transaction = one movement"]
    NAT --> RANK["prioritizeAlerts<br/>ranked by measured USD"]
    AGG --> RANK
    RANK --> SAY["Announce top 2, summarise the rest"]
    ISS --> SAY
```

## 5. Pipeline

```mermaid
flowchart TB
    Q(["Question"]):::io --> INT["detectIntents<br/>code / academic / security /<br/>discuss / book / news / general"]:::prep
    INT --> CACHE{{"SearchCache<br/>3 min TTL"}}:::fuse
    CACHE -->|hit| OUT
    CACHE -->|miss| PLAN["buildProviders<br/>intent-gated"]:::prep

    PLAN --> GEN["duckduckgo-instant<br/>wikipedia<br/>google-news"]:::sparse
    PLAN --> SPEC["github / npm / crates<br/>arxiv / nvd / stackoverflow<br/>hackernews / openlibrary"]:::dense
    PLAN --> LOCAL["local index<br/>BM25 over crawled feeds"]:::prf

    GEN --> GATHER["gatherAll<br/>2s budget, minProviders 3"]:::fuse
    SPEC --> GATHER
    LOCAL --> RRF
    GATHER --> RRF{{"rrfFuse<br/>k = 60, provider weights"}}:::fuse

    RRF --> ANS["extractAnswer<br/>+ verifyAnswer"]:::prep
    ANS --> OUT(["Spoken answer + sources"]):::io

    CORR["suggestCorrection<br/>runs concurrently"]:::prf -.->|"only if < 3 results"| RRF

    classDef io fill:#1f2937,stroke:#111827,color:#f9fafb
    classDef prep fill:#eef2ff,stroke:#4338ca,color:#1e1b4b
    classDef sparse fill:#ecfdf5,stroke:#047857,color:#064e3b
    classDef dense fill:#fef3c7,stroke:#b45309,color:#451a03
    classDef prf fill:#fae8ff,stroke:#a21caf,color:#4a044e
    classDef fuse fill:#e0f2fe,stroke:#0369a1,color:#082f49
```

## 6. Retrieval engine

```mermaid
flowchart TB
    Q(["Query"]):::io --> TOK["tokenize<br/>stopwords, min length 2"]:::prep

    TOK --> BM25["BM25<br/>inverted index<br/>k1 1.5, b 0.75"]:::sparse
    TOK --> DENSE["Dense<br/>nomic-embed-text<br/>cosine, cutoff 0.3"]:::dense
    BM25 -->|"top 4 chunks"| PRFX["PRF<br/>top 6 non-query terms"]:::prf
    PRFX --> PRF2["BM25 second pass"]:::sparse

    BM25 -->|"weight 1.0"| RRF{{"Reciprocal Rank Fusion<br/>k equals 60<br/>tie-break on chunk index"}}:::fuse
    DENSE -->|"weight 1.0"| RRF
    PRF2 -->|"weight 0.5"| RRF

    RRF --> TOP["Top 5 passages"]:::result

    TOP --> GATE{"Ambiguity gate<br/>top1 minus top2<br/>over top1 under 0.15"}:::gate
    GATE -->|"clear winner<br/>about 50 percent<br/>90ms"| SENT
    GATE -->|"ambiguous<br/>and rerank opt-in<br/>4800ms"| RERANK["LLM rerank<br/>Gemma 3, JSON, temp 0"]:::ai
    RERANK -->|"timeout or bad JSON"| SENT
    RERANK -->|"reordered"| SENT

    SENT["Late sentence selection<br/>IDF-weighted overlap<br/>lead bias, budget 10"]:::select
    SENT --> ENT["Entity context<br/>Levenshtein 0.25<br/>relation-grouped"]:::select
    ENT --> CTX(["Context block<br/>best result first"]):::io

    Q -.->|"exact miss"| ENT

    classDef io fill:#1f2933,stroke:#7b8794,stroke-width:2px,color:#ffffff
    classDef prep fill:#374151,stroke:#9ca3af,stroke-width:2px,color:#ffffff
    classDef sparse fill:#1e3a8a,stroke:#60a5fa,stroke-width:2px,color:#ffffff
    classDef dense fill:#065f46,stroke:#34d399,stroke-width:2px,color:#ffffff
    classDef prf fill:#0c4a6e,stroke:#38bdf8,stroke-width:2px,color:#ffffff
    classDef fuse fill:#5b21b6,stroke:#a78bfa,stroke-width:3px,color:#ffffff
    classDef result fill:#3f3f46,stroke:#a1a1aa,stroke-width:2px,color:#ffffff
    classDef gate fill:#7c2d12,stroke:#fb923c,stroke-width:3px,color:#ffffff
    classDef ai fill:#831843,stroke:#f472b6,stroke-width:2px,color:#ffffff
    classDef select fill:#134e4a,stroke:#2dd4bf,stroke-width:2px,color:#ffffff
```

## 7. Pairing

```mermaid
sequenceDiagram
    autonumber
    actor U as User
    participant D as Desktop<br/>electron.js
    participant B as Bridge<br/>port 8765
    participant P as Phone<br/>LinkService
    participant W as WebSocket<br/>port 8766

    rect rgb(46, 16, 101)
    Note over U,D: Onboarding, once per device
    U->>D: "Jarvis, connect to my mobile"
    D->>B: openPairingWindow, 5 minutes
    D-->>U: QR code on HUD
    U->>P: scan with camera
    P->>B: GET /install
    B-->>P: landing page
    P->>B: GET /apk
    B-->>P: app-debug.apk
    U->>P: tap Install, then open
    end

    rect rgb(2, 44, 34)
    Note over P,W: Discovery and pairing, automatic
    P->>P: NSD discover _jarvis._tcp
    B-->>P: resolved, filtered addresses
    Note right of P: drops 169.254.x<br/>and 192.168.56.x
    P->>B: POST /pair
    alt window still open
        B-->>P: 200 token plus wsPort
    else window closed
        B-->>P: 403 pairing window is closed
        Note right of P: retry every 10s
    end
    end

    rect rgb(8, 51, 68)
    Note over P,W: Persistent link
    P->>W: connect, X-Jarvis-Token
    W->>W: timingSafeEqual
    alt token valid
        W-->>P: accepted
        P->>W: hello plus capabilities
        W-->>D: companion-devices event
        D-->>U: "Linked: Xiaomi M2101K6P"
    else token invalid
        W-->>P: close 4001
    end
    end

    rect rgb(19, 78, 74)
    Note over U,W: Steady state
    U->>D: "open settings on my phone"
    D->>D: routePhoneCommand
    D->>W: id, open_app_by_name, name settings
    W->>P: forward
    P->>P: resolve name to package
    P-->>W: ok, com.android.settings
    W-->>D: result
    D-->>U: "Settings is now open on your phone, Sir."
    end

    Note over P,W: on disconnect, reconnect with<br/>exponential backoff capped at 30s
```

