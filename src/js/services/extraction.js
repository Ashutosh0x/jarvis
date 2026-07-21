/**
 * @fileoverview Promotion gate — deciding what EARNS a place in memory.
 *
 * PURE: classification and evidence accounting over turns already recorded.
 * No model call. The extractor never invents a record; it only promotes text
 * that already exists in the transcript, which is why a fabricated claim cannot
 * enter memory through this path.
 *
 * THE CENTRAL RULE, from arXiv 2607.02579 (When Not to Write Memory, Jul 2026):
 * repeated observations are not independent evidence when they share a
 * dependency. Ten mentions of "Chrome CVE-2026-15905 is Critical" that all trace
 * to one model turn is ONE piece of evidence, not ten. Naive confidence-by-count
 * is exactly how the fabricated CVE severity would have been promoted to a
 * permanent record and then cited back with authority. Support is therefore
 * counted over distinct ORIGINS, not over mentions.
 *
 * Three outcomes, never two: promote, reject, or needs-review. A gate that can
 * only accept or drop pushes every uncertain case into one of the two failure
 * modes; the third keeps them visible instead.
 */

import { TYPES } from './memory.js';

/* Origin classes, ordered by how much they can be trusted to be true.
   A deterministic handler read a real API; the model generated text. Treating
   those as the same kind of evidence is the error this file exists to prevent. */
export const ORIGINS = {
    verified: 3,   // a probe, a test run, a live API read, a commit hash
    user: 2,   // the user stated it — authoritative about intent, not about the world
    handler: 2,   // a deterministic handler produced it
    model: 1,   // the model said it
};

export const PROMOTE_THRESHOLD = 0.65;
export const REVIEW_THRESHOLD = 0.35;

/* Surface patterns for candidate typing. Deliberately narrow: a missed candidate
   costs nothing (it stays in the transcript), a wrong promotion costs a permanent
   false record. */
const PATTERNS = [
    // "we no longer use X" is a decision as much as "we chose X" — dropping
    // something is the half a naive verb list misses.
    { type: 'decision', re: /\b(we (chose|picked|switched to|replaced|decided|no longer|stopped)|going with|instead of|rather than)\b/i },
    { type: 'constraint', re: /\b(never|always|must not|do not|don'?t) \w+/i },
    { type: 'preference', re: /\b(i (prefer|want|like|hate)|please (always|never)|from now on)\b/i },
    { type: 'bug', re: /\b(bug|broken|fails?|crash(ed|es)?|regression|off by one|wrong)\b/i },
    // No trailing \b: "%" is a non-word char, so \b after it fails at end of
    // string and "99.4%" would not have matched.
    { type: 'benchmark', re: /\b\d+(\.\d+)?\s*(%|percent\b|ms\b|tokens\b|checks\b|suites\b)/i },
    { type: 'experiment', re: /\b(tried|tested|measured|ablation|experiment|probe[ds]?)\b/i },
    { type: 'reference', re: /\b(arxiv|https?:\/\/|doi:|CVE-\d{4}-\d{4,7})\b/i },
    { type: 'todo', re: /\b(todo|next step|still (need|pending)|not yet|remaining)\b/i },
];

/* RE-DERIVABLE ANSWERS ARE NOT MEMORY.
   Found by running this gate over the real 229-turn log: 23 of 43 promotions
   were stock quotes ("Apple returned 55.2 percent annualized"). Those carry
   numbers, so they classify as benchmarks, but they are ANSWERS from live data,
   not measurements of this system. Storing one is worse than useless — the
   figure is stale within a day, and it would later be retrieved as durable
   project knowledge. Anything the handlers can fetch again on demand must be
   fetched again, never remembered. */
const TRANSIENT_SUBJECTS = [
    /\b(annualized|sharpe|beta of|volatility|drawdown|alpha of)\b/i,          // quant answers
    /\b(price of|trading at|market cap|closed at)\b/i,                        // quotes
    /\b\d+(\.\d+)?\s*(gwei|eth|usdc|sol)\b/i,                                 // chain reads
    /\b(odds|probability)\b/i,                                                // prediction markets
    // Live telemetry. The log promoted "You are on Redmi Note 10 Pro, signal
    // 100%, 72.2 megabits" three times — a reading of this moment, not knowledge.
    /\b(signal|megabits|latency|battery|cpu|ram|disk|ghz|networks? found)\b/i,
    /\bhandled \d+ commands?\b/i,
];

/** Order-independent: the number may precede the subject ("returned 55.2
 *  percent annualized"), which an "keyword-then-digit" regex would miss. */
export function isTransient(text) {
    const t = String(text || '');
    return /\d/.test(t) && TRANSIENT_SUBJECTS.some(re => re.test(t));
}

/** @returns {string|null} the type this text looks like, or null */
export function classify(text) {
    const t = String(text || '');
    if (!t.trim()) return null;
    if (isTransient(t)) return null;
    for (const p of PATTERNS) if (p.re.test(t)) return p.type;
    return null;
}

/**
 * Effective support: distinct ORIGINS, not mention count.
 *
 * Observations sharing an originId are one dependency — the model restating its
 * own claim across five turns adds nothing. This is the correction that separates
 * "said often" from "known true".
 *
 * @param {Array<{origin, originId}>} observations
 * @returns {{effective, mentions, byOrigin, strongest}}
 */
export function effectiveSupport(observations) {
    const obs = (observations || []).filter(o => o && ORIGINS[o.origin]);
    const seen = new Map();
    for (const o of obs) {
        // Same origin AND same id = same dependency, counted once.
        const key = `${o.origin}:${o.originId ?? 'anon'}`;
        if (!seen.has(key)) seen.set(key, o.origin);
    }
    const byOrigin = {};
    for (const origin of seen.values()) byOrigin[origin] = (byOrigin[origin] || 0) + 1;
    const strongest = Object.keys(byOrigin).sort((a, b) => ORIGINS[b] - ORIGINS[a])[0] || null;
    return { effective: seen.size, mentions: obs.length, byOrigin, strongest };
}

/**
 * Confidence in [0,1]. Driven by the STRONGEST origin, then nudged by how many
 * independent origins agree. Capped below 1: nothing extracted from a transcript
 * is certain, and a stored 1.0 would read as verified when it is not.
 */
export function confidence(support, { contradicted = false } = {}) {
    if (!support || !support.effective) return 0;
    const base = { verified: 0.85, user: 0.7, handler: 0.7, model: 0.3 }[support.strongest] ?? 0;
    // Corroboration from a SECOND independent origin is worth much more than a
    // third from the same one.
    const distinctKinds = Object.keys(support.byOrigin).length;
    const corroboration = Math.min(0.12, 0.06 * (distinctKinds - 1) + 0.02 * Math.max(0, support.effective - distinctKinds));
    const score = Math.min(0.97, base + corroboration);
    // A live contradiction outranks any amount of agreement.
    return contradicted ? Math.min(score, REVIEW_THRESHOLD) : score;
}

/**
 * The gate. Returns promote / review / reject with a stated reason — never a
 * bare boolean, because "why was this not remembered" must be answerable.
 *
 * @returns {{verdict:'promote'|'review'|'reject', confidence, reason, record?}}
 */
export function gate(candidate, observations, { now = 0, contradicted = false } = {}) {
    const text = String(candidate?.text || '').trim();
    if (!text) return { verdict: 'reject', confidence: 0, reason: 'empty text', record: null };

    const type = candidate.type || classify(text);
    if (!type || !TYPES[type]) return { verdict: 'reject', confidence: 0, reason: 'no recognizable type', record: null };

    const support = effectiveSupport(observations);
    if (!support.effective) return { verdict: 'reject', confidence: 0, reason: 'no supported origin', record: null };

    const c = confidence(support, { contradicted });

    /* A model-only claim is NEVER promoted outright, whatever its score. This is
       the specific path that produced a fabricated CVE severity and a $17,500
       bitcoin; letting it write permanent records would make those durable. */
    const modelOnly = support.strongest === 'model';

    let verdict, reason;
    if (contradicted) {
        verdict = 'review';
        reason = 'contradicted by existing memory';
    } else if (modelOnly) {
        verdict = 'review';
        reason = 'model-only claim — needs a verified or user origin before it becomes durable';
    } else if (c >= PROMOTE_THRESHOLD) {
        verdict = 'promote';
        reason = `${support.effective} independent origin${support.effective === 1 ? '' : 's'}, strongest ${support.strongest}`;
    } else if (c >= REVIEW_THRESHOLD) {
        verdict = 'review';
        reason = 'insufficient support to store without a look';
    } else {
        verdict = 'reject';
        reason = 'support too weak';
    }

    return {
        verdict, confidence: +c.toFixed(2), reason,
        support,
        record: verdict === 'promote' ? {
            type, domain: candidate.domain || 'general', text, at: candidate.at || now,
            sources: [...new Set((observations || []).map(o => `${o.origin}:${o.originId ?? 'anon'}`))],
            confidence: +c.toFixed(2),
            supersedes: candidate.supersedes || null,
        } : null,
    };
}

/** Does this candidate contradict something already stored? Lexical and
 *  conservative — it flags for review, it does not overwrite. */
export function findContradiction(store, candidate) {
    const NEG = /\b(not|no longer|never|instead of|replaced|stopped|removed|dropped)\b/i;
    const key = w => new Set(String(w).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(x => x.length > 3));
    const ck = key(candidate?.text);
    if (!ck.size) return null;
    for (const r of store || []) {
        if (r.type !== (candidate.type || classify(candidate.text))) continue;
        const rk = key(r.text);
        let shared = 0;
        for (const w of ck) if (rk.has(w)) shared++;
        const overlap = shared / Math.min(ck.size, rk.size);
        // Same subject, opposite polarity.
        if (overlap >= 0.5 && NEG.test(candidate.text) !== NEG.test(r.text)) return r;
    }
    return null;
}

/** Spoken summary of a gate batch. */
export function describeGate(results) {
    const n = k => (results || []).filter(r => r.verdict === k).length;
    const p = n('promote'), rv = n('review'), rj = n('reject');
    if (!results?.length) return 'Nothing was extracted, Sir.';
    return `Of ${results.length} candidate${results.length === 1 ? '' : 's'}, Sir: ${p} promoted, ${rv} held for review, ${rj} rejected.`;
}

export default {
    ORIGINS, PROMOTE_THRESHOLD, REVIEW_THRESHOLD,
    classify, effectiveSupport, confidence, gate, findContradiction, describeGate,
};
