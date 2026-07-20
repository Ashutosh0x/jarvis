/* =========================
   JARVIS ADB SERVICE (Tier 3)

   Wireless-ADB control of a paired Android device. This is strictly more
   powerful than the companion app's accessibility path — it can change system
   settings, manage packages and record the screen — and strictly higher
   friction, because the user must enable Wireless Debugging by hand.

   All control logic lives here on the desktop; the APK is not involved.
========================= */

const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

// Prefer a bundled adb, fall back to the one on PATH.
const ADB_CANDIDATES = [
    process.env.JARVIS_ADB_PATH,
    path.join('C:', 'platform-tools', 'platform-tools', 'adb.exe'),
    path.join('C:', 'platform-tools', 'adb.exe'),
    process.env.ANDROID_HOME ? path.join(process.env.ANDROID_HOME, 'platform-tools', 'adb.exe') : null,
    'adb'
].filter(Boolean);

function resolveAdb() {
    for (const candidate of ADB_CANDIDATES) {
        if (candidate === 'adb') return 'adb'; // let PATH resolve it
        try {
            if (fs.existsSync(candidate)) return candidate;
        } catch { /* keep looking */ }
    }
    return 'adb';
}

const ADB = resolveAdb();
const DEFAULT_TIMEOUT_MS = 20000;

/**
 * Runs adb with an argument ARRAY — never a concatenated string. String
 * concatenation here would be a command-injection hole the moment any of
 * these values comes from a spoken command or an LLM tool call.
 */
function adb(args, { timeout = DEFAULT_TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
        execFile(ADB, args, { timeout, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
            (err, stdout, stderr) => {
                if (err) {
                    const detail = (stderr || stdout || err.message).toString().trim();
                    reject(new Error(detail || `adb ${args[0]} failed`));
                    return;
                }
                resolve(stdout.toString().trim());
            });
    });
}

/* ---------- connection ---------- */

/** Pairs with a device using the 6-digit code from Wireless Debugging. */
async function pair(hostPort, code) {
    if (!/^[\w.:-]+$/.test(hostPort)) throw new Error('invalid host:port');
    if (!/^\d{6}$/.test(code)) throw new Error('pairing code must be 6 digits');
    return adb(['pair', hostPort, code], { timeout: 30000 });
}

async function connect(hostPort) {
    if (!/^[\w.:-]+$/.test(hostPort)) throw new Error('invalid host:port');
    const out = await adb(['connect', hostPort], { timeout: 30000 });
    // adb connect exits 0 even when it failed; the text is the real signal.
    if (/failed|cannot|unable|refused/i.test(out)) throw new Error(out);
    return out;
}

async function disconnect(hostPort) {
    return adb(hostPort ? ['disconnect', hostPort] : ['disconnect']);
}

async function devices() {
    const out = await adb(['devices', '-l']);
    return out
        .split('\n')
        .slice(1)
        .map((l) => l.trim())
        .filter(Boolean)
        .map((line) => {
            const [serial, state] = line.split(/\s+/);
            return { serial, state, raw: line };
        });
}

async function isConnected() {
    try {
        return (await devices()).some((d) => d.state === 'device');
    } catch {
        return false;
    }
}

/* ---------- shell helpers ---------- */

function shell(args, opts) {
    return adb(['shell', ...args], opts);
}

/* ---------- display / hardware ---------- */

async function setBrightnessPercent(pct) {
    const clamped = Math.max(0, Math.min(100, Number(pct)));
    if (!Number.isFinite(clamped)) throw new Error('brightness must be a number');
    const val = Math.round((clamped / 100) * 255);
    // Adaptive brightness overwrites a manual value within seconds.
    await shell(['settings', 'put', 'system', 'screen_brightness_mode', '0']);
    await shell(['settings', 'put', 'system', 'screen_brightness', String(val)]);
    return { percent: clamped, raw: val };
}

async function setMediaVolume(level) {
    const v = Math.max(0, Math.min(15, Math.round(Number(level))));
    if (!Number.isFinite(v)) throw new Error('volume must be a number');
    return shell(['media', 'volume', '--stream', '3', '--set', String(v)]);
}

async function battery() {
    const out = await shell(['dumpsys', 'battery']);
    const pick = (key) => {
        const m = out.match(new RegExp(`${key}:\\s*(\\S+)`));
        return m ? m[1] : null;
    };
    return {
        level: Number(pick('level')),
        scale: Number(pick('scale')),
        status: pick('status'),
        health: pick('health'),
        temperature: Number(pick('temperature')) / 10
    };
}

async function keyevent(code) {
    const n = Number(code);
    if (!Number.isInteger(n) || n < 0 || n > 1000) throw new Error('invalid keycode');
    return shell(['input', 'keyevent', String(n)]);
}

const KEYCODES = {
    home: 3, back: 4, power: 26, wake: 224, sleep: 223,
    playpause: 85, next: 87, previous: 88, mute: 164,
    volumeUp: 24, volumeDown: 25, camera: 27, enter: 66
};

/* ---------- input ---------- */

async function tap(x, y) {
    return shell(['input', 'tap', String(Math.round(x)), String(Math.round(y))]);
}

async function swipe(x1, y1, x2, y2, durationMs = 300) {
    return shell([
        'input', 'swipe',
        String(Math.round(x1)), String(Math.round(y1)),
        String(Math.round(x2)), String(Math.round(y2)),
        String(Math.round(durationMs))
    ]);
}

async function inputText(text) {
    // `input text` treats %s as a space and chokes on most punctuation.
    // execFile already avoids shell parsing, so only the %s convention applies.
    const encoded = String(text).replace(/ /g, '%s');
    return shell(['input', 'text', encoded]);
}

/* ---------- packages ---------- */

async function listPackages() {
    const out = await shell(['pm', 'list', 'packages']);
    return out.split('\n').map((l) => l.replace('package:', '').trim()).filter(Boolean);
}

function assertPackage(pkg) {
    if (!/^[A-Za-z0-9._]+$/.test(String(pkg))) throw new Error('invalid package name');
}

async function launchApp(pkg) {
    assertPackage(pkg);
    return shell(['monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1']);
}

async function forceStop(pkg) {
    assertPackage(pkg);
    return shell(['am', 'force-stop', pkg]);
}

async function uninstall(pkg) {
    assertPackage(pkg);
    return adb(['uninstall', pkg]);
}

async function installApk(apkPath) {
    if (!fs.existsSync(apkPath)) throw new Error(`APK not found: ${apkPath}`);
    return adb(['install', '-r', apkPath], { timeout: 180000 });
}

/* ---------- files / capture ---------- */

async function push(localPath, remotePath) {
    if (!fs.existsSync(localPath)) throw new Error(`file not found: ${localPath}`);
    return adb(['push', localPath, remotePath], { timeout: 120000 });
}

async function pull(remotePath, localPath) {
    return adb(['pull', remotePath, localPath], { timeout: 120000 });
}

/** Screenshot straight to a local PNG, via stdout to avoid a temp file. */
async function screencap(localPath) {
    const { execFile } = require('child_process');
    return new Promise((resolve, reject) => {
        const out = fs.createWriteStream(localPath);
        const proc = execFile(ADB, ['exec-out', 'screencap', '-p'], {
            encoding: 'buffer',
            maxBuffer: 64 * 1024 * 1024,
            windowsHide: true
        }, (err) => {
            if (err) reject(err);
        });
        proc.stdout.pipe(out);
        out.on('finish', () => resolve(localPath));
        out.on('error', reject);
    });
}

async function screenrecord(remotePath, seconds = 10) {
    const s = Math.max(1, Math.min(180, Math.round(Number(seconds))));
    return shell(['screenrecord', '--time-limit', String(s), remotePath], {
        timeout: (s + 30) * 1000
    });
}

module.exports = {
    ADB_PATH: ADB,
    adb,
    shell,
    pair,
    connect,
    disconnect,
    devices,
    isConnected,
    setBrightnessPercent,
    setMediaVolume,
    battery,
    keyevent,
    KEYCODES,
    tap,
    swipe,
    inputText,
    listPackages,
    launchApp,
    forceStop,
    uninstall,
    installApk,
    push,
    pull,
    screencap,
    screenrecord
};
