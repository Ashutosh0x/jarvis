/**
 * NAIVE BASELINES — what does 68% have to beat?
 *
 * A conflict-resolution accuracy reported without a baseline is not a result.
 * If "always take the newest document" scores 60%, then gemma3:4b at 68% is
 * buying eight points over a one-line heuristic and the architecture discussion
 * changes completely.
 *
 * Each baseline is a DOCUMENT-SELECTION POLICY, not a model. It picks one of the
 * two conflicting documents and emits its text as the answer, which is then
 * graded by the identical must/trap patterns the real eval uses. No generation
 * calls; nothing here touches Ollama.
 *
 * Grading note: for kind='conflict' the eval's grade() reduces to trap -> fail,
 * else must -> pass, else fail. A document-emitting baseline never abstains and
 * never triggers the guard, so that reduction is exact rather than approximate.
 *
 * The unresolvable items are the reason this is worth running at all. Their
 * `must` demands an acknowledgement that the sources disagree — language that
 * appears in NO single document. Every policy below therefore scores 0/5 on
 * them by construction, which is the honest floor for "always pick something".
 */

import fs from 'node:fs';
import { CONFLICT_DOCS, CONFLICT_QUESTIONS, CONFLICT_PAIRS } from './conflict-corpus.mjs';
import { binomPmf } from './paired-stats.mjs';
import { parseDateHint } from '../src/js/services/investigation.js';

const byId = Object.fromEntries(CONFLICT_DOCS.map((d) => [d.id, d.text]));
const collapse = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const anyMatch = (pats, text) => Array.isArray(pats) && pats.some((r) => r.test(text));

/** The eval's grader, reduced to the branches a document-emitting policy can reach. */
function gradeAnswer(q, answer) {
    const text = collapse(answer);
    if (anyMatch(q.trap, text)) return false;
    if (anyMatch(q.mustNot, text)) return false;
    return anyMatch(q.must, text);
}

/* Declaration order in CONFLICT_DOCS, which is arbitrary with respect to which
   document governs — several conflicts declare the superseded half first. */
const DECL_ORDER = Object.fromEntries(CONFLICT_DOCS.map((d, i) => [d.id, i]));

/** Deterministic PRNG so "random" is reproducible and reviewable. */
function mulberry32(seed) {
    return function rand() {
        seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const POLICIES = {
    /* The heuristic the recency-traps were built to defeat. Undated documents
       sort last, which is the charitable reading of "newest". */
    'always-newest': (pair) => {
        const dated = pair.map((id) => ({ id, d: parseDateHint(byId[id]) }));
        const withDates = dated.filter((x) => x.d);
        if (!withDates.length) return pair[0];
        return withDates.sort((a, b) => b.d - a.d)[0].id;
    },
    /* Length as a proxy for authority — longer documents carry more qualifying
       language, which is a real correlate in filings and advisories. */
    'always-longest': (pair) => (byId[pair[0]].length >= byId[pair[1]].length ? pair[0] : pair[1]),
    /* Corpus order. Included because it is the accidental policy a system with
       no precedence logic falls into. */
    'always-first': (pair) => (DECL_ORDER[pair[0]] <= DECL_ORDER[pair[1]] ? pair[0] : pair[1]),
};

/* --- exact Clopper-Pearson ------------------------------------------------ */
const P = (k, n, p) => { let s = 0; for (let i = 0; i <= k; i++) s += binomPmf(i, n, p); return s; };
const Q = (k, n, p) => { let s = 0; for (let i = k; i <= n; i++) s += binomPmf(i, n, p); return s; };
const bisect = (f) => { let a = 0, b = 1; for (let i = 0; i < 200; i++) { const x = (a + b) / 2; if (f(x)) b = x; else a = x; } return (a + b) / 2; };
const ciLo = (k, n) => (k === 0 ? 0 : bisect((x) => Q(k, n, x) > 0.025));
const ciHi = (k, n) => (k === n ? 1 : bisect((x) => P(k, n, x) < 0.025));
const fmtCI = (k, n) => `[${(100 * ciLo(k, n)).toFixed(0)}%, ${(100 * ciHi(k, n)).toFixed(0)}%]`;

/* --- run ------------------------------------------------------------------ */

const types = [...new Set(CONFLICT_QUESTIONS.map((q) => q.type))];
const results = {};

for (const [name, pick] of Object.entries(POLICIES)) {
    const per = {};
    let k = 0;
    for (const q of CONFLICT_QUESTIONS) {
        const chosen = pick(CONFLICT_PAIRS[q.id]);
        const ok = gradeAnswer(q, byId[chosen]);
        per[q.type] ??= { pass: 0, total: 0 };
        per[q.type].total++;
        if (ok) { per[q.type].pass++; k++; }
    }
    results[name] = { k, n: CONFLICT_QUESTIONS.length, per };
}

/* Random over 200 seeds: a single draw on n=31 is itself noisy, and the point
   of this row is the expectation, not one sample. */
{
    const per = {};
    for (const t of types) per[t] = { pass: 0, total: 0 };
    let total = 0;
    const TRIALS = 200;
    for (let s = 0; s < TRIALS; s++) {
        const rand = mulberry32(1000 + s);
        for (const q of CONFLICT_QUESTIONS) {
            const pair = CONFLICT_PAIRS[q.id];
            const ok = gradeAnswer(q, byId[pair[rand() < 0.5 ? 0 : 1]]);
            per[q.type].total++;
            if (ok) { per[q.type].pass++; total++; }
        }
    }
    results['random (200 draws)'] = {
        k: total / TRIALS, n: CONFLICT_QUESTIONS.length,
        per: Object.fromEntries(types.map((t) => [t, { pass: per[t].pass / TRIALS, total: per[t].total / TRIALS }])),
        expectation: true,
    };
}

/* The measured system, from the frozen run, for side-by-side reading. */
const MEASURED = { name: 'gemma3:4b rag (measured)', k: 21, n: 31 };

console.log(`naive baselines on the frozen ${CONFLICT_QUESTIONS.length}-item conflict set`);
console.log('document-selection policies only — no model calls\n');
console.log('| policy | pass | rate | 95% exact CI |');
console.log('| --- | ---: | ---: | :---: |');
for (const [name, r] of Object.entries(results)) {
    const rate = (100 * r.k / r.n).toFixed(1);
    const ci = r.expectation ? '(expectation)' : fmtCI(r.k, r.n);
    console.log(`| ${name} | ${r.expectation ? r.k.toFixed(1) : r.k}/${r.n} | ${rate}% | ${ci} |`);
}
console.log(`| **${MEASURED.name}** | **${MEASURED.k}/${MEASURED.n}** | **${(100 * MEASURED.k / MEASURED.n).toFixed(1)}%** | **${fmtCI(MEASURED.k, MEASURED.n)}** |`);

console.log('\nby relation (pass/total):');
const names = [...Object.keys(results)];
console.log(`| relation | ${names.join(' | ')} |`);
console.log(`| --- | ${names.map(() => '---:').join(' | ')} |`);
for (const t of types) {
    const cells = names.map((nm) => {
        const p = results[nm].per[t];
        return `${results[nm].expectation ? p.pass.toFixed(1) : p.pass}/${results[nm].expectation ? (p.total).toFixed(0) : p.total}`;
    });
    console.log(`| ${t} | ${cells.join(' | ')} |`);
}

const best = Object.entries(results).filter(([, r]) => !r.expectation).sort((a, b) => b[1].k - a[1].k)[0];
console.log(`\nstrongest naive policy: ${best[0]} at ${best[1].k}/${best[1].n} ${fmtCI(best[1].k, best[1].n)}`);
console.log(`measured system margin over it: ${MEASURED.k - best[1].k} items (${(100 * (MEASURED.k - best[1].k) / MEASURED.n).toFixed(1)}pp)`);
console.log('NOTE: overlapping CIs on n=31 mean that margin is not yet a significant difference.');

const out = `eval/results/conflict-baselines-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
fs.writeFileSync(out, JSON.stringify({ ts: Date.now(), results, measured: MEASURED }, null, 2));
console.log(`\nwrote ${out}`);
