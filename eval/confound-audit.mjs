/**
 * CONFOUND AUDIT — standing gate. Runs BEFORE any model score is reported.
 *
 * Three confounds have been found in this corpus so far: a grader that could be
 * satisfied by copying a document (A2), a date-sort baseline inapplicable to 18
 * of 29 items (C1), and the governing document being the longer one in 15 of 29
 * (C2, generalised). TWO OF THE THREE WERE FOUND BY ACCIDENT — because someone
 * happened to ask about that specific surface feature. That is not a process.
 *
 * This is the process. Every relation is scored against trivial policies that
 * look only at surface features of the two documents and never at meaning. A
 * relation where any of them scores meaningfully above chance is confounded, and
 * the model's score on it is uninterpretable: the model may be right for the
 * trivial reason rather than the intended one.
 *
 * TASK SPLIT. `unresolvable` is a DETECTION task — the correct output is a
 * statement about the sources, which no document-selection policy can produce.
 * Scoring it 0/5 for every policy and then averaging it into a selection number
 * drags every aggregate down by a fixed ~17 points and compares two different
 * capabilities. Selection (n=24) and abstention (n=5) are reported separately
 * and never combined.
 *
 * `always-governing` is deliberately NOT in the results table. It scores 24/24
 * because the policy and the grader are the same predicate — it is a grader
 * self-test, not a ceiling.
 *
 * No model calls.
 */

import fs from 'node:fs';
import path from 'node:path';
import { CONFLICT_DOCS, CONFLICT_QUESTIONS, CONFLICT_PAIRS } from './conflict-corpus.mjs';
import { binomPmf, mcnemarExact } from './paired-stats.mjs';
import { parseDateHint } from '../src/js/services/investigation.js';

const FREE_PASS = ['k-trap-primary', 'k-trap-syndicated'];
const byId = Object.fromEntries(CONFLICT_DOCS.map((d) => [d.id, d.text]));
const DECL = Object.fromEntries(CONFLICT_DOCS.map((d, i) => [d.id, i]));
const collapse = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const anyMatch = (p, t) => Array.isArray(p) && p.some((r) => r.test(t));
const gradeText = (q, a) => {
    const t = collapse(a);
    if (anyMatch(q.trap, t)) return false;
    if (anyMatch(q.mustNot, t)) return false;
    return anyMatch(q.must, t);
};

/* --- surface-feature policies --------------------------------------------
   Each returns a document id chosen WITHOUT reading for meaning. `rand` is the
   unbiased fallback when the feature cannot discriminate — the newestOf bug
   taught that a deterministic fallback silently encodes an answer. */
const dateOf = (id) => parseDateHint(byId[id]);
const FORMAL = /\b(pursuant|notwithstanding|hereby|supersede|thereof|herein|shall|filed|filing|supplement|section|clause|registered|ratified|effective)\b/gi;
const MARKER = /\b(supersede\w*|amend\w*|correct\w*|retract\w*|reject\w*|withdraw\w*|withdrew|errata|notwithstanding|takes precedence|draft|preliminary|unverified|not for implementation|replacing|final)\b/gi;
const countOf = (re) => (t) => (String(t).match(re) || []).length;
const numerics = (t) => (String(t).match(/\d/g) || []).length;

const pick = (a, b, cmp, rand) => {
    const r = cmp(byId[a], byId[b]);
    if (r > 0) return a;
    if (r < 0) return b;
    return rand ? (rand() < 0.5 ? a : b) : a;
};

const POLICIES = {
    'longest': (p, r) => pick(p[0], p[1], (x, y) => x.length - y.length, r),
    'shortest': (p, r) => pick(p[0], p[1], (x, y) => y.length - x.length, r),
    'first': (p, r) => pick(p[0], p[1], () => DECL[p[1]] - DECL[p[0]], r),
    'second': (p, r) => pick(p[0], p[1], () => DECL[p[0]] - DECL[p[1]], r),
    'newest': (p, r) => { const [x, y] = p.map(dateOf); return (x && y) ? (x > y ? p[0] : p[1]) : (x ? p[0] : (y ? p[1] : (r ? (r() < 0.5 ? p[0] : p[1]) : p[0]))); },
    'oldest': (p, r) => { const [x, y] = p.map(dateOf); return (x && y) ? (x < y ? p[0] : p[1]) : (x ? p[0] : (y ? p[1] : (r ? (r() < 0.5 ? p[0] : p[1]) : p[0]))); },
    'more-formal': (p, r) => pick(p[0], p[1], (x, y) => countOf(FORMAL)(x) - countOf(FORMAL)(y), r),
    'has-marker': (p, r) => pick(p[0], p[1], (x, y) => countOf(MARKER)(x) - countOf(MARKER)(y), r),
    'more-numeric': (p, r) => pick(p[0], p[1], (x, y) => numerics(x) - numerics(y), r),
};

function mulberry32(seed) {
    return function rand() {
        seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Expectation over seeds, so a policy with ties is not scored on one draw. */
function expected(qs, policy, trials = 400) {
    let tot = 0;
    for (let s = 0; s < trials; s++) {
        const rand = mulberry32(4000 + s);
        for (const q of qs) if (gradeText(q, byId[policy(CONFLICT_PAIRS[q.id], rand)])) tot++;
    }
    return tot / trials;
}

/* --- load frozen model answers -------------------------------------------- */
const dir = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'results');
const file = fs.readdirSync(dir).filter((f) => /^answers-\d.*\.jsonl$/.test(f)).sort().pop();
const stored = fs.readFileSync(path.join(dir, file), 'utf8').trim().split('\n').map(JSON.parse)
    .filter((r) => r.kind === 'conflict' && r.config === 'rag');
const ansOf = Object.fromEntries(stored.map((r) => [r.id, r.answer]));
const modelPass = (q) => gradeText(q, ansOf[q.id] || '');

const primary = CONFLICT_QUESTIONS.filter((q) => !FREE_PASS.includes(q.id));
const SELECTION = primary.filter((q) => q.type !== 'unresolvable');
const ABSTENTION = primary.filter((q) => q.type === 'unresolvable');

console.log(`frozen answers: ${file}`);
console.log(`SELECTION n=${SELECTION.length}   ABSTENTION n=${ABSTENTION.length}   (never combined)\n`);

/* --- 1. CONFOUND TABLE, before any model number --------------------------- */
const relations = [...new Set(SELECTION.map((q) => q.type))];
const names = Object.keys(POLICIES);
console.log('=== CONFOUND TABLE (surface-feature policies, selection items only) ===');
console.log('chance = 50% per item; a relation is CONFOUNDED if any policy is at or near ceiling\n');
console.log(`| relation | n | ${names.join(' | ')} | verdict |`);
console.log(`| --- | ---: | ${names.map(() => '---:').join(' | ')} | :---: |`);
const confounded = [];
for (const t of relations) {
    const qs = SELECTION.filter((q) => q.type === t);
    const scores = names.map((n) => expected(qs, POLICIES[n]));
    const worst = Math.max(...scores);
    const bad = worst >= qs.length - 0.001;                 // a policy at ceiling
    if (bad) confounded.push(`${t} (${names[scores.indexOf(worst)]} ${worst.toFixed(1)}/${qs.length})`);
    console.log(`| ${t} | ${qs.length} | ${scores.map((s) => s.toFixed(1)).join(' | ')} | ${bad ? '**CONFOUNDED**' : 'ok'} |`);
}
const allSel = names.map((n) => expected(SELECTION, POLICIES[n]));
console.log(`| **ALL selection** | ${SELECTION.length} | ${allSel.map((s) => s.toFixed(1)).join(' | ')} | |`);
console.log(`\nconfounded relations: ${confounded.length ? confounded.join('; ') : 'none'}`);
console.log(`=> model scores on ${confounded.length ? 'those relations are UNINTERPRETABLE' : 'all relations are interpretable'}`);

/* --- 2. model, only after the above ---------------------------------------- */
const selK = SELECTION.filter(modelPass).length;
const absK = ABSTENTION.filter(modelPass).length;
console.log(`\n=== MODEL (read only against the table above) ===`);
console.log(`SELECTION  ${selK}/${SELECTION.length}`);
console.log(`ABSTENTION ${absK}/${ABSTENTION.length}`);

/* --- 3. the requested paired test ------------------------------------------ */
console.log('\n=== PAIRED: model vs always-longest ===');
for (const [label, qs] of [['selection n=' + SELECTION.length, SELECTION], ['all primary n=' + primary.length, primary]]) {
    let b = 0, c = 0; const bl = [], cl = [];
    for (const q of qs) {
        const m = modelPass(q);
        const l = gradeText(q, byId[POLICIES['longest'](CONFLICT_PAIRS[q.id])]);
        if (l && !m) { b++; bl.push(q.id); }
        if (!l && m) { c++; cl.push(q.id); }
    }
    const r = mcnemarExact(b, c);
    console.log(`${label}: longest-wins ${b} [${bl.join(', ')}] | model-wins ${c} [${cl.join(', ')}] | discordant ${r.n} | exact p=${r.p.toFixed(3)} -> ${r.p < 0.05 ? 'SIGNIFICANT' : 'NOT significant'}`);
}

/* --- 4. n required for the step-4 abstention effect ------------------------ */
console.log('\n=== n REQUIRED FOR STEP 4 (option b) ===');
let need = 0;
for (let d = 1; d <= 60; d++) if (mcnemarExact(d, 0).p < 0.05) { need = d; break; }
console.log(`smallest clean one-directional sweep reaching p<0.05: ${need} (p=${mcnemarExact(need, 0).p.toFixed(4)})`);
console.log('predicted flip rate on abstention items (0/5 -> 2-4/5): 40%-80%');
for (const f of [0.4, 0.5, 0.6, 0.8]) {
    const cleanN = Math.ceil(need / f);
    const realN = Math.ceil((need + 2) / f);   // allow 2 opposing flips: 8 vs 2 -> p=0.0106
    console.log(`  flip rate ${(100 * f).toFixed(0)}%: ${cleanN} abstention items if clean; ${realN} if 2 flip back`);
}
console.log(`current abstention set: ${ABSTENTION.length}`);

fs.writeFileSync(path.join(dir, `confound-audit-${new Date().toISOString().replace(/[:.]/g, '-')}.json`),
    JSON.stringify({ ts: Date.now(), file, confounded, selK, selN: SELECTION.length, absK, absN: ABSTENTION.length }, null, 2));
