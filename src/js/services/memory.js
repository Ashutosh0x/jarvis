/**
 * @fileoverview Typed, revisable project memory.
 *
 * PURE: no I/O, no model, no clock except where passed. The caller persists.
 *
 * WHY NOT A ROLLING SUMMARY. Jarvis already forgets across sessions: the log
 * shows the same architectural questions re-asked days apart. A single
 * conversation_summary.txt is the wrong shape for that, for the reason C-DIC
 * (arXiv 2606.12411) makes precise — a frozen summary cannot be revised, so
 * stale facts survive and compound. Memory here is a set of typed, individually
 * revisable records with explicit supersession.
 *
 * WHAT WAS DELIBERATELY NOT TAKEN FROM THE PAPERS:
 *   - CoMem's k-step-off async pipeline (arXiv 2605.30842) targets KV-cache
 *     bandwidth saturation at batch>=16. Their Figure 2 shows TPOT is FLAT
 *     against context length at batch=1, which is what a single-user desktop
 *     assistant on one Ollama instance actually runs. The pipeline solves a
 *     serving problem this app does not have. Writes are still kept off the
 *     reply path, but for UX (never make the user wait to speak), not throughput.
 *   - Reward-trained memory models. That needs GRPO and a frozen agent to score
 *     action-consistency against. gemma3:4b here is inference-only.
 *
 * Retention is per TYPE, not per age: a decision made in March still governs the
 * code today, while a benchmark number from March is merely history.
 */

/** Retention in days, and whether a record may be revised in place.
 *  `null` = keep indefinitely. */
export const TYPES = {
    decision: { ttlDays: null, revisable: true, weight: 1.0 },   // "why we chose X over Y"
    constraint: { ttlDays: null, revisable: true, weight: 1.0 },   // "never hardcode lookup tables"
    preference: { ttlDays: null, revisable: true, weight: 0.9 },   // how the user wants things done
    bug: { ttlDays: 180, revisable: true, weight: 0.7 },   // fixed, but the shape recurs
    benchmark: { ttlDays: 90, revisable: false, weight: 0.5 },   // a measurement, true only when taken
    experiment: { ttlDays: 90, revisable: false, weight: 0.5 },   // including failures — those are data
    reference: { ttlDays: null, revisable: true, weight: 0.6 },   // papers, URLs, tickets
    todo: { ttlDays: 30, revisable: true, weight: 0.8 },
};

export const DOMAINS = ['chain', 'finance', 'news', 'security', 'system', 'routing', 'memory', 'general'];

const DAY = 86400000;

/**
 * @param {{type, domain, text, at, sources?, supersedes?}} rec
 * @returns {{ok, reason?, record?}}
 */
export function makeRecord(rec, now) {
    if (!rec || !rec.text || !String(rec.text).trim()) return { ok: false, reason: 'empty text' };
    if (!TYPES[rec.type]) return { ok: false, reason: `unknown type: ${rec.type}` };
    const domain = DOMAINS.includes(rec.domain) ? rec.domain : 'general';
    return {
        ok: true,
        record: {
            id: rec.id || `${rec.type}-${(now || 0)}-${Math.abs(hash(rec.text)).toString(36)}`,
            type: rec.type,
            domain,
            text: String(rec.text).trim(),
            at: rec.at || now || 0,
            // Provenance. A record with no source is a claim, not a fact — the
            // distinction that stops this becoming another place to hallucinate.
            sources: Array.isArray(rec.sources) ? rec.sources : [],
            supersedes: rec.supersedes || null,
            revisions: rec.revisions || 0,
        },
    };
}

function hash(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; }
    return h;
}

/**
 * Write-back: a new record may REVISE an existing one rather than pile on top.
 * This is the mechanism a rolling summary lacks — without it, "we use Etherscan"
 * and "we replaced Etherscan" both survive and the later reader cannot tell which
 * holds.
 * @returns {{store, action: 'insert'|'revise'|'rejected', reason?}}
 */
export function write(store, rec, now) {
    const built = makeRecord(rec, now);
    if (!built.ok) return { store, action: 'rejected', reason: built.reason };
    const r = built.record;
    const rows = store || [];

    if (r.supersedes) {
        const target = rows.find(x => x.id === r.supersedes);
        if (!target) return { store: [...rows, r], action: 'insert', reason: 'supersede target missing' };
        if (!TYPES[target.type].revisable) {
            // A benchmark is a measurement at a time. Overwriting it destroys the
            // series; the new number is a new record.
            return { store: [...rows, { ...r, supersedes: null }], action: 'insert', reason: `${target.type} is not revisable` };
        }
        const revised = {
            ...r, id: target.id, at: r.at,
            revisions: (target.revisions || 0) + 1,
            previous: target.text,          // one hop back, so a bad revision is visible
        };
        return { store: rows.map(x => (x.id === target.id ? revised : x)), action: 'revise' };
    }
    return { store: [...rows, r], action: 'insert' };
}

/** Expiry is per type. A decision does not go stale because time passed. */
export function prune(store, now) {
    const kept = [], dropped = [];
    for (const r of store || []) {
        const ttl = TYPES[r.type]?.ttlDays;
        if (ttl != null && (now - r.at) > ttl * DAY) dropped.push(r); else kept.push(r);
    }
    return { store: kept, dropped };
}

const STOP = new Set(['the', 'a', 'an', 'is', 'was', 'are', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'we', 'it', 'that', 'this', 'with']);
const words = t => new Set(String(t || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !STOP.has(w)));

/**
 * Retrieval: term overlap x type weight x mild recency. Deliberately lexical —
 * an embedding index would need a model call on the reply path, which is exactly
 * the blocking cost worth avoiding at this scale.
 */
export function retrieve(store, query, { domain, limit = 6, now = 0 } = {}) {
    const q = words(query);
    if (!q.size) return [];
    return (store || [])
        .map(r => {
            const rw = words(r.text);
            let shared = 0;
            for (const w of q) if (rw.has(w)) shared++;
            if (!shared) return null;
            const overlap = shared / q.size;
            const ageDays = now && r.at ? (now - r.at) / DAY : 0;
            // Half-life ~180 days: old decisions still surface, old benchmarks fade.
            const recency = TYPES[r.type].ttlDays == null ? 1 : Math.exp(-ageDays / 180);
            const domainBoost = domain && r.domain === domain ? 1.3 : 1;
            return { record: r, score: +(overlap * TYPES[r.type].weight * recency * domainBoost).toFixed(4) };
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
}

/**
 * Domain-partitioned compaction (the transferable half of arXiv 2605.23296).
 * Each domain is compacted independently, so the operator controls volume by
 * partition rather than by asking a model for "a shorter summary" — an
 * instruction that paper measures as largely ignored.
 *
 * Returns WHAT to compact. It does not call a model: the caller decides whether
 * a deterministic join or a summarizer runs, and does it off the reply path.
 */
export function planCompaction(store, { maxPerDomain = 12, now = 0 } = {}) {
    const byDomain = {};
    for (const r of store || []) (byDomain[r.domain] = byDomain[r.domain] || []).push(r);

    const plan = [];
    for (const [domain, rows] of Object.entries(byDomain)) {
        if (rows.length <= maxPerDomain) continue;
        // Compact the LOW-value tail, never decisions or constraints — those are
        // the records the whole store exists to preserve.
        const candidates = rows
            .filter(r => TYPES[r.type].weight < 0.8)
            .sort((a, b) => a.at - b.at)
            .slice(0, rows.length - maxPerDomain);
        if (candidates.length >= 2) {
            plan.push({ domain, count: candidates.length, ids: candidates.map(r => r.id), types: [...new Set(candidates.map(r => r.type))] });
        }
    }
    return plan.sort((a, b) => b.count - a.count);
}

/** One line per record, newest first — for a prompt or for the user to read. */
export function render(records, { limit = 20 } = {}) {
    return (records || []).slice(0, limit)
        .map(r => {
            const rec = r.record || r;
            const src = rec.sources?.length ? ` [${rec.sources.length} source${rec.sources.length === 1 ? '' : 's'}]` : ' [unsourced]';
            const rev = rec.revisions ? ` (revised ${rec.revisions}x)` : '';
            return `${rec.type.padEnd(10)} ${rec.domain.padEnd(9)} ${rec.text}${src}${rev}`;
        })
        .join('\n');
}

export default { TYPES, DOMAINS, makeRecord, write, prune, retrieve, planCompaction, render };
