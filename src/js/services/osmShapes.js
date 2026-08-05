/* =========================================================================
   CAMPUS AND INSTITUTION BOUNDARIES from OpenStreetMap.

   Google answers "what is here". OSM answers "what shape is it". This module
   is the second half, and it exists because a 120-hectare tech park and a
   two-person consultancy were being drawn as the same five-pixel dot.

   TWO THINGS COME BACK, and the second matters more than the first:

     geometry  — the polygon, so a campus can be outlined instead of pinned.
     osmClass  — the TAG, which is what a place is according to the database
     osmType     rather than according to its name. `landuse=commercial` says
                 "commercial estate" in Bengaluru, Bergisch Gladbach and
                 São Paulo alike. It is the replacement for the pile of
                 English regexes that used to do this job.

   RATE LIMITED IN THE MAIN PROCESS at one request per second, which is
   Nominatim's published policy. That is slow on purpose and it is why this
   module never bulk-resolves: shapes are fetched for the handful of things
   big enough to deserve an outline, not for every pin on the map. Asking for
   sixty polygons would take a minute and abuse a free service to draw
   sixty shapes nobody can tell apart at that zoom anyway.
   ========================================================================= */

/** Kinds that are worth an outline. A company office is a point; a campus,
    a university and an airport are areas, and drawing them as points is the
    bug this fixes. */
const OUTLINE_WORTHY = new Set(['campus', 'university', 'airport', 'hospital']);

/* OSM tags that mean "this is an estate, not a tenant". THIS is where a tech
   park is finally identified — not from its name and not from Google, which
   tags Bagmane Tech Park `corporate_office` exactly like the single office
   inside it. `landuse=commercial` is the database saying it is a commercial
   estate, in every language at once. */
const CAMPUS_TAGS = new Set([
    'landuse/commercial', 'landuse/industrial', 'landuse/institutional',
    'amenity/university', 'amenity/college', 'aeroway/aerodrome',
    'amenity/hospital', 'landuse/education'
]);

/** Did OSM confirm this is a campus, rather than us assuming it? */
export function osmConfirmsCampus(shape) {
    if (!shape?.osmClass || !shape?.osmType) return false;
    return CAMPUS_TAGS.has(`${shape.osmClass}/${shape.osmType}`);
}

export function createOsmShapes({ bridge }) {
    /* Shapes change on the timescale of construction projects, so a resolved
       boundary is cached for the session and beyond. This is also what keeps
       the one-per-second limit from being felt twice for the same campus. */
    const CACHE_KEY = 'jarvis.globe.osmShapes.v1';
    const cache = new Map();
    try {
        const raw = globalThis.localStorage?.getItem(CACHE_KEY);
        if (raw) for (const [k, v] of Object.entries(JSON.parse(raw))) cache.set(k, v);
    } catch { /* a corrupt cache costs a refetch, nothing more */ }

    function persist() {
        try {
            globalThis.localStorage?.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(cache)));
        } catch { /* quota: the shapes still work this session */ }
    }

    const available = () => !!bridge;

    /**
     * The boundary of one named place near a known point.
     *
     * Returns null rather than an approximation when OSM has no area for it —
     * a campus with no polygon stays a pin, and is not given a drawn circle
     * that would look like data and be invention.
     */
    async function shapeFor({ name, lat, lng, radiusKm = 5 } = {}) {
        if (!bridge || !name) return null;
        const key = `${String(name).toLowerCase()}|${lat?.toFixed?.(2)}|${lng?.toFixed?.(2)}`;
        if (cache.has(key)) return cache.get(key);

        const res = await bridge('lookupShape', { name, lat, lng, radiusKm }).catch(() => null);
        const found = res?.ok && res.data?.found ? res.data : null;
        const value = found
            ? {
                osmId: found.osmId,
                osmClass: found.osmClass,
                osmType: found.osmType,
                lat: found.lat,
                lng: found.lng,
                geometry: found.geometry,
                pointCount: found.pointCount
            }
            : null;
        cache.set(key, value);
        persist();
        return value;
    }

    /**
     * Outlines for the places in a list that deserve one.
     *
     * SEQUENTIAL BY NECESSITY — the rate limit is one per second, so this is
     * capped and reports what it drew. `onShape` fires per result so the globe
     * fills in as they arrive rather than after the whole minute.
     */
    async function outlinesFor(places, { limit = 12, onShape = null, requireCampusTag = true } = {}) {
        if (!bridge) return { shapes: [], skipped: 0, confirmed: 0, rejected: 0 };
        const take = (places || []).slice(0, limit);
        const shapes = [];
        let rejected = 0;
        for (const p of take) {
            const s = await shapeFor({ name: p.name, lat: p.lat, lng: p.lng }).catch(() => null);
            if (!s) continue;
            /* THE CONFIRMATION STEP. Google said "maybe a campus"; OSM either
               agrees by tag or it does not. A candidate OSM does not back is
               counted and left as an ordinary pin — it is not promoted on the
               strength of having matched a search for the word "park". */
            if (requireCampusTag && !osmConfirmsCampus(s)) { rejected++; continue; }
            if (!s.geometry) { rejected++; continue; }
            const withPlace = { ...s, name: p.name, kind: 'campus' };
            shapes.push(withPlace);
            onShape?.(withPlace);
        }
        return {
            shapes, rejected,
            confirmed: shapes.length,
            skipped: Math.max(0, (places || []).length - take.length)
        };
    }

    return { available, shapeFor, outlinesFor, osmConfirmsCampus, cacheSize: () => cache.size, OUTLINE_WORTHY };
}

export default { createOsmShapes };
