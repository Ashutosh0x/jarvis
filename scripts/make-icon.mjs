#!/usr/bin/env node
/**
 * Produce build/icon.png — the single 1024x1024 source electron-builder derives
 * every platform icon from (.ico for Windows, .icns for macOS, PNG set for
 * Linux).
 *
 * Uses `jarvis icon.png` from the repo root when present. Falls back to drawing
 * a wireframe placeholder so a fresh clone still builds something recognisable
 * rather than shipping Electron's default logo, which is what this repo did
 * before it had any icon at all.
 *
 * Why resampling is not optional: the supplied artwork is 933x931. macOS .icns
 * generation needs a SQUARE source at 1024x1024, and a non-square input either
 * fails or produces a stretched icon. The image is centre-cropped rather than
 * stretched, so the sphere stays circular.
 *
 * Browser icons for the marketing site come from the same artwork —
 * see make-favicons.mjs.
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, resizeSquare, encodePng } from './lib/png.mjs';

const SIZE = 1024;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCES = ['jarvis icon.png', 'icon.png', join('build', 'icon.src.png')];

function drawPlaceholder() {
    const px = new Uint8Array(SIZE * SIZE * 4);
    const set = (x, y, r, g, b, a) => {
        if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
        const i = (Math.round(y) * SIZE + Math.round(x)) * 4;
        const sa = a / 255;
        px[i] = Math.round(px[i] * (1 - sa) + r * sa);
        px[i + 1] = Math.round(px[i + 1] * (1 - sa) + g * sa);
        px[i + 2] = Math.round(px[i + 2] * (1 - sa) + b * sa);
        px[i + 3] = Math.max(px[i + 3], a);
    };
    const C = SIZE / 2, R = SIZE * 0.36, radius = SIZE * 0.18;
    for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
            const dx = Math.max(radius - x, 0, x - (SIZE - radius));
            const dy = Math.max(radius - y, 0, y - (SIZE - radius));
            if (Math.hypot(dx, dy) <= radius) set(x, y, 12, 16, 24, 255);
        }
    }
    for (let i = -4; i <= 4; i++) {
        const lat = (i / 5) * (Math.PI / 2);
        const rx = R * Math.cos(lat), ry = R * Math.sin(lat);
        for (let a = 0; a < Math.PI * 2; a += 0.0016) {
            set(C + Math.cos(a) * rx, C + ry * 0.42 + Math.sin(a) * rx * 0.18, 34, 226, 238, 150);
        }
    }
    for (let a = 0; a < Math.PI * 2; a += 0.0008) {
        for (let w = -2.5; w <= 2.5; w += 0.5) {
            set(C + Math.cos(a) * (R + w), C + Math.sin(a) * (R + w), 34, 226, 238, 255);
        }
    }
    return px;
}

const source = SOURCES.map((s) => join(root, s)).find(existsSync);
let pixels;

if (source) {
    const decoded = decodePng(readFileSync(source));
    pixels = resizeSquare(decoded, SIZE);
    const note = decoded.width === decoded.height ? '' : ' (centre-cropped to square)';
    console.log(`icon: ${source.split(/[\\/]/).pop()} ${decoded.width}x${decoded.height} ` +
        `-> ${SIZE}x${SIZE}${note}`);
} else {
    pixels = drawPlaceholder();
    console.log(`icon: no source artwork found, drew placeholder ${SIZE}x${SIZE}`);
    console.log('      drop a square PNG at "jarvis icon.png" to use your own');
}

mkdirSync(join(root, 'build'), { recursive: true });
const png = encodePng(pixels, SIZE);
writeFileSync(join(root, 'build', 'icon.png'), png);
console.log(`      wrote build/icon.png (${(png.length / 1024).toFixed(1)} KB)`);
