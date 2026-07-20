const { app, BrowserWindow, ipcMain, desktopCapturer, clipboard, shell } = require('electron');
const path = require('path');
const { exec, execFile, spawn } = require('child_process');
const os = require('os');
const fs = require('fs').promises;
const axios = require('axios');

/* =========================
   UNLIMITED-OCR CONFIG
   Local SGLang server running baidu/Unlimited-OCR
   (see docs: huggingface.co/baidu/Unlimited-OCR)
========================= */
const OCR_SERVER_URL = process.env.JARVIS_OCR_URL || 'http://127.0.0.1:10000';
const OCR_MAX_PDF_PAGES = 20; // safety limit; model supports dozens of pages in one pass
const OCR_TIMEOUT_MS = 300000; // long-horizon parsing can take minutes on consumer GPUs

// GPU acceleration enabled for smooth visualizer performance
// Note: If transparency breaks, uncomment the line below
// app.disableHardwareAcceleration();

// Allow TTS/audio playback without requiring a prior user gesture
// (Chromium's autoplay policy would otherwise mute speech on startup)
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let mainWindow;

/* =========================
   SECURITY UTILITIES
========================= */

// Whitelist of allowed applications (CRITICAL: no arbitrary execution)
const ALLOWED_APPS = {
    chrome: { path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', args: [] },
    notepad: { path: 'notepad.exe', args: [] },
    explorer: { path: 'explorer.exe', args: [] },
    vscode: { path: 'code', args: [] },
    downloads: { path: 'explorer.exe', args: [] },
    calculator: { path: 'calc.exe', args: [] },
    paint: { path: 'mspaint.exe', args: [] }
};

// Validate and sanitize file paths to prevent path traversal
function validatePath(requestedPath) {
    const homedir = os.homedir();
    const allowedRoots = [
        path.join(homedir, 'Downloads'),
        path.join(homedir, 'Documents'),
        path.join(homedir, 'Desktop'),
        path.join(homedir, 'Pictures'),
        path.join(homedir, 'Videos'),
        path.join(homedir, 'Music'),
        // OneDrive known-folder redirection (Windows moves these under OneDrive)
        path.join(homedir, 'OneDrive', 'Documents'),
        path.join(homedir, 'OneDrive', 'Desktop'),
        path.join(homedir, 'OneDrive', 'Pictures')
    ];

    // Normalize and resolve the path
    const resolvedPath = path.resolve(requestedPath);

    // Check if path is within allowed directories
    const isAllowed = allowedRoots.some(root => resolvedPath.startsWith(root));

    if (!isAllowed) {
        throw new Error(`Access denied: Path '${requestedPath}' is outside allowed directories`);
    }

    // Block path traversal attempts
    if (requestedPath.includes('..') || requestedPath.includes('%')) {
        throw new Error('Invalid path: Path traversal not allowed');
    }

    return resolvedPath;
}

// Validate URL format
function validateUrl(url) {
    try {
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
            throw new Error('Only HTTP and HTTPS URLs are allowed');
        }
        return parsed.href;
    } catch (e) {
        throw new Error(`Invalid URL: ${url}`);
    }
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,

        // ✅ Transparency
        transparent: true,
        backgroundColor: '#00000000',

        // ✅ Frameless floating window
        frame: false,
        hasShadow: false,

        // Optional HUD behavior
        alwaysOnTop: false,

        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            enableWebSQL: false,
            // Always-on assistant: never throttle the renderer when the
            // window is hidden/occluded — the voice loop must keep running.
            backgroundThrottling: false
        },

        show: false
    });

    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
        mainWindow.setBackgroundColor('#00000000');
    });

    mainWindow.setMenuBarVisibility(false);

    if (process.env.NODE_ENV === 'development') {
        mainWindow.loadURL('http://localhost:5173');

        // ⚠️ DEVTOOLS BREAK TRANSPARENCY
        // Enable only if debugging
        // mainWindow.webContents.openDevTools({ mode: 'detach' });
    } else {
        mainWindow.loadFile(path.join(__dirname, 'dist/index.html'));
    }

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

app.whenReady().then(async () => {
    createWindow();
    startTelemetry();
    phoneBridgeToken = await loadPhoneBridgeToken();
    startPhoneBridge();
    // Event-driven core watchers
    startDownloadsWatcher();
    startClipboardMonitor();
    startActiveWindowTracker();
    startFinanceService();
    startSttServer();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

/* =========================
   IPC / SYSTEM HANDLERS
========================= */

// SECURITY: Use whitelist-only app launching - NO arbitrary command execution
ipcMain.on('open-app', (event, appName) => {
    try {
        // Sanitize input - only allow alphanumeric app names
        const sanitizedName = String(appName).toLowerCase().replace(/[^a-z0-9]/g, '');

        if (!ALLOWED_APPS[sanitizedName]) {
            event.reply('app-opened', {
                success: false,
                error: `Application '${appName}' is not in the allowed list`
            });
            return;
        }

        const appConfig = ALLOWED_APPS[sanitizedName];

        if (sanitizedName === 'downloads') {
            const downloadsPath = path.join(os.homedir(), 'Downloads');
            // Use shell.openPath for safe directory opening
            shell.openPath(downloadsPath);
        } else if (sanitizedName === 'vscode') {
            // VS Code uses 'code' command
            exec('code', (error) => {
                if (error) console.warn('VS Code launch warning:', error.message);
            });
        } else {
            // Use execFile for other apps (safer than exec)
            execFile(appConfig.path, appConfig.args, (error) => {
                if (error) console.warn(`App launch warning for ${sanitizedName}:`, error.message);
            });
        }

        event.reply('app-opened', { success: true, app: sanitizedName });
    } catch (error) {
        event.reply('app-opened', { success: false, error: error.message });
    }
});

// SECURITY: Only allow whitelisted system commands with proper error handling
ipcMain.on('system-command', (event, command) => {
    const sanitizedCmd = String(command).toLowerCase().replace(/[^a-z-]/g, '');

    const executeCommand = (cmd, successMsg) => {
        exec(cmd, (error, stdout, stderr) => {
            if (error) {
                console.error(`System command error (${sanitizedCmd}):`, error.message);
                event.reply('system-command-result', { success: false, error: error.message });
            } else {
                event.reply('system-command-result', { success: true, command: sanitizedCmd });
            }
        });
    };

    try {
        switch (sanitizedCmd) {
            case 'shutdown':
                executeCommand('shutdown /s /t 5');
                break;
            case 'restart':
                executeCommand('shutdown /r /t 5');
                break;
            case 'mute':
                // Use PowerShell instead of nircmd (native, no external dependency)
                executeCommand('powershell -Command "(New-Object -ComObject WScript.Shell).SendKeys([char]173)"');
                break;
            case 'volume-up':
                // Use PowerShell for volume control
                executeCommand('powershell -Command "(New-Object -ComObject WScript.Shell).SendKeys([char]175)"');
                break;
            case 'volume-down':
                executeCommand('powershell -Command "(New-Object -ComObject WScript.Shell).SendKeys([char]174)"');
                break;
            case 'play-pause':
                executeCommand('powershell -Command "(New-Object -ComObject WScript.Shell).SendKeys([char]179)"');
                break;
            case 'next-track':
                executeCommand('powershell -Command "(New-Object -ComObject WScript.Shell).SendKeys([char]176)"');
                break;
            case 'prev-track':
                executeCommand('powershell -Command "(New-Object -ComObject WScript.Shell).SendKeys([char]177)"');
                break;
            case 'brightness-up':
                executeCommand('powershell -Command "(Get-WmiObject -Namespace root/WMI -Class WmiMonitorBrightnessMethods).WmiSetBrightness(1,80)"');
                break;
            default:
                console.log('Unknown/disallowed command:', command);
                event.reply('system-command-result', { success: false, error: 'Unknown command' });
                return;
        }
    } catch (error) {
        event.reply('system-command-result', { success: false, error: error.message });
    }
});

// Screen Capture Handler - Returns actual screenshot as base64
ipcMain.handle('capture-screen', async () => {
    try {
        const sources = await desktopCapturer.getSources({
            types: ['screen'],
            thumbnailSize: { width: 1920, height: 1080 }
        });

        if (sources.length === 0) {
            throw new Error('No screen sources available');
        }

        const primarySource = sources[0];

        // Get the thumbnail as a NativeImage and convert to base64
        const thumbnail = primarySource.thumbnail;
        const base64Image = thumbnail.toDataURL();

        return {
            success: true,
            sourceId: primarySource.id,
            image: base64Image,
            width: thumbnail.getSize().width,
            height: thumbnail.getSize().height
        };
    } catch (error) {
        console.error('Screen capture error:', error);
        return { success: false, error: error.message };
    }
});

/* =========================
   UNLIMITED-OCR (Baidu, R-SWA long-horizon parsing)
   Accepts { filePath } (image or PDF) OR { imageBase64 } (screen capture).
   Talks to a local SGLang server exposing an OpenAI-compatible endpoint.
========================= */

// Health check so the renderer can toggle between Cloud OCR and Local OCR
ipcMain.handle('check-ocr-server', async () => {
    try {
        const res = await axios.get(`${OCR_SERVER_URL}/health`, { timeout: 2000 });
        return { available: res.status === 200, url: OCR_SERVER_URL };
    } catch {
        // SGLang also answers /v1/models; try it as a fallback probe
        try {
            const res = await axios.get(`${OCR_SERVER_URL}/v1/models`, { timeout: 2000 });
            return { available: res.status === 200, url: OCR_SERVER_URL };
        } catch {
            return { available: false, url: OCR_SERVER_URL };
        }
    }
});

async function collectOcrImages(request) {
    // Returns { images: [base64...], isMultiPage: bool }
    if (request.imageBase64) {
        // Direct screen capture / in-memory image (data URL or raw base64)
        const raw = String(request.imageBase64).replace(/^data:image\/\w+;base64,/, '');
        return { images: [raw], isMultiPage: false };
    }

    const validatedPath = validatePath(request.filePath);
    const ext = path.extname(validatedPath).toLowerCase();

    if (ext === '.pdf') {
        // pdf-to-img is ESM-only; load it dynamically from CommonJS
        const { pdf } = await import('pdf-to-img');
        const doc = await pdf(validatedPath, { scale: 2 });
        const images = [];
        for await (const pageBuffer of doc) {
            images.push(pageBuffer.toString('base64'));
            if (images.length >= OCR_MAX_PDF_PAGES) break;
        }
        if (images.length === 0) throw new Error('PDF contained no renderable pages');
        return { images, isMultiPage: images.length > 1 };
    }

    if (!['.png', '.jpg', '.jpeg', '.webp', '.bmp'].includes(ext)) {
        throw new Error(`Unsupported file type for OCR: ${ext}`);
    }
    const imageBuffer = await fs.readFile(validatedPath);
    return { images: [imageBuffer.toString('base64')], isMultiPage: false };
}

ipcMain.handle('perform-ocr', async (event, request) => {
    try {
        // Back-compat: old callers passed a bare string path
        if (typeof request === 'string') request = { filePath: request };
        if (!request || (!request.filePath && !request.imageBase64)) {
            throw new Error('perform-ocr requires a filePath or imageBase64');
        }

        const { images, isMultiPage } = await collectOcrImages(request);

        // Model card: single page -> "gundam" mode + window 128,
        //             multi-page  -> "base" mode + window 1024
        const imageMode = isMultiPage ? 'base' : (request.mode || 'gundam');
        const content = [
            { type: 'text', text: isMultiPage ? 'Multi page parsing.' : 'document parsing.' },
            ...images.map(b64 => ({
                type: 'image_url',
                image_url: { url: `data:image/png;base64,${b64}` }
            }))
        ];

        const payload = {
            model: 'Unlimited-OCR',
            messages: [{ role: 'user', content }],
            temperature: 0,
            max_tokens: 32768,
            skip_special_tokens: false,
            images_config: { image_mode: imageMode },
            custom_logit_processor: 'DeepseekOCRNoRepeatNGramLogitProcessor',
            custom_params: {
                ngram_size: 35,
                window_size: isMultiPage ? 1024 : 128
            }
        };

        const response = await axios.post(
            `${OCR_SERVER_URL}/v1/chat/completions`,
            payload,
            { timeout: OCR_TIMEOUT_MS }
        );

        const markdown = response.data?.choices?.[0]?.message?.content;
        if (!markdown) throw new Error('OCR server returned an empty response');

        return { success: true, markdown, pages: images.length, mode: imageMode };
    } catch (error) {
        console.error('Unlimited-OCR error:', error.message);
        const hint = error.code === 'ECONNREFUSED'
            ? ` (Is the SGLang server running at ${OCR_SERVER_URL}? See docs/OCR-SETUP.md)`
            : '';
        return { success: false, error: `${error.message}${hint}` };
    }
});

// File Operations Handler - SECURITY: All paths validated against allowed directories
ipcMain.handle('file-operation', async (event, operation, ...args) => {
    try {
        const sanitizedOp = String(operation).toLowerCase().replace(/[^a-z-]/g, '');

        switch (sanitizedOp) {
            case 'create-folder': {
                const folderPath = validatePath(args[0]);
                await fs.mkdir(folderPath, { recursive: true });
                return { success: true, path: folderPath };
            }

            case 'delete-file': {
                const filePath = validatePath(args[0]);
                // Extra safety: only allow deletion of files in Downloads
                if (!filePath.includes(path.join(os.homedir(), 'Downloads'))) {
                    throw new Error('File deletion only allowed in Downloads folder');
                }
                await fs.unlink(filePath);
                return { success: true, path: filePath };
            }

            case 'list-files': {
                const dirPath = args[0] ? validatePath(args[0]) : path.join(os.homedir(), 'Downloads');
                const files = await fs.readdir(dirPath);
                return { success: true, files };
            }

            case 'read-file': {
                const readPath = validatePath(args[0]);
                const content = await fs.readFile(readPath, 'utf-8');
                return { success: true, content };
            }

            case 'search-files': {
                const searchDir = args[0] ? validatePath(args[0]) : path.join(os.homedir(), 'Downloads');
                // Sanitize search pattern to prevent regex injection
                const pattern = String(args[1] || '').replace(/[^a-zA-Z0-9._-]/g, '');
                const allFiles = await fs.readdir(searchDir, { withFileTypes: true });
                const matchingFiles = allFiles
                    .filter(file => file.name.toLowerCase().includes(pattern.toLowerCase()))
                    .map(file => file.name);
                return { success: true, files: matchingFiles };
            }

            default:
                throw new Error(`Unknown file operation: ${operation}`);
        }
    } catch (error) {
        console.error('File operation error:', error);
        return { success: false, error: error.message };
    }
});

// Website Opening Handler - SECURITY: Validate URL and use shell.openExternal (safe)
ipcMain.on('open-website', (event, url) => {
    try {
        const safeUrl = validateUrl(url);
        shell.openExternal(safeUrl);
        event.reply('website-opened', { success: true, url: safeUrl });
    } catch (error) {
        console.error('Website open error:', error.message);
        event.reply('website-opened', { success: false, error: error.message });
    }
});

/* =========================
   WI-FI CONTROL (no admin needed)
   Scanning and connecting to SAVED networks are user-level netsh
   operations - verified on this machine. New networks still need one
   manual connection so Windows stores the password.
========================= */
function runNetsh(args) {
    return new Promise((resolve) => {
        execFile('netsh', args, { timeout: 15000, windowsHide: true },
            (err, stdout) => resolve(err ? '' : String(stdout)));
    });
}

const normalizeSsid = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

ipcMain.handle('wifi-scan', async () => {
    const out = await runNetsh(['wlan', 'show', 'networks', 'mode=bssid']);
    const networks = [];
    let current = null;
    for (const line of out.split(/\r?\n/)) {
        const ssid = line.match(/^SSID \d+ : (.+)$/);
        const signal = line.match(/Signal\s*:\s*(\d+)%/);
        if (ssid) { current = { ssid: ssid[1].trim(), signal: 0 }; networks.push(current); }
        else if (signal && current) current.signal = Math.max(current.signal, parseInt(signal[1], 10));
    }
    return { success: true, networks: networks.filter(n => n.ssid) };
});

ipcMain.handle('wifi-connect', async (event, requestedName) => {
    const query = normalizeSsid(requestedName);
    if (!query) return { success: false, error: 'no network name given' };

    // Saved profiles are what netsh can connect to without a password
    const profOut = await runNetsh(['wlan', 'show', 'profiles']);
    const profiles = [...profOut.matchAll(/All User Profile\s*:\s*(.+)/g)].map(m => m[1].trim());

    const match = profiles.find(p => {
        const n = normalizeSsid(p);
        return n.includes(query) || query.includes(n);
    });

    if (!match) {
        // Visible but never connected before?
        const scan = await runNetsh(['wlan', 'show', 'networks']);
        const visible = [...scan.matchAll(/^SSID \d+ : (.+)$/gm)].map(m => m[1].trim());
        const seen = visible.find(v => normalizeSsid(v).includes(query) || query.includes(normalizeSsid(v)));
        return {
            success: false,
            needsProfile: !!seen,
            error: seen
                ? `"${seen}" is in range but has no saved profile - connect once manually so Windows stores the password, then voice connect works forever.`
                : `No saved profile or visible network matches "${requestedName}". Is the hotspot turned on?`
        };
    }

    await runNetsh(['wlan', 'connect', `name=${match}`]);

    // Give the association a few seconds, then verify
    await new Promise(r => setTimeout(r, 6000));
    const iface = await runNetsh(['wlan', 'show', 'interfaces']);
    const connected = /State\s*:\s*connected/i.test(iface);
    const nowSsid = iface.match(/^\s*SSID\s*:\s*(.+)$/m)?.[1]?.trim();

    if (connected && nowSsid && normalizeSsid(nowSsid) === normalizeSsid(match)) {
        return { success: true, ssid: nowSsid };
    }
    return {
        success: false,
        error: `Tried to connect to "${match}" but Windows reports ${connected ? `connected to ${nowSsid}` : 'not connected'}. The hotspot may be off or out of range.`
    };
});

// Windows Settings deep links - allowlisted ms-settings: pages only.
// (Radio toggles like Wi-Fi on/off need admin rights; opening the exact
// settings panel is the safe, always-works alternative.)
const SETTINGS_PAGES = {
    wifi: 'ms-settings:network-wifi',
    bluetooth: 'ms-settings:bluetooth',
    sound: 'ms-settings:sound',
    display: 'ms-settings:display',
    battery: 'ms-settings:batterysaver',
    notifications: 'ms-settings:notifications'
};

ipcMain.handle('open-settings', (event, page) => {
    const uri = SETTINGS_PAGES[String(page).toLowerCase()];
    if (!uri) return { success: false, error: 'unknown settings page' };
    shell.openExternal(uri);
    return { success: true, page };
});

// Clipboard Handlers
ipcMain.handle('read-clipboard', () => {
    return clipboard.readText();
});

ipcMain.handle('write-clipboard', (event, text) => {
    clipboard.writeText(text);
    return { success: true };
});

// Window Control Handler
ipcMain.on('window-control', (event, action) => {
    if (!mainWindow) return;

    try {
        switch (action) {
            case 'minimize':
                mainWindow.minimize();
                break;
            case 'maximize':
                if (mainWindow.isMaximized()) {
                    mainWindow.unmaximize();
                } else {
                    mainWindow.maximize();
                }
                break;
            case 'close':
                mainWindow.close();
                break;
            case 'toggle-always-on-top':
                mainWindow.setAlwaysOnTop(!mainWindow.isAlwaysOnTop());
                break;
            default:
                console.log('Unknown window action:', action);
        }
        event.reply('window-control-result', { success: true, action });
    } catch (error) {
        event.reply('window-control-result', { success: false, error: error.message });
    }
});

// OS Info Handler
ipcMain.handle('get-os-info', () => {
    return {
        homedir: os.homedir(),
        platform: os.platform(),
        arch: os.arch()
    };
});

/* =========================
   RAG MEMORY PERSISTENCE + TRAJECTORY LOG
   RAG store lives in userData (survives app updates, not in the repo).
   Trajectory log is ATDP-lite (arXiv:2607.01120): one JSONL event per
   tool call — observation, action, outcome, latency — so future versions
   of Jarvis can learn from its own execution history.
========================= */
const RAG_STORE_FILE = () => path.join(app.getPath('userData'), 'rag-store.json');
const TRAJECTORY_FILE = () => path.join(app.getPath('userData'), 'trajectories.jsonl');

ipcMain.handle('rag-load', async () => {
    try {
        const raw = await fs.readFile(RAG_STORE_FILE(), 'utf-8');
        return JSON.parse(raw);
    } catch {
        return null; // first run — no store yet
    }
});

ipcMain.handle('rag-save', async (event, data) => {
    try {
        // Atomic-ish write: temp file then rename, so a crash can't corrupt memory
        const tmp = RAG_STORE_FILE() + '.tmp';
        await fs.writeFile(tmp, JSON.stringify(data), 'utf-8');
        await fs.rename(tmp, RAG_STORE_FILE());
        return { success: true };
    } catch (error) {
        console.error('RAG save error:', error.message);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('log-trajectory', async (event, entry) => {
    try {
        const record = {
            ts: Date.now(),
            ...entry,
        };
        await fs.appendFile(TRAJECTORY_FILE(), JSON.stringify(record) + '\n', 'utf-8');
        return { success: true };
    } catch (error) {
        // Trajectory logging must never break the agent loop
        console.warn('Trajectory log error:', error.message);
        return { success: false };
    }
});

/* =========================
   EVENT-DRIVEN CORE (JARVIS v4)
   Watchers in the main process publish typed events to the renderer over a
   single 'jarvis-event' channel. The renderer's event router decides whether
   to announce, ingest into memory, or stay silent. Push, not polling by the
   LLM — the same principle as the phone bridge.
========================= */

function publishEvent(type, payload) {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('jarvis-event', { type, payload, ts: Date.now() });
}

// Run a PowerShell snippet safely (base64-encoded to avoid quote-escaping bugs)
function runPowerShell(script, timeoutMs = 10000) {
    return new Promise((resolve) => {
        const encoded = Buffer.from(script, 'utf16le').toString('base64');
        exec(`powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`,
            { timeout: timeoutMs, windowsHide: true },
            (err, stdout) => resolve(err ? null : String(stdout).trim()));
    });
}

/* ---------- 1. Downloads watcher: new document -> event -> auto-OCR ---------- */
function startDownloadsWatcher() {
    let chokidar;
    try {
        chokidar = require('chokidar');
    } catch {
        console.warn('chokidar not installed - downloads watcher disabled');
        return;
    }
    const downloadsDir = path.join(os.homedir(), 'Downloads');
    const DOC_EXTS = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.webp']);

    const watcher = chokidar.watch(downloadsDir, {
        ignoreInitial: true,
        depth: 0,
        // Wait until the browser finishes writing before firing
        awaitWriteFinish: { stabilityThreshold: 2500, pollInterval: 500 },
        ignored: /\.(crdownload|tmp|part|partial)$/i
    });

    watcher.on('add', (filePath) => {
        const ext = path.extname(filePath).toLowerCase();
        if (!DOC_EXTS.has(ext)) return;
        publishEvent('download-added', {
            filePath,
            name: path.basename(filePath),
            ext,
            isDocument: true
        });
    });

    watcher.on('error', (e) => console.warn('Downloads watcher error:', e.message));
    console.log('Downloads watcher active:', downloadsDir);
}

/* ---------- 2. Clipboard monitor: secret detection (privacy-first) ----------
   Only SECRET WARNINGS are published — general clipboard contents are never
   streamed to the renderer, so they can't leak into RAG memory or logs.   */
const SECRET_PATTERNS = [
    { kind: 'Stripe live key', re: /sk_live_[A-Za-z0-9]{10,}/ },
    { kind: 'GitHub token', re: /(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/ },
    { kind: 'Google API key', re: /AIzaSy[A-Za-z0-9_-]{20,}/ },
    { kind: 'AWS access key', re: /AKIA[0-9A-Z]{16}/ },
    { kind: 'private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
    { kind: 'Slack token', re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
];
let lastClipboardHash = '';

function startClipboardMonitor() {
    setInterval(() => {
        try {
            const text = clipboard.readText();
            if (!text || text.length > 20000) return;
            // Cheap change detection without keeping the content around
            const hash = `${text.length}:${text.slice(0, 24)}`;
            if (hash === lastClipboardHash) return;
            lastClipboardHash = hash;

            for (const { kind, re } of SECRET_PATTERNS) {
                const m = text.match(re);
                if (m) {
                    publishEvent('clipboard-secret', {
                        kind,
                        // Masked hint only — the actual secret never leaves this process
                        masked: m[0].slice(0, 7) + '***'
                    });
                    break;
                }
            }
        } catch { /* clipboard access can transiently fail — ignore */ }
    }, 1000);
    console.log('Clipboard secret monitor active');
}

/* ---------- 3. Active window tracker (10s PowerShell poll, no native deps) ---------- */
let lastActiveWindow = { app: null, title: null };

function startActiveWindowTracker() {
    const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class FG {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder t, int c);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
"@
$h = [FG]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 256
[void][FG]::GetWindowText($h, $sb, 256)
$procId = 0
[void][FG]::GetWindowThreadProcessId($h, [ref]$procId)
$name = try { (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { "" }
"$name|$($sb.ToString())"`;

    setInterval(async () => {
        const out = await runPowerShell(script, 8000);
        if (!out) return;
        const sep = out.indexOf('|');
        if (sep < 0) return;
        const app = out.slice(0, sep);
        const title = out.slice(sep + 1).slice(0, 150);
        if (app && (app !== lastActiveWindow.app || title !== lastActiveWindow.title)) {
            lastActiveWindow = { app, title };
            publishEvent('active-window', { app, title });
        }
    }, 10000);
    console.log('Active window tracker active (10s cadence)');
}

/* ---------- 4. Bluetooth audio: connection + battery ----------
   Battery via the undocumented-but-widely-used PnP battery property
   DEVPKEY {104EA319-6EE2-4701-BD47-8DDBF425BBE5} 2 — works for most
   modern BT headsets when connected.                              */
ipcMain.handle('get-bluetooth-audio', async () => {
    const script = `
$out = @()
Get-PnpDevice -Class Bluetooth -ErrorAction SilentlyContinue |
  Where-Object { $_.FriendlyName -and $_.FriendlyName -notmatch 'Adapter|Enumerator|Service|Transport|RFCOMM|Protocol|Radio' } |
  ForEach-Object {
    $bat = $null
    try {
      $p = Get-PnpDeviceProperty -InstanceId $_.InstanceId -KeyName '{104EA319-6EE2-4701-BD47-8DDBF425BBE5} 2' -ErrorAction Stop
      if ($p -and $p.Type -ne 'Empty') { $bat = $p.Data }
    } catch {}
    $out += [PSCustomObject]@{ name = $_.FriendlyName; connected = ($_.Status -eq 'OK'); battery = $bat }
  }
$out | ConvertTo-Json -Compress`;

    const raw = await runPowerShell(script, 15000);
    if (!raw) return { success: false, devices: [] };
    try {
        let devices = JSON.parse(raw);
        if (!Array.isArray(devices)) devices = [devices];
        // Deduplicate by name (BT devices enumerate multiple PnP entries)
        const byName = new Map();
        for (const d of devices) {
            const prev = byName.get(d.name);
            if (!prev || (d.battery != null && prev.battery == null) || (d.connected && !prev.connected)) {
                byName.set(d.name, d);
            }
        }
        return { success: true, devices: [...byName.values()] };
    } catch {
        return { success: false, devices: [] };
    }
});

/* ---------- 5. Audio endpoint switching (optional NirSoft SoundVolumeView) ---------- */
ipcMain.handle('switch-audio-output', async (event, deviceName) => {
    const svv = path.join(__dirname, 'bin', 'SoundVolumeView.exe');
    try {
        await fs.access(svv);
    } catch {
        return {
            success: false,
            error: 'SoundVolumeView.exe not found. Download it free from nirsoft.net/utils/sound_volume_view.html and place it in the bin/ folder.'
        };
    }
    const safeName = String(deviceName).replace(/["\r\n]/g, '');
    return new Promise((resolve) => {
        // /SetDefault "name" all -> console + multimedia + communications
        execFile(svv, ['/SetDefault', safeName, 'all'], { timeout: 8000 }, (err) => {
            resolve(err ? { success: false, error: err.message } : { success: true, device: safeName });
        });
    });
});

/* =========================
   LOCAL STT SERVER (faster-whisper via uv)
   Auto-spawned so voice input needs zero manual steps. If another
   instance already owns port 8770, this one exits harmlessly.
========================= */
let sttProcess = null;

function startSttServer() {
    try {
        sttProcess = spawn('uv', [
            'run', '--python', '3.12',
            '--with', 'faster-whisper', '--with', 'websockets',
            'python', '-I', 'server/stt-server.py'
        ], { cwd: __dirname, windowsHide: true, stdio: 'ignore' });

        sttProcess.on('error', (e) => {
            console.warn('STT server spawn failed (voice input disabled):', e.message);
            sttProcess = null;
        });
        sttProcess.on('exit', (code) => {
            console.log('STT server exited with code', code);
            sttProcess = null;
            // AUTO-RESPAWN: voice input must survive server crashes.
            // (Port-conflict exits also land here; the respawn attempt is
            // harmless — it exits again while another instance owns 8770.)
            if (!app.isQuittingJarvis) {
                setTimeout(() => { if (!sttProcess) startSttServer(); }, 15000);
            }
        });
        console.log('STT server spawning (faster-whisper, port 8770)');
    } catch (e) {
        console.warn('STT server unavailable:', e.message);
    }
}

app.on('before-quit', () => {
    app.isQuittingJarvis = true; // stop the STT respawn loop
    if (sttProcess) try { sttProcess.kill(); } catch { /* noop */ }
});

/* =========================
   KEYLESS WEB SEARCH (DuckDuckGo HTML endpoint)
   Gives the local LLM live internet answers without any API key.
   Main process fetch avoids renderer CORS entirely.
========================= */
function decodeEntities(s) {
    return String(s)
        .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'")
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/<[^>]+>/g, '');
}

ipcMain.handle('web-search', async (event, query) => {
    try {
        const q = encodeURIComponent(String(query).slice(0, 200));
        const res = await fetch(`https://html.duckduckgo.com/html/?q=${q}`, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
            signal: AbortSignal.timeout(12000)
        });
        if (!res.ok) throw new Error(`ddg ${res.status}`);
        const html = await res.text();

        const results = [];
        const titleRe = /class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
        const snippetRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
        const titles = [...html.matchAll(titleRe)];
        const snippets = [...html.matchAll(snippetRe)];

        for (let i = 0; i < Math.min(titles.length, 5); i++) {
            // DDG wraps URLs in a redirect: extract the real target from uddg=
            let url = titles[i][1];
            const uddg = url.match(/uddg=([^&]+)/);
            if (uddg) { try { url = decodeURIComponent(uddg[1]); } catch { /* keep raw */ } }
            results.push({
                title: decodeEntities(titles[i][2]).trim(),
                snippet: decodeEntities(snippets[i]?.[1] || '').trim().slice(0, 300),
                url
            });
        }
        return { success: true, results };
    } catch (error) {
        return { success: false, error: error.message, results: [] };
    }
});

/* =========================
   SECURE CREDENTIAL VAULT
   Zero-trust rule from the v4 spec: no API keys in config.js or .env.
   Secrets are encrypted with Electron safeStorage (DPAPI on Windows,
   bound to the OS user account) and stored in userData. The renderer
   can set/check/delete credentials but NEVER read raw values back —
   only main-process services consume them.
========================= */
const { safeStorage } = require('electron');
const CRED_FILE = () => path.join(app.getPath('userData'), 'credentials.json');

async function loadCreds() {
    try { return JSON.parse(await fs.readFile(CRED_FILE(), 'utf-8')); }
    catch { return {}; }
}

async function getCredential(name) {
    const creds = await loadCreds();
    if (!creds[name]) return null;
    try {
        return safeStorage.decryptString(Buffer.from(creds[name], 'base64'));
    } catch { return null; }
}

ipcMain.handle('secure-cred-set', async (event, name, value) => {
    if (!safeStorage.isEncryptionAvailable()) {
        return { success: false, error: 'OS encryption unavailable' };
    }
    const safeName = String(name).toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 64);
    if (!safeName || !value) return { success: false, error: 'invalid name or value' };
    const creds = await loadCreds();
    creds[safeName] = safeStorage.encryptString(String(value)).toString('base64');
    await fs.writeFile(CRED_FILE(), JSON.stringify(creds), 'utf-8');
    return { success: true, name: safeName };
});

ipcMain.handle('secure-cred-list', async () => Object.keys(await loadCreds()));

ipcMain.handle('secure-cred-delete', async (event, name) => {
    const creds = await loadCreds();
    delete creds[String(name).toLowerCase()];
    await fs.writeFile(CRED_FILE(), JSON.stringify(creds), 'utf-8');
    return { success: true };
});

/* =========================
   FINANCE SERVICE (watchlist + live price alerts)
   Quotes: Alpaca REST when 'alpaca_key_id'/'alpaca_secret' exist in the
   vault (paper or live account), otherwise the keyless Yahoo chart
   endpoint (verified working for stocks and crypto, e.g. BTC-USD).
   AIR-GAP: this module only READS market data. No order placement
   exists anywhere in this codebase — trades require a human.
========================= */
const WATCHLIST_FILE = () => path.join(app.getPath('userData'), 'watchlist.json');
const quoteCache = new Map();   // symbol -> { price, currency, at }
const alertCooldowns = new Map(); // `${symbol}:${type}` -> ts
let financeInterval = null;

async function loadWatchlist() {
    try { return JSON.parse(await fs.readFile(WATCHLIST_FILE(), 'utf-8')); }
    catch { return []; }
}
async function saveWatchlist(list) {
    await fs.writeFile(WATCHLIST_FILE(), JSON.stringify(list, null, 2), 'utf-8');
}

async function fetchQuoteYahoo(symbol) {
    const res = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`,
        { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) }
    );
    if (!res.ok) throw new Error(`yahoo ${res.status}`);
    const data = await res.json();
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta?.regularMarketPrice) throw new Error('no price in response');
    return { price: meta.regularMarketPrice, currency: meta.currency || 'USD', source: 'yahoo' };
}

async function fetchQuoteAlpaca(symbol, keyId, secret) {
    const res = await fetch(
        `https://data.alpaca.markets/v2/stocks/${encodeURIComponent(symbol)}/trades/latest`,
        {
            headers: { 'APCA-API-KEY-ID': keyId, 'APCA-API-SECRET-KEY': secret },
            signal: AbortSignal.timeout(10000)
        }
    );
    if (!res.ok) throw new Error(`alpaca ${res.status}`);
    const data = await res.json();
    if (!data?.trade?.p) throw new Error('no trade in response');
    return { price: data.trade.p, currency: 'USD', source: 'alpaca' };
}

async function pollWatchlist() {
    const list = await loadWatchlist();
    if (!list.length) return;

    const keyId = await getCredential('alpaca_key_id');
    const secret = await getCredential('alpaca_secret');

    for (const item of list) {
        try {
            let quote;
            // Alpaca covers US stocks; crypto pairs (BTC-USD) go to Yahoo
            if (keyId && secret && !item.symbol.includes('-')) {
                try { quote = await fetchQuoteAlpaca(item.symbol, keyId, secret); }
                catch { quote = await fetchQuoteYahoo(item.symbol); }
            } else {
                quote = await fetchQuoteYahoo(item.symbol);
            }

            const prev = quoteCache.get(item.symbol);
            quoteCache.set(item.symbol, { ...quote, at: Date.now() });

            // Alert on crossings, not on being above/below (fires once, 30min cooldown)
            const fire = (type, message) => {
                const key = `${item.symbol}:${type}`;
                const last = alertCooldowns.get(key) || 0;
                if (Date.now() - last < 30 * 60 * 1000) return;
                alertCooldowns.set(key, Date.now());
                publishEvent('price-alert', { symbol: item.symbol, type, price: quote.price, message });
            };

            if (item.target && prev && prev.price < item.target && quote.price >= item.target) {
                fire('target', `${item.symbol} crossed your target of ${item.target}. Now at ${quote.price}.`);
            }
            if (item.stop && prev && prev.price > item.stop && quote.price <= item.stop) {
                fire('stop', `${item.symbol} fell below your stop of ${item.stop}. Now at ${quote.price}.`);
            }
        } catch (e) {
            console.warn(`Quote fetch failed for ${item.symbol}:`, e.message);
        }
    }
}

function startFinanceService() {
    if (financeInterval) return;
    pollWatchlist(); // prime immediately
    financeInterval = setInterval(pollWatchlist, 60000);
    console.log('Finance service active (60s quote cadence)');
}

ipcMain.handle('watchlist-get', async () => {
    const list = await loadWatchlist();
    return list.map(item => ({
        ...item,
        quote: quoteCache.get(item.symbol) || null
    }));
});

ipcMain.handle('watchlist-add', async (event, entry) => {
    const symbol = String(entry.symbol || '').toUpperCase().replace(/[^A-Z0-9.\-]/g, '').slice(0, 12);
    if (!symbol) return { success: false, error: 'invalid symbol' };
    const list = await loadWatchlist();
    const existing = list.find(i => i.symbol === symbol);
    if (existing) {
        if (entry.target != null) existing.target = Number(entry.target) || null;
        if (entry.stop != null) existing.stop = Number(entry.stop) || null;
    } else {
        list.push({
            symbol,
            target: entry.target != null ? Number(entry.target) || null : null,
            stop: entry.stop != null ? Number(entry.stop) || null : null,
            added: Date.now()
        });
    }
    await saveWatchlist(list);
    pollWatchlist(); // fetch a quote right away
    return { success: true, symbol };
});

ipcMain.handle('watchlist-remove', async (event, symbol) => {
    const sym = String(symbol).toUpperCase();
    const list = (await loadWatchlist()).filter(i => i.symbol !== sym);
    await saveWatchlist(list);
    quoteCache.delete(sym);
    return { success: true };
});

/* =========================
   PHONE BRIDGE (Wi-Fi notification relay)
   Design follows the cross-device pattern from DevicesWorld (arXiv:2607.13465)
   and WISPA (arXiv:2606.23255): the phone is a lightweight event SOURCE,
   the desktop does the reasoning. Event-driven push over the LAN, not polling.

   Phone side needs no custom app: MacroDroid (free) with a
   "Notification Received" trigger -> "HTTP Request (POST)" action.
   See docs/PHONE-BRIDGE.md for the 5-minute setup.
========================= */
const http = require('http');
const crypto = require('crypto');

const PHONE_BRIDGE_PORT = 8765;
let phoneBridgeServer = null;
let phoneBridgeToken = null;

function getLanAddresses() {
    const nets = os.networkInterfaces();
    const addrs = [];
    for (const name of Object.keys(nets)) {
        for (const net of nets[name] || []) {
            if (net.family === 'IPv4' && !net.internal) addrs.push(net.address);
        }
    }
    return addrs;
}

async function loadPhoneBridgeToken() {
    const tokenFile = path.join(app.getPath('userData'), 'phone-bridge.json');
    try {
        const data = JSON.parse(await fs.readFile(tokenFile, 'utf-8'));
        if (data.token) return data.token;
    } catch { /* first run */ }
    const token = crypto.randomBytes(12).toString('hex');
    await fs.writeFile(tokenFile, JSON.stringify({ token, created: Date.now() }), 'utf-8');
    return token;
}

function startPhoneBridge() {
    if (phoneBridgeServer) return;

    phoneBridgeServer = http.createServer((req, res) => {
        // Token check: header or query param (MacroDroid supports both)
        const url = new URL(req.url, `http://localhost:${PHONE_BRIDGE_PORT}`);
        const token = req.headers['x-jarvis-token'] || url.searchParams.get('token');
        if (token !== phoneBridgeToken) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid token' }));
            return;
        }

        if (req.method === 'GET' && url.pathname === '/status') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, service: 'jarvis-phone-bridge' }));
            return;
        }

        if (req.method === 'POST' && url.pathname === '/notify') {
            let body = '';
            req.on('data', chunk => {
                body += chunk;
                if (body.length > 16384) req.destroy(); // sanity cap
            });
            req.on('end', () => {
                try {
                    const payload = JSON.parse(body || '{}');
                    const event = {
                        app: String(payload.app || 'phone').slice(0, 64),
                        title: String(payload.title || '').slice(0, 200),
                        text: String(payload.text || '').slice(0, 1000),
                        receivedAt: Date.now()
                    };
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('phone-notification', event);
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true }));
                } catch (e) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'bad payload' }));
                }
            });
            return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
    });

    phoneBridgeServer.on('error', (e) => {
        console.error('Phone bridge server error:', e.message);
        phoneBridgeServer = null;
    });

    phoneBridgeServer.listen(PHONE_BRIDGE_PORT, '0.0.0.0', () => {
        console.log(`Phone bridge listening on port ${PHONE_BRIDGE_PORT} (LAN: ${getLanAddresses().join(', ')})`);
    });
}

ipcMain.handle('get-phone-bridge-info', () => ({
    port: PHONE_BRIDGE_PORT,
    addresses: getLanAddresses(),
    token: phoneBridgeToken,
    running: !!phoneBridgeServer,
    exampleUrl: getLanAddresses().length
        ? `http://${getLanAddresses()[0]}:${PHONE_BRIDGE_PORT}/notify?token=${phoneBridgeToken}`
        : null
}));

/* =========================
   SYSTEM TELEMETRY (HUD diagnostics)
   Pushes CPU/RAM/uptime to the renderer every 2s for the
   Iron-Man-style diagnostics widget. Pure `os` module — no deps.
========================= */
let lastCpuTimes = os.cpus().map(c => c.times);
let telemetryInterval = null;

function computeCpuLoad() {
    const cpus = os.cpus();
    let totalDelta = 0;
    let idleDelta = 0;
    cpus.forEach((cpu, i) => {
        const prev = lastCpuTimes[i] || cpu.times;
        const prevTotal = prev.user + prev.nice + prev.sys + prev.idle + prev.irq;
        const curTotal = cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
        totalDelta += curTotal - prevTotal;
        idleDelta += cpu.times.idle - prev.idle;
    });
    lastCpuTimes = cpus.map(c => c.times);
    if (totalDelta <= 0) return 0;
    return Math.round((1 - idleDelta / totalDelta) * 100);
}

function startTelemetry() {
    if (telemetryInterval) return;
    telemetryInterval = setInterval(() => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        mainWindow.webContents.send('system-telemetry', {
            cpu: computeCpuLoad(),
            memUsedGb: +((totalMem - freeMem) / 1073741824).toFixed(1),
            memTotalGb: +(totalMem / 1073741824).toFixed(1),
            memPercent: Math.round(((totalMem - freeMem) / totalMem) * 100),
            uptimeHours: +(os.uptime() / 3600).toFixed(1),
            cores: os.cpus().length,
            timestamp: Date.now()
        });
    }, 2000);
}

ipcMain.handle('get-system-telemetry', () => {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    return {
        cpu: computeCpuLoad(),
        memUsedGb: +((totalMem - freeMem) / 1073741824).toFixed(1),
        memTotalGb: +(totalMem / 1073741824).toFixed(1),
        memPercent: Math.round(((totalMem - freeMem) / totalMem) * 100),
        uptimeHours: +(os.uptime() / 3600).toFixed(1),
        cores: os.cpus().length,
        hostname: os.hostname(),
        platform: os.platform(),
        activeWindow: lastActiveWindow
    };
});
