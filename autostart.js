// ---------------------------------------------------------------------------
// Start with the machine, live in the tray.
//
// Three separate things, often confused:
//
//   AUTOSTART   the OS launches Jarvis at login
//   BACKGROUND  closing the window hides it instead of quitting
//   SINGLE      only ever one Jarvis, however it was launched
//
// The third is not optional once the first exists. Jarvis spawns a speech
// server, a TTS server, a vision server and Ollama, each binding a fixed port.
// A second instance — autostart plus a manual launch, which is the normal case
// on the first day — would fight the first for those ports, run a second
// microphone listener, and arm a second copy of every alarm. Without the lock
// this feature makes the app worse, so the lock is installed first and the rest
// depends on it.
// ---------------------------------------------------------------------------

const path = require('node:path');
const fsSync = require('node:fs');
const { app, Tray, Menu, nativeImage, shell } = require('electron');

/** Passed by the OS-registered launch command so the window stays hidden. */
const HIDDEN_FLAG = '--hidden';

let tray = null;
/** Set true only by an explicit Quit. Everything else hides to the tray. */
let quitting = false;

/**
 * Was this launch started by the OS at login?
 *
 * Two signals because they disagree by platform: Windows passes our own flag
 * from the registry command, macOS sets `wasOpenedAtLogin` instead.
 */
function launchedAtLogin() {
    if (process.argv.includes(HIDDEN_FLAG)) return true;
    try {
        return app.getLoginItemSettings().wasOpenedAtLogin === true;
    } catch {
        return false;
    }
}

/**
 * Whether autostart can actually be registered.
 *
 * In development `process.execPath` is electron.exe, so registering would put
 * a bare Electron runtime in the user's startup — it launches, finds no app,
 * and shows nothing. The entry would look installed and do nothing, which is
 * worse than refusing. Reported rather than silently skipped.
 */
function canRegister() {
    return app.isPackaged;
}

function isEnabled() {
    if (!canRegister()) return false;
    try {
        return app.getLoginItemSettings().openAtLogin === true;
    } catch {
        return false;
    }
}

/**
 * Turn autostart on or off.
 * @returns {{ ok: boolean, enabled: boolean, reason?: string }}
 */
function setEnabled(enabled) {
    if (!canRegister()) {
        return {
            ok: false,
            enabled: false,
            reason: 'Autostart can only be registered from an installed build. '
                + 'Run the installer, or `npm run dist`, then enable it there.',
        };
    }
    try {
        app.setLoginItemSettings({
            openAtLogin: Boolean(enabled),
            // Start into the tray, not with the window in your face. Someone
            // who wanted a window on every boot would not need autostart.
            args: enabled ? [HIDDEN_FLAG] : [],
            // macOS equivalent of the flag above.
            openAsHidden: Boolean(enabled),
        });
        return { ok: true, enabled: isEnabled() };
    } catch (e) {
        return { ok: false, enabled: isEnabled(), reason: e.message };
    }
}

/**
 * Claim the single-instance lock.
 *
 * MUST be called before app.whenReady(). Returns false when another Jarvis
 * already holds it, and the caller must exit immediately — see the header for
 * why a second instance is actively harmful rather than merely redundant.
 *
 * @param {() => import('electron').BrowserWindow|null} getWindow
 */
function claimSingleInstance(getWindow) {
    const gotLock = app.requestSingleInstanceLock();
    if (!gotLock) return false;

    // A second launch is a request to SEE Jarvis — someone clicked the icon
    // because they could not find the window. Surface the existing one.
    app.on('second-instance', () => {
        const win = getWindow();
        if (!win) return;
        if (win.isMinimized()) win.restore();
        if (!win.isVisible()) win.show();
        win.focus();
    });
    return true;
}

/**
 * Install the tray icon and background behaviour.
 *
 * @param {() => import('electron').BrowserWindow|null} getWindow
 * @param {object} [opts]
 * @param {() => void} [opts.onShow]
 */
function installTray(getWindow, { onShow } = {}) {
    if (tray) return tray;

    const iconPath = path.join(__dirname, 'build', 'icon.png');
    // A missing icon makes an invisible-but-present tray entry on Windows —
    // the app would be running with no way to reach it. Fall back to an empty
    // image, which at least renders as a placeholder square.
    const image = fsSync.existsSync(iconPath)
        ? nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
        : nativeImage.createEmpty();

    tray = new Tray(image);
    tray.setToolTip('Jarvis');

    const rebuild = () => {
        const win = getWindow();
        const visible = Boolean(win && win.isVisible());

        tray.setContextMenu(Menu.buildFromTemplate([
            {
                label: visible ? 'Hide Jarvis' : 'Show Jarvis',
                click: () => (visible ? hideWindow(getWindow) : showWindow(getWindow, onShow)),
            },
            { type: 'separator' },
            {
                label: 'Start when I sign in',
                type: 'checkbox',
                checked: isEnabled(),
                enabled: canRegister(),
                click: (item) => {
                    const res = setEnabled(item.checked);
                    // Reflect what actually happened, not what was clicked. A
                    // tick that survives a failed write is a lie about the
                    // state of the system.
                    item.checked = res.enabled;
                    if (!res.ok && res.reason) console.warn('[autostart]', res.reason);
                    rebuild();
                },
            },
            {
                label: 'Open logs folder',
                click: () => shell.openPath(app.getPath('userData')),
            },
            { type: 'separator' },
            {
                label: 'Quit Jarvis',
                click: () => {
                    quitting = true;
                    app.quit();
                },
            },
        ]));
    };

    rebuild();
    tray.on('click', () => {
        const win = getWindow();
        if (win && win.isVisible()) hideWindow(getWindow);
        else showWindow(getWindow, onShow);
    });

    // Keep the Show/Hide label honest when the window changes state by other
    // means — a close button, a renderer call, the second-instance handler.
    const win = getWindow();
    if (win) {
        win.on('show', rebuild);
        win.on('hide', rebuild);
    }

    return tray;
}

function showWindow(getWindow, onShow) {
    const win = getWindow();
    if (!win) return;
    win.show();
    win.focus();
    if (onShow) onShow();
}

function hideWindow(getWindow) {
    const win = getWindow();
    if (win) win.hide();
}

/**
 * Make the close button hide rather than quit.
 *
 * Only after the tray exists. Hiding a window with no tray icon leaves the app
 * running with no way to reach it and no way to stop it short of Task Manager.
 */
function keepAliveInTray(win) {
    if (!win || !tray) return;
    win.on('close', (event) => {
        if (quitting) return;      // an explicit Quit passes straight through
        event.preventDefault();
        win.hide();
    });
}

/** True once an explicit Quit has begun; lets `window-all-closed` behave. */
function isQuitting() { return quitting; }

function beginQuit() { quitting = true; }

function destroyTray() {
    if (tray) { tray.destroy(); tray = null; }
}

module.exports = {
    HIDDEN_FLAG,
    launchedAtLogin,
    canRegister,
    isEnabled,
    setEnabled,
    claimSingleInstance,
    installTray,
    keepAliveInTray,
    showWindow,
    hideWindow,
    isQuitting,
    beginQuit,
    destroyTray,
};
