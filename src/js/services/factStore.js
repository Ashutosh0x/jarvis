// ---------------------------------------------------------------------------
// Belief store — probabilistic, source-aware memory that resists garbled input.
//
// This is a local, pragmatic adaptation of BeliefMem (Liao et al., 2026,
// arXiv:2605.05583): instead of committing each observation to a single
// deterministic fact, it keeps CANDIDATE conclusions per attribute, each with a
// confidence updated by NOISY-OR evidence merge as new observations arrive.
//
// It exists because the live logs showed the old gate-less reflection writing
// STT mis-hearings ("interested in events in Uruguay") into permanent memory.
// Three mechanisms fix that at the root:
//
//   1. SOURCE-WEIGHTED EVIDENCE — a voice/STT observation carries far less
//      evidential weight than typed text or an explicit correction, so garble
//      needs much more corroboration before it can matter.
//   2. NOISY-OR MERGE — confidence rises the way independent evidence actually
//      combines: p' = 1 − (1−p)(1−Δ). A single weak observation barely moves it;
//      repeated corroboration converges it toward (but never to) certainty.
//   3. ATTRIBUTE COMPETITION — "uses Chrome" and "uses Firefox" are competing
//      VALUES of the same attribute (browser). New evidence for one erodes the
//      others, so a genuine preference change is revised rather than stored as a
//      contradiction — and only the winning candidate is ever promoted to the
//      durable RAG.
//
// Facts are archived, never hard-deleted, so history survives.
// ---------------------------------------------------------------------------

const STOP = new Set(['the', 'a', 'an', 'is', 'are', 'to', 'of', 'in', 'on', 'and', 'or',
    'user', 'users', 'their', 'they', 'them', 'his', 'her', 'with', 'for', 'as', 'at',
    'primary', 'currently', 'also', 'who', 'that', 'this', 'has', 'have', 'uses', 'use',
    'prefers', 'prefer', 'preferred', 'preference', 'preferences', 'favorite', 'favourite',
    'likes', 'like']);

function tokenSet(text) {
    return new Set(
        String(text).toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ')
            .split(/\s+/)
            .filter((t) => t.length > 2 && !STOP.has(t))
    );
}

function jaccard(a, b) {
    if (!a.size || !b.size) return 0;
    let inter = 0;
    for (const t of a) if (b.has(t)) inter++;
    return inter / (a.size + b.size - inter);
}

/** Overlap (Szymkiewicz–Simpson) coefficient: |A∩B| / min(|A|,|B|). Recognizes
 *  a short value contained in a longer phrasing ("Chrome" inside "Google
 *  Chrome browser"), which is how the same value gets rephrased across passes. */
function overlap(a, b) {
    if (!a.size || !b.size) return 0;
    let inter = 0;
    for (const t of a) if (b.has(t)) inter++;
    return inter / Math.min(a.size, b.size);
}

/** True when two strings denote the same value/fact. */
function factsMatch(x, y) {
    return overlap(tokenSet(x), tokenSet(y)) >= 0.7;
}

/** Normalize an attribute key so "preferred browser" and "browser preference"
 *  collapse to the same slot (sorted content tokens). */
function normAttr(text) {
    return [...tokenSet(text)].sort().join(' ') || String(text).toLowerCase().trim();
}

// --- BeliefMem-style evidence + tuning -------------------------------------

// How much to trust an observation by its SOURCE. Voice/STT is noisy; an
// explicit user correction is ground truth. Evidence strength Δ is the LLM's
// per-fact confidence scaled by this trust, so a confident voice mis-hearing
// still carries little weight.
const TRUST = { voice: 0.5, text: 0.85, correction: 1.0, api: 0.95, ocr: 0.6, reflection: 0.5, default: 0.6 };

function evidence(prob, source) {
    const p = (typeof prob === 'number' && prob >= 0 && prob <= 1) ? prob : 0.6;
    return Math.max(0.1, Math.min(0.9, p * (TRUST[source] ?? TRUST.default)));
}

/** Noisy-OR merge (BeliefMem Eq. 9): p' = min(1 − (1−p)(1−Δ), 0.99). Capped
 *  below 1 so nothing is ever stored as certain. */
function noisyOr(p, delta) {
    return Math.min(1 - (1 - p) * (1 - delta), 0.99);
}

const MATCH_THRESHOLD = 0.7;   // overlap to count as the SAME value
const EVIDENCE_CAP = 12;       // keep the most recent N observations backing a belief
const COMPETE_DECAY = 0.7;     // a competing observation erodes rival candidates ×0.7
const DECAY_STEP = 0.10;       // per pass a fact goes unconfirmed (after grace)
const DECAY_GRACE_DAYS = 2;
const PROMOTE_OBS = 2;         // corroborated in >= 2 passes
const PROMOTE_CONF = 0.55;     // ...and confident...
const DEMOTE_CONF = 0.30;      // durable fact drops below this -> evict from RAG
const ARCHIVE_CONF = 0.20;
const DAY = 86400000;

class FactStore {
    constructor() {
        this.facts = [];
        this.loaded = false;
    }

    async load() {
        if (this.loaded) return;
        this.loaded = true;
        try {
            const data = await window.electronAPI?.loadFactStore?.();
            this.facts = (data && Array.isArray(data.facts)) ? data.facts : [];
        } catch { this.facts = []; }
    }

    async save() {
        try { await window.electronAPI?.saveFactStore?.({ facts: this.facts }); } catch { /* best effort */ }
    }

    _sameCandidate(attribute, valTok) {
        for (const f of this.facts) {
            if (f.attribute === attribute && overlap(valTok, tokenSet(f.value)) >= MATCH_THRESHOLD) return f;
        }
        return null;
    }

    /**
     * Observe a batch of structured candidate facts from one reflection pass.
     * Each item: { attribute, value, statement, prob }. `opts.source` sets the
     * evidential weight. Returns facts that just crossed INTO durable memory
     * (`promoted`, caller ingests to RAG) or OUT of it (`demoted`, caller
     * evicts). Pure state transition — caller persists via save().
     */
    observe(items, opts = {}) {
        const now = opts.now ?? Date.now();
        const source = opts.source || 'reflection';
        const touched = new Set();

        for (const raw of items) {
            const attribute = normAttr(raw.attribute || raw.statement || raw.value || '');
            const value = String(raw.value ?? raw.statement ?? '').trim();
            const statement = String(raw.statement || `${raw.attribute}: ${raw.value}` || value).trim();
            if (!attribute || statement.length < 6) continue;
            const valTok = tokenSet(value);
            if (!valTok.size) continue;

            const delta = evidence(raw.prob, source);
            const same = this._sameCandidate(attribute, valTok);
            if (same) {
                same.confidence = noisyOr(same.confidence, delta);
                same.timesObserved++;
                same.lastConfirmed = now;
                same.source = same.source || source;
                // PROVENANCE: record which observation backed this belief so it
                // can be explained ("confirmed 3x via voice, last on <date>") and
                // audited. Capped to the most recent N to bound storage.
                (same.evidence = same.evidence || []).push({ source, ts: now, delta });
                if (same.evidence.length > EVIDENCE_CAP) same.evidence = same.evidence.slice(-EVIDENCE_CAP);
                if (statement.length > same.statement.length) same.statement = statement;
                if (same.status === 'archived') same.status = 'provisional';
                touched.add(same.id);
                // Corroborating one value erodes its rivals on the same attribute.
                for (const f of this.facts) {
                    if (f !== same && f.attribute === attribute && f.status !== 'archived') {
                        f.confidence *= COMPETE_DECAY;
                        if (f.confidence < ARCHIVE_CONF) f.status = 'archived';
                    }
                }
            } else {
                const f = {
                    id: `f_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
                    attribute, value, statement,
                    confidence: delta, timesObserved: 1,
                    firstSeen: now, lastConfirmed: now,
                    status: 'provisional', source, inRag: false,
                    evidence: [{ source, ts: now, delta }],
                };
                this.facts.push(f);
                touched.add(f.id);
                // A new competing value mildly erodes existing candidates.
                for (const g of this.facts) {
                    if (g !== f && g.attribute === attribute && g.status !== 'archived') {
                        g.confidence *= (COMPETE_DECAY + 0.15); // gentler than a full corroboration
                    }
                }
            }
        }

        // Decay facts not reconfirmed this pass.
        for (const f of this.facts) {
            if (touched.has(f.id) || f.status === 'archived') continue;
            const ageDays = (now - f.lastConfirmed) / DAY;
            if (ageDays > DECAY_GRACE_DAYS) f.confidence = Math.max(0, f.confidence - DECAY_STEP);
            if (f.confidence < ARCHIVE_CONF) f.status = 'archived';
        }

        // Promotions/demotions, decided PER ATTRIBUTE: only the winning candidate
        // (highest confidence) may be durable, so a revision (Chrome -> Firefox)
        // evicts the old winner and promotes the new one.
        const promoted = [], demoted = [];
        const byAttr = new Map();
        for (const f of this.facts) {
            if (!byAttr.has(f.attribute)) byAttr.set(f.attribute, []);
            byAttr.get(f.attribute).push(f);
        }
        for (const group of byAttr.values()) {
            const active = group.filter((f) => f.status !== 'archived');
            const winner = active.slice().sort((a, b) => b.confidence - a.confidence)[0] || null;
            for (const f of group) {
                const isWinner = f === winner;
                const durableWorthy = isWinner && f.timesObserved >= PROMOTE_OBS && f.confidence >= PROMOTE_CONF;
                if (durableWorthy && !f.inRag) { f.status = 'durable'; promoted.push(f); }
                if (f.inRag && (!isWinner || f.status === 'archived' || f.confidence < DEMOTE_CONF)) {
                    if (f.status === 'durable') f.status = 'provisional';
                    demoted.push(f);
                }
            }
        }
        return { promoted, demoted };
    }

    /** One-time migration of pre-belief RAG facts as low-confidence provisional
     *  candidates (attribute derived from the text), so they face corroboration
     *  going forward and the garbled ones decay out. */
    importProvisional(texts, now = Date.now()) {
        const imported = [];
        for (const raw of texts) {
            const text = String(raw || '').trim();
            if (text.length < 8) continue;
            const attribute = normAttr(text);
            if (this._sameCandidate(attribute, tokenSet(text))) continue;
            const f = {
                id: `f_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
                attribute, value: text, statement: text,
                confidence: 0.30, timesObserved: 1,
                firstSeen: now, lastConfirmed: now,
                status: 'provisional', source: 'reflection', inRag: false,
            };
            this.facts.push(f);
            imported.push(f);
        }
        return imported;
    }

    durableFacts() {
        return this.facts.filter((f) => f.status === 'durable');
    }

    stats() {
        const s = { total: this.facts.length, provisional: 0, durable: 0, archived: 0, attributes: new Set() };
        for (const f of this.facts) { s[f.status] = (s[f.status] || 0) + 1; s.attributes.add(f.attribute); }
        s.attributes = s.attributes.size;
        return s;
    }
}

/** Provenance summary for a belief: how many times it was confirmed, by which
 *  sources, and when last. Powers explainable memory ("I believe this because
 *  you told me 3 times by voice, last on <date>") and the audit trail. */
export function evidenceStats(fact) {
    const ev = fact.evidence || [];
    const bySource = {};
    let lastTs = 0;
    for (const e of ev) {
        bySource[e.source] = (bySource[e.source] || 0) + 1;
        if (e.ts > lastTs) lastTs = e.ts;
    }
    return { count: fact.timesObserved || ev.length, bySource, lastTs, firstSeen: fact.firstSeen || 0 };
}

const factStore = new FactStore();
export default factStore;
// FactStore class exported so tests drive the REAL observe() logic (it is pure —
// no I/O — as long as load()/save() are not called), rather than a mirror.
export { FactStore, tokenSet, jaccard, overlap, factsMatch, noisyOr, evidence, normAttr };
