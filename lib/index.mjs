//
// The library surface.
//
// Jarvis is primarily a desktop app, but several pieces of it are useful on
// their own and were written to be: no Electron imports, no DOM, no globals
// beyond `fetch`. Those are re-exported here so `import { search } from
// '@ashutosh0x/jarvis'` works in any Node 22+ program.
//
// What is NOT exported: anything that touches the Electron main process, the
// renderer, the microphone or the filesystem watcher. Those only make sense
// inside the app, and exporting them would promise an API that cannot work in
// a plain Node process.
//

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// The modules below predate this package and are CommonJS. Converting them to
// ESM would be churn with a real risk of behaviour change in code that has
// tests but no types; bridging is honest and costs nothing at runtime.
const webSearch = require('../webSearch.js');
const metricStore = require('../metricStore.js');
const rpcHedge = require('../rpcHedge.js');
const sectorMove = require('../sectorMove.js');
const streamGuard = require('../streamGuard.js');

// ── Search ──────────────────────────────────────────────────────────────────

/**
 * Federated live search across 11 providers, fused with Reciprocal Rank
 * Fusion (k=60) and re-ranked with BM25.
 *
 * No API key. No index to maintain. Providers are queried in parallel and the
 * slow ones are simply not waited for — see `gatherAll`.
 *
 * @param {string} query
 * @param {{ minProviders?: number, timeoutMs?: number, signal?: AbortSignal }} [options]
 * @returns {Promise<{ results: Array, answer: string|null, providers: string[] }>}
 */
export async function search(query, options = {}) {
    const intents = webSearch.detectIntents(query);
    const providers = webSearch.buildProviders(query, intents);
    const gathered = await webSearch.gatherAll(providers, {
        // Two providers is enough to fuse meaningfully. Waiting for all eleven
        // would make every query as slow as the slowest one.
        minProviders: options.minProviders ?? 2,
        timeoutMs: options.timeoutMs ?? 4000,
        signal: options.signal,
    });

    const fused = webSearch.rrfFuse(gathered, webSearch.providerWeights(query, intents));
    const ranked = webSearch.rankResults(webSearch.dedupeResults(fused), query);

    return {
        results: ranked,
        answer: webSearch.extractAnswer(ranked, query),
        providers: [...new Set(gathered.map((r) => r.provider))],
    };
}

export const {
    /** Which of the 11 providers to query, given the question. */
    buildProviders,
    /** True when the answer changes by the hour — news, prices, scores. */
    isTimeSensitive,
    detectIntents,
    /** BM25 (k1=1.2, b=0.75) over a result set. */
    bm25Search,
    /** Damerau-Levenshtein. Transpositions cost 1, not 2 — "recieve" is one typo. */
    editDistance,
    shouldApplyCorrection,
    verifyAnswer,
    providerWeights,
    gatherAll,
    /** Reciprocal Rank Fusion, k=60. */
    rrfFuse,
    dedupeResults,
    rankResults,
    extractAnswer,
    htmlToText,
    SearchCache,
} = webSearch;

// ── Observability ───────────────────────────────────────────────────────────

export const {
    /** Rolling percentile store — p50/p95/p99 without keeping every sample. */
    stats,
    windowed,
    rollup,
    rollupByDay,
    pruneRaw,
    makeSample,
} = metricStore;

// ── Networking ──────────────────────────────────────────────────────────────

export const {
    /**
     * Races several RPC endpoints and takes the first good answer, with a
     * sticky preference so a healthy endpoint keeps being tried first.
     */
    hedgedRace,
    createStickyOrder,
} = rpcHedge;

export const {
    /** Exponential backoff with jitter. */
    backoffDelay,
    createDedup,
    createBlockTracker,
    prioritizeAlerts,
} = streamGuard;

// ── Market analytics ────────────────────────────────────────────────────────

export const {
    dailyReturns,
    alignReturns,
    correlation,
    beta,
    peerIndex,
    realizedVol,
    trailingReturn,
    drawdown,
    PEER_GROUPS,
} = sectorMove;

export { webSearch, metricStore, rpcHedge, sectorMove, streamGuard };
