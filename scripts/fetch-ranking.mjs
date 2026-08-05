#!/usr/bin/env node
/* =========================================================================
   Crawl the full CompaniesMarketCap ranking into a local database.

   THERE IS NO "GET EVERYTHING" CALL. `get_ranking` returns 100 companies per
   page, so 11,222 companies is 113 requests and 113 credits. This script is
   what makes spending them safe:

     - RESUMABLE. Every page is written as it arrives. Interrupt it, rerun it,
       and it picks up at the first page it does not already have. A crash at
       page 90 does not cost you 90 credits twice.
     - BUDGETED. `--max-credits` is a hard stop, checked before each request,
       so it cannot overshoot. Default 20, not unlimited, because the
       expensive default is the one that gets run by accident.
     - HONEST ON FAILURE. A page that fails is recorded and retried once; if
       it still fails the crawl stops rather than silently leaving a hole in
       the middle of the ranking and calling it complete.

   Usage:
     node scripts/fetch-ranking.mjs --pages 3                 # 3 credits
     node scripts/fetch-ranking.mjs --all --max-credits 120   # full ranking
     node scripts/fetch-ranking.mjs --status                  # spend nothing

   Output: data/companies-ranking.json
     { fetchedAt, pages: {1: [...], ...}, companies: [...], creditsSpent }
   ========================================================================= */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'companies-ranking.json');

/* THE SCRAPER ID IS NOT A CONSTANT, because it is not a property of the API —
   it is a property of the ACCOUNT that forked it. A key from a different
   parse.bot account gets `404 Scraper with ID … not found` against someone
   else's fork, which reads like a missing page and is actually a missing
   permission. Overridable so a new fork needs no code change:

     PARSE_SCRAPER_ID=<uuid>            in .env, or
     --scraper <uuid-or-full-url>       on the command line
*/
const DEFAULT_SCRAPER = 'b9f76412-d8f2-4b41-b0ac-663645e3b633';

/* Load .env the same way the app does, so this works from a plain shell. */
for (const line of fs.existsSync(path.join(ROOT, '.env'))
    ? fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/) : []) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
}

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const val = (n, d) => {
    const i = argv.indexOf(`--${n}`);
    return i === -1 ? d : (Number(argv[i + 1]) || d);
};

const maxCredits = val('max-credits', 20);
const wantPages = flag('all') ? 200 : val('pages', 1);

/* Accepts a bare UUID or the whole cURL URL, because the dashboard gives you
   the URL and retyping just the UUID out of it is a needless chance to fumble. */
const scraperArg = (() => {
    const i = argv.indexOf('--scraper');
    return i === -1 ? null : argv[i + 1];
})();
const SCRAPER_ID = (() => {
    const raw = scraperArg || process.env.PARSE_SCRAPER_ID || DEFAULT_SCRAPER;
    const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(String(raw));
    return m ? m[1] : String(raw).trim();
})();
const BASE = `https://api.parse.bot/scraper/${SCRAPER_ID}`;

function load() {
    try { return JSON.parse(fs.readFileSync(OUT, 'utf8')); }
    catch { return { fetchedAt: null, pages: {}, creditsSpent: 0 }; }
}
function save(db) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    /* Flatten for convenience, but keep the per-page record — that is what
       makes the resume correct rather than approximate. */
    const companies = Object.keys(db.pages)
        .map(Number).sort((a, b) => a - b)
        .flatMap((p) => db.pages[p]);
    fs.writeFileSync(OUT, `${JSON.stringify({ ...db, companies, total: companies.length }, null, 1)}\n`);
}

const db = load();
const have = Object.keys(db.pages).map(Number).sort((a, b) => a - b);

if (flag('status')) {
    const companies = have.flatMap((p) => db.pages[p]);
    console.log(`pages held: ${have.length}${have.length ? ` (${have[0]}-${have[have.length - 1]})` : ''}`);
    console.log(`companies:  ${companies.length}`);
    console.log(`credits spent so far: ${db.creditsSpent}`);
    console.log(`countries:  ${new Set(companies.map((c) => c.country).filter(Boolean)).size}`);
    console.log(`last fetch: ${db.fetchedAt || 'never'}`);
    process.exit(0);
}

const KEY = process.env.PARSE_API_KEY;
if (!KEY) {
    console.error('PARSE_API_KEY is not set. Add it to .env — nothing was requested, no credits spent.');
    process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* THE PUBLISHED LIMIT, LEARNED THE EXPENSIVE WAY. The first full run got 41
   pages before the API answered 429: "bucket of 30, refilling at 5/min". So
   the first thirty requests may go straight out and everything after that has
   to be paced at one per twelve seconds. Pacing in the client is what turns a
   113-page crawl from a burst that fails at page 42 into one that finishes. */
const BURST = 30;
const SUSTAINED_MS = 12000;
let sent = 0;

async function paced() {
    sent++;
    if (sent > BURST) await sleep(SUSTAINED_MS);
}

async function fetchPage(page, attempt = 1) {
    await paced();
    const res = await fetch(`${BASE}/get_ranking?page=${page}`, {
        headers: { 'X-API-Key': KEY, Accept: 'application/json' },
        signal: AbortSignal.timeout(90000)
    });
    const text = await res.text();

    if (res.status === 429) {
        let err = null;
        try { err = JSON.parse(text)?.error; } catch { /* fall through to defaults */ }

        /* TWO DIFFERENT 429s, AND ONLY ONE IS WORTH WAITING FOR.
           The burst limit (30, refilling 5/min) clears in seconds. The DAILY
           cap — 100 requests, `x-ratelimit-daily-remaining: 0` — clears in up
           to 24 hours, and the first version of this code cheerfully went to
           sleep for 18.9 hours because it treated both the same. A crawler
           that hangs overnight looks identical to one that has crashed.
           A daily stop is reported and exits; the work already paid for is
           on disk and `--all` resumes exactly where it left off. */
        const daily = err?.limit_type === 'daily'
            || res.headers.get('x-ratelimit-daily-remaining') === '0';
        const retryAfter = Number(err?.retry_after || res.headers.get('retry-after') || 5);
        if (daily || retryAfter > 300) {
            const hrs = (retryAfter / 3600).toFixed(1);
            const cap = res.headers.get('x-ratelimit-daily-limit');
            throw new Error(
                `DAILY LIMIT REACHED${cap ? ` (${cap} requests/day)` : ''} — resets in ${hrs}h. `
                + 'Everything fetched so far is saved; rerun with --all to resume then.'
            );
        }

        const wait = retryAfter * 1000 + 3000;
        if (attempt > 6) throw new Error(`rate limited ${attempt}x on page ${page}, giving up`);
        console.log(`  page ${page}: burst limit, waiting ${Math.round(wait / 1000)}s (attempt ${attempt})`);
        await sleep(wait);
        return fetchPage(page, attempt + 1);
    }
    if (res.status === 404 && /scraper with id/i.test(text)) {
        /* A key that authenticates but cannot see the scraper. The quota header
           still decrements, so this is NOT a bad key — it is a key belonging to
           a different parse.bot account than the one that owns this fork.
           Named explicitly because "404" on a paginated endpoint reads as "no
           such page" and sends you looking for the end of the data. */
        throw new Error(
            `SCRAPER NOT VISIBLE TO THIS KEY (${SCRAPER_ID}).\n`
            + '  The key is valid but belongs to a different parse.bot account than the fork.\n'
            + '  Fix: fork the API on THIS account, then rerun with --scraper <new-id>.'
        );
    }
    if (!res.ok) {
        const why = res.status === 402 ? 'OUT OF CREDITS'
            : res.status === 401 || res.status === 403 ? 'BAD KEY' : `HTTP ${res.status}`;
        throw new Error(`${why}: ${text.slice(0, 200)}`);
    }
    return JSON.parse(text);
}

let spent = 0;
console.log(`target ${wantPages} page(s), budget ${maxCredits} credits, ${have.length} already held\n`);

for (let page = 1; page <= wantPages; page++) {
    if (db.pages[page]) { console.log(`page ${String(page).padStart(3)}  cached (0 credits)`); continue; }
    if (spent >= maxCredits) { console.log(`\nbudget of ${maxCredits} credits reached — stopping cleanly.`); break; }

    let json;
    try {
        json = await fetchPage(page);
        spent++;
    } catch (e) {
        console.error(`page ${page} failed: ${e.message}`);
        if (/OUT OF CREDITS|BAD KEY/.test(e.message)) break;
        try { json = await fetchPage(page); spent++; console.error('  retry OK'); }
        catch (e2) { console.error(`  retry failed: ${e2.message}\nstopping so the database does not get a hole in it.`); break; }
    }

    /* THE ENVELOPE IS NOT WHAT THE DOCS DESCRIBE. They document the inner
       object — `{page, companies, total_results}` — but the wire format wraps
       it: `{status, data: {…}}`. Both are read so a future fix upstream does
       not break this, and so the first live call was the thing that settled
       it rather than the prose. */
    const payload = json?.data ?? json;
    const rows = payload?.companies || [];
    if (!rows.length) { console.log(`page ${page} empty — end of ranking.`); break; }

    db.pages[page] = rows.map((c) => ({
        rank: Number(c.rank) || null,
        name: c.name ?? null,
        ticker: c.ticker ?? c.identifier ?? null,
        country: c.country ?? null,
        /* market_cap.raw_value is already in dollars; price and today_change
           are scaled by 100 (21194 = $211.94, 256 = 2.56%). Keeping both the
           number and the formatted string: the number is for sorting and
           sizing, the string is what a label should show, and deriving one
           from the other means guessing a locale. */
        marketCap: c.market_cap?.raw_value ?? null,
        marketCapText: c.market_cap?.formatted ?? null,
        price: Number.isFinite(c.price?.raw_value) ? c.price.raw_value / 100 : null,
        priceText: c.price?.formatted ?? null,
        todayChangePct: Number.isFinite(c.today_change?.raw_value) ? c.today_change.raw_value / 100 : null,
        todayChangeText: c.today_change?.formatted ?? null
    })).filter((c) => c.name);

    db.creditsSpent = (db.creditsSpent || 0) + 1;
    db.fetchedAt = new Date().toISOString();
    save(db);            // after EVERY page: a credit paid is a credit kept
    console.log(`page ${String(page).padStart(3)}  +${db.pages[page].length} companies  (${spent} credits this run)`);

    if (rows.length < 100) { console.log('short page — end of ranking.'); break; }
}

const all = Object.keys(db.pages).map(Number).sort((a, b) => a - b).flatMap((p) => db.pages[p]);
console.log(`\ncompanies: ${all.length} | countries: ${new Set(all.map((c) => c.country).filter(Boolean)).size}`);
console.log(`credits this run: ${spent} | lifetime: ${db.creditsSpent}`);
console.log(`written to ${path.relative(ROOT, OUT)}`);
