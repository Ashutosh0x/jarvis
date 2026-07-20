// ---------------------------------------------------------------------------
// Quant analytics engine — pure, deterministic financial math.
//
// The rule this module enforces: the LLM NEVER computes a financial number.
// Sharpe ratios, volatility, drawdowns, betas and option Greeks are exact math,
// not something to approximate in a language model. Every function here is a
// pure function of its inputs — no I/O, no clock, no globals — so each is
// exhaustively testable against known analytical values, and the same code runs
// in Node (tests) and the renderer.
//
// Conventions:
//   - "returns" are SIMPLE periodic returns unless a function says otherwise.
//   - Annualization uses 252 trading days for equities.
//   - Rates are decimals (0.04 = 4%), not percents.
// ---------------------------------------------------------------------------

const TRADING_DAYS = 252;

/** Simple period-over-period returns from a price series: r_t = P_t/P_{t-1} - 1.
 *  Non-positive or missing prices are skipped so a data gap cannot poison the
 *  whole series with an Infinity. */
export function dailyReturns(prices) {
  const out = [];
  for (let i = 1; i < prices.length; i++) {
    const a = prices[i - 1], b = prices[i];
    if (a > 0 && b > 0) out.push(b / a - 1);
  }
  return out;
}

export function mean(xs) {
  if (!xs.length) return 0;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

/** Sample standard deviation (n-1). Sample, not population: return series are
 *  samples of an unknown process, and the n-1 correction is what every finance
 *  text and library (numpy ddof=1) uses for risk. */
export function stdev(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const v = xs.reduce((s, x) => s + (x - m) * (x - m), 0) / (xs.length - 1);
  return Math.sqrt(v);
}

/** Total return over the whole series: P_last / P_first - 1. */
export function cumulativeReturn(prices) {
  const p = prices.filter((x) => x > 0);
  if (p.length < 2) return 0;
  return p[p.length - 1] / p[0] - 1;
}

/** Annualized return (CAGR) from daily returns, geometrically compounded —
 *  NOT the arithmetic mean × 252, which overstates growth because it ignores
 *  compounding and volatility drag. */
export function annualizedReturn(returns, periodsPerYear = TRADING_DAYS) {
  if (!returns.length) return 0;
  const growth = returns.reduce((g, r) => g * (1 + r), 1);
  const years = returns.length / periodsPerYear;
  if (years <= 0) return 0;
  return Math.pow(growth, 1 / years) - 1;
}

/** Annualized volatility: stdev of daily returns × sqrt(252). */
export function annualizedVolatility(returns, periodsPerYear = TRADING_DAYS) {
  return stdev(returns) * Math.sqrt(periodsPerYear);
}

/**
 * Sharpe ratio: excess return per unit of total volatility.
 *   (annualized return − riskFree) / annualized volatility
 * riskFree is an ANNUAL rate. Zero vol returns 0 rather than Infinity — a
 * flat series has no risk-adjusted signal to report.
 */
export function sharpeRatio(returns, riskFree = 0, periodsPerYear = TRADING_DAYS) {
  const vol = annualizedVolatility(returns, periodsPerYear);
  // Near-zero, not exactly zero: a "flat" series still carries ~1e-18 of
  // floating-point volatility from accumulated rounding, and dividing by that
  // would report a nonsense Sharpe of 1e17 instead of "no risk signal".
  if (!(vol > 1e-12)) return 0;
  return (annualizedReturn(returns, periodsPerYear) - riskFree) / vol;
}

/**
 * Sortino ratio: like Sharpe but penalizes only DOWNSIDE deviation, since
 * upside volatility is not risk. Downside deviation is the stdev of returns
 * below the (per-period) target, using the full n in the denominator — the
 * standard downside-risk convention.
 */
export function sortinoRatio(returns, riskFree = 0, periodsPerYear = TRADING_DAYS) {
  if (!returns.length) return 0;
  const targetDaily = riskFree / periodsPerYear;
  const downsideSq = returns.map((r) => {
    const d = Math.min(0, r - targetDaily);
    return d * d;
  });
  const dd = Math.sqrt(mean(downsideSq)) * Math.sqrt(periodsPerYear);
  if (!(dd > 1e-12)) return 0; // near-zero downside → no risk signal (see sharpe)
  return (annualizedReturn(returns, periodsPerYear) - riskFree) / dd;
}

/**
 * Maximum drawdown: the largest peak-to-trough decline in the price series,
 * returned as a negative fraction (−0.35 = a 35% drawdown). The single most
 * important risk number a series can report, and one an LLM routinely gets
 * wrong by eyeballing.
 */
export function maxDrawdown(prices) {
  const p = prices.filter((x) => x > 0);
  let peak = -Infinity, mdd = 0;
  for (const price of p) {
    if (price > peak) peak = price;
    const dd = price / peak - 1;
    if (dd < mdd) mdd = dd;
  }
  return mdd;
}

/** Pearson correlation of two equal-length return series. */
export function correlation(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const x = a.slice(-n), y = b.slice(-n);
  const mx = mean(x), my = mean(y);
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx, dy = y[i] - my;
    cov += dx * dy; vx += dx * dx; vy += dy * dy;
  }
  if (vx === 0 || vy === 0) return 0;
  return cov / Math.sqrt(vx * vy);
}

/**
 * Beta and alpha of an asset against a benchmark, from aligned return series.
 *   beta  = cov(asset, bench) / var(bench)   — sensitivity to the market
 *   alpha = annualized( asset − beta·bench )  — return not explained by beta
 * Alpha is annualized so it reads as a yearly excess, matching how it is quoted.
 */
export function betaAlpha(assetReturns, benchReturns, periodsPerYear = TRADING_DAYS) {
  const n = Math.min(assetReturns.length, benchReturns.length);
  if (n < 2) return { beta: 0, alpha: 0 };
  const a = assetReturns.slice(-n), m = benchReturns.slice(-n);
  const ma = mean(a), mm = mean(m);
  let cov = 0, varm = 0;
  for (let i = 0; i < n; i++) {
    cov += (a[i] - ma) * (m[i] - mm);
    varm += (m[i] - mm) * (m[i] - mm);
  }
  if (varm === 0) return { beta: 0, alpha: 0 };
  const beta = cov / varm;
  const dailyAlpha = ma - beta * mm; // Jensen's alpha, per period
  return { beta, alpha: dailyAlpha * periodsPerYear };
}

// ---------------------------------------------------------------------------
// Options: Black-Scholes-Merton pricing and Greeks.
// ---------------------------------------------------------------------------

/** Standard normal PDF. */
export function normPdf(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/** Standard normal CDF via a high-accuracy erf approximation
 *  (Abramowitz & Stegun 7.1.26, ~1e-7 max error) — good enough that option
 *  prices match reference values to the cent. */
export function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-0.5 * x * x);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

/**
 * Black-Scholes-Merton price and Greeks for a European option.
 *
 *   S sigma  spot price, annualized volatility (decimal)
 *   K T      strike, time to expiry in YEARS
 *   r q      risk-free rate, continuous dividend yield (decimals)
 *   type     'call' | 'put'
 *
 * Greeks are returned in their conventional units: theta PER DAY (÷365) and
 * vega/rho PER 1% move (÷100), because that is how a desk reads them.
 */
export function blackScholes(S, K, T, sigma, r = 0, q = 0, type = 'call') {
  const isCall = type !== 'put';
  // Degenerate expiry/vol: fall back to discounted intrinsic value, no Greeks.
  if (T <= 0 || sigma <= 0) {
    const intrinsic = isCall ? Math.max(0, S - K) : Math.max(0, K - S);
    return { price: intrinsic, delta: 0, gamma: 0, vega: 0, theta: 0, rho: 0 };
  }
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const eqT = Math.exp(-q * T), erT = Math.exp(-r * T);
  const Nd1 = normCdf(d1), Nd2 = normCdf(d2);

  let price, delta, theta, rho;
  if (isCall) {
    price = S * eqT * Nd1 - K * erT * Nd2;
    delta = eqT * Nd1;
    theta = (-S * eqT * normPdf(d1) * sigma / (2 * sqrtT) - r * K * erT * Nd2 + q * S * eqT * Nd1);
    rho = K * T * erT * Nd2 / 100;
  } else {
    price = K * erT * normCdf(-d2) - S * eqT * normCdf(-d1);
    delta = -eqT * normCdf(-d1);
    theta = (-S * eqT * normPdf(d1) * sigma / (2 * sqrtT) + r * K * erT * normCdf(-d2) - q * S * eqT * normCdf(-d1));
    rho = -K * T * erT * normCdf(-d2) / 100;
  }
  const gamma = eqT * normPdf(d1) / (S * sigma * sqrtT);
  const vega = S * eqT * normPdf(d1) * sqrtT / 100; // per 1 vol point
  return { price, delta, gamma, vega, theta: theta / 365, rho };
}

/**
 * One-shot risk/return summary of a price series (plus optional benchmark).
 * The headline block a "how risky is X" question needs, computed once.
 */
export function analyzeSeries(prices, opts = {}) {
  const returns = dailyReturns(prices);
  const riskFree = opts.riskFree ?? 0;
  const out = {
    observations: returns.length,
    cumulativeReturn: cumulativeReturn(prices),
    annualizedReturn: annualizedReturn(returns),
    annualizedVolatility: annualizedVolatility(returns),
    sharpe: sharpeRatio(returns, riskFree),
    sortino: sortinoRatio(returns, riskFree),
    maxDrawdown: maxDrawdown(prices),
  };
  if (opts.benchmarkPrices && opts.benchmarkPrices.length > 1) {
    const br = dailyReturns(opts.benchmarkPrices);
    const { beta, alpha } = betaAlpha(returns, br);
    out.beta = beta;
    out.alpha = alpha;
    out.correlation = correlation(returns, br);
  }
  return out;
}
