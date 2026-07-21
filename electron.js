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
    startSttServer();
    // Not awaited — readiness polling + model warm must not block the window.
    startOllamaServer();

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

ipcMain.handle('load-fact-store', async () => {
    try { return JSON.parse(await fs.readFile(FACT_STORE_FILE(), 'utf-8')); }
    catch { return { facts: [] }; }
});

ipcMain.handle('save-fact-store', async (event, data) => {
    try {
        const tmp = FACT_STORE_FILE() + '.tmp';
        await fs.writeFile(tmp, JSON.stringify(data), 'utf-8');
        await fs.rename(tmp, FACT_STORE_FILE()); // atomic: a crash can't corrupt the ledger
        return { success: true };
    } catch (error) {
        console.warn('Fact store save error:', error.message);
        return { success: false, error: error.message };
    }
});

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
};
// Only these JSON-RPC methods may ever be sent — a hard allowlist so the
// service can never be steered into a write/signing call.
const RPC_READ_METHODS = new Set(['eth_getBalance', 'eth_gasPrice', 'eth_call', 'eth_getTransactionCount', 'eth_blockNumber', 'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_getBlockByNumber']);

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
const { scanBlockTxs, shortAddr: chainShortAddr } = require('./chainWatch');

const CHAIN_WS_URLS = {
    ethereum: process.env.JARVIS_ETH_WS || 'wss://ethereum-rpc.publicnode.com',
};
const CHAIN_WATCHLIST_FILE = () => path.join(app.getPath('userData'), 'chain-watchlist.json');
const ENTITY_DB_FILE = () => path.join(app.getPath('userData'), 'entity-labels.json');

let chainStream = null;          // { ws, chain, blocks, alerts, startedAt }
let chainWatchCache = null;      // watchlist kept in memory, persisted on change

async function loadChainWatchlist() {
    if (chainWatchCache) return chainWatchCache;
    try { chainWatchCache = JSON.parse(await fs.readFile(CHAIN_WATCHLIST_FILE(), 'utf-8')); }
    catch { chainWatchCache = []; }
    return chainWatchCache;
}
async function saveChainWatchlist(list) {
    chainWatchCache = list;
    await fs.writeFile(CHAIN_WATCHLIST_FILE(), JSON.stringify(list, null, 2), 'utf-8');
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

function stopChainStream() {
    if (!chainStream) return false;
    try { chainStream.ws.close(); } catch { /* already closed */ }
    chainStream = null;
    return true;
}

function startChainStream(chainKey = 'ethereum') {
    const url = CHAIN_WS_URLS[chainKey];
    if (!url) return { success: false, error: `no stream endpoint for ${chainKey}` };
    if (chainStream?.chain === chainKey) return { success: true, already: true };
    stopChainStream();

    const state = { ws: null, chain: chainKey, blocks: 0, alerts: 0, startedAt: Date.now() };
    const connect = () => {
        if (chainStream !== state || app.isQuittingJarvis) return;
        const ws = new WsClient(url);
        state.ws = ws;

        ws.on('open', () => {
            ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['newHeads'] }));
            console.log(`Chain stream: connected (${chainKey})`);
        });

        ws.on('message', async (raw) => {
            try {
                const msg = JSON.parse(raw);
                if (msg.method !== 'eth_subscription' || !msg.params?.result?.number) return;
                const blockHex = msg.params.result.number;

                // Full block via the existing hedged HTTP path — the WS socket
                // stays a pure notification channel.
                const block = await rpcCall(chainKey, 'eth_getBlockByNumber', [blockHex, true]).catch(() => null);
                if (!block?.transactions || chainStream !== state) return;
                state.blocks++;

                const watch = await loadChainWatchlist();
                const { whales, watchHits } = scanBlockTxs(block.transactions, {
                    chain: chainKey,
                    watch: watch.filter(w => (w.chains || ['ethereum']).includes(chainKey)).map(w => w.address),
                });
                if (!whales.length && !watchHits.length) return;

                const price = await getEthUsd();
                const blockNumber = parseInt(blockHex, 16);

                for (const w of whales.slice(0, 3)) { // cap: a busy block must not queue 20 announcements
                    state.alerts++;
                    publishEvent('whale-alert', {
                        ...w,
                        blockNumber,
                        usd: price ? Math.round(parseFloat(w.amount.replace(/,/g, '')) * price) : null,
                        fromLabel: await describeParty(w.from),
                        toLabel: await describeParty(w.to),
                    });
                }
                for (const h of watchHits) {
                    state.alerts++;
                    const entry = watch.find(x => x.address === h.watched);
                    publishEvent('chain-watch-hit', {
                        ...h,
                        blockNumber,
                        label: entry?.label || chainShortAddr(h.watched),
                        counterparty: await describeParty(h.direction === 'out' ? h.to : h.from),
                        usd: price ? Math.round(parseFloat(h.amount.replace(/,/g, '')) * price) : null,
                    });
                }
            } catch { /* one bad block must not kill the stream */ }
        });

        ws.on('close', () => {
            if (chainStream === state && !app.isQuittingJarvis) {
                console.warn(`Chain stream: disconnected (${chainKey}), reconnecting in 10s`);
                setTimeout(connect, 10000);
            }
        });
        ws.on('error', (e) => console.warn(`Chain stream error (${chainKey}): ${e.message}`));
    };

    chainStream = state;
    connect();
    return { success: true };
}

ipcMain.handle('chain-stream-start', async (event, { chain } = {}) => startChainStream(chain || 'ethereum'));
ipcMain.handle('chain-stream-stop', async () => ({ success: true, wasRunning: stopChainStream() }));
ipcMain.handle('chain-stream-status', async () => chainStream
    ? { running: true, chain: chainStream.chain, blocks: chainStream.blocks, alerts: chainStream.alerts, connected: chainStream.ws?.readyState === 1 }
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
        return {
            title,
            source,
            url: pick('link').trim(),
            published: pub ? new Date(pub).toISOString() : null,
            publishedText: pub ? timeAgo(new Date(pub)) : '',
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

    const sources = [
        query
            ? `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`
            : `https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en`,
        // Bing needs a query; for top headlines fall back to a broad term.
        `https://www.bing.com/news/search?q=${encodeURIComponent(query || 'top stories')}&format=RSS`,
    ];

    let lastError = null;
    for (const url of sources) {
        try {
            const items = parseRssItems(await fetchRss(url), limit);
            if (items.length) return { success: true, query, items };
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
