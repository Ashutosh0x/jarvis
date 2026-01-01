const { app, BrowserWindow, ipcMain, desktopCapturer, clipboard, shell } = require('electron');
const path = require('path');
const { exec, execFile } = require('child_process');
const os = require('os');
const fs = require('fs').promises;

// GPU acceleration enabled for smooth visualizer performance
// Note: If transparency breaks, uncomment the line below
// app.disableHardwareAcceleration();

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
        path.join(homedir, 'Music')
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
            enableWebSQL: false
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

app.whenReady().then(() => {
    createWindow();

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

// Screen Capture Handler
ipcMain.handle('capture-screen', async () => {
    try {
        const sources = await desktopCapturer.getSources({ types: ['screen'] });
        if (sources.length === 0) {
            throw new Error('No screen sources available');
        }

        const primarySource = sources[0];
        const screenshotPath = path.join(os.tmpdir(), `jarvis-screenshot-${Date.now()}.png`);

        return { sourceId: primarySource.id, path: screenshotPath };
    } catch (error) {
        console.error('Screen capture error:', error);
        throw error;
    }
});

// OCR Handler (placeholder - requires Tesseract.js or OCR API)
ipcMain.handle('perform-ocr', async (event, imagePath) => {
    try {
        return 'OCR functionality requires Tesseract.js integration. This feature is coming soon.';
    } catch (error) {
        console.error('OCR error:', error);
        throw error;
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
