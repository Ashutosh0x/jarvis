// Fuzz test for the belief store. Drives the REAL FactStore.observe() (pure —
// no I/O) with thousands of adversarial synthetic observations and asserts the
// invariants that must hold no matter what noisy input arrives:
//
//   I1  confidence stays finite and within [0, 0.99]
//   I2  at most ONE durable-in-RAG winner per attribute
//   I3  an archived belief is never marked in-RAG (never "current")
//   I4  durableFacts() never returns an archived belief
//   I5  the in-RAG fact is the top-confidence active candidate for its attribute
//   I6  contradictory evidence eventually flips the winner
//
// Seeded RNG so a failure is reproducible. Simulates the reflection caller
// contract: promoted -> inRag=true, demoted -> inRag=false.
import { FactStore } from '../factStore.js';

// --- seeded PRNG (mulberry32) ---
function rng(seed) {
    return function () {
        seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

let failures = 0;
function fail(msg) { failures++; if (failures <= 20) console.log('  INVARIANT FAIL: ' + msg); }

function checkInvariants(store, pass) {
    const byAttr = new Map();
    for (const f of store.facts) {
        // I1
        if (!Number.isFinite(f.confidence)) fail(`pass ${pass}: confidence not finite (${f.confidence})`);
        else if (f.confidence < -1e-9 || f.confidence > 0.99 + 1e-9) fail(`pass ${pass}: confidence ${f.confidence} out of [0,0.99]`);
        // status valid
        if (!['provisional', 'durable', 'archived'].includes(f.status)) fail(`pass ${pass}: bad status ${f.status}`);
        // I3
        if (f.status === 'archived' && f.inRag) fail(`pass ${pass}: archived fact is inRag ("${f.value}")`);
        if (!byAttr.has(f.attribute)) byAttr.set(f.attribute, []);
        byAttr.get(f.attribute).push(f);
    }
    for (const [attr, group] of byAttr) {
        const inrag = group.filter((f) => f.inRag);
        // I2
        if (inrag.length > 1) fail(`pass ${pass}: ${inrag.length} inRag facts for attribute "${attr}"`);
        // I5
        if (inrag.length === 1) {
            const active = group.filter((f) => f.status !== 'archived');
            const top = active.slice().sort((a, b) => b.confidence - a.confidence)[0];
            if (inrag[0] !== top) fail(`pass ${pass}: inRag fact for "${attr}" is not the top active candidate`);
        }
    }
    // I4
    if (store.durableFacts().some((f) => f.status === 'archived')) fail(`pass ${pass}: durableFacts() returned an archived belief`);
}

// Apply the reflection caller contract after each observe().
function applyContract(res) {
    for (const f of res.promoted) f.inRag = true;
    for (const f of res.demoted) f.inRag = false;
}

// ---------------------------------------------------------------------------
// Phase 1: broad random fuzz across many attributes, sources, and value kinds.
// ---------------------------------------------------------------------------
function phaseRandomFuzz(seed, passes) {
    const rand = rng(seed);
    const store = new FactStore();
    store.loaded = true;
    const ATTRS = ['browser', 'editor', 'phone model', 'profession', 'music app', 'coffee preference', 'os'];
    const VALUES = {
        browser: ['Chrome', 'Firefox', 'Edge', 'Safari', 'Brave'],
        editor: ['VS Code', 'Vim', 'Neovim', 'Sublime', 'JetBrains'],
        'phone model': ['Redmi Note 10 Pro', 'iPhone 15', 'Pixel 8', 'Galaxy S24'],
        profession: ['software engineer', 'security researcher', 'data scientist'],
        'music app': ['Spotify', 'YouTube Music', 'Apple Music'],
        'coffee preference': ['black coffee', 'latte', 'espresso'],
        os: ['Windows', 'Linux', 'macOS'],
    };
    const SOURCES = ['voice', 'text', 'correction', 'ocr'];
    let now = Date.now();

    for (let p = 0; p < passes; p++) {
        now += Math.floor(rand() * 2 * 86400000) + 3600000; // 1h–2d
        const n = 1 + Math.floor(rand() * 4);
        const items = [];
        for (let i = 0; i < n; i++) {
            const kind = rand();
            if (kind < 0.15) {
                // pure garble: unique attribute + value, never repeats
                const g = Math.floor(rand() * 1e9).toString(36);
                items.push({ attribute: `garble ${g}`, value: `noise ${g}`, statement: `garble ${g} value`, prob: rand() });
            } else {
                const attr = ATTRS[Math.floor(rand() * ATTRS.length)];
                const vals = VALUES[attr];
                let value = vals[Math.floor(rand() * vals.length)];
                // sometimes paraphrase the attribute or value
                let attribute = attr;
                if (rand() < 0.3) attribute = 'preferred ' + attr;
                if (rand() < 0.2) attribute = attr + ' preference';
                if (rand() < 0.2) value = value + ' browser'.slice(0, 0) + (rand() < 0.5 ? '' : ' app');
                items.push({ attribute, value, statement: `the user uses ${value}`, prob: 0.4 + rand() * 0.6 });
            }
        }
        const source = SOURCES[Math.floor(rand() * SOURCES.length)];
        const res = store.observe(items, { source, now });
        applyContract(res);
        checkInvariants(store, p);
    }
    return store;
}

// ---------------------------------------------------------------------------
// Phase 2 (I6): a sustained contradiction must eventually flip the winner.
// ---------------------------------------------------------------------------
function phaseFlip(seed) {
    const rand = rng(seed);
    const store = new FactStore();
    store.loaded = true;
    let now = Date.now();
    // Establish Chrome firmly.
    for (let i = 0; i < 4; i++) {
        now += 86400000;
        applyContract(store.observe([{ attribute: 'browser', value: 'Chrome', statement: 'uses Chrome', prob: 0.9 }], { source: 'text', now }));
    }
    const chrome0 = store.facts.find((f) => /chrome/i.test(f.value));
    const chromeWasDurable = chrome0 && chrome0.inRag;
    // Now sustained Firefox evidence.
    for (let i = 0; i < 8; i++) {
        now += 86400000;
        applyContract(store.observe([{ attribute: 'browser', value: 'Firefox', statement: 'now uses Firefox', prob: 0.9 }], { source: 'text', now }));
        checkInvariants(store, 100 + i);
    }
    const chrome = store.facts.find((f) => /chrome/i.test(f.value));
    const firefox = store.facts.find((f) => /firefox/i.test(f.value));
    const flipped = firefox && firefox.inRag && chrome && !chrome.inRag && firefox.confidence > chrome.confidence;
    return { chromeWasDurable, flipped };
}

// ---------------------------------------------------------------------------
// Phase 3: overflow — hammer ONE fact with hundreds of confirmations.
// ---------------------------------------------------------------------------
function phaseOverflow() {
    const store = new FactStore();
    store.loaded = true;
    let now = Date.now();
    for (let i = 0; i < 500; i++) {
        now += 3600000;
        applyContract(store.observe([{ attribute: 'browser', value: 'Chrome', statement: 'uses Chrome', prob: 1.0 }], { source: 'correction', now }));
    }
    const chrome = store.facts.find((f) => /chrome/i.test(f.value));
    return { maxConf: chrome.confidence, capped: chrome.confidence <= 0.99 + 1e-9 };
}

// --- run ---
console.log('Phase 1: broad random fuzz (5 seeds × 800 passes)...');
let totalFacts = 0;
for (const seed of [1, 42, 1337, 99999, 271828]) {
    const store = phaseRandomFuzz(seed, 800);
    totalFacts += store.facts.length;
}
console.log(`  ran 4000 passes, ${totalFacts} facts accumulated, ${failures} invariant failures so far`);

console.log('Phase 2: contradiction flip (I6)...');
const flip = phaseFlip(7);
if (!flip.chromeWasDurable) fail('flip: Chrome never became durable');
if (!flip.flipped) fail('flip: Firefox did not overtake Chrome');
console.log(`  chrome established=${flip.chromeWasDurable}, flipped to firefox=${flip.flipped}`);

console.log('Phase 3: confirmation overflow...');
const of = phaseOverflow();
if (!of.capped) fail(`overflow: confidence ${of.maxConf} exceeded 0.99`);
console.log(`  500 confirmations -> max confidence ${of.maxConf.toFixed(4)} (capped=${of.capped})`);

console.log(`\n${failures === 0 ? 'ALL INVARIANTS HELD' : failures + ' INVARIANT FAILURE(S)'}`);
process.exit(failures ? 1 : 0);
