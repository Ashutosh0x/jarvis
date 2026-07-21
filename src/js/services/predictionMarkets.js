/**
 * @fileoverview Prediction markets — Polymarket and Kalshi, read-only.
 *
 * RULES (same contract as quant.js and chainIntel.js):
 * - PURE: deterministic math and parsing only. No network, no DOM, no clock
 *   except where a timestamp is passed in.
 * - The model never computes a probability. A number a user might act on is the
 *   last place to accept a plausible-looking guess.
 * - AIR-GAP: this reads public market data. There is no order placement, no
 *   wallet, no account, and no code path in this project that can take a
 *   position. Both platforms serve prices with no key.
 *
 * SHAPES VERIFIED AGAINST THE LIVE APIS (21 Jul 2026), because three details
 * are silent and each is a factor-of-100 or worse if assumed:
 *
 *   1. Polymarket returns `outcomes` and `outcomePrices` as JSON-encoded
 *      STRINGS inside the JSON: '["Yes","No"]', '["0.87","0.13"]'. Not arrays.
 *   2. Kalshi quotes in DOLLAR STRINGS on `*_dollars` fields: "0.0120" means
 *      1.2 cents, i.e. a 1.2% probability. An earlier draft of this file, and
 *      my own first assumption, both treated Kalshi as integer cents — that is
 *      a 100x error in the direction of "this market is certain".
 *   3. Kalshi sizes and volumes live on `*_fp` fields, also strings.
 */

/* --- unified taxonomy ------------------------------------------------------
   The platforms disagree about what a category is: Polymarket tags a market
   with many, Kalshi assigns exactly one. `poly: null` for weather is not an
   omission — Polymarket has no weather markets, and the answer says so rather
   than searching for something that cannot exist. */
/* Kalshi category names are taken from the LIVE catalogue, not from
   documentation. Two published names do not exist: there is no "Culture"
   category (it is "Entertainment"), and the live data also carries Financials,
   Companies, Health, Social, Transportation and Mentions, which no summary
   mentions. A category name that does not exist silently matches nothing. */
export const PREDICTION_CATEGORIES = {
    politics: { label: 'Politics & Elections', poly: 'politics', kalshi: ['Elections', 'Politics'] },
    sports: { label: 'Sports', poly: 'sports', kalshi: ['Sports'] },
    economics: { label: 'Economics & Macro', poly: 'economy', kalshi: ['Economics', 'Financials'] },
    crypto: { label: 'Crypto', poly: 'crypto', kalshi: ['Crypto'] },
    culture: { label: 'Culture & Entertainment', poly: 'pop-culture', kalshi: ['Entertainment'] },
    tech: { label: 'AI & Science', poly: 'ai', kalshi: ['Science and Technology', 'Companies'] },
    weather: { label: 'Weather & Climate', poly: null, kalshi: ['Climate and Weather'] },
    geopolitics: { label: 'World & Geopolitics', poly: 'geopolitics', kalshi: ['World'] },
};

/** Spoken word -> category key, or null when nothing matches. */
export function resolveCategory(text) {
    const t = String(text || '').toLowerCase();
    if (/\b(politic|election|senate|congress|president|vote|primar)/.test(t)) return 'politics';
    if (/\b(sport|football|soccer|basketball|tennis|nba|nfl|world cup|cricket|golf)/.test(t)) return 'sports';
    if (/\b(econom|inflation|cpi|gdp|\bfed\b|rate cut|jobs|recession|unemploy)/.test(t)) return 'economics';
    if (/\b(crypto|bitcoin|btc|ethereum|eth\b|solana)/.test(t)) return 'crypto';
    if (/\b(culture|oscar|award|movie|music|entertainment|celebrit)/.test(t)) return 'culture';
    if (/\b(\bai\b|tech|science|space|openai|nasa|mars)/.test(t)) return 'tech';
    if (/\b(weather|climate|temperature|hurricane|tornado|warming)/.test(t)) return 'weather';
    if (/\b(world|geopolit|\bwar\b|nato|ukraine|israel|iran|china)/.test(t)) return 'geopolitics';
    return null;
}

/* --- numeric helpers ------------------------------------------------------- */

/** Both APIs send numbers as strings in places. Anything unparseable is null. */
const num = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};

/** A JSON-encoded array field, or the fallback. Never a partial guess. */
function jsonArray(value, fallback = []) {
    if (Array.isArray(value)) return value;
    if (typeof value !== 'string') return fallback;
    try { const v = JSON.parse(value); return Array.isArray(v) ? v : fallback; } catch { return fallback; }
}

/* --- odds conversion -------------------------------------------------------
   Probabilities are handled as 0..1 throughout and converted to percent only
   for display, so there is exactly one representation to reason about. */

export function impliedToDecimal(prob) {
    const p = num(prob);
    if (p === null || p <= 0 || p >= 1) return null;
    return 1 / p;
}

export function decimalToImplied(decimal) {
    const d = num(decimal);
    if (d === null || d <= 1) return null;
    return 1 / d;
}

export function impliedToAmerican(prob) {
    const p = num(prob);
    if (p === null || p <= 0 || p >= 1) return null;
    return p >= 0.5 ? -((p / (1 - p)) * 100) : ((1 - p) / p) * 100;
}

export function americanToImplied(american) {
    const a = num(american);
    if (a === null || a === 0) return null;
    return a > 0 ? 100 / (a + 100) : -a / (-a + 100);
}

export function formatOdds(prob, format = 'implied') {
    const p = num(prob);
    if (p === null || p <= 0 || p >= 1) return null;
    if (format === 'american') {
        const am = impliedToAmerican(p);
        return `${am > 0 ? '+' : ''}${Math.round(am)}`;
    }
    if (format === 'decimal') return impliedToDecimal(p).toFixed(2);
    return `${Math.round(p * 100)}%`;
}

/* --- position math ---------------------------------------------------------
   Present because the alternative is a language model doing it. Nothing here
   recommends a trade; it converts a probability the user supplies into the
   arithmetic consequence of their own belief. */

/** Expected value per contract, given your probability and the ask price. */
export function expectedValue(prob, payout, cost) {
    const p = num(prob), pay = num(payout), c = num(cost);
    if (p === null || pay === null || c === null) return null;
    return p * pay - c;
}

/** Kelly fraction from your probability and DECIMAL odds. Negative = no edge. */
export function kellyFraction(prob, odds) {
    const p = num(prob), o = num(odds);
    if (p === null || o === null || o <= 1) return null;
    const b = o - 1;
    return (b * p - (1 - p)) / b;
}

/** The book's overround: yes + no above $1 is the house's cut. */
export function impliedVig(yesPrice, noPrice) {
    const y = num(yesPrice), n = num(noPrice);
    if (y === null || n === null) return null;
    return y + n - 1;
}

/* --- Polymarket parsers ---------------------------------------------------- */

export function parsePolymarketMarket(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const names = jsonArray(raw.outcomes);
    const prices = jsonArray(raw.outcomePrices);
    const outcomes = names.map((name, i) => {
        const price = num(prices[i]);
        return { name: String(name), price, probability: price };
    });
    const priced = outcomes.filter(o => o.price !== null);
    const top = priced.length ? priced.reduce((a, b) => (b.price > a.price ? b : a)) : null;

    /* THE INVERSION BUG. `probability` is read by callers as "how likely is this
       to happen", so on a Yes/No market it MUST be the Yes price. Taking the
       highest-priced outcome instead reports the No leg whenever the answer is
       "probably not" — caught live, where "Japan recession in 2026?" displayed
       10% and was spoken as "91% yes", and "Will Bitcoin reach $100,000 in
       July?" was spoken as 100% while trading near zero. That is not a rounding
       error; it inverts the meaning of the answer.

       Multi-outcome markets (Ballon d'Or) have no Yes leg, so there the
       favourite is the meaningful figure and `isBinary` records which is which. */
    const yesLeg = priced.find(o => /^yes$/i.test(o.name)) || null;
    const isBinary = outcomes.length === 2 && outcomes.some(o => /^yes$/i.test(o.name)) && outcomes.some(o => /^no$/i.test(o.name));

    return {
        platform: 'polymarket',
        id: raw.conditionId || raw.id || null,
        question: raw.question || raw.groupItemTitle || null,
        slug: raw.slug || null,
        outcomes,
        topOutcome: top,
        isBinary,
        yesPrice: yesLeg ? yesLeg.price : null,
        probability: yesLeg ? yesLeg.price : (top ? top.price : null),
        volume: num(raw.volume),
        liquidity: num(raw.liquidity),
        bestBid: num(raw.bestBid),
        bestAsk: num(raw.bestAsk),
        lastTradePrice: num(raw.lastTradePrice),
        endDate: raw.endDate || null,
        closed: raw.closed === true,
        tokenIds: jsonArray(raw.clobTokenIds),
    };
}

export function parsePolymarketEvent(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const markets = Array.isArray(raw.markets) ? raw.markets.map(parsePolymarketMarket).filter(Boolean) : [];
    const priced = markets.filter(m => m.probability !== null);
    return {
        platform: 'polymarket',
        id: raw.id || null,
        title: raw.title || null,
        slug: raw.slug || null,
        endDate: raw.endDate || null,
        volume: num(raw.volume),
        volume24hr: num(raw.volume24hr),
        liquidity: num(raw.liquidity),
        closed: raw.closed === true,
        tags: Array.isArray(raw.tags) ? raw.tags.map(t => t?.slug || t?.label || t).filter(Boolean) : [],
        markets,
        /* An event's headline is the leading YES across its markets, not the
           highest number in it. Grouped events ("Fed Decision in July?") carry
           one market per outcome, each with a Yes and a No — ranking on the raw
           maximum picks the No leg of the least likely outcome and reports 88%
           for something the market thinks will not happen. */
        probability: (() => {
            const yesLegs = markets.map(m => {
                const yes = (m.outcomes || []).find(o => /^yes$/i.test(o.name)) || (m.outcomes || [])[0];
                return yes && yes.probability !== null ? yes.probability : null;
            }).filter(p => p !== null);
            return yesLegs.length ? Math.max(...yesLegs) : (priced.length ? priced[0].probability : null);
        })(),
    };
}

/** CLOB orderbook -> best bid/ask, spread, mid. */
export function parsePolymarketBook(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const side = (rows) => (Array.isArray(rows) ? rows.map(r => ({ price: num(r.price), size: num(r.size) })).filter(r => r.price !== null) : []);
    const bids = side(raw.bids), asks = side(raw.asks);
    // Sort rather than trust the order the book arrives in.
    const bestBid = bids.length ? Math.max(...bids.map(b => b.price)) : null;
    const bestAsk = asks.length ? Math.min(...asks.map(a => a.price)) : null;
    const mid = bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null;
    return {
        bestBid, bestAsk,
        spread: bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null,
        mid,
        probability: mid,
        depth: { bids: bids.length, asks: asks.length },
    };
}

/* --- Kalshi parsers --------------------------------------------------------
   Values arrive as DOLLAR STRINGS on `*_dollars`, already 0..1. No division. */

export function parseKalshiMarket(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const yesBid = num(raw.yes_bid_dollars);
    const yesAsk = num(raw.yes_ask_dollars);
    const noBid = num(raw.no_bid_dollars);
    const last = num(raw.last_price_dollars);

    /* Which number is spoken matters. A two-sided book gives a mid; with only
       one side, or none, the last trade is all there is and can be hours old.
       The basis is reported so the answer can say which it used instead of
       presenting a stale print as a live quote. */
    const twoSided = yesBid !== null && yesAsk !== null && yesAsk > 0 && yesBid > 0;
    let price, priceSource;
    if (twoSided) {
        price = (yesBid + yesAsk) / 2; priceSource = 'book-mid';
    } else if (last !== null && last > 0) {
        price = last; priceSource = 'last-trade';
    } else if ((yesAsk ?? 0) > 0 || (yesBid ?? 0) > 0) {
        price = (yesAsk ?? 0) > 0 ? yesAsk : yesBid; priceSource = 'one-sided-book';
    } else {
        /* Every field is zero, which on Kalshi means nobody has quoted this
           market — not that it is worth nothing. Zero here would be spoken as
           "0%", a confident claim about a market with no information in it. */
        price = null; priceSource = null;
    }

    return {
        platform: 'kalshi',
        id: raw.ticker || null,
        ticker: raw.ticker || null,
        eventTicker: raw.event_ticker || null,
        title: raw.title || null,
        question: raw.title || raw.yes_sub_title || null,
        yesPrice: yesBid,
        yesAsk,
        noPrice: noBid,
        lastPrice: last,
        probability: price ?? null,
        priceSource,
        volume: num(raw.volume_fp),
        volume24hr: num(raw.volume_24h_fp),
        openInterest: num(raw.open_interest_fp),
        liquidity: num(raw.liquidity_dollars),
        status: raw.status || null,
        closeTime: raw.close_time || null,
        rules: raw.rules_primary || null,
    };
}

export function parseKalshiEvent(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const markets = Array.isArray(raw.markets) ? raw.markets.map(parseKalshiMarket).filter(Boolean) : [];
    const priced = markets.filter(m => m.probability !== null);
    return {
        platform: 'kalshi',
        id: raw.event_ticker || raw.ticker || null,
        ticker: raw.event_ticker || raw.ticker || null,
        title: raw.title || null,
        category: raw.category || null,
        subTitle: raw.sub_title || raw.subTitle || null,
        seriesTicker: raw.series_ticker || null,
        mutuallyExclusive: raw.mutually_exclusive === true,
        markets,
        probability: priced.length ? priced.reduce((a, b) => (b.probability > a.probability ? b : a)).probability : null,
    };
}

/* --- cross-platform matching -----------------------------------------------
   Pairing "Fed decision in July" with a Kalshi ticker is a guess dressed as a
   fact if done loosely, and a wrong pairing invents a spread between two
   unrelated questions. Below the threshold, the honest output is no match. */
const STOP = new Set(['will', 'the', 'be', 'in', 'on', 'at', 'a', 'an', 'of', 'to', 'by', 'for', 'is', 'are',
    'and', 'or', 'this', 'that', 'before', 'after', 'above', 'below', 'than', 'what', 'who', 'which', 'any', 'if', 'yes', 'no']);

export function titleTokens(title) {
    return new Set(String(title || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
        .filter(w => w.length > 2 && !STOP.has(w)));
}

export function titleSimilarity(a, b) {
    const A = titleTokens(a), B = titleTokens(b);
    if (!A.size || !B.size) return 0;
    let shared = 0;
    for (const w of A) if (B.has(w)) shared++;
    return shared / Math.min(A.size, B.size);
}

export const MATCH_THRESHOLD = 0.5;

export function matchMarkets(polyList, kalshiList, threshold = MATCH_THRESHOLD) {
    const pairs = [];
    const used = new Set();
    for (const p of polyList || []) {
        let best = null, bestScore = 0;
        for (const k of kalshiList || []) {
            if (used.has(k.id)) continue;
            const s = titleSimilarity(p.title || p.question, k.title || k.question);
            if (s > bestScore) { bestScore = s; best = k; }
        }
        if (best && bestScore >= threshold) {
            used.add(best.id);
            pairs.push({ polymarket: p, kalshi: best, similarity: Number(bestScore.toFixed(2)) });
        }
    }
    return pairs;
}

/* --- alerts ----------------------------------------------------------------
   CROSSINGS, not levels. A market resting at 71% must not re-fire a 70% alert
   on every poll — the price watchlist learned this the noisy way, and an
   earlier draft of this file repeated it. The first reading only establishes a
   baseline; nothing fires until a threshold is actually crossed. */
export function checkProbAlerts(watchlist, currentPrices) {
    const alerts = [];
    const lookup = Array.isArray(currentPrices)
        ? new Map(currentPrices.map(p => [`${p.source || p.platform}:${p.marketId || p.id}`, p.prob ?? p.probability]))
        : new Map(Object.entries(currentPrices || {}));

    for (const item of watchlist || []) {
        const key = `${item.source || item.platform}:${item.marketId || item.id}`;
        const now = num(lookup.has(key) ? lookup.get(key) : lookup.get(item.marketId || item.id));
        if (now === null) continue;

        const prev = num(item.lastProbability);
        if (prev === null) continue;            // baseline only — never fires

        const threshold = num(item.threshold);
        if (threshold === null) continue;

        if (item.direction === 'above' && prev <= threshold && now > threshold) {
            alerts.push({ marketId: item.marketId || item.id, source: item.source || item.platform, title: item.title, prob: now, from: prev, threshold, direction: 'above' });
        }
        if (item.direction === 'below' && prev >= threshold && now < threshold) {
            alerts.push({ marketId: item.marketId || item.id, source: item.source || item.platform, title: item.title, prob: now, from: prev, threshold, direction: 'below' });
        }
    }
    return alerts;
}

/* --- display helpers ------------------------------------------------------- */

export function formatVolume(n) {
    const v = num(n);
    if (v === null || v <= 0) return '$0';
    if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`.replace('.0B', 'B');
    if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`.replace('.0M', 'M');
    if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`.replace('.0K', 'K');
    return `$${Math.floor(v)}`;
}

/** Probability 0..1 -> percent. Null stays null: no quote is not zero percent. */
export function formatProb(p) {
    const v = num(p);
    if (v === null) return null;
    return `${Math.round(v * 100)}%`;
}

export function timeUntil(dateStr, now = Date.now()) {
    if (!dateStr) return null;
    const d = new Date(dateStr).getTime();
    if (!Number.isFinite(d)) return null;
    const diff = d - now;
    if (diff <= 0) return 'ended';
    const days = Math.floor(diff / 86400000);
    if (days > 0) return `${days} day${days > 1 ? 's' : ''}`;
    const hours = Math.floor(diff / 3600000);
    if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''}`;
    return `${Math.max(1, Math.floor(diff / 60000))} minutes`;
}

/* --- spoken output ---------------------------------------------------------
   Every sentence names the venue, because the two platforms routinely disagree
   and "the market says 68%" is meaningless without knowing which market. */

/* Titles arrive with markdown in them — a live Kalshi title read
   "Will the **high temp in Philadelphia** be <82°" and the asterisks were
   spoken. Also expands comparison symbols, which TTS otherwise drops silently,
   turning "below 82" into "82". */
export function cleanTitle(t) {
    return String(t || '')
        .replace(/\*+/g, '')
        .replace(/\s*<\s*(?=\d)/g, ' below ')
        .replace(/\s*>\s*(?=\d)/g, ' above ')
        .replace(/\s+/g, ' ')
        .trim();
}

export function describeMarket(m) {
    if (!m) return 'I have no market to report, Sir.';
    const where = m.platform === 'kalshi' ? 'Kalshi' : 'Polymarket';
    const title = cleanTitle(m.question || m.title) || 'that market';

    // Multi-outcome: read the leaders, count the rest.
    const priced = (m.outcomes || []).filter(o => o.probability !== null);
    if (priced.length > 2) {
        const ranked = [...priced].sort((a, b) => b.probability - a.probability);
        let line = `On ${where}, ${title}: ${ranked[0].name} leads at ${formatProb(ranked[0].probability)}`;
        if (ranked[1]) line += `, then ${ranked[1].name} at ${formatProb(ranked[1].probability)}`;
        if (ranked.length > 2) line += `, with ${ranked.length - 2} other outcome${ranked.length - 2 === 1 ? '' : 's'}`;
        const v = m.volume ? formatVolume(m.volume) : null;
        return line + (v && v !== '$0' ? `. ${v} traded.` : '.');
    }

    const prob = formatProb(m.probability);
    if (!prob) return `${title} is listed on ${where}, Sir, but has no live quote.`;

    // A last trade can be hours old; saying so costs four words.
    const basis = m.priceSource === 'last-trade' ? ', on its last trade rather than a live quote'
        : m.priceSource === 'one-sided-book' ? ', from a one-sided book' : '';
    const v = m.volume ? formatVolume(m.volume) : null;
    const closes = timeUntil(m.closeTime || m.endDate);
    return `On ${where}, ${title} is at ${prob} yes${basis}.` +
        (v && v !== '$0' ? ` ${v} traded.` : '') +
        (closes && closes !== 'ended' ? ` It closes in ${closes}.` : '');
}

export function describeTrending(markets, { limit = 3 } = {}) {
    const rows = (markets || []).filter(Boolean).slice(0, limit);
    if (!rows.length) return 'I found no active prediction markets, Sir.';
    const parts = rows.map((m) => {
        const prob = formatProb(m.probability);
        const vol = formatVolume(m.volume24hr ?? m.volume);
        const where = m.platform === 'kalshi' ? 'Kalshi' : 'Polymarket';
        return `${cleanTitle(m.title || m.question)} on ${where}${prob ? ` at ${prob}` : ''}${vol !== '$0' ? `, ${vol} traded` : ''}`;
    });
    return `The most active markets, Sir: ${parts.join('. ')}.`;
}

/**
 * The same question on two venues. A gap is reported as disagreement, never as
 * arbitrage: the contracts resolve on different wording and dates, and calling
 * a spread free money would be a trading claim this project has no business
 * making.
 */
export function describeComparison(polyMarket, kalshiMarket) {
    const p = num(polyMarket?.probability);
    const k = num(kalshiMarket?.probability);
    if (p === null || k === null) {
        return 'I could not get a live quote for that market on both platforms, Sir.';
    }
    const pPct = Math.round(p * 100), kPct = Math.round(k * 100);
    const spread = Math.abs(pPct - kPct);
    const title = cleanTitle(polyMarket.title || polyMarket.question) || 'That market';
    if (spread === 0) return `${title}: both venues agree at ${pPct}%, Sir.`;
    const higher = pPct > kPct ? 'Polymarket' : 'Kalshi';
    return `${title}: Polymarket has it at ${pPct}%, Kalshi at ${kPct}% — ${higher} is ${spread} point${spread === 1 ? '' : 's'} higher, Sir. ` +
        `They resolve on different wording and dates, so a gap is not necessarily an opportunity.`;
}

export default {
    PREDICTION_CATEGORIES, resolveCategory,
    impliedToDecimal, decimalToImplied, impliedToAmerican, americanToImplied, formatOdds,
    expectedValue, kellyFraction, impliedVig,
    parsePolymarketEvent, parsePolymarketMarket, parsePolymarketBook,
    parseKalshiEvent, parseKalshiMarket,
    titleTokens, titleSimilarity, matchMarkets, MATCH_THRESHOLD,
    checkProbAlerts, formatVolume, formatProb, timeUntil,
    describeMarket, describeTrending, describeComparison,
};
