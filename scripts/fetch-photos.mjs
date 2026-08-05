#!/usr/bin/env node
/* =========================================================================
   Download a photograph of every company's head office, once.

   THIS SPENDS REAL MONEY. Each photo is TWO billed Google requests — a Place
   Details call to get the photo reference, then the media call for the bytes —
   so the full sweep is roughly $258 and about 840 MB. Everything below exists
   to make that spend safe and to make it happen exactly once.

   KEYED BY PLACE ID, NOT BY COMPANY, and that is a real saving rather than a
   detail: 10,969 resolved companies share 10,7xx distinct buildings, because
   conglomerates genuinely sit together — the six Hanwha entities in Seoul are
   one office and one photograph. Fetching per company would buy the same
   picture six times.

     - RESUMABLE. Every photo lands on disk under its place ID as it arrives.
       Interrupt it and rerun it and it skips what it already has. A crash at
       photo 9,000 does not re-buy 9,000 photos.
     - BUDGETED. `--max-photos` is checked before each fetch and is a hard
       stop. Default 50, not "all", because the expensive default is the one
       that gets run by accident.
     - MISSES ARE CACHED TOO. A building with no photo has no photo tomorrow
       either. Without recording that, every rerun re-buys every failure.
     - LIVE COST. Spend so far is printed as it goes, in dollars, so stopping
       is an informed decision rather than a guess.

   WHY IT WRITES WHERE THE APP READS. `companiesMarketCap.companyPhoto` caches
   to `<userData>/company-photos/<placeId>.json`. This writes the identical
   shape to the identical place, so a swept machine simply never has a cache
   miss — there is no second store to keep in sync, and no import step.

   Usage:
     node scripts/fetch-photos.mjs --status              # spend nothing
     node scripts/fetch-photos.mjs --max-photos 50       # ~$1.20
     node scripts/fetch-photos.mjs --all                 # every building
     node scripts/fetch-photos.mjs --top 500             # richest 500 only
   ========================================================================= */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'package.json'));

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const val = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : (Number(argv[i + 1]) || d); };

/* Two billed requests per photo. Only used to print an estimate — the real
   number is on the billing console and this is a guide, not a claim. */
const USD_PER_PHOTO = 0.024;
const MAX_WIDTH_PX = 800;
const CONCURRENCY = Math.max(1, Math.min(12, val('concurrency', 6)));

/* Load .env the way the app does, so this script needs no extra wiring. */
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const googleMaps = require(path.join(ROOT, 'googleMaps.js'));

/* The app's own cache directory, so a sweep here IS the app's cache. */
const userData = process.env.APPDATA
    ? path.join(process.env.APPDATA, 'jarvis')
    : path.join(process.env.HOME || ROOT, '.config', 'jarvis');
const PHOTO_DIR = path.join(userData, 'company-photos');
fs.mkdirSync(PHOTO_DIR, { recursive: true });

const cachePath = (placeId) =>
    path.join(PHOTO_DIR, `${String(placeId).replace(/[^A-Za-z0-9_-]/g, '_')}.json`);

// ── what to fetch ───────────────────────────────────────────────────────────

const hq = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'companies-hq.json'), 'utf8'));
const ranking = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'companies-ranking.json'), 'utf8'));
const rankOf = new Map(ranking.companies.filter((c) => c.ticker).map((c) => [c.ticker, c.rank ?? 1e9]));

/* One entry per BUILDING, carrying the best rank of any company in it so
   `--top` means "the buildings the most valuable companies work in". */
const buildings = new Map();
for (const [ticker, r] of Object.entries(hq.results)) {
    if (r.status !== 'ok' || !r.placeId) continue;
    const rank = rankOf.get(ticker) ?? 1e9;
    const prev = buildings.get(r.placeId);
    if (!prev || rank < prev.rank) {
        buildings.set(r.placeId, { placeId: r.placeId, rank, name: r.matchedName, tickers: prev?.tickers || [] });
    }
    buildings.get(r.placeId).tickers.push(ticker);
}

let queue = [...buildings.values()].sort((a, b) => a.rank - b.rank);
const top = val('top', 0);
if (top > 0) queue = queue.slice(0, top);

const already = queue.filter((b) => fs.existsSync(cachePath(b.placeId))).length;
const todo = queue.filter((b) => !fs.existsSync(cachePath(b.placeId)));

const budget = flag('all') ? todo.length : val('max-photos', 50);

console.log(`buildings        ${buildings.size} (from ${Object.keys(hq.results).length} companies)`);
console.log(`in scope         ${queue.length}${top ? ` (--top ${top})` : ''}`);
console.log(`already on disk  ${already}`);
console.log(`to fetch         ${todo.length}`);
console.log(`budget           ${Math.min(budget, todo.length)} ≈ $${(Math.min(budget, todo.length) * USD_PER_PHOTO).toFixed(2)}`);
console.log(`cache            ${PHOTO_DIR}`);

if (flag('status')) process.exit(0);
if (!process.env.GOOGLE_MAPS_API_KEY) {
    console.error('\nGOOGLE_MAPS_API_KEY is not set — nothing to do.');
    process.exit(1);
}

// ── the sweep ───────────────────────────────────────────────────────────────

let fetched = 0, missing = 0, failed = 0, throttled = 0, spent = 0, stop = null;
let cursor = 0;
const started = Date.now();

/* A PER-MINUTE CAP IS NOT A DEAD END, and the first version of this script
   treated it as one. It ran at 8 concurrent, hit ~9.9 photos/s — two billed
   requests each, so ~1,200 requests a minute — and Places answered
   RESOURCE_EXHAUSTED for 'GetPlaceRequest per minute'. The stop guard matched
   the word "quota", declared an account limit and gave up 1,224 buildings in,
   which is exactly the sort of "the crawl died overnight" that a resumable
   script exists to avoid.

   The two failures look alike in the text and are opposite in kind. A per-MINUTE
   cap clears in sixty seconds and wants a pause. Billing off, a revoked key or a
   per-DAY cap does not clear by waiting, and retrying it is how one dead request
   becomes ten thousand. So the transient one is matched first and specifically,
   and only what is left is allowed to stop the run. */
const isPerMinute = (t) => /per minute|rate limit|RESOURCE_EXHAUSTED/i.test(t) && !/per day|daily/i.test(t);
const isFatal = (t) => /billing|denied|expired|invalid.*key|API key not valid|per day|daily/i.test(t);

/* Requests per minute, spread evenly rather than burst-then-block: a token
   bucket that refuses to hand out more than the budget in any rolling minute.
   Two billed requests per photo, so the photo rate is half this. */
const RPM = Math.max(60, val('rpm', 500));
let windowStart = Date.now(), issued = 0;
async function ration(cost = 2) {
    for (;;) {
        const now = Date.now();
        if (now - windowStart >= 60000) { windowStart = now; issued = 0; }
        if (issued + cost <= RPM) { issued += cost; return; }
        await new Promise((r) => setTimeout(r, 60000 - (now - windowStart) + 250));
    }
}

async function one(b, attempt = 1) {
    await ration();
    const res = await googleMaps.placePhotoForCompany({ placeId: b.placeId, maxWidthPx: MAX_WIDTH_PX })
        .catch((e) => ({ ok: false, reason: 'threw', detail: e.message }));

    if (!res.ok) {
        const text = `${res.reason} ${res.detail || ''}`;
        if (isPerMinute(text) && !isFatal(text)) {
            /* Backing off past the end of the current minute window, because
               the counter Google is enforcing resets on ITS clock, not ours. */
            if (attempt <= 4) {
                await new Promise((r) => setTimeout(r, 15000 * attempt));
                return one(b, attempt + 1);
            }
            throttled++;
            return;                       // leave it for the next run to pick up
        }
        if (isFatal(text)) {
            stop = `${res.reason}: ${String(res.detail || '').slice(0, 160)}`;
            return;
        }
    }

    spent += USD_PER_PHOTO;
    if (res.ok) {
        /* `found: false` is a real, paid-for answer — the building has no
           photo, or its photo carried no attribution and Google's terms make
           it unusable. Cached exactly as the app's own path caches it, so the
           second ask is free. */
        fs.writeFileSync(cachePath(b.placeId), JSON.stringify(res.data));
        if (res.data?.found) fetched++; else missing++;
    } else {
        /* A TIMEOUT IS NOT AN ANSWER. Caching misses is right — a building with
           no photo has none tomorrow either, and re-asking costs a Details call
           every run. But that reasoning only holds for a verdict Google
           actually gave. A timeout, a dropped connection or a 429 is the
           network failing to deliver a verdict, and writing it to the cache
           makes a transient blip permanent: the building is never retried and
           shows no photo forever.

           The first full sweep did exactly that to 38 buildings — 36 timeouts
           and 2 rate-limited — which the post-run audit caught by reading the
           reasons back out of the cache. They are simply left unwritten now, so
           the next run picks them up. */
        if (/timeout|network|threw|429|5\d\d/i.test(res.reason || '')) {
            failed++;
            return;
        }
        fs.writeFileSync(cachePath(b.placeId),
            JSON.stringify({ found: false, reason: res.reason || 'no-photo' }));
        missing++;
    }
}

async function worker() {
    while (!stop) {
        const i = cursor++;
        if (i >= todo.length || i >= budget) return;
        const b = todo[i];
        try { await one(b); } catch { failed++; }
        const done = fetched + missing + failed;
        if (done % 100 === 0 && done) {
            const rate = done / ((Date.now() - started) / 1000);
            const left = Math.min(budget, todo.length) - done;
            console.log(`   ${done}/${Math.min(budget, todo.length)}  got ${fetched}  none ${missing}  err ${failed}` +
                `  |  $${spent.toFixed(2)}  |  ${rate.toFixed(1)}/s  |  eta ${Math.round(left / Math.max(rate, 0.01) / 60)}m`);
        }
    }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));

console.log('\n==============================================================');
if (stop) {
    console.log(`STOPPED — this is an account limit, not a data problem:\n  ${stop}`);
}
console.log(`photographed  ${fetched}`);
console.log(`no photo      ${missing}  (recorded, so they are not re-bought)`);
console.log(`errors        ${failed}`);
if (throttled) console.log(`rate-limited  ${throttled}  (left for the next run — rerun to pick them up)`);
console.log(`spent         ≈ $${spent.toFixed(2)}`);

let bytes = 0;
for (const f of fs.readdirSync(PHOTO_DIR)) bytes += fs.statSync(path.join(PHOTO_DIR, f)).size;
console.log(`cache on disk ${(bytes / 1024 / 1024).toFixed(1)} MB in ${PHOTO_DIR}`);
