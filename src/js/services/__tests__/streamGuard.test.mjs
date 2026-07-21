// Tests for the stream operational guards. These encode the reviewer's
// questions as executable answers: does reconnect back off? are duplicates
// possible after replay? does a skipped block get detected? does memory stay
// bounded? does a burst block stay quiet?
import pkg from '../../../../streamGuard.js';
const { backoffDelay, createDedup, createBlockTracker, prioritizeAlerts } = pkg;

let pass = 0, fail = 0;
const check = (n, c) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); };

// --- backoffDelay -------------------------------------------------------------
{
    const max = (a) => backoffDelay(a, { rand: () => 0.999999 });
    check('backoff: grows exponentially', max(0) < max(2) && max(2) < max(5));
    check('backoff: attempt 0 ceiling is base', max(0) <= 2000);
    check('backoff: capped at capMs', max(20) <= 120000);
    check('backoff: floor enforced even at rand 0', backoffDelay(0, { rand: () => 0 }) === 1000);
    check('backoff: jitter spreads values', (() => {
        const seq = [0.1, 0.5, 0.9]; let i = 0;
        const vals = seq.map(() => backoffDelay(4, { rand: () => seq[i++] }));
        return new Set(vals).size === 3;
    })());
    check('backoff: hostile attempt values do not explode',
        Number.isFinite(backoffDelay(NaN)) && Number.isFinite(backoffDelay(1e9)) && backoffDelay(1e9, { rand: () => 1 }) <= 120000);
}

// --- createDedup ---------------------------------------------------------------
{
    let t = 0;
    const d = createDedup({ ttlMs: 1000, max: 3, now: () => t });
    check('dedup: first sighting is new', d.seen('a') === false);
    check('dedup: replay is caught', d.seen('a') === true);
    t = 500;
    check('dedup: still caught within TTL', d.seen('a') === true);
    t = 2000; // 'a' refreshed at t=500 -> expires at 1500
    check('dedup: expired key is new again', d.seen('a') === false);

    // Bound: max 3 entries no matter how many keys arrive.
    d.seen('b'); d.seen('c'); d.seen('d'); d.seen('e');
    check('dedup: size stays bounded', d.size <= 3);
    check('dedup: newest keys survive eviction', d.seen('e') === true);
}

// --- createBlockTracker ----------------------------------------------------------
{
    const tr = createBlockTracker({ maxGap: 3 });
    check('tracker: first block is clean', JSON.stringify(tr.next(100)) === JSON.stringify({ duplicate: false, gap: [], lost: 0 }));
    check('tracker: consecutive block is clean', tr.next(101).gap.length === 0);
    check('tracker: replayed head flagged duplicate', tr.next(101).duplicate === true);
    check('tracker: older head flagged duplicate', tr.next(99).duplicate === true);

    const g = tr.next(104); // 102, 103 skipped
    check('tracker: small gap fully listed', JSON.stringify(g.gap) === JSON.stringify([102, 103]) && g.lost === 0);

    const big = tr.next(120); // 105..119 skipped = 15, cap 3
    check('tracker: big gap capped to most recent', JSON.stringify(big.gap) === JSON.stringify([117, 118, 119]));
    check('tracker: blocks beyond cap declared lost', big.lost === 12);
    check('tracker: missedTotal accumulates', tr.missedTotal === 17);
    check('tracker: lastBlock advances', tr.lastBlock === 120);
    check('tracker: garbage input treated as duplicate', tr.next('nope').duplicate === true);
}

// --- prioritizeAlerts -------------------------------------------------------------
{
    const W = (eth) => ({ valueWei: (BigInt(eth) * 10n ** 18n).toString(), amount: String(eth) });
    check('prioritize: empty is silent', prioritizeAlerts([]).speak.length === 0);
    check('prioritize: null is silent', prioritizeAlerts(null).speak.length === 0);

    const two = prioritizeAlerts([W(150), W(300)], { maxSpoken: 2 });
    check('prioritize: within budget all speak', two.speak.length === 2 && two.summary === null);
    check('prioritize: largest speaks first', two.speak[0].amount === '300');

    const burst = prioritizeAlerts([W(100), W(500), W(200), W(120), W(9000)], { maxSpoken: 2 });
    check('prioritize: burst speaks only the biggest', burst.speak.length === 2
        && burst.speak[0].amount === '9000' && burst.speak[1].amount === '500');
    check('prioritize: rest collapse to one summary', burst.summary.count === 3);
    check('prioritize: summary carries largest remaining', burst.summary.largest.amount === '200');
    check('prioritize: input array not mutated', (() => {
        const arr = [W(1), W(2)]; const before = JSON.stringify(arr);
        prioritizeAlerts(arr, { maxSpoken: 1 });
        return JSON.stringify(arr) === before;
    })());

    // BigInt comparison, not float: 1000.0000001 ETH vs 1000 ETH differs
    // beyond double precision at wei scale.
    const a = { valueWei: (1000n * 10n ** 18n + 1n).toString(), amount: 'bigger' };
    const b = { valueWei: (1000n * 10n ** 18n).toString(), amount: 'smaller' };
    check('prioritize: wei-exact ordering', prioritizeAlerts([b, a], { maxSpoken: 1 }).speak[0].amount === 'bigger');

    /* Cross-asset ranking. 4,000,000 USDC (6dp) is a far bigger movement than
       100 ETH, but its raw unit count is smaller — ranking on units alone would
       announce the wrong one as the headline of the block. */
    const ethWhale = { valueWei: (100n * 10n ** 18n).toString(), amount: '100', asset: 'ETH', usd: 194169, hash: '0xa' };
    const usdcWhale = { raw: (4_000_000n * 10n ** 6n).toString(), amount: '4,000,000', asset: 'USDC', usd: 4000000, hash: '0xb' };
    check('prioritize: ranks across assets by measured USD, not raw units',
        prioritizeAlerts([ethWhale, usdcWhale], { maxSpoken: 1 }).speak[0].asset === 'USDC');
    check('prioritize: unit ordering alone would have been wrong here',
        BigInt(ethWhale.valueWei) > BigInt(usdcWhale.raw));

    const unpriced = { raw: '999', amount: '999', asset: 'MYSTERY', usd: null, hash: '0xc' };
    check('prioritize: a priced alert outranks an unpriced one of unknown size',
        prioritizeAlerts([unpriced, ethWhale], { maxSpoken: 1 }).speak[0].asset === 'ETH');

    check('prioritize: equal values order deterministically by hash', (() => {
        const x = { usd: 5, hash: '0xb', amount: 'x' }, y = { usd: 5, hash: '0xa', amount: 'y' };
        const one = prioritizeAlerts([x, y], { maxSpoken: 2 }).speak.map(r => r.amount).join();
        const two = prioritizeAlerts([y, x], { maxSpoken: 2 }).speak.map(r => r.amount).join();
        return one === two && one === 'y,x';
    })());
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
