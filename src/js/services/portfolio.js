// ---------------------------------------------------------------------------
// Portfolio-level analytics — covariance, risk contribution, and allocation.
//
// quant.js answers "how risky is this ONE thing". Nothing there answers the
// question a portfolio actually poses: given several holdings that move
// together, where does the risk actually sit, and what weights would put it
// somewhere else. Correlation is the whole difference — a book of five names
// with r = 0.8 is much closer to one position than to five.
//
// PURE, like quant.js: no I/O, no clock, no globals. Same rule applies — the
// language model never computes any of this.
//
// WHY RISK CONTRIBUTION IS THE HEADLINE. The claim that motivates risk parity
// is that a 60/40 portfolio is really a ~90% equity-risk portfolio. That is not
// an opinion, it is what riskContributions() returns for those weights, and it
// is checked against exactly that case in the tests. Dollar weight and risk
// weight are different numbers and only one of them is what you are exposed to.
//
// A NOTE ON WHAT THESE SOLVERS ARE. Mean-variance optimisation is famously
// unstable: it takes expected returns as given, and small changes in an input
// nobody can measure produce large changes in the output. The functions here
// report the mathematics faithfully and do NOT pretend the result is advice.
// minVariance and riskParity need no expected returns at all, which is exactly
// why practitioners lean on them.
// ---------------------------------------------------------------------------

const TRADING_DAYS = 252;

/* --- alignment -------------------------------------------------------------
   Series are aligned BY DATE, never by index. Two listings on different
   venues, or one with a shorter history, do not share a row order — pairing
   them positionally compares Tuesday with Wednesday and produces a covariance
   that is quietly wrong rather than obviously broken. */

/**
 * @param {Record<string, Array<{d: string, c: number}>>} seriesBysymbol
 * @returns {{symbols: string[], dates: string[], returns: number[][]}}
 *   returns[i] is the aligned daily-return series for symbols[i].
 */
export function alignSeries(seriesBySymbol) {
  const symbols = Object.keys(seriesBySymbol || {});
  if (!symbols.length) return { symbols: [], dates: [], returns: [] };

  const byDate = symbols.map((s) => {
    const m = new Map();
    const pts = (seriesBySymbol[s] || []).filter((p) => p && p.d && Number(p.c) > 0);
    for (let i = 1; i < pts.length; i++) m.set(pts[i].d, Number(pts[i].c) / Number(pts[i - 1].c) - 1);
    return m;
  });

  /* The union is scanned, not series 0: if the first symbol happens to be the
     SHORT one, its keys are the only candidates and a long common history is
     invisible. */
  const all = new Set();
  for (const m of byDate) for (const d of m.keys()) all.add(d);
  const dates = [...all].filter((d) => byDate.every((m) => m.has(d))).sort();

  /* WHICH HOLDING IS COSTING THE HISTORY. Intersecting dates means one recent
     listing truncates every other series: adding a stock that IPO'd three
     weeks ago cut a four-name book from ~125 shared sessions to 13, and the
     covariance matrix silently became an estimate off three weeks of a
     selloff. Naming it lets a caller decide to drop it. */
  const firstDates = symbols.map((s, i) => {
    const keys = [...byDate[i].keys()].sort();
    return { symbol: s, first: keys[0] || null, sessions: keys.length };
  });
  const binding = firstDates
    .filter((f) => f.first)
    .sort((a, b) => String(b.first).localeCompare(String(a.first)))[0] || null;

  return {
    symbols, dates, returns: byDate.map((m) => dates.map((d) => m.get(d))),
    perSymbol: firstDates,
    overlapLimitedBy: binding && firstDates.length > 1 && binding.sessions < Math.max(...firstDates.map((f) => f.sessions))
      ? binding : null,
  };
}

/** Annualised covariance matrix from aligned return series (sample, n-1). */
export function covarianceMatrix(returns, periodsPerYear = TRADING_DAYS) {
  const k = returns.length;
  if (!k) return [];
  const n = returns[0].length;
  if (n < 2) return returns.map(() => new Array(k).fill(0));
  const means = returns.map((r) => r.reduce((s, x) => s + x, 0) / n);
  const cov = Array.from({ length: k }, () => new Array(k).fill(0));
  for (let i = 0; i < k; i++) {
    for (let j = i; j < k; j++) {
      let s = 0;
      for (let t = 0; t < n; t++) s += (returns[i][t] - means[i]) * (returns[j][t] - means[j]);
      const v = (s / (n - 1)) * periodsPerYear;
      cov[i][j] = v; cov[j][i] = v;
    }
  }
  return cov;
}

/** Annualised volatility of a weighted portfolio: sqrt(wᵀ Σ w). */
export function portfolioVolatility(weights, cov) {
  return Math.sqrt(Math.max(0, quadraticForm(weights, cov)));
}

function quadraticForm(w, cov) {
  let s = 0;
  for (let i = 0; i < w.length; i++) for (let j = 0; j < w.length; j++) s += w[i] * cov[i][j] * w[j];
  return s;
}

const matVec = (m, v) => m.map((row) => row.reduce((s, x, j) => s + x * v[j], 0));

/**
 * Where the risk actually is.
 *
 * Marginal contribution is (Sigma w)_i; the risk contribution of holding i is
 * w_i times that, and those sum EXACTLY to the portfolio variance — which is
 * why a percentage split is meaningful rather than a heuristic.
 *
 * @returns {{vol: number, contribution: number[], percent: number[]}|null}
 */
export function riskContributions(weights, cov) {
  const vol = portfolioVolatility(weights, cov);
  if (!(vol > 0)) return null;
  const mc = matVec(cov, weights);                       // marginal, in variance units
  const contribution = weights.map((w, i) => (w * mc[i]) / vol);
  const total = contribution.reduce((s, x) => s + x, 0);
  return {
    vol,
    contribution,
    percent: total === 0 ? contribution.map(() => 0) : contribution.map((c) => c / total),
  };
}

/* --- linear algebra ---------------------------------------------------------
   Gauss-Jordan with partial pivoting. Small k (a handful of holdings), so
   clarity beats a decomposition library.

   SINGULARITY IS NOT AN EDGE CASE HERE. Highly correlated holdings — which is
   precisely the situation portfolio analysis exists for — make the covariance
   matrix near-singular, and an unchecked inverse returns enormous offsetting
   weights that look like a strategy. It refuses instead. */
export function invertMatrix(m, tol = 1e-12) {
  const k = m.length;
  if (!k || m.some((r) => r.length !== k)) return null;
  const a = m.map((row, i) => [...row, ...Array.from({ length: k }, (_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < k; col++) {
    let piv = col;
    for (let r = col + 1; r < k; r++) if (Math.abs(a[r][col]) > Math.abs(a[piv][col])) piv = r;
    if (Math.abs(a[piv][col]) < tol) return null;         // singular / ill-conditioned
    [a[col], a[piv]] = [a[piv], a[col]];
    const p = a[col][col];
    for (let j = 0; j < 2 * k; j++) a[col][j] /= p;
    for (let r = 0; r < k; r++) {
      if (r === col) continue;
      const f = a[r][col];
      if (f === 0) continue;
      for (let j = 0; j < 2 * k; j++) a[r][j] -= f * a[col][j];
    }
  }
  return a.map((row) => row.slice(k));
}

const normalise = (w) => {
  const s = w.reduce((a, b) => a + b, 0);
  return s === 0 ? w.map(() => 0) : w.map((x) => x / s);
};

/**
 * Minimum-variance weights: w ∝ Σ⁻¹1, normalised to sum to 1.
 *
 * Needs NO expected returns, which is the reason to prefer it — the return
 * estimate is the input mean-variance optimisation is most sensitive to and
 * the one nobody can measure.
 *
 * @returns {{weights: number[], vol: number, hasShorts: boolean}|null}
 *   `hasShorts` is surfaced rather than silently clipped: a negative weight is
 *   a short position, which is a different instruction from "hold less".
 */
export function minVarianceWeights(cov) {
  const inv = invertMatrix(cov);
  if (!inv) return null;
  const ones = new Array(cov.length).fill(1);
  const raw = matVec(inv, ones);
  const denom = raw.reduce((s, x) => s + x, 0);
  if (!Number.isFinite(denom) || denom === 0) return null;
  const weights = raw.map((x) => x / denom);
  return { weights, vol: portfolioVolatility(weights, cov), hasShorts: weights.some((w) => w < 0) };
}

/**
 * Tangency (max-Sharpe) weights: w ∝ Σ⁻¹(mu − rf).
 * @param {number[]} expectedReturns annualised, as decimals
 */
export function maxSharpeWeights(cov, expectedReturns, riskFree = 0) {
  const inv = invertMatrix(cov);
  if (!inv || !Array.isArray(expectedReturns) || expectedReturns.length !== cov.length) return null;
  const excess = expectedReturns.map((r) => r - riskFree);
  const raw = matVec(inv, excess);
  const denom = raw.reduce((s, x) => s + x, 0);
  if (!Number.isFinite(denom) || denom === 0) return null;
  const weights = raw.map((x) => x / denom);
  const vol = portfolioVolatility(weights, cov);
  const ret = weights.reduce((s, w, i) => s + w * expectedReturns[i], 0);
  return {
    weights, vol, expectedReturn: ret,
    sharpe: vol > 0 ? (ret - riskFree) / vol : null,
    hasShorts: weights.some((w) => w < 0),
  };
}

/**
 * Risk-parity weights: every holding contributes the SAME share of portfolio
 * risk. Bridgewater's observation is that dollar-balancing is not
 * risk-balancing, and this is the allocation that actually equalises risk.
 *
 * Solved by the standard multiplicative fixed-point iteration
 * w_i <- w_i * (target_i / RC_i), renormalised each pass. Long-only and
 * convergent for a positive-definite covariance matrix; it reports whether it
 * converged instead of returning whatever it had reached at the iteration cap.
 *
 * @param {number[][]} cov
 * @param {{target?: number[], iterations?: number, tolerance?: number}} [opts]
 *   `target` allows a risk BUDGET (unequal shares) rather than strict parity.
 * @returns {{weights, percent, vol, converged, iterations}|null}
 */
export function riskParityWeights(cov, opts = {}) {
  const k = cov.length;
  if (!k) return null;
  if (cov.some((r, i) => !(cov[i][i] > 0))) return null;   // a zero-variance holding has no risk to equalise
  const target = normalise(
    Array.isArray(opts.target) && opts.target.length === k ? opts.target.map((x) => Math.max(0, x)) : new Array(k).fill(1),
  );
  const maxIter = Number.isFinite(opts.iterations) ? opts.iterations : 2000;
  const tol = Number.isFinite(opts.tolerance) ? opts.tolerance : 1e-10;

  /* Seeded by inverse volatility, which is already the exact answer when the
     holdings are uncorrelated — so the common case starts at the solution. */
  let w = normalise(cov.map((_, i) => 1 / Math.sqrt(cov[i][i])));
  let converged = false, iter = 0;

  for (; iter < maxIter; iter++) {
    const rc = riskContributions(w, cov);
    if (!rc) return null;
    const err = Math.max(...rc.percent.map((p, i) => Math.abs(p - target[i])));
    if (err < tol) { converged = true; break; }
    const next = normalise(w.map((wi, i) => (rc.percent[i] > 0 ? wi * (target[i] / rc.percent[i]) : wi)));
    /* Damped: the raw update oscillates on strongly correlated holdings. */
    w = normalise(w.map((wi, i) => 0.5 * wi + 0.5 * next[i]));
  }
  const rc = riskContributions(w, cov);
  return { weights: w, percent: rc?.percent || [], vol: rc?.vol ?? null, converged, iterations: iter };
}

/**
 * Diversification ratio: weighted average volatility / portfolio volatility.
 * 1.0 means the holdings are effectively one position; higher means the
 * correlation structure is doing work.
 */
export function diversificationRatio(weights, cov) {
  const vol = portfolioVolatility(weights, cov);
  if (!(vol > 0)) return null;
  const weighted = weights.reduce((s, w, i) => s + Math.abs(w) * Math.sqrt(cov[i][i]), 0);
  return weighted / vol;
}

/**
 * Historical portfolio VaR/CVaR: build the weighted portfolio's own return
 * series and read the quantile off it.
 *
 * NOT the sum of the individual VaRs, which would be the portfolio's loss only
 * if every holding had its worst day simultaneously. The difference is the
 * diversification benefit, and it is reported.
 */
export function portfolioTailRisk(weights, returns, confidence = 0.95, minObservations = 30) {
  if (!returns.length || returns[0].length < minObservations) return null;
  const n = returns[0].length;
  const port = [];
  for (let t = 0; t < n; t++) port.push(weights.reduce((s, w, i) => s + w * returns[i][t], 0));
  const sorted = [...port].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((1 - confidence) * sorted.length)));
  const cut = Math.max(1, Math.floor((1 - confidence) * sorted.length));
  const tail = sorted.slice(0, cut);
  return {
    var: Math.max(0, -sorted[idx]),
    expectedShortfall: Math.max(0, -(tail.reduce((s, x) => s + x, 0) / tail.length)),
    worst: Math.max(0, -sorted[0]),
    observations: n,
    confidence,
  };
}

/**
 * One call that answers "where is the risk in this book, and what would move
 * it". Everything is reported for the weights ACTUALLY held; the alternative
 * allocations are shown alongside, never substituted.
 */
export function analyzePortfolio(seriesBySymbol, weights, opts = {}) {
  const { symbols, dates, returns, perSymbol, overlapLimitedBy } = alignSeries(seriesBySymbol);
  if (symbols.length < 2 || dates.length < 3) {
    return {
      symbols, observations: dates.length, perSymbol, overlapLimitedBy,
      error: 'need at least two holdings with overlapping history',
    };
  }
  const w = Array.isArray(weights) && weights.length === symbols.length
    ? normalise(weights.map(Number))
    : new Array(symbols.length).fill(1 / symbols.length);

  const cov = covarianceMatrix(returns);
  const rc = riskContributions(w, cov);
  const corr = cov.map((row, i) => row.map((v, j) => {
    const d = Math.sqrt(cov[i][i] * cov[j][j]);
    return d > 0 ? v / d : 0;
  }));

  const out = {
    symbols,
    observations: dates.length,
    from: dates[0],
    to: dates[dates.length - 1],
    weights: w,
    volatility: rc?.vol ?? null,
    riskContribution: rc?.percent ?? null,
    correlation: corr,
    diversificationRatio: diversificationRatio(w, cov),
    tail: portfolioTailRisk(w, returns, opts.confidence ?? 0.95),
    /* The gap that motivates the whole module, stated as a number: how far the
       largest RISK share is from the largest DOLLAR share. */
    concentration: rc ? {
      largestWeight: Math.max(...w),
      largestRiskShare: Math.max(...rc.percent),
      symbolAtMostRisk: symbols[rc.percent.indexOf(Math.max(...rc.percent))],
    } : null,
    alternatives: {
      riskParity: riskParityWeights(cov),
      minVariance: minVarianceWeights(cov),
    },
    limits: [],
  };
  if (!out.alternatives.minVariance) {
    out.limits.push('covariance matrix is singular or near-singular — holdings are too collinear to invert, so minimum-variance weights are not reported');
  }
  if (out.alternatives.riskParity && !out.alternatives.riskParity.converged) {
    out.limits.push('risk-parity solver hit its iteration cap without converging');
  }
  if (dates.length < 60) {
    out.limits.push(`only ${dates.length} overlapping sessions — covariance is noisy at this length`);
  }
  if (overlapLimitedBy) {
    out.overlapLimitedBy = overlapLimitedBy;
    out.limits.push(
      `${overlapLimitedBy.symbol} has only ${overlapLimitedBy.sessions} sessions (from ${overlapLimitedBy.first}) `
      + `and every other holding is truncated to match — dropping it would widen the window`);
  }
  out.perSymbol = perSymbol;
  if (!out.tail) {
    out.limits.push(`fewer than 30 overlapping sessions — portfolio VaR and expected shortfall are not reported`);
  }
  return out;
}
