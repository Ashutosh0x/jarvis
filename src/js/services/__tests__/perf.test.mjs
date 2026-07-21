// Tests for the turn profiler. The load-bearing property is that it is INERT
// outside a turn and never throws — it runs on the voice path, where a
// telemetry bug would break real commands.
import perf, { TurnProfiler } from '../perf.js';

let pass = 0, fail = 0;
const check = (n, c) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// --- inert before a turn starts ---------------------------------------------
{
    const p = new TurnProfiler();
    check('inert: snapshot is null before startTurn', p.snapshot() === null);
    p.stage('x', 10);
    p.markFirstWord();
    check('inert: stages recorded outside a turn are dropped', p.snapshot() === null);
    check('inert: time() still runs the function', (await p.time('x', async () => 42)) === 42);
}

// --- basic recording ---------------------------------------------------------
{
    const p = new TurnProfiler();
    p.startTurn();
    p.stage('intent', 3);
    p.stage('rag', 40);
    const snap = p.snapshot();
    check('record: stages captured', snap.stages.intent === 3 && snap.stages.rag === 40);
    check('record: total is present', typeof snap.totalMs === 'number');
    check('record: no firstWord until marked', snap.firstWordMs === undefined);
}

// --- repeated stages accumulate rather than overwrite ------------------------
{
    const p = new TurnProfiler();
    p.startTurn();
    p.stage('rpc', 100);
    p.stage('rpc', 50);
    p.stage('rpc', 25);
    const snap = p.snapshot();
    check('accumulate: sums repeated stages', snap.stages.rpc.ms === 175);
    check('accumulate: counts the calls', snap.stages.rpc.calls === 3);
    check('accumulate: single call stays a plain number', (() => {
        const q = new TurnProfiler(); q.startTurn(); q.stage('one', 5);
        return q.snapshot().stages.one === 5;
    })());
}

// --- time() measures, propagates values, and survives rejection --------------
{
    const p = new TurnProfiler();
    p.startTurn();
    const v = await p.time('work', async () => { await sleep(30); return 'done'; });
    check('time: returns the value', v === 'done');
    check('time: measured roughly right', p.snapshot().stages.work >= 25);

    let threw = false;
    try { await p.time('bad', async () => { throw new Error('boom'); }); } catch { threw = true; }
    check('time: rethrows the error', threw);
    check('time: records the stage even on failure', p.snapshot().stages.bad !== undefined);
}

// --- first-word marking is once-only ----------------------------------------
{
    const p = new TurnProfiler();
    p.startTurn();
    await sleep(20);
    p.markFirstWord();
    const first = p.snapshot().firstWordMs;
    await sleep(20);
    p.markFirstWord();
    check('firstWord: recorded', first >= 15);
    check('firstWord: later marks do not overwrite', p.snapshot().firstWordMs === first);
}

// --- a new turn discards the previous one ------------------------------------
{
    const p = new TurnProfiler();
    p.startTurn();
    p.stage('old', 99);
    p.startTurn();
    check('reset: previous stages are gone', p.snapshot().stages.old === undefined);
}

// --- endTurn returns the snapshot and deactivates ----------------------------
{
    const p = new TurnProfiler();
    p.startTurn();
    p.stage('a', 1);
    const snap = p.endTurn();
    check('endTurn: returns the breakdown', snap.stages.a === 1);
    check('endTurn: profiler goes inert', p.snapshot() === null);
}

// --- hostile input must not throw -------------------------------------------
{
    const p = new TurnProfiler();
    p.startTurn();
    p.stage('neg', -5);
    p.stage('nan', NaN);
    p.stage('undef', undefined);
    const snap = p.snapshot();
    check('hostile: negative duration ignored', snap.stages.neg === undefined);
    check('hostile: NaN ignored', snap.stages.nan === undefined);
    check('hostile: undefined ignored', snap.stages.undef === undefined);
}

// --- the shared singleton is exported and usable -----------------------------
{
    check('singleton: exported', typeof perf.startTurn === 'function');
    check('singleton: starts inert', perf.snapshot() === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
