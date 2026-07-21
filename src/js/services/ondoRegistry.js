// ---------------------------------------------------------------------------
// Ondo Global Markets token registry — 440 tokenized securities, generated
// from Ondo's own catalog CSV by scripts/build-ondo-registry.mjs.
//
// Every entry is a standard ERC-20 on Ethereum AND BSC (verified live:
// AAPLon/NVDAon/SPYon answered totalSupply/decimals/symbol on mainnet), so
// the existing read-only on-chain engine queries them with no new trust
// assumptions. Solana/HyperEVM deployments exist in Ondo's catalog but are
// NOT in this registry: this codebase has no Solana RPC support and no
// HyperEVM endpoint — omitted openly rather than half-supported.
//
// What a GM token IS, for honest voice output: a token Ondo states is backed
// 1:1 by the underlying security. totalSupply × underlying price is therefore
// spoken as "representing approximately $X at the current <ticker> price" —
// the backing ratio is Ondo's claim, the supply and the price are measured.
// ---------------------------------------------------------------------------
import TOKENS from './ondoTokens.js';

/** ticker -> entry (first wins; catalog has no duplicate tickers) */
const BY_TICKER = new Map();
/** lowercased on-chain symbol ("aaplon") -> entry */
const BY_SYMBOL = new Map();
/** lowercased eth/bsc address -> entry (for decoding Transfer logs) */
export const BY_ADDRESS = new Map();

for (const t of TOKENS) {
    if (!BY_TICKER.has(t.k)) BY_TICKER.set(t.k, t);
    BY_SYMBOL.set(t.s.toLowerCase(), t);
    BY_ADDRESS.set(t.e, t);
    if (t.b) BY_ADDRESS.set(t.b, t);
}

export const ONDO_COUNT = TOKENS.length;

/* Spoken-name aliases the raw catalog can't resolve: STT emits "google" not
   "Alphabet", "s and p" not "SPDR S&P 500 ETF Trust". Kept deliberately small
   — name/ticker/symbol matching below covers the rest. */
/* Catalog tickers that collide with everyday English words — never matched as
   bare lowercase words in speech (STT text has no case signal to disambiguate). */
const WORD_TICKERS = new Set(['CAT', 'LOW', 'NOW', 'ON', 'OPEN', 'SO', 'NET', 'BE', 'TEN', 'YEAR']);

const ALIASES = {
    google: 'GOOGL', alphabet: 'GOOGL', facebook: 'META', 'meta platforms': 'META',
    'the s and p': 'SPY', 's and p': 'SPY', 'sp 500': 'SPY', 'spy etf': 'SPY',
    nasdaq: 'QQQ', 'the nasdaq': 'QQQ', bitcoin: 'IBIT', gold: 'GLD', silver: 'SLV',
    oil: 'USO', 'berkshire hathaway': 'BRK.B', berkshire: 'BRK.B',
};

/**
 * Resolves spoken/typed text to a registry entry, or null.
 * Order: alias -> exact ticker -> on-chain symbol ("aaplon") -> whole-word
 * name match. Name matching requires a word boundary so "visa" cannot match
 * inside "improvisation".
 */
export function resolveOndoToken(text) {
    const t = String(text || '').toLowerCase().trim();
    if (!t) return null;

    for (const [alias, ticker] of Object.entries(ALIASES)) {
        if (new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(t)) {
            const hit = BY_TICKER.get(ticker);
            if (hit) return hit;
        }
    }

    // Exact ticker anywhere in the text ("supply of NVDA", "TSLA tokens").
    // Ten catalog tickers ARE common English words (verified against the
    // generated registry) — a real log showed "minting activity ON tokenized
    // nvidia" resolving to ON Semiconductor instead of Nvidia. Those tickers
    // are only reachable via company name or the "<sym>on" symbol form.
    for (const word of t.toUpperCase().split(/[^A-Z.]+/)) {
        if (word.length >= 2 && !WORD_TICKERS.has(word) && BY_TICKER.has(word)) return BY_TICKER.get(word);
    }

    // On-chain symbol: "aaplon", "supply of nvdaon".
    for (const word of t.split(/[^a-z0-9]+/)) {
        if (word.endsWith('on') && BY_SYMBOL.has(word)) return BY_SYMBOL.get(word);
    }

    // Whole-word company-name match, longest names first so "goldman sachs"
    // beats a hypothetical "goldman".
    const candidates = TOKENS
        .filter(x => x.n && x.n.length >= 3)
        .sort((a, b) => b.n.length - a.n.length);
    for (const x of candidates) {
        const name = x.n.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp(`\\b${name}\\b`).test(t)) return x;
    }
    return null;
}

/** Tokens most likely to be asked about — the "scan" hot list. */
export const HOT_LIST = ['SPY', 'QQQ', 'NVDA', 'AAPL', 'MSFT', 'TSLA', 'AMZN', 'GOOGL', 'META', 'AMD', 'IWM', 'GLD', 'IBIT', 'COIN', 'PLTR']
    .map(k => BY_TICKER.get(k)).filter(Boolean);

/* ---------------------------------------------------------------------------
   Voice-intent parsing. Pure and exported so it is unit-testable.

   STRICTLY GATED: parseOnchainQuery runs BEFORE the quant/price parsers in
   jarvis.js, so a loose match here would steal "price of apple" (a stock
   quote) or "analyze tesla" (quant engine). The gate requires either explicit
   tokenization context (tokenized/ondo/gm token) or supply/mint/holder
   wording that no other parser owns.
--------------------------------------------------------------------------- */

/** "over the last 30 days" / "this month" / "history" -> days for the
 *  key-gated Dune supply-history path; null means the keyless 24h RPC scan. */
function parseDays(t) {
    const m = t.match(/\b(?:over|last|past)\s+(?:the\s+)?(\d{1,2})\s+days?\b/);
    if (m) return Math.max(1, Math.min(parseInt(m[1], 10), 90));
    if (/\bthis month\b/.test(t)) return 30;
    if (/\bthis week\b/.test(t)) return 7;
    if (/\bhistory\b/.test(t)) return 30;
    return null;
}

/**
 * Text -> Ondo intent {kind, ondo?, days?} or null.
 * Kinds: ondo-catalog | ondo-supply | ondo-flows | ondo-holders | ondo-info.
 */
export function parseOndoQuery(text) {
    const t = String(text || '').toLowerCase();
    if (!t) return null;

    const ctx = /\b(tokenized|tokenised|ondo|gm ?tokens?)\b/.test(t);
    const supplyish = /\b(supply|outstanding|in circulation|circulating)\b/.test(t)
        || (/\bhow (many|much)\b/.test(t) && /\b(tokens?|exist)\b/.test(t));
    const flowish = /\b(mint(s|ed|ing)?|redeem(s|ed|ing|ption|ptions)?|redemption|issuance|burn(s|ed|ing)?)\b/.test(t);
    const holderish = /\b((top|largest|biggest) holders?|who holds|holder list|whale holders?)\b/.test(t);
    if (!ctx && !supplyish && !flowish && !holderish) return null;

    // Catalog questions need no specific token: "which tokenized stocks exist",
    // "how many ondo tokens are there", "list gm tokens".
    if (ctx && /\b(what|which|list|how many)\b/.test(t)
        && /\b(stocks?|securities|assets|tokens?|equities|etfs?)\b/.test(t)
        && /\b(tokenized|tokenised|ondo|gm ?tokens?)\s+(stocks?|securities|assets|tokens?|equities|etfs?)\b/.test(t)) {
        return { kind: 'ondo-catalog' };
    }

    const ondo = resolveOndoToken(t);
    if (!ondo) return null;

    if (holderish) return { kind: 'ondo-holders', ondo };
    const days = parseDays(t);
    if (flowish) return { kind: 'ondo-flows', ondo, days };
    // "supply history of X over 30 days" carries no mint/redeem word but is an
    // issuance-history question, not a point-in-time supply read.
    if (supplyish && days !== null) return { kind: 'ondo-flows', ondo, days };
    if (supplyish || (ctx && /\b(market cap|worth|backed|backing)\b/.test(t))) return { kind: 'ondo-supply', ondo };
    if (ctx) return { kind: 'ondo-info', ondo };
    return null;
}
