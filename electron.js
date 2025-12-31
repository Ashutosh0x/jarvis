const { app, BrowserWindow, ipcMain, desktopCapturer, clipboard } = require('electron');
const path = require('path');
const { exec } = require('child_process');
const os = require('os');
const fs = require('fs').promises;

// GPU acceleration enabled for smooth visualizer performance
// Note: If transparency breaks, uncomment the line below
// app.disableHardwareAcceleration();

let mainWindow;

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

const apps = {
    chrome: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    notepad: 'notepad.exe',
    explorer: 'explorer.exe',
    vscode: 'code',
    downloads: 'explorer.exe'
};

ipcMain.on('open-app', (event, appName) => {
    try {
        if (appName === 'downloads') {
            const downloadsPath = path.join(os.homedir(), 'Downloads');
            exec(`explorer "${downloadsPath}"`);
        } else if (appName === 'vscode') {
            exec('code');
        } else if (apps[appName]) {
            exec(`"${apps[appName]}"`);
        } else {
            exec(appName);
        }
        event.reply('app-opened', { success: true, app: appName });
    } catch (error) {
        event.reply('app-opened', { success: false, error: error.message });
    }
});

ipcMain.on('system-command', (event, command) => {
    try {
        switch (command) {
            case 'shutdown':
                exec('shutdown /s /t 5');
                break;
            case 'restart':
                exec('shutdown /r /t 5');
                break;
            case 'mute':
                exec('nircmd mutesysvolume 1');
                break;
            case 'volume-up':
                exec('nircmd changesysvolume 2000');
                break;
            case 'brightness-up':
                exec('powershell -Command "(Get-WmiObject -Namespace root/WMI -Class WmiMonitorBrightnessMethods).WmiSetBrightness(1,80)"');
                break;
            default:
                console.log('Unknown command:', command);
        }
        event.reply('system-command-result', { success: true, command });
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

// File Operations Handler
ipcMain.handle('file-operation', async (event, operation, ...args) => {
    try {
        switch (operation) {
            case 'create-folder':
                const folderPath = args[0];
                await fs.mkdir(folderPath, { recursive: true });
                return { success: true, path: folderPath };

            case 'delete-file':
                const filePath = args[0];
                await fs.unlink(filePath);
                return { success: true, path: filePath };

            case 'list-files':
                const dirPath = args[0] || os.homedir();
                const files = await fs.readdir(dirPath);
                return { success: true, files };

            case 'read-file':
                const readPath = args[0];
                const content = await fs.readFile(readPath, 'utf-8');
                return { success: true, content };

            case 'search-files':
                const searchDir = args[0] || os.homedir();
                const pattern = args[1] || '*';
                const allFiles = await fs.readdir(searchDir, { withFileTypes: true });
                const matchingFiles = allFiles
                    .filter(file => file.name.includes(pattern))
                    .map(file => file.name);
                return { success: true, files: matchingFiles };

            default:
                throw new Error(`Unknown file operation: ${operation}`);
        }
    } catch (error) {
        console.error('File operation error:', error);
        return { success: false, error: error.message };
    }
});

// Website Opening Handler
ipcMain.on('open-website', (event, url) => {
    try {
        exec(`start ${url}`);
        event.reply('website-opened', { success: true, url });
    } catch (error) {
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
