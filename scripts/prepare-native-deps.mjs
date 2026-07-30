#!/usr/bin/env node
/**
 * Stub out platform-gated optional dependencies that npm correctly did not
 * install, so electron-builder's collector can walk the tree.
 *
 * THE PROBLEM, measured rather than assumed. @napi-rs/canvas — reached through
 * pdf-to-img -> pdfjs-dist, and used for PDF OCR — declares 11 platform
 * variants as optionalDependencies. On this machine npm installed exactly 1
 * (canvas-win32-x64-msvc) and skipped 10, which is correct behaviour. But
 * electron-builder's node_modules collector resolves the DECLARED list and
 * scandirs each entry, so packaging dies on the first absent one:
 *
 *   ENOENT: no such file or directory, scandir '.../@napi-rs/canvas-android-arm64'
 *
 * Neither `npmRebuild: false` nor a `files` negation avoids it: the collector
 * resolves the dependency tree before any file filter is applied.
 *
 * THE FIX. Give it empty, valid packages to find. They contain no binary and no
 * code, so nothing ships and no behaviour changes — the collector simply stops
 * tripping over a directory that was never meant to exist on this platform.
 *
 * Written generically over the whole tree rather than hardcoded to canvas, so a
 * future native dependency with the same packaging pattern is handled without
 * anyone having to rediscover this.
 */
import { readdir, readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const modules = join(root, 'node_modules');

const exists = async (p) => access(p).then(() => true, () => false);

/** Every installed package's manifest, including one level of scoping. */
async function* manifests() {
    let top;
    try { top = await readdir(modules, { withFileTypes: true }); } catch { return; }
    for (const entry of top) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('@')) {
            const scoped = await readdir(join(modules, entry.name), { withFileTypes: true })
                .catch(() => []);
            for (const s of scoped) {
                if (s.isDirectory()) yield `${entry.name}/${s.name}`;
            }
        } else {
            yield entry.name;
        }
    }
}

const created = [];
for await (const name of manifests()) {
    let pkg;
    try {
        pkg = JSON.parse(await readFile(join(modules, name, 'package.json'), 'utf-8'));
    } catch { continue; }

    const optional = Object.keys(pkg.optionalDependencies || {});
    if (!optional.length) continue;

    for (const dep of optional) {
        const path = join(modules, dep);
        if (await exists(path)) continue;

        /* Only stub things that look like PLATFORM variants. A genuinely
           missing optional dependency that the app might import at runtime
           must still fail loudly rather than resolve to an empty package. */
        if (!/-(win32|darwin|linux|android|freebsd)(-|$)/.test(dep)) continue;

        await mkdir(path, { recursive: true });
        await writeFile(join(path, 'package.json'), `${JSON.stringify({
            name: dep,
            version: pkg.optionalDependencies[dep].replace(/^[^0-9]*/, '') || '0.0.0',
            description: 'Platform stub created by scripts/prepare-native-deps.mjs. Not installed on this platform.',
        }, null, 2)}\n`, 'utf-8');
        created.push(dep);
    }
}

if (created.length) {
    console.log(`native deps: stubbed ${created.length} absent platform package(s)`);
    for (const c of created) console.log(`  ${c}`);
} else {
    console.log('native deps: nothing to stub');
}
