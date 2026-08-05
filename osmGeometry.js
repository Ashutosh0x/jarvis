/* =========================================================================
   OPENSTREETMAP GEOMETRY — the shape of a place, not just its point.

   MAIN PROCESS ONLY, for the same reason googleMaps.js is: the renderer gets
   results, never the network surface.

   WHY THIS EXISTS. Google Places is a search engine and it is very good at
   one: give it "tech parks in Bengaluru" and it finds them. What it returns
   is a POINT — Manyata Tech Park, a 120-hectare campus with fifty buildings,
   arrives as one pin the same size as a coffee shop. OpenStreetMap has the
   same campus as a polygon with its actual boundary, and tags it
   `landuse=commercial`, which is a machine-readable fact about what it IS
   rather than a guess from its name. So: Google finds it, OSM shapes it.

   WHY NOMINATIM AND NOT OVERPASS. Overpass is the natural tool for
   "everything with this tag in this box", and it was the first choice. Four
   endpoints were probed — overpass-api.de, kumi.systems, private.coffee and
   osm.jp — and all four returned 504 or timed out. It is a free shared
   service with no availability guarantee, and a globe that goes blank when a
   volunteer server is busy is not a globe. Nominatim answered every request
   during the same window and returns `geojson` polygons directly, so the
   feature is built on the endpoint that actually stays up.

   RATE LIMIT IS A HARD RULE, NOT A SUGGESTION. Nominatim's usage policy is a
   maximum of one request per second from a single source, with an
   identifying User-Agent. Exceeding it gets the app blocked, and being
   blocked is indistinguishable to a user from being broken. The queue below
   enforces the interval in code so no caller can accidentally violate it by
   looping — the limit does not depend on every future caller remembering it.
   ========================================================================= */

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const TIMEOUT_MS = 15000;

/* Their policy requires a real identifier with contact info. */
const UA = 'JarvisGlobe/0.9 (desktop assistant; https://github.com/Ashutosh0x/jarvis)';

/* One request per second, serialised. `last` is the wall clock of the previous
   send, so a burst of twenty lookups becomes twenty seconds of polite traffic
   rather than twenty simultaneous requests and a ban. */
let chain = Promise.resolve();
let last = 0;
const MIN_INTERVAL_MS = 1100;

function rateLimited(fn) {
    chain = chain.then(async () => {
        const wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - last));
        if (wait) await new Promise((r) => setTimeout(r, wait));
        last = Date.now();
        return fn();
    }, async () => {
        /* A failure upstream must not break the chain for everyone after it. */
        const wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - last));
        if (wait) await new Promise((r) => setTimeout(r, wait));
        last = Date.now();
        return fn();
    });
    return chain;
}

/**
 * The boundary of a named place, plus what OSM says it is.
 *
 * The coordinates are used as a VIEWBOX, not as the query: searching the name
 * alone finds the Manyata Tech Park in the wrong city, and searching by
 * coordinate alone finds whatever building happens to be nearest. Bounding the
 * search to a box around the point Google already returned is what makes the
 * two agree on the same object.
 *
 * Returns the polygon when there is one and the point when there is not —
 * absence of geometry is reported as `geometry: null`, never faked by drawing
 * a circle and calling it a campus.
 */
async function lookupShape({ name, lat, lng, radiusKm = 3 } = {}) {
    const q = String(name || '').trim();
    if (!q) return { ok: false, reason: 'no-name' };

    const params = new URLSearchParams({
        q,
        format: 'jsonv2',
        polygon_geojson: '1',
        addressdetails: '1',
        limit: '3'
    });
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
        /* Degrees of longitude shrink towards the poles; a fixed degree box
           would be a 300 km search in Norway and a 3 km one at the equator. */
        const dLat = radiusKm / 111.32;
        const dLng = radiusKm / (111.32 * Math.max(0.15, Math.cos(lat * Math.PI / 180)));
        params.set('viewbox', `${lng - dLng},${lat + dLat},${lng + dLng},${lat - dLat}`);
        params.set('bounded', '1');
    }

    try {
        const res = await rateLimited(() => fetch(`${NOMINATIM}?${params}`, {
            headers: { 'User-Agent': UA, Accept: 'application/json' },
            signal: AbortSignal.timeout(TIMEOUT_MS)
        }));
        if (!res.ok) return { ok: false, reason: `http-${res.status}` };
        const hits = await res.json();
        if (!Array.isArray(hits) || !hits.length) return { ok: true, data: { found: false } };

        /* Prefer a hit that actually carries an area. A polygon is the whole
           point of asking OSM; a second Point result adds nothing Google did
           not already have. */
        const withArea = hits.find((h) => h.geojson && h.geojson.type !== 'Point');
        const hit = withArea || hits[0];
        const geom = hit.geojson || null;

        return {
            ok: true,
            data: {
                found: true,
                osmId: `${hit.osm_type}/${hit.osm_id}`,
                displayName: hit.display_name || null,
                /* The tag pair — this is the classification, straight from the
                   database, in no particular language. */
                osmClass: hit.category || hit.class || null,
                osmType: hit.type || null,
                lat: Number(hit.lat),
                lng: Number(hit.lon),
                geometry: geom && geom.type !== 'Point' ? geom : null,
                geometryType: geom?.type || null,
                /* Rings, so a caller can decide whether it is worth drawing
                   before it deserialises a megabyte of coastline. */
                pointCount: countPoints(geom)
            }
        };
    } catch (error) {
        return {
            ok: false,
            reason: error.name === 'TimeoutError' ? 'timeout' : 'network',
            detail: error.message
        };
    }
}

function countPoints(geom) {
    if (!geom) return 0;
    const walk = (a) => (Array.isArray(a[0]) ? a.reduce((s, x) => s + walk(x), 0) : 1);
    return Array.isArray(geom.coordinates) ? walk(geom.coordinates) : 0;
}

const METHODS = { lookupShape };

async function invoke(method, params = {}) {
    const fn = METHODS[method];
    if (!fn) return { ok: false, reason: 'unknown-method', detail: String(method).slice(0, 40) };
    return fn(params || {});
}

module.exports = { invoke, methods: Object.keys(METHODS), lookupShape };
