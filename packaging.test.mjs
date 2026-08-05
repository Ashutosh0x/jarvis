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

import { readFileSync, existsSync, readdirSync } from 'node:fs';
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

// The main process also reaches into DIRECTORIES — `require('./setup/path.js')`
// for the terminal-command installer. `localRequires` cannot see those: its
// character class excludes '/', so a module in a subdirectory silently escapes
// every check above. That is the googleCalendar.js bug again, one directory
// over, and it would crash the packaged app on launch in exactly the same way.
{
    const src = readFileSync(path.join(root, 'electron.js'), 'utf-8');
    const dirs = new Set();
    for (const m of src.matchAll(/require\(\s*['"]\.\/([A-Za-z0-9_.-]+)\/[^'"]+['"]\s*\)/g)) {
        dirs.add(`${m[1]}/`);
    }

    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf-8'));
    const npmFiles = new Set(pkg.files || []);

    const notPackaged = [...dirs].filter((d) => !listed.has(d) && !listed.has(d.replace(/\/$/, '')));
    check(`every directory electron.js requires is in electron-builder files${notPackaged.length ? ` — MISSING: ${notPackaged.join(', ')}` : ''}`,
        notPackaged.length === 0);

    const notNpm = [...dirs].filter((d) => !npmFiles.has(d));
    check(`every directory electron.js requires is in package.json files${notNpm.length ? ` — MISSING: ${notNpm.join(', ')}` : ''}`,
        notNpm.length === 0);

    const missing = [...src.matchAll(/require\(\s*['"](\.\/[A-Za-z0-9_.-]+\/[^'"]+)['"]\s*\)/g)]
        .map((m) => m[1])
        .filter((rel) => !existsSync(path.join(root, rel)));
    check(`every directory module electron.js requires exists${missing.length ? ` — MISSING: ${missing.join(', ')}` : ''}`,
        missing.length === 0);
}

// ── data directories, which no dependency walk can see ──────────────────────
//
// `companiesMarketCap.js` reads `data/companies-ranking.json` with
// `fs.readFileSync(path.join(__dirname, 'data', ...))`. That is not a require,
// so every check above is blind to it — and both allowlists were in fact
// missing `data/` when the companies layer landed.
//
// The failure is the quiet kind rather than the loud one that motivated this
// file. Nothing crashes: `localRanking` finds no file, correctly reports
// `available: false, reason: 'not-crawled'`, and the globe falls back to the
// hand-transcribed list. A packaged build would ship 11,222 companies' worth of
// resolved head offices as 60 names, and look like it was working.
{
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf-8'));
    const npmFiles = new Set(pkg.files || []);

    // Every `path.join(__dirname, 'x', ...)` in a root module, where x is a
    // directory of pure data.
    //
    // The "pure data" filter — every entry is a .json file — is what keeps this
    // check from firing on `build/`, `static/`, `bin/`, `companion/`,
    // `resources/` and `dist/`. Those are all joined the same way and all reach
    // the build by a different route: a glob, `extraResources`, or Vite folding
    // them into the bundle. A rule that flagged them would be noise, and noise
    // is how a check stops being read.
    const isDataDir = (dir) => {
        const entries = readdirSync(path.join(root, dir), { withFileTypes: true });
        return entries.length > 0 && entries.every((e) => e.isFile() && e.name.endsWith('.json'));
    };

    const dataDirs = new Set();
    for (const file of readdirSync(root).filter((f) => f.endsWith('.js'))) {
        const src = readFileSync(path.join(root, file), 'utf-8');
        for (const m of src.matchAll(/path\.join\(\s*__dirname\s*,\s*['"]([A-Za-z0-9_.-]+)['"]\s*,/g)) {
            if (!existsSync(path.join(root, m[1]))) continue;
            if (!isDataDir(m[1])) continue;
            dataDirs.add(`${m[1]}/`);
        }
    }

    check(`root modules read from data directories (${[...dataDirs].join(', ') || 'none'})`,
        dataDirs.size > 0);

    const notNpm = [...dataDirs].filter((d) => !npmFiles.has(d));
    check(`every data directory is in package.json files${notNpm.length ? ` — MISSING: ${notNpm.join(', ')}` : ''}`,
        notNpm.length === 0);

    const notBuilder = [...dataDirs].filter((d) => !listed.has(d) && !listed.has(d.replace(/\/$/, '')));
    check(`every data directory is in electron-builder files${notBuilder.length ? ` — MISSING: ${notBuilder.join(', ')}` : ''}`,
        notBuilder.length === 0);

    // Named, because this is the one that would have shipped.
    check('the crawled company ranking exists',
        existsSync(path.join(root, 'data', 'companies-ranking.json')));
    check('the resolved head offices exist',
        existsSync(path.join(root, 'data', 'companies-hq.json')));
}

// npm's own allowlist has the same failure mode: a root module added to
// exports/bin but left out of `files` ships a package that cannot start.
{
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf-8'));
    const npmFiles = new Set(pkg.files || []);
    const npmMissing = [...required].filter((dep) => !npmFiles.has(dep));
    check(`every required module is in package.json files${npmMissing.length ? ` — MISSING: ${npmMissing.join(', ')}` : ''}`,
        npmMissing.length === 0);
}

// ── the CLI, which has its own dependency tree ──────────────────────────────
//
// The checks above only walk flat `require('./x')` from electron.js. The
// launcher reaches into a DIRECTORY (`../setup/`), which that regex cannot see
// and neither allowlist covered — the same allowlist bug as googleCalendar.js,
// one directory over. `jarvis doctor` on a freshly installed package would
// have thrown `Cannot find module '../setup/bootstrap.js'`.
{
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf-8'));
    const npmFiles = new Set(pkg.files || []);

    const binEntry = (pkg.bin && pkg.bin.jarvis) || 'bin/jarvis.mjs';
    check('the CLI entry point exists', existsSync(path.join(root, binEntry)));
    check('the CLI entry point is packaged for npm',
        [...npmFiles].some((f) => binEntry.startsWith(f.replace(/\/$/, ''))));

    const cliSrc = readFileSync(path.join(root, binEntry), 'utf-8');

    // Both forms — `require_('../setup/x.js')` and a static import.
    const dirDeps = new Set();
    for (const m of cliSrc.matchAll(/(?:require_?\(|from\s+)\s*['"]\.\.\/([A-Za-z0-9_.-]+)\//g)) {
        dirDeps.add(`${m[1]}/`);
    }

    check(`the CLI's directory dependencies were found (${[...dirDeps].join(', ') || 'none'})`,
        dirDeps.size > 0);

    const notNpm = [...dirDeps].filter((d) => !npmFiles.has(d));
    check(`every CLI directory dependency is in package.json files${notNpm.length ? ` — MISSING: ${notNpm.join(', ')}` : ''}`,
        notNpm.length === 0);

    const notBuilder = [...dirDeps].filter((d) => !listed.has(d) && !listed.has(d.replace(/\/$/, '')));
    check(`every CLI directory dependency is in electron-builder files${notBuilder.length ? ` — MISSING: ${notBuilder.join(', ')}` : ''}`,
        notBuilder.length === 0);

    // And the modules inside those directories must resolve each other.
    const unresolved = [];
    for (const dir of dirDeps) {
        const dirPath = path.join(root, dir);
        if (!existsSync(dirPath)) { unresolved.push(`${dir} (directory missing)`); continue; }
        for (const file of readdirSync(dirPath).filter((f) => f.endsWith('.js'))) {
            const src = readFileSync(path.join(dirPath, file), 'utf-8');
            for (const m of src.matchAll(/require\(\s*['"](\.\/[A-Za-z0-9_.-]+)['"]\s*\)/g)) {
                if (!existsSync(path.join(dirPath, m[1]))) unresolved.push(`${dir}${file} -> ${m[1]}`);
            }
        }
    }
    check(`modules inside those directories resolve${unresolved.length ? ` — BROKEN: ${unresolved.join(', ')}` : ''}`,
        unresolved.length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
