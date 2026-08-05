#!/usr/bin/env node
/* =========================================================================
   RE-CHECK the head offices that share a place ID, against the stricter name
   rule — WITHOUT SPENDING A CREDIT.

   `validate-crawl.mjs` found 390 companies sitting on 167 shared place IDs,
   and the worst cluster was twenty unrelated bank holding companies pinned to
   one office in Little Rock because they all contain the word "Bancorp".

   The fix to `nameMatch` (sector words can no longer be the sole evidence)
   changes which of those rows are admissible. This re-runs the NEW rule over
   the STORED `matchedName` of each affected row, so the set that actually
   needs re-buying is known before any money is spent. Every row that still
   passes is left alone — re-resolving a correct answer is pure waste.

   Writes nothing. Print only.

   Usage:  node scripts/recheck-shared-hq.mjs [--all] [--json]
     --all   re-check every resolved row, not just the shared ones
     --json  emit the refetch list as JSON for the resolver to consume
   ========================================================================= */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALL = process.argv.includes('--all');
const AS_JSON = process.argv.includes('--json');

/* The validation half of resolve-hq.mjs, loaded without its crawler half so
   nothing can issue a request. Sliced rather than imported because the file is
   a script with top-level side effects, and exporting from it would mean
   restructuring a module that is working. */
const src = fs.readFileSync(path.join(ROOT, 'scripts', 'resolve-hq.mjs'), 'utf8');
const start = src.indexOf('/* ------------------------------------------------------------ validation -- */');
const end = src.indexOf('/* ------------------------------------------------------------- resolution -- */');
if (start === -1 || end === -1) {
    console.error('could not locate the validation block in resolve-hq.mjs');
    process.exit(1);
}
const tmp = path.join(ROOT, '.tmp-namecheck.mjs');
fs.writeFileSync(tmp, `${src.slice(start, end)}\nexport { nameAgrees };\n`);
let nameMatch;
try {
    ({ nameAgrees: nameMatch } = await import(`file:///${tmp.replace(/\\/g, '/')}`));
} finally {
    fs.rmSync(tmp, { force: true });
}

const hq = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'companies-hq.json'), 'utf8'));
const ranking = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'companies-ranking.json'), 'utf8'));
const nameOf = new Map(ranking.companies.filter((c) => c.ticker).map((c) => [c.ticker, c.name]));

const resolved = Object.entries(hq.results).filter(([, r]) => r.status === 'ok' && r.placeId);

const byPlace = new Map();
for (const [t, r] of resolved) {
    if (!byPlace.has(r.placeId)) byPlace.set(r.placeId, []);
    byPlace.get(r.placeId).push(t);
}
const sharedIds = [...byPlace.entries()].filter(([, ts]) => ts.length > 1);
const target = ALL ? resolved.map(([t]) => t) : sharedIds.flatMap(([, ts]) => ts);

/* NOT EVERY FAILING ROW IS A REGRESSION, and treating them alike would ask for
   $15 of re-resolution to fix $2 of actual error.

   `resolveOne` accepts a candidate three ways: on the name check, or — when the
   name check cannot be evidence — via the CROSS-SCRIPT fallback (a Latin
   company name can never share a token with a Chinese place name) or the
   CORPORATE-OFFICE fallback (Comcast's head office is signed "Xfinity"). Both
   fallbacks are deliberate, are recorded at LOW confidence, and store no
   `nameScore` precisely because no name match was claimed. Re-running the name
   rule over them and calling the result a failure would be scoring a test they
   were never sitting.

   So a row only needs re-buying when the name check is what ADMITTED it and the
   stricter rule now refuses — or when it leant on a fallback AND shares its
   building with other companies, which is the pattern that produced three
   unrelated firms at one NCR representative office in Shanghai. */
const keep = [];
const refetch = [];
const byDesign = [];
const sharedSet = new Set(sharedIds.flatMap(([, ts]) => ts));

for (const ticker of target) {
    const r = hq.results[ticker];
    const nm = nameMatch(nameOf.get(ticker) || '', r.matchedName || '');
    const row = {
        ticker,
        name: nameOf.get(ticker) || null,
        matched: r.matchedName || null,
        was: r.nameScore ?? null,
        now: nm.score,
        confidence: r.confidence,
        placeId: r.placeId
    };
    if (nm.ok) { keep.push(row); continue; }

    const admittedOnName = r.nameScore !== null && r.nameScore !== undefined;
    if (admittedOnName) { row.why = 'name-rule-tightened'; refetch.push(row); }
    else if (sharedSet.has(ticker)) { row.why = 'fallback-and-shares-a-building'; refetch.push(row); }
    else { row.why = 'accepted-by-fallback-as-designed'; byDesign.push(row); }
}

if (AS_JSON) {
    console.log(JSON.stringify({ refetch: refetch.map((r) => r.ticker) }, null, 2));
    process.exit(0);
}

console.log(`resolved rows            : ${resolved.length}`);
console.log(`place IDs shared by 2+   : ${sharedIds.length} (covering ${sharedIds.flatMap(([, t]) => t).length} companies)`);
console.log(`re-checked               : ${target.length}${ALL ? ' (--all)' : ''}`);
console.log('');
const onName = refetch.filter((r) => r.why === 'name-rule-tightened').length;
const onShared = refetch.length - onName;
console.log(`still valid              : ${keep.length}`);
console.log(`accepted by fallback,`);
console.log(`  left alone as designed : ${byDesign.length}`);
console.log(`NEED REFETCH             : ${refetch.length}`);
console.log(`  name rule tightened    : ${onName}`);
console.log(`  fallback + shared bldg : ${onShared}`);
console.log(`estimated refetch cost   : $${(refetch.length * 0.032).toFixed(2)}`);
console.log('');

/* Grouped by the place they were wrongly sharing, because that is the shape of
   the error — one popular building absorbing a family of similar names. */
const byWrongPlace = new Map();
for (const r of refetch) {
    if (!byWrongPlace.has(r.matched)) byWrongPlace.set(r.matched, []);
    byWrongPlace.get(r.matched).push(r);
}
const worst = [...byWrongPlace.entries()].sort((a, b) => b[1].length - a[1].length);

console.log('the buildings that were absorbing other companies:');
for (const [place, rows] of worst.slice(0, 12)) {
    console.log(`  ${String(rows.length).padStart(3)}  ${(place || '?').slice(0, 46)}`);
    for (const r of rows.slice(0, 4)) {
        console.log(`         ${(r.name || '').slice(0, 34).padEnd(36)} was ${r.was} -> now ${r.now}`);
    }
    if (rows.length > 4) console.log(`         ... and ${rows.length - 4} more`);
}

const conf = {};
for (const r of refetch) conf[r.confidence] = (conf[r.confidence] || 0) + 1;
console.log('');
console.log(`confidence of the rejected: ${JSON.stringify(conf)}`);
