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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
