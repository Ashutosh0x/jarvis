// Portfolio-level analytics.
//
// Every fixture below has an answer that can be derived by hand, so these
// check the mathematics rather than a previously recorded output. The headline
// case is the 60/40 claim: if riskContributions is right, a 60/40 book must
// come back as roughly 94% equity RISK, and that number falls out of the
// covariance arithmetic rather than from anyone's assertion.

import * as P from '../portfolio.js';

let pass = 0, fail = 0;
const check = (n, c, d = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };
const near = (a, b, tol = 1e-9) => a != null && Math.abs(a - b) <= tol;

/** Covariance matrix from vols and a correlation matrix — the inputs a reader
 *  can verify by eye, rather than a matrix of raw numbers. */
const covOf = (vols, corr) => vols.map((si, i) => vols.map((sj, j) => si * sj * corr[i][j]));

/* --- the 60/40 claim --------------------------------------------------------
   Equities 16% vol, bonds 5% vol, correlation 0.1. By hand:
     Sw      = [0.01568, 0.00148]
     var     = 0.01          -> portfolio vol exactly 10%
     RC      = [0.09408, 0.00592] -> 94.08% / 5.92%
   Sixty percent of the dollars, ninety-four percent of the risk. */
{
  const cov = covOf([0.16, 0.05], [[1, 0.1], [0.1, 1]]);
  const rc = P.riskContributions([0.6, 0.4], cov);
  check('60/40: portfolio volatility is exactly 10%', near(rc.vol, 0.10, 1e-12), rc.vol.toFixed(6));
  check('60/40: equities carry ~94% of the RISK despite 60% of the dollars',
    near(rc.percent[0], 0.9408, 1e-9), `${(rc.percent[0] * 100).toFixed(2)}%`);
  check('60/40: bonds carry ~6%', near(rc.percent[1], 0.0592, 1e-9));
  check('risk contributions sum to 1', near(rc.percent.reduce((s, x) => s + x, 0), 1, 1e-12));
}

/* --- risk parity ------------------------------------------------------------ */
{
  // Uncorrelated, vols 20% and 10%: parity weights must be proportional to 1/sigma.
  const cov = covOf([0.2, 0.1], [[1, 0], [0, 1]]);
  const rp = P.riskParityWeights(cov);
  check('parity: converges', rp.converged === true, `after ${rp.iterations}`);
  check('parity: uncorrelated weights go as 1/vol -> 1/3 and 2/3',
    near(rp.weights[0], 1 / 3, 1e-6) && near(rp.weights[1], 2 / 3, 1e-6),
    rp.weights.map((w) => w.toFixed(4)).join(', '));
  check('parity: each holding really does contribute half the risk',
    near(rp.percent[0], 0.5, 1e-6) && near(rp.percent[1], 0.5, 1e-6));
  check('parity: weights sum to 1', near(rp.weights.reduce((s, x) => s + x, 0), 1, 1e-12));
  check('parity: is long-only', rp.weights.every((w) => w >= 0));

  // Identical vols and a shared correlation: symmetry forces equal weights.
  const sym = covOf([0.2, 0.2, 0.2], [[1, 0.5, 0.5], [0.5, 1, 0.5], [0.5, 0.5, 1]]);
  const rps = P.riskParityWeights(sym);
  check('parity: identical assets give equal weights',
    rps.weights.every((w) => near(w, 1 / 3, 1e-6)), rps.weights.map((w) => w.toFixed(4)).join(', '));

  // A risk BUDGET rather than parity: 70/30 of the risk, not of the dollars.
  const budget = P.riskParityWeights(cov, { target: [0.7, 0.3] });
  check('parity: an unequal risk budget is honoured',
    near(budget.percent[0], 0.7, 1e-6), `${(budget.percent[0] * 100).toFixed(2)}%`);
  check('parity: and that is NOT the same as 70/30 dollars',
    !near(budget.weights[0], 0.7, 0.01), budget.weights[0].toFixed(4));
}

/* --- minimum variance ------------------------------------------------------- */
{
  // Uncorrelated: min-variance weights go as 1/variance -> 0.2 / 0.8.
  const cov = covOf([0.2, 0.1], [[1, 0], [0, 1]]);
  const mv = P.minVarianceWeights(cov);
  check('min-var: uncorrelated weights go as 1/variance',
    near(mv.weights[0], 0.2, 1e-9) && near(mv.weights[1], 0.8, 1e-9),
    mv.weights.map((w) => w.toFixed(4)).join(', '));
  check('min-var: its volatility is below either holding alone',
    mv.vol < 0.1 && mv.vol > 0, mv.vol.toFixed(4));
  check('min-var: no shorts needed here', mv.hasShorts === false);

  /* A short IS the answer for strongly correlated holdings of different vol —
     reported rather than clipped, because "hold none" and "sell short" are
     different instructions. */
  const tight = covOf([0.30, 0.10], [[1, 0.95], [0.95, 1]]);
  const st = P.minVarianceWeights(tight);
  check('min-var: a required short is flagged, not silently clipped',
    st.hasShorts === true && st.weights.some((w) => w < 0),
    st.weights.map((w) => w.toFixed(3)).join(', '));
}

/* --- singular covariance ----------------------------------------------------
   Perfectly correlated holdings are not an exotic edge case: it is what two
   share classes, or a stock and its own ETF, look like. An unchecked inverse
   returns enormous offsetting weights that read as a strategy. */
{
  const singular = covOf([0.2, 0.2], [[1, 1], [1, 1]]);
  check('singular: the inverse is refused', P.invertMatrix(singular) === null);
  check('singular: minimum-variance is refused rather than fabricated',
    P.minVarianceWeights(singular) === null);
  check('singular: risk contributions still work — variance is well defined',
    P.riskContributions([0.5, 0.5], singular) !== null);
  check('diversification: perfectly correlated holdings give a ratio of 1',
    near(P.diversificationRatio([0.5, 0.5], singular), 1, 1e-12));
  check('diversification: uncorrelated holdings beat 1',
    P.diversificationRatio([0.5, 0.5], covOf([0.2, 0.2], [[1, 0], [0, 1]])) > 1.4);
}

/* --- max Sharpe ------------------------------------------------------------- */
{
  const cov = covOf([0.2, 0.1], [[1, 0], [0, 1]]);
  const ms = P.maxSharpeWeights(cov, [0.10, 0.05], 0.02);
  check('max-Sharpe: returns weights, a vol and a Sharpe', ms && ms.sharpe > 0);
  check('max-Sharpe: beats equal-weight on Sharpe', (() => {
    const eqVol = P.portfolioVolatility([0.5, 0.5], cov);
    const eqSharpe = (0.5 * 0.10 + 0.5 * 0.05 - 0.02) / eqVol;
    return ms.sharpe >= eqSharpe;
  })(), `${ms.sharpe.toFixed(3)}`);
  check('max-Sharpe: mismatched expected-return length is refused',
    P.maxSharpeWeights(cov, [0.1], 0.02) === null);
}

/* --- alignment by date ------------------------------------------------------ */
{
  const a = [{ d: '2026-01-01', c: 100 }, { d: '2026-01-02', c: 110 }, { d: '2026-01-03', c: 121 }];
  // b is missing 01-02 and has an extra day a never traded.
  const b = [{ d: '2026-01-01', c: 50 }, { d: '2026-01-03', c: 55 }, { d: '2026-01-06', c: 60 }];
  const al = P.alignSeries({ A: a, B: b });
  check('align: only dates BOTH series traded survive', al.dates.length === 1 && al.dates[0] === '2026-01-03',
    JSON.stringify(al.dates));
  check('align: every symbol gets the same number of observations',
    al.returns.every((r) => r.length === al.dates.length));
  check('align: empty input is safe', P.alignSeries({}).symbols.length === 0);
  check('align: null is safe', P.alignSeries(null).symbols.length === 0);
}

/* --- portfolio tail risk ---------------------------------------------------- */
{
  /* Two anti-correlated series: the portfolio's own worst day is much smaller
     than either holding's, which is the whole diversification argument. Adding
     the individual VaRs would overstate the loss badly. */
  const n = 120;
  const r1 = Array.from({ length: n }, (_, i) => (i % 2 ? 0.03 : -0.03));
  const r2 = r1.map((x) => -x);
  const tail = P.portfolioTailRisk([0.5, 0.5], [r1, r2], 0.95);
  check('tail: a perfectly hedged book has no loss to report', near(tail.var, 0, 1e-12));
  check('tail: observation count is reported', tail.observations === n);

  const solo = P.portfolioTailRisk([1, 0], [r1, r2], 0.95);
  check('tail: the un-hedged version does have a loss', solo.var > 0.02);
  check('tail: CVaR is at least VaR', solo.expectedShortfall >= solo.var);
  check('tail: too little history is refused',
    P.portfolioTailRisk([0.5, 0.5], [[0.01, 0.02], [0.01, 0.02]], 0.95) === null);
}

/* --- analyzePortfolio -------------------------------------------------------- */
{
  const mk = (start, step, n = 90) => Array.from({ length: n }, (_, i) => ({
    d: `2026-${String(1 + Math.floor(i / 28)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`,
    c: start * (1 + step * Math.sin(i / 4)) + i * 0.1,
  }));
  const res = P.analyzePortfolio({ AAA: mk(100, 0.05), BBB: mk(50, 0.01) }, [0.6, 0.4]);
  check('analyze: reports the symbols and the overlap window',
    res.symbols.length === 2 && res.observations > 10 && res.from < res.to);
  check('analyze: risk contribution shares sum to 1',
    near(res.riskContribution.reduce((s, x) => s + x, 0), 1, 1e-9));
  check('analyze: names the holding carrying the most risk',
    res.concentration.symbolAtMostRisk === 'AAA' || res.concentration.symbolAtMostRisk === 'BBB');
  check('analyze: surfaces the dollar-vs-risk gap',
    typeof res.concentration.largestWeight === 'number'
    && typeof res.concentration.largestRiskShare === 'number');
  check('analyze: offers risk-parity and minimum-variance alternatives',
    res.alternatives.riskParity !== null);
  check('analyze: correlation matrix has a unit diagonal',
    near(res.correlation[0][0], 1, 1e-9) && near(res.correlation[1][1], 1, 1e-9));
  check('analyze: defaults to equal weight when none is given',
    near(P.analyzePortfolio({ AAA: mk(100, 0.05), BBB: mk(50, 0.01) }).weights[0], 0.5, 1e-12));
  check('analyze: weights are normalised, not taken raw',
    near(P.analyzePortfolio({ AAA: mk(100, 0.05), BBB: mk(50, 0.01) }, [3, 1]).weights[0], 0.75, 1e-12));
  check('analyze: a single holding is refused with a reason',
    /at least two/.test(P.analyzePortfolio({ AAA: mk(100, 0.05) }, [1]).error || ''));
  check('analyze: a short overlap is stated in limits', (() => {
    const short = P.analyzePortfolio({ AAA: mk(100, 0.05, 20), BBB: mk(50, 0.01, 20) });
    return short.limits.some((l) => /overlapping sessions/.test(l));
  })());
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
