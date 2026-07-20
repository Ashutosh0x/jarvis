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
 * Retrieval = dense (Ollama nomic-embed-text) + sparse (pure-JS BM25),
 * fused with Reciprocal Rank Fusion. Degrades gracefully to BM25-only
 * when no local embedding server is available. Zero native dependencies.
 */

const STOPWORDS = new Set(['a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'and', 'or', 'not', 'it', 'its', 'this', 'that', 'i', 'my', 'me', 'you', 'your', 'we', 'do', 'does', 'did', 'have', 'has', 'had', 'what', 'which', 'who', 'when', 'where', 'how', 'about', 'from', 'by', 'as', 'so']);

const RRF_K = 60;          // standard RRF constant
const MAX_RESULTS = 5;     // small context: the paper shows more retrieval ≠ better generation
const CHUNK_SIZE = 800;    // characters per chunk, split on paragraph boundaries

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
    }

    _ollamaUrl() {
        try {
            const s = JSON.parse(localStorage.getItem('jarvis_settings') || '{}');
            return s.localOllamaUrl || 'http://localhost:11434';
        } catch { return 'http://localhost:11434'; }
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
                console.log(`RAG: loaded ${this.chunks.length} chunks, ${this.relations.length} relations`);
            }
        } catch (e) {
            console.warn('RAG: load failed', e);
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

        for (const piece of pieces) {
            const hash = contentHash(piece);
            if (this.chunks.some(c => c.hash === hash)) { deduped++; continue; }
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
            this.chunks.push(...fresh);
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

    /* ---------- sparse search: BM25 ---------- */

    _bm25(queryTokens) {
        const k1 = 1.5, b = 0.75;
        const N = this.chunks.length;
        if (!N) return [];
        const docTokens = this.chunks.map(c => tokenize(c.text));
        const avgLen = docTokens.reduce((s, t) => s + t.length, 0) / N || 1;

        // document frequency per query token
        const df = {};
        for (const qt of queryTokens) {
            df[qt] = docTokens.reduce((s, toks) => s + (toks.includes(qt) ? 1 : 0), 0);
        }

        const scores = this.chunks.map((chunk, i) => {
            const toks = docTokens[i];
            let score = 0;
            for (const qt of queryTokens) {
                if (!df[qt]) continue;
                const tf = toks.filter(t => t === qt).length;
                if (!tf) continue;
                const idf = Math.log(1 + (N - df[qt] + 0.5) / (df[qt] + 0.5));
                score += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * toks.length / avgLen));
            }
            return { i, score };
        });
        return scores.filter(s => s.score > 0).sort((x, y) => y.score - x.score);
    }

    /* ---------- entity context: relation-grouped 1-hop (paper §3.5) ---------- */

    _entityContext(query) {
        const q = query.toLowerCase();
        const hit = Object.keys(this.entities).filter(name => q.includes(name));
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

    /* ---------- hybrid recall: dense + sparse, RRF fusion ---------- */

    /**
     * @param {string} query
     * @returns {Promise<{context: string, results: Array<{text: string, source: string, score: number}>}>}
     */
    async recall(query) {
        await this.load();
        if (!this.chunks.length && !this.relations.length) {
            return { context: '', results: [] };
        }

        const sparseRanks = this._bm25(tokenize(query));

        let denseRanks = [];
        const qVec = (await this._embed([query]))?.[0];
        if (qVec) {
            denseRanks = this.chunks
                .map((c, i) => ({ i, score: c.vector ? cosine(qVec, c.vector) : 0 }))
                .filter(s => s.score > 0.3)
                .sort((x, y) => y.score - x.score);
        }

        // Reciprocal Rank Fusion
        const rrf = {};
        sparseRanks.forEach((s, rank) => { rrf[s.i] = (rrf[s.i] || 0) + 1 / (RRF_K + rank + 1); });
        denseRanks.forEach((s, rank) => { rrf[s.i] = (rrf[s.i] || 0) + 1 / (RRF_K + rank + 1); });

        const top = Object.entries(rrf)
            .sort((a, b) => b[1] - a[1])
            .slice(0, MAX_RESULTS) // small context — retrieval-generation gap
            .map(([i, score]) => ({
                text: this.chunks[i].text,
                source: this.chunks[i].source,
                score: +score.toFixed(4),
            }));

        // Best results FIRST (positional attention decay: rank-1 → 97.9% extraction)
        const sections = [];
        const entityCtx = this._entityContext(query);
        if (entityCtx) sections.push(entityCtx);
        top.forEach((r, i) => sections.push(`[${i + 1}] (${r.source}) ${r.text}`));

        return { context: sections.join('\n\n'), results: top };
    }

    stats() {
        return {
            chunks: this.chunks.length,
            entities: Object.keys(this.entities).length,
            relations: this.relations.length,
            denseSearch: this.embedAvailable === true,
        };
    }
}

// Singleton — shared by jarvis.js and liveService.js
const ragService = new RagService();
export default ragService;
