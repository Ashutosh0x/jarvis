// Tests for hedged endpoint racing. The property that matters: a dead first
// endpoint must cost the hedge delay, NOT its full timeout — that is the whole
// difference between the measured 30s chain query and a ~2s one.
import pkg from '../../../../rpcHedge.js';
const { hedgedRace, createStickyOrder } = pkg;

let pass = 0, fail = 0;
const check = (n, c) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); };
const sleep = (ms, signal) => new Promise((res, rej) => {
    const t = setTimeout(res, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); rej(new Error('aborted')); });
});

// --- happy path: a healthy first endpoint wins before any hedge fires -------
{
    const started = [];
    const t0 = Date.now();
    const r = await hedgedRace(['a', 'b', 'c'], async (item, signal) => {
        started.push(item);
        await sleep(20, signal);
        return `ok:${item}`;
    }, { hedgeAfterMs: 200, timeoutMs: 1000 });
    const took = Date.now() - t0;

    check('happy: returns the first endpoint\'s value', r.value === 'ok:a' && r.item === 'a');
    check('happy: reports the winning index', r.index === 0);
    check('happy: no hedge was launched', started.length === 1);
    check('happy: fast (no hedge delay paid)', took < 150);
}

// --- the measured bug: a hanging endpoint must not cost its full timeout ----
{
    const t0 = Date.now();
    const r = await hedgedRace(['dead', 'live'], async (item, signal) => {
        if (item === 'dead') { await sleep(5000, signal); return 'never'; }
        await sleep(30, signal);
        return 'ok:live';
    }, { hedgeAfterMs: 120, timeoutMs: 5000 });
    const took = Date.now() - t0;

    check('hedge: a hung endpoint is overtaken', r.value === 'ok:live' && r.item === 'live');
    check('hedge: cost is the hedge delay, not the timeout', took < 400);
    check('hedge: and not faster than the hedge delay', took >= 120);
}

// --- a fast failure should not wait for the hedge timer at all --------------
{
    const t0 = Date.now();
    const r = await hedgedRace(['broken', 'live'], async (item, signal) => {
        if (item === 'broken') throw new Error('http 503');
        await sleep(20, signal);
        return 'ok:live';
    }, { hedgeAfterMs: 5000, timeoutMs: 9000 });
    const took = Date.now() - t0;

    check('failure: falls straight through to the next endpoint', r.value === 'ok:live');
    check('failure: does not wait on the hedge timer', took < 300);
}

// --- losers are aborted so sockets are not left hanging --------------------
{
    let aborted = false;
    await hedgedRace(['slow', 'fast'], async (item, signal) => {
        if (item === 'slow') {
            try { await sleep(3000, signal); } catch { aborted = true; throw new Error('aborted'); }
            return 'never';
        }
        await sleep(30, signal);
        return 'ok';
    }, { hedgeAfterMs: 50, timeoutMs: 4000 });
    await sleep(40);
    check('abort: the losing endpoint is cancelled', aborted);
}

// --- total failure reports the last error and does not hang -----------------
{
    const t0 = Date.now();
    let msg = '';
    try {
        await hedgedRace(['x', 'y'], async () => { throw new Error('refused'); },
            { hedgeAfterMs: 100, timeoutMs: 1000 });
    } catch (e) { msg = e.message; }
    check('all-fail: rejects', /all endpoints failed/.test(msg));
    check('all-fail: includes the underlying error', /refused/.test(msg));
    check('all-fail: returns promptly', Date.now() - t0 < 300);
}

// --- a timeout is enforced per endpoint -------------------------------------
{
    const t0 = Date.now();
    let msg = '';
    try {
        await hedgedRace(['hang'], async (item, signal) => { await sleep(9000, signal); },
            { hedgeAfterMs: 5000, timeoutMs: 150 });
    } catch (e) { msg = e.message; }
    check('timeout: a single hung endpoint still rejects', /all endpoints failed/.test(msg));
    check('timeout: honours timeoutMs', Date.now() - t0 < 600);
}

// --- degenerate input --------------------------------------------------------
{
    let msg = '';
    try { await hedgedRace([], async () => 'x', {}); } catch (e) { msg = e.message; }
    check('empty endpoint list rejects clearly', /no endpoints/.test(msg));
}

// --- sticky ordering ---------------------------------------------------------
{
    const s = createStickyOrder();
    const urls = ['one', 'two', 'three'];
    check('sticky: untouched order before any success',
        JSON.stringify(s.order('eth', urls)) === JSON.stringify(urls));

    s.remember('eth', 'three');
    check('sticky: promotes the endpoint that worked',
        JSON.stringify(s.order('eth', urls)) === JSON.stringify(['three', 'one', 'two']));
    check('sticky: does not leak across chains',
        JSON.stringify(s.order('base', urls)) === JSON.stringify(urls));
    check('sticky: returns a copy, not the caller\'s array', s.order('base', urls) !== urls);

    // An endpoint dropped from config must not resurrect itself.
    s.remember('eth', 'retired');
    check('sticky: ignores a remembered url no longer in the list',
        JSON.stringify(s.order('eth', urls)) === JSON.stringify(urls));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
