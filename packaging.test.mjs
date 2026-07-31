// Does the packaged build actually contain everything the main process
// requires?
//
// This exists because it did not, and the failure is expensive: the app builds
// green, installs, launches, and dies instantly with
//
//   Error: Cannot find module './googleCalendar.js'
//
// electron-builder's `files` is an explicit ALLOWLIST. Adding a root module to
// electron.js and forgetting the second list produces a build that passes every
// unit test and every typecheck, because nothing in the repo depends on the two
// staying in sync. Only the smoke test catches it, and only after a full
// platform build — eight minutes on Linux CI.
//
// Worse, the crash it produced was misleading. The require sat at line 899 but
// `app.whenReady()` is at line 281, so module evaluation aborted midway and the
// ready callback still fired, hitting a temporal-dead-zone error on a variable
// declared thousands of lines further down:
//
//   ReferenceError: Cannot access 'telemetryInterval' before initialization
//
// which points at telemetry and has nothing to do with the actual fault.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const check = (n, c) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); };

/** Every `require('./x')` in a file, normalised to a root-relative filename. */
function localRequires(file) {
    const src = readFileSync(path.join(root, file), 'utf-8');
    const found = new Set();
    for (const m of src.matchAll(/require\(\s*['"]\.\/([A-Za-z0-9_.-]+)['"]\s*\)/g)) {
        let name = m[1];
        if (!name.endsWith('.js') && !name.endsWith('.json')) name += '.js';
        found.add(name);
    }
    return [...found];
}

/** Filenames listed in electron-builder.yml's `files:` block. */
function packagedFiles() {
    const yml = readFileSync(path.join(root, 'electron-builder.yml'), 'utf-8');
    const start = yml.indexOf('\nfiles:');
    if (start === -1) return null;

    // Ends at the next top-level key.
    const rest = yml.slice(start + 1);
    const end = rest.search(/\n[a-zA-Z][a-zA-Z0-9_]*:/);
    const block = end === -1 ? rest : rest.slice(0, end);

    const entries = new Set();
    for (const line of block.split('\n')) {
        const m = line.match(/^\s+-\s+'?([^'#\s]+)'?/);
        if (m && !m[1].startsWith('!')) entries.add(m[1]);
    }
    return entries;
}

const listed = packagedFiles();
check('electron-builder.yml has a files allowlist', listed !== null && listed.size > 0);

// The main process, plus every root module it pulls in — one of those could
// itself require a sibling that was never packaged.
const seen = new Set();
const queue = ['electron.js'];
const required = new Set();

while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    if (!existsSync(path.join(root, file))) continue;

    for (const dep of localRequires(file)) {
        required.add(dep);
        queue.push(dep);
    }
}

check('found the root modules electron.js requires', required.size >= 10);

// Every one of them must exist on disk AND be in the allowlist.
const missingOnDisk = [];
const missingFromPackage = [];

for (const dep of [...required].sort()) {
    if (!existsSync(path.join(root, dep))) { missingOnDisk.push(dep); continue; }
    if (!listed.has(dep)) missingFromPackage.push(dep);
}

check(`every required module exists on disk${missingOnDisk.length ? ` — MISSING: ${missingOnDisk.join(', ')}` : ''}`,
    missingOnDisk.length === 0);

// The one that would have caught the shipped bug.
check(`every required module is in electron-builder files${missingFromPackage.length ? ` — NOT PACKAGED: ${missingFromPackage.join(', ')}` : ''}`,
    missingFromPackage.length === 0);

// The two that were actually missing, named so a regression is unambiguous.
check('googleCalendar.js is packaged', listed.has('googleCalendar.js'));
check('autostart.js is packaged', listed.has('autostart.js'));

// The entry points, which would fail even more obviously.
check('electron.js is packaged', listed.has('electron.js'));
check('preload.js is packaged', listed.has('preload.js'));

// The renderer bundle. Without it the window loads a blank page.
check('the built renderer is packaged',
    [...listed].some((f) => f.startsWith('dist')));

// npm's own allowlist has the same failure mode: a root module added to
// exports/bin but left out of `files` ships a package that cannot start.
{
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf-8'));
    const npmFiles = new Set(pkg.files || []);
    const npmMissing = [...required].filter((dep) => !npmFiles.has(dep));
    check(`every required module is in package.json files${npmMissing.length ? ` — MISSING: ${npmMissing.join(', ')}` : ''}`,
        npmMissing.length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
