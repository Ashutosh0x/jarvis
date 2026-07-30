/**
 * CONFLICT REPORT — corrected grading, naive baselines, recency partition.
 *
 * Combines three things that must be read together or not at all:
 *
 *   1. The frozen model answers RE-GRADED under the A2-fixed matcher. These are
 *      corrections, not re-measurements: the stored text is unchanged, so no
 *      model call is made and the delta is attributable entirely to the grader.
 *   2. All five naive policies under the same fixed matcher.
 *   3. Both stratified by whether recency is definitionally aligned with the
 *      gold answer, because the aggregate is a function of the relation mix of
 *      a 31-item set that was authored by hand — it measures corpus composition
 *      at least as much as it measures the system.
 *
 * PRIMARY n IS 29. The retrieval probe (eval/retrieval-probe.mjs, 22 Jul 2026)
 * found that k-trap-primary and k-trap-syndicated never surfaced their opposing
 * document, so the model answered from the only document it had. Both were
 * scored as passes. They are not conflict resolutions and they are excluded
 * from the primary figures; n=31 is retained alongside so the correction is
 * visible rather than quietly applied.
 *
 * No generation calls anywhere in this file.
 */

import fs from 'node:fs';
import path from 'node:path';
import { CONFLICT_DOCS, CONFLICT_QUESTIONS, CONFLICT_PAIRS } from './conflict-corpus.mjs';
import { binomPmf, mcnemarExact } from './paired-stats.mjs';
import { parseDateHint } from '../src/js/services/investigation.js';

/* Items the model was never actually shown both halves of. */
const FREE_PASS = ['k-trap-primary', 'k-trap-syndicated'];

/* Recency is definitionally aligned with the gold answer here: an amendment
   supersedes what it amends, a correction is necessarily later than the error.
   A date sort is close to the correct algorithm on these, not a naive baseline.
   `authority` is provisional pending the C1 date check below. */
const ALIGNED = new Set(['supersession', 'correction']);

const byId = Object.fromEntries(CONFLICT_DOCS.map((d) => [d.id, d.text]));
const collapse = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const anyMatch = (pats, text) => Array.isArray(pats) && pats.some((r) => r.test(text));

/** The eval grader reduced to the branches reachable here. */
function gradeText(q, answer) {
    const text = collapse(answer);
    if (anyMatch(q.trap, text)) return false;
    if (anyMatch(q.mustNot, text)) return false;
    return anyMatch(q.must, text);
}

/* --- exact Clopper-Pearson ------------------------------------------------ */
const P = (k, n, p) => { let s = 0; for (let i = 0; i <= k; i++) s += binomPmf(i, n, p); return s; };
const Q = (k, n, p) => { let s = 0; for (let i = k; i <= n; i++) s += binomPmf(i, n, p); return s; };
const bis = (f) => { let a = 0, b = 1; for (let i = 0; i < 200; i++) { const x = (a + b) / 2; if (f(x)) b = x; else a = x; } return (a + b) / 2; };
const ci = (k, n) => (n ? `[${(100 * (k === 0 ? 0 : bis((x) => Q(k, n, x) > 0.025))).toFixed(0)}%, ${(100 * (k === n ? 1 : bis((x) => P(k, n, x) < 0.025))).toFixed(0)}%]` : '[--]');

/* --- policies -------------------------------------------------------------- */
const DECL = Object.fromEntries(CONFLICT_DOCS.map((d, i) => [d.id, i]));
function mulberry32(seed) {
    return function rand() {
        seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
/**
 * DEFECT B1, found by the C1 date check. The first implementation fell back to
 * `pair[0]` when neither document carried a date — and pair[0] is the GOVERNING
 * document by construction of CONFLICT_PAIRS. On undated pairs the "naive
 * recency baseline" was therefore silently an oracle. All five authority items
 * and all five specificity items are undated, so ten of twenty-nine were
 * inflated to a guaranteed pass.
 *
 * A date sort given no dates cannot decide. It falls back to input order, which
 * is what an implementation without special-casing actually does. Declaration
 * order is uncorrelated with which document governs.
 */
const newestOf = (pair, rand = null) => {
    const d = pair.map((id) => ({ id, d: parseDateHint(byId[id]) })).filter((x) => x.d);
    if (d.length === 2) return d.sort((a, b) => b.d - a.d)[0].id;
    if (d.length === 1) return d[0].id;              // one dated, one not: the dated one is the only evidence of recency
    /* Undecidable. The FIRST attempt fell back to pair[0] — the governing
       document — turning the baseline into an oracle on 10 of 29 items. The
       SECOND fell back to declaration order, which scores 27.6%, BELOW random's
       40.3%, because the governing half is declared second in most pairs; that
       replaced a guaranteed pass with a guaranteed failure. Both errors ran in
       whichever direction suited the conclusion being drawn at the time.
       A coin is the only unbiased answer to an undecidable pair. */
    return rand ? pair[rand() < 0.5 ? 0 : 1] : pair[0];
};
/** How many pairs the date sort can actually adjudicate, per relation. */
const datedCount = (pair) => pair.filter((id) => parseDateHint(byId[id])).length;
const POLICIES = {
    'always-longest': (p) => (byId[p[0]].length >= byId[p[1]].length ? p[0] : p[1]),
    'always-first': (p) => (DECL[p[0]] <= DECL[p[1]] ? p[0] : p[1]),
    'always-governing (oracle doc)': (p) => p[0],
};

/** Expectation of a stochastic policy over `trials` seeds. */
function expectedScore(qs, pickWithRand, trials = 400) {
    const per = {}; let tot = 0;
    for (let s = 0; s < trials; s++) {
        const rand = mulberry32(9000 + s);
        for (const q of qs) {
            const ok = gradeText(q, byId[pickWithRand(CONFLICT_PAIRS[q.id], rand)]);
            per[q.type] ??= 0;
            if (ok) { per[q.type]++; tot++; }
        }
    }
    return { k: tot / trials, n: qs.length, per: Object.fromEntries(Object.entries(per).map(([t, v]) => [t, v / trials])) };
}

/* --- load the frozen model answers ---------------------------------------- */
const dir = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'results');
const file = fs.readdirSync(dir).filter((f) => /^answers-\d.*\.jsonl$/.test(f)).sort().pop();
const stored = fs.readFileSync(path.join(dir, file), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    .filter((r) => r.kind === 'conflict' && r.config === 'rag');
if (!stored.length) { console.error('no stored conflict rows in', file); process.exit(1); }
console.log(`frozen answers: ${file} (${stored.length} rows, config=rag)\n`);

const answerById = Object.fromEntries(stored.map((r) => [r.id, r.answer]));
const oldPassById = Object.fromEntries(stored.map((r) => [r.id, r.pass]));

/* --- scoring --------------------------------------------------------------- */
function score(qs, verdictFn) {
    const per = {}; let k = 0;
    for (const q of qs) {
        const ok = verdictFn(q);
        per[q.type] ??= { pass: 0, total: 0 };
        per[q.type].total++;
        if (ok) { per[q.type].pass++; k++; }
    }
    return { k, n: qs.length, per };
}

const SETS = {
    'n=31 (all)': CONFLICT_QUESTIONS,
    'n=29 (primary)': CONFLICT_QUESTIONS.filter((q) => !FREE_PASS.includes(q.id)),
};

const modelNew = (q) => gradeText(q, answerById[q.id] || '');
const modelOld = (q) => !!oldPassById[q.id];

console.log('=== A2 CORRECTION — same stored answers, fixed matcher ===');
console.log('| set | grader | model pass | rate | 95% CI |');
console.log('| --- | --- | ---: | ---: | :---: |');
for (const [label, qs] of Object.entries(SETS)) {
    for (const [g, fn] of [['original (A2 defect)', modelOld], ['fixed', modelNew]]) {
        const r = score(qs, fn);
        console.log(`| ${label} | ${g} | ${r.k}/${r.n} | ${(100 * r.k / r.n).toFixed(1)}% | ${ci(r.k, r.n)} |`);
    }
}

console.log('\n=== ALL POLICIES, FIXED MATCHER ===');
for (const [label, qs] of Object.entries(SETS)) {
    console.log(`\n${label}`);
    console.log('| policy | pass | rate | 95% CI |');
    console.log('| --- | ---: | ---: | :---: |');
    const rows = [];
    for (const [name, pick] of Object.entries(POLICIES)) {
        const r = score(qs, (q) => gradeText(q, byId[pick(CONFLICT_PAIRS[q.id])]));
        rows.push([name, r]);
        console.log(`| ${name} | ${r.k}/${r.n} | ${(100 * r.k / r.n).toFixed(1)}% | ${ci(r.k, r.n)} |`);
    }
    // random as an expectation over 200 draws
    let tot = 0; const perR = {};
    for (let s = 0; s < 200; s++) {
        const rand = mulberry32(1000 + s);
        for (const q of qs) {
            const pr = CONFLICT_PAIRS[q.id];
            const ok = gradeText(q, byId[pr[rand() < 0.5 ? 0 : 1]]);
            perR[q.type] ??= 0; if (ok) { perR[q.type]++; tot++; }
        }
    }
    console.log(`| random (200 draws) | ${(tot / 200).toFixed(1)}/${qs.length} | ${(100 * tot / 200 / qs.length).toFixed(1)}% | (expectation) |`);
    const nw = expectedScore(qs, newestOf);
    console.log(`| always-newest (coin on undated) | ${nw.k.toFixed(1)}/${nw.n} | ${(100 * nw.k / nw.n).toFixed(1)}% | (expectation) |`);
    const decidable = qs.filter((q) => datedCount(CONFLICT_PAIRS[q.id]) > 0);
    const dec = score(decidable, (q) => gradeText(q, byId[newestOf(CONFLICT_PAIRS[q.id])]));
    console.log(`| always-newest (DECIDABLE subset only) | ${dec.k}/${dec.n} | ${(100 * dec.k / dec.n).toFixed(1)}% | ${ci(dec.k, dec.n)} |`);
    const mDec = score(decidable, modelNew);
    console.log(`| model, same decidable subset | ${mDec.k}/${mDec.n} | ${(100 * mDec.k / mDec.n).toFixed(1)}% | ${ci(mDec.k, mDec.n)} |`);
    const mr = score(qs, modelNew);
    console.log(`| **gemma3:4b rag (fixed grader)** | **${mr.k}/${mr.n}** | **${(100 * mr.k / mr.n).toFixed(1)}%** | **${ci(mr.k, mr.n)}** |`);
}

/* --- C2 + per-relation ------------------------------------------------------ */
const primary = SETS['n=29 (primary)'];
const types = [...new Set(CONFLICT_QUESTIONS.map((q) => q.type))];
console.log('\n=== PER RELATION (n=29, fixed matcher) ===');
const polNames = Object.keys(POLICIES);
console.log(`| relation | aligned? | n | ${polNames.join(' | ')} | model |`);
console.log(`| --- | :---: | ---: | ${polNames.map(() => '---:').join(' | ')} | ---: |`);
for (const t of types) {
    const qs = primary.filter((q) => q.type === t);
    if (!qs.length) continue;
    const cells = polNames.map((nm) => {
        const r = score(qs, (q) => gradeText(q, byId[POLICIES[nm](CONFLICT_PAIRS[q.id])]));
        return `${r.k}/${r.n}`;
    });
    const m = score(qs, modelNew);
    console.log(`| ${t} | ${ALIGNED.has(t) ? 'ALIGNED' : 'adversarial'} | ${qs.length} | ${cells.join(' | ')} | ${m.k}/${m.n} |`);
}

/* --- C1: is `authority` confounded with recency? ---------------------------- */
console.log('\n=== C1 — authority items: is the governing document also the later one? ===');
console.log('| item | governing | date | opposing | date | governing is later? |');
console.log('| --- | --- | --- | --- | --- | :---: |');
let authLater = 0, authDated = 0;
for (const q of CONFLICT_QUESTIONS.filter((x) => x.type === 'authority')) {
    const [g, o] = CONFLICT_PAIRS[q.id];
    const dg = parseDateHint(byId[g]), don = parseDateHint(byId[o]);
    const iso = (d) => (d ? d.toISOString().slice(0, 10) : '(none)');
    let verdict;
    if (!dg || !don) verdict = 'undated';
    else { authDated++; if (dg > don) { verdict = 'YES'; authLater++; } else verdict = 'no'; }
    console.log(`| ${q.id} | ${g} | ${iso(dg)} | ${o} | ${iso(don)} | ${verdict} |`);
}
console.log(`\ngoverning-is-later in ${authLater} of ${authDated} dated authority items ` +
    `(${CONFLICT_QUESTIONS.filter((x) => x.type === 'authority').length - authDated} undated).`);
console.log(authLater >= 4
    ? 'CONFOUNDED: authority is not separable from recency on this corpus.'
    : 'NOT confounded with recency — but see below: it is not TESTABLE by recency either.');

console.log('\n=== how many pairs the date sort can adjudicate at all ===');
console.log('| relation | n | both dated | one dated | neither |');
console.log('| --- | ---: | ---: | ---: | ---: |');
for (const t of types) {
    const qs = primary.filter((q) => q.type === t);
    if (!qs.length) continue;
    const c = [0, 0, 0];
    for (const q of qs) c[2 - datedCount(CONFLICT_PAIRS[q.id])]++;
    console.log(`| ${t} | ${qs.length} | ${c[0]} | ${c[1]} | ${c[2]} |`);
}

/* --- oracle router ceiling -------------------------------------------------- */
console.log('\n=== ORACLE ROUTER CEILING (adversarial partition) ===');
const adversarial = primary.filter((q) => !ALIGNED.has(q.type));
const oracleAdv = score(adversarial, modelNew);
// date sort on adversarial items, coin tie-break, expectation over seeds
const newestAdvExp = expectedScore(adversarial, newestOf);
const newestAdv = score(adversarial, (q) => gradeText(q, byId[newestOf(CONFLICT_PAIRS[q.id])]));
let b = 0, c = 0;
for (const q of adversarial) {
    const m = modelNew(q), nn = gradeText(q, byId[newestOf(CONFLICT_PAIRS[q.id])]);
    if (nn && !m) b++; if (!nn && m) c++;
}
const mc = mcnemarExact(b, c);
console.log(`adversarial n=${adversarial.length}: model ${oracleAdv.k}, always-newest ${newestAdv.k}`);
console.log(`discordant b=${b} c=${c}, exact p=${mc.p.toFixed(4)} -> ${mc.p < 0.05 ? 'significant' : 'NOT significant'}`);

/* Smallest one-directional discordant count reaching p<0.05, and the corpus
   size that implies at the observed discordance rate. */
let need = 0;
for (let d = 1; d <= 40; d++) if (mcnemarExact(d, 0).p < 0.05) { need = d; break; }
const discRate = adversarial.length ? (b + c) / adversarial.length : 0;
console.log(`\nsmallest clean sweep reaching p<0.05: ${need} discordant pairs (p=${mcnemarExact(need, 0).p.toFixed(4)})`);
console.log(`observed discordance rate on adversarial items: ${(100 * discRate).toFixed(0)}% (${b + c}/${adversarial.length})`);
if (discRate > 0) {
    console.log(`=> adversarial items required at that rate, assuming a CLEAN sweep: ${Math.ceil(need / discRate)}`);
    console.log(`=> with a realistic 80/20 split of discordant pairs, ~${Math.ceil((need * 3) / discRate)} would be needed.`);
}

const out = path.join(dir, `conflict-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
fs.writeFileSync(out, JSON.stringify({ ts: Date.now(), file, freePass: FREE_PASS, aligned: [...ALIGNED] }, null, 2));
console.log(`\nwrote ${path.basename(out)}`);
