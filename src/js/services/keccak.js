// ---------------------------------------------------------------------------
// keccak-256 (Ethereum's hash — NOT NIST SHA3-256; the domain pad byte is 0x01,
// not 0x06). Pure, dependency-free, operates on bytes. Needed for ENS namehash
// and for deriving/ verifying function selectors on-chain.
//
// Correctness is verified in tests against public vectors AND against selectors
// this codebase already hardcoded (balanceOf -> 0x70a08231, the ERC-20 Transfer
// topic), so a subtle permutation bug cannot slip through.
// ---------------------------------------------------------------------------

const MASK = (1n << 64n) - 1n;
const rotl = (x, n) => { const b = BigInt(n); return ((x << b) | (x >> (64n - b))) & MASK; };

const RC = [
    0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
    0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
    0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
    0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
    0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
    0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
// Rho rotation offsets, indexed by lane i = x + 5*y.
const R = [
    0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39,
    41, 45, 15, 21, 8, 18, 2, 61, 56, 14,
];

function keccakF(s) {
    for (let round = 0; round < 24; round++) {
        // theta
        const C = new Array(5);
        for (let x = 0; x < 5; x++) C[x] = s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20];
        const D = new Array(5);
        for (let x = 0; x < 5; x++) D[x] = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1);
        for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) s[x + 5 * y] ^= D[x];
        // rho + pi
        const B = new Array(25).fill(0n);
        for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) {
            B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(s[x + 5 * y], R[x + 5 * y]);
        }
        // chi
        for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) {
            s[x + 5 * y] = B[x + 5 * y] ^ ((~B[(x + 1) % 5 + 5 * y] & MASK) & B[(x + 2) % 5 + 5 * y]);
        }
        // iota
        s[0] ^= RC[round];
    }
}

/** keccak-256 of a byte array -> 32-byte Uint8Array. */
export function keccak256(bytes) {
    const rate = 136; // bytes (1088-bit rate, 512-bit capacity)
    const input = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
    // pad10*1 with Keccak domain byte 0x01.
    const padLen = rate - (input.length % rate);
    const padded = new Uint8Array(input.length + padLen);
    padded.set(input);
    padded[input.length] ^= 0x01;
    padded[padded.length - 1] ^= 0x80;

    const s = new Array(25).fill(0n);
    for (let off = 0; off < padded.length; off += rate) {
        for (let i = 0; i < rate / 8; i++) {
            let lane = 0n;
            for (let j = 7; j >= 0; j--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + j]);
            s[i] ^= lane;
        }
        keccakF(s);
    }
    const out = new Uint8Array(32);
    for (let i = 0; i < 4; i++) {
        let lane = s[i];
        for (let j = 0; j < 8; j++) { out[i * 8 + j] = Number(lane & 0xffn); lane >>= 8n; }
    }
    return out;
}

export function bytesToHex(bytes) {
    let h = '';
    for (const b of bytes) h += b.toString(16).padStart(2, '0');
    return h;
}

export function hexToBytes(hex) {
    const h = String(hex).replace(/^0x/i, '');
    const out = new Uint8Array(h.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
    return out;
}

export function utf8ToBytes(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    // Node fallback.
    return Uint8Array.from(Buffer.from(str, 'utf8'));
}

/** keccak-256 of a UTF-8 string -> 0x hex. */
export function keccak256Utf8(str) {
    return '0x' + bytesToHex(keccak256(utf8ToBytes(str)));
}

/** 4-byte function selector for a signature, e.g. "balanceOf(address)". */
export function selector(signature) {
    return '0x' + bytesToHex(keccak256(utf8ToBytes(signature))).slice(0, 8);
}
