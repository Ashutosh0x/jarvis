#!/usr/bin/env node
/* =========================================================================
   Resolve an ARBITRARY named list of companies to head-office coordinates.

   `resolve-hq.mjs` does this for the 11,222-company market-cap ranking, keyed
   by ticker. This does it for a hand-supplied list — HFT firms, the blockchain
   and RegTech names from a research document, Hong Kong VATPs — none of which
   carry tickers and most of which are private, so none of them appear in the
   ranking at all. Checked: neither "Citadel" nor "Jane Street" nor "Joho
   Technology" is in the crawled database.

   IT REUSES THE RANKING RESOLVER'S VALIDATION RATHER THAN INVENTING ITS OWN.
   The country check and the name check are sliced out of `resolve-hq.mjs` at
   run time, so the rule that stopped twenty unrelated banks sharing one
   address in Little Rock applies here unchanged. Two checks must pass:

     1. COUNTRY — the ISO country Google returns must equal the hint.
     2. NAME — the matched place must share a DISTINCTIVE token with the
        company. Sector words ("securities", "trading", "capital", "bank")
        count for a quarter, which matters enormously in this list: it is full
        of firms called "<word> Trading" and "<word> Capital".

   A hit failing either is recorded as REJECTED WITH ITS REASON, never pinned.

   WHY THE COUNTRY HINT IS LOAD-BEARING HERE. Measured on the live API: a bare
   "Citadel" is location-biased to the caller's own region and came back with
   eight Bengaluru apartments and hotels. The hint is appended to the query AND
   used to verify the answer.

     - RESUMABLE. Written to disk as each lands; rerun skips what it has.
     - BUDGETED. `--max-lookups` is a hard stop, default 25.
     - LIVE COST printed as it goes.

   Usage:
     node scripts/resolve-named.mjs --status
     node scripts/resolve-named.mjs --max-lookups 25      # ~$0.80
     node scripts/resolve-named.mjs --all                 # whole list
     node scripts/resolve-named.mjs --only hft            # one category
   ========================================================================= */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'package.json'));

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const val = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : (argv[i + 1] ?? d); };

const USD_PER_LOOKUP = 0.032;
const SOURCE = path.join(ROOT, 'data', 'named-companies.source.json');
const OUT = path.join(ROOT, 'data', 'named-companies.json');

for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const googleMaps = require(path.join(ROOT, 'googleMaps.js'));
const { regionCodeFor } = await import(
    `file:///${ROOT.replace(/\\/g, '/')}/src/js/services/googleServices.js`
);

/* The ranking resolver's validation half, loaded without its crawler half. */
const src = fs.readFileSync(path.join(ROOT, 'scripts', 'resolve-hq.mjs'), 'utf8');
const a = src.indexOf('/* ------------------------------------------------------------ validation -- */');
const b = src.indexOf('/* ------------------------------------------------------------- resolution -- */');
const tmp = path.join(ROOT, '.tmp-named-validate.mjs');
fs.writeFileSync(tmp, `${src.slice(a, b)}\nexport { nameAgrees, CORPORATE_TYPES };\n`);
let nameAgrees, CORPORATE_TYPES;
try {
    ({ nameAgrees, CORPORATE_TYPES } = await import(`file:///${tmp.replace(/\\/g, '/')}`));
} finally {
    fs.rmSync(tmp, { force: true });
}

// ── state ───────────────────────────────────────────────────────────────────

const source = JSON.parse(fs.readFileSync(SOURCE, 'utf8'));
let store = { updatedAt: null, lookups: 0, results: {} };
if (fs.existsSync(OUT)) {
    try { store = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch { /* start fresh */ }
}

const only = val('only', null);
let queue = source.companies.filter((c) => !only || c.category === only);
const todo = queue.filter((c) => !store.results[c.name]);
const budget = flag('all') ? todo.length : Number(val('max-lookups', 25)) || 25;

console.log(`list         ${source.companies.length}${only ? ` (--only ${only} -> ${queue.length})` : ''}`);
console.log(`already done ${queue.length - todo.length}`);
console.log(`to resolve   ${todo.length}`);
console.log(`budget       ${Math.min(budget, todo.length)} ≈ $${(Math.min(budget, todo.length) * USD_PER_LOOKUP).toFixed(2)}`);

if (flag('status')) {
    const ok = Object.values(store.results).filter((r) => r.status === 'ok').length;
    const rej = Object.values(store.results).length - ok;
    console.log(`\nresolved ${ok} · rejected ${rej} · lookups ${store.lookups} ≈ $${(store.lookups * USD_PER_LOOKUP).toFixed(2)}`);
    process.exit(0);
}
if (!process.env.GOOGLE_MAPS_API_KEY) { console.error('\nGOOGLE_MAPS_API_KEY is not set.'); process.exit(1); }

const persist = () => {
    store.updatedAt = new Date().toISOString();
    fs.writeFileSync(OUT, JSON.stringify(store, null, 1));
};

// ── resolve ─────────────────────────────────────────────────────────────────

let spent = 0, okCount = 0, rejCount = 0, stop = null;

async function resolveOne(entry) {
    const want = regionCodeFor(entry.country);
    /* Two query shapes, precise first — the same order the ranking resolver
       uses. "corporate headquarters" pins an office rather than a branch; the
       bare form recovers names Google indexes without that phrasing. */
    /* `query` overrides what is SEARCHED without changing what is VERIFIED.
       Three names in this list are ordinary English and collided with unrelated
       businesses that passed both checks: "Trail of Bits" matched "Bowman Bits
       USA" in Millersburg, Ohio; "Circle Internet Financial" matched "Full
       Circle Financial Services" in Tampa; "Halborn" matched "HAL, Inc." in
       Houston. All three are real companies at real addresses, and all three
       are the wrong one — the exact failure the ranking crawl hit with
       "Bancorp", in a list too small to catch it statistically.

       A city in the query is the cheapest disambiguator there is. The name
       check still runs against the ORIGINAL name, so a sharper query is
       allowed to find more candidates and is not allowed to lower the bar they
       clear. */
    const searchName = entry.query || entry.name;
    for (const bare of [false, true]) {
        const res = await googleMaps.invoke('placesCompanyHQ', {
            name: searchName, country: entry.country, regionCode: want, bare
        });
        store.lookups++; spent += USD_PER_LOOKUP;

        if (!res.ok) {
            const text = `${res.reason} ${res.detail || ''}`;
            if (/billing|denied|expired|invalid.*key|per day|daily/i.test(text)) { stop = text.slice(0, 160); return null; }
            continue;
        }
        const candidates = res.data?.candidates || [];
        const tried = [];
        for (const c of candidates) {
            const countryOk = !want || c.countryCode === want;
            const nm = nameAgrees(entry.name, c.matchedName);
            tried.push({ matched: c.matchedName, cc: c.countryCode, countryOk, nameScore: nm.score });
            if (!countryOk || !nm.ok) continue;
            return {
                status: 'ok',
                name: entry.name, category: entry.category,
                lat: c.lat, lng: c.lng,
                matchedName: c.matchedName, address: c.address,
                countryCode: c.countryCode, placeId: c.id || null,
                nameScore: nm.score,
                confidence: nm.score >= 0.9 ? 'high' : nm.score >= 0.6 ? 'medium' : 'low',
                precision: 'building', source: 'google-places'
            };
        }
        if (bare) {
            return {
                status: 'rejected',
                name: entry.name, category: entry.category,
                reason: candidates.length ? 'no-candidate-passed' : 'no-candidates',
                tried: tried.slice(0, 4)
            };
        }
    }
    return { status: 'rejected', name: entry.name, category: entry.category, reason: 'no-candidates' };
}

let done = 0;
for (const entry of todo) {
    if (stop || done >= budget) break;
    const r = await resolveOne(entry);
    if (stop) break;
    if (!r) continue;
    store.results[entry.name] = r;
    r.status === 'ok' ? okCount++ : rejCount++;
    done++;
    const mark = r.status === 'ok' ? 'OK ' : '-- ';
    console.log(`  ${mark}${entry.name.padEnd(34)} ${r.status === 'ok'
        ? `${r.lat.toFixed(4)},${r.lng.toFixed(4)}  ${(r.matchedName || '').slice(0, 34)}`
        : r.reason}`);
    if (done % 10 === 0) persist();
}
persist();

console.log('\n==============================================================');
if (stop) console.log(`STOPPED — account limit, not a data problem:\n  ${stop}`);
const all = Object.values(store.results);
console.log(`resolved   ${all.filter((r) => r.status === 'ok').length} / ${all.length}`);
console.log(`rejected   ${all.filter((r) => r.status !== 'ok').length}`);
console.log(`spent      ≈ $${spent.toFixed(2)} this run · ${store.lookups} lookups total ≈ $${(store.lookups * USD_PER_LOOKUP).toFixed(2)}`);
console.log(`written to ${path.relative(ROOT, OUT)}`);
