/**
 * @fileoverview Which sources a question actually needs, and in what shape.
 *
 * PURE: scoring only. No fetch, no model, no clock. The caller does the I/O.
 *
 * MEASURED, NOT ASSUMED. Fetching seven feeds sequentially took 6560ms; in
 * parallel, 1652ms — a 3.97x speedup. But parallel total came within 2ms of the
 * SLOWEST SINGLE SOURCE (chrome, 1650ms), which is the floor fan-out can reach.
 * So past that point the only remaining lever is not fetching what the question
 * does not need:
 *
 *   all seven, parallel      1652ms   (bounded by chrome)
 *   sec + fed only             24ms   (measured, same run)
 *
 * That is ~69x, and it dwarfs the 3.97x from parallelism alone. The scheduler
 * matters more than the fan-out — which is the opposite of where the papers put
 * their emphasis, because they assume a single homogeneous search backend where
 * every call costs the same. These sources do not.
 */

/* Per-source terms and MEASURED latency. The latency is here so the planner can
   prefer a fast source when two would answer equally — a real tradeoff only
   visible because the numbers were taken rather than guessed. */
export const SOURCES = {
    'cisa': { terms: /\b(cisa|advisor(y|ies)|exploited|kev|ics|critical infrastructure)\b/i, domain: 'security', ms: 65 },
    'chrome': { terms: /\b(chrome|chromium|browser|desktop update)\b/i, domain: 'security', ms: 1650 },
    'google-sec': { terms: /\b(google security|android|pixel|zero.?day)\b/i, domain: 'security', ms: 1010 },
    'nvd': { terms: /\bCVE-\d{4}-\d{4,7}\b|\b(vulnerabilit(y|ies)|cvss|severity)\b/i, domain: 'security', ms: 400 },
    'sec-8k': { terms: /\b(sec|8-?k|10-?[kq]|filing|edgar|earnings|disclosure)\b/i, domain: 'finance', ms: 24 },
    'fed': { terms: /\b(fed|federal reserve|fomc|rate|monetary|inflation)\b/i, domain: 'finance', ms: 18 },
    'arxiv-cr': { terms: /\b(arxiv|paper|preprint)\b.*\b(security|crypto)\b|\bcs\.CR\b/i, domain: 'research', ms: 71 },
    'arxiv-ai': { terms: /\b(arxiv|paper|preprint|research)\b/i, domain: 'research', ms: 238 },
    'chain': { terms: /\b(gas|balance|wallet|0x[0-9a-f]{6,}|whale|on.?chain|ethereum|arbitrum|base|bsc|solana)\b/i, domain: 'chain', ms: 300 },
    'prediction': { terms: /\b(odds|prediction market|polymarket|kalshi|probability)\b/i, domain: 'markets', ms: 500 },
};

export const SCORE_FLOOR = 1;

/**
 * @returns {{plan, skipped, estimatedMs, sequentialMs}} — plan is scored, highest first.
 */
export function planSources(query, { max = 4 } = {}) {
    const q = String(query || '');
    const scored = [];
    for (const [name, s] of Object.entries(SOURCES)) {
        const m = q.match(s.terms);
        if (!m) continue;
        // Score by how much of the query the match explains, so a passing
        // mention loses to a query that is about this source.
        scored.push({ name, domain: s.domain, ms: s.ms, score: +(m[0].length / Math.max(q.length, 1) * 10).toFixed(3) });
    }
    scored.sort((a, b) => b.score - a.score || a.ms - b.ms);

    const plan = scored.filter(s => s.score >= SCORE_FLOOR / 10).slice(0, max);
    const skipped = Object.keys(SOURCES).filter(n => !plan.some(p => p.name === n));

    return {
        plan, skipped,
        // Parallel cost IS the slowest member — measured, not modelled.
        estimatedMs: plan.length ? Math.max(...plan.map(p => p.ms)) : 0,
        sequentialMs: plan.reduce((s, p) => s + p.ms, 0),
    };
}

/**
 * Merge results from several sources into one deduplicated, source-attributed
 * list. Attribution is not decoration: when two feeds disagree, knowing which
 * said what is the difference between a corroborated fact and a repeated one —
 * the same independence rule the promotion gate enforces.
 */
export function mergeResults(results, { limit = 20 } = {}) {
    const seen = new Map();
    for (const r of results || []) {
        for (const item of r?.items || []) {
            // Same link, or same title, is the same story from two feeds.
            const key = (item.link || item.title || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 80);
            if (!key) continue;
            if (seen.has(key)) {
                const prev = seen.get(key);
                if (!prev.sources.includes(r.source)) prev.sources.push(r.source);
            } else {
                seen.set(key, { ...item, sources: [r.source] });
            }
        }
    }
    return [...seen.values()]
        // Corroborated items first — appearing in two independent feeds is the
        // only evidence available here that a story is real.
        .sort((a, b) => b.sources.length - a.sources.length || (b.at || 0) - (a.at || 0))
        .slice(0, limit);
}

/** Failures are reported, never silently dropped: a missing source changes what
 *  the answer is allowed to claim. */
export function describePlan(p, failures = []) {
    if (!p?.plan.length) return 'No primary source matches that, Sir; I would be guessing.';
    const names = p.plan.map(x => x.name).join(', ');
    const saved = p.sequentialMs - p.estimatedMs;
    let s = `Checking ${p.plan.length} source${p.plan.length === 1 ? '' : 's'} in parallel, Sir: ${names}.`;
    if (saved > 200) s += ` About ${Math.round(saved / 100) / 10} seconds faster than one at a time.`;
    if (failures.length) s += ` ${failures.join(' and ')} did not respond, so this may be incomplete.`;
    return s;
}

export default { SOURCES, planSources, mergeResults, describePlan };
