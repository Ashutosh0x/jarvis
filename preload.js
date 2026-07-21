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
    onCompanionPaired: createSafeListener('companion-paired'),
    onCompanionEvent: createSafeListener('companion-event'),
    onCompanionDevices: createSafeListener('companion-devices'),
    // Tier 3: wireless ADB (curated methods only — no raw shell passthrough)
    adbCommand: (method, args) => ipcRenderer.invoke('adb-command', method, args),
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
    // Finance watchlist (read + manage; NO order placement exists)
    watchlistGet: () => ipcRenderer.invoke('watchlist-get'),
    watchlistAdd: (entry) => ipcRenderer.invoke('watchlist-add', entry),
    watchlistRemove: (symbol) => ipcRenderer.invoke('watchlist-remove', symbol),
    // On-demand live quote (name or ticker) and keyless news headlines
    getQuote: (text) => ipcRenderer.invoke('get-quote', text),
    getNews: (opts) => ipcRenderer.invoke('get-news', opts),
    // Historical daily closes for the quant analytics engine
    getHistory: (opts) => ipcRenderer.invoke('get-history', opts),
    // On-chain reads (keyless public RPC, read-only — no signing exists)
    onchainBalance: (opts) => ipcRenderer.invoke('onchain-balance', opts),
    onchainGas: (opts) => ipcRenderer.invoke('onchain-gas', opts),
    onchainTxCount: (opts) => ipcRenderer.invoke('onchain-txcount', opts),
    onchainToken: (opts) => ipcRenderer.invoke('onchain-token', opts),
    onchainCall: (opts) => ipcRenderer.invoke('onchain-call', opts),
    onchainTx: (opts) => ipcRenderer.invoke('onchain-tx', opts),
    fileOperation: (operation, ...args) => ipcRenderer.invoke('file-operation', operation, ...args),
    openWebsite: (url) => ipcRenderer.send('open-website', url),
    readClipboard: () => ipcRenderer.invoke('read-clipboard'),
    writeClipboard: (text) => ipcRenderer.invoke('write-clipboard', text),
    windowControl: (action) => ipcRenderer.send('window-control', action),
    getOSInfo: () => ipcRenderer.invoke('get-os-info'),
    // Additional safe listeners
    onWebsiteOpened: createSafeListener('website-opened'),
    onWindowControlResult: createSafeListener('window-control-result')
});
