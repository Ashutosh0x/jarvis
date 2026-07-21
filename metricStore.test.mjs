// Tests for the metrics/event tier. The properties that matter: bounded
// growth, null-safety (a missing reading must never be averaged as zero), and
// hysteresis/debounce so a hovering value cannot emit a stream of events.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
    shouldPersist, makeSample, stats, windowed, dayKey, rollup, rollupByDay,
    pruneRaw, deriveEvents, deriveProcessEvents, dedupeEvents, describeRollup,
    SAMPLE_INTERVAL_MS, RAW_RETENTION_MS, THRESHOLDS, EVENT_DEBOUNCE_MS,
} = require('./metricStore.js');

let pass = 0, fail = 0;
const check = (n, c) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); };

const T0 = Date.parse('2026-07-21T09:00:00');
const mk = (mins, cpu, mem, proc) => makeSample(T0 + mins * 60000, { cpu, memPct: mem, memUsedMB: mem * 100, topProc: proc, topCpu: cpu });

// --- sampling cadence --------------------------------------------------------
check('persist: first sample always persists', shouldPersist(NaN, T0) === true);
check('persist: too soon is rejected', shouldPersist(T0, T0 + 30000) === false);
check('persist: a full interval is accepted', shouldPersist(T0, T0 + SAMPLE_INTERVAL_MS) === true);
check('persist: interval is one minute (1440/day, bounded)', SAMPLE_INTERVAL_MS === 60000);

// --- compact row shape --------------------------------------------------------
{
    const s = makeSample(T0, { cpu: 12.34, memPct: 55.67, memUsedMB: 5678.9, topProc: 'chrome', topCpu: 8.9 });
    check('sample: rounded to one decimal', s.c === 12.3 && s.m === 55.7);
    check('sample: memory MB rounded to integer', s.mu === 5679);
    check('sample: keys are short for disk economy',
        Object.keys(s).join(',') === 't,c,m,mu,p,pc');
    const bad = makeSample(T0, { cpu: undefined, memPct: null, topProc: null });
    check('sample: missing readings become null, NOT zero', bad.c === null && bad.m === null);
}

// --- statistics ------------------------------------------------------------------
{
    const list = [mk(0, 10, 40, 'chrome'), mk(1, 20, 50, 'chrome'), mk(2, 90, 60, 'ollama')];
    const c = stats(list, 'c');
    check('stats: avg', c.avg === 40);
    check('stats: peak', c.peak === 90);
    check('stats: min', c.min === 10);
    check('stats: p95 is the top of this small set', c.p95 === 90);
    check('stats: count', c.n === 3);
    const withNulls = [mk(0, 10, 40, 'x'), makeSample(T0 + 60000, {}), mk(2, 30, 50, 'x')];
    check('stats: nulls skipped, not averaged as zero', stats(withNulls, 'c').avg === 20);
    check('stats: nulls reduce n', stats(withNulls, 'c').n === 2);
    check('stats: all-null returns null', stats([makeSample(T0, {})], 'c') === null);
    check('stats: empty returns null', stats([], 'c') === null);
}

// --- windowing / day keys ----------------------------------------------------------
{
    const list = [mk(0, 1, 1, 'a'), mk(10, 2, 2, 'a'), mk(20, 3, 3, 'a')];
    check('window: inclusive range', windowed(list, T0, T0 + 10 * 60000).length === 2);
    check('window: open end', windowed(list, T0 + 10 * 60000).length === 2);
    check('window: nothing matches', windowed(list, T0 + 99 * 60000).length === 0);
    check('dayKey: local date form', dayKey(T0) === '2026-07-21');
    check('dayKey: stable within a day', dayKey(T0) === dayKey(T0 + 8 * 3600000));
}

// --- rollups (the compression step) --------------------------------------------------
{
    const day = [];
    for (let i = 0; i < 60; i++) day.push(mk(i, i < 50 ? 15 : 80, 45, i < 50 ? 'chrome' : 'ollama'));
    const r = rollup(day);
    check('rollup: sample count preserved', r.samples === 60);
    check('rollup: peak captured', r.cpu.peak === 80);
    check('rollup: average is real', r.cpu.avg === Math.round(((50 * 15 + 10 * 80) / 60) * 10) / 10);
    check('rollup: dominant process identified', r.topProcess.name === 'chrome');
    check('rollup: dominance expressed as a share', r.topProcess.shareOfSamples === 83);
    check('rollup: day key attached', r.day === '2026-07-21');
    check('rollup: empty input is null', rollup([]) === null);
    // The economy claim: a day compresses to a small object.
    check('rollup: compresses ~1440 samples into a small row',
        JSON.stringify(r).length < 400);
}
{
    const two = [mk(0, 10, 20, 'a'), mk(60 * 24, 90, 80, 'b')];
    const rs = rollupByDay(two);
    check('rollupByDay: splits across days', rs.length === 2);
    check('rollupByDay: sorted by day', rs[0].day < rs[1].day);
}

// --- retention --------------------------------------------------------------------
{
    const now = T0 + 10 * 24 * 3600 * 1000;
    const list = [mk(0, 1, 1, 'a'), makeSample(now - 3600000, { cpu: 5, memPct: 5 })];
    const kept = pruneRaw(list, now);
    check('prune: old raw samples dropped', kept.length === 1);
    check('prune: recent kept', kept[0].c === 5);
    check('prune: retention is 7 days', RAW_RETENTION_MS === 7 * 24 * 3600 * 1000);
}

// --- threshold events: hysteresis + debounce (the anti-noise property) -------------
{
    let st = {};
    const step = (mins, cpu) => {
        const r = deriveEvents(mk(mins, cpu, 40, 'chrome'), st, T0 + mins * 60000);
        st = r.state; return r.events;
    };
    check('events: below threshold is silent', step(0, 20).length === 0);
    check('events: crossing high fires once', step(1, 90).length === 1);
    check('events: STAYING high does not re-fire', step(2, 92).length === 0);
    check('events: still silent while high', step(3, 95).length === 0);
    check('events: dropping into the band does not fire', step(4, 75).length === 0);
    check('events: recovery below low is silent', step(5, 60).length === 0);
    // Re-arm only after recovery, and only past the debounce window.
    const later = 5 + Math.ceil(EVENT_DEBOUNCE_MS / 60000) + 1;
    check('events: re-fires after genuine recovery + debounce', step(later, 95).length === 1);
    check('events: hysteresis band is real', THRESHOLDS.cpu.low < THRESHOLDS.cpu.high);
}
{
    // Debounce must suppress a rapid second crossing even after recovery.
    let st = {};
    let r = deriveEvents(mk(0, 95, 40, 'x'), st, T0); st = r.state;
    check('debounce: first crossing fires', r.events.length === 1);
    r = deriveEvents(mk(1, 50, 40, 'x'), st, T0 + 60000); st = r.state;
    r = deriveEvents(mk(2, 95, 40, 'x'), st, T0 + 120000); st = r.state;
    check('debounce: immediate re-cross suppressed', r.events.length === 0);
}
{
    const r = deriveEvents(mk(0, 95, 95, 'chrome'), {}, T0);
    check('events: cpu and memory both reported', r.events.length === 2);
    check('events: text carries the measurement', /95%/.test(r.events[0].text));
    check('events: busiest process attributed', /chrome/.test(r.events[0].text));
    check('events: null sample is safe', deriveEvents(null, {}).events.length === 0);
}

// --- process events -----------------------------------------------------------------
{
    const watch = new Set(['ollama', 'chrome']);
    const e = deriveProcessEvents(['chrome'], ['chrome', 'ollama'], T0, watch);
    check('proc: start detected', e.length === 1 && e[0].kind === 'process-start');
    check('proc: name carried', e[0].data.name === 'ollama');
    const x = deriveProcessEvents(['chrome', 'ollama'], ['chrome'], T0, watch);
    check('proc: stop detected', x.length === 1 && x[0].kind === 'process-stop');
    const ignored = deriveProcessEvents([], ['randomthing'], T0, watch);
    check('proc: unwatched processes ignored (no telemetry flood)', ignored.length === 0);
    check('proc: no change is no events', deriveProcessEvents(['a'], ['a'], T0, new Set(['a'])).length === 0);
    // Input-order independence: the same set difference must serialise
    // identically however the caller happened to order its process list.
    {
        const w = new Set(['a', 'b', 'c']);
        const one = deriveProcessEvents(['a'], ['a', 'b', 'c'], T0, w);
        const two = deriveProcessEvents(['a'], ['c', 'a', 'b'], T0, w);
        check('proc: ordering is deterministic regardless of input order',
            JSON.stringify(one) === JSON.stringify(two));
        check('proc: both starts reported', one.length === 2);
    }
    check('proc: empty watch set tracks everything',
        deriveProcessEvents([], ['anything'], T0, new Set()).length === 1);
}

// --- dedupe ---------------------------------------------------------------------------
{
    const evs = [
        { t: T0, kind: 'cpu-high', text: 'CPU reached 90%.' },
        { t: T0 + 1000, kind: 'cpu-high', text: 'CPU reached 90%.' },
        { t: T0 + 2000, kind: 'cpu-high', text: 'CPU reached 90%.' },
        { t: T0 + EVENT_DEBOUNCE_MS + 1000, kind: 'cpu-high', text: 'CPU reached 90%.' },
    ];
    const d = dedupeEvents(evs);
    check('dedupe: repeats inside the window collapse', d.length === 2);
    check('dedupe: keeps the first occurrence', d[0].t === T0);
    check('dedupe: empty safe', dedupeEvents([]).length === 0);
}

// --- spoken description ------------------------------------------------------------------
{
    const day = [mk(0, 15, 45, 'chrome'), mk(1, 80, 50, 'chrome')];
    const text = describeRollup(rollup(day));
    check('describe: mentions average and peak', /averaged/.test(text) && /peaked/.test(text));
    check('describe: mentions dominant process', /chrome/.test(text));
    check('describe: null rollup is null', describeRollup(null) === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
