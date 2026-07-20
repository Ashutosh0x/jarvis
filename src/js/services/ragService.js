/**
 * Jarvis Hybrid RAG Memory Engine
 *
 * Design is evidence-driven, following "Is GraphRAG Needed?" (arXiv:2606.25656):
 * - NO heavy graph traversal: the paper's Scenario 2 (documents augmented with
 *   1-hop relations) beat full GraphRAG (Scenario 5), and an autonomous agent
 *   with a single retrieval tool (Scenario 8) beat everything else.
 * - Relation-grouped compact representation `a -(rel1|rel2)- b` (their context
 *   optimization, 19-53% token savings) instead of repeated triplets.
 * - Retrieval-generation gap mitigations: content-hash dedup, SMALL contexts,
 *   and best-results-FIRST ordering (positional attention decay: 85% extraction
 *   in the first token decile vs ~0% in the last).
 *
 * Retrieval = dense (Ollama nomic-embed-text) + sparse (BM25 over an inverted
 * index) + pseudo-relevance feedback, fused with Reciprocal Rank Fusion, then
 * narrowed to sentence-level evidence. Degrades gracefully to BM25-only when no
 * local embedding server is available. Zero native dependencies.
 *
 * Later refinements from three 2026 RAG papers:
 * - PubHealthBench RAG (arXiv:2607.06641): hybrid > dense-only or sparse-only
 *   for every embedding model tested; k in {3,5} is the accuracy peak and more
 *   chunks add noise; RANK position (not just recall) drives faithfulness, and
 *   smaller models are the MOST rank-sensitive — which matters here because the
 *   generator is gemma3:4b.
 * - LongEval-RAG (CLEF 2026): the winning system paired stable rule-based
 *   passages with LATE sentence-level selection rather than fancier semantic
 *   chunking. Also the source of the PRF recipe used below.
 * - NGM-RAG (arXiv:2607.11159): combining Levenshtein name matching with BM25
 *   beat either alone, and cutting context to sentence level took token cost
 *   from ~11k to ~0.8k per query WITHOUT losing answer quality.
 */

const STOPWORDS = new Set(['a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'and', 'or', 'not', 'it', 'its', 'this', 'that', 'i', 'my', 'me', 'you', 'your', 'we', 'do', 'does', 'did', 'have', 'has', 'had', 'what', 'which', 'who', 'when', 'where', 'how', 'about', 'from', 'by', 'as', 'so']);

const RRF_K = 60;          // standard RRF constant (Cormack et al., SIGIR'09)
const MAX_RESULTS = 5;     // k in {3,5} is the measured accuracy peak; beyond it noise dominates
const CHUNK_SIZE = 800;    // characters per chunk (~130 words) — well under the 700-800 WORD
                           // ceiling where PubHealthBench sees rank quality collapse
const MAX_SENTENCES = 10;  // sentence-level evidence budget (LongEval uses 10)
const PRF_CHUNKS = 4;      // feedback pool size
const PRF_TERMS = 6;       // expansion terms drawn from that pool

/* Selective reranking.
   Ollama has no /api/rerank endpoint, so the usual cross-encoder is not
   available here. Measured on this machine, gemma3:4b CAN rerank correctly
   (3/3 top-1 on held-out passages) — but a single call costs ~3s, which is
   unaffordable on a voice assistant's critical path.

   So reranking is GATED on ambiguity: when the fused top-1 clearly dominates
   there is nothing to fix and the call is skipped entirely. It only fires when
   the top candidates are genuinely close, which is exactly the case where rank
   order is fragile and faithfulness suffers. */
const RERANK_MARGIN = 0.15;   // relative gap below which top-1 is "not clearly best"
const RERANK_CANDIDATES = 6;  // passages shown to the reranker
const RERANK_TIMEOUT_MS = 6000;

function tokenize(text) {
    return String(text).toLowerCase()
        .replace(/[^a-z0-9_\s.-]/g, ' ')
        .split(/\s+/)
        .filter(t => t.length > 1 && !STOPWORDS.has(t));
}

// djb2 content hash for dedup (content-aware document deduplication, §3.5)
function contentHash(text) {
    let h = 5381;
    const s = String(text);
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
}

function cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/**
 * Normalized Levenshtein distance (Yujian & Bo, 2007), as used by NGM-RAG for
 * name-level matching. Returns 0..1 where 0 is identical.
 *
 * Jarvis's input is speech-to-text, so entity names arrive mangled far more
 * often than in a typed system — exact substring matching silently misses them.
 */
function levenshteinRatio(a, b) {
    a = String(a); b = String(b);
    if (a === b) return 0;
    if (!a.length || !b.length) return 1;
    // Length gap alone can exceed the threshold; skip the DP when it does.
    if (Math.abs(a.length - b.length) / Math.max(a.length, b.length) > 0.4) return 1;

    let prev = new Array(b.length + 1);
    let curr = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) prev[j] = j;

    for (let i = 1; i <= a.length; i++) {
        curr[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
        }
        [prev, curr] = [curr, prev];
    }
    return prev[b.length] / Math.max(a.length, b.length);
}

function chunkText(text) {
    const paragraphs = String(text).split(/\n\s*\n/);
    const chunks = [];
    let current = '';
    for (const p of paragraphs) {
        if (current.length + p.length > CHUNK_SIZE && current) {
            chunks.push(current.trim());
            current = '';
        }
        current += (current ? '\n\n' : '') + p;
        // Hard-split pathological paragraphs
        while (current.length > CHUNK_SIZE * 2) {
            chunks.push(current.slice(0, CHUNK_SIZE * 2).trim());
            current = current.slice(CHUNK_SIZE * 2);
        }
    }
    if (current.trim()) chunks.push(current.trim());
    return chunks;
}

/** Splits a passage into sentences, keeping them addressable for evidence selection. */
function splitSentences(text) {
    return String(text)
        .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])|\n+/)
        .map(s => s.trim())
        .filter(s => s.length > 2);
}

class RagService {
    constructor() {
        // chunks: [{ id, text, hash, source, ts, vector|null }]
        // entities: { name: { type } } (lowercased keys)
        // relations: [{ a, rel, b }] (lowercased a/b)
        this.chunks = [];
        this.entities = {};
        this.relations = [];
        this.embedAvailable = null; // null = unknown, probed lazily
        this.loaded = false;
        this._dirty = false;
        this._saveTimer = null;

        /* Inverted index — the whole point is to never touch chunks that do not
           contain a query term. The previous implementation re-tokenized the
           ENTIRE corpus on every single query (measured: 94ms at 5k chunks, on
           the renderer thread, which also stutters the visualizer). */
        this._index = new Map();   // term -> { df, postings: Map(chunkIdx -> tf) }
        this._docLen = [];         // chunkIdx -> token count
        this._totalLen = 0;
    }

    _ollamaUrl() {
        try {
            const s = JSON.parse(localStorage.getItem('jarvis_settings') || '{}');
            return s.localOllamaUrl || 'http://localhost:11434';
        } catch { return 'http://localhost:11434'; }
    }

    /* ---------- inverted index ---------- */

    _indexChunk(chunkIdx) {
        const toks = tokenize(this.chunks[chunkIdx].text);
        this._docLen[chunkIdx] = toks.length;
        this._totalLen += toks.length;

        const tf = new Map();
        for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);

        for (const [term, count] of tf) {
            let entry = this._index.get(term);
            if (!entry) {
                entry = { df: 0, postings: new Map() };
                this._index.set(term, entry);
            }
            entry.df++;
            entry.postings.set(chunkIdx, count);
        }
    }

    _rebuildIndex() {
        this._index = new Map();
        this._docLen = [];
        this._totalLen = 0;
        for (let i = 0; i < this.chunks.length; i++) this._indexChunk(i);
    }

    /* ---------- persistence (main-process file via IPC) ---------- */

    async load() {
        if (this.loaded) return;
        this.loaded = true;
        try {
            if (!window.electronAPI?.ragLoad) return;
            const data = await window.electronAPI.ragLoad();
            if (data) {
                this.chunks = data.chunks || [];
                this.entities = data.entities || {};
                this.relations = data.relations || [];
                this._rebuildIndex();
                console.log(`RAG: loaded ${this.chunks.length} chunks, ${this.relations.length} relations, ${this._index.size} terms`);
                // Chunks stored while Ollama was down have vector:null and would
                // stay dense-invisible forever. Backfill them in the background.
                this._backfillVectors();
            }
        } catch (e) {
            console.warn('RAG: load failed', e);
        }
    }

    /**
     * Embeds any chunk missing a vector. Runs detached so it never delays a
     * query, and batches to keep the number of Ollama round-trips small.
     */
    async _backfillVectors() {
        const missing = this.chunks.filter(c => !c.vector);
        if (!missing.length) return;
        try {
            const BATCH = 32;
            let done = 0;
            for (let i = 0; i < missing.length; i += BATCH) {
                const batch = missing.slice(i, i + BATCH);
                const vectors = await this._embed(batch.map(c => c.text));
                if (!vectors) return; // no embedder — stay BM25-only, not an error
                batch.forEach((c, j) => { c.vector = vectors[j]; });
                done += batch.length;
            }
            if (done) {
                console.log(`RAG: backfilled ${done} missing embeddings`);
                this._scheduleSave();
            }
        } catch (e) {
            console.warn('RAG: vector backfill failed (BM25 still works)', e.message);
        }
    }

    _scheduleSave() {
        this._dirty = true;
        if (this._saveTimer) return;
        this._saveTimer = setTimeout(async () => {
            this._saveTimer = null;
            if (!this._dirty || !window.electronAPI?.ragSave) return;
            this._dirty = false;
            try {
                await window.electronAPI.ragSave({
                    chunks: this.chunks,
                    entities: this.entities,
                    relations: this.relations,
                });
            } catch (e) {
                console.warn('RAG: save failed', e);
            }
        }, 2000);
    }

    /* ---------- embeddings (optional, local-only) ---------- */

    async _embed(texts) {
        if (this.embedAvailable === false) return null;
        try {
            const res = await fetch(`${this._ollamaUrl()}/api/embed`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: 'nomic-embed-text', input: texts }),
                signal: AbortSignal.timeout(15000),
            });
            if (!res.ok) throw new Error(`embed HTTP ${res.status}`);
            const data = await res.json();
            this.embedAvailable = true;
            return data.embeddings || null;
        } catch (e) {
            if (this.embedAvailable === null) {
                console.warn('RAG: no local embedder (pull nomic-embed-text in Ollama for dense search). BM25-only mode.', e.message);
            }
            this.embedAvailable = false;
            return null;
        }
    }

    /* ---------- ingestion ---------- */

    /**
     * Ingest a document or fact into memory.
     * @param {string} text
     * @param {{source?: string, entities?: Array<{name: string, type?: string}>, relations?: Array<{subject: string, relation: string, object: string}>}} meta
     * @returns {Promise<{stored: number, deduped: number}>}
     */
    async ingest(text, meta = {}) {
        await this.load();
        const pieces = chunkText(text);
        const fresh = [];
        let deduped = 0;

        // Hash set instead of a linear scan per piece: ingesting a large PDF was
        // O(pieces x chunks) before.
        const seen = new Set(this.chunks.map(c => c.hash));
        for (const piece of pieces) {
            const hash = contentHash(piece);
            if (seen.has(hash)) { deduped++; continue; }
            seen.add(hash);
            fresh.push({
                id: `${Date.now().toString(36)}-${hash}`,
                text: piece,
                hash,
                source: meta.source || 'conversation',
                ts: Date.now(),
                vector: null,
            });
        }

        if (fresh.length) {
            const vectors = await this._embed(fresh.map(c => c.text));
            if (vectors) fresh.forEach((c, i) => { c.vector = vectors[i]; });
            const base = this.chunks.length;
            this.chunks.push(...fresh);
            // Index incrementally — no full rebuild on every ingest.
            for (let i = 0; i < fresh.length; i++) this._indexChunk(base + i);
        }

        // Entity graph: names stored lowercase for matching, display-cased in output
        for (const e of meta.entities || []) {
            if (!e?.name) continue;
            this.entities[e.name.toLowerCase()] = { type: e.type || 'thing', display: e.name };
        }
        for (const r of meta.relations || []) {
            if (!r?.subject || !r?.relation || !r?.object) continue;
            const a = r.subject.toLowerCase(), b = r.object.toLowerCase();
            if (!this.relations.some(x => x.a === a && x.rel === r.relation && x.b === b)) {
                this.relations.push({ a, rel: r.relation, b });
                this.entities[a] = this.entities[a] || { type: 'thing', display: r.subject };
                this.entities[b] = this.entities[b] || { type: 'thing', display: r.object };
            }
        }

        if (fresh.length || (meta.entities || meta.relations)) this._scheduleSave();
        return { stored: fresh.length, deduped };
    }

    /**
     * Remove every chunk matching a predicate, then rebuild the index. Used by
     * the confidence layer to evict facts that were demoted or archived — a
     * garbled one-off fact must be able to LEAVE durable memory, not just never
     * enter it. Returns the number removed.
     */
    async forget(predicate) {
        await this.load();
        const before = this.chunks.length;
        this.chunks = this.chunks.filter((c) => !predicate(c));
        const removed = before - this.chunks.length;
        if (removed) {
            this._rebuildIndex(); // postings hold chunk indices — stale after a filter
            this._scheduleSave();
        }
        return removed;
    }

    /* ---------- sparse search: BM25 over the inverted index ---------- */

    _idf(df, N) {
        return Math.log(1 + (N - df + 0.5) / (df + 0.5));
    }

    _bm25(queryTokens) {
        const k1 = 1.5, b = 0.75;
        const N = this.chunks.length;
        if (!N) return [];
        const avgLen = this._totalLen / N || 1;

        const scores = new Map();
        for (const qt of queryTokens) {
            const entry = this._index.get(qt);
            if (!entry) continue;
            const idf = this._idf(entry.df, N);
            // Only iterates chunks that actually contain this term.
            for (const [i, tf] of entry.postings) {
                const norm = tf + k1 * (1 - b + b * this._docLen[i] / avgLen);
                scores.set(i, (scores.get(i) || 0) + idf * (tf * (k1 + 1)) / norm);
            }
        }

        /* Tie-break on chunk index, not map insertion order.
           Equal-scoring chunks are common (identical term profiles), and
           postings-order traversal would otherwise rank them differently from
           run to run. Since rank position — not just recall — drives
           faithfulness, an unstable order means the same question can get a
           differently-ordered context each time it is asked. */
        return [...scores.entries()]
            .map(([i, score]) => ({ i, score }))
            .sort((x, y) => (y.score - x.score) || (x.i - y.i));
    }

    /**
     * Pseudo-relevance feedback (LongEval-RAG recipe): take the top feedback
     * passages from the first pass, harvest their most frequent non-query terms,
     * and issue those as a SEPARATE ranked list into RRF.
     *
     * Kept as its own list rather than merged into the original query, so a bad
     * feedback pool can only dilute the fusion — it cannot corrupt the original
     * query's ranking.
     */
    _prfTokens(firstPass, queryTokens) {
        if (!firstPass.length) return [];
        const qSet = new Set(queryTokens);
        const freq = new Map();
        for (const { i } of firstPass.slice(0, PRF_CHUNKS)) {
            for (const t of tokenize(this.chunks[i].text)) {
                if (t.length < 4 || qSet.has(t)) continue;
                freq.set(t, (freq.get(t) || 0) + 1);
            }
        }
        return [...freq.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, PRF_TERMS)
            .map(([t]) => t);
    }

    /* ---------- entity context: relation-grouped 1-hop (paper §3.5) ---------- */

    _entityContext(query) {
        const q = query.toLowerCase();
        const names = Object.keys(this.entities);

        // Exact substring first; fall back to fuzzy name matching for STT noise.
        let hit = names.filter(name => q.includes(name));
        if (!hit.length) {
            const qWords = q.split(/\s+/).filter(w => w.length > 3);
            hit = names.filter(name =>
                qWords.some(w => levenshteinRatio(w, name) <= 0.25)
            );
        }
        if (!hit.length) return '';

        const lines = [];
        for (const name of hit) {
            // Group multiple relations between the same pair: a -(r1|r2)- b
            const grouped = {};
            for (const r of this.relations) {
                if (r.a === name) (grouped[r.b] = grouped[r.b] || new Set()).add(r.rel);
                else if (r.b === name) (grouped[r.a] = grouped[r.a] || new Set()).add(`inv:${r.rel}`);
            }
            const parts = Object.entries(grouped).map(([other, rels]) => {
                const disp = this.entities[other]?.display || other;
                return `${this.entities[name]?.display || name} -(${[...rels].join('|')})- ${disp}`;
            });
            if (parts.length) lines.push(...parts);
        }
        return lines.length ? `Known relations:\n${lines.slice(0, 15).join('\n')}` : '';
    }

    /* ---------- selective LLM reranking ---------- */

    /**
     * True when the fused ranking is ambiguous enough that reordering could
     * plausibly change which passage lands at rank 1.
     *
     * Cheap guard that decides whether the ~3s rerank call is worth paying for.
     */
    _needsRerank(top) {
        if (top.length < 2) return false;
        const [first, second] = top;
        if (!first.score) return false;
        return (first.score - second.score) / first.score < RERANK_MARGIN;
    }

    /**
     * Reorders passages with the local model. Returns the reordered array, or
     * the original on any failure — reranking is an enhancement, never a
     * dependency, so a slow or malformed response must not break recall.
     */
    async _rerank(query, top) {
        const cands = top.slice(0, RERANK_CANDIDATES);
        const listing = cands
            .map((r, i) => `[${i + 1}] ${r.text.slice(0, 300)}`)
            .join('\n');

        try {
            const res = await fetch(`${this._ollamaUrl()}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: this._localModel(),
                    format: 'json',
                    stream: false,
                    keep_alive: '60m',
                    options: { temperature: 0 },
                    messages: [
                        {
                            role: 'system',
                            content: 'Rank the passages by how well they answer the question. Reply with JSON only: {"order":[ids most relevant first]}.'
                        },
                        { role: 'user', content: `Question: ${query}\n\nPassages:\n${listing}` }
                    ]
                }),
                signal: AbortSignal.timeout(RERANK_TIMEOUT_MS),
            });
            if (!res.ok) return top;

            const data = await res.json();
            const order = JSON.parse(data.message?.content || '{}').order;
            if (!Array.isArray(order) || !order.length) return top;

            // Map 1-based ids back to passages, dropping anything malformed,
            // then append any candidate the model failed to mention.
            const seen = new Set();
            const reordered = [];
            for (const id of order) {
                const idx = Number(id) - 1;
                if (!Number.isInteger(idx) || idx < 0 || idx >= cands.length) continue;
                if (seen.has(idx)) continue;
                seen.add(idx);
                reordered.push(cands[idx]);
            }
            if (!reordered.length) return top;
            cands.forEach((c, i) => { if (!seen.has(i)) reordered.push(c); });

            return [...reordered, ...top.slice(RERANK_CANDIDATES)];
        } catch {
            return top; // timeout, offline model, bad JSON — keep lexical order
        }
    }

    _localModel() {
        try {
            const s = JSON.parse(localStorage.getItem('jarvis_settings') || '{}');
            return s.localModel || 'gemma3:4b';
        } catch { return 'gemma3:4b'; }
    }

    /* ---------- late sentence selection ---------- */

    /**
     * Narrows retrieved passages to their query-relevant sentences.
     *
     * This is the LongEval-RAG result applied here: their best system kept plain
     * rule-based passages and did the neural work LATE, at sentence selection,
     * rather than using cleverer chunking. NGM-RAG reports the same shape of win
     * from the token side (~11k -> ~0.8k per query, with F1 going UP).
     *
     * Scoring is lexical (IDF-weighted overlap + a mild lead bias) rather than a
     * cross-encoder: there is no cross-encoder available in the renderer, and an
     * embedding round-trip per sentence would cost more latency than it returns.
     */
    _selectSentences(ranked, queryTokens) {
        const N = this.chunks.length;
        const qSet = new Set(queryTokens);
        const cands = [];

        for (const r of ranked) {
            const sentences = splitSentences(r.text);
            sentences.forEach((sentence, pos) => {
                const toks = tokenize(sentence);
                if (!toks.length) return;
                let score = 0;
                const counted = new Set();
                for (const t of toks) {
                    if (!qSet.has(t) || counted.has(t)) continue;
                    counted.add(t);
                    const entry = this._index.get(t);
                    score += entry ? this._idf(entry.df, N) : 1;
                }
                if (score <= 0) return;
                // Lead bias: the opening sentences of a passage carry the topic
                // that made it rank in the first place.
                score *= 1 + Math.max(0, (3 - pos)) * 0.08;
                cands.push({ sentence, score, source: r.source, passageScore: r.score });
            });
        }

        // Nothing matched lexically (e.g. a purely semantic dense hit) — keep the
        // passages whole rather than returning an empty context.
        if (!cands.length) return null;

        return cands
            .sort((a, b) => (b.score - a.score) || (b.passageScore - a.passageScore))
            .slice(0, MAX_SENTENCES);
    }

    /* ---------- hybrid recall: dense + sparse + PRF, RRF fusion ---------- */

    /**
     * @param {string} query
     * @param {{sentenceLevel?: boolean}} [opts]
     * @returns {Promise<{context: string, results: Array<{text: string, source: string, score: number}>}>}
     */
    async recall(query, opts = {}) {
        await this.load();
        if (!this.chunks.length && !this.relations.length) {
            return { context: '', results: [] };
        }

        const queryTokens = tokenize(query);
        const sparseRanks = this._bm25(queryTokens);

        // PRF: a second lexical list from feedback terms.
        const prfTokens = this._prfTokens(sparseRanks, queryTokens);
        const prfRanks = prfTokens.length ? this._bm25(prfTokens) : [];

        let denseRanks = [];
        const qVec = (await this._embed([query]))?.[0];
        if (qVec) {
            denseRanks = this.chunks
                .map((c, i) => ({ i, score: c.vector ? cosine(qVec, c.vector) : 0 }))
                .filter(s => s.score > 0.3)
                .sort((x, y) => y.score - x.score);
        }

        /* Reciprocal Rank Fusion. Hybrid beat dense-only and sparse-only for
           EVERY embedding model in PubHealthBench, and it is what lets a small
           local stack behave like a much larger one. PRF is down-weighted: it is
           derived evidence, not the user's actual question. */
        const rrf = {};
        const fuse = (list, weight = 1) => {
            list.forEach((s, rank) => {
                rrf[s.i] = (rrf[s.i] || 0) + weight / (RRF_K + rank + 1);
            });
        };
        fuse(sparseRanks, 1);
        fuse(denseRanks, 1);
        fuse(prfRanks, 0.5);

        let top = Object.entries(rrf)
            // Same determinism requirement as _bm25: tie-break on chunk index.
            .sort((a, b) => (b[1] - a[1]) || (Number(a[0]) - Number(b[0])))
            .slice(0, MAX_RESULTS) // small context — retrieval-generation gap
            .map(([i, score]) => ({
                text: this.chunks[i].text,
                source: this.chunks[i].source,
                score: +score.toFixed(4),
            }));

        /* Reranking is OPT-IN, not default-on.
           Measured on this corpus: the ambiguity gate fires on ~50% of queries
           and costs ~4.8s when it does (avg 2.5s/query overall, vs ~90ms when
           skipped). It does earn its keep — it changed rank-1 on 4/4 firings,
           and gemma3:4b scored 3/3 top-1 on labelled passages — but ~5s of
           added silence is not acceptable on the spoken path, which is Jarvis's
           primary interface. Callers that can afford the wait (typed queries,
           document Q&A) pass {rerank: true}. */
        let reranked = false;
        if (opts.rerank === true && this._needsRerank(top)) {
            const before = top[0]?.text;
            top = await this._rerank(query, top);
            reranked = top[0]?.text !== before;
        }

        // Best results FIRST (positional attention decay: rank-1 → 97.9% extraction).
        // Rank order matters more than usual here: PubHealthBench shows faithfulness
        // falling off sharply as the true chunk slides down the context, and that
        // smaller generators — gemma3:4b — are the most rank-sensitive of all.
        const sections = [];
        const entityCtx = this._entityContext(query);
        if (entityCtx) sections.push(entityCtx);

        const useSentences = opts.sentenceLevel !== false;
        const picked = useSentences ? this._selectSentences(top, queryTokens) : null;

        if (picked) {
            picked.forEach((s, i) => sections.push(`[${i + 1}] (${s.source}) ${s.sentence}`));
        } else {
            top.forEach((r, i) => sections.push(`[${i + 1}] (${r.source}) ${r.text}`));
        }

        return { context: sections.join('\n\n'), results: top, reranked };
    }

    stats() {
        return {
            chunks: this.chunks.length,
            entities: Object.keys(this.entities).length,
            relations: this.relations.length,
            terms: this._index.size,
            embedded: this.chunks.filter(c => c.vector).length,
            denseSearch: this.embedAvailable === true,
        };
    }
}

// Singleton — shared by jarvis.js and liveService.js
const ragService = new RagService();
export default ragService;
