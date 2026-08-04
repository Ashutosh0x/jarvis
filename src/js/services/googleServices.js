// Google Maps Platform, from the renderer's side.
//
// ---------------------------------------------------------------------------
// THE RENDERER NEVER HOLDS THE KEY
//
// Every call here goes through the `google-maps` bridge to the main process,
// which owns GOOGLE_MAPS_API_KEY. This module's job is to ask for the right
// thing and to turn the answers into the few lines the globe actually shows.
//
// THE FORMATTING IS PURE AND EXPORTED SEPARATELY from the fetching. Every bug
// worth catching here is in the shaping — a null temperature rendered as 0°C,
// an offset applied in the wrong direction — and none of it needs a network to
// test. The `describe*` functions take parsed JSON and return strings.
//
// ABSENT IS NOT ZERO. If Google did not answer for a field, that field is
// omitted from the line rather than printed as a zero or an em-dash pretending
// to be data. A dossier with two facts says two facts.
// ---------------------------------------------------------------------------

/** Round to a sensible number of places without printing "12.000001". */
const r1 = (n) => Math.round(n * 10) / 10;

/**
 * Local time at a place, from the IANA offset.
 *
 * Computed from the offset rather than `toLocaleString(timeZone)` because the
 * offset is what Google returned and is already correct for DST on the day
 * asked about; re-deriving it from a zone id would be a second source of truth
 * that can disagree with the first.
 */
export function localTime(utcOffsetSec, now = new Date()) {
    if (!Number.isFinite(utcOffsetSec)) return null;
    const shifted = new Date(now.getTime() + utcOffsetSec * 1000);
    const hh = String(shifted.getUTCHours()).padStart(2, '0');
    const mm = String(shifted.getUTCMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
}

/**
 * One line of ground truth for the status bar.
 *
 * Only the parts that answered appear. An empty dossier yields null, and the
 * caller shows nothing rather than an empty label.
 */
export function describeDossier(d, now = new Date()) {
    if (!d) return null;
    const bits = [];
    const t = localTime(d.utcOffsetSec, now);
    if (t) bits.push(`${t} local`);
    if (Number.isFinite(d.temperatureC)) {
        bits.push(`${r1(d.temperatureC)}°C${d.condition ? `, ${String(d.condition).toLowerCase()}` : ''}`);
    } else if (d.condition) {
        bits.push(String(d.condition).toLowerCase());
    }
    if (Number.isFinite(d.elevationM)) bits.push(`${Math.round(d.elevationM)} m elevation`);
    if (Number.isFinite(d.aqi)) bits.push(`AQI ${d.aqi}${d.aqiCategory ? ` (${String(d.aqiCategory).replace(/ air quality$/i, '')})` : ''}`);
    if (d.streetViewDate) bits.push(`street view ${d.streetViewDate}`);
    return bits.length ? bits.join(' · ') : null;
}

/**
 * How wide, in kilometres, is the thing that was found?
 *
 * Taken from the viewport Google returns, which is REAL data about the extent
 * of the place — Japan is ~3,000 km across and a doorway is metres. Deriving
 * the camera framing from this is why there is no table anywhere mapping
 * "country" to a zoom number.
 */
export function spanKmFromViewport(viewport) {
    const lo = viewport?.low, hi = viewport?.high;
    if (!lo || !hi) return null;
    const dLat = Math.abs(hi.latitude - lo.latitude);
    const dLng = Math.abs(hi.longitude - lo.longitude);
    if (!Number.isFinite(dLat) || !Number.isFinite(dLng)) return null;
    const midLat = ((hi.latitude + lo.latitude) / 2) * Math.PI / 180;
    /* Degrees of longitude narrow towards the poles; ignoring that makes
       Norway look wider than the equator. */
    const kmLat = dLat * 111.32;
    const kmLng = dLng * 111.32 * Math.cos(midLat);
    return Math.max(kmLat, Math.abs(kmLng));
}

/**
 * Camera distance that frames a thing of this size.
 *
 * Continuous rather than bucketed: a state and a small country differ by
 * degree, not in kind. Clamped at both ends because the globe carries no
 * street-level geometry — flying closer than the floor shows a blank sphere,
 * and further than the ceiling loses the planet.
 */
export function cameraDistanceFor(spanKm, radius = 5) {
    if (!Number.isFinite(spanKm) || spanKm <= 0) return radius * 1.9;
    const d = radius * (1.15 + 3.0 * Math.sqrt(Math.min(1, spanKm / 20000)));
    return Math.max(radius * 1.4, Math.min(radius * 4, d));
}

/**
 * Geocoding v4 -> the shape the globe speaks.
 *
 * Field names are lower camel case in v4 (`addressComponents`, `formattedAddress`)
 * where v3 used snake case, which is the migration's main trap.
 */
export function parseGeocodeV4(json) {
    const hit = json?.results?.[0];
    const loc = hit?.location;
    if (!Number.isFinite(loc?.latitude) || !Number.isFinite(loc?.longitude)) return null;
    const comps = hit.addressComponents || [];
    const pick = (type) => comps.find((c) => (c.types || []).includes(type))?.longText;
    /* Name at the granularity that was ACTUALLY found. Preferring the locality
       unconditionally labelled "MG Road Bengaluru" as plain "Bengaluru" —
       correct about the city and useless as a label for the thing asked for.
       Anything resolved more precisely than a locality is named by its own
       first address line instead. */
    const fine = hit.granularity === 'ROOFTOP' || hit.granularity === 'GEOMETRIC_CENTER'
        || (hit.types || []).some((t) => ['route', 'premise', 'street_address', 'subpremise', 'intersection'].includes(t));
    const firstLine = String(hit.formattedAddress || '').split(',')[0].trim();
    const name = (fine && firstLine)
        ? firstLine
        : (pick('locality') || pick('administrative_area_level_1') || pick('country') || firstLine);
    const span = spanKmFromViewport(hit.viewport);
    return {
        name,
        lat: loc.latitude,
        lng: loc.longitude,
        country: pick('country') || '',
        types: hit.types || [],
        granularity: hit.granularity || null,
        spanKm: span,
        formatted: hit.formattedAddress || name,
        /* ROOFTOP and GEOMETRIC_CENTER are exact; APPROXIMATE is a centroid,
           which is exactly right for a country and still fine for a city. */
        score: hit.granularity === 'ROOFTOP' ? 0.99 : 0.95,
        source: 'google'
    };
}

/* Legal-entity suffixes across the markets the globe is likely to visit, plus
   the words companies put in their trading names. A place whose name carries
   one of these is almost certainly a company; a hotel or a shopping complex is
   not. Kept broad on purpose — Pvt Ltd (India), LLC/Inc (US), Ltd/PLC (UK),
   GmbH/AG (Germany), Pte (Singapore), Oy (Finland), and so on. */
const COMPANY_SUFFIX = /\b(?:pvt\.?\s*ltd|private\s+limited|ltd\.?|limited|llc|l\.l\.c|inc\.?|incorporated|corp\.?|corporation|co\.?|company|plc|gmbh|ag|s\.?a\.?|s\.?r\.?l|b\.?v|pte\.?\s*ltd|pte|oy|ab|as|sdn\.?\s*bhd|pty\.?\s*ltd|llp)\b/i;
/* Words that name a tech/services company even without a legal suffix. */
const COMPANY_WORD = /\b(technolog(?:y|ies)|systems?|solutions?|software|labs?|digital|infotech|consulting|networks?|robotics|analytics|cyber|semiconductors?|electronics)\b/i;
/* Google place types that are companies rather than venues. */
const COMPANY_TYPE = new Set(['corporate_office', 'coworking_space', 'business_center', 'manufacturer', 'software_company', 'consultant']);

/**
 * Does this result look like an actual company?
 *
 * Exported and pure — this is the filter the user asked for, and it is exactly
 * the kind of rule worth pinning: too loose and hotels slip through, too tight
 * and "Google" or "IBM" (no suffix in their Google name) are dropped. A known
 * company TYPE is enough on its own; otherwise a legal suffix or a company word
 * in the name carries it.
 */
export function looksLikeCompany(name, types = []) {
    if ((types || []).some((t) => COMPANY_TYPE.has(t))) return true;
    const n = String(name || '');
    if (COMPANY_SUFFIX.test(n) || COMPANY_WORD.test(n)) return true;
    /* Venues that a business search drags in — reject these outright even if a
       stray word matched, so "Grand Hotel Technologies-adjacent" is not kept. */
    if (/\b(hotel|resort|mall|shopping|complex|restaurant|cafe|hospital|school|college|temple|church|station|museum|park|stadium)\b/i.test(n)) return false;
    return false;
}

/** Google's v3 geocode response -> the same shape. Kept for the v3 fallback. */
export function parseGeocode(json) {
    const hit = json?.results?.[0];
    if (!hit?.geometry?.location) return null;
    const loc = hit.geometry.location;
    if (!Number.isFinite(loc.lat) || !Number.isFinite(loc.lng)) return null;
    /* The locality component is the city; formatted_address is the whole
       postal string and makes a terrible map label. */
    const locality = (hit.address_components || [])
        .find((c) => (c.types || []).includes('locality'))?.long_name;
    const country = (hit.address_components || [])
        .find((c) => (c.types || []).includes('country'))?.long_name || '';
    return {
        name: locality || String(hit.formatted_address || '').split(',')[0],
        lat: loc.lat,
        lng: loc.lng,
        country,
        /* Google's own confidence: ROOFTOP/GEOMETRIC_CENTER are exact,
           APPROXIMATE is a region centroid — still fine for a city. */
        score: hit.geometry.location_type === 'APPROXIMATE' ? 0.9 : 0.97,
        source: 'google',
        placeId: hit.place_id || null
    };
}

/** Routes response -> "10.1 km, 21 min". */
export function describeRoute(json) {
    const route = json?.routes?.[0];
    if (!route) return null;
    const km = Number.isFinite(route.distanceMeters) ? r1(route.distanceMeters / 1000) : null;
    const secs = typeof route.duration === 'string' ? Number(route.duration.replace(/s$/, '')) : null;
    const mins = Number.isFinite(secs) ? Math.round(secs / 60) : null;
    if (km === null && mins === null) return null;
    return [km !== null ? `${km} km` : null, mins !== null ? `${mins} min` : null]
        .filter(Boolean).join(', ');
}

export function createGoogleServices({
    bridge = (typeof window !== 'undefined' ? window.electronAPI?.googleMaps : null)
} = {}) {
    /* Cacheable: elevation and time zone do not change, weather and air
       quality change slowly. Places content is NOT cached anywhere — their
       terms forbid it, which is why placesNearby is not routed through here. */
    const cache = new Map();
    const TTL = { dossier: 10 * 60 * 1000, geocode: 24 * 60 * 60 * 1000 };

    const available = () => !!bridge;

    async function callCached(method, params, ttl) {
        const k = `${method}:${JSON.stringify(params)}`;
        const hit = cache.get(k);
        if (hit && Date.now() - hit.at < ttl) return hit.value;
        const value = await bridge(method, params);
        if (value?.ok) cache.set(k, { at: Date.now(), value });
        return value;
    }

    /**
     * Name -> coordinates, as a FALLBACK behind the offline gazetteer.
     *
     * This is what closes the gaps the bundled Natural Earth data has: it has
     * "New Delhi" but not "Delhi", and no Trichardt at all.
     */
    async function geocode(query) {
        if (!bridge || !query) return null;
        const res = await callCached('geocode', { address: String(query) }, TTL.geocode);
        if (!res?.ok) return null;
        /* v4 first because that is what main asks for; v3 shape only appears
           when main had to fall back, and it is told apart by its own field
           names rather than by a flag that could drift out of step. */
        return parseGeocodeV4(res.data) || parseGeocode(res.data);
    }

    /** Coordinates -> place name. */
    async function reverseGeocode(lat, lng) {
        if (!bridge) return null;
        const res = await bridge('reverseGeocode', { lat, lng });
        return res?.ok ? parseGeocode(res.data) : null;
    }

    /** Everything true at a point, in one round trip. */
    async function dossier(lat, lng) {
        if (!bridge) return null;
        const res = await callCached('dossier', { lat, lng }, TTL.dossier);
        return res?.ok ? res.data : null;
    }

    async function route(fromLat, fromLng, toLat, toLng, travelMode = 'DRIVE') {
        if (!bridge) return null;
        const res = await bridge('route', { fromLat, fromLng, toLat, toLng, travelMode });
        return res?.ok ? describeRoute(res.data) : null;
    }

    /** A flat map thumbnail as a data URI — no key ever reaches the DOM. */
    async function staticMap(lat, lng, opts = {}) {
        if (!bridge) return null;
        const res = await bridge('staticMap', { lat, lng, ...opts });
        return res?.ok ? res.data.dataUri : null;
    }

    async function findPlace(query) {
        if (!bridge || !query) return null;
        const res = await bridge('placesText', { query: String(query), limit: 1 });
        const p = res?.ok ? res.data?.places?.[0] : null;
        if (!p?.location) return null;
        return {
            name: p.displayName?.text || String(query),
            lat: p.location.latitude,
            lng: p.location.longitude,
            address: p.formattedAddress || '',
            source: 'google'
        };
    }

    /**
     * Companies matching a query near a point, as globe markers.
     *
     * COORDINATE-DRIVEN, so it works at any place without a name baked in: the
     * query ("technology companies") is biased to the target's coordinates, and
     * `radiusM` scales with the place. That is the whole "companies everywhere"
     * algorithm — no per-city list, no hardcoding.
     *
     * Filtered by `looksLikeCompany` to keep incorporated entities and drop the
     * hotels, malls and civic buildings a business search picks up around them.
     */
    async function searchCompanies(query, { pages = 2, lat, lng, radiusM, strict = true } = {}) {
        if (!bridge) return [];
        const res = await bridge('placesCompanies', { query: String(query || 'companies'), pages, lat, lng, radiusM });
        if (!res?.ok) return [];
        const out = [];
        const seen = new Set();
        for (const p of res.data?.places || []) {
            const plat = p?.location?.latitude, plng = p?.location?.longitude;
            const name = p?.displayName?.text;
            if (!Number.isFinite(plat) || !Number.isFinite(plng) || !name) continue;
            const key = p.id || name.toLowerCase();
            if (seen.has(key)) continue;      // Google can repeat across pages
            seen.add(key);
            const types = p.types || [];
            if (strict && !looksLikeCompany(name, types)) continue;
            out.push({
                id: p.id || null,
                name,
                lat: plat, lng: plng,
                address: p.formattedAddress || null,
                website: p.websiteUri || null,
                type: types[0] || null
            });
        }
        return out;
    }

    return { available, geocode, reverseGeocode, dossier, route, staticMap, findPlace, searchCompanies };
}

export default {
    createGoogleServices, describeDossier, parseGeocode, describeRoute, localTime
};
