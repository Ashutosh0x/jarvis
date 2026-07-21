// ---------------------------------------------------------------------------
// On-chain data engine — pure, deterministic blockchain math.
//
// Same rule the quant engine enforces, applied to chain data: the LLM NEVER
// computes an on-chain number. Converting a wei balance to ETH, or a raw token
// amount to a human figure, is exact BigInt/decimal arithmetic — the moment a
// language model "estimates" 1240500000 / 1e6 it will confidently get it wrong.
//
// Every function here is a pure function of its inputs (no network, no clock),
// so each is testable against known values and the same code runs in Node
// (tests) and the renderer. The network calls live in the main process; this
// module only parses and formats what they return.
//
// AIR-GAP: read-only. There is no signing, no key handling, and no transaction
// construction anywhere here — balances and gas in, human strings out.
// ---------------------------------------------------------------------------

// Chain metadata. RPC URLs deliberately live in the main process (electron.js),
// not here, so the network surface stays out of the renderer; a chain is
// referenced across the IPC boundary by its `key`.
export const CHAINS = {
    ethereum: { key: 'ethereum', id: 1, name: 'Ethereum', native: 'ETH', explorer: 'https://etherscan.io' },
    arbitrum: { key: 'arbitrum', id: 42161, name: 'Arbitrum One', native: 'ETH', explorer: 'https://arbiscan.io' },
    base: { key: 'base', id: 8453, name: 'Base', native: 'ETH', explorer: 'https://basescan.org' },
    optimism: { key: 'optimism', id: 10, name: 'Optimism', native: 'ETH', explorer: 'https://optimistic.etherscan.io' },
    polygon: { key: 'polygon', id: 137, name: 'Polygon', native: 'POL', explorer: 'https://polygonscan.com' },
    // Added for Ondo GM tokens (all 440 are deployed on BSC too, verified);
    // keyless publicnode BSC RPC confirmed live before this entry was made.
    bsc: { key: 'bsc', id: 56, name: 'BNB Chain', native: 'BNB', explorer: 'https://bscscan.com' },
};

// Well-known ERC-20s per chain (canonical addresses + decimals). Verified
// mainnet/Arbitrum addresses — decimals matter: USDC/USDT are 6, most are 18.
export const TOKENS = {
    ethereum: {
        USDC: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
        USDT: { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },
        WETH: { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18 },
        DAI: { address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', decimals: 18 },
        WBTC: { address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', decimals: 8 },
    },
    arbitrum: {
        USDC: { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 },
        USDT: { address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6 },
        WETH: { address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', decimals: 18 },
        DAI: { address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', decimals: 18 },
        ARB: { address: '0x912CE59144191C1204E64559FE8253a0e49E6548', decimals: 18 },
    },
    base: {
        USDC: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
        WETH: { address: '0x4200000000000000000000000000000000000006', decimals: 18 },
        DAI: { address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', decimals: 18 },
    },
    optimism: {
        USDC: { address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', decimals: 6 },
        WETH: { address: '0x4200000000000000000000000000000000000006', decimals: 18 },
    },
    polygon: {
        USDC: { address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6 },
        WETH: { address: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', decimals: 18 },
    },
};

/** A 20-byte hex address (not checksum-validated — we only read). */
export function isAddress(s) {
    return typeof s === 'string' && /^0x[0-9a-fA-F]{40}$/.test(s.trim());
}

/** Parse a hex quantity ("0x1a2b" or "1a2b") into a BigInt. Empty/"0x" -> 0n. */
export function hexToBigInt(hex) {
    if (hex == null) return 0n;
    let h = String(hex).trim();
    if (h.startsWith('0x') || h.startsWith('0X')) h = h.slice(2);
    if (h === '') return 0n;
    return BigInt('0x' + h);
}

/**
 * Format a base-unit integer amount as a decimal string with `decimals` places,
 * trimming trailing zeros and capping the fraction at `maxFrac` for readability.
 * Pure BigInt math — no float, so a 78-digit wei value round-trips exactly.
 *   formatUnits(1240500000n, 6) -> "1240.5"
 *   formatUnits(1000000000000000000n, 18) -> "1"
 */
export function formatUnits(value, decimals, maxFrac = 6) {
    const v = typeof value === 'bigint' ? value : hexToBigInt(value);
    const neg = v < 0n;
    const abs = neg ? -v : v;
    const base = 10n ** BigInt(decimals);
    const intPart = (abs / base).toString();
    let frac = (abs % base).toString().padStart(decimals, '0');
    if (maxFrac >= 0) frac = frac.slice(0, maxFrac);
    frac = frac.replace(/0+$/, '');
    const s = frac ? `${intPart}.${frac}` : intPart;
    return neg ? `-${s}` : s;
}

/** wei (hex or BigInt) -> ETH string. */
export function formatEther(wei, maxFrac = 6) {
    return formatUnits(wei, 18, maxFrac);
}

/** wei (hex or BigInt) -> gwei string, the unit gas is quoted in. */
export function formatGwei(wei, maxFrac = 3) {
    return formatUnits(wei, 9, maxFrac);
}

/** Group the integer part with thousands separators for spoken/printed output:
 *  "1240.5" -> "1,240.5". Leaves the fractional part untouched. */
export function groupThousands(decimalStr) {
    const [int, frac] = String(decimalStr).split('.');
    const sign = int.startsWith('-') ? '-' : '';
    const digits = sign ? int.slice(1) : int;
    const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return frac ? `${sign}${grouped}.${frac}` : `${sign}${grouped}`;
}

/** Short 0x1234…abcd form for reading an address aloud or on screen. */
export function shortAddress(addr) {
    if (!isAddress(addr)) return String(addr);
    const a = addr.trim();
    return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

/** ERC-20 balanceOf(address) calldata: selector 0x70a08231 + 32-byte address. */
export function encodeBalanceOf(address) {
    if (!isAddress(address)) throw new Error('bad address');
    return '0x70a08231' + address.trim().toLowerCase().slice(2).padStart(64, '0');
}

// A bare address defaults to Ethereum unless the user names a chain; FurlPay's
// world is Arbitrum-heavy, but the answer always states which chain it read.
export function resolveChain(text, fallback = 'ethereum') {
    const t = String(text || '').toLowerCase();
    if (/\barb(itrum)?\b/.test(t)) return 'arbitrum';
    if (/\bbase\b/.test(t)) return 'base';
    if (/\b(op|optimism)\b/.test(t)) return 'optimism';
    if (/\b(polygon|matic|pol)\b/.test(t)) return 'polygon';
    if (/\b(bsc|bnb|binance)\b/.test(t)) return 'bsc';
    if (/\b(eth(ereum)?|mainnet|l1)\b/.test(t)) return 'ethereum';
    return fallback;
}

/** Find a known token symbol in the text for the given chain. */
export function resolveToken(text, chainKey) {
    const map = TOKENS[chainKey] || {};
    const t = String(text || '').toUpperCase();
    for (const sym of Object.keys(map)) {
        if (new RegExp(`\\b${sym}\\b`).test(t)) return { symbol: sym, ...map[sym] };
    }
    return null;
}

/** Pull the first 0x… address out of free text, if any. */
export function extractAddress(text) {
    const m = String(text || '').match(/0x[0-9a-fA-F]{40}/);
    return m ? m[0] : null;
}

// ---------------------------------------------------------------------------
// ERC standard classification (inspired by SymGPT's sound subset: interface /
// API conformance). All DETERMINISTIC on-chain reads — no LLM. ERC-165's
// supportsInterface tells us NFT standards directly; ERC-20 predates 165, so it
// is probed by its metadata calls (decimals/symbol) succeeding.
// ---------------------------------------------------------------------------

// EIP-165 interface identifiers (the XOR of a standard's function selectors).
export const INTERFACE_IDS = {
    erc165: '0x01ffc9a7',
    erc721: '0x80ac58cd',
    erc721Metadata: '0x5b5e139f',
    erc721Enumerable: '0x780e9d63',
    erc1155: '0xd9b67a26',
    erc1155MetadataURI: '0x0e89341c',
};

// Function selectors (first 4 bytes of keccak256 of the signature).
export const SELECTORS = {
    supportsInterface: '0x01ffc9a7', // supportsInterface(bytes4)
    decimals: '0x313ce567',
    symbol: '0x95d89b41',
    name: '0x06fdde03',
    totalSupply: '0x18160ddd',
};

/** Calldata for supportsInterface(bytes4 id): selector + id left-aligned in a
 *  32-byte word (bytes4 is right-padded per the ABI). */
export function encodeSupportsInterface(interfaceId) {
    const id = String(interfaceId).toLowerCase().replace(/^0x/, '');
    if (id.length !== 8) throw new Error('interfaceId must be 4 bytes');
    return SELECTORS.supportsInterface + id + '0'.repeat(56);
}

/** Decode an ABI bool return (last byte non-zero => true). */
export function decodeBool(hex) {
    return hexToBigInt(hex) !== 0n;
}

/** Decode an ABI/bytes32 string return. Handles both the modern dynamic-string
 *  encoding (offset,len,data) and the legacy bytes32 form (e.g. MKR's symbol).
 *  ASCII-focused — token symbols/names are effectively ASCII. */
export function decodeAbiString(hex) {
    let h = String(hex || '').replace(/^0x/i, '');
    if (!h) return '';
    const hexToAscii = (s) => {
        let out = '';
        for (let i = 0; i + 1 < s.length; i += 2) {
            const c = parseInt(s.slice(i, i + 2), 16);
            if (c >= 32 && c < 127) out += String.fromCharCode(c);
        }
        return out.trim();
    };
    // Legacy bytes32: a single 32-byte word, decode directly.
    if (h.length === 64) return hexToAscii(h);
    // Dynamic string: [offset][length][data...].
    try {
        const offset = Number(hexToBigInt('0x' + h.slice(0, 64))) * 2;
        const len = Number(hexToBigInt('0x' + h.slice(offset, offset + 64))) * 2;
        const data = h.slice(offset + 64, offset + 64 + len);
        return hexToAscii(data);
    } catch {
        return hexToAscii(h);
    }
}

// ---------------------------------------------------------------------------
// Transaction decoding — turn a receipt's raw logs into the token transfers that
// actually happened. DETERMINISTIC: from/to/amount come straight out of the log
// topics/data, never from the LLM. This is the honest core of "who sent what in
// this transaction" — one transaction, ground truth. It is NOT multi-hop
// provenance or entity attribution (those need indexers + proprietary label DBs).
// ---------------------------------------------------------------------------

// keccak256("Transfer(address,address,uint256)") — the ERC-20/721 Transfer topic.
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/** A 32-byte log topic holds a left-padded address in its low 20 bytes. */
export function topicToAddress(topic) {
    const h = String(topic || '').replace(/^0x/i, '');
    if (h.length < 40) return null;
    return '0x' + h.slice(-40);
}

/**
 * Decode one ERC-20 Transfer log into { token, from, to, amount }, or null if
 * the log is not a standard 3-topic Transfer (e.g. an ERC-721 Transfer carries
 * the tokenId as a 4th indexed topic with empty data — reported as amount 0n).
 */
export function decodeTransferLog(log) {
    if (!log || !Array.isArray(log.topics) || !log.topics.length) return null;
    if (String(log.topics[0]).toLowerCase() !== TRANSFER_TOPIC) return null;
    if (log.topics.length < 3) return null; // non-standard / anonymous
    const from = topicToAddress(log.topics[1]);
    const to = topicToAddress(log.topics[2]);
    if (!from || !to) return null;
    // ERC-20: amount is in data. ERC-721: amount lives in topics[3] (tokenId).
    const isNft = log.topics.length >= 4;
    const amount = isNft ? hexToBigInt(log.topics[3]) : hexToBigInt(log.data);
    return { token: (log.address || '').toLowerCase(), from, to, amount, isNft };
}

/** Look up a known token by contract address for a chain (case-insensitive). */
export function resolveTokenByAddress(chainKey, address) {
    const map = TOKENS[chainKey] || {};
    const a = String(address || '').toLowerCase();
    for (const [symbol, t] of Object.entries(map)) {
        if (t.address.toLowerCase() === a) return { symbol, ...t };
    }
    return null;
}

/** Turn raw supportsInterface/metadata results into a plain-language verdict. */
export function classifyContract({ is721, is1155, is721Meta, is1155Meta, decimalsRaw, symbol } = {}) {
    if (is721) {
        const bits = ['ERC-721 (NFT)'];
        if (is721Meta) bits.push('with the Metadata extension');
        return { standard: 'ERC-721', kind: 'NFT', detail: bits.join(' '), symbol: symbol || null };
    }
    if (is1155) {
        const bits = ['ERC-1155 (multi-token)'];
        if (is1155Meta) bits.push('with the Metadata URI extension');
        return { standard: 'ERC-1155', kind: 'multi-token', detail: bits.join(' '), symbol: symbol || null };
    }
    // ERC-20 has no ERC-165; a successful decimals() call is the tell.
    if (decimalsRaw != null && decimalsRaw !== '0x' && decimalsRaw !== '') {
        const d = Number(hexToBigInt(decimalsRaw));
        if (d >= 0 && d <= 36) {
            return { standard: 'ERC-20', kind: 'fungible token', detail: `ERC-20 fungible token, ${d} decimals`, symbol: symbol || null, decimals: d };
        }
    }
    return { standard: null, kind: 'unknown', detail: 'no standard token interface detected (may be a plain contract or EOA)', symbol: symbol || null };
}
