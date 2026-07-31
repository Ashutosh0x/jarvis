#!/usr/bin/env node
/**
 * SHA256SUMS for everything in release/, plus verification of what it wrote.
 *
 * Two modes:
 *   node scripts/checksums.mjs            generate release/SHA256SUMS
 *   node scripts/checksums.mjs --verify   re-hash and compare, exit 1 on drift
 *
 * The verify mode is the point. A checksum file generated and never checked
 * proves nothing — it only says the build produced bytes, not that the bytes
 * published are the bytes built. CI runs both.
 *
 * Output format is `sha256sum -c` compatible, so a user can verify a download
 * with the tool already on their machine rather than trusting a web page.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, writeFile, readFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const releaseDir = join(root, 'release');
const sumsPath = join(releaseDir, 'SHA256SUMS');

/* Only real distributables. The directory also holds unpacked build trees and
   builder-effective-config.yaml, which are not artifacts and whose presence
   varies by platform — hashing them would make the file unstable. */
const ARTIFACT = /\.(exe|dmg|zip|AppImage|deb|rpm|tar\.gz|blockmap|yml)$/;
/* latest*.yml IS an artifact — electron-updater fetches it — but the two
   builder-* files are debug output whose presence and contents vary per run.
   Hashing those would make SHA256SUMS unstable between identical builds. */
const EXCLUDE = /^(SHA256SUMS|builder-debug\.yml|builder-effective-config\.yaml)/;

async function hash(path) {
    return new Promise((resolve, reject) => {
        const h = createHash('sha256');
        createReadStream(path)
            .on('data', (d) => h.update(d))
            .on('end', () => resolve(h.digest('hex')))
            .on('error', reject);
    });
}

async function artifacts() {
    let names;
    try {
        names = await readdir(releaseDir);
    } catch {
        console.error(`no release/ directory — run a build first`);
        process.exit(1);
    }
    const out = [];
    for (const name of names.sort()) {
        if (EXCLUDE.test(name) || !ARTIFACT.test(name)) continue;
        const full = join(releaseDir, name);
        if (!(await stat(full)).isFile()) continue;
        out.push(name);
    }
    return out;
}

const verify = process.argv.includes('--verify');
const names = await artifacts();

if (!names.length) {
    console.error('no artifacts found in release/ — did the build produce anything?');
    process.exit(1);
}

if (!verify) {
    const lines = [];
    for (const name of names) {
        const sum = await hash(join(releaseDir, name));
        const size = (await stat(join(releaseDir, name))).size;
        lines.push(`${sum}  ${name}`);
        console.log(`${sum.slice(0, 16)}…  ${(size / 1048576).toFixed(1).padStart(7)} MB  ${name}`);
    }
    await writeFile(sumsPath, `${lines.join('\n')}\n`, 'utf-8');
    console.log(`\nwrote release/SHA256SUMS (${lines.length} artifacts)`);
    process.exit(0);
}

/* ---- verify ---- */
let expected;
try {
    expected = new Map((await readFile(sumsPath, 'utf-8'))
        .split('\n').filter(Boolean)
        .map((l) => {
            const [sum, ...rest] = l.split(/\s+/);
            return [rest.join(' ').trim(), sum];
        }));
} catch {
    console.error('release/SHA256SUMS is missing — generate it before verifying');
    process.exit(1);
}

let failed = 0;
for (const name of names) {
    const want = expected.get(name);
    if (!want) {
        console.error(`FAIL  ${name}: present on disk but absent from SHA256SUMS`);
        failed++;
        continue;
    }
    const got = await hash(join(releaseDir, name));
    if (got !== want) {
        console.error(`FAIL  ${name}\n      expected ${want}\n      actual   ${got}`);
        failed++;
    } else {
        console.log(`OK    ${name}`);
    }
}
for (const name of expected.keys()) {
    if (!names.includes(name)) {
        console.error(`FAIL  ${name}: listed in SHA256SUMS but not on disk`);
        failed++;
    }
}

console.log(`\n${names.length - failed} verified, ${failed} failed`);
process.exit(failed ? 1 : 0);
