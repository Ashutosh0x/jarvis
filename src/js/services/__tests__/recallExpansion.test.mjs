// Integration test for REPAIR-style bounded-recall expansion, driving the REAL
// ragService.recall() with a stubbed embedder and reranker. docGraph.test.mjs
// proves the graph maths; this proves the WIRING — that expansion reaches the
// pool only on the typed path, that a recovered passage can actually land in
// the context, and that a failed rerank leaves no unjudged passage behind.

// --- environment stubs (renderer globals ragService reaches for) -------------
globalThis.localStorage = { getItem: () => null, setItem: () => {} };

let rerankBehaviour = 'promote-bridge';
let chatCalls = 0;
let lastListing = '';

globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);

    if (String(url).includes('/api/embed')) {
        // Deterministic toy embeddings by keyword, so "runoff" documents cluster.
        const vec = (t) => {
            const s = t.toLowerCase();
            if (s.includes('runoff') || s.includes('saucer') || s.includes('drain')) return [1, 0, 0];
            if (s.includes('fertiliz') || s.includes('salt')) return [0.97, 0.24, 0];
            return [0, 0, 1];
        };
        return { ok: true, json: async () => ({ embeddings: body.input.map(vec) }) };
    }

    if (String(url).includes('/api/chat')) {
        chatCalls++;
        lastListing = body.messages[1].content;
        if (rerankBehaviour === 'fail') {
            return { ok: true, json: async () => ({ message: { content: 'not json' } }) };
        }
        // Promote whichever candidate mentions salt — the "bridge" passage that
        // fusion never surfaced.
        const ids = [...lastListing.matchAll(/\[(\d+)\]\s*([^\n]*)/g)].map(m => ({ id: +m[1], text: m[2] }));
        const bridge = ids.find(c => c.text.toLowerCase().includes('salt'));
        const order = bridge ? [bridge.id, ...ids.filter(c => c.id !== bridge.id).map(c => c.id)]
                             : ids.map(c => c.id);
        return { ok: true, json: async () => ({ message: { content: JSON.stringify({ order }) } }) };
    }

    throw new Error(`unexpected fetch ${url}`);
};

const { default: rag } = await import('../ragService.js');

let pass = 0, fail = 0;
const check = (n, c) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); };
const tick = () => new Promise(r => setTimeout(r, 5));

// --- corpus ------------------------------------------------------------------
// Several near-identical "runoff" passages guarantee an ambiguous fused ranking
// (so the rerank gate fires). The passage that actually answers the question —
// the salt one — shares almost no query vocabulary, which is precisely the
// "bridge document" REPAIR is about: it loses on lexical overlap and is pushed
// out of the top-5 cut, but it is a dense neighbour of what did get retrieved.
const CORPUS = [
    'Water runoff collects in the saucer under a plant pot after watering.',
    'Runoff water in the saucer should be emptied from the drain tray promptly.',
    'A saucer catches runoff water so the drain does not spill onto the floor.',
    'Runoff water in a drain saucer can be tipped back into the watering can.',
    'Drain saucer runoff often looks clear even when it is not.',
    'Dissolved fertiliser salt accumulates in collected water and harms roots when reused.',
];

async function seed() {
    rag.loaded = true;
    rag.chunks = [];
    rag.entities = {};
    rag.relations = [];
    rag._rebuildIndex();
    rag._graph = null;
    rag._graphRev = -1;
    rag._rev = 0;
    rag.embedAvailable = null;
    for (const text of CORPUS) await rag.ingest(text, { source: 'test' });
    check('setup: corpus ingested with vectors', rag.chunks.length === 6 && rag.chunks.every(c => c.vector));
}

await seed();
const QUERY = 'can I reuse the runoff water in the saucer';
const bridgeIn = (res) => res.results.some(r => r.text.toLowerCase().includes('salt'));

// --- 1. voice path: no expansion, no model call, no graph --------------------
{
    chatCalls = 0;
    const res = await rag.recall(QUERY);
    await tick();
    check('voice path: no rerank call', chatCalls === 0);
    check('voice path: no expansion reported', !res.expanded);
    check('voice path: bridge passage stays lost (bounded recall)', !bridgeIn(res));
    check('voice path: no graph was built', rag.stats().graphEdges === 0);
}

// --- 2. typed path: first call warms the graph, never blocks on it -----------
{
    chatCalls = 0;
    const first = await rag.recall(QUERY, { rerank: true });
    check('typed path: rerank gate fired', chatCalls === 1);
    check('typed path: first query does not wait for the graph', first.expanded === 0);
    await tick();
    check('typed path: graph is ready after the build tick', rag.stats().graphEdges > 0);
}

// --- 3. typed path with a warm graph: the bridge passage is recovered --------
{
    chatCalls = 0;
    const res = await rag.recall(QUERY, { rerank: true });
    check('expansion: neighbours joined the pool', res.expanded > 0);
    check('expansion: pool was shown to the reranker', /salt/i.test(lastListing));
    check('expansion: bridge passage recovered into results', bridgeIn(res));
    check('expansion: reranker promoted it to rank 1', /salt/i.test(res.results[0].text));
    check('expansion: context budget unchanged', res.results.length <= 5);
    check('expansion: still one model call', chatCalls === 1);
}

// --- 4. a failed rerank must not leave unjudged passages in the context ------
{
    rerankBehaviour = 'fail';
    const res = await rag.recall(QUERY, { rerank: true });
    check('rerank failure: expansion discarded', res.expanded === 0);
    check('rerank failure: no unjudged passage in results', !bridgeIn(res));
    check('rerank failure: every result kept its fusion score', res.results.every(r => r.score > 0));
    check('rerank failure: recall still returns usable context', res.results.length > 0);
    rerankBehaviour = 'promote-bridge';
}

// --- 5. forget() renumbers chunks: a stale graph must never be reused --------
{
    await rag.recall(QUERY, { rerank: true });
    await tick();
    const before = rag.stats().graphEdges;
    await rag.forget(c => c.text.includes('tipped back'));
    check('invalidation: graph was live before forget()', before > 0);
    check('invalidation: forget() invalidates the graph', rag.stats().graphEdges === 0);
    const res = await rag.recall(QUERY, { rerank: true });
    check('invalidation: query after forget() does not expand on stale ids', res.expanded === 0);
    await tick();
    check('invalidation: graph rebuilds itself', rag.stats().graphEdges > 0);
}

// --- 6. BM25-only mode (no embedder) must be completely unaffected -----------
{
    await seed();
    rag.chunks.forEach(c => { c.vector = null; });
    rag.embedAvailable = false;
    rag._graph = null; rag._graphRev = -1; rag._rev++;
    const res = await rag.recall(QUERY, { rerank: true });
    await tick();
    check('bm25-only: no graph is built without vectors', rag.stats().graphEdges === 0);
    check('bm25-only: no expansion attempted', res.expanded === 0);
    check('bm25-only: recall still works', res.results.length > 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
