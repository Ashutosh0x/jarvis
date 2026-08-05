/* =========================================================================
   COMPANIESMARKETCAP — the ranking, live, instead of a table typed by hand.

   MAIN PROCESS ONLY. PARSE_API_KEY is read here and never reaches the
   renderer, same rule as googleMaps.js.

   WHY THIS REPLACES A FILE. `src/js/data/marketcapCompanies.js` is a list of
   company names and countries that a human transcribed from a web page. Every
   row is a chance to put a company in the wrong country, it is stale the day
   it is written, and it carries no market cap, no price and no rank. This
   endpoint returns all of that, ordered, a hundred at a time. The hardcoded
   file stays as an offline fallback — a globe that needs a paid API to draw
   anything is worse than one with a stale list — but it is no longer the
   source of truth.

   CREDITS ARE THE HARD CONSTRAINT, and they are what shapes every decision
   in this module. One call is one credit, charged on success. The account had
   195 when this was written. That means:

     - 11,222 companies is ~113 pages, so a full crawl is more than half the
       balance. `ranking()` therefore takes an explicit page and this module
       NEVER loops over pages on its own. A caller that wants ten pages has to
       ask for ten pages.
     - Results are cached to disk with a TTL. Market caps move daily, not
       secondly; refetching a page inside the TTL buys nothing and costs a
       credit.
     - A failed call is not cached, because it was not charged.

   The response shape below is taken from the endpoint's own documentation:
   `{ page, companies[], total_results }` where each company carries rank,
   name, ticker, market_cap (formatted and raw), price, today_change and
   country. Fields are read defensively anyway — a scraper-backed API can
   change shape when the page under it does, and a silent undefined that
   becomes "undefined" on a label is worse than a reported miss.
   ========================================================================= */

const fs = require('node:fs');
const path = require('node:path');

const BASE = 'https://api.parse.bot/scraper/b9f76412-d8f2-4b41-b0ac-663645e3b633';
const TIMEOUT_MS = 30000;      // the playground measured 3.4 s; scrapers are slow
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;   // half a day: caps move daily

const key = () => process.env.PARSE_API_KEY || '';
function isConfigured() { return !!key(); }

/* Cache lives beside the app's other state. Set by init() so this module does
   not have to import electron and stays unit-testable. */
let cacheFile = null;
let cache = new Map();

function init(userDataDir) {
    cacheFile = path.join(userDataDir, 'marketcap-cache.json');
    photoDir = path.join(userDataDir, 'company-photos');
    try {
        if (fs.existsSync(cacheFile)) {
            for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(cacheFile, 'utf8')))) {
                cache.set(k, v);
            }
        }
    } catch { /* a corrupt cache costs credits, not correctness */ }
}

function persist() {
    if (!cacheFile) return;
    try { fs.writeFileSync(cacheFile, JSON.stringify(Object.fromEntries(cache))); }
    catch { /* disk full or read-only: this session still has it in memory */ }
}

/**
 * One request. Returns `{ok, data}` or `{ok:false, reason, detail}`, never throws.
 *
 * `cacheKey` is required rather than optional: every endpoint here costs a
 * credit, so "should this be cached" is not a decision worth leaving to a
 * caller in a hurry.
 */
async function call(endpoint, params, cacheKey) {
    if (!key()) return { ok: false, reason: 'no-key', detail: 'PARSE_API_KEY is not set' };

    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
        return { ok: true, data: hit.data, cached: true, ageMs: Date.now() - hit.at };
    }

    const qs = new URLSearchParams(
        Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
    );
    try {
        const res = await fetch(`${BASE}/${endpoint}?${qs}`, {
            headers: { 'X-API-Key': key(), Accept: 'application/json' },
            signal: AbortSignal.timeout(TIMEOUT_MS)
        });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* handled below */ }

        if (!res.ok) {
            /* 401/403 is a bad key, 402 is out of credits, 429 is rate limit —
               all different problems and none of them is "offline". Passing the
               status through is what lets the user act on it. */
            return {
                ok: false,
                reason: res.status === 402 ? 'out-of-credits'
                    : res.status === 401 || res.status === 403 ? 'bad-key'
                        : `http-${res.status}`,
                detail: (json?.error || json?.message || text || '').slice(0, 300)
            };
        }
        if (!json) return { ok: false, reason: 'bad-json', detail: text.slice(0, 200) };

        /* Only a success is cached. A failure was not charged, so caching it
           would just hide a transient problem for twelve hours. */
        cache.set(cacheKey, { at: Date.now(), data: json });
        persist();
        return { ok: true, data: json, cached: false };
    } catch (error) {
        return {
            ok: false,
            reason: error.name === 'TimeoutError' ? 'timeout' : 'network',
            detail: error.message
        };
    }
}

/** Normalise one row into the shape the globe already speaks. */
function toEntry(c) {
    if (!c) return null;
    const name = c.name || c.company_name || null;
    if (!name) return null;
    return {
        name,
        ticker: c.ticker || c.identifier || c.symbol || null,
        country: c.country || null,
        rank: Number(c.rank) || null,
        /* VERIFIED AGAINST THE WIRE, not the documentation. The docs say
           `market_cap` carries "formatted and raw"; the API actually sends
           `{formatted, raw_value}`, and `price`/`today_change` are the same
           shape scaled by 100 — price.raw_value 21194 is $211.94, and
           today_change.raw_value 256 is 2.56%. Reading `raw` produced null for
           every company, which reads as an empty database rather than as the
           parsing bug it is.

           Both forms are kept: the formatted string is what a label should
           show, the number is what a sort or a marker size needs. Deriving one
           from the other means parsing "$5.133 T", which is a locale trap. */
        marketCap: Number.isFinite(c.market_cap?.raw_value) ? c.market_cap.raw_value : null,
        marketCapText: c.market_cap?.formatted ?? null,
        price: Number.isFinite(c.price?.raw_value) ? c.price.raw_value / 100 : null,
        priceText: c.price?.formatted ?? null,
        todayChangePct: Number.isFinite(c.today_change?.raw_value) ? c.today_change.raw_value / 100 : null,
        todayChangeText: c.today_change?.formatted ?? null
    };
}

/**
 * One page of the global ranking — 100 companies, richest first.
 *
 * NO INTERNAL PAGINATION, deliberately. Crawling the whole ranking is 113
 * credits and that has to be a decision someone makes on purpose, in a loop
 * they can see, not a side effect of asking for "the companies".
 */
async function ranking({ page = 1 } = {}) {
    const p = Math.max(1, Math.min(200, Number(page) || 1));
    const res = await call('get_ranking', { page: p }, `ranking:${p}`);
    if (!res.ok) return res;
    /* `{status, data: {page, companies, total_results}}` on the wire; the docs
       describe only the inner object. Both are accepted so an upstream fix
       does not break this. */
    const payload = res.data?.data ?? res.data;
    const rows = payload?.companies || [];
    const companies = rows.map(toEntry).filter(Boolean);
    return {
        ok: true,
        cached: res.cached,
        data: {
            page: payload?.page ?? p,
            total: payload?.total_results ?? companies.length,
            companies
        }
    };
}

/** Resolve a name or ticker to the identifier the other endpoints want. */
async function search({ query } = {}) {
    const q = String(query || '').trim();
    if (!q) return { ok: false, reason: 'no-query' };
    const res = await call('search', { query: q }, `search:${q.toLowerCase()}`);
    if (!res.ok) return res;
    const rows = Array.isArray(res.data) ? res.data : (res.data?.results || res.data?.companies || []);
    return {
        ok: true,
        cached: res.cached,
        data: {
            results: rows.map((r) => ({
                identifier: r.identifier || null,
                name: r.name || null,
                slug: r.url || null,
                type: r.type || null
            })).filter((r) => r.identifier && r.name)
        }
    };
}

/** Rank, price, country, categories, description, revenue and earnings history. */
async function details({ identifier } = {}) {
    const id = String(identifier || '').trim();
    if (!id) return { ok: false, reason: 'no-identifier' };
    return call('get_company_details', { identifier: id }, `details:${id.toLowerCase()}`);
}

/** Year-by-year history of one metric (pe-ratio, eps, revenue, ...). */
async function metricHistory({ identifier, metric } = {}) {
    const id = String(identifier || '').trim();
    const m = String(metric || '').trim();
    if (!id || !m) return { ok: false, reason: 'no-identifier-or-metric' };
    return call('get_company_metric_history', { identifier: id, metric: m },
        `metric:${id.toLowerCase()}:${m.toLowerCase()}`);
}

/** What is already paid for, so a caller can prefer free pages over new ones. */
function cachedPages() {
    const out = [];
    for (const [k, v] of cache) {
        if (!k.startsWith('ranking:')) continue;
        if (Date.now() - v.at >= CACHE_TTL_MS) continue;
        out.push(Number(k.slice(8)));
    }
    return out.sort((a, b) => a - b);
}

/**
 * The crawled ranking from disk — FREE, and the reason the crawl was worth
 * paying for.
 *
 * `scripts/fetch-ranking.mjs` buys the ranking once, a page at a time, and
 * writes it here. Reading it back costs nothing and works offline, so the
 * globe's company list is a local database rather than a live dependency on a
 * metered API. The paid endpoints above remain for the things a static file
 * cannot answer — a company's revenue history, or a name the crawl predates.
 *
 * Returns `{available: false}` rather than an empty list when the file is
 * missing: "nobody has run the crawl" and "the ranking is empty" are different
 * facts and the caller has to be able to tell them apart.
 */
function localRanking({ limit = 0, country = null } = {}) {
    const file = path.join(__dirname, 'data', 'companies-ranking.json');
    let db;
    try {
        if (!fs.existsSync(file)) return { ok: true, data: { available: false, reason: 'not-crawled' } };
        db = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        return { ok: false, reason: 'unreadable', detail: e.message };
    }
    let companies = Array.isArray(db.companies) ? db.companies : [];
    if (country) {
        const want = String(country).toLowerCase();
        companies = companies.filter((c) => String(c.country || '').toLowerCase() === want);
    }
    const total = companies.length;
    if (limit > 0) companies = companies.slice(0, limit);
    return {
        ok: true,
        data: {
            available: true,
            fetchedAt: db.fetchedAt || null,
            pages: Object.keys(db.pages || {}).length,
            total,
            companies
        }
    };
}

/**
 * The resolved head-office coordinates from disk — FREE, and the reason the
 * $453 of Places lookups was worth paying once.
 *
 * `scripts/resolve-hq.mjs` bought these and validated every one against the
 * country the ranking recorded. Reading them back costs nothing and works
 * offline. The globe MUST prefer this over resolving live, or every launch
 * re-buys eleven thousand lookups that are already sitting in a file.
 *
 * Confidence and precision travel with each row rather than being flattened
 * away: 10,959 are building-level from Places, 36 are city-level from
 * Wikidata, and a caller that wants only the verified ones can filter on
 * `confidence` instead of trusting a number it cannot inspect.
 */
function localHq({ minConfidence = null } = {}) {
    const file = path.join(__dirname, 'data', 'companies-hq.json');
    try {
        if (!fs.existsSync(file)) return { ok: true, data: { available: false, reason: 'not-resolved' } };
        const db = JSON.parse(fs.readFileSync(file, 'utf8'));
        const RANK = { high: 3, medium: 2, low: 1 };
        const floor = RANK[minConfidence] || 0;
        const out = {};
        let counts = { high: 0, medium: 0, low: 0 };
        for (const [ticker, r] of Object.entries(db.results || {})) {
            if (r.status !== 'ok' || !Number.isFinite(r.lat)) continue;
            counts[r.confidence] = (counts[r.confidence] || 0) + 1;
            if ((RANK[r.confidence] || 0) < floor) continue;
            out[ticker] = {
                lat: r.lat, lng: r.lng,
                placeId: r.placeId || null,
                matchedName: r.matchedName,
                address: r.address,
                countryCode: r.countryCode,
                confidence: r.confidence,
                precision: r.precision || 'building',
                source: r.source || 'google-places'
            };
        }
        return {
            ok: true,
            data: { available: true, updatedAt: db.updatedAt || null, counts, total: Object.keys(out).length, hq: out }
        };
    } catch (e) {
        return { ok: false, reason: 'unreadable', detail: e.message };
    }
}

/**
 * The hand-curated named list — quant funds, HFT firms, banks, the Hong Kong
 * VATP ecosystem — from disk. FREE, offline, and already validated.
 *
 * SEPARATE FROM THE RANKING ON PURPOSE. `localRanking` is 11,222 public
 * companies keyed by ticker. Almost nothing here has a ticker: Citadel
 * Securities, Jane Street, Jump and DRW are private, and none of them appear
 * in the market-cap crawl at all. Merging the two would mean inventing a key
 * for companies that do not have one.
 *
 * Only `status: 'ok'` rows are returned. The rejected ones stay in the file
 * with their reason — a firm Google could not confirm is absent from the globe
 * rather than approximated onto it — and a caller that wants to know what was
 * refused can read the file directly.
 */
function localNamed({ category = null, minConfidence = null } = {}) {
    const file = path.join(__dirname, 'data', 'named-companies.json');
    try {
        if (!fs.existsSync(file)) return { ok: true, data: { available: false, reason: 'not-resolved' } };
        const db = JSON.parse(fs.readFileSync(file, 'utf8'));
        const RANK = { high: 3, medium: 2, low: 1 };
        const floor = RANK[minConfidence] || 0;
        const wanted = category
            ? (Array.isArray(category) ? category : String(category).split(','))
                .map((c) => c.trim().toLowerCase())
            : null;

        const companies = [];
        const categories = {};
        let rejected = 0;
        for (const r of Object.values(db.results || {})) {
            if (r.status !== 'ok' || !Number.isFinite(r.lat)) { rejected++; continue; }
            categories[r.category] = (categories[r.category] || 0) + 1;
            if (wanted && !wanted.includes(String(r.category || '').toLowerCase())) continue;
            if ((RANK[r.confidence] || 0) < floor) continue;
            companies.push({
                name: r.name,
                lat: r.lat, lng: r.lng,
                matchedName: r.matchedName,
                address: r.address,
                placeId: r.placeId || null,
                category: r.category,
                countryCode: r.countryCode,
                confidence: r.confidence,
                source: r.source || 'google-places'
            });
        }
        return {
            ok: true,
            data: {
                available: true,
                updatedAt: db.updatedAt || null,
                total: companies.length,
                rejected,
                categories,
                companies
            }
        };
    } catch (e) {
        return { ok: false, reason: 'unreadable', detail: e.message };
    }
}

/**
 * A photograph of one company's office, fetched on demand and kept.
 *
 * ON DEMAND IS THE WHOLE DESIGN. Two billed Google requests per company —
 * Details for the reference, media for the bytes — so sweeping all 10,959
 * would be about $263 and 877 MB to produce pictures nobody has asked for.
 * Clicking one company costs roughly half a cent, and the second click on the
 * same company costs nothing because of the cache below.
 *
 * Cached on DISK rather than in memory: photos are large, they never change,
 * and a cache that empties on restart would re-buy them every launch.
 */
let photoDir = null;

function photoCachePath(placeId) {
    /* The place ID is Google's own opaque token and can contain characters
       that are not safe in a filename. */
    const safe = String(placeId).replace(/[^A-Za-z0-9_-]/g, '_');
    return path.join(photoDir, `${safe}.json`);
}

async function companyPhoto({ placeId, maxWidthPx = 800, googleMaps = null } = {}) {
    if (!placeId) return { ok: false, reason: 'no-place-id' };
    if (!photoDir) return { ok: false, reason: 'not-initialised' };

    const file = photoCachePath(placeId);
    try {
        if (fs.existsSync(file)) {
            return { ok: true, cached: true, data: JSON.parse(fs.readFileSync(file, 'utf8')) };
        }
    } catch { /* a corrupt entry is refetched, not fatal */ }

    const gm = googleMaps || require('./googleMaps');
    const res = await gm.placePhotoForCompany({ placeId, maxWidthPx });
    if (!res.ok) return res;

    /* Misses are cached too — a place with no photo has no photo tomorrow
       either, and re-asking costs a Details request every time. */
    try {
        fs.mkdirSync(photoDir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(res.data));
    } catch { /* disk full: the photo still works this session */ }
    return { ok: true, cached: false, data: res.data };
}

/** How much has been photographed already, without fetching anything. */
function photoStats() {
    try {
        if (!photoDir || !fs.existsSync(photoDir)) return { ok: true, data: { cached: 0, bytes: 0 } };
        const files = fs.readdirSync(photoDir).filter((f) => f.endsWith('.json'));
        let bytes = 0;
        for (const f of files) bytes += fs.statSync(path.join(photoDir, f)).size;
        return { ok: true, data: { cached: files.length, bytes } };
    } catch (e) {
        return { ok: false, reason: 'unreadable', detail: e.message };
    }
}

const METHODS = { ranking, search, details, metricHistory, localRanking, localHq, localNamed, companyPhoto, photoStats };

async function invoke(method, params = {}) {
    const fn = METHODS[method];
    if (!fn) return { ok: false, reason: 'unknown-method', detail: String(method).slice(0, 40) };
    return fn(params || {});
}

module.exports = {
    invoke, init, isConfigured, cachedPages, toEntry, localNamed,
    methods: Object.keys(METHODS), ...METHODS
};
