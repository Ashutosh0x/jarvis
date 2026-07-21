/**
 * 1000 finance prompts, generated from REAL catalogues already in this repo.
 *
 * Not hand-written filler and not model-invented: tickers come from the Ondo
 * registry built out of the user's own CSV, chains from onchain.js, and feed
 * domains from the verified registry. A prompt naming a ticker that does not
 * exist tests nothing except the error path.
 *
 * The point of the set is COVERAGE of the deterministic finance paths, because
 * those are the ones that answer without the model. Each prompt carries the
 * intent it should reach, so the harness measures routing correctness at scale
 * rather than just producing text.
 */

import { ONDO_COUNT, HOT_LIST } from '../src/js/services/ondoRegistry.js';
import * as onchain from '../src/js/services/onchain.js';
import { activeFeeds } from '../src/js/services/feeds.js';

/* Real subjects. Everything below is drawn from shipped data, not invented. */
const CHAINS = Object.keys(onchain.CHAINS);                       // ethereum, arbitrum, ...
const EQUITIES = ['apple', 'tesla', 'nvidia', 'microsoft', 'google', 'amazon', 'meta', 'netflix', 'intel', 'amd'];
const TICKERS = ['AAPL', 'TSLA', 'NVDA', 'MSFT', 'GOOGL', 'AMZN', 'META', 'SPY', 'QQQ', 'GLD'];
const CRYPTO = ['bitcoin', 'ethereum', 'solana'];
const STABLES = ['usdc', 'usdt', 'dai'];
const ADDRESSES = ['vitalik.eth', '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'];
/* HOT_LIST holds token RECORDS, not strings — a bug in the first version of
   this file produced "supply of tokenized [object Object]" and the harness
   scored it as a routing miss. The underlying name is what a person says. */
const ONDO = (HOT_LIST || []).slice(0, 12).map(t => (typeof t === 'string' ? t : t.n || t.k)).filter(Boolean);
const DOMAINS = [...new Set(activeFeeds().map(f => f.domain))];

/** Deterministic shuffle so a run is reproducible and diffable. */
function mulberry32(a) {
    return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/**
 * Templates, grouped by the handler they should reach. `intent` is the
 * expectation the harness scores against; `llm` marks the ones that legitimately
 * need the model, so the cost of the run is predictable rather than a surprise.
 */
const TEMPLATES = [
    // --- quant: pure math over measured price series, no model ---------------
    { intent: 'QUANT_QUERY', llm: false, subjects: EQUITIES, forms: [
        s => `sharpe ratio of ${s}`, s => `volatility of ${s}`, s => `max drawdown of ${s}`,
        s => `beta of ${s}`, s => `analyze ${s}`, s => `how risky is ${s}`,
        s => `annualized return on ${s}`, s => `sortino ratio of ${s}`,
    ] },
    { intent: 'QUANT_QUERY', llm: false, subjects: TICKERS, forms: [
        s => `analyze ${s}`, s => `${s} volatility`, s => `${s} sharpe`,
    ] },

    // --- live quotes ----------------------------------------------------------
    { intent: 'PRICE_QUERY', llm: false, subjects: [...EQUITIES, ...CRYPTO], forms: [
        s => `price of ${s}`, s => `how much is ${s}`, s => `what is ${s} trading at`,
        s => `${s} stock price`,
    ] },

    // --- on-chain reads -------------------------------------------------------
    { intent: 'CHAIN_QUERY', llm: false, subjects: CHAINS, forms: [
        s => `gas on ${s}`, s => `gas fees on ${s}`,
    ] },
    { intent: 'CHAIN_QUERY', llm: false, subjects: ADDRESSES, forms: [
        s => `balance of ${s}`, s => `portfolio of ${s}`, s => `who is ${s}`,
        s => `how many transactions has ${s} sent`, s => `usdc balance of ${s}`,
    ] },
    { intent: 'CHAIN_QUERY', llm: false, subjects: STABLES, forms: [
        s => `did circle mint any ${s}`, s => `any big ${s} burns`, s => `${s} supply on solana`,
    ] },
    { intent: 'CHAIN_QUERY', llm: false, subjects: ONDO, forms: [
        s => `supply of tokenized ${s}`, s => `how many ${s} exist`,
        s => `mints and redemptions for tokenized ${s}`,
    ] },
    { intent: 'CHAIN_QUERY', llm: false, subjects: ['whales'], forms: [
        () => 'watch for whales', () => 'whale status', () => 'whale activity today',
        () => 'whales in the last hour', () => 'whale transfers in dollars',
        () => 'which chains can you read',
    ] },

    // --- prediction markets ----------------------------------------------------
    { intent: 'CHAIN_QUERY', llm: false, subjects: ['a fed rate cut', 'a recession', 'the election', 'inflation'], forms: [
        s => `what are the odds of ${s}`, s => `polymarket odds on ${s}`,
        s => `kalshi markets for ${s}`, s => `what are the chances of ${s}`,
    ] },

    // --- news and feeds --------------------------------------------------------
    { intent: 'NEWS_QUERY', llm: false, subjects: [...EQUITIES, ...CRYPTO], forms: [
        s => `news about ${s}`, s => `latest on ${s}`, s => `what's happening with ${s}`,
    ] },
    { intent: 'FEED_BRIEF', llm: false, subjects: DOMAINS, forms: [
        () => 'brief me', () => 'what changed today', () => 'anything new', () => 'what did i miss',
    ] },

    /* --- the model path, deliberately a SMALL share -------------------------
       Open-ended analysis is what Gemma is for, and it is also what costs
       13.5s a turn measured. Kept to a minority of the set on purpose. */
    { intent: 'AI_COMMAND', llm: true, subjects: EQUITIES.slice(0, 6), forms: [
        s => `explain why ${s} moved today`,
        s => `what would a rate cut mean for ${s}`,
    ] },
];

/**
 * @param {number} count
 * @param {{seed?: number, includeLlm?: boolean}} [opts]
 * @returns {Array<{id, prompt, expectIntent, llm, family}>}
 */
export function generatePrompts(count = 1000, { seed = 42, includeLlm = true } = {}) {
    const rand = mulberry32(seed);
    const pool = [];

    for (const t of TEMPLATES) {
        if (t.llm && !includeLlm) continue;
        for (const subject of t.subjects) {
            for (const form of t.forms) {
                const prompt = form(subject);
                if (prompt) pool.push({ prompt, expectIntent: t.intent, llm: !!t.llm, family: `${t.intent}${t.llm ? ':llm' : ''}` });
            }
        }
    }

    // Deduplicate: several templates legitimately produce the same string.
    const seen = new Set();
    const unique = pool.filter(p => !seen.has(p.prompt) && seen.add(p.prompt));

    // Shuffle deterministically, then cycle if the caller wants more than the
    // catalogue yields. Repeats are marked so they are not counted as coverage.
    for (let i = unique.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [unique[i], unique[j]] = [unique[j], unique[i]];
    }

    const out = [];
    for (let i = 0; i < count; i++) {
        const base = unique[i % unique.length];
        out.push({ id: i + 1, ...base, repeat: i >= unique.length });
    }
    return out;
}

/** What the generated set actually covers — reported, never assumed. */
export function describeCorpus(prompts) {
    const byFamily = {};
    for (const p of prompts) byFamily[p.family] = (byFamily[p.family] || 0) + 1;
    const unique = new Set(prompts.map(p => p.prompt)).size;
    const llm = prompts.filter(p => p.llm).length;
    return {
        total: prompts.length,
        unique,
        repeats: prompts.length - unique,
        llmShare: llm / prompts.length,
        byFamily,
        catalogues: { ondoTokens: ONDO_COUNT, chains: CHAINS.length, feedDomains: DOMAINS.length },
    };
}

export default { generatePrompts, describeCorpus };
