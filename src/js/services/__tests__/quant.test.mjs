import * as Q from '../quant.js';

let pass = 0, fail = 0;
const approx = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
function check(name, cond) { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); }

// --- returns / stats ---
{ const dr = Q.dailyReturns([100, 110, 99]); check('dailyReturns basic', dr.length===2 && approx(dr[0],0.1) && approx(dr[1],-0.1)); }
check('stdev sample (n-1)', approx(Q.stdev([2, 4, 4, 4, 5, 5, 7, 9]), 2.138089935, 1e-6));
check('cumulativeReturn', approx(Q.cumulativeReturn([100, 150]), 0.5));
check('maxDrawdown 100->50', approx(Q.maxDrawdown([100, 120, 60, 80]), 0.6 * -1 + 0, 1e-9) || approx(Q.maxDrawdown([100,120,60,80]), -0.5));

// maxDrawdown: peak 120 -> trough 60 = -50%
check('maxDrawdown -50%', approx(Q.maxDrawdown([100, 120, 60, 80]), -0.5, 1e-9));
check('maxDrawdown monotonic up = 0', approx(Q.maxDrawdown([10, 20, 30]), 0));

// --- annualization identity: constant daily return r for 252 days -> (1+r)^252-1 ---
const r = 0.001;
const series = Array(252).fill(r);
check('annualizedReturn compounding', approx(Q.annualizedReturn(series), Math.pow(1 + r, 252) - 1, 1e-9));
check('annualizedVolatility of constant = 0', approx(Q.annualizedVolatility(series), 0));

// --- Sharpe: build a series with known ann return and vol ---
// Zero-vol positive return -> Sharpe 0 (guard), and correlation of identical series = 1
check('sharpe zero-vol guard', Q.sharpeRatio(series, 0) === 0);
const a = [0.01, -0.02, 0.03, 0.00, -0.01];
check('correlation self = 1', approx(Q.correlation(a, a), 1, 1e-9));
check('correlation anti = -1', approx(Q.correlation(a, a.map(x => -x)), -1, 1e-9));

// --- beta/alpha: asset = 2*bench exactly -> beta 2, alpha 0 ---
const bench = [0.01, -0.005, 0.02, -0.01, 0.015];
const asset = bench.map(x => 2 * x);
const ba = Q.betaAlpha(asset, bench);
check('beta = 2.0', approx(ba.beta, 2, 1e-9));
check('alpha = 0', approx(ba.alpha, 0, 1e-9));

// --- Black-Scholes reference values (Hull textbook) ---
// Call: S=42,K=40,r=0.10,sigma=0.20,T=0.5 -> 4.759 ; Put -> 0.808
const call = Q.blackScholes(42, 40, 0.5, 0.20, 0.10, 0, 'call');
const put  = Q.blackScholes(42, 40, 0.5, 0.20, 0.10, 0, 'put');
check('BS call price ~4.759', approx(call.price, 4.759, 0.01));
check('BS put price ~0.808', approx(put.price, 0.808, 0.01));
// Put-call parity: C - P = S - K*e^{-rT}
const parity = 42 - 40 * Math.exp(-0.10 * 0.5);
check('put-call parity', approx(call.price - put.price, parity, 0.01));
// ATM call delta ~ N(d1) in (0,1); gamma>0; vega>0
check('call delta in (0,1)', call.delta > 0 && call.delta < 1);
check('put delta in (-1,0)', put.delta < 0 && put.delta > -1);
check('gamma positive', call.gamma > 0);
check('vega positive', call.vega > 0);
check('call theta negative', call.theta < 0);

// --- analyzeSeries wiring ---
const an = Q.analyzeSeries([100, 101, 99, 102, 98, 105], { benchmarkPrices: [100,100.5,99.5,101,99,103] });
check('analyzeSeries has sharpe', typeof an.sharpe === 'number');
check('analyzeSeries has beta (benchmark)', typeof an.beta === 'number');
check('analyzeSeries maxDD <= 0', an.maxDrawdown <= 0);

/* --- loss metrics -----------------------------------------------------------
   Fixtures where the answer is known by construction, so a refactor is checked
   against arithmetic rather than against a previously recorded output. */
{
  // 100 returns: -0.10, -0.09, ... the 100 worst-to-best in known order.
  const rs = Array.from({ length: 100 }, (_, i) => (i - 50) / 1000); // -0.050 .. +0.049
  const v95 = Q.historicalVaR(rs, 0.95);
  // sorted[0]=-0.050 .. sorted[5]=-0.045; nearest-rank index floor(0.05*100)=5.
  check('VaR: reads the 5th-percentile loss off the sorted sample',
    approx(v95.var, 0.045, 1e-12));
  check('VaR: reported as a positive loss magnitude', v95.var > 0);
  check('VaR: 99% is at least as bad as 95%', Q.historicalVaR(rs, 0.99).var >= v95.var);
  check('VaR: the worst observation is carried alongside', approx(v95.worst, 0.05, 1e-12));
  check('VaR: observation count reported', v95.observations === 100);

  /* A confident VaR off 10 sessions is the failure mode this guards. */
  check('VaR: too small a sample is refused, not estimated',
    Q.historicalVaR([0.01, -0.02, 0.03], 0.95) === null);
  check('VaR: a nonsense confidence is refused', Q.historicalVaR(rs, 1.5) === null);
  check('VaR: an all-gains series has no loss to report', Q.historicalVaR(
    Array.from({ length: 60 }, () => 0.01), 0.95).var === 0);

  const es = Q.expectedShortfall(rs, 0.95);
  check('CVaR: averages the tail beyond VaR', approx(es.expectedShortfall, 0.048, 1e-12));
  check('CVaR: is worse than VaR — that is the point of it', es.expectedShortfall > v95.var);
  check('CVaR: says how many observations were in the tail', es.tailObservations === 5);
  check('CVaR: too small a sample is refused', Q.expectedShortfall([0.01, -0.01], 0.95) === null);
}

/* --- benchmark-relative ----------------------------------------------------- */
{
  const bench = [0.01, -0.02, 0.03, -0.01, 0.02, 0.01, -0.03, 0.02, 0.01, -0.01, 0.02, -0.02];
  const same = bench.slice();
  const double = bench.map((r) => r * 2);

  check('R2: an identical series is fully explained', approx(Q.rSquared(same, bench), 1, 1e-9));
  check('R2: a proportional series is also fully explained',
    approx(Q.rSquared(double, bench), 1, 1e-9));
  check('R2: is bounded to 0..1', (() => {
    const r2 = Q.rSquared([0.01, -0.05, 0.02, 0.04, -0.01, 0.03, -0.02, 0.01, 0.05, -0.03, 0.02, 0.01], bench);
    return r2 >= 0 && r2 <= 1;
  })());

  check('tracking error: zero when the series is the benchmark',
    approx(Q.trackingError(same, bench), 0, 1e-12));
  check('tracking error: positive once it deviates', Q.trackingError(double, bench) > 0);
  check('tracking error: too little data is null', Q.trackingError([0.01], [0.01]) === null);

  check('information ratio: undefined without tracking error, not Infinity',
    Q.informationRatio(same, bench) === null);
  check('information ratio: a series that beats the benchmark scores positive',
    Q.informationRatio(bench.map((r) => r + 0.001), bench) > 0);

  /* The asymmetry a single beta hides: all of the upside, none of the downside. */
  const asym = bench.map((r) => (r > 0 ? r : r * 0.5));
  const cap = Q.upDownCapture(asym, bench);
  check('capture: full participation on the way up', approx(cap.up, 1, 1e-9));
  check('capture: half participation on the way down', approx(cap.down, 0.5, 1e-9));
  check('capture: counts the periods each side used', cap.upPeriods > 0 && cap.downPeriods > 0);
  check('capture: no up periods yields null rather than 0',
    Q.upDownCapture([0.01, 0.02], [-0.01, -0.02]).up === null);
}

/* --- analyzeSeries now carries them ----------------------------------------- */
{
  const prices = Array.from({ length: 80 }, (_, i) => 100 * (1 + 0.004 * Math.sin(i / 3)) + i * 0.2);
  const bench = Array.from({ length: 80 }, (_, i) => 50 * (1 + 0.003 * Math.sin(i / 3)) + i * 0.1);
  const a = Q.analyzeSeries(prices, { benchmarkPrices: bench });
  check('analyzeSeries: reports VaR at 95 and 99', a.var95 != null && a.var99 != null);
  check('analyzeSeries: reports expected shortfall', a.cvar95 != null);
  check('analyzeSeries: reports R2 with a benchmark', typeof a.rSquared === 'number');
  check('analyzeSeries: reports tracking error and information ratio',
    typeof a.trackingError === 'number' && 'informationRatio' in a);
  check('analyzeSeries: reports up/down capture', a.capture && 'up' in a.capture);
  check('analyzeSeries: omits benchmark metrics when no benchmark is given',
    Q.analyzeSeries(prices).rSquared === undefined);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
