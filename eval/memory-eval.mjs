/**
 * MEMORY EVALUATION — does the belief store actually hold the right beliefs?
 *
 * The claim the architecture makes is specific and testable: a genuine
 * preference, repeated, becomes durable memory; a speech-recognition mangling,
 * heard once, never does; and when a fact CHANGES, the new value replaces the
 * old rather than sitting alongside it. Elaborate memory machinery is worth
 * nothing if it cannot be shown to do those three things.
 *
 * Drives the REAL FactStore class (observe() is pure — no I/O), on the scripted
 * observation stream in eval/corpus.mjs.
 *
 * Run:  node eval/memory-eval.mjs
 */

import { FactStore } from '../src/js/services/factStore.js';
import { MEMORY_SCRIPT, MEMORY_EXPECTATIONS } from './corpus.mjs';

const DAY = 24 * 60 * 60 * 1000;
const store = new FactStore();

// Replay the script, one reflection pass per simulated day, so decay applies
// the way it would in real use rather than all at once.
const passes = [...new Set(MEMORY_SCRIPT.map(s => s.pass))].sort((a, b) => a - b);
const t0 = Date.now() - passes.length * DAY;
let promotedTotal = 0, demotedTotal = 0;

for (const p of passes) {
    const now = t0 + p * DAY;
    for (const step of MEMORY_SCRIPT.filter(s => s.pass === p)) {
        const { promoted = [], demoted = [] } = store.observe(step.facts, { source: step.source, now }) || {};
        promotedTotal += promoted.length;
        demotedTotal += demoted.length;
    }
}

const durable = store.durableFacts();
const byAttr = new Map(durable.map(f => [f.attribute, f]));

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
    ok ? pass++ : fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

console.log(`replayed ${MEMORY_SCRIPT.length} observations over ${passes.length} passes`);
console.log(`durable beliefs held: ${durable.length}, promotions: ${promotedTotal}, demotions: ${demotedTotal}\n`);

for (const exp of MEMORY_EXPECTATIONS) {
    const found = [...byAttr.entries()].find(([attr]) => attr.includes(exp.attribute.split(' ').pop()));
    const fact = found?.[1];
    if (exp.shouldBeDurable) {
        const held = !!fact;
        const rightValue = held && new RegExp(exp.value, 'i').test(fact.statement + ' ' + (fact.value || ''));
        check(`remembers "${exp.attribute}"`, held, exp.why);
        check(`  value is ${exp.value}`, rightValue, held ? `stored: "${fact.statement}" (${Math.round(fact.confidence * 100)}% sure)` : 'nothing stored');
    } else {
        check(`rejects "${exp.attribute}"`, !fact, exp.why + (fact ? ` — LEAKED: "${fact.statement}"` : ''));
    }
}

/* The revision case gets its own assertion: the failure mode is not "forgot the
   new value" but "kept both", which reads as remembering and answers wrongly. */
const editorFacts = store.facts.filter(f => f.attribute.includes('editor'));
// `inRag` is set by the caller after it ingests a promoted fact, not by the
// store, so durability is the store's own signal and the right thing to assert
// here. (First version of this check used inRag and failed against a store that
// was behaving correctly — the assertion was wrong, not the code.)
const liveEditors = editorFacts.filter(f => f.status === 'durable');
check('only one editor belief is durable after revision',
    liveEditors.length === 1 && /VS Code/i.test(liveEditors[0].value),
    `durable: ${liveEditors.map(f => f.value).join(', ') || 'none'}; archived: ${editorFacts.filter(f => f.status === 'archived').map(f => f.value).join(', ') || 'none'}`);

/* Confidence has to be usable, not decorative: a belief confirmed by typing
   should not sit below one heard once through a microphone. */
const browser = byAttr.get([...byAttr.keys()].find(k => k.includes('browser')) || '');
if (browser) {
    check('confidence is reported and bounded', browser.confidence > 0 && browser.confidence <= 0.99,
        `${Math.round(browser.confidence * 100)}% after ${browser.timesObserved} observations`);
    check('provenance is retained', Array.isArray(browser.evidence) && browser.evidence.length > 0,
        `${browser.evidence?.length || 0} evidence records, sources: ${[...new Set((browser.evidence || []).map(e => e.source))].join(', ')}`);
}

/* The headline number the reviews asked for: of everything the store was told,
   how much of what SHOULD be remembered is, and how much garbage got in. */
const shouldHold = MEMORY_EXPECTATIONS.filter(e => e.shouldBeDurable);
const shouldReject = MEMORY_EXPECTATIONS.filter(e => !e.shouldBeDurable);
const held = shouldHold.filter(e => [...byAttr.keys()].some(k => k.includes(e.attribute.split(' ').pop()))).length;
const leaked = shouldReject.filter(e => [...byAttr.keys()].some(k => k.includes(e.attribute.split(' ').pop()))).length;

console.log(`\nrecall of genuine facts:   ${held}/${shouldHold.length}`);
console.log(`garble admitted to memory: ${leaked}/${shouldReject.length}`);
console.log(`\n${pass} passed, ${fail} failed`);
console.log('\nNOTE: the observation script is synthetic (eval/corpus.mjs) and small. It tests');
console.log('the STATE MACHINE — corroboration, decay, competition, revision — not how well');
console.log('an LLM distils facts out of real conversation, which is a separate question.');
process.exit(fail ? 1 : 0);
