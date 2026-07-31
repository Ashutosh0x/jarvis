#!/usr/bin/env node
//
// Jarvis CLI launcher.
//
// `npx @ashutosh0x/jarvis` and `jarvis` (when installed globally) both land
// here. The job is small: find the Electron binary this package installed,
// hand it the app directory, and get out of the way.
//
// Electron is a real dependency rather than a peer because the whole point of
// shipping on npm is that `npm i -g` gives you a working app. Asking a user to
// install Electron separately would make the package a set of instructions
// rather than a program.
//

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const args = process.argv.slice(2);

// ── flags handled here, before Electron is spawned ──────────────────────────

if (args.includes('--version') || args.includes('-v')) {
    console.log(pkg.version);
    process.exit(0);
}

if (args.includes('--help') || args.includes('-h')) {
    console.log(`
  Jarvis ${pkg.version} — a local-first desktop AI assistant

  Usage
    jarvis                 Launch the app (sets itself up on first run)
    jarvis setup           Install everything Jarvis needs, then exit
    jarvis doctor          Report what is present, what is not, and how to fix it
    jarvis repair          Retry whatever setup could not finish
    jarvis link            Put the \`jarvis\` command on your PATH
    jarvis unlink          Take it off again
    jarvis --version       Print the version
    jarvis --help          Show this

  Setup flags
    --skip-setup           Launch without checking dependencies
    --verbose              Show installer output during setup

  Configuration
    Jarvis reads a .env from its install directory, or the environment.
    Nothing is required to start — every key below unlocks a feature, and
    the app degrades honestly without it.

      GEMINI_API_KEY       Conversational answers and vision
      OLLAMA_HOST          Local model endpoint (default http://127.0.0.1:11434)
      SEARXNG_URL          Your own SearXNG instance, if you run one

  Docs  https://github.com/Ashutosh0x/jarvis
`);
    process.exit(0);
}

const require_ = createRequire(import.meta.url);
const verbose = args.includes('--verbose');

if (args[0] === 'doctor') {
    process.exit(await doctor());
}

if (args[0] === 'link' || args[0] === 'unlink') {
    process.exit(await link(args[0] === 'unlink'));
}

if (args[0] === 'setup' || args[0] === 'repair') {
    const summary = await runSetup({ verbose });
    process.exit(summary.ok ? 0 : 1);
}

// ── first run ───────────────────────────────────────────────────────────────
//
// The whole point of this gate: someone who has just run `npm i -g` and typed
// `jarvis` should get a working assistant, not a window that cannot speak.
//
// It is deliberately NOT a hard gate. If setup fails, Jarvis still launches —
// degraded and honest about it — because a missing optional dependency is a
// worse reason to have no app than to have a quiet one.
if (!args.includes('--skip-setup') && !process.env.JARVIS_SKIP_SETUP) {
    try {
        const { needsBootstrap } = require_('../setup/bootstrap.js');
        const status = await needsBootstrap({ version: pkg.version });
        if (status.needed) {
            await runSetup({ verbose, reason: status.firstRun ? 'first-run' : 'missing' });
        }
    } catch (e) {
        // A broken bootstrapper must never be the reason the app will not
        // start. Say what happened and carry on.
        console.error(`  Setup check failed (${e.message}). Launching anyway — run \`jarvis doctor\` to see what is missing.
`);
    }
}

// ── launch ──────────────────────────────────────────────────────────────────

let electron;
try {
    // The module's default export is the absolute path to the binary, which is
    // the only reliable way to find it across npm, pnpm and yarn layouts.
    electron = (await import('electron')).default;
} catch {
    fail(
        'Electron is not installed.',
        'Reinstall with `npm i -g @ashutosh0x/jarvis`. If you are behind a proxy,',
        'Electron\'s postinstall download may have been blocked — set',
        'ELECTRON_MIRROR or run `npm rebuild electron`.'
    );
}

if (typeof electron !== 'string' || !existsSync(electron)) {
    fail(
        'The Electron binary is missing from this install.',
        'Run `npm rebuild electron`, or reinstall the package.'
    );
}

const renderer = join(root, 'dist', 'index.html');
if (!existsSync(renderer)) {
    // Published tarballs always contain dist/. Seeing this means someone is
    // running from a git clone without building, so say that rather than
    // showing an Electron white screen.
    fail(
        'The interface has not been built.',
        'If you are running from a clone: `npm install && npm run build`.',
        'If you installed from npm, this is a packaging bug — please report it.'
    );
}

const child = spawn(electron, [root, ...args], {
    stdio: 'inherit',
    env: process.env,
    windowsHide: false,
});

child.on('close', (code) => process.exit(code ?? 0));

// Forward the signal so Ctrl-C closes the window rather than orphaning it.
for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => child.kill(signal));
}

// ── helpers ─────────────────────────────────────────────────────────────────

function fail(...lines) {
    console.error(`\n  ${lines[0]}\n`);
    for (const line of lines.slice(1)) console.error(`  ${line}`);
    console.error('');
    process.exit(1);
}

/** Run the bootstrapper with a terminal reporter attached. */
async function runSetup({ verbose = false, reason } = {}) {
    const { bootstrap } = require_('../setup/bootstrap.js');
    const { createReporter } = require_('../setup/reporter.js');

    if (reason === 'first-run') {
        console.log('\n  First run — setting Jarvis up for this machine.');
    }

    const reporter = createReporter({ verbose });
    try {
        return await bootstrap({ onEvent: reporter.onEvent, version: pkg.version });
    } finally {
        // Leaving a spinner running would corrupt every line printed after it.
        reporter.stop();
    }
}

/**
 * Put `jarvis` on PATH, or take it off.
 *
 * Setup does this on first run; this exists for the case where it did not, or
 * where someone wants it gone. It prints what changed on disk and in the
 * environment, because a tool that edits your PATH silently is a tool you
 * cannot audit later.
 */
async function link(remove) {
    const pathSetup = require_('../setup/path.js');

    if (remove) {
        const res = await pathSetup.removeCommand();
        if (res.status === 'removed') {
            console.log(`\n  Removed: ${res.detail}\n`);
            console.log('  Open a new terminal for the change to take effect.\n');
            return 0;
        }
        console.error(`\n  ${res.detail}\n`);
        return 1;
    }

    const res = await pathSetup.ensureCommand({ root });

    if (res.status === 'present' && res.source === 'existing') {
        console.log(`\n  \`jarvis\` already runs from ${res.command}\n`);
        console.log('  Left alone — two launchers for one name is worse than none.\n');
        return 0;
    }
    if (res.status === 'installed' || res.status === 'present') {
        console.log(`\n  ${res.status === 'installed' ? 'Linked' : 'Already linked'}: ${res.command}`);
        console.log(`  Runs: ${res.target}\n`);
        if (res.needsNewShell) {
            console.log('  Open a NEW terminal and type `jarvis`. This one inherited its');
            console.log('  PATH before the change and cannot be updated from outside.\n');
        }
        return 0;
    }

    console.error(`\n  ${res.detail}\n`);
    return 1;
}

/**
 * What is present, what is not, and — for everything that is not — the exact
 * command that fixes it.
 *
 * "Missing" and "broken" are kept apart. Jarvis is designed to degrade: no
 * Ollama and no API key still runs, it just answers from fewer places. Marking
 * an optional absence as a failure trains people to ignore the whole report,
 * so only things that actually stop Jarvis working set the exit code.
 */
async function doctor() {
    const detect = require_('../setup/detect.js');
    const { readState } = require_('../setup/bootstrap.js');

    const OK = '✓', NO = '·', BAD = '✗';
    let broken = 0;

    /** @param {'ok'|'optional'|'broken'} level */
    const check = (level, label, detail = '', fix = null) => {
        console.log(`  ${level === 'ok' ? OK : level === 'broken' ? BAD : NO} ${label.padEnd(24)} ${detail}`);
        if (fix) console.log(`      → ${fix}`);
        if (level === 'broken') broken += 1;
    };

    console.log(`\n  Jarvis ${pkg.version}\n`);

    const d = await detect.detectAll();

    // ── runtime ─────────────────────────────────────────────────────────────
    console.log('  Runtime');
    check(d.node.adequate ? 'ok' : 'broken', 'Node', process.version,
        d.node.adequate ? null : 'Jarvis needs Node 22+. Install it from https://nodejs.org');
    check('ok', 'Platform', `${d.platform.os} ${d.platform.arch}`
        + (d.platform.appleSilicon ? ' (Apple Silicon)' : '')
        + (d.platform.isWSL ? ' (WSL)' : ''));
    check('ok', 'Memory / cores', `${d.resources.totalRamGB} GB, ${d.resources.cores} cores`);

    /* Free space only matters if something still has to be downloaded. Telling
       someone their 5 GB disk is too small for a model that is already sitting
       on it is a false alarm, and false alarms are how a report like this gets
       ignored. */
    const modelsPresent = d.ollama.apiUp
        && ['gemma3:4b', 'nomic-embed-text']
            .every((n) => (d.ollama.models || []).some((m) => m.startsWith(n)));

    if (d.resources.freeDiskGB === null) {
        // Unknown is reported as unknown. It is not a failure, and it is not
        // an assumed pass either.
        check('optional', 'Disk', 'could not be measured');
    } else if (modelsPresent) {
        check('ok', 'Disk', `${d.resources.freeDiskGB} GB free (models already downloaded)`);
    } else {
        check(d.resources.freeDiskGB >= 6 ? 'ok' : 'broken', 'Disk',
            `${d.resources.freeDiskGB} GB free`,
            d.resources.freeDiskGB >= 6 ? null
                : 'The AI model needs about 3.6 GB. Free some space, then run `jarvis repair`.');
    }

    check('ok', 'GPU', d.gpu.name ? `${d.gpu.name} (${d.gpu.backend})` : `none detected (${d.gpu.backend})`);

    let electronPath = null;
    try { electronPath = (await import('electron')).default; } catch { /* reported below */ }
    const electronOk = Boolean(electronPath && existsSync(electronPath));
    check(electronOk ? 'ok' : 'broken', 'Electron', electronOk ? 'installed' : 'missing',
        electronOk ? null : 'npm rebuild electron');

    const built = existsSync(join(root, 'dist', 'index.html'));
    check(built ? 'ok' : 'broken', 'Interface built', built ? 'yes' : 'no',
        built ? null : 'Running from a clone? `npm install && npm run build`. From npm? Please report it.');

    /* The `jarvis` command itself. `where jarvis` alone would be the wrong
       question: a machine linked thirty seconds ago answers no in THIS process
       and yes in the next terminal, because a running shell cannot be given a
       new PATH. commandAvailable() consults the persisted value as well. */
    const cmd = await require_('../setup/path.js').commandAvailable();
    check(cmd.available ? 'ok' : 'broken', 'jarvis command',
        cmd.available
            ? `${cmd.path}${cmd.needsNewShell ? '  (open a new terminal)' : ''}`
            : 'not on PATH',
        cmd.available ? null : 'jarvis link');

    // ── local model ─────────────────────────────────────────────────────────
    console.log('\n  Local model');
    check(d.ollama.installed ? 'ok' : 'broken', 'Ollama', d.ollama.path || 'not installed',
        d.ollama.installed ? null : 'jarvis repair  (or install from https://ollama.com/download)');

    if (d.ollama.installed) {
        check(d.ollama.apiUp ? 'ok' : 'broken', 'Ollama API',
            d.ollama.apiUp ? d.ollama.host : `${d.ollama.host} not answering`,
            d.ollama.apiUp ? null : 'Start it with `ollama serve`, or run `jarvis repair`.');
    }

    if (d.ollama.apiUp) {
        for (const [name, why] of [['gemma3:4b', 'local answers'], ['nomic-embed-text', 'memory search']]) {
            const have = (d.ollama.models || []).some((m) => m.startsWith(name));
            check(have ? 'ok' : 'broken', name, have ? 'present' : `missing — ${why} disabled`,
                have ? null : `ollama pull ${name}  (or run \`jarvis repair\`)`);
        }
    }

    // ── speech ──────────────────────────────────────────────────────────────
    console.log('\n  Speech');
    // uv is what the STT/TTS servers actually launch with, so it is the thing
    // that matters. Old system Python is only a problem when uv is absent too;
    // reporting 3.8 as a failure on a machine where uv makes it moot sends
    // someone off to install something they do not need.
    check(d.uv.installed ? 'ok' : 'optional', 'uv', d.uv.version || 'not installed',
        d.uv.installed ? null : 'jarvis repair  (or install from https://astral.sh/uv)');

    if (d.uv.installed) {
        check('ok', 'Python', 'managed by uv (3.12)');
    } else {
        check(d.python.adequate ? 'ok' : 'broken', 'Python',
            d.python.version ? `${d.python.version}${d.python.adequate ? '' : ' — too old'}` : 'not found',
            d.python.adequate ? null
                : 'Voice needs Python 3.10+ or uv. `jarvis repair` installs uv, which is the smaller change.');
    }

    for (const [port, label] of [[8770, 'Speech-to-text'], [8771, 'Text-to-speech']]) {
        const up = await detect.portInUse(port);
        check(up ? 'ok' : 'optional', label, up ? `listening on ${port}` : 'not running',
            up ? null : 'Starts with the app. If it never comes up, run `jarvis --verbose`.');
    }

    check(d.ffmpeg.installed ? 'ok' : 'optional', 'ffmpeg',
        d.ffmpeg.installed ? 'installed' : 'not installed — some audio formats unavailable');

    // ── optional keys ───────────────────────────────────────────────────────
    console.log('\n  Optional services');
    check(process.env.GEMINI_API_KEY ? 'ok' : 'optional', 'GEMINI_API_KEY',
        process.env.GEMINI_API_KEY ? 'set' : 'unset — cloud answers and vision disabled',
        process.env.GEMINI_API_KEY ? null : 'Add GEMINI_API_KEY to .env. The local model works without it.');

    if (process.env.SEARXNG_URL) {
        const up = await reachable(process.env.SEARXNG_URL);
        check(up ? 'ok' : 'broken', 'SearXNG', process.env.SEARXNG_URL,
            up ? null : 'Not reachable — unset SEARXNG_URL to use the public providers instead.');
    } else {
        check('optional', 'SearXNG', 'unset — using public search providers');
    }

    // ── setup record ────────────────────────────────────────────────────────
    const state = await readState();
    console.log('\n  Setup');
    if (state) {
        check(state.version === pkg.version ? 'ok' : 'optional', 'Last run',
            `${state.completedAt}${state.version === pkg.version ? '' : ` (v${state.version})`}`,
            state.version === pkg.version ? null : 'Version changed — `jarvis repair` re-checks against this one.');
    } else {
        check('optional', 'Last run', 'never — setup runs on next launch');
    }

    console.log(broken
        ? `\n  ${broken === 1 ? '1 thing needs' : `${broken} things need`} attention.`
          + ` Everything marked ${NO} is optional.`
          + '\n  `jarvis repair` fixes what can be fixed automatically.\n'
        : `\n  Everything Jarvis needs is present. Items marked ${NO} are optional.\n`);

    return broken ? 1 : 0;
}

async function reachable(url) {
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 1500);
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);
        return response.ok;
    } catch {
        return false;
    }
}
