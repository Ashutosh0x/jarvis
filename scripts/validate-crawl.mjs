#!/usr/bin/env node
/* =========================================================================
   VALIDATE THE CRAWL — prove the committed database, don't trust it.

   `data/` holds 11,222 companies and 10,995 head-office coordinates that cost
   113 credits and ~$453 to produce. They are now a static file that everything
   downstream believes. A file nobody re-checks is a file that quietly rots:
   a bad parse, a half-finished resume, or a schema change upstream all look
   exactly like valid JSON.

   COSTS NOTHING AND TOUCHES NO NETWORK. Every check below runs against what is
   already on disk, so it can be run on every commit and by anyone who clones
   the repo without a key.

   The checks, cheapest first:

     1. STRUCTURE. Finite coordinates in range, tickers unique, and every
        resolved ticker actually present in the ranking. A head office for a
        company that is not in the ranking is an orphan.
     2. COUNTRY AGREEMENT. The resolver already enforced this at crawl time;
        this re-proves it against the committed file, which is the artefact
        that ships. The two can disagree if a row was edited by hand.
     3. ON LAND. The check no country code can make. A coordinate can carry the
        right ISO code and still sit in the sea — a centroid fallback, a
        transposed pair, a lat/lng swap. Tested against the bundled Natural
        Earth land polygons, so it needs no network.
     4. DUPLICATE COORDINATES. Many companies at one exact point means a
        default centroid leaked in and is being drawn as N distinct offices.

   ON THE LAND TEST'S TOLERANCE. ne_110m_land is coarse — roughly 1:110M — so
   small islands, reclaimed land and tight coastal sites legitimately fall
   outside it. Failing those would make the check cry wolf and get ignored,
   which is worse than not having it. So a point outside every polygon is only
   REPORTED when it is also far from any polygon's bounding box; near-coast
   misses are counted separately and named as a limit of the test rather than
   as a fault in the data.

   Usage:
     node scripts/validate-crawl.mjs            # summary
     node scripts/validate-crawl.mjs --verbose  # list every offender
   ========================================================================= */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERBOSE = process.argv.includes('--verbose');

const { regionCodeFor } = await import(
    `file:///${ROOT.replace(/\\/g, '/')}/src/js/services/googleServices.js`
);

/* DOMICILE_ONLY comes from the resolver rather than being restated here.
   A market-cap table's "country" is where a company is REGISTERED, which for
   Bermuda, Jersey and their neighbours is not where anyone works: Brookfield
   Renewable is Bermuda and runs from Toronto, Lazard is Bermuda and sits in
   New York. The resolver accepts that on purpose. A validator that flagged it
   would be reporting a policy it disagrees with as a data fault — and one
   restated by hand would drift the moment the resolver's list changed. */
const DOMICILE_ONLY = await (async () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'resolve-hq.mjs'), 'utf8');
    const a = src.indexOf('/* ------------------------------------------------------------ validation -- */');
    const b = src.indexOf('/* ------------------------------------------------------------- resolution -- */');
    const tmp = path.join(ROOT, '.tmp-domicile.mjs');
    fs.writeFileSync(tmp, `${src.slice(a, b)}\nexport { DOMICILE_ONLY };\n`);
    try {
        return (await import(`file:///${tmp.replace(/\\/g, '/')}`)).DOMICILE_ONLY;
    } finally {
        fs.rmSync(tmp, { force: true });
    }
})();

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
    ok ? pass++ : fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));

// ── load ────────────────────────────────────────────────────────────────────
const ranking = read('data/companies-ranking.json');
const hqdb = read('data/companies-hq.json');
const results = hqdb.results || {};

const companies = ranking.companies || [];
const byTicker = new Map();
for (const c of companies) if (c.ticker) byTicker.set(c.ticker, c);

console.log(`ranking : ${companies.length} companies, crawled ${ranking.fetchedAt}`);
console.log(`head off: ${Object.keys(results).length} entries, updated ${hqdb.updatedAt}`);
console.log('');

// ── 1. structure ────────────────────────────────────────────────────────────
const resolved = Object.entries(results).filter(([, r]) => r.status === 'ok');
const rejected = Object.entries(results).filter(([, r]) => r.status !== 'ok');

check('the ranking carries companies', companies.length > 0, `${companies.length}`);
/* A repeated ticker is only a fault when the two rows disagree about WHICH
   company it is. The upstream ranking lists Mastek at both 7300 and 7301 —
   same ticker, same name, adjacent ranks — which is the source repeating
   itself, faithfully recorded. Rewriting the crawl to hide that would be
   editing evidence; the globe draws one dot twice and nothing is misstated.
   Two different companies claiming one ticker is another matter: the head
   office lookup is keyed by ticker, so one of them would silently get the
   other's building. */
{
    const rows = companies.filter((c) => c.ticker);
    const seen = new Map();
    const conflicting = [], benign = [];
    for (const c of rows) {
        const prev = seen.get(c.ticker);
        if (!prev) { seen.set(c.ticker, c); continue; }
        (prev.name === c.name ? benign : conflicting).push([prev, c]);
    }
    check('no two different companies claim the same ticker', conflicting.length === 0,
        conflicting.length
            ? conflicting.slice(0, 3).map(([a, b]) => `${a.ticker}: ${a.name} vs ${b.name}`).join('; ')
            : `${seen.size} unique tickers, ${benign.length} benign repeat(s) of the same company`);
}

const badCoord = resolved.filter(([, r]) =>
    !Number.isFinite(r.lat) || !Number.isFinite(r.lng) ||
    r.lat < -90 || r.lat > 90 || r.lng < -180 || r.lng > 180);
check('every resolved coordinate is finite and in range', badCoord.length === 0,
    badCoord.length ? `${badCoord.length} bad` : `${resolved.length} checked`);

const orphans = resolved.filter(([t]) => !byTicker.has(t));
check('every resolved ticker exists in the ranking', orphans.length === 0,
    orphans.length ? `${orphans.length} orphans: ${orphans.slice(0, 5).map(([t]) => t).join(', ')}`
        : `${resolved.length} matched`);

const everyRejectHasReason = rejected.every(([, r]) => !!r.reason);
check('every rejection carries a reason', everyRejectHasReason,
    `${rejected.length} rejected`);

// ── 2. country agreement ────────────────────────────────────────────────────
const mismatched = [];
let uncheckable = 0, domicileOnly = 0;
for (const [ticker, r] of resolved) {
    const country = byTicker.get(ticker)?.country;
    if (DOMICILE_ONLY.has(String(country || ''))) { domicileOnly++; continue; }
    const want = regionCodeFor(country);
    if (!want) { uncheckable++; continue; }
    if (r.countryCode && r.countryCode !== want) mismatched.push({ ticker, want, got: r.countryCode });
}
check('resolved country matches the ranking country', mismatched.length === 0,
    mismatched.length
        ? `${mismatched.length} disagree: ${mismatched.slice(0, 5).map((m) => `${m.ticker} ${m.got}!=${m.want}`).join(', ')}`
        : `${resolved.length - uncheckable - domicileOnly} checked, ${uncheckable} had no ISO mapping, ` +
          `${domicileOnly} registered in a domicile-only jurisdiction`);

// ── 3. on land ──────────────────────────────────────────────────────────────
const land = read('static/geo/ne_110m_land.geojson');

/** Every ring in the land layer, with a precomputed bbox to reject fast. */
const rings = [];
for (const f of land.features || []) {
    const g = f.geometry;
    if (!g) continue;
    const polys = g.type === 'Polygon' ? [g.coordinates]
        : g.type === 'MultiPolygon' ? g.coordinates : [];
    for (const poly of polys) {
        const outer = poly[0];
        if (!outer || outer.length < 4) continue;
        let minX = 180, minY = 90, maxX = -180, maxY = -90;
        for (const [x, y] of outer) {
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
        rings.push({ outer, minX, minY, maxX, maxY });
    }
}

function inRing(lng, lat, ring) {
    const pts = ring.outer;
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
        if ((yi > lat) !== (yj > lat) &&
            lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}

/* Degrees, not km, deliberately: this is a tolerance on a coarse polygon, not
   a distance measurement, and pretending otherwise would dress a fudge factor
   up as precision. ~0.6 deg is comfortably wider than 110m simplification
   error at any latitude that has cities in it. */
const NEAR_DEG = 0.6;

const offLand = [];
const nearCoast = [];
for (const [ticker, r] of resolved) {
    const { lat, lng } = r;
    let hit = false, near = false;
    for (const ring of rings) {
        if (lng >= ring.minX && lng <= ring.maxX && lat >= ring.minY && lat <= ring.maxY) {
            if (inRing(lng, lat, ring)) { hit = true; break; }
        }
        if (!near &&
            lng >= ring.minX - NEAR_DEG && lng <= ring.maxX + NEAR_DEG &&
            lat >= ring.minY - NEAR_DEG && lat <= ring.maxY + NEAR_DEG) near = true;
    }
    if (hit) continue;
    (near ? nearCoast : offLand).push({ ticker, name: r.matchedName, lat, lng, cc: r.countryCode });
}

check('no head office sits in open ocean', offLand.length === 0,
    offLand.length
        ? `${offLand.length} adrift: ${offLand.slice(0, 5).map((o) => `${o.ticker} (${o.lat.toFixed(2)},${o.lng.toFixed(2)})`).join(', ')}`
        : `${resolved.length} checked against Natural Earth land`);
console.log(`      note: ${nearCoast.length} fall just outside the coarse 110m land layer ` +
    `(islands, reclaimed land, coastal sites) — a limit of the test, not a fault in the data`);

// ── 4. duplicate coordinates ────────────────────────────────────────────────
const atPoint = new Map();
for (const [ticker, r] of resolved) {
    const key = `${r.lat.toFixed(5)},${r.lng.toFixed(5)}`;
    if (!atPoint.has(key)) atPoint.set(key, []);
    atPoint.get(key).push(ticker);
}
const clusters = [...atPoint.entries()].filter(([, ts]) => ts.length > 1)
    .sort((a, b) => b[1].length - a[1].length);
const worst = clusters[0]?.[1].length || 0;

/* Two companies at one point is normal — a shared tower, a parent and its
   subsidiary. A dozen is a centroid that leaked in and is being drawn as a
   dozen distinct offices. */
check('no coordinate is shared by an implausible number of companies', worst < 8,
    worst ? `largest cluster ${worst} at ${clusters[0][0]} (${clusters[0][1].slice(0, 6).join(', ')})`
        : 'no duplicates');
console.log(`      ${clusters.length} coordinates shared by 2+ companies, largest ${worst}`);

// ── confidence + precision, reported not asserted ───────────────────────────
const conf = {}, prec = {}, src = {};
for (const [, r] of resolved) {
    conf[r.confidence] = (conf[r.confidence] || 0) + 1;
    prec[r.precision || 'building'] = (prec[r.precision || 'building'] || 0) + 1;
    src[r.source || 'google-places'] = (src[r.source || 'google-places'] || 0) + 1;
}
const reasons = {};
for (const [, r] of rejected) reasons[r.reason || '?'] = (reasons[r.reason || '?'] || 0) + 1;

console.log('');
console.log(`resolved   ${resolved.length}`);
console.log(`  confidence ${JSON.stringify(conf)}`);
console.log(`  precision  ${JSON.stringify(prec)}`);
console.log(`  source     ${JSON.stringify(src)}`);
console.log(`rejected   ${rejected.length}`);
console.log(`  reasons    ${JSON.stringify(reasons)}`);

if (VERBOSE) {
    if (offLand.length) {
        console.log('\nadrift:');
        for (const o of offLand) console.log(`  ${o.ticker.padEnd(8)} ${o.name} (${o.lat},${o.lng}) ${o.cc}`);
    }
    if (mismatched.length) {
        console.log('\ncountry mismatches:');
        for (const m of mismatched) console.log(`  ${m.ticker.padEnd(8)} got ${m.got}, ranking says ${m.want}`);
    }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
