// ---------------------------------------------------------------------------
// Peer-relative price analysis — separating "the sector moved" from "this
// company moved". Pure: input is closing series the caller measured, output is
// numbers. No fetching, no clock, no guessing at a peer group it was not given.
//
// WHY THIS EXISTS, measured rather than argued. On 30 Jul 2026 a live run over
// the memory complex returned these one-day moves:
//
//     MU -9.9%   SNDK -7.3%   SKHY -2.6%   WDC -0.3%   000660.KS -4.2%
//
// and these correlations of daily returns over three months:
//
//     MU/SNDK r=0.84   MU/WDC r=0.74   SNDK/SKHY r=0.80   MU/000660.KS r=0.58
//
// Announcing "Micron fell 9.9%" is true and misleading in the same breath: the
// entire complex fell, every name was down 34-57% from a late-June high, and
// the number a listener actually wants is how much of that was Micron. That is
// the move minus what its beta to the group already explains.
//
// WHAT THIS DELIBERATELY DOES NOT DO. It does not name a cause. Correlation
// across five memory names is not evidence of any particular reason, and the
// module has no way to know one. It reports the decomposition and the
// confidence in it; the reason has to come from a filing or a source.
// ---------------------------------------------------------------------------

/* Peer groups are DATA, not inference. A name belongs here because it competes
   in the same product market, not because its chart happened to correlate. */
const PEER_GROUPS = {
    memory: {
        name: 'Memory and storage',
        members: ['MU', 'SNDK', 'WDC', 'SKHY', '000660.KS'],
        /* Traded on other venues or not listed at all, so they cannot enter the
           index but matter to the read. Named so a summary can say so. */
        offIndex: ['005930.KS (Samsung)', 'CXMT (private)'],
    },
};

/** Daily simple returns from a closing series. @param {Array<{d,c}>} series */
function dailyReturns(series) {
    const out = new Map();
    const pts = (Array.isArray(series) ? series : [])
        .filter((p) => p && p.d && Number.isFinite(Number(p.c)) && Number(p.c) > 0);
    for (let i = 1; i < pts.length; i++) {
        const prev = Number(pts[i - 1].c), cur = Number(pts[i].c);
        out.set(pts[i].d, (cur - prev) / prev);
    }
    return out;
}

/** Returns for the dates BOTH series have. Trading calendars differ across
    venues — a Seoul listing and a Nasdaq one share only part of the year, and
    silently pairing them by index rather than by date compares Tuesday with
    Wednesday. */
function alignReturns(a, b) {
    const days = [...a.keys()].filter((d) => b.has(d)).sort();
    return { days, x: days.map((d) => a.get(d)), y: days.map((d) => b.get(d)) };
}

const mean = (v) => (v.length ? v.reduce((s, n) => s + n, 0) / v.length : 0);

/** Pearson correlation. Returns null rather than NaN when it is undefined. */
function correlation(a, b, minPoints = 10) {
    const { x, y } = alignReturns(a, b);
    if (x.length < minPoints) return { r: null, n: x.length, insufficient: true };
    const mx = mean(x), my = mean(y);
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < x.length; i++) {
        const dx = x[i] - mx, dy = y[i] - my;
        sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
    }
    /* NEAR-zero, not exactly zero. A series whose return is identical every
       session has a variance of ~1e-33 rather than 0 in floating point, so an
       `=== 0` guard let it through and the ratio below exploded — a synthetic
       constant-decline fixture produced a beta of 2e14. Anything under this is
       a degenerate series, not a market. */
    const DEGENERATE = 1e-20;
    if (sxx < DEGENERATE || syy < DEGENERATE) return { r: null, n: x.length, insufficient: true };
    return { r: sxy / Math.sqrt(sxx * syy), n: x.length, insufficient: false };
}

/** OLS of target returns on benchmark returns: target = alpha + beta*bench. */
function beta(target, bench, minPoints = 10) {
    const { x, y } = alignReturns(target, bench); // x = target, y = bench
    if (x.length < minPoints) return { beta: null, alpha: null, n: x.length, insufficient: true };
    const mx = mean(x), my = mean(y);
    let cov = 0, varb = 0;
    for (let i = 0; i < x.length; i++) { cov += (y[i] - my) * (x[i] - mx); varb += (y[i] - my) ** 2; }
    /* Same degenerate-benchmark guard as correlation: dividing by a variance of
       1e-33 yields a beta with no meaning and a confident-looking number. */
    if (!(varb > 1e-20)) return { beta: null, alpha: null, n: x.length, insufficient: true };
    const b = cov / varb;
    return { beta: b, alpha: mx - b * my, n: x.length, insufficient: false };
}

/** Equal-weight return index of the peers, per date. A date is only usable if
    at least two peers traded on it, otherwise "the sector" is one name. */
function peerIndex(peerReturns, minMembers = 2) {
    const byDate = new Map();
    for (const rets of peerReturns) {
        for (const [d, r] of rets) {
            if (!byDate.has(d)) byDate.set(d, []);
            byDate.get(d).push(r);
        }
    }
    const idx = new Map();
    for (const [d, vals] of byDate) if (vals.length >= minMembers) idx.set(d, mean(vals));
    return idx;
}

/** Annualised realised volatility from daily returns (252 trading days). */
function realizedVol(rets, minPoints = 10) {
    const v = [...rets.values()];
    if (v.length < minPoints) return null;
    const m = mean(v);
    const varr = v.reduce((s, n) => s + (n - m) ** 2, 0) / (v.length - 1);
    return Math.sqrt(varr) * Math.sqrt(252);
}

/** Trailing return over `bars` sessions. Null when the history is too short —
    a listing three weeks old HAS no one-month return, and inventing one from
    the oldest bar available silently reports a shorter window as a longer one. */
function trailingReturn(series, bars) {
    const pts = (series || []).filter((p) => Number.isFinite(Number(p?.c)));
    if (pts.length < bars + 1) return null;
    const last = Number(pts.at(-1).c), then = Number(pts.at(-1 - bars).c);
    return then > 0 ? ((last - then) / then) * 100 : null;
}

/** Peak-to-current drawdown over whatever history was supplied. */
function drawdown(series) {
    const pts = (series || []).filter((p) => Number.isFinite(Number(p?.c)));
    if (pts.length < 2) return null;
    let hi = pts[0];
    for (const p of pts) if (Number(p.c) > Number(hi.c)) hi = p;
    const last = pts.at(-1);
    return {
        high: Number(hi.c), highDate: hi.d, last: Number(last.c), lastDate: last.d,
        pct: ((Number(last.c) - Number(hi.c)) / Number(hi.c)) * 100,
    };
}

const WINDOWS = { d1: 1, d5: 5, m1: 21, m3: 63, m6: 126, y1: 252 };

/**
 * Full decomposition of one symbol's move against its peer group.
 *
 * @param {{symbol: string, series: Array<{d,c}>}} target
 * @param {Array<{symbol: string, series: Array<{d,c}>}>} peers
 * @param {{minPoints?: number}} [opts]
 */
function analyzeMove(target, peers = [], opts = {}) {
    const minPoints = Number.isFinite(opts.minPoints) ? opts.minPoints : 10;
    const series = target?.series || [];
    const tRets = dailyReturns(series);

    const returns = {};
    for (const [k, bars] of Object.entries(WINDOWS)) returns[k] = trailingReturn(series, bars);

    /* A `= []` default covers undefined and NOT null, and this is called with
       whatever a caller or an IPC message carried — so `null` threw a TypeError
       instead of returning an absolute-move-only result. */
    const usablePeers = (Array.isArray(peers) ? peers : [])
        .filter((p) => p && p.symbol !== target?.symbol && (p.series || []).length > 1);
    const idx = peerIndex(usablePeers.map((p) => dailyReturns(p.series)));

    const corr = correlation(tRets, idx, minPoints);
    const fit = beta(tRets, idx, minPoints);

    /* TODAY, SPLIT. What the sector explains is beta x the sector's move; what
       is left is the part that belongs to this name. With no usable fit the
       split is not reported at all rather than reported as zero. */
    const days = [...tRets.keys()].sort();
    const lastDay = days.at(-1) || null;
    const move = lastDay != null ? tRets.get(lastDay) * 100 : null;

    /* CROSS-VENUE CALENDARS. A Seoul listing closes a session the US names have
       not started, so its newest bar has no peer to compare against and the
       whole decomposition came back empty for it. Compare on the most recent
       date the target and the index actually share, and say which date that
       was — a stale comparison presented as today's is worse than none. */
    const comparedOn = [...days].reverse().find((d) => idx.has(d)) || null;
    const sectorMove = comparedOn != null ? idx.get(comparedOn) * 100 : null;
    const targetOnCompared = comparedOn != null ? tRets.get(comparedOn) * 100 : null;
    const explained = fit.beta != null && sectorMove != null ? fit.beta * sectorMove : null;
    const idiosyncratic = explained != null && targetOnCompared != null
        ? targetOnCompared - explained : null;

    /* BREADTH. How many peers moved the same way — one name falling and one
       sector falling look identical in a single number. */
    let down = 0, up = 0, counted = 0;
    for (const p of usablePeers) {
        const r = dailyReturns(p.series).get(comparedOn);
        if (r == null) continue;
        counted++; r < 0 ? down++ : up++;
    }

    const vol = realizedVol(tRets, minPoints);
    /* How unusual today is against this name's own noise, not a fixed number of
       percent — an 8% day is ordinary for one of these and extreme for a utility. */
    const dailyVol = vol != null ? vol / Math.sqrt(252) : null;
    const zScore = dailyVol && move != null ? (move / 100) / dailyVol : null;

    return {
        symbol: target?.symbol || null,
        asOf: lastDay,
        /* The date the sector split refers to. Equal to asOf for names on the
           same calendar; earlier for one whose venue is ahead of its peers. */
        comparedOn,
        moveOnComparedDate: targetOnCompared,
        bars: series.length,
        returns,
        drawdown: drawdown(series),
        volAnnualisedPct: vol != null ? vol * 100 : null,
        move,
        sectorMove,
        beta: fit.beta,
        correlation: corr.r,
        explainedBySector: explained,
        idiosyncratic,
        zScore,
        breadth: counted ? { down, up, of: counted } : null,
        peersUsed: usablePeers.map((p) => p.symbol),
        /* Every reason the numbers above may be weak, stated rather than
           implied by a null. A three-week-old listing produces a page of nulls
           that otherwise look like a bug. */
        limits: [
            series.length < minPoints + 1
                ? `only ${series.length} sessions of history — trailing windows and volatility need more`
                : null,
            corr.insufficient ? `peer overlap too short to correlate (${corr.n} shared sessions)` : null,
            fit.insufficient ? 'not enough overlap to fit a beta, so the split is not reported' : null,
            !usablePeers.length ? 'no peer series supplied — this is an absolute move only' : null,
            comparedOn && lastDay && comparedOn !== lastDay
                ? `sector split is for ${comparedOn}, the last session shared with the peer group, not ${lastDay}`
                : null,
        ].filter(Boolean),
    };
}

/** One-line spoken summary. Says what is known and stops. */
function describeMove(a) {
    if (!a || a.move == null) return `${a?.symbol || 'symbol'}: no usable price history.`;
    const pct = (v, dp = 1) => `${v >= 0 ? 'up ' : 'down '}${Math.abs(v).toFixed(dp)}%`;
    const bits = [`${a.symbol} ${pct(a.move)} on ${a.asOf}`];
    if (a.sectorMove != null) {
        /* Name the date when the comparison is not from the same session, so a
           cross-venue read is never spoken as though it were simultaneous. */
        const when = a.comparedOn && a.comparedOn !== a.asOf ? ` on ${a.comparedOn}` : '';
        bits.push(`its peer group ${pct(a.sectorMove)}${when}`);
    }
    if (a.idiosyncratic != null && Math.abs(a.idiosyncratic) >= 0.5) {
        bits.push(`${pct(a.idiosyncratic)} beyond what the sector explains`);
    } else if (a.idiosyncratic != null) {
        bits.push('essentially all of it is the sector');
    }
    if (a.breadth && a.breadth.of > 1) bits.push(`${a.breadth.down} of ${a.breadth.of} peers also fell`);
    if (a.drawdown) bits.push(`${Math.abs(a.drawdown.pct).toFixed(0)}% below its ${a.drawdown.highDate} high`);
    return bits.join('; ') + '.';
}

module.exports = {
    PEER_GROUPS, WINDOWS,
    dailyReturns, alignReturns, correlation, beta, peerIndex,
    realizedVol, trailingReturn, drawdown, analyzeMove, describeMove,
};
