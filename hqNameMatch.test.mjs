// The name check that decides whether a company's head office is where Google
// says it is.
//
// WHY THIS EXISTS. `validate-crawl.mjs` found twenty unrelated bank holding
// companies — First Bancorp (North Carolina), S&T Bancorp (Pennsylvania), Hope
// Bancorp (California), Origin Bancorp (Louisiana) and sixteen more — all
// pinned to one address in Little Rock, Arkansas: Southern Bancorp Corporate
// Headquarters.
//
// Nothing caught it. The country check passed, because every one of them is in
// the United States. The name check passed, because they all contain the word
// "Bancorp" and a shared token was a shared token. And 2 of the 20 were
// recorded at HIGH confidence, so filtering on confidence would not have found
// them either.
//
// The rule now weights a token by how much it identifies a company: a sector
// word counts for a quarter of a distinctive one, on both sides of the ratio.
// These cases are the ones the measurement actually turned up, so a regression
// reintroduces a bug that shipped rather than a hypothetical one.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const check = (n, c) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); };

/* The validation half of the resolver, loaded without its crawler half so this
   test cannot issue a billed request. */
const src = fs.readFileSync(path.join(ROOT, 'scripts', 'resolve-hq.mjs'), 'utf8');
const start = src.indexOf('/* ------------------------------------------------------------ validation -- */');
const end = src.indexOf('/* ------------------------------------------------------------- resolution -- */');
check('the resolver still has a separable validation block', start !== -1 && end !== -1);

const tmp = path.join(ROOT, '.tmp-hqname.test.mjs');
fs.writeFileSync(tmp, `${src.slice(start, end)}\nexport { nameAgrees };\n`);
let nameAgrees;
try {
    ({ nameAgrees } = await import(`file:///${tmp.replace(/\\/g, '/')}`));
} finally {
    fs.rmSync(tmp, { force: true });
}

const score = (a, b) => nameAgrees(a, b).score;
const ok = (a, b) => nameAgrees(a, b).ok;

// ── the twenty banks ────────────────────────────────────────────────────────
const SOUTHERN = 'Southern Bancorp Corporate Headquarters';

check('a shared sector word alone is not a match — First Bancorp',
    !ok('First Bancorp', SOUTHERN));
check('  ... nor Hope Bancorp', !ok('Hope Bancorp', SOUTHERN));
check('  ... nor Origin Bancorp', !ok('Origin Bancorp', SOUTHERN));
check('  ... nor S&T Bancorp', !ok('S&T Bancorp', SOUTHERN));

// The company that IS there must still resolve, or the fix is just a ban.
check('the company that really is there still matches',
    ok('Southern Bancorp', SOUTHERN));

// ── the fix must not become a blanket ban on sector words ───────────────────
check('a sector word still counts when the distinctive token agrees',
    ok('Bank of America', 'Bank of America Corporate Center'));
check('a name made only of sector words still matches its own office',
    ok('Technology Solutions', 'Technology Solutions Ltd'));
check('and a distinctive token alone still carries a match',
    ok('Schneider', 'Schneider Electric France'));

// ── the other clusters the measurement found ────────────────────────────────
check('an exchange building does not absorb its listings',
    !ok('LandBridge', 'New York Stock Exchange'));
check('  ... nor LXP Industrial Trust', !ok('LXP Industrial Trust', 'New York Stock Exchange'));
check('a shared legal-form suffix is not a match',
    !ok('Nynomic AG', 'Siemens AG - Corporate Headquarters'));
check('a shared prefix of a different word is not a match',
    !ok('Veritone', 'Verizon Corporate Headquarters'));

// ── the behaviours the earlier fixes bought, still intact ───────────────────
check('diacritics still fold', ok('América Móvil', 'America Movil'));
check('concatenation still matches', ok('Exxon Mobil', 'ExxonMobil Corporation'));
check('an all-stopword name still has something to compare',
    ok('S&P Global', 'S&P Global Inc'));

// The weighting is a ratio, so it has to stay in range whatever it is fed.
for (const [a, b] of [['', ''], ['Bancorp', ''], ['', 'Southern Bancorp'], ['Bancorp', 'Bancorp']]) {
    const s = score(a, b);
    if (!(s >= 0 && s <= 1)) { check(`score stays in [0,1] for ${JSON.stringify([a, b])}`, false); break; }
}
check('the score stays a ratio in [0,1] for empty and degenerate names', true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
