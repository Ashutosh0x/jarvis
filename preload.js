// Preload script for secure IPC communication
const { contextBridge, ipcRenderer } = require('electron');

// SECURITY FIX: Use removeListener pattern to prevent memory leaks
const createSafeListener = (channel) => {
    return (callback) => {
        const handler = (event, ...args) => callback(event, ...args);
        ipcRenderer.on(channel, handler);
        // Return cleanup function
        return () => ipcRenderer.removeListener(channel, handler);
    };
};

contextBridge.exposeInMainWorld('electronAPI', {
    openApp: (app) => ipcRenderer.send('open-app', app),
    systemCommand: (command) => ipcRenderer.send('system-command', command),
    // Use safe listener pattern (returns cleanup function)
    onAppOpened: createSafeListener('app-opened'),
    onSystemCommandResult: createSafeListener('system-command-result'),
    captureScreen: () => ipcRenderer.invoke('capture-screen'),
    // Unlimited-OCR: accepts { filePath } for images/PDFs or { imageBase64 } for captures
    performOCR: (request) => ipcRenderer.invoke('perform-ocr', request),
    checkOcrServer: () => ipcRenderer.invoke('check-ocr-server'),
    checkVisionServer: () => ipcRenderer.invoke('check-vision-server'),
    // System telemetry for the diagnostics HUD
    getSystemTelemetry: () => ipcRenderer.invoke('get-system-telemetry'),
    onSystemTelemetry: createSafeListener('system-telemetry'),
    // RAG memory persistence + ATDP-lite trajectory logging
    ragLoad: () => ipcRenderer.invoke('rag-load'),
    ragSave: (data) => ipcRenderer.invoke('rag-save', data),
    logTrajectory: (entry) => ipcRenderer.invoke('log-trajectory', entry),
    // Persistent interaction log (local turns) + its aggregate stats
    logInteraction: (entry) => ipcRenderer.invoke('log-interaction', entry),
    getInteractionStats: () => ipcRenderer.invoke('get-interaction-stats'),
    // Reflection / memory consolidation ("sleep") — read raw experience, persist learnings
    getInteractions: (opts) => ipcRenderer.invoke('get-interactions', opts),
    saveReflection: (entry) => ipcRenderer.invoke('save-reflection', entry),
    getReflections: (opts) => ipcRenderer.invoke('get-reflections', opts),
    // Confidence ledger for consolidated facts (corroboration gate + decay)
    loadFactStore: () => ipcRenderer.invoke('load-fact-store'),
    saveFactStore: (data) => ipcRenderer.invoke('save-fact-store', data),
    // Memory audit log — version history of belief changes
    logMemoryEvent: (entry) => ipcRenderer.invoke('log-memory-event', entry),
    getMemoryAudit: (opts) => ipcRenderer.invoke('get-memory-audit', opts),
    // Phone bridge (Wi-Fi notification relay)
    onPhoneNotification: createSafeListener('phone-notification'),
    getPhoneBridgeInfo: () => ipcRenderer.invoke('get-phone-bridge-info'),
    // Android companion: onboarding + Tier 1/2 control over the WebSocket link
    companionOpenPairing: () => ipcRenderer.invoke('companion-open-pairing'),
    companionClosePairing: () => ipcRenderer.invoke('companion-close-pairing'),
    companionDevices: () => ipcRenderer.invoke('companion-devices'),
    companionCommand: (action, params) => ipcRenderer.invoke('companion-command', action, params),
    /* Windows system commands. `systemAction` covers the four that end the
       session (lock, sleep, hibernate, sign out) and is fire-and-forget by
       nature — the process that would confirm is going away. */
    systemAction: (action) => ipcRenderer.invoke('system-action', action),
    emptyRecycleBin: () => ipcRenderer.invoke('empty-recycle-bin'),
    setTheme: (mode) => ipcRenderer.invoke('set-theme', mode),
    setDnd: (on) => ipcRenderer.invoke('set-dnd', on),
    diskSpace: () => ipcRenderer.invoke('disk-space'),
    systemUptime: () => ipcRenderer.invoke('system-uptime'),
    /* Feedback on the one surface that has a motor.
       Deliberately fire-and-forget: this is called from inside pointer
       handlers, and a rejected promise from a phone that just disconnected
       must never surface as an error in the middle of a click. It rides the
       existing authenticated command channel rather than opening a second
       route, so it inherits the same token and the same bounds. */
    sendCompanionHaptic: (effect) => {
        ipcRenderer.invoke('companion-command', 'haptic', {
            effect: String(effect).slice(0, 32)
        }).catch(() => { /* no device, or the link is down */ });
    },
    onCompanionPaired: createSafeListener('companion-paired'),
    onCompanionEvent: createSafeListener('companion-event'),
    onCompanionDevices: createSafeListener('companion-devices'),
    // Tier 3: wireless ADB (curated methods only — no raw shell passthrough)
    adbCommand: (method, args) => ipcRenderer.invoke('adb-command', method, args),
    /* Live screen mirroring over scrcpy. The encoded video arrives on its own
       channel and NOT through createSafeListener: that wrapper is built for
       occasional events, and the mirror pushes ~60 messages a second. It gets
       a single dedicated subscription that the panel replaces on each session,
       so a leaked handler cannot double-decode the stream. */
    mirror: {
        devices: () => ipcRenderer.invoke('mirror-devices'),
        start: (opts) => ipcRenderer.invoke('mirror-start', opts || {}),
        stop: () => ipcRenderer.invoke('mirror-stop'),
        status: () => ipcRenderer.invoke('mirror-status'),
        serverInfo: () => ipcRenderer.invoke('mirror-server-info'),
        input: (kind, payload) => ipcRenderer.invoke('mirror-input', kind, payload),
        onVideo: (cb) => {
            ipcRenderer.removeAllListeners('mirror-video');
            ipcRenderer.on('mirror-video', (_e, packet) => cb(packet));
            return () => ipcRenderer.removeAllListeners('mirror-video');
        },
        // Same single-subscription rule as video: PCM arrives continuously, and
        // a leaked handler would feed the player twice.
        onAudio: (cb) => {
            ipcRenderer.removeAllListeners('mirror-audio');
            ipcRenderer.on('mirror-audio', (_e, chunk) => cb(chunk));
            return () => ipcRenderer.removeAllListeners('mirror-audio');
        },
        onStatus: createSafeListener('mirror-status')
    },
    // Event-driven core (JARVIS v4)
    onJarvisEvent: createSafeListener('jarvis-event'),
    getBluetoothAudio: () => ipcRenderer.invoke('get-bluetooth-audio'),
    switchAudioOutput: (deviceName) => ipcRenderer.invoke('switch-audio-output', deviceName),
    // Secure credential vault (set/check/delete only — raw values never returned)
    secureCredSet: (name, value) => ipcRenderer.invoke('secure-cred-set', name, value),
    secureCredList: () => ipcRenderer.invoke('secure-cred-list'),
    secureCredDelete: (name) => ipcRenderer.invoke('secure-cred-delete', name),
    // Keyless web search for the local LLM
    webSearch: (query) => ipcRenderer.invoke('web-search', query),
    // Windows settings deep links (allowlisted pages)
    openSettings: (page) => ipcRenderer.invoke('open-settings', page),
    // Wi-Fi: scan networks + connect to saved profiles (no admin needed)
    wifiScan: () => ipcRenderer.invoke('wifi-scan'),
    wifiConnect: (name) => ipcRenderer.invoke('wifi-connect', name),
    wifiDisconnect: () => ipcRenderer.invoke('wifi-disconnect'),
    wifiInfo: () => ipcRenderer.invoke('wifi-info'),
    // Connection-level network visibility (read-only; no capture, no injection)
    networkConnections: () => ipcRenderer.invoke('network-connections'),
    portServices: () => ipcRenderer.invoke('port-services'),
    // Keyboard + window control. Keys go to the FOCUSED window; handlers report
    // which one received them. Closing is graceful only — no force-kill exists.
    focusedWindow: () => ipcRenderer.invoke('focused-window'),
    listWindows: () => ipcRenderer.invoke('list-windows'),
    typeText: (opts) => ipcRenderer.invoke('type-text', opts),
    focusWindow: (opts) => ipcRenderer.invoke('focus-window', opts),
    closeWindow: (opts) => ipcRenderer.invoke('close-window', opts),
    networkResolve: (opts) => ipcRenderer.invoke('network-resolve', opts),
    networkTraffic: () => ipcRenderer.invoke('network-traffic'),
    networkCaptureCapability: () => ipcRenderer.invoke('network-capture-capability'),
    // Discovery: resolve names, list radios/neighbours (measured, never guessed)
    resolveHost: (opts) => ipcRenderer.invoke('resolve-host', opts),
    wifiNetworksDetail: () => ipcRenderer.invoke('wifi-networks-detail'),
    lanNeighbours: () => ipcRenderer.invoke('lan-neighbours'),
    bluetoothDevices: () => ipcRenderer.invoke('bluetooth-devices'),
    // Radio power state (WinRT). radioSet is state-changing and is only called
    // after the user answers an explicit spoken confirmation.
    // Full process visibility — read-only; no kill/stop handler exists
    systemProcesses: () => ipcRenderer.invoke('system-processes'),
    // Metric history + derived event log (telemetry tier, never embedded in RAG)
    getMetricHistory: (opts) => ipcRenderer.invoke('get-metric-history', opts),
    getSystemEvents: (opts) => ipcRenderer.invoke('get-system-events', opts),
    radioState: () => ipcRenderer.invoke('radio-state'),
    radioSet: (opts) => ipcRenderer.invoke('radio-set', opts),
    // Finance watchlist (read + manage; NO order placement exists)
    watchlistGet: () => ipcRenderer.invoke('watchlist-get'),
    watchlistAdd: (entry) => ipcRenderer.invoke('watchlist-add', entry),
    watchlistRemove: (symbol) => ipcRenderer.invoke('watchlist-remove', symbol),
    // On-demand live quote (name or ticker) and keyless news headlines
    getQuote: (text) => ipcRenderer.invoke('get-quote', text),
    getNews: (opts) => ipcRenderer.invoke('get-news', opts),
    // Real web search, raced across keyless providers in the main process
    // (the renderer cannot fetch these directly — CORS blocks it).
    webSearch: (opts) => ipcRenderer.invoke('web-search', opts),

    // Auto-update. Download and install are explicit, never automatic, so an
    // update cannot restart the app mid-conversation.
    updateStatus: () => ipcRenderer.invoke('update-status'),
    updateDownload: () => ipcRenderer.invoke('update-download'),
    updateInstall: () => ipcRenderer.invoke('update-install'),
    onUpdateStatus: (cb) => {
        const handler = (_e, state) => cb(state);
        ipcRenderer.on('update-status', handler);
        return () => ipcRenderer.removeListener('update-status', handler);
    },
    // Historical daily closes for the quant analytics engine
    getHistory: (opts) => ipcRenderer.invoke('get-history', opts),
    getSectorMove: (opts) => ipcRenderer.invoke('get-sector-move', opts),
    getPortfolioSeries: (opts) => ipcRenderer.invoke('get-portfolio-series', opts),
    dartFilings: (opts) => ipcRenderer.invoke('dart-filings', opts),
    // Security advisories: Chrome Releases RSS + NVD, both keyless. Exists so
    // CVE answers come from an advisory rather than from the model.
    // Continuous ingestion: fetch verified feeds, record events with provenance
    feedFetch: (opts) => ipcRenderer.invoke('feed-fetch', opts),
    edgarSearch: (opts) => ipcRenderer.invoke('edgar-search', opts),
    secDocument: (opts) => ipcRenderer.invoke('sec-document', opts),
    // Per-company filings: the CIK and form type only — main builds the URL.
    secCompanyFeed: (opts) => ipcRenderer.invoke('sec-company-feed', opts),
    secTickers: (opts) => ipcRenderer.invoke('sec-tickers', opts || {}),
    feedRecord: (opts) => ipcRenderer.invoke('feed-record', opts),
    feedHistory: (opts) => ipcRenderer.invoke('feed-history', opts || {}),
    feedSeenGet: () => ipcRenderer.invoke('feed-seen-get'),
    feedSeenSet: (opts) => ipcRenderer.invoke('feed-seen-set', opts),
    securityAdvisories: (opts) => ipcRenderer.invoke('security-advisories', opts || {}),
    cveLookup: (opts) => ipcRenderer.invoke('cve-lookup', opts),
    // Prediction markets (Polymarket + Kalshi). Read-only: no order placement
    // exists on either platform anywhere in this project.
    predictionSearch: (opts) => ipcRenderer.invoke('prediction-search', opts),
    predictionTrending: (opts) => ipcRenderer.invoke('prediction-trending', opts || {}),
    predictionMarket: (opts) => ipcRenderer.invoke('prediction-market', opts),
    predictionOrderbook: (opts) => ipcRenderer.invoke('prediction-orderbook', opts),
    // On-chain reads (keyless public RPC, read-only — no signing exists)
    onchainBalance: (opts) => ipcRenderer.invoke('onchain-balance', opts),
    onchainGas: (opts) => ipcRenderer.invoke('onchain-gas', opts),
    onchainTxCount: (opts) => ipcRenderer.invoke('onchain-txcount', opts),
    onchainToken: (opts) => ipcRenderer.invoke('onchain-token', opts),
    onchainCall: (opts) => ipcRenderer.invoke('onchain-call', opts),
    onchainTx: (opts) => ipcRenderer.invoke('onchain-tx', opts),
    // Contract vs externally-owned account — on-chain fact, not attribution
    onchainCode: (opts) => ipcRenderer.invoke('onchain-code', opts),
    // Bounded Transfer-log reads (keyless, ~24h window) — Ondo mint/redeem flows
    onchainLogs: (opts) => ipcRenderer.invoke('onchain-logs', opts),
    // Dune analytics (key-gated on dune_api_key in the vault; vetted SQL only)
    duneWhaleTransfers: (opts) => ipcRenderer.invoke('dune-whale-transfers', opts || {}),
    duneTopHolders: (opts) => ipcRenderer.invoke('dune-top-holders', opts),
    duneSupplyHistory: (opts) => ipcRenderer.invoke('dune-supply-history', opts),
    // Real-time chain stream + address watchlist (read-only, keyless)
    chainStreamStart: (opts) => ipcRenderer.invoke('chain-stream-start', opts || {}),
    chainStreamStop: () => ipcRenderer.invoke('chain-stream-stop'),
    chainStreamStatus: () => ipcRenderer.invoke('chain-stream-status'),
    chainWatchlistAdd: (opts) => ipcRenderer.invoke('chain-watchlist-add', opts),
    chainWatchlistGet: () => ipcRenderer.invoke('chain-watchlist-get'),
    chainWatchlistRemove: (opts) => ipcRenderer.invoke('chain-watchlist-remove', opts),
    chainAlertsSummary: (opts) => ipcRenderer.invoke('chain-alerts-summary', opts || {}),
    // Keyed providers — Alchemy (EVM portfolio/prices) + Helius (Solana).
    // Still read-only; the raw payload comes back and chainIntel.js parses it.
    chainProvidersStatus: () => ipcRenderer.invoke('chain-providers-status'),
    chainIssuance: (opts) => ipcRenderer.invoke('chain-issuance', opts || {}),
    solanaSupply: (opts) => ipcRenderer.invoke('solana-supply', opts || {}),
    chainPortfolio: (opts) => ipcRenderer.invoke('chain-portfolio', opts),
    chainPrices: (opts) => ipcRenderer.invoke('chain-prices', opts),
    solanaActivity: (opts) => ipcRenderer.invoke('solana-activity', opts),
    solanaAssets: (opts) => ipcRenderer.invoke('solana-assets', opts),
    solanaCall: (opts) => ipcRenderer.invoke('solana-call', opts),
    // Prediction markets (read-only, keyless public APIs — NO betting/trading exists)
    predictionSearch: (query, source) => ipcRenderer.invoke('prediction-search', query, source),
    predictionMarket: (id, source) => ipcRenderer.invoke('prediction-market', id, source),
    predictionTrending: (source) => ipcRenderer.invoke('prediction-trending', source),
    predictionOrderbook: (id, source) => ipcRenderer.invoke('prediction-orderbook', id, source),
    predictionWatchlistGet: () => ipcRenderer.invoke('prediction-watchlist-get'),
    predictionWatchlistAdd: (market) => ipcRenderer.invoke('prediction-watchlist-add', market),
    predictionWatchlistRemove: (id) => ipcRenderer.invoke('prediction-watchlist-remove', id),
    onPredictionAlert: createSafeListener('prediction-alert'),
    fileOperation: (operation, ...args) => ipcRenderer.invoke('file-operation', operation, ...args),
    // Opening a written file in an editor, and revealing it in the file
    // manager. Both validate the path in the main process; the renderer cannot
    // reach outside the allowed user folders through either.
    openEditor: (filePath, editor) => ipcRenderer.invoke('open-editor', filePath, editor),
    // Google Calendar. Credentials live in the main process only — the
    // renderer can ask for events and create them, never see a token.
    // Autostart and background running
    autostartStatus: () => ipcRenderer.invoke('autostart-status'),
    autostartSet: (enabled) => ipcRenderer.invoke('autostart-set', enabled),
    // The `jarvis` terminal command: whether it works, and linking it.
    terminalCommandStatus: () => ipcRenderer.invoke('terminal-command-status'),
    terminalCommandLink: (enabled) => ipcRenderer.invoke('terminal-command-link', enabled),
    hideWindow: () => ipcRenderer.invoke('window-hide'),
    gcalStatus: () => ipcRenderer.invoke('gcal-status'),
    gcalConnect: () => ipcRenderer.invoke('gcal-connect'),
    gcalDisconnect: () => ipcRenderer.invoke('gcal-disconnect'),
    gcalList: (opts) => ipcRenderer.invoke('gcal-list', opts),
    gcalCreate: (draft) => ipcRenderer.invoke('gcal-create', draft),
    gcalDelete: (eventId) => ipcRenderer.invoke('gcal-delete', eventId),
    gcalMeetSpace: () => ipcRenderer.invoke('gcal-meet-space'),
    revealInFolder: (filePath) => ipcRenderer.invoke('reveal-in-folder', filePath),
    openWebsite: (url) => ipcRenderer.send('open-website', url),
    readClipboard: () => ipcRenderer.invoke('read-clipboard'),
    writeClipboard: (text) => ipcRenderer.invoke('write-clipboard', text),
    windowControl: (action) => ipcRenderer.send('window-control', action),
    getOSInfo: () => ipcRenderer.invoke('get-os-info'),
    /* Foundry — 3D modelling through Blender. The renderer never learns where
       Blender is or what it is spawned with; it sends a sentence and receives
       a result, the same shape as every other privileged operation here. */
    foundryCreate: (request) => ipcRenderer.invoke('foundry-create', request),
    foundryDoctor: () => ipcRenderer.invoke('foundry-doctor'),
    /* The viewer reads finished jobs off disk. Listing and image bytes are
       separate calls: a render is ~300 KB, so base64-ing every job into one
       response would push tens of megabytes across the bridge to draw one. */
    foundryJobs: (opts) => ipcRenderer.invoke('foundry-jobs', opts),
    foundryImage: (jobId) => ipcRenderer.invoke('foundry-image', jobId),
    /* The GLB the 3D viewer orbits, and a rebuild for jobs made before GLB
       export became automatic — the saved spec is what makes that possible. */
    foundryMesh: (jobId) => ipcRenderer.invoke('foundry-mesh', jobId),
    /* Globe map data, read by the main process because fetch() cannot touch
       file:// and the packaged window is loaded from disk. */
    loadGeoAsset: (name) => ipcRenderer.invoke('globe-geo', name),
    /* Google Maps Platform. Returns data, never the key that fetched it. */
    googleMaps: (method, params) => ipcRenderer.invoke('google-maps', method, params),
    googleMapsStatus: () => ipcRenderer.invoke('google-maps-status'),
    /* Kept as a named shortcut: the landmark ring is the hot path. */
    placesNearby: (opts) => ipcRenderer.invoke('google-maps', 'placesNearby', opts),
    foundryRebuild: (jobId) => ipcRenderer.invoke('foundry-rebuild', jobId),
    onFoundryStatus: createSafeListener('foundry-status'),
    onFoundryJobComplete: createSafeListener('foundry-job-complete'),
    // Additional safe listeners
    onWebsiteOpened: createSafeListener('website-opened'),
    onWindowControlResult: createSafeListener('window-control-result')
});
