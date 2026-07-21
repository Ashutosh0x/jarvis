// ---------------------------------------------------------------------------
// Document-neighbourhood graph — the one locally-honest slice of REPAIR
// (Kim & Kim et al., "Adaptive Retrieval for Reasoning", ACL 2026).
//
// REPAIR's problem is BOUNDED RECALL: a reranker can only reorder what the
// first stage already surfaced, so a relevant document outside the candidate
// pool is unrecoverable. JARVIS has exactly that shape in miniature — fusion
// keeps MAX_RESULTS passages and the reranker reorders those and nothing else.
//
// Its answer is neighbourhood-aware adaptive retrieval (NAR) over a
// precomputed corpus graph, resting on the Clustering Hypothesis (Jardine &
// van Rijsbergen, 1971): documents similar to a relevant one tend to be
// relevant to the same query. Building that graph is pure vector arithmetic
// over embeddings this project already stores — no model call, no training.
//
// WHAT IS DELIBERATELY NOT PORTED, and why:
//   * PSR, the planning reranker, is a Qwen-2.5-7B trained with LoRA on 8x
//     A6000s, then run listwise over sliding windows of a top-100 pool. At
//     gemma3:4b's measured 4-8.5s per /api/chat call, one query would cost
//     minutes. Untrainable and unrunnable here.
//   * The step-selection rewards (step-document similarity + a Bradley-Terry
//     consistency model over accumulated pairwise preferences) need PSR's
//     reasoning steps and >=5 window iterations to warm up. No steps, no
//     reward.
//   * Therefore SAR's *selective* expansion cannot be reproduced faithfully,
//     and that matters: the paper's own results (Table 4, Figure 3) show
//     UNGUIDED NAR IS HARMFUL — RankZephyr -3.3pt and REARANK -5.8pt
//     nDCG@10, with recall falling below the plain BM25 baseline, because
//     expansion drifts semantically away from the query.
//
// So expansion here is never unguided and never free-running. It is offered
// only into a pool that a reranker is about to judge (see ragService.recall),
// which is the condition under which the paper measures expansion paying off.
// This module stays pure and deterministic — no I/O, no clock — so the
// expansion decision is fully testable in isolation.
// ---------------------------------------------------------------------------

/** Squared L2 norm helper; returns 0 for absent/degenerate vectors. */
function norm(vec) {
    if (!vec || !vec.length) return 0;
    let s = 0;
    for (let i = 0; i < vec.length; i++) s += vec[i] * vec[i];
    return Math.sqrt(s);
}

/**
 * Unit-length copy of a vector, or null when it has no direction (missing,
 * empty, or all zeros) and therefore no meaningful cosine to anything.
 *
 * @param {number[]|null|undefined} vec
 * @returns {number[]|null}
 */
export function unit(vec) {
    const n = norm(vec);
    if (!(n > 0)) return null;
    const out = new Array(vec.length);
    for (let i = 0; i < vec.length; i++) out[i] = vec[i] / n;
    return out;
}

/** Dot product of two equal-length unit vectors == their cosine similarity. */
function dot(a, b) {
    let s = 0;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) s += a[i] * b[i];
    return s;
}

/**
 * Builds a k-nearest-neighbour graph over document vectors.
 *
 * Vectors are unit-normalised once up front so every pairwise similarity is a
 * plain dot product. Documents without a usable vector simply have no edges —
 * a corpus stored while the embedder was down degrades to "no expansion",
 * never to wrong expansion.
 *
 * Cost is O(n^2 * d), paid once in the background and cached by the caller;
 * `maxDocs` is the caller's guard against paying it on a corpus large enough
 * for the quadratic term to hurt.
 *
 * @param {Array<number[]|null>} vectors indexed by document id
 * @param {{k?: number, minSim?: number, maxDocs?: number}} [opts]
 * @returns {{k: number, minSim: number, size: number, adj: Map<number, Array<{j: number, sim: number}>>}}
 */
export function buildNeighborGraph(vectors, opts = {}) {
    const prep = _prepare(vectors, opts);
    if (!prep.units) return prep.empty;
    _rows(prep, 0, prep.units.length);
    return _finalize(prep);
}

/**
 * Identical output to `buildNeighborGraph`, computed in time-boxed slices that
 * yield to the event loop between them.
 *
 * This exists because the build is quadratic and runs in the renderer: measured
 * on this machine at 768 dimensions, 2000 documents cost 1.6s as a single
 * block, which would freeze the visualiser for well over a second. Slicing
 * changes only WHEN work happens, never what is computed — the row loop and the
 * finalisation are the same code paths the synchronous builder uses, so the two
 * are required (and tested) to agree exactly.
 *
 * @param {Array<number[]|null>} vectors
 * @param {{k?: number, minSim?: number, maxDocs?: number, sliceMs?: number}} [opts]
 * @returns {Promise<{k: number, minSim: number, size: number, adj: Map<number, Array<{j: number, sim: number}>>}>}
 */
export async function buildNeighborGraphAsync(vectors, opts = {}) {
    const sliceMs = opts.sliceMs ?? 12;
    const prep = _prepare(vectors, opts);
    if (!prep.units) return prep.empty;

    const n = prep.units.length;
    let a = 0;
    while (a < n) {
        const started = Date.now();
        let end = a;
        // Advance a row at a time until the slice budget is spent. Row cost
        // falls as `a` grows (each row only compares against later documents),
        // so a fixed row count would produce very uneven slices. The first row
        // of each slice is unconditional: a zero or already-exceeded budget
        // must still make progress, or the loop never terminates.
        do {
            _rows(prep, end, end + 1);
            end++;
        } while (end < n && Date.now() - started < sliceMs);
        a = end;
        if (a < n) await new Promise(r => setTimeout(r, 0));
    }
    return _finalize(prep);
}

/* Shared internals — one implementation of the maths, two schedules. */

function _prepare(vectors, opts) {
    const k = opts.k ?? 8;
    const minSim = opts.minSim ?? 0.5;
    const maxDocs = opts.maxDocs ?? Infinity;
    const size = Array.isArray(vectors) ? vectors.length : 0;
    const empty = { k, minSim, size: 0, adj: new Map() };

    if (!Array.isArray(vectors) || !vectors.length) return { empty };
    if (vectors.length > maxDocs) return { empty };

    // Index only the documents that actually carry a direction.
    const units = [];
    for (let i = 0; i < vectors.length; i++) {
        const u = unit(vectors[i]);
        if (u) units.push({ i, u });
    }
    if (units.length < 2) return { empty };

    const pairs = new Map(); // i -> Array<{j, sim}>
    for (const { i } of units) pairs.set(i, []);
    return { k, minSim, size, units, pairs, empty };
}

function _rows({ units, pairs, minSim }, from, to) {
    const n = units.length;
    for (let a = from; a < to && a < n; a++) {
        for (let b = a + 1; b < n; b++) {
            const sim = dot(units[a].u, units[b].u);
            if (!(sim >= minSim)) continue;
            // Undirected: each endpoint lists the other, so expansion works
            // from whichever side happened to be retrieved.
            pairs.get(units[a].i).push({ j: units[b].i, sim });
            pairs.get(units[b].i).push({ j: units[a].i, sim });
        }
    }
}

function _finalize({ k, minSim, size, pairs }) {
    const adj = new Map();
    for (const [i, list] of pairs) {
        if (!list.length) continue;
        // Descending similarity, ties broken on document id. Equal-scoring
        // neighbours are common in a small corpus, and insertion order would
        // otherwise make expansion non-reproducible run to run.
        list.sort((x, y) => (y.sim - x.sim) || (x.j - y.j));
        adj.set(i, list.slice(0, k));
    }
    return { k, minSim, size, adj };
}

/**
 * Neighbours of the retrieved passages that were NOT themselves retrieved —
 * i.e. exactly the documents bounded recall would otherwise have lost.
 *
 * Candidates are scored by their strongest link to any seed (max, not sum, so
 * one decisive neighbour beats a document loosely attached to several), and
 * ranked deterministically.
 *
 * @param {{adj: Map<number, Array<{j: number, sim: number}>>}|null} graph
 * @param {number[]} seeds document ids already in the pool
 * @param {{limit?: number, minSim?: number}} [opts]
 * @returns {Array<{i: number, sim: number}>}
 */
export function expandCandidates(graph, seeds, opts = {}) {
    const limit = opts.limit ?? 4;
    const minSim = opts.minSim ?? 0;
    if (!graph || !graph.adj || !Array.isArray(seeds) || !seeds.length) return [];
    if (!(limit > 0)) return [];

    const seedSet = new Set(seeds.filter(Number.isInteger));
    const best = new Map(); // candidate id -> strongest similarity to any seed

    for (const s of seedSet) {
        const neighbours = graph.adj.get(s);
        if (!neighbours) continue;
        for (const { j, sim } of neighbours) {
            if (seedSet.has(j)) continue;      // already in the pool
            if (!(sim >= minSim)) continue;
            const prev = best.get(j);
            if (prev === undefined || sim > prev) best.set(j, sim);
        }
    }

    return [...best.entries()]
        .map(([i, sim]) => ({ i, sim }))
        .sort((x, y) => (y.sim - x.sim) || (x.i - y.i))
        .slice(0, limit);
}
