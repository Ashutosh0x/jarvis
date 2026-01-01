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
    performOCR: (imagePath) => ipcRenderer.invoke('perform-ocr', imagePath),
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
