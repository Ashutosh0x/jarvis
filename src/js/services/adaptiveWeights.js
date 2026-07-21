// ---------------------------------------------------------------------------
// Query-adaptive fusion weights — a faithful, local adaptation of QuDAR-confidence
// (Kim et al., "Query-Wise Dual-Perspective Adaptive Retrieval", ACL 2026, §4.4).
//
// JARVIS's hybrid retriever fuses sparse (BM25) and dense (nomic-embed) lists
// with FIXED weights. QuDAR's finding: the optimal sparse/dense balance is not
// universal — it shifts per query. Their training-free, LLM-free variant weights
// each retriever by its own confidence margin (how decisively it ranks its top
// candidate above the next), then normalizes with a temperature softmax.
//
// This is a perfect fit for a local, latency-sensitive assistant: it is pure
// arithmetic over scores the retriever has already computed — no extra model
// call, no planning loop (which the project rejects on latency grounds). And it
// is deliberately conservative: when both lists are equally confident it reduces
// EXACTLY to the proven fixed baseline, so it can never regress the known-good
// case. Pure and deterministic — no I/O, no clock — hence fully testable.
// ---------------------------------------------------------------------------

/**
 * Confidence margin of a scored, descending-sorted list, in [0, 1].
 * Min-max normalized within the list, then margin = (score1 - score2) / range,
 * i.e. how far the top result sits above the runner-up relative to the list's
 * own spread. A decisive top-1 → margin near 1; a near-tie → margin near 0.
 * Lists shorter than 2, or with no spread, yield 0 (no confidence signal).
 *
 * @param {Array<{score:number}>} list
 * @returns {number}
 */
export function confidenceMargin(list) {
    if (!Array.isArray(list) || list.length < 2) return 0;
    const s1 = list[0].score;
    const s2 = list[1].score;
    const min = list[list.length - 1].score;
    const range = s1 - min;
    if (!(range > 0)) return 0;
    const m = (s1 - s2) / range;
    return m > 0 ? (m < 1 ? m : 1) : 0;
}

/**
 * Per-query adaptive weights for the sparse and dense lists, summing to `budget`
 * (default 2, matching the fixed baseline of sparse 1.0 + dense 1.0 so the PRF
 * list keeps its relative down-weighted role unchanged).
 *
 * Both lists present  → temperature-softmax over their confidence margins.
 *                       Equal margins → { sparse: 1, dense: 1 } (== baseline).
 * Only one present    → fall back to the fixed baseline (1 and 0), so BM25-only
 *                       mode is byte-identical to before.
 *
 * @param {Array<{score:number}>} sparseList
 * @param {Array<{score:number}>} denseList
 * @param {{tau?:number, budget?:number}} [opts]
 * @returns {{sparse:number, dense:number}}
 */
export function adaptiveSparseDenseWeights(sparseList, denseList, opts = {}) {
    const tau = opts.tau ?? 0.3;
    const budget = opts.budget ?? 2;
    const hasS = Array.isArray(sparseList) && sparseList.length > 0;
    const hasD = Array.isArray(denseList) && denseList.length > 0;

    // With only one retriever available, keep the proven fixed weights so the
    // degraded (e.g. BM25-only) path is unchanged.
    if (!hasS && !hasD) return { sparse: 0, dense: 0 };
    if (hasS && !hasD) return { sparse: 1, dense: 0 };
    if (!hasS && hasD) return { sparse: 0, dense: 1 };

    const mS = confidenceMargin(sparseList);
    const mD = confidenceMargin(denseList);
    // Temperature softmax over the two margins (QuDAR Eq. §4.4).
    const eS = Math.exp(mS / tau);
    const eD = Math.exp(mD / tau);
    const wS = eS / (eS + eD);
    return { sparse: wS * budget, dense: (1 - wS) * budget };
}

/**
 * Dual-perspective weights covering all three fused lists — QuDAR's second
 * (query-format) axis, mapped onto the retriever this pipeline already has:
 * the PRF list IS the expanded-query signal (feedback terms re-queried against
 * BM25), so weighting it by its own confidence margin is the paper's
 * original-vs-expanded adaptation without any extra retrieval pass.
 *
 * PRF stays one-sided by design: its weight is CAPPED at its fixed baseline
 * (0.5), so an unconfident feedback pool dilutes toward zero but a confident
 * one can never outrank the user's actual question — the same "dilute but not
 * corrupt" contract the fixed 0.5 encoded. Budget freed by a weak PRF list
 * flows to sparse/dense, keeping total fusion mass constant.
 *
 * Baseline reduction (the invariant): all three lists equally confident →
 * exactly { sparse: 1, dense: 1, prf: 0.5 }. With PRF absent, the result is
 * adaptiveSparseDenseWeights unchanged; degraded single-retriever modes keep
 * their fixed weights.
 *
 * @param {Array<{score:number}>} sparseList
 * @param {Array<{score:number}>} denseList
 * @param {Array<{score:number}>} prfList
 * @param {{tau?:number, prfCap?:number}} [opts]
 * @returns {{sparse:number, dense:number, prf:number}}
 */
export function adaptiveFusionWeights(sparseList, denseList, prfList, opts = {}) {
    const tau = opts.tau ?? 0.3;
    const prfCap = opts.prfCap ?? 0.5;
    const hasS = Array.isArray(sparseList) && sparseList.length > 0;
    const hasD = Array.isArray(denseList) && denseList.length > 0;
    const hasP = Array.isArray(prfList) && prfList.length > 0;

    if (!hasP) return { ...adaptiveSparseDenseWeights(sparseList, denseList, { tau }), prf: 0 };
    if (!hasS && !hasD) return { sparse: 0, dense: 0, prf: prfCap };

    // Budget = sum of the fixed baseline weights of the lists actually present,
    // so total fusion mass matches the proven baseline in every mode.
    const budget = (hasS ? 1 : 0) + (hasD ? 1 : 0) + prfCap;

    const margins = [];
    if (hasS) margins.push(confidenceMargin(sparseList));
    if (hasD) margins.push(confidenceMargin(denseList));
    margins.push(confidenceMargin(prfList));
    const exps = margins.map((m) => Math.exp(m / tau));
    const sum = exps.reduce((a, b) => a + b, 0);
    const pPrf = exps[exps.length - 1] / sum;

    const prf = Math.min(budget * pPrf, prfCap);
    const rest = budget - prf;
    if (hasS && !hasD) return { sparse: rest, dense: 0, prf };
    if (!hasS && hasD) return { sparse: 0, dense: rest, prf };
    const sd = adaptiveSparseDenseWeights(sparseList, denseList, { tau, budget: rest });
    return { sparse: sd.sparse, dense: sd.dense, prf };
}
