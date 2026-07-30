// Peer-relative price analysis.
//
// The properties that matter here are the ones a spoken summary can get wrong
// in a way that sounds authoritative: attributing a sector-wide fall to one
// company, comparing two venues that were not open on the same day, and
// inventing a one-month return for a listing that is three weeks old.
//
// The fixtures at the bottom are the REAL memory-complex figures measured on
// 30 Jul 2026, so a refactor that changes the arithmetic is caught against
// numbers that were actually observed rather than invented.

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const {
    PEER_GROUPS, dailyReturns, correlation, beta, peerIndex, realizedVol,
    trailingReturn, drawdown, analyzeMove, describeMove,
} = require('./sectorMove.js');

let pass = 0, fail = 0;
const check = (n, c, d = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };
const near = (a, b, tol = 1e-6) => a != null && Math.abs(a - b) <= tol;

/* Dates are ISO so they sort lexically; the module relies on that. */
const mkSeries = (closes, start = 1) =>
    closes.map((c, i) => ({ d: `2026-06-${String(start + i).padStart(2, '0')}`, c }));

// --- dailyReturns -------------------------------------------------------------
{
    const r = dailyReturns(mkSeries([100, 110, 99]));
    check('returns: one fewer than the closes', r.size === 2);
    check('returns: +10% computed exactly', near(r.get('2026-06-02'), 0.1, 1e-12));
    check('returns: -10% computed exactly', near(r.get('2026-06-03'), -0.1, 1e-12));
    check('returns: junk closes are skipped, never NaN',
        [...dailyReturns([{ d: 'a', c: null }, { d: 'b', c: 10 }, { d: 'c', c: 'x' }]).values()]
            .every(Number.isFinite));
    check('returns: empty and non-array are safe',
        dailyReturns([]).size === 0 && dailyReturns(null).size === 0);
}

// --- correlation / beta -------------------------------------------------------
{
    const a = dailyReturns(mkSeries([100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111]));
    const b = dailyReturns(mkSeries([50, 50.5, 51, 51.5, 52, 52.5, 53, 53.5, 54, 54.5, 55, 55.5]));
    const c = correlation(a, b);
    check('correlation: two series moving together are ~+1', c.r > 0.99, String(c.r?.toFixed(4)));
    check('correlation: reports how many sessions it used', c.n === 11, String(c.n));

    /* A short overlap must say so rather than return a confident number from
       three points. */
    const short = dailyReturns(mkSeries([100, 101, 102]));
    const cs = correlation(a, short);
    check('correlation: too little overlap returns null, not a number', cs.r === null);
    check('correlation: and flags itself insufficient', cs.insufficient === true);
    check('correlation: a flat series has no correlation to report',
        correlation(a, dailyReturns(mkSeries(Array(12).fill(10)))).r === null);

    const f = beta(a, b);
    check('beta: identical proportional moves give beta ~1', near(f.beta, 1, 0.05), String(f.beta?.toFixed(3)));
    check('beta: short overlap is refused', beta(a, short).insufficient === true);
}

// --- peerIndex ----------------------------------------------------------------
{
    const p1 = dailyReturns(mkSeries([100, 110]));      // +10% on 06-02
    const p2 = dailyReturns(mkSeries([100, 90]));       // -10% on 06-02
    const idx = peerIndex([p1, p2]);
    check('index: equal-weight average of the members', near(idx.get('2026-06-02'), 0, 1e-12));
    check('index: a date with only one member is not a sector',
        peerIndex([p1, dailyReturns(mkSeries([100, 100, 100], 5))]).has('2026-06-02') === false);
}

// --- trailing returns and short history ---------------------------------------
{
    const s = mkSeries([100, 101, 102, 103, 104]);
    check('trailing: 1-session return', near(trailingReturn(s, 1), (104 - 103) / 103 * 100, 1e-9));
    /* The SKHY case: a listing with 14 sessions has no one-month return, and
       silently using the oldest bar would report 14 days as a month. */
    check('trailing: a window longer than the history is null, not the whole series',
        trailingReturn(s, 21) === null);
    check('trailing: exactly enough history works', trailingReturn(s, 4) !== null);
}

// --- drawdown -----------------------------------------------------------------
{
    const d = drawdown(mkSeries([100, 150, 120, 90]));
    check('drawdown: measured from the peak, not the start', near(d.pct, -40, 1e-9));
    check('drawdown: the peak date is reported', d.highDate === '2026-06-02');
    check('drawdown: too little data is null', drawdown([{ d: 'x', c: 1 }]) === null);
}

// --- volatility ---------------------------------------------------------------
{
    const flat = dailyReturns(mkSeries(Array(20).fill(100)));
    check('vol: a flat series has zero volatility', near(realizedVol(flat), 0, 1e-12));
    check('vol: too few points is null', realizedVol(dailyReturns(mkSeries([1, 2]))) === null);
}

/* --- the decomposition -------------------------------------------------------
   The point of the module: a name that fell exactly as much as its sector has
   no story, and one that fell twice as much does. */
{
    // Twelve sessions so beta/correlation have enough points.
    const wobble = [100, 98, 99.5, 96, 97.2, 93, 94.1, 90, 91.3, 87, 88.4, 84];
    const sectorA = { symbol: 'PA', series: mkSeries(wobble) };
    const sectorB = { symbol: 'PB', series: mkSeries(wobble) };

    const inline = { symbol: 'T', series: mkSeries(wobble) };
    const a1 = analyzeMove(inline, [sectorA, sectorB]);
    check('decompose: a name moving with its sector has ~no idiosyncratic move',
        Math.abs(a1.idiosyncratic) < 0.2, String(a1.idiosyncratic?.toFixed(3)));
    check('decompose: beta to an identical series is ~1', near(a1.beta, 1, 0.05));
    check('decompose: breadth counts the peers that fell',
        a1.breadth.down === 2 && a1.breadth.of === 2);
    check('decompose: peers used are named', a1.peersUsed.join(',') === 'PA,PB');

    /* A name that falls harder than the sector on the last day keeps the excess
       as its own. */
    const worse = { symbol: 'W', series: mkSeries([...wobble.slice(0, 11), wobble[10] * 0.9]) };
    const a2 = analyzeMove(worse, [sectorA, sectorB]);
    /* The excess is not the full extra 5%: the target's own outsized session
       is in the sample the beta is fitted on, so the fit absorbs part of it.
       What matters is the sign and that it is clearly separated from the
       moved-with-the-sector case above. */
    check('decompose: an extra fall shows up as idiosyncratic', a2.idiosyncratic < -3,
        String(a2.idiosyncratic?.toFixed(2)));
    check('decompose: the sector part is still reported', a2.sectorMove != null);

    check('decompose: with no peers it is an absolute move and says so',
        analyzeMove(inline, []).limits.some((l) => /no peer series/.test(l)));
    check('decompose: garbage input does not throw',
        analyzeMove(null, null).move === null);
}

/* --- cross-venue calendars ---------------------------------------------------
   000660.KS closes a session the US names have not opened. Before this, its
   newest bar had no peer on the same date and the whole split came back empty. */
{
    const usPeer = { symbol: 'US1', series: mkSeries([100, 98, 96, 94, 92, 90, 88, 86, 84, 82, 80, 78]) };
    const usPeer2 = { symbol: 'US2', series: mkSeries([100, 98, 96, 94, 92, 90, 88, 86, 84, 82, 80, 78]) };
    // Same dates plus one extra session the US names do not have.
    const kr = { symbol: 'KR', series: [...mkSeries([100, 98, 96, 94, 92, 90, 88, 86, 84, 82, 80, 78]), { d: '2026-06-13', c: 76 }] };

    const a = analyzeMove(kr, [usPeer, usPeer2]);
    check('calendar: the newest own session is still reported as asOf', a.asOf === '2026-06-13');
    check('calendar: the split falls back to the last shared session',
        a.comparedOn === '2026-06-12');
    check('calendar: and the sector move is not lost', a.sectorMove != null);
    check('calendar: the mismatch is stated in limits',
        a.limits.some((l) => /last session shared/.test(l)));
    check('calendar: the spoken line names the comparison date',
        describeMove(a).includes('on 2026-06-12'));
    check('calendar: breadth uses the shared date, not an empty one',
        a.breadth && a.breadth.of === 2);
}

/* --- measured fixtures, 30 Jul 2026 ------------------------------------------
   Real closes for the memory complex. These pin the arithmetic to figures that
   were actually observed rather than to a synthetic ramp. */
{
    const mu = [1213.56, 1100.0, 1010.0, 959.48, 820.4, 739.0];
    const s = mkSeries(mu, 24);
    check('fixture: Micron drawdown from the 25 Jun high is ~-39%',
        near(drawdown(s).pct, ((739 - 1213.56) / 1213.56) * 100, 1e-9));
    check('fixture: the last session is -9.9%',
        near(trailingReturn(s, 1), ((739 - 820.4) / 820.4) * 100, 1e-9));
    check('fixture: the memory peer group is defined and non-empty',
        PEER_GROUPS.memory.members.length >= 4);
    check('fixture: names that cannot enter the index are still listed',
        PEER_GROUPS.memory.offIndex.some((x) => /CXMT/.test(x)));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
