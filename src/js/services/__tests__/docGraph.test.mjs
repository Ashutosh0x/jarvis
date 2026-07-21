// Tests for the REPAIR-derived neighbourhood graph. Load-bearing properties:
// (1) documents without vectors get NO edges — a corpus embedded while Ollama
// was down must degrade to "no expansion", never to wrong expansion;
// (2) expansion is deterministic, since equal similarities are common in a
// small corpus and insertion order would otherwise reorder the pool run to run.
import { unit, buildNeighborGraph, buildNeighborGraphAsync, expandCandidates } from '../docGraph.js';

let pass = 0, fail = 0;
const approx = (a, b, t = 1e-9) => Math.abs(a - b) <= t;
const check = (n, c) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); };

// --- unit ---
check('unit: null vector -> null', unit(null) === null);
check('unit: empty vector -> null', unit([]) === null);
check('unit: all-zero vector -> null', unit([0, 0, 0]) === null);
{
    const u = unit([3, 4]);
    check('unit: normalises to length 1', approx(u[0], 0.6) && approx(u[1], 0.8));
}

// A synthetic corpus with two clear clusters plus one isolated document.
// 0,1,2 = cluster A; 3,4 = cluster B; 5 = orthogonal loner; 6 = no vector.
const CORPUS = [
    [1, 0, 0],
    [0.97, 0.24, 0],
    [0.94, 0.34, 0],
    [0, 1, 0],
    [0.24, 0.97, 0],
    [0, 0, 1],
    null,
];

// --- buildNeighborGraph ---
{
    const g = buildNeighborGraph(CORPUS, { k: 8, minSim: 0.5 });
    check('graph: reports corpus size', g.size === CORPUS.length);
    check('graph: vectorless doc has no edges', !g.adj.has(6));
    check('graph: orthogonal doc has no edges above threshold', !g.adj.has(5));

    const a0 = (g.adj.get(0) || []).map(n => n.j);
    check('graph: cluster A neighbours are cluster A', a0.includes(1) && a0.includes(2));
    check('graph: cluster A excludes cluster B', !a0.includes(3));

    const a3 = (g.adj.get(3) || []).map(n => n.j);
    check('graph: cluster B links to cluster B', a3.includes(4));

    // Edges are undirected: whichever end is retrieved can reach the other.
    const a4 = (g.adj.get(4) || []).map(n => n.j);
    check('graph: edges are undirected', a3.includes(4) && a4.includes(3));

    // Neighbours are sorted by descending similarity.
    const sims = (g.adj.get(0) || []).map(n => n.sim);
    check('graph: neighbours sorted by similarity desc', sims.every((s, i) => i === 0 || sims[i - 1] >= s));
}

// --- degraded inputs (must be no-ops, never throw) ---
{
    check('graph: empty corpus -> empty', buildNeighborGraph([], {}).adj.size === 0);
    check('graph: non-array -> empty', buildNeighborGraph(null, {}).adj.size === 0);
    check('graph: single doc -> empty (nothing to link)', buildNeighborGraph([[1, 0]], {}).adj.size === 0);
    check('graph: all vectorless -> empty', buildNeighborGraph([null, null, null], {}).adj.size === 0);
    check('graph: over maxDocs guard -> empty',
        buildNeighborGraph(CORPUS, { maxDocs: 3 }).adj.size === 0);
}

// --- thresholds and caps ---
{
    // Docs 1 and 2 sit ~6 degrees apart (cosine ~0.9945), so a 0.99 floor keeps
    // exactly that pair and prunes everything else — including doc 0, which is
    // only ~0.97 from doc 1.
    const strict = buildNeighborGraph(CORPUS, { minSim: 0.99 });
    check('graph: high minSim keeps only the near-identical pair',
        strict.adj.size === 2 && strict.adj.has(1) && strict.adj.has(2));
    check('graph: high minSim prunes the merely-similar doc', !strict.adj.has(0));

    const capped = buildNeighborGraph(CORPUS, { k: 1, minSim: 0.5 });
    check('graph: k caps neighbour count', [...capped.adj.values()].every(l => l.length <= 1));
    // With k=1, doc 0 keeps its single strongest neighbour (doc 1, sim .97).
    check('graph: k=1 keeps the strongest neighbour', capped.adj.get(0)[0].j === 1);
}

// --- expandCandidates ---
{
    const g = buildNeighborGraph(CORPUS, { k: 8, minSim: 0.5 });

    // Seed with doc 0 only: cluster A's other members are the bounded-recall win.
    const e = expandCandidates(g, [0], { limit: 4 });
    const ids = e.map(c => c.i);
    check('expand: surfaces unretrieved cluster mates', ids.includes(1) && ids.includes(2));
    check('expand: never returns a seed', !ids.includes(0));
    check('expand: does not cross into the other cluster', !ids.includes(3) && !ids.includes(4));
    check('expand: ranked by similarity desc', e[0].sim >= e[e.length - 1].sim);

    // Seeds spanning both clusters reach both neighbourhoods.
    const both = expandCandidates(g, [0, 3], { limit: 4 }).map(c => c.i);
    check('expand: multi-seed reaches both neighbourhoods', both.includes(1) && both.includes(4));

    // A candidate linked to several seeds is scored by its STRONGEST link.
    const multi = expandCandidates(g, [0, 1], { limit: 4 });
    const two = multi.find(c => c.i === 2);
    const simFrom1 = g.adj.get(1).find(n => n.j === 2).sim;
    check('expand: scores candidate by max link, not sum', two && approx(two.sim, simFrom1));

    // Caps and empty cases.
    check('expand: respects limit', expandCandidates(g, [0], { limit: 1 }).length === 1);
    check('expand: limit 0 -> empty', expandCandidates(g, [0], { limit: 0 }).length === 0);
    check('expand: no seeds -> empty', expandCandidates(g, [], { limit: 4 }).length === 0);
    check('expand: null graph -> empty', expandCandidates(null, [0], { limit: 4 }).length === 0);
    check('expand: isolated seed -> empty', expandCandidates(g, [5], { limit: 4 }).length === 0);
    check('expand: vectorless seed -> empty', expandCandidates(g, [6], { limit: 4 }).length === 0);
    check('expand: minSim floor prunes', expandCandidates(g, [0], { limit: 4, minSim: 0.999 }).length === 0);
}

// --- determinism (equal similarities must not reorder run to run) ---
{
    // Two candidates exactly equidistant from the seed: the tie-break on id
    // is what makes the expanded pool reproducible.
    const tied = [[1, 0, 0], [0.8, 0.6, 0], [0.8, -0.6, 0]];
    const g = buildNeighborGraph(tied, { minSim: 0.5 });
    const a = expandCandidates(g, [0], { limit: 2 });
    const b = expandCandidates(g, [0], { limit: 2 });
    check('expand: deterministic across calls', JSON.stringify(a) === JSON.stringify(b));
    check('expand: ties broken on document id', a[0].i === 1 && a[1].i === 2);
    check('expand: tied similarities really are equal', approx(a[0].sim, a[1].sim));

    const g2 = buildNeighborGraph(CORPUS, { k: 8, minSim: 0.5 });
    check('graph: build is deterministic',
        JSON.stringify([...buildNeighborGraph(CORPUS, { k: 8, minSim: 0.5 }).adj])
        === JSON.stringify([...g2.adj]));
}

// --- the sliced builder must agree with the synchronous one EXACTLY ----------
// The whole point of slicing is to move work off one long block; if it also
// changed the ranking it would be a regression wearing a performance costume.
{
    const ser = (g) => JSON.stringify([...g.adj].map(([i, l]) => [i, l.map(n => [n.j, n.sim])]));
    const opts = { k: 8, minSim: 0.5 };

    const sync = buildNeighborGraph(CORPUS, opts);
    const async1 = await buildNeighborGraphAsync(CORPUS, opts);
    check('async: identical to sync on the clustered corpus', ser(async1) === ser(sync));

    // A corpus big enough to span several slices, with a tiny budget to force
    // many yields — the seam between slices must not drop or duplicate a pair.
    const many = Array.from({ length: 120 }, (_, i) => [Math.cos(i / 7), Math.sin(i / 7), (i % 5) / 10]);
    const syncMany = buildNeighborGraph(many, opts);
    const asyncMany = await buildNeighborGraphAsync(many, { ...opts, sliceMs: 0 });
    check('async: identical across many forced slices', ser(asyncMany) === ser(syncMany));
    check('async: that corpus actually produced edges', syncMany.adj.size > 0);

    // Degraded inputs behave the same through both entry points.
    check('async: respects maxDocs guard', (await buildNeighborGraphAsync(CORPUS, { maxDocs: 3 })).adj.size === 0);
    check('async: empty corpus -> empty', (await buildNeighborGraphAsync([], {})).adj.size === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
