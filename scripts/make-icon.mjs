#!/usr/bin/env node
/**
 * Produce build/icon.png — the single 1024x1024 source electron-builder derives
 * every platform icon from (.ico for Windows, .icns for macOS, PNG set for
 * Linux).
 *
 * Prefers real artwork. `jarvis icon.png` in the repo root is used when present
 * and resampled to exactly 1024x1024; otherwise a wireframe placeholder is
 * drawn so a fresh clone still builds rather than shipping Electron's default
 * logo, which is what this repo did before it had any icon at all.
 *
 * Why resampling is not optional: the supplied artwork is 933x931. macOS .icns
 * generation requires a SQUARE source and wants 1024x1024; a non-square input
 * either fails outright or produces a stretched icon. Padding would letterbox
 * it, so it is scaled with bilinear filtering and any residual aspect
 * difference is absorbed by a centred crop of at most a few pixels.
 *
 * Pure Node — zlib is enough to read and write PNG. Adding an image dependency
 * for one square would cost more than it saves.
 */
import { deflateSync, inflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 1024;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCES = ['jarvis icon.png', 'icon.png', join('build', 'icon.src.png')];

/* ------------------------------------------------------------ PNG decode -- */

function decodePng(buf) {
    if (buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
        throw new Error('not a PNG');
    }
    let pos = 8;
    let width = 0, height = 0, depth = 0, colour = 0, interlace = 0;
    const idat = [];

    while (pos < buf.length) {
        const len = buf.readUInt32BE(pos);
        const type = buf.subarray(pos + 4, pos + 8).toString('ascii');
        const data = buf.subarray(pos + 8, pos + 8 + len);
        if (type === 'IHDR') {
            width = data.readUInt32BE(0);
            height = data.readUInt32BE(4);
            depth = data[8];
            colour = data[9];
            interlace = data[12];
        } else if (type === 'IDAT') {
            idat.push(data);
        } else if (type === 'IEND') break;
        pos += 12 + len;
    }

    if (depth !== 8) throw new Error(`unsupported bit depth ${depth} (need 8)`);
    if (interlace !== 0) throw new Error('interlaced PNG is not supported');
    const channels = colour === 6 ? 4 : colour === 2 ? 3 : 0;
    if (!channels) throw new Error(`unsupported colour type ${colour} (need 2 or 6)`);

    const raw = inflateSync(Buffer.concat(idat));
    const stride = width * channels;
    const out = Buffer.alloc(width * height * 4);
    let prev = Buffer.alloc(stride);

    for (let y = 0; y < height; y++) {
        const filter = raw[y * (stride + 1)];
        const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride));

        // Reverse the per-scanline filter (PNG spec 9.2).
        for (let i = 0; i < stride; i++) {
            const a = i >= channels ? line[i - channels] : 0;   // left
            const b = prev[i];                                   // up
            const c = i >= channels ? prev[i - channels] : 0;    // up-left
            switch (filter) {
                case 1: line[i] = (line[i] + a) & 0xff; break;
                case 2: line[i] = (line[i] + b) & 0xff; break;
                case 3: line[i] = (line[i] + ((a + b) >> 1)) & 0xff; break;
                case 4: {
                    const p = a + b - c;
                    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
                    line[i] = (line[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
                    break;
                }
                default: break;                                  // 0 = None
            }
        }
        prev = line;

        for (let x = 0; x < width; x++) {
            const s = x * channels, d = (y * width + x) * 4;
            out[d] = line[s];
            out[d + 1] = line[s + 1];
            out[d + 2] = line[s + 2];
            out[d + 3] = channels === 4 ? line[s + 3] : 255;
        }
    }
    return { width, height, data: out };
}

/* ---------------------------------------------------------------- resize -- */

/** Bilinear resample of a square-cropped region to SIZE x SIZE. */
function resizeSquare(src) {
    // Centre-crop to a square first, so a 933x931 source is not stretched.
    const side = Math.min(src.width, src.height);
    const ox = Math.floor((src.width - side) / 2);
    const oy = Math.floor((src.height - side) / 2);

    const out = new Uint8Array(SIZE * SIZE * 4);
    const scale = (side - 1) / (SIZE - 1);

    for (let y = 0; y < SIZE; y++) {
        const sy = oy + y * scale;
        const y0 = Math.floor(sy), y1 = Math.min(y0 + 1, oy + side - 1);
        const fy = sy - y0;
        for (let x = 0; x < SIZE; x++) {
            const sx = ox + x * scale;
            const x0 = Math.floor(sx), x1 = Math.min(x0 + 1, ox + side - 1);
            const fx = sx - x0;
            const i00 = (y0 * src.width + x0) * 4, i10 = (y0 * src.width + x1) * 4;
            const i01 = (y1 * src.width + x0) * 4, i11 = (y1 * src.width + x1) * 4;
            const d = (y * SIZE + x) * 4;
            for (let c = 0; c < 4; c++) {
                const top = src.data[i00 + c] * (1 - fx) + src.data[i10 + c] * fx;
                const bot = src.data[i01 + c] * (1 - fx) + src.data[i11 + c] * fx;
                out[d + c] = Math.round(top * (1 - fy) + bot * fy);
            }
        }
    }
    return out;
}

/* -------------------------------------------------------------- fallback -- */

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

/* ------------------------------------------------------------ PNG encode -- */

let table = null;
function crc32(buf) {
    if (!table) {
        table = new Int32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            table[n] = c;
        }
    }
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return c ^ -1;
}

function encodePng(px) {
    const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
    for (let y = 0; y < SIZE; y++) {
        raw[y * (SIZE * 4 + 1)] = 0;
        Buffer.from(px.buffer, px.byteOffset + y * SIZE * 4, SIZE * 4)
            .copy(raw, y * (SIZE * 4 + 1) + 1);
    }
    const chunk = (type, data) => {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(data.length);
        const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(crc32(body) >>> 0);
        return Buffer.concat([len, body, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(SIZE, 0);
    ihdr.writeUInt32BE(SIZE, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

/* ------------------------------------------------------------------ main -- */

const source = SOURCES.map((s) => join(root, s)).find(existsSync);
let pixels;

if (source) {
    const decoded = decodePng(readFileSync(source));
    pixels = resizeSquare(decoded);
    const note = decoded.width === decoded.height ? '' : ' (centre-cropped to square)';
    console.log(`icon: ${source.replace(root + '\\', '').replace(root + '/', '')} ` +
        `${decoded.width}x${decoded.height} -> ${SIZE}x${SIZE}${note}`);
} else {
    pixels = drawPlaceholder();
    console.log(`icon: no source artwork found, drew placeholder ${SIZE}x${SIZE}`);
    console.log(`      drop a square PNG at "jarvis icon.png" to use your own`);
}

mkdirSync(join(root, 'build'), { recursive: true });
const png = encodePng(pixels);
writeFileSync(join(root, 'build', 'icon.png'), png);
console.log(`      wrote build/icon.png (${(png.length / 1024).toFixed(1)} KB)`);
