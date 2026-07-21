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
    'cisa': { terms: /\b(cisa|advisor(y|ies)|exploited|kev|ics|critical infrastructure)\b/i, domain: 'security', ms: 65, ok: 1 },
    'chrome': { terms: /\b(chrome|chromium|browser|desktop update)\b/i, domain: 'security', ms: 1650, ok: 1 },
    'google-sec': { terms: /\b(google security|android|pixel|zero.?day)\b/i, domain: 'security', ms: 1010, ok: 1 },
    'nvd': { terms: /\bCVE-\d{4}-\d{4,7}\b|\b(vulnerabilit(y|ies)|cvss|severity)\b/i, domain: 'security', ms: 400, ok: 1 },
    'sec-8k': { terms: /\b(sec|8-?k|10-?[kq]|filing|edgar|earnings|disclosure)\b/i, domain: 'finance', ms: 24, ok: 1 },
    'fed': { terms: /\b(fed|federal reserve|fomc|rate|monetary|inflation)\b/i, domain: 'finance', ms: 18, ok: 1 },
    'arxiv-cr': { terms: /\b(arxiv|paper|preprint)\b.*\b(security|crypto)\b|\bcs\.CR\b/i, domain: 'research', ms: 71, ok: 1 },
    'arxiv-ai': { terms: /\b(arxiv|paper|preprint|research)\b/i, domain: 'research', ms: 238, ok: 1 },
    'chain': { terms: /\b(gas|balance|wallet|0x[0-9a-f]{6,}|whale|on.?chain|ethereum|arbitrum|base|bsc|solana)\b/i, domain: 'chain', ms: 300, ok: 1 },
    'prediction': { terms: /\b(odds|prediction market|polymarket|kalshi|probability)\b/i, domain: 'markets', ms: 500, ok: 1 },
};


/* OBSERVED, NOT ASSERTED.
   The ms values above are seeds from one run on one network. Left frozen they
   become exactly the kind of guess-map this project has a standing rule against
   — a table that keeps being right about the past. observe() replaces each seed
   with an exponentially weighted moving average of what actually happened, so a
   feed that degrades is demoted without anyone editing a constant.

   ALPHA 0.2: a single slow response should nudge the estimate, not redefine it,
   since one timeout on a flaky network is noise rather than a new normal. */
export const ALPHA = 0.2;

export function observe(stats, source, { ms, ok }) {
    const prev = stats?.[source] || { ms: SOURCES[source]?.ms ?? 500, ok: 1, n: 0 };
    return {
        ...(stats || {}),
        [source]: {
            // A failure carries no latency information — it tells us the source
            // was unreachable, not that it was slow.
            ms: ok ? Math.round(ALPHA * ms + (1 - ALPHA) * prev.ms) : prev.ms,
            ok: +(ALPHA * (ok ? 1 : 0) + (1 - ALPHA) * prev.ok).toFixed(3),
            n: prev.n + 1,
        },
    };
}

/* Utility, not speed. Optimizing latency alone would rank a fast source that
   rarely answers above a slow one that always does. relevance x reliability
   discounted by cost keeps a 1650ms source in the plan when it is the ONLY one
   that can answer — which for a Chrome advisory it is. */
export function utility({ score, ms, ok }) {
    return +(score * (ok ?? 1) / Math.log2(2 + (ms ?? 500) / 100)).toFixed(4);
}

export const SCORE_FLOOR = 1;

/**
 * @returns {{plan, skipped, estimatedMs, sequentialMs}} — plan is scored, highest first.
 */
export function planSources(query, { max = 4, stats = null } = {}) {
    const q = String(query || '');
    const scored = [];
    for (const [name, s] of Object.entries(SOURCES)) {
        const m = q.match(s.terms);
        if (!m) continue;
        // Score by how much of the query the match explains, so a passing
        // mention loses to a query that is about this source.
        const live = stats?.[name];
        const ms = live?.ms ?? s.ms;
        const ok = live?.ok ?? s.ok ?? 1;
        const score = +(m[0].length / Math.max(q.length, 1) * 10).toFixed(3);
        scored.push({ name, domain: s.domain, ms, ok, score, utility: utility({ score, ms, ok }) });
    }
    scored.sort((a, b) => b.utility - a.utility || a.ms - b.ms);

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

export default { SOURCES, ALPHA, observe, utility, planSources, mergeResults, describePlan };
