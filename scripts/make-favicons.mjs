#!/usr/bin/env node
/**
 * Generate the browser icon set for the marketing site from the same artwork
 * the desktop app uses.
 *
 * The site was shipping the v0.app scaffold's placeholder icons — icon.svg,
 * icon-dark-32x32.png, icon-light-32x32.png and apple-icon.png in
 * webapp/public/ — none of which were referenced by any code, and none of which
 * were the product's icon. layout.tsx declared no `icons` metadata at all, so
 * Next.js fell back to whatever it could find.
 *
 * Output uses the App Router file convention (app/icon.png, app/apple-icon.png,
 * app/favicon.ico), which Next.js serves and injects <link> tags for
 * automatically. That is why no metadata entry is needed: the filenames ARE the
 * declaration, and adding a manual `icons` block on top would duplicate them.
 */
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, resizeSquare, encodePng, encodeIco } from './lib/png.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const appDir = join(root, 'webapp', 'app');
const publicDir = join(root, 'webapp', 'public');

const SOURCES = ['jarvis icon.png', 'icon.png', join('build', 'icon.src.png')];
const source = SOURCES.map((s) => join(root, s)).find(existsSync);
if (!source) {
    console.error('no source artwork found — expected "jarvis icon.png" in the repo root');
    process.exit(1);
}

const src = decodePng(readFileSync(source));
console.log(`favicons: source ${source.split(/[\\/]/).pop()} ${src.width}x${src.height}`);

mkdirSync(appDir, { recursive: true });

/* Next.js App Router picks these up by filename. 512 for icon.png because it
   also feeds PWA installs; 180 is Apple's touch-icon size. */
const png = (size) => Buffer.from(encodePng(resizeSquare(src, size), size));

const outputs = [
    [join(appDir, 'icon.png'), png(512), 'icon.png (512)'],
    [join(appDir, 'apple-icon.png'), png(180), 'apple-icon.png (180)'],
];

/* A .ico with 16/32/48 so Windows taskbar pins and older browsers get a
   sharp icon rather than a downscaled 512. */
const ico = encodeIco([16, 32, 48].map((size) => ({ size, png: png(size) })));
outputs.push([join(appDir, 'favicon.ico'), ico, 'favicon.ico (16/32/48)']);

for (const [path, data, label] of outputs) {
    writeFileSync(path, data);
    console.log(`          wrote webapp/app/${label} — ${(data.length / 1024).toFixed(1)} KB`);
}

/* Remove the scaffold placeholders. They are unreferenced, and leaving them
   beside the real icons is how the wrong one gets picked up later. */
const stale = ['icon.svg', 'icon-dark-32x32.png', 'icon-light-32x32.png', 'apple-icon.png'];
let removed = 0;
for (const name of stale) {
    const path = join(publicDir, name);
    if (existsSync(path)) {
        rmSync(path);
        console.log(`          removed webapp/public/${name} (v0 scaffold placeholder)`);
        removed++;
    }
}
if (!removed) console.log('          no scaffold placeholders left to remove');
