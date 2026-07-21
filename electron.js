const { app, BrowserWindow, ipcMain, desktopCapturer, clipboard, shell } = require('electron');
const path = require('path');
const { exec, execFile, spawn } = require('child_process');
const os = require('os');
const fs = require('fs').promises;
const fsSync = require('fs');
const axios = require('axios');
const QRCode = require('qrcode');
const { CompanionBridge, WS_PORT: COMPANION_WS_PORT } = require('./companionBridge');
const adbService = require('./adbService');
const { hedgedRace, createStickyOrder } = require('./rpcHedge');
const chainProviders = require('./chainProviders');

/* =========================
   LOCAL SECRETS (.env)
   No dotenv dependency: the format this app needs is KEY=value and nothing
   more, and a 12-line reader is easier to audit than a package. Values are
   read into process.env ONLY if not already set, so a real environment
   variable always wins over the file. Never logged — the loader reports
   which NAMES it found, never their values.
========================= */
function loadDotEnv(file = path.join(__dirname, '.env')) {
    const found = [];
    try {
        for (const line of fsSync.readFileSync(file, 'utf8').split(/\r?\n/)) {
            const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
            if (!m) continue;                     // comments and blanks
            const key = m[1];
            const value = m[2].trim().replace(/^["']|["']$/g, '');
            if (!value) continue;                 // an empty placeholder is not a key
            if (process.env[key] === undefined) process.env[key] = value;
            found.push(key);
        }
    } catch { /* no .env is a normal, supported state — Jarvis runs keyless */ }
    return found;
}
const ENV_KEYS_PRESENT = loadDotEnv();
if (ENV_KEYS_PRESENT.length) console.log('[env] loaded keys:', ENV_KEYS_PRESENT.join(', '));

/* =========================
   UNLIMITED-OCR CONFIG
   Local SGLang server running baidu/Unlimited-OCR
   (see docs: huggingface.co/baidu/Unlimited-OCR)
========================= */
const OCR_SERVER_URL = process.env.JARVIS_OCR_URL || 'http://127.0.0.1:10000';
const OCR_MAX_PDF_PAGES = 20; // safety limit; model supports dozens of pages in one pass
const OCR_TIMEOUT_MS = 300000; // long-horizon parsing can take minutes on consumer GPUs

/* =========================
   LOCAL LLM CONFIG (Ollama)
   Defaults mirror settings.js (llmProvider 'gemma-local'). The renderer
   keeps its settings in localStorage, which main can't read at boot, so
   these are env-overridable the same way OCR_SERVER_URL is.
========================= */
const OLLAMA_URL = process.env.JARVIS_OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.JARVIS_LOCAL_MODEL || 'gemma3:4b';

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
    startCompanionBridge();
    // Event-driven core watchers
    startDownloadsWatcher();
    startClipboardMonitor();
    startActiveWindowTracker();
    startFinanceService();
    // Names the busiest process for each metric sample and emits start/stop
    // events for watched programs. 60s cadence — deliberately not per-poll.
    startProcessTracker();
    // Compact yesterday's samples into a rollup shortly after start, then daily.
    setTimeout(compactMetrics, 90000);
    setInterval(compactMetrics, 6 * 3600 * 1000);
    startSttServer();
    // Not awaited — readiness polling + model warm must not block the window.
    startOllamaServer();
    // Probe which chains the configured keys actually serve. Not awaited and
    // failure-tolerant: until it resolves, chain reads use the keyless pool.
    discoverAlchemyProviders().catch((e) => console.warn('[chain] provider discovery failed:', e.message));

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

// Resolve a Chrome executable, or null if none is installed. The hard-coded
// path in ALLOWED_APPS covers the common install, but Chrome also lands in
// Program Files (x86) and per-user LocalAppData, so probe all three rather than
// assume. Cached after the first lookup — the install location does not move.
let _chromePathCache;
function resolveChromePath() {
    if (_chromePathCache !== undefined) return _chromePathCache;
    const candidates = [
        ALLOWED_APPS.chrome.path,
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];
    _chromePathCache = candidates.find((p) => { try { return fsSync.existsSync(p); } catch { return false; } }) || null;
    return _chromePathCache;
}

// Website Opening Handler - SECURITY: validateUrl() enforces http/https only.
// Opens in Chrome specifically (the user's default browser preference); the URL
// is passed as an execFile ARGUMENT ARRAY, never a shell string, so a crafted
// URL cannot inject flags or commands. Falls back to shell.openExternal (the
// system default browser) when Chrome is not installed, so the feature still
// works everywhere rather than failing closed.
ipcMain.on('open-website', (event, url) => {
    try {
        const safeUrl = validateUrl(url);
        const chrome = resolveChromePath();
        if (chrome) {
            execFile(chrome, [safeUrl], (error) => {
                if (error) {
                    console.warn('Chrome launch failed, using default browser:', error.message);
                    shell.openExternal(safeUrl);
                }
            });
            event.reply('website-opened', { success: true, url: safeUrl, browser: 'chrome' });
        } else {
            shell.openExternal(safeUrl);
            event.reply('website-opened', { success: true, url: safeUrl, browser: 'default' });
        }
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

ipcMain.handle('wifi-disconnect', async () => {
    const before = parseNetshInterface(await runNetsh(['wlan', 'show', 'interfaces']));
    if (before.state !== 'connected') {
        return { success: true, alreadyOff: true, ssid: before.ssid };
    }
    await runNetsh(['wlan', 'disconnect']);
    await new Promise(r => setTimeout(r, 2000));
    const after = parseNetshInterface(await runNetsh(['wlan', 'show', 'interfaces']));
    return { success: after.state !== 'connected', wasSsid: before.ssid, nowState: after.state };
});

// Parse `netsh wlan show interfaces` into a key->value map. Splitting on the
// FIRST " : " is essential — values like MAC addresses contain their own
// colons, so a greedy split would corrupt the BSSID.
function parseNetshInterface(out) {
    const kv = {};
    for (const line of String(out).split(/\r?\n/)) {
        const m = line.match(/^\s{4,}([^:]+?)\s*:\s*(.+)$/);
        if (m) kv[m[1].trim().toLowerCase()] = m[2].trim();
    }
    return {
        ssid: kv['ssid'] || null,
        bssid: kv['ap bssid'] || kv['bssid'] || null,
        state: (kv['state'] || '').toLowerCase(),
        radio: kv['radio type'] || null,
        band: kv['band'] || null,
        channel: kv['channel'] || null,
        signal: kv['signal'] || null,
        rxRate: kv['receive rate (mbps)'] || null,
        txRate: kv['transmit rate (mbps)'] || null,
        auth: kv['authentication'] || null,
    };
}

// Real, measured network + device intelligence — no fabricated numbers.
// Everything here comes from netsh / Get-NetIPConfiguration / live pings.
const PING_PROBES = 2; // probes per target; all loss arithmetic derives from this

ipcMain.handle('wifi-info', async () => {
    /* MEASURED: this handler averaged 12.1s in the interaction log. The work is
       three powershell.exe spawns (~300-800ms of startup EACH on 5.1) plus
       three-count pings, and it ran almost entirely in series — most damningly,
       the 8.8.8.8 ping waited for BOTH the netsh call and Get-NetIPConfiguration
       despite depending on neither. Only the gateway ping genuinely needs the IP
       config, so everything else is started at once. */
    const ipScript = `
$c = Get-NetIPConfiguration -InterfaceAlias 'Wi-Fi' -ErrorAction SilentlyContinue
[PSCustomObject]@{
  ipv4 = $c.IPv4Address.IPAddress
  gateway = $c.IPv4DefaultGateway.NextHop
  dns = ($c.DNSServer | Where-Object { $_.AddressFamily -eq 2 } | Select-Object -ExpandProperty ServerAddresses) -join ','
} | ConvertTo-Json -Compress`;

    // Live latency + packet loss. Two probes rather than three: one fewer
    // second of waiting, and two still distinguish "up", "lossy" and "down".
    const measure = async (target) => {
        const s = `$p = Test-Connection '${target}' -Count ${PING_PROBES} -ErrorAction SilentlyContinue
if ($p) { "$([math]::Round(($p | Measure-Object ResponseTime -Average).Average)):$(${PING_PROBES} - $p.Count)" } else { "x:${PING_PROBES}" }`;
        const r = await runPowerShell(s, 8000);
        // Loss is reported against the probe count rather than a hardcoded 3:
        // the count is a tuning knob, and every verdict below is derived from
        // it, so baking "3" into the arithmetic would silently produce wrong
        // percentages and an unreachable "no internet" branch.
        if (!r || r.startsWith('x')) return { latencyMs: null, lost: PING_PROBES, probes: PING_PROBES };
        const [lat, loss] = r.split(':');
        return { latencyMs: Number(lat), lost: Number(loss), probes: PING_PROBES };
    };

    const ifacePromise = runNetsh(['wlan', 'show', 'interfaces']).then(parseNetshInterface);
    const ipPromise = runPowerShell(ipScript, 8000)
        .then((r) => { try { return JSON.parse(r || '{}'); } catch { return {}; } });
    const netPromise = measure('8.8.8.8'); // independent of everything above

    const iface = await ifacePromise;
    if (iface.state !== 'connected') {
        // Let the in-flight probes finish rather than leaving them dangling.
        await Promise.allSettled([ipPromise, netPromise]);
        return { success: true, connected: false };
    }

    const ip = await ipPromise;
    const [gw, net] = await Promise.all([
        ip.gateway ? measure(ip.gateway) : Promise.resolve({ latencyMs: null, lost: PING_PROBES, probes: PING_PROBES }),
        netPromise,
    ]);

    // Derive a plain-language quality verdict from measured internet latency/loss
    let quality = 'unknown';
    if (net.latencyMs != null && net.lost === 0) {
        quality = net.latencyMs < 40 ? 'excellent' : net.latencyMs < 100 ? 'good' : net.latencyMs < 250 ? 'fair' : 'poor';
    } else if (net.lost >= net.probes) {
        quality = 'no internet';
    } else if (net.lost > 0) {
        quality = 'unstable';
    }

    return {
        success: true,
        connected: true,
        ssid: iface.ssid,
        bssid: iface.bssid,
        radio: iface.radio,
        band: iface.band,
        channel: iface.channel,
        signal: iface.signal,
        linkRateMbps: iface.rxRate,
        security: iface.auth,
        ipv4: ip.ipv4 || null,
        gateway: ip.gateway || null,
        dns: ip.dns ? ip.dns.split(',') : [],
        gatewayLatencyMs: gw.latencyMs,
        internetLatencyMs: net.latencyMs,
        packetLossPct: Math.round((net.lost / net.probes) * 100),
        internetReachable: net.lost < net.probes,
        quality,
    };
});

/* =========================
   NETWORK CONNECTION INSPECTION
   Answers "who is this machine actually talking to" — every socket, its
   remote IP and port, and the process that owns it. Collected here, parsed
   and analysed by the pure src/js/services/netInspect.js engine.

   WHY netstat AND NOT Get-NetTCPConnection: measured on this machine, the CIM
   cmdlet path took 3.4s wall (2.9s in-script) for the same data that
   `netstat -ano` plus Get-Process returns in 161ms in-script / ~590ms wall.
   On the voice path that difference is the whole budget.

   SCOPE, stated honestly: this is connection-level visibility, not packet
   capture. Reading packet contents needs a capture driver (Npcap) or Windows'
   own pktmon, both of which require Administrator; neither is silently
   attempted here. checkPacketCapture() reports what is actually available so
   the assistant can say what it can and cannot see.
========================= */
const NET_CONNECTIONS_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$ns = (netstat -ano | Out-String)
$procs = Get-Process | ForEach-Object { "$($_.Id)\`t$($_.ProcessName)" }
[PSCustomObject]@{ netstat = $ns; procs = @($procs) } | ConvertTo-Json -Depth 3 -Compress`;

/* =========================
   KEYBOARD + WINDOW CONTROL
   Synthetic keystrokes via SendKeys, which is part of .NET Framework and needs
   no install. Keys land in WHATEVER WINDOW HAS FOCUS, so every handler returns
   the window that received them and the voice layer says it aloud — the user
   is the only one who can see the target.

   Escaping is done in the renderer's pure inputControl module and verified
   byte-exact through Notepad; the text arriving here is already encoded, so
   this layer must not re-escape it.

   Closing is GRACEFUL ONLY (CloseMainWindow), which lets an app prompt to save.
   There is deliberately no force-kill path, and protected/system processes are
   refused outright.
========================= */
const WIN_INTEROP = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -Namespace JarvisW -Name U -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
'@
function Get-Focused {
    $h = [JarvisW.U]::GetForegroundWindow()
    $sb = New-Object System.Text.StringBuilder 512
    [void][JarvisW.U]::GetWindowText($h, $sb, 512)
    $pid = 0; [void][JarvisW.U]::GetWindowThreadProcessId($h, [ref]$pid)
    $proc = (Get-Process -Id $pid -ErrorAction SilentlyContinue)
    [pscustomobject]@{ title = $sb.ToString(); pid = [int]$pid; process = $proc.ProcessName }
}`;

ipcMain.handle('focused-window', async () => {
    try {
        const raw = await runPowerShell(`${WIN_INTEROP}
Get-Focused | ConvertTo-Json -Compress`, 12000);
        if (!raw) return { success: false, error: 'focus query failed' };
        return { success: true, ...JSON.parse(raw) };
    } catch (e) { return { success: false, error: e.message }; }
});

/** Windows that can be focused or closed. */
ipcMain.handle('list-windows', async () => {
    try {
        const raw = await runPowerShell(`
$rows = Get-Process | Where-Object { $_.MainWindowTitle } | ForEach-Object {
    $d = $null; try { $d = $_.MainModule.FileVersionInfo.FileDescription } catch {}
    [pscustomobject]@{ pid = $_.Id; process = $_.ProcessName; title = $_.MainWindowTitle; desc = $d }
}
@($rows) | ConvertTo-Json -Depth 3 -Compress`, 15000);
        if (!raw) return { success: false, error: 'window enumeration failed' };
        const j = JSON.parse(raw);
        return { success: true, windows: Array.isArray(j) ? j : [j] };
    } catch (e) { return { success: false, error: e.message }; }
});

/* Type pre-encoded SendKeys text. The payload is passed as a base64 argument
   rather than interpolated into the script, so no quoting or metacharacter in
   the user's text can alter the command being run. */
ipcMain.handle('type-text', async (event, { encoded, targetPid } = {}) => {
    try {
        if (typeof encoded !== 'string' || !encoded.length) return { success: false, error: 'nothing to type' };
        if (encoded.length > 4000) return { success: false, error: 'text too long to type safely' };
        const b64 = Buffer.from(encoded, 'utf8').toString('base64');
        const focusStep = Number.isFinite(Number(targetPid)) && Number(targetPid) > 0 ? `
$t = Get-Process -Id ${Number(targetPid)} -ErrorAction SilentlyContinue
if ($t -and $t.MainWindowHandle -ne 0) { [void][JarvisW.U]::SetForegroundWindow($t.MainWindowHandle); Start-Sleep -Milliseconds 400 }` : '';
        const raw = await runPowerShell(`${WIN_INTEROP}${focusStep}
$before = Get-Focused
$text = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))
[System.Windows.Forms.SendKeys]::SendWait($text)
Start-Sleep -Milliseconds 150
[pscustomobject]@{ ok = $true; target = $before } | ConvertTo-Json -Depth 3 -Compress`, 20000);
        if (!raw) return { success: false, error: 'send failed' };
        const j = JSON.parse(raw);
        // The window is reported back so the spoken confirmation names where
        // the text actually went — the assistant cannot see the screen.
        return { success: true, target: j.target };
    } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('focus-window', async (event, { pid } = {}) => {
    try {
        const id = Number(pid);
        if (!Number.isFinite(id) || id <= 0) return { success: false, error: 'invalid pid' };
        const raw = await runPowerShell(`${WIN_INTEROP}
$p = Get-Process -Id ${id} -ErrorAction SilentlyContinue
if (-not $p -or $p.MainWindowHandle -eq 0) { [pscustomobject]@{ ok = $false } | ConvertTo-Json -Compress }
else {
  [void][JarvisW.U]::ShowWindow($p.MainWindowHandle, 9)   # restore if minimised
  [void][JarvisW.U]::SetForegroundWindow($p.MainWindowHandle)
  Start-Sleep -Milliseconds 400
  [pscustomobject]@{ ok = $true; now = (Get-Focused) } | ConvertTo-Json -Depth 3 -Compress
}`, 15000);
        if (!raw) return { success: false, error: 'focus failed' };
        const j = JSON.parse(raw);
        // Verified by re-reading focus, not assumed from the call succeeding.
        return j.ok ? { success: true, focused: j.now } : { success: false, error: 'window not available' };
    } catch (e) { return { success: false, error: e.message }; }
});

/* Graceful close. Refuses anything without a real window, anything Windows
   protects, and this app itself. No Kill() anywhere in this path. */
ipcMain.handle('close-window', async (event, { pid } = {}) => {
    try {
        const id = Number(pid);
        if (!Number.isFinite(id) || id <= 0) return { success: false, error: 'invalid pid' };
        if (id === process.pid) return { success: false, error: 'refusing to close Jarvis itself' };
        const raw = await runPowerShell(`
$p = Get-Process -Id ${id} -ErrorAction SilentlyContinue
if (-not $p) { [pscustomobject]@{ ok=$false; reason='not running' } | ConvertTo-Json -Compress; exit }
if ($p.MainWindowHandle -eq 0) { [pscustomobject]@{ ok=$false; reason='no window to close' } | ConvertTo-Json -Compress; exit }
$path = $null; try { $path = $p.MainModule.FileName } catch {}
if (-not $path) { [pscustomobject]@{ ok=$false; reason='protected system process' } | ConvertTo-Json -Compress; exit }
if ($path -like "$env:SystemRoot\\*") { [pscustomobject]@{ ok=$false; reason='Windows system process' } | ConvertTo-Json -Compress; exit }
$name = $p.ProcessName
[void]$p.CloseMainWindow()
Start-Sleep -Milliseconds 1200
$still = Get-Process -Id ${id} -ErrorAction SilentlyContinue
[pscustomobject]@{ ok=$true; name=$name; exited=(-not $still) } | ConvertTo-Json -Compress`, 20000);
        if (!raw) return { success: false, error: 'close failed' };
        const j = JSON.parse(raw);
        if (!j.ok) return { success: false, error: j.reason };
        // exited=false is reported honestly: the app may be asking to save.
        return { success: true, name: j.name, exited: j.exited };
    } catch (e) { return { success: false, error: e.message }; }
});

/* Windows' own IANA port->service table. Read from disk rather than shipped
   as a hand-written map, so the names are the system's, not mine. */
ipcMain.handle('port-services', async () => {
    try {
        const file = path.join(process.env.SystemRoot || 'C:\\Windows',
            'System32', 'drivers', 'etc', 'services');
        const text = fsSync.readFileSync(file, 'utf8');
        return { success: true, text, source: file };
    } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('network-connections', async () => {
    try {
        const raw = await runPowerShell(NET_CONNECTIONS_SCRIPT, 15000);
        if (!raw) return { success: false, error: 'connection table unavailable' };
        const parsed = JSON.parse(raw);
        return {
            success: true,
            netstat: parsed.netstat || '',
            procs: Array.isArray(parsed.procs) ? parsed.procs : [],
        };
    } catch (e) { return { success: false, error: e.message }; }
});

/* Reverse DNS for a bounded set of remote IPs. Names come from the resolver,
   never from a model — an unresolvable address is reported as unresolved
   rather than guessed at. Runs in parallel with a short per-lookup timeout so
   one dead PTR zone cannot stall the answer. */
ipcMain.handle('network-resolve', async (event, { addresses } = {}) => {
    const dns = require('dns').promises;
    const list = (Array.isArray(addresses) ? addresses : [])
        .filter(a => typeof a === 'string' && /^[0-9a-fA-F.:]+$/.test(a))
        .slice(0, 24); // bounded: this is a spoken summary, not a scan
    const names = {};
    await Promise.all(list.map(async (addr) => {
        try {
            const hosts = await Promise.race([
                dns.reverse(addr),
                new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 1500)),
            ]);
            if (hosts && hosts.length) names[addr] = hosts[0];
        } catch { /* no PTR record is normal; stays unresolved */ }
    }));
    return { success: true, names };
});

/* Per-adapter byte counters — the honest answer to "how much data has moved".
   Separate handler because Get-NetAdapterStatistics measured ~1.3s, and the
   connection list must stay fast. */
ipcMain.handle('network-traffic', async () => {
    try {
        const script = `Get-NetAdapterStatistics | Where-Object { $_.ReceivedBytes -gt 0 -or $_.SentBytes -gt 0 } |
Select-Object Name, ReceivedBytes, SentBytes | ConvertTo-Json -Depth 2 -Compress`;
        const raw = await runPowerShell(script, 12000);
        if (!raw) return { success: false, error: 'adapter statistics unavailable' };
        const parsed = JSON.parse(raw);
        return { success: true, adapters: Array.isArray(parsed) ? parsed : [parsed] };
    } catch (e) { return { success: false, error: e.message }; }
});

/* What packet-level capability actually exists right now. Reports facts:
   whether pktmon is present and whether this process is elevated. Nothing is
   captured — this only tells the user (truthfully) what would be possible. */
ipcMain.handle('network-capture-capability', async () => {
    try {
        const script = `$pk = [bool](Get-Command pktmon -ErrorAction SilentlyContinue)
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$npcap = (Test-Path 'C:\\Windows\\System32\\Npcap') -or (Test-Path 'C:\\Program Files\\Wireshark')
[PSCustomObject]@{ pktmon = $pk; admin = $admin; npcap = $npcap } | ConvertTo-Json -Compress`;
        const raw = await runPowerShell(script, 10000);
        if (!raw) return { success: false, error: 'capability probe failed' };
        return { success: true, ...JSON.parse(raw) };
    } catch (e) { return { success: false, error: e.message }; }
});

/* =========================
   NETWORK DISCOVERY — resolve names, enumerate neighbours and radios.

   DIRECTLY ANSWERS A LOGGED FABRICATION: asked "what's the IP of pro haven",
   the local model replied "192.168.1.10" — an address it made up. Nothing had
   been resolved. These handlers return only what the OS resolver, the ARP
   table or the radio actually reported, and report failure as failure.
========================= */

/* Hostname -> address via getaddrinfo, i.e. the FULL Windows resolution chain
   (hosts file, DNS, mDNS, NetBIOS) rather than DNS alone — a LAN device name
   usually is not in DNS. An unresolvable name returns found:false so the voice
   layer can say so plainly. */
ipcMain.handle('resolve-host', async (event, { host } = {}) => {
    const name = String(host || '').trim();
    // Hostnames only: no shell metacharacters can reach anything from here.
    if (!name || name.length > 253 || !/^[a-zA-Z0-9._-]+$/.test(name)) {
        return { success: false, error: 'invalid hostname' };
    }
    try {
        const dns = require('dns').promises;
        const addrs = await Promise.race([
            dns.lookup(name, { all: true }),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
        ]);
        return { success: true, found: true, host: name, addresses: addrs };
    } catch (e) {
        // ENOTFOUND is the normal, honest answer for a name that does not exist.
        return { success: true, found: false, host: name, reason: e.code || e.message };
    }
});

/* Wi-Fi networks in range WITH per-AP detail (BSSID, signal, band, channel).
   This is what "tell me about that other network" can truthfully answer: a
   network you are not joined to has no IP address for you, but its radio
   facts are measurable. */
ipcMain.handle('wifi-networks-detail', async () => {
    try {
        const out = await runNetsh(['wlan', 'show', 'networks', 'mode=bssid']);
        if (!out) return { success: false, error: 'scan unavailable' };
        return { success: true, raw: out };
    } catch (e) { return { success: false, error: e.message }; }
});

/* LAN neighbours from the ARP cache — devices this machine has actually
   exchanged frames with. Not an active sweep: no probing of the user's
   network, only what the OS already knows. */
ipcMain.handle('lan-neighbours', async () => {
    try {
        const out = await new Promise((resolve) => {
            execFile('arp', ['-a'], { windowsHide: true, timeout: 8000 },
                (err, stdout) => resolve(err ? null : String(stdout)));
        });
        if (out == null) return { success: false, error: 'arp unavailable' };
        return { success: true, raw: out };
    } catch (e) { return { success: false, error: e.message }; }
});

/* Bluetooth devices known to Windows. HONEST SCOPE: these are paired/known
   devices, which is what the PnP tree exposes. Discovering nearby UNPAIRED
   devices needs the WinRT DeviceWatcher API and is not available from a plain
   PowerShell call — the voice layer says so rather than implying a live sweep. */
ipcMain.handle('bluetooth-devices', async () => {
    try {
        const script = `Get-PnpDevice -Class Bluetooth -ErrorAction SilentlyContinue |
Select-Object @{n='status';e={$_.Status}}, @{n='name';e={$_.FriendlyName}} | ConvertTo-Json -Depth 2 -Compress`;
        const raw = await runPowerShell(script, 12000);
        if (!raw) return { success: false, error: 'bluetooth enumeration unavailable' };
        const parsed = JSON.parse(raw);
        return { success: true, devices: Array.isArray(parsed) ? parsed : [parsed] };
    } catch (e) { return { success: false, error: e.message }; }
});

/* Radio state (Bluetooth / Wi-Fi) via the WinRT Radio API — the only source
   that reports whether the radio is actually switched ON, as opposed to
   whether an adapter exists. The PnP tree shows the Realtek adapter as "OK"
   even while Bluetooth is toggled off, which is exactly how the assistant came
   to list paired devices without mentioning the radio was off.

   Measured 612ms wall on this machine, RequestAccessAsync -> "Allowed". */
const RADIO_PREAMBLE = `
Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($op, $type) {
    $m = $asTaskGeneric.MakeGenericMethod($type)
    $t = $m.Invoke($null, @($op))
    $null = $t.Wait(8000)
    $t.Result
}
[Windows.Devices.Radios.Radio, Windows.System.Devices, ContentType = WindowsRuntime] | Out-Null
[Windows.Devices.Radios.RadioAccessStatus, Windows.System.Devices, ContentType = WindowsRuntime] | Out-Null
[Windows.Devices.Radios.RadioState, Windows.System.Devices, ContentType = WindowsRuntime] | Out-Null
$access = Await ([Windows.Devices.Radios.Radio]::RequestAccessAsync()) ([Windows.Devices.Radios.RadioAccessStatus])
$radios = Await ([Windows.Devices.Radios.Radio]::GetRadiosAsync()) ([System.Collections.Generic.IReadOnlyList[Windows.Devices.Radios.Radio]])
`;

ipcMain.handle('radio-state', async () => {
    try {
        const script = `$ErrorActionPreference='Stop'
try {${RADIO_PREAMBLE}
  $out = foreach ($r in $radios) { [pscustomobject]@{ name=$r.Name; kind=[string]$r.Kind; state=[string]$r.State } }
  [pscustomobject]@{ ok=$true; access=[string]$access; radios=@($out) } | ConvertTo-Json -Depth 3 -Compress
} catch { [pscustomobject]@{ ok=$false; error=$_.Exception.Message } | ConvertTo-Json -Compress }`;
        const raw = await runPowerShell(script, 15000);
        if (!raw) return { success: false, error: 'radio query unavailable' };
        const j = JSON.parse(raw);
        if (!j.ok) return { success: false, error: j.error };
        return { success: true, access: j.access, radios: Array.isArray(j.radios) ? j.radios : [j.radios] };
    } catch (e) { return { success: false, error: e.message }; }
});

/* Switch a radio on or off. STATE-CHANGING, so it is deliberately NOT reachable
   from the model: the renderer only calls this after the user has answered an
   explicit spoken confirmation. Kind and state are validated against fixed
   sets — no caller-supplied text reaches PowerShell. */
ipcMain.handle('radio-set', async (event, { kind, state } = {}) => {
    const k = String(kind || '').toLowerCase() === 'wifi' ? 'WiFi' : 'Bluetooth';
    const s = String(state || '').toLowerCase() === 'off' ? 'Off' : 'On';
    try {
        const script = `$ErrorActionPreference='Stop'
try {${RADIO_PREAMBLE}
  if ("$access" -ne 'Allowed') { throw "radio access $access" }
  $target = $radios | Where-Object { [string]$_.Kind -eq '${k}' } | Select-Object -First 1
  if (-not $target) { throw 'no ${k} radio present' }
  $res = Await ($target.SetStateAsync([Windows.Devices.Radios.RadioState]::${s})) ([Windows.Devices.Radios.RadioAccessStatus])
  Start-Sleep -Milliseconds 400
  $after = Await ([Windows.Devices.Radios.Radio]::GetRadiosAsync()) ([System.Collections.Generic.IReadOnlyList[Windows.Devices.Radios.Radio]])
  $now = ($after | Where-Object { [string]$_.Kind -eq '${k}' } | Select-Object -First 1).State
  [pscustomobject]@{ ok=$true; result=[string]$res; state=[string]$now } | ConvertTo-Json -Compress
} catch { [pscustomobject]@{ ok=$false; error=$_.Exception.Message } | ConvertTo-Json -Compress }`;
        const raw = await runPowerShell(script, 20000);
        if (!raw) return { success: false, error: 'radio set unavailable' };
        const j = JSON.parse(raw);
        if (!j.ok) return { success: false, error: j.error };
        // The state is re-read AFTER the call: the spoken confirmation reports
        // what the radio actually is now, not what was requested.
        return { success: true, requested: s, state: j.state, applied: j.state === s };
    } catch (e) { return { success: false, error: e.message }; }
});

/* =========================
   SYSTEM PROCESS INSPECTION — STRICTLY READ-ONLY.
   There is deliberately no kill/stop/suspend handler anywhere in this file:
   the assistant can observe the machine completely and change none of it.

   CORRECTNESS: Get-Process .CPU is CUMULATIVE processor-seconds since start,
   which as a spoken "CPU usage" figure would be nonsense (Chrome measured 848
   there while actually using a few percent). Two samples 500ms apart give a
   real instantaneous percentage, normalised by core count. Both values are
   returned under distinct names so they cannot be mixed up later.
========================= */
const PROCESS_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$cores = [Environment]::ProcessorCount
$s1 = @{}
foreach ($p in Get-Process) { $s1[$p.Id] = $p.TotalProcessorTime.TotalMilliseconds }
$sampleMs = 500
Start-Sleep -Milliseconds $sampleMs
$rows = foreach ($p in Get-Process) {
    $prev = $s1[$p.Id]
    $now = $p.TotalProcessorTime.TotalMilliseconds
    $pct = if ($null -ne $prev -and $now -ge $prev) { [math]::Round((($now - $prev) / ($sampleMs * $cores)) * 100, 1) } else { $null }
    # Ask WINDOWS what this program is instead of carrying a hand-written name
    # table. Protected processes (svchost, lsass, MsMpEng, System...) throw here
    # for a non-elevated caller, and that failure is recorded as evidence:
    # readable=$false is how the system/user split is derived downstream.
    $desc = $null; $co = $null; $path = $null
    try { $fi = $p.MainModule.FileVersionInfo; $desc = $fi.FileDescription; $co = $fi.CompanyName; $path = $p.MainModule.FileName } catch {}
    [pscustomobject]@{
        pid = $p.Id; name = $p.ProcessName; cpu = $pct
        mb = [int]($p.WorkingSet64 / 1MB); cpuS = [int]$p.TotalProcessorTime.TotalSeconds
        start = if ($p.StartTime) { $p.StartTime.ToString('o') } else { $null }
        title = $p.MainWindowTitle
        desc = $desc; company = $co; path = $path; readable = [bool]$path
    }
}
[pscustomobject]@{ cores = $cores; sampleMs = $sampleMs; procs = @($rows) } | ConvertTo-Json -Depth 3 -Compress`;

ipcMain.handle('system-processes', async () => {
    try {
        const raw = await runPowerShell(PROCESS_SCRIPT, 20000);
        if (!raw) return { success: false, error: 'process list unavailable' };
        const j = JSON.parse(raw);
        return {
            success: true,
            cores: j.cores,
            sampleMs: j.sampleMs,
            procs: Array.isArray(j.procs) ? j.procs : [j.procs],
        };
    } catch (e) { return { success: false, error: e.message }; }
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

/* =========================
   DURABLE STORES
   Every persistent file in this app used the same shape: read, JSON.parse,
   and on ANY failure return an empty default. That conflates two situations
   that must never be conflated — "this file does not exist yet" and "this file
   exists but I could not read it". The second returned empty memory, empty
   facts, an empty credential vault, and then the next save wrote that emptiness
   over the user's real data. A single truncated write during a power cut would
   permanently destroy months of memory.

   Now: ENOENT is a genuine first run. A corrupt file is PRESERVED under
   .corrupt-<timestamp> before anything can overwrite it. An unreadable file
   (permissions, locking) poisons that path so saves refuse to run at all —
   better to lose this session's changes than the whole store.
========================= */
const poisonedStores = new Set();

async function readJsonStore(file, fallback, label) {
    let raw;
    try {
        raw = await fs.readFile(file, 'utf-8');
    } catch (e) {
        if (e.code === 'ENOENT') return fallback;   // genuinely nothing there yet
        // Present but unreadable. Refuse to let a save overwrite what we could
        // not see; the user keeps their data and loses only this session.
        poisonedStores.add(file);
        console.error(`[store] ${label}: cannot read (${e.code}). Saving is disabled for it this session so nothing is overwritten.`);
        return fallback;
    }
    try {
        return JSON.parse(raw);
    } catch (e) {
        const quarantine = `${file}.corrupt-${Date.now()}`;
        try {
            await fs.rename(file, quarantine);
            console.error(`[store] ${label}: file is corrupt and has been preserved at ${quarantine}. Starting from empty.`);
        } catch {
            poisonedStores.add(file);
            console.error(`[store] ${label}: file is corrupt and could not be preserved. Saving is disabled for it this session.`);
        }
        return fallback;
    }
}

/** Atomic write: temp file then rename, so a crash cannot leave a half file. */
async function writeJsonStore(file, data, label) {
    if (poisonedStores.has(file)) {
        console.error(`[store] ${label}: save refused — the existing file could not be read and must not be overwritten.`);
        return { success: false, error: 'store unreadable; save refused to protect existing data' };
    }
    const tmp = `${file}.tmp`;
    try {
        await fs.writeFile(tmp, JSON.stringify(data), 'utf-8');
        await fs.rename(tmp, file);
        return { success: true };
    } catch (error) {
        await fs.unlink(tmp).catch(() => {});
        console.error(`[store] ${label}: save failed — ${error.message}`);
        return { success: false, error: error.message };
    }
}

ipcMain.handle('rag-load', async () => readJsonStore(RAG_STORE_FILE(), null, 'RAG memory'));

ipcMain.handle('rag-save', async (event, data) => writeJsonStore(RAG_STORE_FILE(), data, 'RAG memory'));

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
   INTERACTION LOG (self-improvement telemetry)
   Every LOCAL turn — input, intent, latency, success, response — appended as
   JSONL to userData/interactions.jsonl. This is distinct from trajectories.jsonl
   (which only fires on the dormant Gemini cloud tool path and so never writes in
   local mode): this is the durable record of how Jarvis is ACTUALLY used, the
   raw material for finding failing commands, common asks and latency outliers.
   Never leaves the machine; secret-bearing turns are dropped by the renderer
   before they ever reach here.
========================= */
const INTERACTION_FILE = () => path.join(app.getPath('userData'), 'interactions.jsonl');
const INTERACTION_MAX_BYTES = 5 * 1024 * 1024; // rotate past 5MB, keep one prior gen

ipcMain.handle('log-interaction', async (event, entry) => {
    try {
        // Size-cap the log so it never grows without bound. One rotated
        // generation (.1) is kept so history survives a rollover.
        try {
            const st = await fs.stat(INTERACTION_FILE());
            if (st.size > INTERACTION_MAX_BYTES) {
                await fs.rename(INTERACTION_FILE(), INTERACTION_FILE() + '.1');
            }
        } catch { /* no file yet — first write */ }
        const record = { ts: Date.now(), ...entry };
        await fs.appendFile(INTERACTION_FILE(), JSON.stringify(record) + '\n', 'utf-8');
        return { success: true };
    } catch (error) {
        console.warn('Interaction log error:', error.message); // never break the turn
        return { success: false };
    }
});

// Raw interaction rows for the reflection/consolidation pass. Optional sinceTs
// returns only rows newer than the last reflection, so each consolidation only
// processes NEW experience (the log itself stays the immutable source of truth,
// per SelfMem). Reads the rotated generation too so a rollover is not a blind
// spot.
ipcMain.handle('get-interactions', async (event, opts) => {
    try {
        const sinceTs = Number(opts?.sinceTs) || 0;
        const limit = Math.min(Math.max(Number(opts?.limit) || 300, 1), 1000);
        let lines = [];
        for (const f of [INTERACTION_FILE() + '.1', INTERACTION_FILE()]) {
            try { lines = lines.concat((await fs.readFile(f, 'utf-8')).trim().split('\n')); }
            catch { /* generation absent */ }
        }
        const rows = lines.filter(Boolean)
            .map((l) => { try { return JSON.parse(l); } catch { return null; } })
            .filter((r) => r && (!sinceTs || r.ts > sinceTs));
        return { success: true, rows: rows.slice(-limit) };
    } catch (error) {
        return { success: false, error: error.message, rows: [] };
    }
});

// Reflection store: durable, human-readable summaries of what each consolidation
// pass learned and recommended. Separate from interactions.jsonl because a
// reflection is derived knowledge, not raw experience, and its max-covered
// timestamp is what the next pass reads to avoid re-processing old rows.
const REFLECTION_FILE = () => path.join(app.getPath('userData'), 'reflections.jsonl');

ipcMain.handle('save-reflection', async (event, entry) => {
    try {
        const record = { ts: Date.now(), ...entry };
        await fs.appendFile(REFLECTION_FILE(), JSON.stringify(record) + '\n', 'utf-8');
        return { success: true };
    } catch (error) {
        console.warn('Reflection save error:', error.message);
        return { success: false };
    }
});

// Confidence ledger for consolidated facts. A fact is PROVISIONAL until a later
// reflection pass corroborates it; only corroborated facts reach durable memory
// (the RAG). This is the store behind that gate — small, structured, atomic
// write like the watchlist. Kept OUT of rag-store.json on purpose: provisional
// and archived facts must never be retrievable, only durable ones live in RAG.
const FACT_STORE_FILE = () => path.join(app.getPath('userData'), 'fact-store.json');

// Memory audit log — an append-only version history of every belief change
// (promote / revise / archive), with attribution (what, which value, resulting
// confidence, when). This is the "version history" of the Dreaming design: it
// makes the memory's evolution inspectable and reversible in review, rather than
// a silent black box.
const MEMORY_AUDIT_FILE = () => path.join(app.getPath('userData'), 'memory-audit.jsonl');
const MEMORY_AUDIT_MAX = 2 * 1024 * 1024;

ipcMain.handle('log-memory-event', async (event, entry) => {
    try {
        try {
            const st = await fs.stat(MEMORY_AUDIT_FILE());
            if (st.size > MEMORY_AUDIT_MAX) await fs.rename(MEMORY_AUDIT_FILE(), MEMORY_AUDIT_FILE() + '.1');
        } catch { /* first write */ }
        await fs.appendFile(MEMORY_AUDIT_FILE(), JSON.stringify({ ts: Date.now(), ...entry }) + '\n', 'utf-8');
        return { success: true };
    } catch (error) {
        console.warn('Memory audit log error:', error.message);
        return { success: false };
    }
});

ipcMain.handle('get-memory-audit', async (event, opts) => {
    try {
        const limit = Math.min(Math.max(Number(opts?.limit) || 20, 1), 200);
        let lines = [];
        try { lines = (await fs.readFile(MEMORY_AUDIT_FILE(), 'utf-8')).trim().split('\n'); }
        catch { return { success: true, events: [] }; }
        const events = lines.filter(Boolean)
            .map((l) => { try { return JSON.parse(l); } catch { return null; } })
            .filter(Boolean);
        return { success: true, events: events.slice(-limit) };
    } catch (error) {
        return { success: false, error: error.message, events: [] };
    }
});

ipcMain.handle('load-fact-store', async () => readJsonStore(FACT_STORE_FILE(), { facts: [] }, 'belief store'));

ipcMain.handle('save-fact-store', async (event, data) => writeJsonStore(FACT_STORE_FILE(), data, 'belief store'));

ipcMain.handle('get-reflections', async (event, opts) => {
    try {
        const limit = Math.min(Math.max(Number(opts?.limit) || 10, 1), 100);
        let lines = [];
        try { lines = (await fs.readFile(REFLECTION_FILE(), 'utf-8')).trim().split('\n'); }
        catch { return { success: true, reflections: [], lastCoveredTs: 0 }; }
        const reflections = lines.filter(Boolean)
            .map((l) => { try { return JSON.parse(l); } catch { return null; } })
            .filter(Boolean);
        // The high-water mark: the newest interaction any prior pass consolidated.
        const lastCoveredTs = reflections.reduce((m, r) => Math.max(m, Number(r.coveredTs) || 0), 0);
        return { success: true, reflections: reflections.slice(-limit), lastCoveredTs };
    } catch (error) {
        return { success: false, error: error.message, reflections: [], lastCoveredTs: 0 };
    }
});

// Aggregate the interaction log into the numbers that actually drive
// improvement: volume, error rate, average/worst latency, and the intent mix.
// Reads the rotated generation first so the window spans a rollover.
ipcMain.handle('get-interaction-stats', async () => {
    try {
        let lines = [];
        for (const f of [INTERACTION_FILE() + '.1', INTERACTION_FILE()]) {
            try { lines = lines.concat((await fs.readFile(f, 'utf-8')).trim().split('\n')); }
            catch { /* generation absent */ }
        }
        const rows = lines.filter(Boolean)
            .map((l) => { try { return JSON.parse(l); } catch { return null; } })
            .filter(Boolean);

        const byIntent = {};
        const byLatency = {}; // intent -> {sum,n} for per-intent averages
        let errors = 0, totalMs = 0, msCount = 0;
        const slowest = [];
        for (const r of rows) {
            const intent = r.intent || 'unknown';
            byIntent[intent] = (byIntent[intent] || 0) + 1;
            if (r.ok === false) errors++;
            if (typeof r.latencyMs === 'number') {
                totalMs += r.latencyMs; msCount++;
                const b = byLatency[intent] || (byLatency[intent] = { sum: 0, n: 0 });
                b.sum += r.latencyMs; b.n++;
                if (r.latencyMs > 3000) slowest.push({ intent, ms: r.latencyMs, input: r.input });
            }
        }
        const avgByIntent = Object.fromEntries(
            Object.entries(byLatency).map(([k, v]) => [k, Math.round(v.sum / v.n)])
        );
        return {
            success: true,
            total: rows.length,
            errors,
            errorRate: rows.length ? +(errors / rows.length * 100).toFixed(1) : 0,
            avgLatencyMs: msCount ? Math.round(totalMs / msCount) : null,
            byIntent: Object.fromEntries(Object.entries(byIntent).sort((a, b) => b[1] - a[1])),
            avgLatencyByIntent: avgByIntent,
            slowest: slowest.sort((a, b) => b.ms - a.ms).slice(0, 10),
            firstTs: rows[0]?.ts || null,
            lastTs: rows[rows.length - 1]?.ts || null,
        };
    } catch (error) {
        return { success: false, error: error.message };
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
   LOCAL LLM SERVER (Gemma via Ollama)
   Auto-spawned so local mode needs zero manual steps. If Ollama is
   already up (tray app, another Jarvis, manual `ollama serve`) we reuse
   that instance and never kill it on quit — we only own what we spawn.
========================= */
let ollamaProcess = null; // non-null ONLY when this process spawned the server

async function ollamaAlive(timeoutMs = 1500) {
    try {
        await axios.get(`${OLLAMA_URL}/api/tags`, { timeout: timeoutMs });
        return true;
    } catch {
        return false;
    }
}

// Load the model into RAM ahead of the first prompt, so the first spoken
// question doesn't eat a multi-second cold load. keep_alive matches the
// 60m used by toolService.js chat calls.
async function preloadLocalModel() {
    try {
        await axios.post(
            `${OLLAMA_URL}/api/generate`,
            { model: OLLAMA_MODEL, keep_alive: '60m' },
            { timeout: 180000 }
        );
        console.log(`Local model resident: ${OLLAMA_MODEL} (keep_alive 60m)`);
    } catch (e) {
        console.warn(`Local model preload failed (${OLLAMA_MODEL}) — is it pulled? ollama pull ${OLLAMA_MODEL}:`, e.message);
    }
}

async function startOllamaServer() {
    if (await ollamaAlive()) {
        console.log('Ollama already running — reusing existing instance');
        preloadLocalModel();
        return;
    }

    try {
        ollamaProcess = spawn('ollama', ['serve'], { windowsHide: true, stdio: 'ignore' });

        ollamaProcess.on('error', (e) => {
            console.warn('Ollama spawn failed (local mode disabled):', e.message);
            ollamaProcess = null;
        });
        ollamaProcess.on('exit', (code) => {
            console.log('Ollama exited with code', code);
            ollamaProcess = null;
            // AUTO-RESPAWN, same contract as the STT server. A port-conflict
            // exit lands here too; the retry is harmless because the
            // alive-check above short-circuits while another instance owns it.
            if (!app.isQuittingJarvis) {
                setTimeout(() => { if (!ollamaProcess) startOllamaServer(); }, 15000);
            }
        });
        console.log(`Ollama spawning (${OLLAMA_URL}, model ${OLLAMA_MODEL})`);
    } catch (e) {
        console.warn('Ollama unavailable:', e.message);
        return;
    }

    // Wait for the server to bind before warming the model.
    for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        if (await ollamaAlive()) {
            preloadLocalModel();
            return;
        }
    }
    console.warn('Ollama did not become ready within 30s — local mode may be unavailable');
}

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
    app.isQuittingJarvis = true; // stop the STT/Ollama respawn loops
    if (sttProcess) try { sttProcess.kill(); } catch { /* noop */ }
    // Only ours to kill — an Ollama we merely reused stays up for the user.
    if (ollamaProcess) try { ollamaProcess.kill(); } catch { /* noop */ }
    // Unpublish mDNS and drop companion sockets cleanly, otherwise the phone
    // keeps retrying against a stale advertisement.
    if (companionBridge) try { companionBridge.stop(); } catch { /* noop */ }
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

// Keyless web search with a FAILOVER CHAIN. No single free endpoint is
// reliable: the DuckDuckGo HTML scrape gives the richest results (real titles +
// snippets) but, once an IP is flagged, returns an HTTP 202 CAPTCHA interstitial
// ("select all squares containing a duck") instead of results — which silently
// broke search. When that happens we fall through to DuckDuckGo's official
// Instant Answer JSON API and then Wikipedia's REST API; both are proper APIs
// that are not bot-blocked, so factual questions still get grounded answers.

async function ddgHtmlSearch(query) {
    const q = encodeURIComponent(String(query).slice(0, 200));
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${q}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        signal: AbortSignal.timeout(12000)
    });
    // 202 (or any non-200) is the anomaly/CAPTCHA page, not results — fail over.
    if (res.status !== 200) throw new Error(`ddg http ${res.status}`);
    const html = await res.text();
    if (/bots use DuckDuckGo|complete the following challenge/i.test(html)) {
        throw new Error('ddg captcha');
    }
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
    if (!results.length) throw new Error('ddg empty');
    return results;
}

async function ddgInstantAnswer(query) {
    const res = await fetch(
        `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`,
        { headers: { 'User-Agent': 'Jarvis/1.0' }, signal: AbortSignal.timeout(10000) }
    );
    if (!res.ok) throw new Error(`ddg-ia ${res.status}`);
    const j = await res.json();
    const results = [];
    if (j.AbstractText) results.push({ title: j.Heading || query, snippet: j.AbstractText.slice(0, 300), url: j.AbstractURL || '' });
    else if (j.Answer && typeof j.Answer === 'string') results.push({ title: query, snippet: j.Answer.slice(0, 300), url: j.AbstractURL || '' });
    for (const t of (j.RelatedTopics || [])) {
        if (results.length >= 5) break;
        if (t && t.Text) results.push({ title: t.Text.split(' - ')[0] || query, snippet: t.Text.slice(0, 300), url: t.FirstURL || '' });
    }
    if (!results.length) throw new Error('ddg-ia empty');
    return results;
}

async function wikipediaSearch(query) {
    const s = await fetch(
        `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=3`,
        { headers: { 'User-Agent': 'Jarvis/1.0 (local assistant)' }, signal: AbortSignal.timeout(10000) }
    );
    if (!s.ok) throw new Error(`wiki ${s.status}`);
    const sj = await s.json();
    const hits = (sj?.query?.search || []).slice(0, 3);
    if (!hits.length) throw new Error('wiki no hits');
    // Fetch the clean intro summaries in parallel to keep failover latency low.
    const results = await Promise.all(hits.map(async (h) => {
        const sum = await fetch(
            `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(h.title)}`,
            { headers: { 'User-Agent': 'Jarvis/1.0 (local assistant)' }, signal: AbortSignal.timeout(8000) }
        ).then((r) => (r.ok ? r.json() : null)).catch(() => null);
        return {
            title: h.title,
            snippet: (sum?.extract || String(h.snippet || '').replace(/<[^>]+>/g, '')).slice(0, 300),
            url: sum?.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(h.title)}`,
        };
    }));
    return results.filter((r) => r.snippet);
}

ipcMain.handle('web-search', async (event, query) => {
    const providers = [
        ['duckduckgo', ddgHtmlSearch],
        ['duckduckgo-instant', ddgInstantAnswer],
        ['wikipedia', wikipediaSearch],
    ];
    let lastErr = 'none';
    for (const [name, fn] of providers) {
        try {
            const results = await fn(query);
            if (results && results.length) return { success: true, provider: name, results };
        } catch (e) {
            lastErr = `${name}: ${e.message}`;
            console.warn(`web-search fell through — ${lastErr}`);
        }
    }
    return { success: false, error: `all providers failed (${lastErr})`, results: [] };
});

/* =========================
   ON-CHAIN DATA SERVICE (read-only)
   Live blockchain reads over keyless public JSON-RPC. Per-chain endpoint
   failover because free RPCs rate-limit and go down (verified: llamarpc/
   polygon-rpc were failing, publicnode/drpc were up). The renderer does all
   number formatting via the tested onchain.js module — main only fetches and
   returns raw hex. AIR-GAP: only read methods are ever sent; there is no
   signing, no eth_sendTransaction, no key handling anywhere in this service.
========================= */
const RPC_URLS = {
    ethereum: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org', 'https://1rpc.io/eth'],
    arbitrum: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com', 'https://arbitrum.drpc.org'],
    base: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com', 'https://base.drpc.org'],
    optimism: ['https://mainnet.optimism.io', 'https://optimism-rpc.publicnode.com', 'https://optimism.drpc.org'],
    polygon: ['https://polygon-bor-rpc.publicnode.com', 'https://polygon.drpc.org', 'https://1rpc.io/matic'],
    bsc: ['https://bsc-rpc.publicnode.com', 'https://bsc.drpc.org', 'https://1rpc.io/bnb'],
};

/* eth_getLogs is served very unevenly by free endpoints (measured: drpc
   handled a 7200-block range in 793ms; publicnode demands a token for ANY
   archive range; 1rpc caps at 50 blocks). So log queries use their own
   drpc-first ordering instead of the balance-read ordering. */
const RPC_LOG_URLS = {
    ethereum: ['https://eth.drpc.org', 'https://ethereum-rpc.publicnode.com', 'https://1rpc.io/eth'],
    bsc: ['https://bsc.drpc.org', 'https://bsc-rpc.publicnode.com', 'https://1rpc.io/bnb'],
};
/* --- keyed providers -------------------------------------------------------
   Alchemy sits IN FRONT of the keyless pool rather than replacing it: a paid
   endpoint that rate-limits or 403s must degrade to the public one, not take
   the feature down with it. Which chains the key actually serves is DISCOVERED
   (chainProviders.probeSlug makes each endpoint prove its chain id), because a
   plan that omits a network answers 403 and a hardcoded slug map would lie
   about it. Chain ids below are protocol facts and are the assertion the probe
   checks against — they are not a vendor lookup table. */
const CHAIN_IDS = {
    ethereum: { id: 1, native: 'ETH' },
    arbitrum: { id: 42161, native: 'ETH' },
    base: { id: 8453, native: 'ETH' },
    optimism: { id: 10, native: 'ETH' },
    polygon: { id: 137, native: 'POL' },
    bsc: { id: 56, native: 'BNB' },
};

// Filled in by discoverAlchemyProviders() at startup; empty = fully keyless.
let alchemyNetworks = {};   // chainKey -> {slug, chainId, url}
let alchemyRejected = {};   // chainKey -> why it is NOT available (kept: negative results are data)
let alchemyKey = null;
let heliusKey = null;

async function discoverAlchemyProviders() {
    alchemyKey = await chainProviders.resolveKey('alchemy', getCredential);
    heliusKey = await chainProviders.resolveKey('helius', getCredential);
    if (!alchemyKey) {
        console.log('[chain] no Alchemy key — running on keyless public endpoints');
        return;
    }
    const t0 = Date.now();
    const { verified, rejected } = await chainProviders.discoverAlchemyNetworks(alchemyKey, CHAIN_IDS, fetch);
    alchemyNetworks = verified;
    alchemyRejected = rejected;

    for (const [chainKey, info] of Object.entries(verified)) {
        // Prepend, never replace: the public pool stays as failover.
        if (RPC_URLS[chainKey] && !RPC_URLS[chainKey].includes(info.url)) RPC_URLS[chainKey].unshift(info.url);
        /* NOT added to RPC_LOG_URLS. Measured, not assumed: Alchemy's free tier
           rejects any eth_getLogs range wider than 10 BLOCKS
           ("Under the Free tier plan, you can make eth_getLogs requests with up
           to a 10 block range"). The wide-range log features here — Ondo flows,
           treasury history — need thousands of blocks, which the keyless pool
           serves. Single-block stream scans go through RPC_URLS and are fine. */
    }
    console.log(`[chain] Alchemy verified in ${Date.now() - t0}ms:`, Object.keys(verified).join(', ') || 'none',
        Object.keys(rejected).length ? `| unavailable: ${Object.keys(rejected).join(', ')}` : '');
}

/** The keyed websocket for a chain, or null if we have no key for it. */
function alchemyWsUrl(chainKey) {
    const info = alchemyNetworks[chainKey];
    return info ? info.url.replace(/^https:/, 'wss:') : null;
}

// Only these JSON-RPC methods may ever be sent — a hard allowlist so the
// service can never be steered into a write/signing call.
const RPC_READ_METHODS = new Set(['eth_getBalance', 'eth_gasPrice', 'eth_call', 'eth_getTransactionCount', 'eth_blockNumber', 'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_getBlockByNumber', 'eth_getLogs', 'eth_getCode']);

/* Endpoints are RACED, not queued. Sequential failover with a 10s timeout each
   is what put a 30.0s worst case in the interaction log: three dead endpoints
   cost three full timeouts before the user heard anything. See rpcHedge.js. */
const RPC_HEDGE_MS = 1200;    // how long a healthy endpoint has before we hedge
const RPC_TIMEOUT_MS = 4000;  // a JSON-RPC read has no business taking longer
const rpcSticky = createStickyOrder();

async function rpcCall(chainKey, method, params = []) {
    if (!RPC_READ_METHODS.has(method)) throw new Error(`method not allowed: ${method}`);
    const urls = RPC_URLS[chainKey];
    if (!urls) throw new Error(`unknown chain: ${chainKey}`);

    const { value, item } = await hedgedRace(
        rpcSticky.order(chainKey, urls),
        async (url, signal) => {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'User-Agent': 'Jarvis/1.0' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
                signal,
            });
            if (!res.ok) throw new Error(`http ${res.status}`);
            const j = await res.json();
            if (j.error) throw new Error(j.error.message || 'rpc error');
            if (j.result === undefined) throw new Error('empty result');
            return j.result;
        },
        { hedgeAfterMs: RPC_HEDGE_MS, timeoutMs: RPC_TIMEOUT_MS },
    );

    // Keep using whichever endpoint actually answered, so a chain that failed
    // over once stops paying the hedge delay on every later query.
    rpcSticky.remember(chainKey, item);
    return value;
}

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

ipcMain.handle('onchain-balance', async (event, { chain, address }) => {
    try {
        if (!ADDR_RE.test(String(address || ''))) return { success: false, error: 'invalid address' };
        const wei = await rpcCall(chain, 'eth_getBalance', [address, 'latest']);
        return { success: true, wei };
    } catch (e) { return { success: false, error: e.message }; }
});

/* Contract or externally-owned account. This is the one thing on-chain data
   CAN say about what an address is — code present means a contract, absent
   means a key-controlled wallet. It is not an entity name and is never spoken
   as one. */
ipcMain.handle('onchain-code', async (event, { chain, address }) => {
    try {
        if (!ADDR_RE.test(String(address || ''))) return { success: false, error: 'invalid address' };
        const code = await rpcCall(chain, 'eth_getCode', [address, 'latest']);
        const isContract = typeof code === 'string' && code !== '0x' && code.length > 2;
        return { success: true, isContract, codeSize: isContract ? (code.length - 2) / 2 : 0 };
    } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('onchain-gas', async (event, { chain }) => {
    try {
        const wei = await rpcCall(chain, 'eth_gasPrice', []);
        return { success: true, wei };
    } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('onchain-txcount', async (event, { chain, address }) => {
    try {
        if (!ADDR_RE.test(String(address || ''))) return { success: false, error: 'invalid address' };
        const hex = await rpcCall(chain, 'eth_getTransactionCount', [address, 'latest']);
        return { success: true, count: Number(BigInt(hex)) };
    } catch (e) { return { success: false, error: e.message }; }
});

const TXHASH_RE = /^0x[0-9a-fA-F]{64}$/;

// Decode a transaction: fetch its receipt (logs, status, gas) + the tx itself
// (native value, from/to). The renderer decodes the Transfer logs with the
// tested onchain.js decoder — main just returns the raw receipt/tx.
ipcMain.handle('onchain-tx', async (event, { chain, hash }) => {
    try {
        if (!TXHASH_RE.test(String(hash || ''))) return { success: false, error: 'invalid transaction hash' };
        const [receipt, tx] = await Promise.all([
            rpcCall(chain, 'eth_getTransactionReceipt', [hash]),
            rpcCall(chain, 'eth_getTransactionByHash', [hash]),
        ]);
        if (!receipt) return { success: false, error: 'transaction not found (or not yet mined)' };
        return { success: true, receipt, tx };
    } catch (e) { return { success: false, error: e.message }; }
});

// Generic read-only eth_call for contract introspection (supportsInterface,
// decimals, symbol, …). Still an eth_call — a pure read, never a state change.
// `to` is the contract; `data` is calldata built by the renderer's tested
// encoders. Returns raw hex for the renderer to decode deterministically.
ipcMain.handle('onchain-call', async (event, { chain, to, data }) => {
    try {
        if (!ADDR_RE.test(String(to || ''))) return { success: false, error: 'invalid contract address' };
        if (!/^0x[0-9a-fA-F]+$/.test(String(data || ''))) return { success: false, error: 'invalid calldata' };
        const raw = await rpcCall(chain, 'eth_call', [{ to, data }, 'latest']);
        return { success: true, raw };
    } catch (e) { return { success: false, error: e.message }; }
});

// ERC-20 balance: eth_call balanceOf(owner). `data` is built by the renderer's
// tested encodeBalanceOf; `token` is the contract address to call.
ipcMain.handle('onchain-token', async (event, { chain, token, data }) => {
    try {
        if (!ADDR_RE.test(String(token || ''))) return { success: false, error: 'invalid token address' };
        if (!/^0x[0-9a-fA-F]+$/.test(String(data || ''))) return { success: false, error: 'invalid calldata' };
        const raw = await rpcCall(chain, 'eth_call', [{ to: token, data }, 'latest']);
        return { success: true, raw };
    } catch (e) { return { success: false, error: e.message }; }
});

/* Bounded, validated Transfer-log reads — powers Ondo mint/redeem flow
   detection WITHOUT an Etherscan key (the pasted spec assumed one was
   required; live probing showed drpc serves 24h ranges keyless). Guards:
   log-capable chains only, contract address validated, topics must be
   32-byte hex or null, range capped at ~24h so a bad caller cannot demand
   a full archive scan. */
const LOGS_MAX_RANGE = 7200; // blocks (~24h at 12s); drpc-verified workable

ipcMain.handle('onchain-logs', async (event, { chain, address, topics, spanBlocks }) => {
    try {
        const chainKey = RPC_LOG_URLS[chain] ? chain : null;
        if (!chainKey) return { success: false, error: `log queries not supported on ${chain}` };
        if (!ADDR_RE.test(String(address || ''))) return { success: false, error: 'invalid contract address' };
        const cleanTopics = (Array.isArray(topics) ? topics : []).map((t) => {
            if (t === null || t === undefined) return null;
            if (/^0x[0-9a-fA-F]{64}$/.test(String(t))) return t;
            throw new Error('invalid topic');
        });
        const span = Math.min(Math.max(1, Number(spanBlocks) || LOGS_MAX_RANGE), LOGS_MAX_RANGE);

        const latestHex = await rpcCall(chainKey, 'eth_blockNumber', []);
        const latest = parseInt(latestHex, 16);
        /* A malformed reply makes parseInt return NaN, and NaN.toString(16) is
           the string "NaN" — so the next call would quietly request block
           "0xNaN" and get back nothing, or worse, something. Fail loudly here
           instead of asking for a block that cannot exist. */
        if (!Number.isFinite(latest)) throw new Error(`bad block number from ${chainKey}: ${JSON.stringify(latestHex)}`);
        const fromBlock = '0x' + Math.max(0, latest - span).toString(16);

        const { value } = await hedgedRace(
            RPC_LOG_URLS[chainKey],
            async (url, signal) => {
                const res = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Jarvis/1.0' },
                    body: JSON.stringify({
                        jsonrpc: '2.0', id: 1, method: 'eth_getLogs',
                        params: [{ address, topics: cleanTopics, fromBlock, toBlock: 'latest' }],
                    }),
                    signal,
                });
                if (!res.ok) throw new Error(`http ${res.status}`);
                const j = await res.json();
                if (j.error) throw new Error(j.error.message || 'rpc error');
                if (!Array.isArray(j.result)) throw new Error('empty result');
                return j.result;
            },
            { hedgeAfterMs: 2500, timeoutMs: 20000 }, // log scans are legitimately slower than reads
        );
        return { success: true, logs: value, fromBlock: latest - span, toBlock: latest };
    } catch (e) { return { success: false, error: e.message }; }
});

/* =========================
   KEYED PROVIDER HANDLERS — Alchemy (EVM) + Helius (Solana)
   These answer the questions raw public RPC structurally CANNOT: what a wallet
   holds without being told which tokens to ask about, what something is worth,
   and Solana history at all. Every handler returns the raw provider payload;
   the renderer parses it with the tested chainIntel.js module, so no number is
   ever computed here and none is ever computed by the model.
   Each handler states needsKey rather than failing silently, so the assistant
   can say WHY it cannot answer instead of inventing an answer.
   AIR-GAP unchanged: read-only endpoints, no signing, keys never returned.
========================= */
const SOL_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/; // base58, no 0/O/I/l

/* Solana stablecoin mint accounts. Live-verified against Helius: USDC supply
   8.14B at 6 decimals, USDT 3.84B — both match the public figures, which is
   the check that these are the right accounts and not lookalikes. */
const SOLANA_STABLE_MINTS = {
    USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
};

async function providerFetch(url, { body = null, timeoutMs = 12000 } = {}) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            method: body ? 'POST' : 'GET',
            headers: { 'Content-Type': 'application/json', 'User-Agent': 'Jarvis/1.0' },
            body: body ? JSON.stringify(body) : undefined,
            signal: ac.signal,
        });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* provider returned non-JSON */ }
        if (!res.ok) throw new Error(json?.error?.message || `http ${res.status}`);
        if (json?.error) throw new Error(json.error.message || 'provider error');
        return json;
    } finally { clearTimeout(t); }
}

/** Which chains/capabilities are actually available right now, and why not. */
ipcMain.handle('chain-providers-status', async () => ({
    success: true,
    alchemy: {
        keyed: !!alchemyKey,
        networks: Object.fromEntries(Object.entries(alchemyNetworks).map(([k, v]) => [k, { slug: v.slug, chainId: v.chainId }])),
        unavailable: alchemyRejected,
    },
    helius: { keyed: !!heliusKey },
}));

/* Full wallet contents across chains — Alchemy Portfolio. Public RPC can only
   answer "balance of TOKEN X", never "everything this address holds". */
ipcMain.handle('chain-portfolio', async (event, { address, chains } = {}) => {
    try {
        if (!alchemyKey) return { success: false, needsKey: 'alchemy', error: 'no Alchemy key configured' };
        if (!ADDR_RE.test(String(address || ''))) return { success: false, error: 'invalid address' };
        const wanted = (Array.isArray(chains) && chains.length ? chains : Object.keys(alchemyNetworks))
            .filter((c) => alchemyNetworks[c]);
        if (!wanted.length) return { success: false, error: 'no keyed networks available' };
        const networks = wanted.map((c) => alchemyNetworks[c].slug);

        const payload = await providerFetch(chainProviders.alchemyTokensByAddressUrl(alchemyKey), {
            body: { addresses: [{ address, networks }], withMetadata: true, withPrices: true },
            timeoutMs: 20000,
        });
        // slug -> chainKey so the renderer can name chains the way the user does
        const slugMap = Object.fromEntries(wanted.map((c) => [alchemyNetworks[c].slug, { chain: c, native: CHAIN_IDS[c]?.native }]));
        return { success: true, payload, networks: wanted, slugMap };
    } catch (e) { return { success: false, error: e.message }; }
});

/* USD prices straight from the provider — a measured feed, not a model guess. */
ipcMain.handle('chain-prices', async (event, { symbols, addresses } = {}) => {
    try {
        if (!alchemyKey) return { success: false, needsKey: 'alchemy', error: 'no Alchemy key configured' };
        if (Array.isArray(symbols) && symbols.length) {
            const clean = symbols.map((s) => String(s).trim().toUpperCase())
                .filter((s) => /^[A-Z0-9.-]{1,16}$/.test(s)).slice(0, 25);
            if (!clean.length) return { success: false, error: 'no valid symbols' };
            return { success: true, payload: await providerFetch(chainProviders.alchemyPricesBySymbolUrl(alchemyKey, clean)) };
        }
        if (Array.isArray(addresses) && addresses.length) {
            const clean = addresses.filter((a) => a && ADDR_RE.test(String(a.address || '')) && alchemyNetworks[a.chain])
                .map((a) => ({ network: alchemyNetworks[a.chain].slug, address: a.address })).slice(0, 25);
            if (!clean.length) return { success: false, error: 'no valid token addresses on keyed networks' };
            return { success: true, payload: await providerFetch(chainProviders.alchemyPricesByAddressUrl(alchemyKey), { body: { addresses: clean } }) };
        }
        return { success: false, error: 'nothing requested' };
    } catch (e) { return { success: false, error: e.message }; }
});

/* Solana, via Helius. Jarvis had NO Solana capability at all before this. */
ipcMain.handle('solana-activity', async (event, { address, limit } = {}) => {
    try {
        if (!heliusKey) return { success: false, needsKey: 'helius', error: 'no Helius key configured' };
        if (!SOL_ADDR_RE.test(String(address || ''))) return { success: false, error: 'invalid Solana address' };
        const n = Math.min(Math.max(1, Number(limit) || 10), 25);
        const payload = await providerFetch(chainProviders.heliusTxByAddressUrl(address, heliusKey, n), { timeoutMs: 20000 });
        return { success: true, payload };
    } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('solana-assets', async (event, { address, limit } = {}) => {
    try {
        if (!heliusKey) return { success: false, needsKey: 'helius', error: 'no Helius key configured' };
        if (!SOL_ADDR_RE.test(String(address || ''))) return { success: false, error: 'invalid Solana address' };
        const payload = await providerFetch(chainProviders.heliusRpcUrl(heliusKey), {
            body: {
                jsonrpc: '2.0', id: 'jarvis', method: 'getAssetsByOwner',
                params: {
                    ownerAddress: address, page: 1,
                    limit: Math.min(Math.max(1, Number(limit) || 20), 50),
                    displayOptions: { showFungible: true, showNativeBalance: true },
                },
            },
            timeoutMs: 20000,
        });
        return { success: true, payload };
    } catch (e) { return { success: false, error: e.message }; }
});

/* Read-only Solana RPC, same hard allowlist discipline as the EVM side. */
const SOL_READ_METHODS = new Set(['getSlot', 'getBalance', 'getBlockHeight', 'getLatestBlockhash', 'getTransaction', 'getSignaturesForAddress', 'getTokenAccountsByOwner']);
ipcMain.handle('solana-call', async (event, { method, params } = {}) => {
    try {
        if (!heliusKey) return { success: false, needsKey: 'helius', error: 'no Helius key configured' };
        if (!SOL_READ_METHODS.has(method)) return { success: false, error: `method not allowed: ${method}` };
        const payload = await providerFetch(chainProviders.heliusRpcUrl(heliusKey), {
            body: { jsonrpc: '2.0', id: 'jarvis', method, params: Array.isArray(params) ? params : [] },
        });
        return { success: true, result: payload?.result };
    } catch (e) { return { success: false, error: e.message }; }
});

/* Stablecoin issuance on demand — "has Circle minted anything today?".
   Uses the KEYLESS log pool: Alchemy's free tier caps eth_getLogs at 10 blocks,
   which cannot answer a question about the last hour. Measured on drpc: a
   300-block (~1h) window returns in 0.4-1.4s; 7200 blocks times out, so the
   window is capped at what the endpoint can actually serve rather than
   promising a day and failing. */
const ISSUANCE_MAX_SPAN = 600; // blocks (~2h at 12s) — drpc-verified workable
ipcMain.handle('chain-issuance', async (event, { chain = 'ethereum', spanBlocks, minUnits } = {}) => {
    try {
        const tokens = await verifyChainTokens(chain);
        const stables = Object.fromEntries(Object.entries(tokens).filter(([, v]) => /^(USDC|USDT|DAI)$/.test(v.symbol)));
        if (!Object.keys(stables).length) return { success: false, error: `no verified stablecoins on ${chain}` };
        const urls = RPC_LOG_URLS[chain];
        if (!urls) return { success: false, error: `log queries not supported on ${chain}` };

        const span = Math.min(Math.max(10, Number(spanBlocks) || 300), ISSUANCE_MAX_SPAN);
        const latest = parseInt(await rpcCall(chain, 'eth_blockNumber', []), 16);
        if (!Number.isFinite(latest)) return { success: false, error: `bad block number from ${chain}` };

        /* CHUNKED, because the free endpoints disagree about how wide a log
           query may be and the limits move: measured in one sitting, drpc
           served 300 blocks in 0.4s and later refused to route at all, 1rpc
           caps at 50 ("eth_getLogs is limited to 0 - 50 blocks range"), and
           Alchemy's free tier caps at 10. A 50-block chunk is inside every
           limit that answered. Chunks that fail are COUNTED, not hidden — the
           caller is told which part of the window was actually read, because
           "no mints in the last hour" and "I could only see half the hour" are
           different answers. */
        const CHUNK = 50, CONCURRENCY = 3;
        const zero = '0x' + '0'.repeat(64);
        const ranges = [];
        for (let end = latest; end > latest - span; end -= CHUNK) {
            ranges.push([Math.max(0, end - CHUNK + 1), end]);
        }

        const fetchRange = (topics, from, to) => hedgedRace(urls, async (url, signal) => {
            const res = await fetch(url, {
                method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'Jarvis/1.0' },
                body: JSON.stringify({
                    jsonrpc: '2.0', id: 1, method: 'eth_getLogs',
                    params: [{ address: Object.keys(stables), topics, fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }],
                }),
                signal,
            });
            if (!res.ok) throw new Error(`http ${res.status}`);
            const j = await res.json();
            if (j.error) throw new Error(j.error.message || 'rpc error');
            if (!Array.isArray(j.result)) throw new Error('empty result');
            return j.result;
        }, { hedgeAfterMs: 1500, timeoutMs: 12000 }).then(r => r.value);

        const jobs = [];
        for (const [from, to] of ranges) {
            jobs.push({ topics: [TRANSFER_TOPIC, zero], from, to });
            jobs.push({ topics: [TRANSFER_TOPIC, null, zero], from, to });
        }
        const logs = [];
        let failedChunks = 0;
        for (let i = 0; i < jobs.length; i += CONCURRENCY) {
            const batch = await Promise.all(jobs.slice(i, i + CONCURRENCY).map(j =>
                fetchRange(j.topics, j.from, j.to).catch(() => null)));
            for (const r of batch) { if (r) logs.push(...r); else failedChunks++; }
        }

        const blocksRead = Math.round(span * (1 - failedChunks / jobs.length));
        const events = scanIssuanceLogs(logs, {
            chain, tokens: stables,
            minAmount: Number.isFinite(minUnits) ? minUnits : 100000,
        });
        return {
            success: true, chain, fromBlock: latest - span, toBlock: latest,
            approxMinutes: Math.round(blocksRead * 12 / 60),
            requestedMinutes: Math.round(span * 12 / 60),
            partial: failedChunks > 0,
            coverage: `${jobs.length - failedChunks}/${jobs.length} chunks`,
            events: events.slice(0, 25),
            summary: summarizeIssuance(events),
        };
    } catch (e) { return { success: false, error: e.message }; }
});

/* Solana stablecoin supply — the same question the Ethereum handler answers by
   logs, answered here by the mint account itself. Helius serves it in ~150ms.
   A supply DELTA between two readings is a mint or a burn; a single reading is
   just the supply, and is reported as such. */
ipcMain.handle('solana-supply', async (event, { mints } = {}) => {
    try {
        if (!heliusKey) return { success: false, needsKey: 'helius', error: 'no Helius key configured' };
        const targets = (mints && typeof mints === 'object' ? mints : SOLANA_STABLE_MINTS);
        const out = {};
        await Promise.all(Object.entries(targets).map(async ([symbol, mint]) => {
            if (!SOL_ADDR_RE.test(String(mint))) return;
            try {
                const r = await providerFetch(chainProviders.heliusRpcUrl(heliusKey), {
                    body: { jsonrpc: '2.0', id: 'jarvis', method: 'getTokenSupply', params: [mint] }, timeoutMs: 8000,
                });
                const v = r?.result?.value;
                if (v) out[symbol] = { mint, amount: Number(v.uiAmountString), decimals: v.decimals, at: Date.now() };
            } catch { /* one mint failing must not take the rest down */ }
        }));
        return { success: true, supplies: out };
    } catch (e) { return { success: false, error: e.message }; }
});

/* =========================
   DUNE ANALYTICS (key-gated)
   Aggregate on-chain intelligence via DuneSQL — the class of question raw
   RPC cannot answer (top holders, USD-priced whale flows, supply history).
   HONEST GATING: every handler works only when the user has stored
   dune_api_key in the vault; without it they return needsKey so the voice
   layer says exactly what is missing instead of failing vaguely. Results
   are cached aggressively because the free tier is ~2,500 credits/month.
   Only vetted query templates run — no SQL is ever composed from voice
   text; values are validated (addresses/numbers) before interpolation.
========================= */
const DUNE_API = 'https://api.dune.com/api/v1';
const duneCache = new Map(); // key -> { rows, at }

async function duneQuery(sql, cacheKey, cacheTtlMs) {
    const cached = duneCache.get(cacheKey);
    if (cached && Date.now() - cached.at < cacheTtlMs) return { rows: cached.rows, cached: true };

    const apiKey = await getCredential('dune_api_key');
    if (!apiKey) return { needsKey: true };

    const exec = await fetch(`${DUNE_API}/sql/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Dune-API-Key': apiKey },
        body: JSON.stringify({ sql, performance: 'medium' }),
        signal: AbortSignal.timeout(15000),
    });
    if (!exec.ok) {
        const err = await exec.json().catch(() => ({}));
        throw new Error(`Dune execute failed: ${err.error || exec.status}`);
    }
    const { execution_id } = await exec.json();
    if (!execution_id) throw new Error('Dune returned no execution id');

    for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const st = await fetch(`${DUNE_API}/execution/${execution_id}/status`, {
            headers: { 'X-Dune-API-Key': apiKey }, signal: AbortSignal.timeout(10000),
        }).then(r => r.ok ? r.json() : null).catch(() => null);
        if (!st) continue;
        if (st.state === 'QUERY_STATE_COMPLETED') {
            const res = await fetch(`${DUNE_API}/execution/${execution_id}/results`, {
                headers: { 'X-Dune-API-Key': apiKey }, signal: AbortSignal.timeout(15000),
            });
            if (!res.ok) throw new Error('Dune results fetch failed');
            const rows = (await res.json())?.result?.rows || [];
            duneCache.set(cacheKey, { rows, at: Date.now() });
            return { rows, cached: false };
        }
        if (st.state === 'QUERY_STATE_FAILED') throw new Error(`Dune query failed: ${st.error || 'unknown'}`);
    }
    throw new Error('Dune query timed out after 60s');
}

const DUNE_ADDR = /^0x[0-9a-fA-F]{40}$/;

ipcMain.handle('dune-whale-transfers', async (event, { chain, minUsd, hours } = {}) => {
    try {
        const c = ['ethereum', 'bnb', 'arbitrum', 'base', 'optimism', 'polygon'].includes(chain) ? chain : 'ethereum';
        const usd = Math.max(100000, Math.min(Number(minUsd) || 1000000, 1e9));
        const h = Math.max(1, Math.min(Number(hours) || 24, 168));
        const sql = `SELECT block_time, "from" AS sender, "to" AS receiver, symbol, amount_usd,
                CAST(amount_raw AS double) / POW(10, decimals) AS amount
            FROM tokens.transfers
            WHERE blockchain = '${c}' AND block_time > now() - interval '${h}' hour
              AND amount_usd > ${usd}
            ORDER BY amount_usd DESC LIMIT 20`;
        const r = await duneQuery(sql, `whales:${c}:${usd}:${h}`, 5 * 60 * 1000);
        return r.needsKey ? { success: false, needsKey: true } : { success: true, rows: r.rows, cached: r.cached };
    } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('dune-top-holders', async (event, { tokenAddress } = {}) => {
    try {
        if (!DUNE_ADDR.test(String(tokenAddress || ''))) return { success: false, error: 'invalid token address' };
        const a = tokenAddress.toLowerCase();
        const sql = `SELECT address, SUM(amount) AS balance FROM (
                SELECT "to" AS address, CAST(value AS double) / 1e18 AS amount
                FROM erc20_ethereum.evt_Transfer WHERE contract_address = ${a}
                UNION ALL
                SELECT "from" AS address, -CAST(value AS double) / 1e18 AS amount
                FROM erc20_ethereum.evt_Transfer WHERE contract_address = ${a}
            ) t GROUP BY 1 HAVING SUM(amount) > 0.000001
            ORDER BY 2 DESC LIMIT 10`;
        const r = await duneQuery(sql, `holders:${a}`, 30 * 60 * 1000);
        return r.needsKey ? { success: false, needsKey: true } : { success: true, rows: r.rows, cached: r.cached };
    } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('dune-supply-history', async (event, { tokenAddress, days } = {}) => {
    try {
        if (!DUNE_ADDR.test(String(tokenAddress || ''))) return { success: false, error: 'invalid token address' };
        const a = tokenAddress.toLowerCase();
        const d = Math.max(1, Math.min(Number(days) || 30, 90));
        const sql = `SELECT date_trunc('day', evt_block_time) AS day,
                SUM(CASE WHEN "from" = 0x0000000000000000000000000000000000000000
                    THEN CAST(value AS double) / 1e18 ELSE 0 END) AS minted,
                SUM(CASE WHEN "to" = 0x0000000000000000000000000000000000000000
                    THEN CAST(value AS double) / 1e18 ELSE 0 END) AS redeemed
            FROM erc20_ethereum.evt_Transfer
            WHERE contract_address = ${a}
              AND evt_block_time > now() - interval '${d}' day
            GROUP BY 1 ORDER BY 1 DESC`;
        const r = await duneQuery(sql, `supplyhist:${a}:${d}`, 15 * 60 * 1000);
        return r.needsKey ? { success: false, needsKey: true } : { success: true, rows: r.rows, cached: r.cached };
    } catch (e) { return { success: false, error: e.message }; }
});

/* =========================
   REAL-TIME CHAIN STREAMER + ADDRESS WATCHLIST
   Push-based on-chain awareness: eth_subscribe(newHeads) over keyless
   public WebSocket RPC (LIVE-VERIFIED: publicnode serves newHeads without
   a key on both ethereum and arbitrum), then one hedged
   eth_getBlockByNumber per head, scanned by the pure chainWatch module.

   Deliberate boundaries, so this stays honest:
   - Ethereum only by default. Arbitrum produces multiple blocks per
     second (measured), which would mean hammering getBlockByNumber
     ~4x/sec forever on a free endpoint.
   - Native-value whales only. ERC-20 whale detection needs per-block log
     scanning + per-token pricing — not a keyless streamer's job.
   - NO built-in entity labels. Who owns an address is not on-chain data;
     a hardcoded "Binance Hot Wallet" dictionary is unverifiable
     attribution stated as fact. Labels come from exactly two honest
     sources: the user's own watchlist labels, and (when the user has
     stored an arkham_api_key in the vault) Arkham's API with the answer
     attributed to Arkham. Otherwise the address is spoken shortened.
   - Mempool (newPendingTransactions) deliberately skipped: most free
     endpoints reject it, and pending txs can be dropped/replaced — a
     spoken alert about a tx that never lands is misinformation.
========================= */
const WsClient = require('ws');
const { scanBlockTxs, shortAddr: chainShortAddr, scanTokenLogs, aggregateTokenWhales, scanIssuanceLogs, summarizeIssuance, TRANSFER_TOPIC, ZERO_ADDRESS } = require('./chainWatch');
// Metric/event tier (root CJS like chainWatch/streamGuard — main cannot import
// the renderer's ESM services).
const metricStore = require('./metricStore');
const { backoffDelay, createDedup, createBlockTracker, prioritizeAlerts } = require('./streamGuard');

const CHAIN_WS_URLS = {
    ethereum: process.env.JARVIS_ETH_WS || 'wss://ethereum-rpc.publicnode.com',
};
const CHAIN_WATCHLIST_FILE = () => path.join(app.getPath('userData'), 'chain-watchlist.json');
const ENTITY_DB_FILE = () => path.join(app.getPath('userData'), 'entity-labels.json');

let chainStream = null;          // { ws, chain, blocks, alerts, startedAt }
let chainWatchCache = null;      // watchlist kept in memory, persisted on change

async function loadChainWatchlist() {
    if (chainWatchCache) return chainWatchCache;
    chainWatchCache = await readJsonStore(CHAIN_WATCHLIST_FILE(), [], 'address watchlist');
    return chainWatchCache;
}
async function saveChainWatchlist(list) {
    chainWatchCache = list;
    return writeJsonStore(CHAIN_WATCHLIST_FILE(), list, 'address watchlist');
}

/* ETH/USD context for whale announcements. Best-effort with a 5-minute cache —
   reuses the existing keyless Yahoo quote path; a missing price simply means
   the alert speaks ETH amounts only, never a made-up dollar figure. */
let ethUsdCache = { price: null, at: 0 };
async function getEthUsd() {
    if (Date.now() - ethUsdCache.at < 5 * 60 * 1000) return ethUsdCache.price;
    try {
        const q = await fetchQuoteYahoo('ETH-USD');
        ethUsdCache = { price: q?.price || null, at: Date.now() };
    } catch { ethUsdCache = { price: null, at: Date.now() }; }
    return ethUsdCache.price;
}

/* --- ERC-20 whale tracking -------------------------------------------------
   Native-ETH-only whale watching reports a small slice of where money actually
   goes: most large value on Ethereum moves as stablecoins. These contracts are
   the candidates, and like the Alchemy slugs they must PROVE themselves before
   any amount is decoded with them — decimals() is read on-chain, and a token
   whose answer disagrees with the table (or that cannot be read) is dropped
   rather than trusted. Getting decimals wrong by 12 turns $4M into $4. */
const TOKEN_CANDIDATES = {
    ethereum: [
        { address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', symbol: 'USDC', decimals: 6 },
        { address: '0xdac17f958d2ee523a2206206994597c13d831ec7', symbol: 'USDT', decimals: 6 },
        { address: '0x6b175474e89094c44da98b954eedeac495271d0f', symbol: 'DAI', decimals: 18 },
        { address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', symbol: 'WETH', decimals: 18 },
        { address: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599', symbol: 'WBTC', decimals: 8 },
    ],
};
const DECIMALS_SELECTOR = '0x313ce567'; // decimals()
const TOKEN_WHALE_MIN_USD = 1000000;
/* Issuance is watched at treasury scale, in whole tokens — for a stablecoin the
   unit IS the dollar. Measured on live mainnet: a 1M floor catches roughly a
   dozen events an hour, which is a signal; a 100k floor would be a stream. */
const ISSUANCE_MIN_UNITS = 1000000;

/** Verified token table for a chain: { contractAddress: {symbol, decimals} }. */
const verifiedTokens = {};
async function verifyChainTokens(chainKey) {
    if (verifiedTokens[chainKey]) return verifiedTokens[chainKey];
    const table = {};
    const rejected = [];
    for (const t of TOKEN_CANDIDATES[chainKey] || []) {
        try {
            const raw = await rpcCall(chainKey, 'eth_call', [{ to: t.address, data: DECIMALS_SELECTOR }, 'latest']);
            const onchainDecimals = parseInt(raw, 16);
            if (onchainDecimals !== t.decimals) { rejected.push(`${t.symbol}: chain says ${onchainDecimals}`); continue; }
            table[t.address.toLowerCase()] = { symbol: t.symbol, decimals: t.decimals };
        } catch (e) { rejected.push(`${t.symbol}: ${e.message}`); }
    }
    verifiedTokens[chainKey] = table;
    console.log(`[chain] token decimals verified on ${chainKey}: ${Object.values(table).map(v => v.symbol).join(', ') || 'none'}` +
        (rejected.length ? ` | dropped: ${rejected.join('; ')}` : ''));
    return table;
}

/* Token prices, measured. Alchemy when keyed; nothing invented when not — an
   unpriced token simply falls back to a raw-unit floor, and the alert says the
   amount without claiming a dollar value. */
let tokenPriceCache = { at: 0, prices: {} };
async function getTokenPrices(symbols) {
    if (Date.now() - tokenPriceCache.at < 5 * 60 * 1000) return tokenPriceCache.prices;
    if (!alchemyKey || !symbols.length) return tokenPriceCache.prices;
    try {
        const payload = await providerFetch(chainProviders.alchemyPricesBySymbolUrl(alchemyKey, symbols), { timeoutMs: 8000 });
        const prices = {};
        for (const row of payload?.data || []) {
            const usd = (row?.prices || []).find(p => String(p?.currency).toLowerCase() === 'usd');
            if (usd && Number.isFinite(Number(usd.value))) prices[row.symbol] = Number(usd.value);
        }
        tokenPriceCache = { at: Date.now(), prices };
    } catch { tokenPriceCache = { at: Date.now(), prices: tokenPriceCache.prices }; }
    return tokenPriceCache.prices;
}

/* Entity labels — user's own labels first, then optional Arkham (attributed,
   cached). Returns { name, source } or null; NEVER a guess. */
let entityCache = null;
async function lookupEntity(address) {
    if (!address) return null;
    const key = String(address).toLowerCase();

    const watch = await loadChainWatchlist();
    const own = watch.find(w => w.address === key && w.label);
    if (own) return { name: own.label, source: 'your watchlist' };

    if (!entityCache) {
        try { entityCache = JSON.parse(await fs.readFile(ENTITY_DB_FILE(), 'utf-8')); }
        catch { entityCache = {}; }
    }
    if (entityCache[key]) return entityCache[key];

    const arkhamKey = await getCredential('arkham_api_key');
    if (arkhamKey) {
        try {
            const res = await fetch(`https://api.arkhamintelligence.com/intelligence/address/${key}`, {
                headers: { 'API-Key': arkhamKey }, signal: AbortSignal.timeout(5000),
            });
            if (res.ok) {
                const data = await res.json();
                const name = data?.arkhamEntity?.name;
                if (name) {
                    const label = { name, source: 'Arkham' };
                    entityCache[key] = label;
                    fs.writeFile(ENTITY_DB_FILE(), JSON.stringify(entityCache), 'utf-8').catch(() => {});
                    return label;
                }
            }
        } catch { /* Arkham unavailable — fall through to null */ }
    }
    return null;
}

async function describeParty(address) {
    if (!address) return 'a contract creation';
    const ent = await lookupEntity(address);
    return ent ? `${ent.name} (per ${ent.source})` : chainShortAddr(address);
}

/* Alert history — append-only JSONL so "show whale activity today" is
   answerable from what was actually seen, not from memory. Rotated at 2MB. */
const CHAIN_ALERTS_FILE = () => path.join(app.getPath('userData'), 'chain-alerts.jsonl');
async function appendChainAlert(entry) {
    try {
        const file = CHAIN_ALERTS_FILE();
        try {
            const st = await fs.stat(file);
            if (st.size > 2 * 1024 * 1024) await fs.rename(file, file + '.1').catch(() => {});
        } catch { /* no file yet */ }
        await fs.appendFile(file, JSON.stringify(entry) + '\n', 'utf-8');
    } catch { /* history is best-effort, never blocks an alert */ }
}

function stopChainStream() {
    if (!chainStream) return false;
    const s = chainStream;
    chainStream = null;            // cleared FIRST so close/heartbeat handlers see intent
    clearInterval(s.heartbeat);
    clearTimeout(s.reconnectTimer);
    try { s.ws?.terminate?.(); } catch { /* already gone */ }
    return true;
}

function startChainStream(chainKey = 'ethereum') {
    /* Prefer the keyed socket when the key proved it serves this chain: public
       newHeads sockets drop subscriptions under load, which is the failure the
       backfill logic exists to survive. An explicit JARVIS_ETH_WS override and
       the keyless default both remain, so this degrades rather than breaks. */
    const url = (!process.env.JARVIS_ETH_WS && alchemyWsUrl(chainKey)) || CHAIN_WS_URLS[chainKey];
    if (!url) return { success: false, error: `no stream endpoint for ${chainKey}` };
    if (chainStream?.chain === chainKey) return { success: true, already: true };
    stopChainStream();

    const state = {
        ws: null, chain: chainKey, startedAt: Date.now(), keyed: url === alchemyWsUrl(chainKey),
        blocks: 0, alerts: 0, reconnects: 0, attempt: 0,
        lastMsgAt: 0, heartbeat: null, reconnectTimer: null,
        procTotalMs: 0, procCount: 0,
        dedup: createDedup({ ttlMs: 10 * 60 * 1000, max: 2048 }),
        tracker: createBlockTracker({ maxGap: 5 }),
    };

    /* One block through scan -> dedupe -> prioritise -> announce -> history.
       Used identically by the live head path and gap backfill, so a backfilled
       block cannot behave differently from a live one. */
    const processBlock = async (blockHex, { backfilled = false } = {}) => {
        const t0 = Date.now();
        const block = await rpcCall(chainKey, 'eth_getBlockByNumber', [blockHex, true]).catch(() => null);
        if (!block?.transactions || chainStream !== state) return;
        state.blocks++;

        const blockNumber = parseInt(blockHex, 16);
        /* When the movement actually happened, taken from the block rather than
           from when this process got round to announcing it. The two differ by
           seconds on a live head and by many minutes on a block recovered after
           an outage — and only the block's own timestamp is a fact about the
           transfer. Every alert carries it so nothing is announced as though it
           were happening now when it is not. */
        const blockTs = block.timestamp ? parseInt(block.timestamp, 16) * 1000 : null;

        const watch = await loadChainWatchlist();
        const watchedAddrs = watch.filter(w => (w.chains || ['ethereum']).includes(chainKey)).map(w => w.address);
        const { whales, watchHits } = scanBlockTxs(block.transactions, { chain: chainKey, watch: watchedAddrs });

        /* Token transfers in the SAME block. One extra log query per block —
           affordable on a keyed endpoint, and it is where most of the money
           actually moves. A failure here degrades to native-only rather than
           taking the whole alert down. */
        const tokens = await verifyChainTokens(chainKey);
        const tokenAddrs = Object.keys(tokens);
        let tokenWhales = [], tokenHits = [];
        if (tokenAddrs.length) {
            const prices = await getTokenPrices([...new Set(Object.values(tokens).map(t => t.symbol))]);
            const logs = await rpcCall(chainKey, 'eth_getLogs', [{
                fromBlock: blockHex, toBlock: blockHex, address: tokenAddrs, topics: [TRANSFER_TOPIC],
            }]).catch(() => null);
            if (Array.isArray(logs)) {
                const scanned = scanTokenLogs(logs, {
                    chain: chainKey, tokens, prices, minUsd: TOKEN_WHALE_MIN_USD,
                    // Only used when a token has no measured price: a large
                    // round number of units, stated without a dollar claim.
                    minAmount: { USDC: 10n ** 12n, USDT: 10n ** 12n, DAI: 10n ** 24n },
                    watch: watchedAddrs,
                });
                // One transaction routing the same token through several pools
                // is ONE movement, not one alert per hop (live-verified: a
                // single arb tx otherwise announced $27M three times).
                tokenWhales = aggregateTokenWhales(scanned.whales);
                tokenHits = scanned.watchHits;

                /* Issuance rides the SAME logs — a mint is a Transfer from 0x0
                   and a burn one to it, so supply changes cost no extra query.
                   Announced separately: "Circle minted 250 million USDC" is a
                   different fact from "someone moved 250 million USDC". */
                for (const ev of scanIssuanceLogs(logs, { chain: chainKey, tokens, minAmount: ISSUANCE_MIN_UNITS })) {
                    if (state.dedup.seen(`${chainKey}:${ev.hash}:${ev.symbol}:${ev.kind}`)) continue;
                    state.alerts++;
                    publishEvent('stablecoin-issuance', {
                        ...ev, blockNumber, blockTs, backfilled,
                        counterpartyLabel: await describeParty(ev.counterparty),
                    });
                    appendChainAlert({ ts: Date.now(), blockTs, type: 'issuance', chain: chainKey, kind: ev.kind, hash: ev.hash, asset: ev.symbol, amount: ev.amount, units: ev.units, to: ev.counterparty, blockNumber });
                }
            }
        }

        // Duplicate suppression across reconnect replays and backfill overlap.
        // Token and native events from the SAME tx hash are distinct facts, so
        // the dedup key carries the symbol.
        const freshWhales = whales.filter(w => !state.dedup.seen(`${chainKey}:${w.hash}:w`));
        const freshHits = watchHits.filter(h => !state.dedup.seen(`${chainKey}:${h.hash}:h`));
        const freshTokenWhales = tokenWhales.filter(w => !state.dedup.seen(`${chainKey}:${w.hash}:${w.symbol}:w`));
        const freshTokenHits = tokenHits.filter(h => !state.dedup.seen(`${chainKey}:${h.hash}:${h.symbol}:h`));
        state.procCount++; state.procTotalMs += Date.now() - t0;
        if (!freshWhales.length && !freshHits.length && !freshTokenWhales.length && !freshTokenHits.length) return;

        const price = await getEthUsd();
        const usdOf = (amount) => price ? Math.round(parseFloat(String(amount).replace(/,/g, '')) * price) : null;

        // Watch hits ALWAYS announce — the user asked about these addresses.
        // Native and token hits differ only in where the amount came from.
        for (const h of [...freshHits, ...freshTokenHits]) {
            state.alerts++;
            const entry = watch.find(x => x.address === h.watched);
            const payload = {
                ...h, blockNumber, blockTs, backfilled,
                asset: h.symbol || CHAIN_IDS[chainKey]?.native || 'ETH',
                label: entry?.label || chainShortAddr(h.watched),
                counterparty: await describeParty(h.direction === 'out' ? h.to : h.from),
                counterpartyAddress: h.direction === 'out' ? h.to : h.from,
                usd: h.usd != null ? h.usd : usdOf(h.amount),
            };
            publishEvent('chain-watch-hit', payload);
            appendChainAlert({ ts: Date.now(), blockTs, type: 'watch', chain: chainKey, hash: h.hash, asset: payload.asset, amount: h.amount, usd: payload.usd, from: h.from, to: h.to, blockNumber });
        }

        /* Whales: native and token movements ranked TOGETHER by dollar value,
           because "the biggest thing that happened in this block" is one
           question, not one per asset. USD is attached before ranking so the
           comparison is between measured values, not raw units of different
           tokens. */
        const nativeSymbol = CHAIN_IDS[chainKey]?.native || 'ETH';
        const priced = [
            ...freshWhales.map(w => ({ ...w, asset: nativeSymbol, usd: usdOf(w.amount) })),
            ...freshTokenWhales.map(w => ({ ...w, asset: w.symbol })),
        ];
        const { speak, summary } = prioritizeAlerts(priced, { maxSpoken: 2 });
        for (const w of speak) {
            state.alerts++;
            const payload = {
                ...w, blockNumber, blockTs, backfilled,
                fromLabel: await describeParty(w.from),
                toLabel: await describeParty(w.to),
            };
            publishEvent('whale-alert', payload);
            appendChainAlert({ ts: Date.now(), blockTs, type: 'whale', chain: chainKey, hash: w.hash, asset: w.asset, amount: w.amount, usd: w.usd, from: w.from, to: w.to, blockNumber });
        }
        if (summary) {
            state.alerts++;
            publishEvent('whale-alert', {
                summary: true, blockNumber, blockTs, backfilled, chain: chainKey,
                count: summary.count,
                largestAmount: summary.largest.amount,
                largestAsset: summary.largest.asset,
                largestUsd: summary.largest.usd,
            });
            for (const w of [summary.largest]) {
                appendChainAlert({ ts: Date.now(), type: 'whale', chain: chainKey, hash: w.hash, asset: w.asset, amount: w.amount, usd: w.usd, from: w.from, to: w.to, blockNumber, summarized: summary.count });
            }
        }
    };

    const scheduleReconnect = () => {
        if (chainStream !== state || app.isQuittingJarvis) return;
        state.reconnects++;
        const delay = backoffDelay(state.attempt++);
        console.warn(`Chain stream: reconnecting (${chainKey}) in ${Math.round(delay / 1000)}s (attempt ${state.attempt})`);
        state.reconnectTimer = setTimeout(connect, delay);
    };

    const connect = () => {
        if (chainStream !== state || app.isQuittingJarvis) return;
        const ws = new WsClient(url);
        state.ws = ws;

        ws.on('open', () => {
            ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['newHeads'] }));
            state.lastMsgAt = Date.now();
            console.log(`Chain stream: connected (${chainKey})`);
        });

        ws.on('message', async (raw) => {
            state.lastMsgAt = Date.now();
            try {
                const msg = JSON.parse(raw);
                // Any successful subscription reply resets the backoff ladder.
                if (msg.id === 1 && msg.result) { state.attempt = 0; return; }
                if (msg.method !== 'eth_subscription' || !msg.params?.result?.number) return;

                const blockHex = msg.params.result.number;
                const n = parseInt(blockHex, 16);
                const { duplicate, gap, lost } = state.tracker.next(n);
                if (duplicate) return; // provider replayed a head after reconnect

                if (lost > 0) console.warn(`Chain stream: ${lost} blocks lost beyond backfill cap (${chainKey})`);
                // Backfill detected gaps oldest-first BEFORE the live head, so
                // announcements stay chronological. Dedup makes overlap safe.
                for (const missed of gap) {
                    await processBlock('0x' + missed.toString(16), { backfilled: true });
                }
                await processBlock(blockHex);
            } catch { /* one bad block must not kill the stream */ }
        });

        ws.on('pong', () => { state.lastMsgAt = Date.now(); });
        ws.on('close', () => { if (chainStream === state) scheduleReconnect(); });
        ws.on('error', (e) => console.warn(`Chain stream error (${chainKey}): ${e.message}`));
    };

    /* Heartbeat: ethereum heads arrive ~12s apart, so 90s of silence means the
       socket is dead even if TCP hasn't noticed (BT/wifi transitions on this
       machine kill connections eventlessly — same lesson as the mic watchdog).
       Ping at 30s; terminate (not close: close waits for the peer) at 90s. */
    state.heartbeat = setInterval(() => {
        if (chainStream !== state) return;
        const ws = state.ws;
        if (!ws || ws.readyState !== 1) return;
        const silentMs = Date.now() - state.lastMsgAt;
        if (silentMs > 90000) {
            console.warn(`Chain stream: no traffic for ${Math.round(silentMs / 1000)}s, forcing reconnect (${chainKey})`);
            try { ws.terminate(); } catch { /* close handler reconnects */ }
        } else if (silentMs > 30000) {
            try { ws.ping(); } catch { /* dead socket -> heartbeat catches it next tick */ }
        }
    }, 15000);

    chainStream = state;
    connect();
    return { success: true };
}

/* Today's alert history, aggregated for "show whale activity today". Reads the
   JSONL (plus rotation file) and reports only what was actually recorded. */
ipcMain.handle('chain-alerts-summary', async (event, { sinceMs } = {}) => {
    // Default window is today; a caller can ask for the last N milliseconds
    // ("the last five minutes") instead.
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    const since = Number.isFinite(sinceMs) && sinceMs > 0 ? Date.now() - sinceMs : midnight.getTime();
    const rows = [];
    for (const f of [CHAIN_ALERTS_FILE() + '.1', CHAIN_ALERTS_FILE()]) {
        try {
            const text = await fs.readFile(f, 'utf-8');
            for (const line of text.split('\n')) {
                if (!line.trim()) continue;
                try { const r = JSON.parse(line); if (r.ts >= since) rows.push(r); } catch { /* skip torn line */ }
            }
        } catch { /* file may not exist */ }
    }
    const whales = rows.filter(r => r.type === 'whale');
    const watch = rows.filter(r => r.type === 'watch');
    const issuance = rows.filter(r => r.type === 'issuance');

    /* Per-asset totals: "42M USDC and 12M USDT moved" is the shape of the
       question. Ranking uses USD where it was measured, because raw amounts of
       different assets are not comparable. */
    const byAsset = {};
    for (const w of whales) {
        const sym = w.asset || 'ETH';
        const a = (byAsset[sym] = byAsset[sym] || { count: 0, totalUsd: 0, unpriced: 0 });
        a.count++;
        if (Number.isFinite(w.usd)) a.totalUsd += w.usd; else a.unpriced++;
    }
    let largest = null;
    for (const w of whales) {
        if (!Number.isFinite(w.usd)) continue;
        if (!largest || w.usd > largest.usd) largest = w;
    }
    // Nothing priced in the window: fall back to raw units, which are only
    // comparable within one asset — so the asset is named alongside.
    if (!largest && whales.length) {
        for (const w of whales) {
            const v = parseFloat(String(w.amount).replace(/,/g, '')) || 0;
            if (!largest || v > (parseFloat(String(largest.amount).replace(/,/g, '')) || 0)) largest = w;
        }
    }

    return {
        success: true,
        since,
        windowMinutes: Math.round((Date.now() - since) / 60000),
        whaleCount: whales.length,
        watchCount: watch.length,
        issuanceCount: issuance.length,
        byAsset,
        issuance: issuance.slice(-10).map(r => ({ kind: r.kind, asset: r.asset, amount: r.amount, units: r.units, ts: r.ts })),
        largest: largest ? { amount: largest.amount, asset: largest.asset || 'ETH', usd: largest.usd || null, from: largest.from, to: largest.to, hash: largest.hash, blockNumber: largest.blockNumber, ts: largest.ts } : null,
        streaming: !!chainStream,
    };
});

ipcMain.handle('chain-stream-start', async (event, { chain } = {}) => startChainStream(chain || 'ethereum'));
ipcMain.handle('chain-stream-stop', async () => ({ success: true, wasRunning: stopChainStream() }));
ipcMain.handle('chain-stream-status', async () => chainStream
    ? {
        running: true,
        chain: chainStream.chain,
        connected: chainStream.ws?.readyState === 1,
        blocks: chainStream.blocks,
        alerts: chainStream.alerts,
        reconnects: chainStream.reconnects,
        missedBlocks: chainStream.tracker.missedTotal,
        lastBlock: chainStream.tracker.lastBlock,
        uptimeMin: Math.round((Date.now() - chainStream.startedAt) / 60000),
        avgProcessMs: chainStream.procCount ? Math.round(chainStream.procTotalMs / chainStream.procCount) : null,
        dedupSize: chainStream.dedup.size,
        // Whether the feed is the keyed provider or a public endpoint. The URL
        // itself is never returned — it embeds the API key.
        keyed: chainStream.keyed,
    }
    : { running: false });

ipcMain.handle('chain-watchlist-add', async (event, { address, label, chains }) => {
    if (!ADDR_RE.test(String(address || ''))) return { success: false, error: 'invalid address' };
    const key = address.toLowerCase();
    const list = await loadChainWatchlist();
    const existing = list.find(w => w.address === key);
    if (existing) {
        if (label) existing.label = label;
        if (chains) existing.chains = chains;
    } else {
        list.push({ address: key, label: label || chainShortAddr(key), chains: chains || ['ethereum'], added: Date.now() });
    }
    await saveChainWatchlist(list);
    return { success: true, count: list.length };
});
ipcMain.handle('chain-watchlist-get', async () => loadChainWatchlist());
ipcMain.handle('chain-watchlist-remove', async (event, { address }) => {
    const key = String(address || '').toLowerCase();
    const list = await loadChainWatchlist();
    const next = list.filter(w => w.address !== key);
    await saveChainWatchlist(next);
    return { success: true, removed: list.length - next.length };
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

/* The vault matters more than the other stores: a lost credential cannot be
   recovered from anywhere else in the system, and the user may not discover it
   is gone until the key it held is needed. */
async function loadCreds() {
    return readJsonStore(CRED_FILE(), {}, 'credential vault');
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
    // Atomic, like every other store: a crash mid-write must not truncate the
    // vault, because the next load would then quarantine it and every stored
    // key would need re-entering.
    const w = await writeJsonStore(CRED_FILE(), creds, 'credential vault');
    if (!w.success) return { success: false, error: w.error };
    return { success: true, name: safeName };
});

ipcMain.handle('secure-cred-list', async () => Object.keys(await loadCreds()));

ipcMain.handle('secure-cred-delete', async (event, name) => {
    const creds = await loadCreds();
    delete creds[String(name).toLowerCase()];
    return writeJsonStore(CRED_FILE(), creds, 'credential vault');
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
    return readJsonStore(WATCHLIST_FILE(), [], 'price watchlist');
}
async function saveWatchlist(list) {
    return writeJsonStore(WATCHLIST_FILE(), list, 'price watchlist');
}

async function fetchQuoteYahoo(symbol) {
    const res = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`,
        { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) }
    );
    if (!res.ok) throw new Error(`yahoo ${res.status}`);
    const data = await res.json();
    const meta = data?.chart?.result?.[0]?.meta;
    const price = meta?.regularMarketPrice;
    if (price == null) throw new Error('no price in response');
    // Day change is derived from the previous close. Yahoo names this field
    // inconsistently across asset classes (chartPreviousClose for equities,
    // previousClose for some crypto), so fall back through both before giving up
    // on the change rather than reporting a wrong one.
    const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? null;
    const changePct = prevClose ? ((price - prevClose) / prevClose) * 100 : null;
    return {
        price,
        prevClose,
        changePct,
        currency: meta.currency || 'USD',
        name: meta.shortName || meta.longName || symbol,
        marketState: meta.marketState || null,
        source: 'yahoo',
    };
}

// Resolve a spoken company/asset name to a ticker via Yahoo's keyless search
// ("tesla" -> TSLA, "bitcoin" -> BTC-USD). Returns null when nothing sensible
// matches, so the caller can say so plainly rather than quote a wrong symbol.
// A string that is already ticker-shaped is passed straight through — resolving
// "AAPL" would waste a request and can mis-rank against a fund of the same name.
async function resolveSymbol(text) {
    const raw = String(text || '').trim();
    if (!raw) return null;
    // Ticker-shaped already: 1-6 letters, optional -USD / .NS style suffix.
    if (/^[A-Za-z]{1,6}(-[A-Za-z]{2,4}|\.[A-Za-z]{1,3})?$/.test(raw) && raw === raw.toUpperCase()) {
        return raw;
    }
    const res = await fetch(
        `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(raw)}&quotesCount=6&newsCount=0`,
        { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) }
    );
    if (!res.ok) throw new Error(`yahoo search ${res.status}`);
    const quotes = (await res.json())?.quotes || [];
    // Yahoo already returns these in relevance order, and that order is better
    // than any type preference: for "bitcoin" it puts BTC-USD first, ahead of
    // the GBTC trust and the futures. So KEEP the order and merely skip the
    // instruments a spoken "what's X worth" never means — a re-sort by type is
    // what wrongly promoted the ETF over the coin. Take the first tradable.
    const SKIP = new Set(['FUTURE', 'OPTION', 'INDEX', 'ECNQUOTE']);
    const best = quotes.find((q) => q.symbol && !SKIP.has(q.quoteType));
    return best ? best.symbol : (quotes[0]?.symbol || null);
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

// On-demand single quote for a spoken price question ("what's Tesla trading
// at"). Resolves a name to a ticker, then reuses the SAME reliable Yahoo path
// as the watchlist poller — the whole point is that a live price question no
// longer falls back to scraping search-engine snippets. A fresh cache entry (<
// 45s old) is reused so rapid re-asks do not re-hit the network.
ipcMain.handle('get-quote', async (event, text) => {
    try {
        const symbol = await resolveSymbol(text);
        if (!symbol) return { success: false, error: 'no matching symbol' };
        const cached = quoteCache.get(symbol);
        if (cached && Date.now() - cached.at < 45000) {
            return { success: true, symbol, ...cached };
        }
        const quote = await fetchQuoteYahoo(symbol);
        quoteCache.set(symbol, { ...quote, at: Date.now() });
        return { success: true, symbol, ...quote };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// Historical daily closes for quant analytics — the structured series the
// deterministic quant engine (services/quant.js) computes on. Reuses the SAME
// keyless Yahoo chart endpoint and resolveSymbol as the quote path; only the
// range differs. Live market data is fetched, never stored in memory (per the
// architecture: prices are queried, not remembered). Returns closes + the
// currency/name so the caller can present real numbers, not model guesses.
const HISTORY_RANGES = new Set(['5d', '1mo', '3mo', '6mo', '1y', '2y', '5y', 'ytd', 'max']);
ipcMain.handle('get-history', async (event, opts) => {
    try {
        const symbol = await resolveSymbol(opts?.text || opts?.symbol);
        if (!symbol) return { success: false, error: 'no matching symbol' };
        const range = HISTORY_RANGES.has(opts?.range) ? opts.range : '1y';
        const res = await fetch(
            `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${range}`,
            { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(12000) }
        );
        if (!res.ok) throw new Error(`yahoo history ${res.status}`);
        const r = (await res.json())?.chart?.result?.[0];
        const rawCloses = r?.indicators?.quote?.[0]?.close || [];
        // Yahoo interpolates nulls on non-trading days; drop them so returns are
        // computed on real observations only.
        const closes = rawCloses.filter((x) => x != null && x > 0);
        if (closes.length < 5) throw new Error('insufficient history');
        return {
            success: true,
            symbol,
            range,
            closes,
            currency: r.meta?.currency || 'USD',
            name: r.meta?.shortName || r.meta?.longName || symbol,
        };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// Keyless news via RSS. RSS is used deliberately over scraping a news site's
// HTML: it is a stable, structured contract with real per-item timestamps and
// source attribution, which snippet scraping cannot give.
//
// Two independent providers with FAILOVER (Google News, then Bing News). Google
// News rate-limits an IP fairly aggressively on repeated hits and then serves an
// empty feed; a single source would make the feature silently unreliable, so a
// zero-item result from the first provider falls through to the second.
function decodeNewsTitle(raw) {
    return decodeEntities(String(raw).replace(/<!\[CDATA\[|\]\]>/g, '')).trim();
}

// Parse the <item> list of any RSS 2.0 feed into our normalized shape. Both
// Google and Bing use the same core tags, so one parser serves both.
function parseRssItems(xml, limit) {
    return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, limit).map((m) => {
        const block = m[1];
        const pick = (tag) => (block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)) || [])[1] || '';
        let title = decodeNewsTitle(pick('title'));
        // Google News encodes the outlet as "Headline - Source"; Bing carries a
        // <source> tag. Try the tag first, then the dash suffix.
        let source = decodeNewsTitle(pick('source'));
        if (!source) {
            const dash = title.lastIndexOf(' - ');
            if (dash > 0) { source = title.slice(dash + 3); title = title.slice(0, dash); }
        }
        const pub = pick('pubDate');
        const when = pub ? new Date(pub) : null;
        const valid = when && !Number.isNaN(when.getTime());
        return {
            title,
            source,
            url: pick('link').trim(),
            published: valid ? when.toISOString() : null,
            publishedText: valid ? timeAgo(when) : '',
            /* The actual date, not just how long ago. "3h ago" is the useful
               form in speech, but it cannot answer "what day is this from",
               which is exactly the question asked of a headline that sounds
               surprising. Both are carried. */
            publishedLocal: valid
                ? when.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
                : '',
        };
    }).filter((it) => it.title);
}

async function fetchRss(url) {
    const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) throw new Error(`rss ${res.status}`);
    return res.text();
}

ipcMain.handle('get-news', async (event, opts) => {
    const query = String(opts?.query || '').trim().slice(0, 120);
    const limit = Math.min(Math.max(Number(opts?.limit) || 5, 1), 10);

    /* FAILOVER CHAIN, ordered by what each provider actually serves.

       MEASURED, not assumed: Bing's `format=RSS` returns 314KB of HTML with
       zero <item> blocks for "top stories", "news" and "world news" — it only
       emits real RSS for a specific topic. So the general-headline fallback it
       was supposed to provide never worked; a Google outage meant no headlines
       at all. Yahoo and BBC serve genuine RSS for general news (newest items
       measured at 9 and 185 minutes old respectively) and are used instead. */
    const sources = query
        ? [
            `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`,
            `https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=RSS`,
        ]
        : [
            'https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en',
            'https://news.yahoo.com/rss/world',
            'https://feeds.bbci.co.uk/news/world/rss.xml',
        ];

    let lastError = null;
    for (const url of sources) {
        try {
            const items = parseRssItems(await fetchRss(url), limit);
            if (items.length) {
                /* Feed freshness, stated rather than assumed. A provider that
                   starts serving a cached or stale feed looks identical to a
                   working one from the inside — the only tell is the age of its
                   newest item, so that is reported and the caller decides what
                   to say about it. */
                const newest = items.map(i => Date.parse(i.published)).filter(Number.isFinite).sort((a, b) => b - a)[0] || null;
                return {
                    success: true, query, items,
                    provider: new URL(url).hostname,
                    newestAgeMinutes: newest ? Math.round((Date.now() - newest) / 60000) : null,
                    fetchedAt: Date.now(),
                };
            }
            lastError = `${new URL(url).hostname} returned no items`;
        } catch (error) {
            lastError = error.message; // try the next provider
        }
    }
    return { success: false, error: lastError || 'no news available', items: [] };
});

// Compact relative time ("3h ago") for news recency, spoken and displayed.
function timeAgo(date) {
    const s = Math.max(0, (Date.now() - date.getTime()) / 1000);
    if (s < 90) return 'just now';
    const m = s / 60;
    if (m < 60) return `${Math.round(m)}m ago`;
    const h = m / 60;
    if (h < 24) return `${Math.round(h)}h ago`;
    return `${Math.round(h / 24)}d ago`;
}

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

/* ---- Android companion ---- */
const COMPANION_APK_PATH = path.join(
    __dirname, 'companion', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk'
);
let companionBridge = null;

// Served at /install. Deliberately dependency-free and inline-styled: this is
// rendered by a phone browser that has never seen this host before.
const COMPANION_INSTALL_PAGE = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Install JARVIS</title>
<style>
  body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;
       justify-content:center;background:#050a0f;color:#1accff;
       font-family:system-ui,-apple-system,sans-serif;text-align:center;padding:24px}
  h1{font-size:22px;letter-spacing:3px;font-weight:400;margin:0 0 8px}
  p{color:#7aa6b8;font-size:14px;line-height:1.6;max-width:320px;margin:0 0 28px}
  a{display:inline-block;padding:16px 40px;border:1px solid #1accff;border-radius:8px;
    color:#1accff;text-decoration:none;font-size:16px;letter-spacing:1px}
  a:active{background:rgba(26,204,255,.15)}
  small{display:block;margin-top:28px;color:#4a6b7a;font-size:12px;max-width:320px}
</style></head>
<body>
  <h1>JARVIS</h1>
  <p>Install the companion app to mirror the visualizer and link this phone to your desktop.</p>
  <a href="/apk">Download APK</a>
  <small>Android will ask permission to install from this browser. The app pairs
  automatically once opened, while the desktop pairing window is still open.</small>
</body></html>`;

/**
 * LAN IPv4 addresses, best-first.
 *
 * Order matters: addresses[0] is what the pairing QR and the install URL are
 * built from. Unranked, this machine returns the VirtualBox host-only adapter
 * (192.168.56.1) before the real Wi-Fi address (192.168.0.107) — a phone on the
 * Wi-Fi subnet cannot route to it, so pairing timed out and the QR pointed at a
 * dead host. Virtual and link-local adapters are pushed to the back.
 */
function getLanAddresses() {
    const nets = os.networkInterfaces();
    const candidates = [];

    for (const name of Object.keys(nets)) {
        for (const net of nets[name] || []) {
            if (net.family !== 'IPv4' || net.internal) continue;

            const ip = net.address;
            // APIPA/link-local: never routable to a phone.
            if (ip.startsWith('169.254.')) continue;

            let rank = 0;
            // VirtualBox/VMware host-only and Docker/WSL bridges: real
            // interfaces, but never the one the phone is on.
            if (ip.startsWith('192.168.56.') || ip.startsWith('192.168.99.')) rank += 100;
            if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) rank += 100;
            if (/virtual|vmware|hyper-v|vethernet|docker|wsl|loopback|tailscale|zerotier/i.test(name)) rank += 100;
            // Prefer the adapter that is actually the Wi-Fi/Ethernet uplink.
            if (/wi-?fi|wlan|wireless/i.test(name)) rank -= 10;
            else if (/^ethernet$/i.test(name)) rank -= 5;

            candidates.push({ ip, rank, name });
        }
    }

    candidates.sort((a, b) => a.rank - b.rank);
    return candidates.map((c) => c.ip);
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
        const url = new URL(req.url, `http://localhost:${PHONE_BRIDGE_PORT}`);

        /* ---- unauthenticated onboarding routes ----
           These MUST bypass the token check: a phone that has not paired yet
           has no token by definition. They are gated instead by the pairing
           window, which only the desktop user can open. */

        // Serves the companion APK for the QR-code install flow.
        if (req.method === 'GET' && url.pathname === '/apk') {
            if (!companionBridge || !companionBridge.isPairingOpen) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'pairing window is closed' }));
                return;
            }
            if (!fsSync.existsSync(COMPANION_APK_PATH)) {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('Companion APK not built yet. Run: companion/gradlew assembleDebug');
                return;
            }
            const stat = fsSync.statSync(COMPANION_APK_PATH);
            res.writeHead(200, {
                'Content-Type': 'application/vnd.android.package-archive',
                'Content-Length': stat.size,
                'Content-Disposition': 'attachment; filename="jarvis-companion.apk"'
            });
            fsSync.createReadStream(COMPANION_APK_PATH).pipe(res);
            return;
        }

        // Hands the bridge token to a phone, but only while the user has
        // explicitly opened the pairing window.
        if (req.method === 'POST' && url.pathname === '/pair') {
            if (!companionBridge || !companionBridge.isPairingOpen) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'pairing window is closed' }));
                return;
            }
            let body = '';
            req.on('data', (chunk) => {
                body += chunk;
                if (body.length > 4096) req.destroy();
            });
            req.on('end', () => {
                let device = {};
                try { device = JSON.parse(body || '{}'); } catch { /* tolerate */ }
                console.log(`Companion paired: ${device.model || 'unknown device'} (Android ${device.android || '?'})`);
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('companion-paired', device);
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ token: phoneBridgeToken, wsPort: COMPANION_WS_PORT }));
            });
            return;
        }

        // Landing page the QR code points at — gives the phone a tap target
        // rather than an immediate binary download.
        if (req.method === 'GET' && url.pathname === '/install') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(COMPANION_INSTALL_PAGE);
            return;
        }

        /* ---- everything below requires the token ---- */
        const token = req.headers['x-jarvis-token'] || url.searchParams.get('token');
        if (token !== phoneBridgeToken) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid token' }));
            return;
        }

        // Opens the companion pairing window without touching the HUD. Token
        // is required, so this grants nothing to a caller who does not already
        // hold the bridge secret. Useful for CLI/automation and for verifying
        // the pairing flow headlessly.
        if (req.method === 'POST' && url.pathname === '/pair-window') {
            if (!companionBridge) {
                res.writeHead(503, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'companion bridge not running' }));
                return;
            }
            const until = companionBridge.openPairingWindow();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, expiresAt: until }));
            return;
        }

        // Token-gated command passthrough to the paired phone. Same authority
        // as the renderer IPC path, exposed over the bridge so the companion
        // can be driven and tested without the HUD in the loop.
        if (req.method === 'POST' && url.pathname === '/companion/command') {
            let body = '';
            req.on('data', (chunk) => {
                body += chunk;
                if (body.length > 65536) req.destroy();
            });
            req.on('end', async () => {
                try {
                    const { action, params } = JSON.parse(body || '{}');
                    if (!companionBridge) throw new Error('companion bridge not running');
                    const result = await companionBridge.send(action, params || {});
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true, result }));
                } catch (e) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: e.message }));
                }
            });
            return;
        }

        if (req.method === 'GET' && url.pathname === '/companion/devices') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(companionBridge?.listDevices() ?? []));
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

/* =========================
   ANDROID COMPANION CONTROL PLANE
   Tier 1+2 run over the companion's WebSocket; Tier 3 shells out to adb.
========================= */
function startCompanionBridge() {
    if (companionBridge) return;

    companionBridge = new CompanionBridge({
        getToken: () => phoneBridgeToken,
        onEvent: ({ deviceId, event, payload }) => {
            // Phone-originated events reuse the existing renderer channel so
            // the HUD does not need a second notification path.
            if (event === 'notification' && mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('phone-notification', {
                    app: String(payload.app || 'phone').slice(0, 64),
                    title: String(payload.title || '').slice(0, 200),
                    text: String(payload.text || '').slice(0, 1000),
                    receivedAt: Date.now()
                });
            }
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('companion-event', { deviceId, event, payload });
            }
        },
        onDevicesChanged: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('companion-devices', companionBridge.listDevices());
            }
        }
    });

    companionBridge.start(PHONE_BRIDGE_PORT);
}

// Opens the install/pair window and returns a QR the phone can scan.
ipcMain.handle('companion-open-pairing', async () => {
    if (!companionBridge) return { error: 'companion bridge not running' };

    const until = companionBridge.openPairingWindow();
    const addresses = getLanAddresses();
    if (!addresses.length) {
        return { error: 'no LAN address — is this machine on Wi-Fi?' };
    }

    const installUrl = `http://${addresses[0]}:${PHONE_BRIDGE_PORT}/install`;
    const qrDataUrl = await QRCode.toDataURL(installUrl, {
        margin: 1,
        width: 320,
        color: { dark: '#1accffff', light: '#00000000' } // transparent, matches HUD
    });

    return {
        installUrl,
        qrDataUrl,
        expiresAt: until,
        apkBuilt: fsSync.existsSync(COMPANION_APK_PATH),
        addresses
    };
});

ipcMain.handle('companion-close-pairing', () => {
    companionBridge?.closePairingWindow();
    return { ok: true };
});

ipcMain.handle('companion-devices', () => companionBridge?.listDevices() ?? []);

// Generic command passthrough: click, swipe, get_layout, screenshot, tts, ...
ipcMain.handle('companion-command', async (_e, action, params) => {
    if (!companionBridge) return { ok: false, error: 'companion bridge not running' };
    try {
        const result = await companionBridge.send(action, params || {});
        return { ok: true, result };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

/* ---- Tier 3: ADB ---- */
ipcMain.handle('adb-command', async (_e, method, args) => {
    const fn = adbService[method];
    if (typeof fn !== 'function') {
        return { ok: false, error: `unknown adb method '${method}'` };
    }
    // Only the curated exports are reachable — never a raw shell string from
    // the renderer or from an LLM tool call.
    if (method === 'adb' || method === 'shell') {
        return { ok: false, error: 'raw adb/shell passthrough is disabled' };
    }
    try {
        const result = await fn(...(Array.isArray(args) ? args : []));
        return { ok: true, result };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

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
        const telemetry = {
            cpu: computeCpuLoad(),
            memUsedGb: +((totalMem - freeMem) / 1073741824).toFixed(1),
            memTotalGb: +(totalMem / 1073741824).toFixed(1),
            memPercent: Math.round(((totalMem - freeMem) / totalMem) * 100),
            uptimeHours: +(os.uptime() / 3600).toFixed(1),
            cores: os.cpus().length,
            timestamp: Date.now()
        };
        mainWindow.webContents.send('system-telemetry', telemetry);
        // The HUD still updates every 2s; only one row per minute is persisted.
        recordMetricSample(telemetry);
    }, 2000);
}

/* =========================
   METRIC HISTORY + EVENT LOG
   The storage tier the assistant was missing. Telemetry has always been
   correctly kept OUT of the RAG (embedding a CPU reading every two seconds
   would bury the knowledge base in noise), but it was also never persisted,
   so nothing about the past could be answered.

   Cheap by construction: one row per MINUTE (not per 2s poll), raw rows
   pruned after 7 days, and each day compacted into a ~150-byte rollup that is
   kept indefinitely. Events are derived, deduped and debounced by the pure
   metricStore engine rather than written per sample.
========================= */
const METRICS_FILE = () => path.join(app.getPath('userData'), 'metrics.jsonl');
const ROLLUP_FILE = () => path.join(app.getPath('userData'), 'metrics-rollups.jsonl');
const EVENTS_FILE = () => path.join(app.getPath('userData'), 'events.jsonl');

let _lastMetricTs = NaN;
let _eventState = {};
let _lastProcNames = null;
// Only programs worth narrating; tracking all ~260 would recreate the flood.
const WATCHED_PROCESSES = new Set(['chrome', 'msedge', 'firefox', 'brave', 'code', 'ollama',
    'llama-server', 'docker', 'python', 'node', 'electron', 'discord', 'spotify', 'steam']);

/* NOTE: this file binds `fs` to require('fs').promises; the SYNCHRONOUS API is
   `fsSync`. Using `fs.appendFileSync` here threw a TypeError that the catch
   below swallowed, so metrics silently never persisted — caught by checking
   for the file on disk rather than trusting the code path. */
function appendJsonl(file, rows, maxBytes = 4 * 1024 * 1024) {
    try {
        if (!rows.length) return;
        // Rotate before append so a crash cannot leave an unbounded file.
        try {
            const st = fsSync.statSync(file);
            if (st.size > maxBytes) fsSync.renameSync(file, file + '.1');
        } catch { /* absent is fine */ }
        fsSync.appendFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    } catch (e) { console.warn('metric append failed:', e.message); }
}

function readJsonl(file) {
    const out = [];
    for (const f of [file + '.1', file]) {
        try {
            for (const line of fsSync.readFileSync(f, 'utf8').split('\n')) {
                if (!line.trim()) continue;
                try { out.push(JSON.parse(line)); } catch { /* skip torn line */ }
            }
        } catch { /* absent is fine */ }
    }
    return out;
}

/** Called from the 2s telemetry tick; persists at most once per minute. */
function recordMetricSample(telemetry) {
    try {
        const now = Date.now();
        if (!metricStore.shouldPersist(_lastMetricTs, now)) return;
        _lastMetricTs = now;

        const sample = metricStore.makeSample(now, {
            cpu: telemetry.cpu,
            memPct: telemetry.memPercent,
            memUsedMB: telemetry.memUsedGb * 1024,
            topProc: lastTopProcess?.name || null,
            topCpu: lastTopProcess?.cpu ?? null,
        });
        appendJsonl(METRICS_FILE(), [sample]);

        const { events, state } = metricStore.deriveEvents(sample, _eventState, now);
        _eventState = state;
        if (events.length) {
            appendJsonl(EVENTS_FILE(), events, 2 * 1024 * 1024);
            // Threshold crossings are worth surfacing live, not just storing.
            for (const ev of events) publishEvent('system-threshold', ev);
        }
    } catch (e) { console.warn('metric sample failed:', e.message); }
}

// Lightweight top-process tracker: reuses the process collector at a slow
// cadence so samples can name what was busy, without a per-2s spawn.
let lastTopProcess = null;
function startProcessTracker() {
    const tick = async () => {
        try {
            const raw = await runPowerShell(PROCESS_SCRIPT, 20000);
            if (!raw) return;
            const j = JSON.parse(raw);
            const procs = Array.isArray(j.procs) ? j.procs : [j.procs];
            const byName = new Map();
            for (const p of procs) {
                if (!p?.name) continue;
                const k = p.name.toLowerCase();
                byName.set(k, (byName.get(k) || 0) + (typeof p.cpu === 'number' ? p.cpu : 0));
            }
            const top = [...byName.entries()].sort((a, b) => b[1] - a[1])[0];
            lastTopProcess = top ? { name: top[0], cpu: Math.round(top[1] * 10) / 10 } : null;

            const names = [...byName.keys()];
            if (_lastProcNames) {
                const evs = metricStore.deriveProcessEvents(_lastProcNames, names, Date.now(), WATCHED_PROCESSES);
                if (evs.length) {
                    appendJsonl(EVENTS_FILE(), evs, 2 * 1024 * 1024);
                    for (const ev of evs) publishEvent('process-change', ev);
                }
            }
            _lastProcNames = names;
        } catch { /* tracker is best-effort telemetry, never fatal */ }
    };
    tick();
    setInterval(tick, 60000);
}

ipcMain.handle('get-metric-history', async (event, { hours } = {}) => {
    try {
        const h = Math.max(1, Math.min(Number(hours) || 24, 24 * 30));
        const now = Date.now();
        const raw = readJsonl(METRICS_FILE());
        const rollups = readJsonl(ROLLUP_FILE());
        return {
            success: true,
            samples: metricStore.windowed(raw, now - h * 3600 * 1000),
            rollups,
            totalRaw: raw.length,
        };
    } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('get-system-events', async (event, { hours } = {}) => {
    try {
        const h = Math.max(1, Math.min(Number(hours) || 24, 24 * 30));
        const cutoff = Date.now() - h * 3600 * 1000;
        const evs = readJsonl(EVENTS_FILE()).filter(e => e.t >= cutoff);
        return { success: true, events: metricStore.dedupeEvents(evs) };
    } catch (e) { return { success: false, error: e.message }; }
});

/* Nightly compaction: yesterday's raw samples become one rollup row, then raw
   rows outside the retention window are dropped. This is the step that keeps
   the store flat rather than ever-growing. */
function compactMetrics() {
    try {
        const raw = readJsonl(METRICS_FILE());
        if (!raw.length) return;
        const today = metricStore.dayKey(Date.now());
        const existing = new Set(readJsonl(ROLLUP_FILE()).map(r => r.day));
        const fresh = metricStore.rollupByDay(raw)
            .filter(r => r.day !== today && !existing.has(r.day));
        if (fresh.length) appendJsonl(ROLLUP_FILE(), fresh, 1024 * 1024);

        const kept = metricStore.pruneRaw(raw, Date.now());
        if (kept.length !== raw.length) {
            fsSync.writeFileSync(METRICS_FILE(), kept.map(r => JSON.stringify(r)).join('\n') + '\n');
            try { fsSync.unlinkSync(METRICS_FILE() + '.1'); } catch { /* may not exist */ }
        }
        console.log(`Metrics compacted: +${fresh.length} rollups, ${raw.length}->${kept.length} raw rows`);
    } catch (e) { console.warn('metric compaction failed:', e.message); }
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
