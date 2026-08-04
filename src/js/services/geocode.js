// Turning "San Francisco" into a latitude and a longitude.
//
// ---------------------------------------------------------------------------
// OFFLINE FIRST, NETWORK ONLY AS A FALLBACK
//
// Jarvis is local-first, and a globe that cannot find a city without the
// internet is a globe that does not work on a train. Natural Earth's populated
// places ships in the repo — about 1,250 cities in 162 KB, which covers every
// capital and major city anyone is likely to ask about.
//
// Only when that misses does it reach for Nominatim, and that request is
// deliberately conspicuous in the return value (`source: 'nominatim'`) so the
// caller can say where the answer came from. OpenStreetMap's usage policy asks
// for an identifying User-Agent and no heavy traffic; one lookup per spoken
// query is well inside it, and results are cached so asking twice costs once.
//
// MATCHING IS FUZZY ON PURPOSE. Speech-to-text produces "san fransico" and
// "saint petersberg". An exact match would fail on both, so the local index is
// searched by normalised prefix and then by edit distance, and a near-miss is
// returned WITH its score so the caller can decide whether to trust it.
// ---------------------------------------------------------------------------

const cache = new Map();

/** Strip accents, punctuation and case so "São Paulo" matches "sao paulo". */
export function normalise(s) {
    return String(s ?? '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Levenshtein distance, capped.
 *
 * Bounded because the only question asked of it is "is this within two edits";
 * an uncapped distance over 1,250 names on every keystroke is wasted work.
 */
export function editDistance(a, b, max = 3) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        let best = i;
        for (let j = 1; j <= b.length; j++) {
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
            best = Math.min(best, cur[j]);
        }
        if (best > max) return max + 1;
        prev = cur;
    }
    return prev[b.length];
}

/**
 * How many edits a query of this length may be wrong by.
 *
 * Exported to be tested directly: it is the knob that decides whether a
 * misheard city is recovered or a random word is turned into one.
 */
export function allowedEdits(len) {
    if (len >= 6) return 2;
    if (len >= 4) return 1;
    return 0;
}

/** Shortest fragment allowed to stand as a prefix match. */
const MIN_PREFIX_CHARS = 4;
/** How much of the longer string the shorter one must cover. */
const MIN_PREFIX_COVERAGE = 0.5;

/**
 * Is `q` a prefix of `name` (or vice versa) strongly enough to mean it?
 *
 * Exported so the rule is testable on its own — it is the difference between
 * finding a city and inventing one.
 */
export function isPrefixMatch(name, q) {
    if (!name || !q) return false;
    const forward = name.startsWith(q);
    const backward = q.startsWith(name);
    if (!forward && !backward) return false;
    const shorter = Math.min(name.length, q.length);
    const longer = Math.max(name.length, q.length);
    if (shorter < MIN_PREFIX_CHARS) return false;
    return shorter / longer >= MIN_PREFIX_COVERAGE;
}

/**
 * Build a searchable index from Natural Earth populated places.
 *
 * PURE — takes the parsed GeoJSON, returns an array. Testable without a
 * filesystem, which is why the loading is the caller's job.
 */
export function buildPlaceIndex(geojson) {
    const out = [];
    for (const f of geojson?.features || []) {
        const c = f?.geometry?.coordinates;
        const p = f?.properties || {};
        const name = p.name || p.NAME || p.nameascii;
        if (!Array.isArray(c) || !name) continue;
        out.push({
            name,
            norm: normalise(name),
            country: p.adm0name || p.ADM0NAME || '',
            admin: p.adm1name || '',
            lat: c[1],
            lng: c[0],
            /* Population breaks ties: "Springfield" should mean the biggest
               one unless the user says which. */
            population: Number(p.pop_max || p.POP_MAX || 0)
        });
    }
    return out;
}

/**
 * Look a place up in the local index.
 *
 * @returns {{name,lat,lng,country,score,source}|null}
 */
export function findLocal(index, query) {
    const q = normalise(query);
    if (!q || !index?.length) return null;

    let exact = null, squashed = null, prefix = null, fuzzy = null, fuzzyScore = 99;

    /* Speech-to-text runs words together — "sanfrancisco", "newyork". Comparing
       with the spaces taken out of BOTH sides is an exact match on the letters,
       not a guess, so it is trusted nearly as much as a true exact hit and well
       clear of the fuzzy tier. */
    const qSquash = q.replace(/ /g, '');

    for (const place of index) {
        if (place.norm === q) {
            if (!exact || place.population > exact.population) exact = place;
            continue;
        }
        if (place.norm.replace(/ /g, '') === qSquash) {
            if (!squashed || place.population > squashed.population) squashed = place;
            continue;
        }
        /* A PREFIX MATCH HAS TO BE SUBSTANTIAL.
           With no floor on it, "map" prefix-matched Maputo and "ku" matched
           Kuwait City — both at 0.80, which is exactly the confidence the
           intent parser trusts, so "show me the map" flew the camera to
           Mozambique. A prefix is only evidence when it is long enough to be
           distinctive AND covers a real share of the name: "san fran" for San
           Francisco, not three letters for a capital on another continent. */
        if (isPrefixMatch(place.norm, q)) {
            if (!prefix || place.population > prefix.population) prefix = place;
            continue;
        }
        /* Only bother with edit distance on names of a similar length —
           otherwise every short name is "close" to every query.

           THE EDIT BUDGET SCALES WITH THE QUERY. A flat two edits let "map"
           reach Malé and "ku" reach Baku: on a three-letter word, two edits
           means one surviving character, which is not a typo but a different
           word. Short queries therefore get no slack at all. */
        const budget = allowedEdits(q.length);
        if (budget > 0 && Math.abs(place.norm.length - q.length) <= 3) {
            const d = editDistance(q, place.norm, budget);
            if (d <= budget && (d < fuzzyScore || (d === fuzzyScore && place.population > (fuzzy?.population || 0)))) {
                fuzzy = place; fuzzyScore = d;
            }
        }
    }

    const hit = exact || squashed || prefix || fuzzy;
    if (!hit) return null;
    return {
        name: hit.name, lat: hit.lat, lng: hit.lng, country: hit.country,
        score: exact ? 1 : squashed ? 0.95 : prefix ? 0.8 : Math.max(0.4, 1 - fuzzyScore * 0.25),
        source: 'local'
    };
}

/**
 * Resolve a place name, local index first.
 *
 * @param {object} opts
 * @param {Array} opts.index          from buildPlaceIndex
 * @param {boolean} [opts.allowNetwork]
 */
export async function geocode(query, { index = [], allowNetwork = true, fetchImpl = fetch } = {}) {
    const key = normalise(query);
    if (!key) return null;
    if (cache.has(key)) return cache.get(key);

    const local = findLocal(index, query);
    /* A confident local hit is the end of it — no request, no latency. */
    if (local && local.score >= 0.8) { cache.set(key, local); return local; }

    if (allowNetwork) {
        try {
            const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
            const res = await fetchImpl(url, {
                headers: { 'User-Agent': 'Jarvis/0.5 (local assistant; contact via github.com/ashutosh0x)' },
                signal: AbortSignal.timeout?.(8000)
            });
            if (res.ok) {
                const json = await res.json();
                const hit = json?.[0];
                if (hit) {
                    const found = {
                        name: String(hit.display_name).split(',')[0],
                        lat: Number(hit.lat), lng: Number(hit.lon),
                        country: String(hit.display_name).split(',').pop().trim(),
                        score: 0.95, source: 'nominatim'
                    };
                    cache.set(key, found);
                    return found;
                }
            }
        } catch {
            /* Offline, blocked or slow. The weak local match below is a better
               answer than nothing, and it is returned with its low score so the
               caller can hedge the wording. */
        }
    }

    if (local) { cache.set(key, local); return local; }
    return null;
}

export default { geocode, findLocal, buildPlaceIndex, normalise, editDistance };
