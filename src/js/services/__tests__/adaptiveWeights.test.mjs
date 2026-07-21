// Tests for QuDAR-confidence adaptive fusion weights. The load-bearing property:
// equal confidence must reduce EXACTLY to the fixed baseline (sparse 1, dense 1),
// so the adaptation can never regress the proven case.
import { confidenceMargin, adaptiveSparseDenseWeights, adaptiveFusionWeights } from '../adaptiveWeights.js';

let pass = 0, fail = 0;
const approx = (a, b, t = 1e-9) => Math.abs(a - b) <= t;
const check = (n, c) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); };

// --- confidenceMargin ---
check('margin: empty list is 0', confidenceMargin([]) === 0);
check('margin: single element is 0', confidenceMargin([{ score: 5 }]) === 0);
check('margin: no spread is 0', confidenceMargin([{ score: 3 }, { score: 3 }, { score: 3 }]) === 0);
// [10, 6, 2]: range 8, (10-6)/8 = 0.5
check('margin: half-spread gap = 0.5', approx(confidenceMargin([{ score: 10 }, { score: 6 }, { score: 2 }]), 0.5));
// Decisive top-1: [10, 1, 0.5] range 9.5, (10-1)/9.5 ≈ 0.947
check('margin: decisive top-1 is near 1', confidenceMargin([{ score: 10 }, { score: 1 }, { score: 0.5 }]) > 0.9);
// Near-tie top-1/top-2: [10, 9.9, 0] range 10, 0.1/10 = 0.01
check('margin: near-tie is near 0', confidenceMargin([{ score: 10 }, { score: 9.9 }, { score: 0 }]) < 0.05);
check('margin: two-element list', approx(confidenceMargin([{ score: 8 }, { score: 2 }]), 1)); // range=6, gap=6 -> 1

// --- adaptiveSparseDenseWeights: baseline reduction (THE invariant) ---
{
    // Both lists equally confident -> must be exactly { sparse: 1, dense: 1 }.
    const s = [{ score: 10 }, { score: 6 }, { score: 2 }];
    const d = [{ score: 1 }, { score: 0.6 }, { score: 0.2 }]; // same shape, same margin 0.5
    const w = adaptiveSparseDenseWeights(s, d);
    check('weights: equal confidence == baseline sparse 1', approx(w.sparse, 1));
    check('weights: equal confidence == baseline dense 1', approx(w.dense, 1));
    check('weights: budget preserved (sum 2)', approx(w.sparse + w.dense, 2));
}

// --- adaptivity: confident list gets more weight ---
{
    const confidentSparse = [{ score: 10 }, { score: 1 }, { score: 0 }];   // margin ~0.9
    const ambiguousDense = [{ score: 10 }, { score: 9.8 }, { score: 0 }];  // margin ~0.02
    const w = adaptiveSparseDenseWeights(confidentSparse, ambiguousDense);
    check('weights: confident sparse outweighs ambiguous dense', w.sparse > w.dense);
    check('weights: still sums to budget 2', approx(w.sparse + w.dense, 2));
    check('weights: shift is bounded (dense not zeroed)', w.dense > 0);

    // Symmetric case
    const w2 = adaptiveSparseDenseWeights(ambiguousDense, confidentSparse);
    check('weights: symmetric — confident dense outweighs', w2.dense > w2.sparse);
    check('weights: symmetric magnitude matches', approx(w2.dense, w.sparse) && approx(w2.sparse, w.dense));
}

// --- degraded modes fall back to fixed baseline (no regression) ---
{
    const s = [{ score: 10 }, { score: 2 }];
    check('weights: dense empty -> fixed sparse 1, dense 0',
        JSON.stringify(adaptiveSparseDenseWeights(s, [])) === JSON.stringify({ sparse: 1, dense: 0 }));
    check('weights: sparse empty -> fixed sparse 0, dense 1',
        JSON.stringify(adaptiveSparseDenseWeights([], s)) === JSON.stringify({ sparse: 0, dense: 1 }));
    check('weights: both empty -> zero',
        JSON.stringify(adaptiveSparseDenseWeights([], [])) === JSON.stringify({ sparse: 0, dense: 0 }));
}

// --- determinism ---
{
    const s = [{ score: 9 }, { score: 3 }, { score: 1 }];
    const d = [{ score: 5 }, { score: 4.9 }, { score: 1 }];
    const a = adaptiveSparseDenseWeights(s, d);
    const b = adaptiveSparseDenseWeights(s, d);
    check('deterministic across calls', a.sparse === b.sparse && a.dense === b.dense);
}

// --- adaptiveFusionWeights: baseline reduction (THE invariant, 3-list) ---
{
    // All three lists equally confident -> exactly { sparse: 1, dense: 1, prf: 0.5 }.
    const s = [{ score: 10 }, { score: 6 }, { score: 2 }];
    const d = [{ score: 1 }, { score: 0.6 }, { score: 0.2 }];
    const p = [{ score: 4 }, { score: 2.4 }, { score: 0.8 }]; // same margin 0.5
    const w = adaptiveFusionWeights(s, d, p);
    check('fusion: equal confidence == baseline sparse 1', approx(w.sparse, 1));
    check('fusion: equal confidence == baseline dense 1', approx(w.dense, 1));
    check('fusion: equal confidence == baseline prf 0.5', approx(w.prf, 0.5));
    check('fusion: budget preserved (sum 2.5)', approx(w.sparse + w.dense + w.prf, 2.5));
}

// --- adaptiveFusionWeights: PRF is one-sided (capped at baseline) ---
{
    const ambiguous = [{ score: 10 }, { score: 9.9 }, { score: 0 }];  // margin ~0.01
    const confident = [{ score: 10 }, { score: 1 }, { score: 0 }];    // margin ~0.9
    // Confident PRF vs ambiguous retrievers: PRF must NOT exceed 0.5.
    const up = adaptiveFusionWeights(ambiguous, ambiguous, confident);
    check('fusion: confident prf capped at 0.5', up.prf <= 0.5 + 1e-12);
    check('fusion: cap keeps budget (sum 2.5)', approx(up.sparse + up.dense + up.prf, 2.5));
    // Ambiguous PRF vs confident retrievers: PRF dilutes below 0.5, freed
    // budget flows to sparse/dense.
    const down = adaptiveFusionWeights(confident, confident, ambiguous);
    check('fusion: weak prf dilutes below 0.5', down.prf < 0.5);
    check('fusion: freed budget flows to retrievers', down.sparse > 1 && down.dense > 1);
    check('fusion: dilution keeps budget (sum 2.5)', approx(down.sparse + down.dense + down.prf, 2.5));
    check('fusion: weak prf never zeroed', down.prf > 0);
}

// --- adaptiveFusionWeights: degraded modes ---
{
    const s = [{ score: 10 }, { score: 6 }, { score: 2 }];
    const p = [{ score: 4 }, { score: 2.4 }, { score: 0.8 }]; // same margin as s
    // No PRF list -> identical to the 2-list function (with prf 0).
    const two = adaptiveSparseDenseWeights(s, s);
    const noP = adaptiveFusionWeights(s, s, []);
    check('fusion: no prf == 2-list result', approx(noP.sparse, two.sparse) && approx(noP.dense, two.dense) && noP.prf === 0);
    // BM25-only mode with equal margins -> fixed baseline { 1, 0, 0.5 }.
    const bm25Only = adaptiveFusionWeights(s, [], p);
    check('fusion: bm25-only equal margins == baseline sparse 1', approx(bm25Only.sparse, 1));
    check('fusion: bm25-only dense 0', bm25Only.dense === 0);
    check('fusion: bm25-only equal margins == baseline prf 0.5', approx(bm25Only.prf, 0.5));
    check('fusion: no retrievers -> prf baseline only',
        JSON.stringify(adaptiveFusionWeights([], [], p)) === JSON.stringify({ sparse: 0, dense: 0, prf: 0.5 }));
}

// --- adaptiveFusionWeights: determinism ---
{
    const s = [{ score: 9 }, { score: 3 }, { score: 1 }];
    const d = [{ score: 5 }, { score: 4.9 }, { score: 1 }];
    const p = [{ score: 2 }, { score: 1.8 }, { score: 0.4 }];
    const a = adaptiveFusionWeights(s, d, p);
    const b = adaptiveFusionWeights(s, d, p);
    check('fusion: deterministic across calls', a.sparse === b.sparse && a.dense === b.dense && a.prf === b.prf);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
