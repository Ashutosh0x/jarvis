// Preload script for secure IPC communication
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    openApp: (app) => ipcRenderer.send('open-app', app),
    systemCommand: (command) => ipcRenderer.send('system-command', command),
    onAppOpened: (callback) => ipcRenderer.on('app-opened', callback),
    onSystemCommandResult: (callback) => ipcRenderer.on('system-command-result', callback),
    captureScreen: () => ipcRenderer.invoke('capture-screen'),
    performOCR: (imagePath) => ipcRenderer.invoke('perform-ocr', imagePath),
    fileOperation: (operation, ...args) => ipcRenderer.invoke('file-operation', operation, ...args),
    openWebsite: (url) => ipcRenderer.send('open-website', url),
    readClipboard: () => ipcRenderer.invoke('read-clipboard'),
    writeClipboard: (text) => ipcRenderer.invoke('write-clipboard', text),
    windowControl: (action) => ipcRenderer.send('window-control', action),
    getOSInfo: () => ipcRenderer.invoke('get-os-info')
});

