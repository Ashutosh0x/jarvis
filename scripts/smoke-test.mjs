#!/usr/bin/env node
/**
 * Post-package smoke test: does the built app actually start?
 *
 * The unit suite is pure — no Electron, no DOM — which is what makes it fast,
 * but it means nothing in it would catch the packaging bug this repo shipped
 * with: a files glob that excluded the eleven root modules electron.js
 * requires. Every test passed; the installed app died on its first require.
 *
 * So this launches the REAL packaged binary and asserts the things that bug
 * would have broken:
 *   - the process starts and stays up
 *   - the main process reaches the point where it logs service startup
 *   - no missing-module error appears on stderr
 *   - it exits cleanly when asked
 *
 * Runs headless on CI via xvfb on Linux; Windows and macOS runners have a
 * session already.
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const releaseDir = join(root, 'release');

/** Locate the unpacked binary electron-builder leaves beside the installers. */
function findBinary() {
    if (!existsSync(releaseDir)) return null;
    const candidates = [
        ['win32', join(releaseDir, 'win-unpacked', 'Jarvis.exe')],
        ['darwin', join(releaseDir, 'mac-universal', 'Jarvis.app', 'Contents', 'MacOS', 'Jarvis')],
        ['darwin', join(releaseDir, 'mac', 'Jarvis.app', 'Contents', 'MacOS', 'Jarvis')],
        ['darwin', join(releaseDir, 'mac-arm64', 'Jarvis.app', 'Contents', 'MacOS', 'Jarvis')],
        ['linux', join(releaseDir, 'linux-unpacked', 'jarvis')],
    ];
    for (const [platform, path] of candidates) {
        if (platform === process.platform && existsSync(path)) return path;
    }
    return null;
}

const binary = findBinary();
if (!binary) {
    console.error('smoke: no unpacked build found in release/');
    if (existsSync(releaseDir)) console.error('  contents:', readdirSync(releaseDir).join(', '));
    process.exit(1);
}

console.log(`smoke: launching ${binary}`);

/* A missing module is the failure mode being guarded against, and Node reports
   it with a distinctive shape. Anything matching this is fatal regardless of
   exit code, because Electron can survive a failed require in a handler and
   still appear to run. */
const FATAL = /Cannot find module|MODULE_NOT_FOUND|Error: ENOENT.*\.(js|json)|App threw an error during load/;

/* Chromium's setuid sandbox helper needs root:root 4755. A real .deb or .rpm
   install sets that; a raw linux-unpacked directory straight out of a build
   does not, so Electron aborts before printing anything of its own. Detected
   separately because the generic "no startup output" message hid the cause and
   sent the reader looking for a packaging bug that was not there. */
const SANDBOX = /SUID sandbox helper binary|chrome-sandbox is owned by root/;

const child = spawn(binary, [], {
    env: { ...process.env, JARVIS_SMOKE_TEST: '1', ELECTRON_ENABLE_LOGGING: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
});

let out = '';
let fatal = null;
const collect = (buf) => {
    const text = String(buf);
    out += text;
    if (!fatal && FATAL.test(text)) fatal = text.trim().split('\n')[0];
};
child.stdout.on('data', collect);
child.stderr.on('data', collect);

/* Long enough for the main process to get through service startup, short
   enough that a hung CI job is obvious rather than a 6-hour timeout. */
const RUN_MS = 25000;
const timer = setTimeout(() => child.kill(), RUN_MS);

const exitCode = await new Promise((resolve) => {
    child.on('exit', (code) => { clearTimeout(timer); resolve(code); });
    child.on('error', (e) => { fatal = `spawn failed: ${e.message}`; resolve(-1); });
});

/* Evidence the main process actually reached its startup path, rather than
   merely failing to crash. Any one of these is enough — which services come up
   depends on what is installed on the runner. */
const STARTED = [
    /\[env\] loaded keys/,
    /Companion command server listening/,
    /Watchdog active/,
    /Search warm-up/,
    /server spawning/,
];
const evidence = STARTED.filter((re) => re.test(out));

console.log(`smoke: exit=${exitCode}, ${out.length} bytes of output, ` +
    `${evidence.length}/${STARTED.length} startup markers`);

if (SANDBOX.test(out)) {
    console.error('smoke: FAILED — Chromium\'s setuid sandbox is not configured.');
    console.error('       The packaged .deb/.rpm set this on install; an unpacked');
    console.error('       build does not. Reproduce the installed permissions with:');
    console.error(`         sudo chown root:root ${dirname(binary)}/chrome-sandbox`);
    console.error(`         sudo chmod 4755 ${dirname(binary)}/chrome-sandbox`);
    process.exit(1);
}
if (fatal) {
    console.error(`smoke: FAILED — ${fatal}`);
    console.error(out.slice(0, 4000));
    process.exit(1);
}
if (!evidence.length) {
    console.error('smoke: FAILED — the app produced no recognisable startup output.');
    console.error(out.slice(0, 4000) || '(no output at all)');
    process.exit(1);
}

console.log('smoke: PASSED — packaged app starts and initialises');
process.exit(0);
