// ---------------------------------------------------------------------------
// Fund-flow tracer — deterministic graph search over a transaction graph.
//
// This is a compact implementation of the core idea behind TRacer (Wu et al.,
// KDD '22): trace where money went from a source account using Approximate
// Personalized PageRank (Andersen–Chung–Lang local push), biased for the
// blockchain setting. The LLM is NOT involved — ranking a cash-out path above
// background noise is graph math, and an LLM "estimating" relevance would just
// hallucinate. The same anti-fabrication rule as the quant/on-chain engines.
//
// TRacer's two most impactful strategies are included:
//   - tracing tendency (β): push residual forward along out-edges (following the
//     money) far more than backward, so we find where funds GO.
//   - weighted pollution: split a node's residual across neighbors in proportion
//     to transfer amount — a big transfer is a stronger lead than a dust tx.
// (Temporal reasoning and DeFi token-redirection from the paper are left for the
//  live layer, where timestamps and swap patterns are available.)
//
// This module is pure: it takes an edge list in, returns a ranking out. The live
// data that fills the graph (an address's transaction history) requires an
// indexer/Etherscan-family API and is deliberately kept out of here.
// ---------------------------------------------------------------------------

/**
 * Build adjacency structures from a flat edge list.
 * edges: [{ from, to, amount }]  (amount > 0; a weight/strength of the link)
 * Returns { out, in, nodes } where out[u] = [{to, amount}], in[v] = [{from, amount}].
 */
export function buildGraph(edges) {
    const out = new Map();
    const inc = new Map();
    const nodes = new Set();
    for (const e of edges || []) {
        if (!e || e.from == null || e.to == null) continue;
        const amount = Number(e.amount) > 0 ? Number(e.amount) : 1;
        nodes.add(e.from); nodes.add(e.to);
        if (!out.has(e.from)) out.set(e.from, []);
        if (!inc.has(e.to)) inc.set(e.to, []);
        out.get(e.from).push({ to: e.to, amount });
        inc.get(e.to).push({ from: e.from, amount });
    }
    return { out, inc, nodes };
}

function distribute(residual, edges, key, target) {
    // Split `residual` across `edges` proportional to amount, into `target` map.
    let total = 0;
    for (const e of edges) total += e.amount;
    if (total <= 0) return false;
    for (const e of edges) {
        const share = residual * (e.amount / total);
        target.set(e[key], (target.get(e[key]) || 0) + share);
    }
    return true;
}

/**
 * Approximate Personalized PageRank via local push, forward-biased for tracing.
 *
 *   alpha   teleport/absorption constant (0.15 default, as in the paper)
 *   epsilon residual threshold to stop pushing (smaller = deeper/costlier)
 *   beta    tracing tendency in [0,1]; >0.5 follows outgoing money flow
 *   maxIter safety cap on push operations
 *
 * Returns a Map<node, score>. Score(source) is highest (it absorbs alpha mass);
 * downstream nodes rank by how much money-weighted flow reaches them.
 * Deterministic: same edges + params => identical scores.
 */
export function personalizedPageRank(graph, source, opts = {}) {
    const alpha = opts.alpha ?? 0.15;
    const epsilon = opts.epsilon ?? 1e-4;
    const beta = opts.beta ?? 0.85;
    const maxIter = opts.maxIter ?? 100000;

    const p = new Map();
    const r = new Map([[source, 1]]);
    let iter = 0;

    // Push the highest-residual node until all residuals fall below epsilon.
    while (iter++ < maxIter) {
        let u = null, best = epsilon;
        for (const [node, res] of r) if (res > best) { best = res; u = node; }
        if (u === null) break;

        const ru = r.get(u);
        r.set(u, 0);
        p.set(u, (p.get(u) || 0) + alpha * ru);
        const remaining = (1 - alpha) * ru;

        const outE = graph.out.get(u) || [];
        const inE = graph.inc.get(u) || [];
        // Forward share follows the money; backward share is the smaller (1-β).
        const fwd = beta * remaining;
        const bwd = (1 - beta) * remaining;
        // If a direction has no edges, that mass is absorbed at u (a sink/leaf).
        if (!distribute(fwd, outE, 'to', r)) p.set(u, (p.get(u) || 0) + fwd);
        if (!distribute(bwd, inE, 'from', r)) p.set(u, (p.get(u) || 0) + bwd);
    }
    return p;
}

/**
 * Rank candidate accounts by relevance to the source (excluding the source),
 * highest first. `limit` caps the returned list.
 */
export function topRanked(scores, source, limit = 20) {
    return [...scores.entries()]
        .filter(([node]) => node !== source)
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([account, score]) => ({ account, score }));
}

/** One-call trace: edges + source -> ranked downstream accounts. */
export function traceFunds(edges, source, opts = {}) {
    const graph = buildGraph(edges);
    const scores = personalizedPageRank(graph, source, opts);
    return topRanked(scores, source, opts.limit ?? 20);
}
