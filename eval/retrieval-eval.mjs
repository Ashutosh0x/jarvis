/**
 * RETRIEVAL EVALUATION — does the retrieval stack actually retrieve better?
 *
 * The architecture makes claims: hybrid beats lexical alone, PRF helps, dense
 * carries paraphrase, reranking earns its latency. Until now those claims came
 * from papers and from spot checks. This measures them, on this machine, with
 * this embedding model, against a labelled set (eval/corpus.mjs).
 *
 * It drives the REAL ragService — the same code the assistant runs — through
 * the ablation switches on recall(). A benchmark that reimplements the ranker
 * measures the reimplementation.
 *
 * Run:  node eval/retrieval-eval.mjs
 * Needs Ollama with nomic-embed-text for the dense configurations. Without it,
 * the dense rows are reported as unavailable rather than silently scored as
 * lexical, which would fake a result.
 */

import { DOCS, QUESTIONS } from './corpus.mjs';

/* --- browser stubs: ragService is a renderer module ------------------------ */
const store = { chunks: [], entities: {}, relations: [] };
globalThis.window = {
    electronAPI: {
        ragLoad: async () => null,          // start empty; the harness ingests
        ragSave: async (d) => { Object.assign(store, d); },
        logMemoryEvent: async () => {},
    },
    localStorage: { getItem: () => null, setItem() {} },
    addEventListener() {},
};
globalThis.localStorage = window.localStorage;
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node' }, configurable: true });

const { default: rag } = await import('../src/js/services/ragService.js');

/* --- ingest the corpus ----------------------------------------------------- */
const t0 = Date.now();
for (const d of DOCS) await rag.ingest(d.text, { source: d.source, id: d.id });
const stats = rag.stats();
console.log(`corpus: ${DOCS.length} documents -> ${stats.chunks} chunks, ${stats.vectors ?? '?'} embedded (${Date.now() - t0}ms)`);

const embedderUp = rag.embedAvailable !== false && rag.chunks.some(c => c.vector);
console.log(`embedder: ${embedderUp ? 'available (nomic-embed-text)' : 'UNAVAILABLE — dense rows will be skipped, not faked'}\n`);

/* --- scoring ---------------------------------------------------------------
   The label is a document id; chunks carry it through ingest metadata. A hit
   is the labelled document appearing at rank <= k. MRR uses the first hit,
   which is the metric that matters here: rank-1 extraction is ~98% and falls
   off sharply below that, so "in the top 5 somewhere" is not success. */
/* recall() returns chunk text, not the ingest metadata, so results are mapped
   back to document ids by their text. Exact-prefix matching, so a chunk can
   only ever resolve to the document it came from. */
const TEXT_TO_ID = new Map(DOCS.map(d => [d.text.trim(), d.id]));
function idOf(text) {
    const t = String(text || '').trim();
    /* An empty string matches EVERY document: "anything".startsWith("") is true
       in JavaScript, so a missing or blank result would silently resolve to
       whichever document happens to be first in the map — turning a retrieval
       failure into a scored hit whenever that document was the labelled answer.
       A benchmark that flatters itself is worse than no benchmark. */
    if (!t) return null;
    if (TEXT_TO_ID.has(t)) return TEXT_TO_ID.get(t);
    for (const [docText, id] of TEXT_TO_ID) if (docText.startsWith(t) || t.startsWith(docText)) return id;
    return null;
}
function scoreRun(results, answerId) {
    const idx = results.findIndex(r => idOf(r.text) === answerId);
    return { rank: idx < 0 ? null : idx + 1 };
}

const CONFIGS = [
    { name: 'lexical only (BM25)', opts: { ablate: { dense: false, prf: false } }, needsEmbedder: false },
    { name: 'lexical + PRF', opts: { ablate: { dense: false } }, needsEmbedder: false },
    { name: 'dense only', opts: { ablate: { sparse: false, prf: false } }, needsEmbedder: true },
    { name: 'hybrid (shipped default)', opts: {}, needsEmbedder: true },
    { name: 'hybrid + rerank (typed path)', opts: { rerank: true }, needsEmbedder: true },
    // Fusion-weight sweep. The shipped default weights the two retrievers
    // roughly equally; if dense-only wins outright, that equality is costing
    // accuracy and the sweep will show where the crossover is.
    { name: 'fusion 1.0/1.5/0.5', opts: { weights: { sparse: 1.0, dense: 1.5, prf: 0.5 } }, needsEmbedder: true },
    { name: 'fusion 1.0/2.0/0.5', opts: { weights: { sparse: 1.0, dense: 2.0, prf: 0.5 } }, needsEmbedder: true },
    { name: 'fusion 0.5/2.0/0.25', opts: { weights: { sparse: 0.5, dense: 2.0, prf: 0.25 } }, needsEmbedder: true },
    { name: 'fusion 0.5/3.0/0.25', opts: { weights: { sparse: 0.5, dense: 3.0, prf: 0.25 } }, needsEmbedder: true },
];

const results = [];
for (const cfg of CONFIGS) {
    if (cfg.needsEmbedder && !embedderUp) {
        results.push({ name: cfg.name, skipped: true });
        continue;
    }
    let hit1 = 0, hit3 = 0, hit5 = 0, mrrSum = 0, totalMs = 0;
    const byKind = {};
    const misses = [];

    for (const item of QUESTIONS) {
        const t = Date.now();
        const { results: top } = await rag.recall(item.q, cfg.opts);
        const ms = Date.now() - t;
        totalMs += ms;

        const { rank } = scoreRun(top, item.answer);
        const k = (byKind[item.kind] = byKind[item.kind] || { n: 0, hit1: 0, hit3: 0 });
        k.n++;
        if (rank === 1) { hit1++; k.hit1++; }
        if (rank && rank <= 3) { hit3++; k.hit3++; }
        if (rank && rank <= 5) hit5++;
        if (rank) mrrSum += 1 / rank;
        if (!rank || rank > 3) misses.push({ q: item.q, kind: item.kind, rank, got: idOf(top[0]?.text) || top[0]?.text?.slice(0, 40) || 'nothing' });
    }

    const n = QUESTIONS.length;
    results.push({
        name: cfg.name,
        p1: (hit1 / n) * 100, p3: (hit3 / n) * 100, p5: (hit5 / n) * 100,
        mrr: mrrSum / n, msPerQuery: totalMs / n, byKind, misses,
    });
}

/* --- report ---------------------------------------------------------------- */
const pad = (s, w) => String(s).padEnd(w);
const num = (v, d = 1) => v.toFixed(d).padStart(6);

console.log(`${pad('configuration', 30)} ${pad('P@1', 7)} ${pad('P@3', 7)} ${pad('P@5', 7)} ${pad('MRR', 7)} ms/query`);
console.log('-'.repeat(72));
for (const r of results) {
    if (r.skipped) { console.log(`${pad(r.name, 30)} skipped (no embedder)`); continue; }
    console.log(`${pad(r.name, 30)} ${num(r.p1)}% ${num(r.p3)}% ${num(r.p5)}% ${num(r.mrr, 3)}  ${Math.round(r.msPerQuery)}`);
}

const shipped = results.find(r => r.name.startsWith('hybrid (shipped'));
const lexical = results.find(r => r.name.startsWith('lexical only'));
if (shipped && lexical && !shipped.skipped) {
    const delta = shipped.p1 - lexical.p1;
    console.log(`\nhybrid vs lexical-only at rank 1: ${delta >= 0 ? '+' : ''}${delta.toFixed(1)} points`);
}

/* Per-kind for EVERY configuration. Overall P@1 can hide the thing that
   matters: lexical retrieval is in the stack to catch rare proper nouns, which
   embeddings blur. If dense-only also wins there, lexical is not protecting
   anything on this data and its weight is pure dilution. If it loses there, the
   hybrid is buying insurance that the overall average obscures. */
const kinds = [...new Set(QUESTIONS.map(q => q.kind))];
console.log(`\nP@1 by question type:\n${pad('configuration', 30)}${kinds.map(k => pad(k.slice(0, 13), 15)).join('')}`);
console.log('-'.repeat(30 + kinds.length * 15));
for (const r of results) {
    if (r.skipped) continue;
    const cells = kinds.map(k => {
        const v = r.byKind[k];
        return pad(v ? `${v.hit1}/${v.n}` : '-', 15);
    });
    console.log(`${pad(r.name, 30)}${cells.join('')}`);
}

console.log('\nwhere the shipped default fails:');
if (shipped && !shipped.skipped) {
    if (shipped.misses.length) {
        for (const m of shipped.misses) console.log(`  [${m.kind}] "${m.q}" -> rank ${m.rank ?? 'absent'}, got ${m.got}`);
    } else {
        console.log('  nothing below rank 3');
    }
}

const dense = results.find(r => r.name === 'dense only');
if (dense && !dense.skipped) {
    console.log('\ndense-only misses (the case FOR keeping lexical in the stack):');
    if (dense.misses.length) {
        for (const m of dense.misses) console.log(`  [${m.kind}] "${m.q}" -> rank ${m.rank ?? 'absent'}, got ${m.got}`);
    } else {
        console.log('  none below rank 3 — on this corpus, lexical protects nothing dense misses');
    }
}

console.log(`\nSample size: ${QUESTIONS.length} questions. One question is ${(100 / QUESTIONS.length).toFixed(1)} points,`);
console.log('so differences under ~7 points are inside the noise of a single labelling choice.');

console.log('\nNOTE: the corpus is synthetic (see eval/corpus.mjs). These numbers compare');
console.log('configurations against each other on identical data; they are not a prediction');
console.log('of accuracy on a real user\'s memory, which is a different distribution.');
