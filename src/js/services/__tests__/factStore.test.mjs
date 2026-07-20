// Behavioral tests for the belief store, driving the REAL FactStore.observe()
// (class exported; observe is pure). Documents the named behaviors the belief
// model must exhibit. Complements factStore.fuzz.mjs (invariants under load).
import { FactStore, noisyOr, evidence, normAttr, factsMatch } from '../factStore.js';

let pass = 0, fail = 0;
const approx = (a, b, t = 1e-6) => Math.abs(a - b) <= t;
const check = (n, c) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); };

const DAY = 86400000;
function store() { const s = new FactStore(); s.loaded = true; return s; }
function apply(res) { for (const f of res.promoted) f.inRag = true; for (const f of res.demoted) f.inRag = false; return res; }

// --- primitives ---
check('noisyOr(0.5,0.5)=0.75', approx(noisyOr(0.5, 0.5), 0.75));
check('noisyOr caps at 0.99', noisyOr(0.99, 0.99) <= 0.99);
check('voice evidence < text evidence', evidence(0.9, 'voice') < evidence(0.9, 'text'));
check('correction is strongest source', evidence(0.9, 'correction') >= evidence(0.9, 'text'));
check('attribute phrasings collapse', normAttr('preferred browser') === normAttr('browser preference'));
check('short value matches longer phrasing', factsMatch('Chrome', 'Google Chrome browser'));

// --- behavior 1: a single voice garble never becomes durable, then decays ---
{
    const s = store();
    let now = Date.now();
    apply(s.observe([{ attribute: 'topic', value: 'Uruguay events', statement: 'interested in Uruguay', prob: 0.9 }], { source: 'voice', now }));
    check('garble: not promoted on first sighting', s.facts[0].status === 'provisional' && !s.facts[0].inRag);
    for (let i = 0; i < 6; i++) { now += DAY; s.observe([], { source: 'voice', now }); }
    check('garble: archived after decay', s.facts[0].status === 'archived');
    check('garble: never returned as durable', s.durableFacts().length === 0);
}

// --- behavior 2: a genuine fact promotes only after corroboration (noisy-OR) ---
{
    const s = store();
    const now = Date.now();
    const r1 = apply(s.observe([{ attribute: 'preferred browser', value: 'Chrome', statement: 'prefers Chrome', prob: 0.9 }], { source: 'voice', now }));
    check('corroboration: pass 1 not promoted', r1.promoted.length === 0);
    const r2 = apply(s.observe([{ attribute: 'browser preference', value: 'Chrome', statement: 'uses Chrome', prob: 0.9 }], { source: 'voice', now: now + DAY }));
    check('corroboration: pass 2 promotes to durable', r2.promoted.length === 1 && r2.promoted[0].inRag);
}

// --- behavior 3: typed evidence promotes faster than voice ---
{
    const s = store();
    const now = Date.now();
    apply(s.observe([{ attribute: 'editor', value: 'VS Code', statement: 'uses VS Code', prob: 0.9 }], { source: 'text', now }));
    const r = apply(s.observe([{ attribute: 'editor', value: 'VS Code', statement: 'uses VS Code', prob: 0.9 }], { source: 'text', now: now + DAY }));
    check('source: typed fact promotes after 2 confirmations', r.promoted.length === 1);
}

// --- behavior 4: revision — a sustained new value overtakes and evicts the old ---
{
    const s = store();
    let now = Date.now();
    for (let i = 0; i < 3; i++) { now += DAY; apply(s.observe([{ attribute: 'browser', value: 'Chrome', statement: 'uses Chrome', prob: 0.9 }], { source: 'text', now })); }
    const chromeDurable = s.facts.find((f) => /chrome/i.test(f.value)).inRag;
    for (let i = 0; i < 6; i++) { now += DAY; apply(s.observe([{ attribute: 'browser', value: 'Firefox', statement: 'now uses Firefox', prob: 0.9 }], { source: 'text', now })); }
    const chrome = s.facts.find((f) => /chrome/i.test(f.value));
    const firefox = s.facts.find((f) => /firefox/i.test(f.value));
    check('revision: Chrome was durable first', chromeDurable);
    check('revision: Firefox is now the durable winner', firefox.inRag && firefox.status === 'durable');
    check('revision: Chrome evicted from durable memory', !chrome.inRag);
    check('revision: at most one durable value for the attribute', s.durableFacts().filter((f) => f.attribute === firefox.attribute).length === 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
