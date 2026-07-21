// Tests for the deterministic fund-flow tracer (Approximate Personalized
// PageRank, forward-biased). The property under test: money-weighted forward
// flow surfaces the real cash-out path above dust noise and upstream funders,
// exactly as TRacer claims — and it does so deterministically, no LLM.
import {
    buildGraph, personalizedPageRank, topRanked, traceFunds,
    coefficientOfVariation, detectCycles, detectConsistentChains, structuralReport,
} from '../tracer.js';

let pass = 0, fail = 0;
const check = (n, c) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); };

// A Cryptopia-style trace: a heavy laundering path to an exchange, plus dust
// noise branches and an upstream funder that forward-tracing should ignore.
const edges = [
    { from: 'FUNDER', to: 'HACKER', amount: 5 },     // upstream (backward)
    { from: 'HACKER', to: 'MULE', amount: 10 },      // heavy forward path
    { from: 'MULE', to: 'EXCHANGE', amount: 9 },     // cash-out
    { from: 'HACKER', to: 'DUST1', amount: 0.05 },   // dust noise
    { from: 'DUST1', to: 'DUST2', amount: 0.04 },
    { from: 'MULE', to: 'DUST3', amount: 0.1 },
];

const g = buildGraph(edges);
check('buildGraph collects all nodes', g.nodes.size === 7);
check('buildGraph out-edges of HACKER', (g.out.get('HACKER') || []).length === 2);
check('buildGraph in-edges of HACKER', (g.inc.get('HACKER') || []).length === 1);

const scores = personalizedPageRank(g, 'HACKER', { alpha: 0.15, epsilon: 1e-5, beta: 0.9 });
const s = (n) => scores.get(n) || 0;

// The cash-out point pools the funds that reach it, so the terminal exchange
// ranks #1 overall — the single most useful lead in a fund trace.
check('cash-out EXCHANGE pools funds (ranks #1 of all)',
    [...scores.entries()].every(([, v]) => v <= s('EXCHANGE')));
check('source still outranks dust noise', s('HACKER') > s('DUST2'));
check('heavy path (MULE) outranks dust', s('MULE') > s('DUST1') && s('MULE') > s('DUST3'));
check('cash-out EXCHANGE outranks all dust', s('EXCHANGE') > s('DUST1') && s('EXCHANGE') > s('DUST2') && s('EXCHANGE') > s('DUST3'));
check('forward bias: EXCHANGE (downstream) outranks FUNDER (upstream)', s('EXCHANGE') > s('FUNDER'));
check('weighted pollution: heavy branch outranks light branch at same hop', s('MULE') > s('DUST1'));

// Mass is (approximately) conserved: absorbed p sums to ~1.
let totalP = 0; for (const v of scores.values()) totalP += v;
check('PPR mass conserved (~1)', totalP > 0.95 && totalP <= 1.0001);

// Determinism: identical inputs => identical scores.
const scores2 = personalizedPageRank(buildGraph(edges), 'HACKER', { alpha: 0.15, epsilon: 1e-5, beta: 0.9 });
let identical = scores.size === scores2.size;
for (const [k, v] of scores) if (Math.abs((scores2.get(k) || 0) - v) > 1e-12) identical = false;
check('deterministic across runs', identical);

// topRanked: source excluded, EXCHANGE + MULE are the top leads.
const ranked = topRanked(scores, 'HACKER', 5);
check('topRanked excludes source', !ranked.some((r) => r.account === 'HACKER'));
check('topRanked leads with the laundering path', ['MULE', 'EXCHANGE'].includes(ranked[0].account));

// One-call helper agrees with the step-by-step path.
const oneCall = traceFunds(edges, 'HACKER', { epsilon: 1e-5, beta: 0.9, limit: 3 });
check('traceFunds returns ranked leads', oneCall.length === 3 && oneCall[0].score > 0);

// Edge cases: empty graph, isolated source.
check('empty edges => no leads', traceFunds([], 'X').length === 0);
check('isolated source (no out-edges) still terminates', traceFunds([{ from: 'A', to: 'B', amount: 1 }], 'Z').length === 0);

// --- coefficient of variation (Clue2Group Eq. 11) ---
check('CV of identical amounts is 0', coefficientOfVariation([100, 100, 100]) === 0);
check('CV of varied amounts is > 0', coefficientOfVariation([10, 100, 1000]) > 0.5);
check('CV single element is 0', coefficientOfVariation([5]) === 0);
check('CV zero-mean is Infinity (never falsely consistent)', coefficientOfVariation([-5, 5]) === Infinity);
check('CV near-consistent below threshold', coefficientOfVariation([100, 98, 102, 99]) < 0.15);

// --- cycle detection (round-trip / U-turn typology) ---
{
    // A → B → C → A round trip, plus a non-returning branch A → D.
    const g = buildGraph([
        { from: 'A', to: 'B', amount: 5 },
        { from: 'B', to: 'C', amount: 5 },
        { from: 'C', to: 'A', amount: 5 },
        { from: 'A', to: 'D', amount: 5 },
    ]);
    const cycles = detectCycles(g, 'A', 6);
    check('detectCycles finds the round-trip', cycles.length === 1);
    check('cycle starts and ends at source', cycles[0][0] === 'A' && cycles[0][cycles[0].length - 1] === 'A');
    check('cycle includes B and C', cycles[0].includes('B') && cycles[0].includes('C'));
    check('no false cycle on acyclic source', detectCycles(buildGraph([{ from: 'X', to: 'Y', amount: 1 }]), 'X').length === 0);
}

// --- amount-consistent chain detection (SACC structural enhancement) ---
{
    // Consistent layering chain (≈100 each) vs an inconsistent decoy branch.
    const g = buildGraph([
        { from: 'S', to: 'M1', amount: 100 },
        { from: 'M1', to: 'M2', amount: 99 },
        { from: 'M2', to: 'EXIT', amount: 101 },
        { from: 'S', to: 'N1', amount: 3 },      // inconsistent decoy
        { from: 'N1', to: 'N2', amount: 900 },
    ]);
    const chains = detectConsistentChains(g, 'S', { minLen: 2, maxLen: 4, cvThreshold: 0.15 });
    check('detectConsistentChains finds the layering path', chains.length >= 1);
    check('top chain is amount-consistent (low CV)', chains[0].cv < 0.15);
    check('a consistent chain reaches EXIT', chains.some((c) => c.path.includes('EXIT') && c.cv < 0.15));
    check('inconsistent decoy is excluded', !chains.some((c) => c.path.includes('N2')));
}

// --- structuralReport one-call ---
{
    const edges = [
        { from: 'H', to: 'M', amount: 10 }, { from: 'M', to: 'EX', amount: 9 },
        { from: 'EX', to: 'H', amount: 1 }, // small round-trip back
    ];
    const rep = structuralReport(edges, 'H', { maxCycleLen: 5 });
    check('structuralReport returns leads', rep.leads.length > 0);
    check('structuralReport returns cycles array', Array.isArray(rep.cycles));
    check('structuralReport returns consistentChains array', Array.isArray(rep.consistentChains));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
