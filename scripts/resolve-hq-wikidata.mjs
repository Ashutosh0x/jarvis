#!/usr/bin/env node
/* =========================================================================
   Last-resort locations for the companies Google Places cannot see.

   FREE. Wikidata has no API key and no per-query cost, so this pass is worth
   running for whatever it can add — unlike the Places retries, where each
   marginal company cost real money and precision fell with every round.

   IT IS CITY-LEVEL, AND THAT IS RECORDED. Wikidata's `headquarters location`
   (P159) points at a CITY, so its coordinate is a city centre, not a
   building. China Yangtze Power comes back at 116.407, 39.904 — the middle of
   Beijing, not its office. That is genuinely useful on a globe showing the
   whole planet and genuinely wrong if anyone reads it as an address, so every
   row written here carries `precision: 'city'` and `confidence: 'low'`. The
   Places results stay marked `building`. Nothing merges the two silently.

   WHY THIS IS NOT THE GEOCODING FALLBACK I REJECTED. The Geocoding API
   answered every unresolvable Chinese company with 35.862, 104.195 — the
   centroid of the whole country, the same point for all of them. That is not
   a location, it is a shrug rendered as coordinates. A city centre is a real
   place the company is actually in.

   COUNTRY IS STILL CHECKED. Wikidata knows the company's country too, so the
   same rule applies as everywhere else: a result in the wrong country is
   refused rather than recorded.

   Usage:  node scripts/resolve-hq-wikidata.mjs [--dry-run]
   ========================================================================= */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'companies-hq.json');
const ENDPOINT = 'https://query.wikidata.org/sparql';
const UA = 'JarvisGlobe/0.9 (company HQ backfill; https://github.com/Ashutosh0x/jarvis)';

const dryRun = process.argv.includes('--dry-run');

const store = JSON.parse(fs.readFileSync(OUT, 'utf8'));
const pending = Object.entries(store.results).filter(([, x]) => x.status !== 'ok');
console.log(`unresolved after the Places passes: ${pending.length}`);

/* ISO codes so a Wikidata hit can be country-checked like every other source. */
const { regionCodeFor } = await import(`file:///${ROOT.replace(/\\/g, '/')}/src/js/services/googleServices.js`);

async function sparql(query) {
    const res = await fetch(`${ENDPOINT}?query=${encodeURIComponent(query)}&format=json`, {
        headers: { Accept: 'application/sparql-results+json', 'User-Agent': UA },
        signal: AbortSignal.timeout(120000)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
}

/* Batched: one query per fifty names rather than one per name. Wikidata is a
   shared public service and a query per company would be 262 requests where 6
   will do. */
const BATCH = 45;
const found = new Map();

for (let i = 0; i < pending.length; i += BATCH) {
    const slice = pending.slice(i, i + BATCH);
    const values = slice.map(([, x]) => `${JSON.stringify(String(x.name))}@en`).join(' ');
    const q = `
SELECT ?name ?companyLabel ?hqLabel ?coord ?countryCode WHERE {
  VALUES ?name { ${values} }
  ?company rdfs:label ?name .
  ?company wdt:P159 ?hq .
  ?hq wdt:P625 ?coord .
  OPTIONAL { ?company wdt:P17 ?country . ?country wdt:P297 ?countryCode }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}`;
    try {
        const j = await sparql(q);
        for (const b of j.results.bindings) {
            const name = b.name.value;
            if (found.has(name)) continue;
            /* "Point(lng lat)" — longitude FIRST, which is the reverse of every
               other coordinate in this codebase and an easy way to put a
               company in the wrong hemisphere. */
            const m = /Point\(([-\d.]+) ([-\d.]+)\)/.exec(b.coord.value);
            if (!m) continue;
            found.set(name, {
                lng: parseFloat(m[1]),
                lat: parseFloat(m[2]),
                city: b.hqLabel?.value || null,
                countryCode: b.countryCode?.value || null
            });
        }
        console.log(`  batch ${Math.floor(i / BATCH) + 1}: ${slice.length} asked, ${found.size} found so far`);
    } catch (e) {
        console.error(`  batch ${Math.floor(i / BATCH) + 1} failed: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 1500));   // be polite to a free service
}

let added = 0, wrongCountry = 0;
for (const [ticker, entry] of pending) {
    const hit = found.get(String(entry.name));
    if (!hit) continue;
    const want = regionCodeFor(entry.country);
    /* Same rule as everywhere: wrong country is refused, not recorded. */
    if (want && hit.countryCode && hit.countryCode !== want) { wrongCountry++; continue; }
    added++;
    if (dryRun) {
        console.log(`  + ${ticker.padEnd(11)} ${String(entry.name).slice(0, 28).padEnd(30)} -> ${String(hit.city).padEnd(16)} ${hit.lat.toFixed(3)},${hit.lng.toFixed(3)}`);
        continue;
    }
    store.results[ticker] = {
        ...entry,
        status: 'ok',
        lat: hit.lat, lng: hit.lng,
        matchedName: hit.city,
        address: hit.city,
        countryCode: hit.countryCode || want || null,
        nameScore: null,
        confidence: 'low',
        source: 'wikidata',
        /* THE HONEST BIT. Places results are building-level; these are not. */
        precision: 'city',
        note: `Wikidata headquarters city (${hit.city}) — city centre, not a street address`
    };
}

console.log(`\nadded ${added} at city precision | refused ${wrongCountry} for wrong country`);
if (!dryRun && added) {
    store.updatedAt = new Date().toISOString();
    fs.writeFileSync(OUT, JSON.stringify(store));
    const ok = Object.values(store.results).filter((x) => x.status === 'ok').length;
    console.log(`resolved now ${ok} / ${Object.keys(store.results).length}`);
    console.log(`written to ${path.relative(ROOT, OUT)}`);
} else if (dryRun) {
    console.log('(dry run — nothing written)');
}
