// ---------------------------------------------------------------------------
// Provider response parsing — Alchemy Portfolio/Prices, Helius DAS/Enhanced.
//
// Same contract as onchain.js and quant.js: the LLM never computes an on-chain
// number. Everything here is a pure function of a provider payload, so the
// arithmetic is exact BigInt work and every shape is testable against real
// captured responses rather than a guess at what the API returns.
//
// The shapes below were read off the live APIs on 21 Jul 2026, not off the
// docs — the published reference pages omit the response bodies entirely, and
// two details only showed up in real payloads:
//   1. A native balance arrives with `tokenAddress: null` AND a fully null
//      metadata block, so its decimals must come from the chain (18 on every
//      EVM chain here), not from the response.
//   2. Prices come back with `currency: "usd"` lowercase, not "USD" as the
//      quickstart shows. Matching case-sensitively silently drops every price.
// ---------------------------------------------------------------------------

import { hexToBigInt, formatUnits, groupThousands } from './onchain.js';

/** EVM native currencies are 18-decimal by protocol; this is not a lookup. */
const NATIVE_DECIMALS = 18;

/** Read a USD price out of a provider `prices` array, case-insensitively. */
export function usdPrice(prices) {
    if (!Array.isArray(prices)) return null;
    const hit = prices.find(p => String(p?.currency || '').toLowerCase() === 'usd');
    if (!hit) return null;
    const v = Number(hit.value);
    return Number.isFinite(v) ? v : null;
}

/**
 * Exact balance -> decimal string, then to a Number ONLY for pricing.
 * The BigInt string is kept alongside so display never depends on the float.
 */
function balanceOf(hexOrDec, decimals) {
    let raw;
    try {
        raw = typeof hexOrDec === 'string' && hexOrDec.startsWith('0x')
            ? hexToBigInt(hexOrDec)
            : BigInt(String(hexOrDec ?? '0'));
    } catch { return null; }
    const exact = formatUnits(raw, decimals, 8);
    return { raw, exact, approx: Number(exact) };
}

/**
 * Normalise Alchemy's tokens-by-address payload into holdings.
 *
 * @param {object} payload  raw response
 * @param {Record<string,{native?: string}>} chainMeta  keyed by Alchemy network slug
 * @returns {Array<{network, symbol, name, tokenAddress, isNative, exact, approx, priceUsd, valueUsd}>}
 */
export function parseTokenHoldings(payload, chainMeta = {}) {
    const tokens = payload?.data?.tokens;
    if (!Array.isArray(tokens)) return [];

    const out = [];
    for (const t of tokens) {
        const isNative = t?.tokenAddress == null;
        const meta = t?.tokenMetadata || {};
        // Native rows carry no metadata at all — see header note 1.
        const decimals = Number.isFinite(Number(meta.decimals)) && meta.decimals !== null
            ? Number(meta.decimals)
            : (isNative ? NATIVE_DECIMALS : null);
        // A token whose decimals nobody knows cannot be converted correctly, and
        // a wrong balance spoken confidently is worse than an omitted one.
        if (decimals === null) continue;

        const bal = balanceOf(t?.tokenBalance, decimals);
        if (!bal) continue;
        if (bal.raw === 0n) continue; // dust-free: zero balances are noise

        const priceUsd = usdPrice(t?.tokenPrices);
        const symbol = meta.symbol || (isNative ? (chainMeta[t?.network]?.native || 'native') : null);

        out.push({
            network: t?.network || null,
            // The caller's own name for the chain, when it supplied one. Native
            // holdings on several chains are all "ETH", so a spoken list is
            // ambiguous without it.
            chain: chainMeta[t?.network]?.chain || null,
            symbol,
            name: meta.name || null,
            tokenAddress: t?.tokenAddress || null,
            isNative,
            exact: bal.exact,
            approx: bal.approx,
            priceUsd,
            valueUsd: priceUsd != null ? bal.approx * priceUsd : null,
        });
    }
    return out;
}

/** Total USD across holdings, plus how much of it is actually priced. */
export function portfolioTotal(holdings) {
    let total = 0, priced = 0, unpriced = 0;
    for (const h of holdings) {
        if (h.valueUsd != null) { total += h.valueUsd; priced++; } else { unpriced++; }
    }
    return { totalUsd: total, priced, unpriced };
}

/** Money, spoken. Two decimals under $1000, none above — nobody says cents on $12,000. */
export function formatUsd(n) {
    if (n == null || !Number.isFinite(n)) return 'unknown';
    const abs = Math.abs(n);
    if (abs >= 1000) return '$' + groupThousands(String(Math.round(n)));
    if (abs >= 1) return '$' + n.toFixed(2);
    if (abs === 0) return '$0';
    return '$' + n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * A spoken portfolio summary: biggest positions first, capped, with the tail
 * summarised rather than enumerated. Answers are read aloud — a 40-token list
 * is unusable as speech.
 */
export function describePortfolio(holdings, { limit = 5 } = {}) {
    if (!holdings.length) return 'That wallet holds no tokens with a non-zero balance on the networks I checked, Sir.';

    const { totalUsd, priced, unpriced } = portfolioTotal(holdings);
    // Priced positions sort by value; unpriced ones cannot be ranked and go last.
    const ranked = holdings.slice().sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1));
    const top = ranked.slice(0, limit);

    const parts = top.map(h => {
        const amount = groupThousands(h.exact.replace(/\.?0+$/, '') || '0');
        const sym = h.symbol || 'an unnamed token';
        const worth = h.valueUsd != null ? ` worth ${formatUsd(h.valueUsd)}` : '';
        // Native balances repeat the same symbol across chains; name the chain
        // so "6.6 ETH" and "0.16 ETH" are distinguishable when spoken.
        const where = h.isNative && h.chain ? ` on ${h.chain}` : '';
        return `${amount} ${sym}${where}${worth}`;
    });

    let line = priced
        ? `That wallet holds about ${formatUsd(totalUsd)} across ${holdings.length} position${holdings.length === 1 ? '' : 's'}. `
        : `That wallet holds ${holdings.length} position${holdings.length === 1 ? '' : 's'}, none of which I have a price for. `;
    line += `Largest: ${parts.join(', ')}.`;
    if (ranked.length > top.length) line += ` Plus ${ranked.length - top.length} smaller position${ranked.length - top.length === 1 ? '' : 's'}.`;
    if (unpriced) line += ` ${unpriced} had no price feed, so ${unpriced === 1 ? 'it is' : 'they are'} excluded from the total.`;
    return line;
}

/* --- Time -------------------------------------------------------------------
   Alerts without a time are hard to act on: "2.98 million USDC moved" reads the
   same whether it happened twelve seconds ago or was recovered from a block
   missed during a twenty-minute outage. Both forms are given — relative for
   speech, because nobody converts a clock time in their head mid-sentence, and
   absolute for the screen, because that is what you correlate against an
   explorer or a log. */

/**
 * "just now" / "3 minutes ago" / "2 hours ago". Deliberately coarse: block
 * timestamps have second resolution and a spoken alert does not benefit from
 * more precision than the listener can use.
 * @param {number} ts   milliseconds
 * @param {number} [now]
 */
export function timeAgo(ts, now = Date.now()) {
    if (!Number.isFinite(ts) || ts <= 0) return null;
    const secs = Math.round((now - ts) / 1000);
    // A block timestamp can sit a second or two in the future relative to this
    // clock; that is clock skew, not a time traveller, so it reads as "just now".
    if (secs < 0) return 'just now';
    if (secs < 20) return 'just now';
    // Switch to minutes at 60, not 90: "60 seconds ago" is not how anyone says
    // it out loud, and these lines are spoken.
    if (secs < 60) return `${secs} seconds ago`;
    const mins = Math.round(secs / 60);
    if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
    const days = Math.round(hours / 24);
    return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** Wall-clock time for the screen: 20:14:32. */
export function clockTime(ts) {
    if (!Number.isFinite(ts) || ts <= 0) return null;
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/* --- Prices ---------------------------------------------------------------- */

/** parse by-symbol / by-address price payloads into a symbol -> price map. */
export function parsePrices(payload) {
    const rows = payload?.data;
    if (!Array.isArray(rows)) return {};
    const out = {};
    for (const r of rows) {
        const key = r?.symbol || r?.address;
        if (!key) continue;
        const p = usdPrice(r?.prices);
        // An entry can carry an `error` instead of a price; recording null keeps
        // "I asked and there is no price" distinct from "I never asked".
        out[key] = p != null ? { usd: p, at: r?.prices?.[0]?.lastUpdatedAt || null } : null;
    }
    return out;
}

export function describePrices(priceMap) {
    const entries = Object.entries(priceMap);
    if (!entries.length) return 'I got no price data back, Sir.';
    const known = entries.filter(([, v]) => v);
    const missing = entries.filter(([, v]) => !v).map(([k]) => k);
    let line = known.map(([sym, v]) => `${sym} is ${formatUsd(v.usd)}`).join(', ');
    if (!known.length) line = `I have no price for ${missing.join(' or ')}`;
    else if (missing.length) line += `. I have no price for ${missing.join(' or ')}`;
    return line + ', Sir.';
}

/* --- Helius: Solana ---------------------------------------------------------
   The Enhanced Transactions API returns a `description` that is already a
   human sentence ("X transferred 0.0001 SOL to Y"). That is measured provider
   output, not model output, so it can be spoken as-is — which is exactly the
   kind of grounded fact the assistant is otherwise forbidden to invent. */

export function parseSolanaActivity(payload, { limit = 5 } = {}) {
    if (!Array.isArray(payload)) return [];
    return payload.slice(0, limit).map(tx => ({
        signature: tx?.signature || null,
        type: tx?.type || 'UNKNOWN',
        source: tx?.source || null,
        description: (tx?.description || '').trim() || null,
        feeSol: Number.isFinite(Number(tx?.fee)) ? Number(tx.fee) / 1e9 : null,
        timestamp: Number.isFinite(Number(tx?.timestamp)) ? Number(tx.timestamp) * 1000 : null,
    }));
}

export function describeSolanaActivity(items) {
    if (!items.length) return 'I found no recent transactions for that Solana address, Sir.';
    const withText = items.filter(i => i.description);
    if (!withText.length) {
        const kinds = [...new Set(items.map(i => i.type))].join(', ');
        return `I found ${items.length} recent transactions, Sir, of type ${kinds}, but none came with a readable description.`;
    }
    const ago = (ts) => {
        if (!ts) return '';
        const mins = Math.round((Date.now() - ts) / 60000);
        if (mins < 1) return ' just now';
        if (mins < 60) return ` ${mins} minute${mins === 1 ? '' : 's'} ago`;
        const h = Math.round(mins / 60);
        if (h < 24) return ` ${h} hour${h === 1 ? '' : 's'} ago`;
        return ` ${Math.round(h / 24)} day${Math.round(h / 24) === 1 ? '' : 's'} ago`;
    };
    const lines = withText.slice(0, 3).map(i => `${i.description}${ago(i.timestamp)}`);
    return `Most recent activity, Sir: ${lines.join('. ')}.`;
}

/**
 * DAS getAssetsByOwner -> a compact asset list.
 *
 * `showNativeBalance` adds a `nativeBalance` block that is NOT in `items` — the
 * SOL balance, which is the one number a wallet question usually means. It is
 * reported in lamports (1e9 per SOL) alongside the provider's own SOL price.
 */
export function parseSolanaAssets(payload, { limit = 10 } = {}) {
    const nb = payload?.result?.nativeBalance;
    const nativeSol = Number.isFinite(Number(nb?.lamports))
        ? {
            sol: Number(nb.lamports) / 1e9,
            priceUsd: Number.isFinite(Number(nb?.price_per_sol)) ? Number(nb.price_per_sol) : null,
            valueUsd: Number.isFinite(Number(nb?.total_price)) ? Number(nb.total_price) : null,
        }
        : null;

    const items = payload?.result?.items;
    if (!Array.isArray(items)) return { total: 0, assets: [], nativeSol };
    const assets = items.slice(0, limit).map(a => {
        const meta = a?.content?.metadata || {};
        const info = a?.token_info || {};
        const amount = Number.isFinite(Number(info.balance)) && Number.isFinite(Number(info.decimals))
            ? Number(info.balance) / Math.pow(10, Number(info.decimals))
            : null;
        return {
            id: a?.id || null,
            name: meta.name || null,
            symbol: meta.symbol || info.symbol || null,
            interface: a?.interface || null,
            compressed: !!a?.compression?.compressed,
            amount,
            priceUsd: Number.isFinite(Number(info?.price_info?.price_per_token))
                ? Number(info.price_info.price_per_token) : null,
        };
    });
    return { total: Number(payload?.result?.total) || assets.length, assets, nativeSol };
}

export function describeSolanaAssets({ total, assets, nativeSol }) {
    const solLine = nativeSol
        ? `That wallet holds ${nativeSol.sol.toFixed(4)} SOL${nativeSol.valueUsd != null ? `, about ${formatUsd(nativeSol.valueUsd)}` : ''}`
        : null;
    if (!assets.length) {
        return solLine
            ? solLine + ', Sir, and no other assets I can see.'
            : 'That Solana wallet holds no assets I can see, Sir.';
    }
    const fungible = assets.filter(a => /Fungible/i.test(a.interface || ''));
    const nfts = assets.filter(a => !/Fungible/i.test(a.interface || ''));
    const named = assets.map(a => a.symbol || a.name).filter(Boolean).slice(0, 4);
    let line = solLine
        ? `${solLine}, Sir, plus ${total} asset${total === 1 ? '' : 's'}`
        : `That wallet holds ${total} asset${total === 1 ? '' : 's'}, Sir`;
    if (fungible.length || nfts.length) {
        const bits = [];
        if (fungible.length) bits.push(`${fungible.length} fungible`);
        if (nfts.length) bits.push(`${nfts.length} NFT${nfts.length === 1 ? '' : 's'}`);
        const compressed = assets.filter(a => a.compressed).length;
        if (compressed) bits.push(`${compressed} compressed`);
        line += ` — ${bits.join(', ')} in the first page`;
    }
    if (named.length) line += `. Including ${named.join(', ')}`;
    return line + '.';
}

export default {
    usdPrice, parseTokenHoldings, portfolioTotal, formatUsd, describePortfolio,
    parsePrices, describePrices, timeAgo, clockTime,
    parseSolanaActivity, describeSolanaActivity, parseSolanaAssets, describeSolanaAssets,
};
