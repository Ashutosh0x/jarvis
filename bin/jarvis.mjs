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
    jarvis                 Launch the app
    jarvis doctor          Check the environment and report what is missing
    jarvis --version       Print the version
    jarvis --help          Show this

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

if (args[0] === 'doctor') {
    await doctor();
    process.exit(0);
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

/**
 * Reports what is present and what is not, without pretending a missing
 * optional dependency is a failure. Jarvis is designed to degrade — a machine
 * with no Ollama and no API key still runs, it just answers from fewer places.
 */
async function doctor() {
    const check = (label, ok, detail = '') =>
        console.log(`  ${ok ? '✓' : '·'} ${label.padEnd(22)} ${detail}`);

    console.log(`\n  Jarvis ${pkg.version}\n`);

    console.log('  Runtime');
    check('Node', true, process.version);
    check('Platform', true, `${process.platform} ${process.arch}`);

    let electronPath = null;
    try { electronPath = (await import('electron')).default; } catch { /* reported below */ }
    check('Electron', Boolean(electronPath && existsSync(electronPath)),
        electronPath && existsSync(electronPath) ? 'installed' : 'missing — npm rebuild electron');
    check('Interface built', existsSync(join(root, 'dist', 'index.html')));

    console.log('\n  Optional services');
    check('GEMINI_API_KEY', Boolean(process.env.GEMINI_API_KEY),
        process.env.GEMINI_API_KEY ? 'set' : 'unset — conversational answers disabled');

    const ollama = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
    const ollamaUp = await reachable(`${ollama}/api/tags`);
    check('Ollama', ollamaUp, ollamaUp ? ollama : `${ollama} — not reachable, local model disabled`);

    if (process.env.SEARXNG_URL) {
        check('SearXNG', await reachable(process.env.SEARXNG_URL), process.env.SEARXNG_URL);
    } else {
        check('SearXNG', false, 'unset — using public search providers');
    }

    console.log('\n  Web search runs with no key at all. Everything marked · is');
    console.log('  optional; Jarvis degrades rather than failing.\n');
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
