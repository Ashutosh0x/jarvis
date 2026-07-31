/**
 * Minimal PNG read / resize / write, plus ICO packing.
 *
 * Shared by make-icon.mjs (the 1024px app icon electron-builder derives every
 * platform icon from) and make-favicons.mjs (the browser icon set). Both start
 * from the same artwork, so the decoding lives here rather than twice.
 *
 * Pure Node — zlib is all a PNG needs. Adding an image dependency to resize a
 * handful of squares at build time would cost more than it saves, and this runs
 * on CI runners where fewer native dependencies is the point.
 */
import { deflateSync, inflateSync } from 'node:zlib';

/* ------------------------------------------------------------------ read -- */

export function decodePng(buf) {
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

/**
 * Centre-crop to a square, then bilinear-resample to `size`.
 *
 * Cropping rather than stretching matters: the supplied artwork is 933x931, and
 * a stretch to square would visibly distort a circle.
 */
export function resizeSquare(src, size) {
    const side = Math.min(src.width, src.height);
    const ox = Math.floor((src.width - side) / 2);
    const oy = Math.floor((src.height - side) / 2);

    const out = new Uint8Array(size * size * 4);
    const scale = (side - 1) / (size - 1);

    for (let y = 0; y < size; y++) {
        const sy = oy + y * scale;
        const y0 = Math.floor(sy), y1 = Math.min(y0 + 1, oy + side - 1);
        const fy = sy - y0;
        for (let x = 0; x < size; x++) {
            const sx = ox + x * scale;
            const x0 = Math.floor(sx), x1 = Math.min(x0 + 1, ox + side - 1);
            const fx = sx - x0;
            const i00 = (y0 * src.width + x0) * 4, i10 = (y0 * src.width + x1) * 4;
            const i01 = (y1 * src.width + x0) * 4, i11 = (y1 * src.width + x1) * 4;
            const d = (y * size + x) * 4;
            for (let c = 0; c < 4; c++) {
                const top = src.data[i00 + c] * (1 - fx) + src.data[i10 + c] * fx;
                const bot = src.data[i01 + c] * (1 - fx) + src.data[i11 + c] * fx;
                out[d + c] = Math.round(top * (1 - fy) + bot * fy);
            }
        }
    }
    return out;
}

/* ----------------------------------------------------------------- write -- */

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

export function encodePng(px, size) {
    const raw = Buffer.alloc((size * 4 + 1) * size);
    for (let y = 0; y < size; y++) {
        raw[y * (size * 4 + 1)] = 0;
        Buffer.from(px.buffer, px.byteOffset + y * size * 4, size * 4)
            .copy(raw, y * (size * 4 + 1) + 1);
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
    ihdr.writeUInt32BE(size, 0);
    ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8;      // bit depth
    ihdr[9] = 6;      // colour type RGBA
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

/**
 * Pack PNGs into a multi-size .ico.
 *
 * ICO entries may hold PNG data directly rather than a BMP bitmap — supported
 * everywhere since Vista — so this is a header plus the already-encoded PNGs,
 * with no second image codec to write.
 */
export function encodeIco(images) {
    const header = Buffer.alloc(6);
    header.writeUInt16LE(0, 0);            // reserved
    header.writeUInt16LE(1, 2);            // type: icon
    header.writeUInt16LE(images.length, 4);

    let offset = 6 + images.length * 16;
    const entries = [];
    for (const { size, png } of images) {
        const e = Buffer.alloc(16);
        e[0] = size >= 256 ? 0 : size;     // 0 means 256
        e[1] = size >= 256 ? 0 : size;
        e[2] = 0;                          // palette
        e[3] = 0;                          // reserved
        e.writeUInt16LE(1, 4);             // colour planes
        e.writeUInt16LE(32, 6);            // bits per pixel
        e.writeUInt32BE(0, 8);
        e.writeUInt32LE(png.length, 8);
        e.writeUInt32LE(offset, 12);
        entries.push(e);
        offset += png.length;
    }
    return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}
