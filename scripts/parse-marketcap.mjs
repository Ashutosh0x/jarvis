#!/usr/bin/env node
/* =========================================================================
   Turn a dumped CompaniesMarketCap listing page into {name, ticker, country}.

   WHY A PARSER RATHER THAN A HAND-TYPED TABLE. Eleven thousand rows retyped by
   hand is eleven thousand chances to put a company in the wrong country, and a
   wrong country here does not fail loudly — it silently pins a business to the
   wrong continent. Parsing the dump keeps the data exactly as the source had
   it, and anything that does not parse is REPORTED rather than guessed at.

   Usage:
     node scripts/parse-marketcap.mjs page.txt > companies.json
     node scripts/parse-marketcap.mjs page.txt --limit 500

   Where page.txt is the visible text of the listing page (select all, paste).
   The shape it looks for, per company:

       <name>            <- repeated once above, ignored
       <TICKER>
       ₹2.130 T    ₹63.92    0.21%         Indonesia

   The money line is the anchor because it is the only one with a fixed shape;
   the ticker is the non-empty line above it and the name the one above that.
   Currency symbol and unit are not assumed to be rupees or trillions — the
   page renders whatever the user picked, so both are matched loosely.
   ========================================================================= */

import fs from 'node:fs';

const [, , file, ...rest] = process.argv;
if (!file) {
    console.error('usage: parse-marketcap.mjs <dump.txt> [--limit N]');
    process.exit(2);
}
const limitArg = rest.indexOf('--limit');
const limit = limitArg === -1 ? 0 : Number(rest[limitArg + 1]) || 0;

const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim());

/* "₹2.130 T    ₹63.92    0.21%         Indonesia" — cap, price, change, country.
   The country is everything after the percentage, trimmed of the flag glyphs
   and non-breaking spaces the page puts in front of it. */
const MONEY = /^[^\d\s]*\s*([\d.,]+)\s*([TBM])\s+[^\d\s]*\s*([\d.,]+)\s+([\d.]+)%\s+(.+)$/;
/* Tickers are upper-case with an optional exchange suffix: STLA, GRASIM.NS,
   600660.SS, PE&OLES.MX, BF-A, 2002A.TW. */
const TICKER = /^[A-Z0-9][A-Z0-9&.\-]{0,14}$/;

const out = [];
const skipped = [];
const seen = new Set();

for (let i = 0; i < lines.length; i++) {
    const m = MONEY.exec(lines[i]);
    if (!m) continue;

    const country = m[5].replace(/[ ​]/g, ' ').replace(/[^\p{L}\p{Zs}.'-]/gu, '').trim();
    if (!country) { skipped.push({ line: i + 1, why: 'no country', text: lines[i] }); continue; }

    /* Walk back over blank lines to the ticker, then again to the name. */
    let j = i - 1;
    while (j >= 0 && !lines[j]) j--;
    const ticker = lines[j] || '';
    if (!TICKER.test(ticker)) { skipped.push({ line: i + 1, why: `no ticker (saw "${ticker}")`, text: lines[i] }); continue; }

    let k = j - 1;
    while (k >= 0 && (!lines[k] || lines[k] === 'logo')) k--;
    /* The listing prints the name twice, the second time immediately above the
       ticker, sometimes with a trailing " logo". */
    const name = (lines[k] || '').replace(/\s*logo\s*$/i, '').trim();
    if (!name || /^favorite icon/i.test(name)) {
        skipped.push({ line: i + 1, why: 'no name', text: lines[i] });
        continue;
    }

    /* The dump repeats whole pages when someone scrolls and re-copies. */
    const key = `${ticker}|${name}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
        name, ticker, country,
        marketCap: `${m[1]} ${m[2]}`
    });
    if (limit && out.length >= limit) break;
}

process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
console.error(`parsed ${out.length} companies, ${skipped.length} rows skipped`);
for (const s of skipped.slice(0, 10)) console.error(`  line ${s.line}: ${s.why} — ${s.text.slice(0, 70)}`);
if (skipped.length > 10) console.error(`  ...and ${skipped.length - 10} more`);
