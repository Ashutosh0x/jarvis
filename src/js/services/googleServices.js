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

/* =========================================================================
   CLASSIFICATION BY TAG, NOT BY NAME.

   WHAT THIS REPLACED AND WHY. The previous version of this file matched
   names: a list of legal suffixes (Pvt Ltd, GmbH, LLC), a list of industry
   words (technology, systems, solutions), and a regex for "tech park". It
   worked in Bengaluru and it worked in English, and that was the whole
   problem — "Technologiepark Bergisch Gladbach", "テクノパーク",
   "Parque Tecnológico de Andalucía" and "Parc Technologique" all failed it,
   and every new country meant another line in another list. A rule that has
   to grow by one entry per language is not a rule, it is a backlog.

   Google returns a `types` array on every place and OSM returns `class`/`type`
   on every element. Both are STRUCTURED, both are language-independent, and
   both are already paid for. `corporate_office` means the same thing in Tokyo
   and Munich; "Ltd" does not.

   The scores below are not thresholds pretending to be certainty. They are
   evidence weights: a place carrying `corporate_office` is strong evidence of
   a company, `point_of_interest` alone is no evidence at all, and the caller
   decides what to do with a middling number rather than being handed a
   yes/no it cannot argue with.
   ========================================================================= */

/* Google Place types that are, on their own, decisive. */
const TYPE_EVIDENCE = {
    /* --- companies --- */
    corporate_office: { kind: 'company', weight: 0.95 },
    software_company: { kind: 'company', weight: 0.95 },
    manufacturer: { kind: 'company', weight: 0.85 },
    consultant: { kind: 'company', weight: 0.7 },
    coworking_space: { kind: 'company', weight: 0.6 },
    business_center: { kind: 'company', weight: 0.6 },
    insurance_agency: { kind: 'company', weight: 0.6 },
    accounting: { kind: 'company', weight: 0.6 },
    moving_company: { kind: 'company', weight: 0.6 },
    general_contractor: { kind: 'company', weight: 0.55 },
    electrician: { kind: 'company', weight: 0.5 },
    finance: { kind: 'company', weight: 0.5 },
    /* --- campuses: the thing a tech park IS, in tag form --- */
    industrial_park: { kind: 'campus', weight: 0.95 },
    business_park: { kind: 'campus', weight: 0.95 },
    office_park: { kind: 'campus', weight: 0.95 },
    premise: { kind: 'campus', weight: 0.45 },
    subpremise: { kind: 'campus', weight: 0.35 },
    /* --- institutions, worth their own marker rather than a reject --- */
    university: { kind: 'university', weight: 0.95 },
    school: { kind: 'school', weight: 0.9 },
    hospital: { kind: 'hospital', weight: 0.95 },
    airport: { kind: 'airport', weight: 0.98 },
    international_airport: { kind: 'airport', weight: 0.98 },
    /* --- venues: evidence AGAINST being a company office --- */
    shopping_mall: { kind: 'venue', weight: 0.9 },
    department_store: { kind: 'venue', weight: 0.85 },
    restaurant: { kind: 'venue', weight: 0.95 },
    cafe: { kind: 'venue', weight: 0.95 },
    lodging: { kind: 'venue', weight: 0.9 },
    hotel: { kind: 'venue', weight: 0.9 },
    tourist_attraction: { kind: 'venue', weight: 0.8 },
    park: { kind: 'venue', weight: 0.9 },
    place_of_worship: { kind: 'venue', weight: 0.95 },
    stadium: { kind: 'venue', weight: 0.9 },
    museum: { kind: 'venue', weight: 0.9 },
    transit_station: { kind: 'venue', weight: 0.8 },
    store: { kind: 'venue', weight: 0.5 }
};

/* OpenStreetMap class/type -> the same vocabulary. OSM is where the campus
   POLYGONS come from, and `landuse=commercial` is what Manyata Tech Park
   actually is in the database — no name matching involved. */
const OSM_EVIDENCE = {
    'landuse/commercial': { kind: 'campus', weight: 0.9 },
    'landuse/industrial': { kind: 'campus', weight: 0.8 },
    'landuse/retail': { kind: 'venue', weight: 0.8 },
    'office/company': { kind: 'company', weight: 0.95 },
    'office/it': { kind: 'company', weight: 0.95 },
    'office/research': { kind: 'company', weight: 0.85 },
    'office/coworking': { kind: 'company', weight: 0.7 },
    'amenity/university': { kind: 'university', weight: 0.95 },
    'amenity/college': { kind: 'university', weight: 0.85 },
    'amenity/hospital': { kind: 'hospital', weight: 0.95 },
    'amenity/research_institute': { kind: 'company', weight: 0.8 },
    'aeroway/aerodrome': { kind: 'airport', weight: 0.98 },
    'building/office': { kind: 'company', weight: 0.6 },
    'building/commercial': { kind: 'company', weight: 0.5 }
};

/**
 * What is this place, and how sure are we?
 *
 * Pure, and takes only structured fields — no name is read. Returns the
 * best-supported kind with its evidence weight, plus everything that was
 * considered, so a caller can show WHY a pin is the colour it is instead of
 * asking the user to trust it.
 *
 * `websiteUri` is a weak independent signal: a place with its own domain is
 * more likely to be a business than a bus stop. It nudges, it does not decide.
 *
 * @param {{types?: string[], osmClass?: string, osmType?: string, website?: string|null}} place
 * @returns {{kind: string, confidence: number, evidence: string[]}}
 */
export function classifyPlace({ types = [], osmClass = null, osmType = null, website = null } = {}) {
    const scores = new Map();
    const evidence = [];
    const add = (kind, weight, why) => {
        scores.set(kind, Math.max(scores.get(kind) || 0, weight));
        evidence.push(why);
    };

    for (const t of types || []) {
        const e = TYPE_EVIDENCE[t];
        if (e) add(e.kind, e.weight, `google:${t}`);
    }
    if (osmClass && osmType) {
        const e = OSM_EVIDENCE[`${osmClass}/${osmType}`];
        if (e) add(e.kind, e.weight, `osm:${osmClass}=${osmType}`);
    }
    /* A campus and the companies inside it both look like "company" to a
       coarse reading. When something is tagged BOTH, the campus tag is the
       more specific fact and should win. */
    if (scores.has('campus') && scores.has('company')) {
        scores.set('campus', Math.max(scores.get('campus'), scores.get('company') + 0.01));
    }
    if (website && scores.has('company')) {
        add('company', Math.min(0.98, scores.get('company') + 0.05), 'has-website');
    }

    let best = 'unknown', bestScore = 0;
    for (const [k, v] of scores) if (v > bestScore) { best = k; bestScore = v; }

    /* THE MEASUREMENT THAT SHAPED THIS FUNCTION.
       Sixty real Bengaluru results were pulled from the live API and their
       tags counted: only 27 of 60 carried ANY type more specific than
       `point_of_interest, establishment`. Classifying on tags alone would
       therefore have thrown away 33 genuine companies — a 55% recall loss,
       traded for a purity nobody asked for.

       But 51 of those 60 had a `websiteUri`. A place with its own domain is a
       business; that is a structural fact about the record, not a word in its
       name, so it generalises the way the old regex never could. It is
       weaker evidence than a `corporate_office` tag and is scored lower to
       say so — the caller sees 0.55, not a confident yes.

       A place with no useful tag AND no website stays `unknown`. Nine of the
       sixty land there, and they are left off rather than waved through. */
    if (best === 'unknown' && website) {
        return { kind: 'company', confidence: 0.55, evidence: ['has-website', 'no-specific-type'] };
    }
    if (!scores.size) return { kind: 'unknown', confidence: 0, evidence: [] };
    return { kind: best, confidence: Math.min(1, bestScore), evidence };
}

/**
 * Does this result look like an actual company?
 *
 * Exported and pure — this is the filter the user asked for, and it is exactly
 * the kind of rule worth pinning: too loose and hotels slip through, too tight
 * and "Google" or "IBM" (no suffix in their Google name) are dropped. A known
 * company TYPE is enough on its own; otherwise a legal suffix or a company word
 * in the name carries it.
 */
/**
 * Does this result belong on the map as a business?
 *
 * A thin, honest wrapper over `classifyPlace` kept because callers read
 * better for it. NOTE THE SIGNATURE CHANGE: it no longer takes a name,
 * because it no longer looks at one. Anything classified as a venue is out;
 * a company or a campus is in; an unknown is in only if Google gave it a
 * website, which is the weakest evidence this module will act on.
 */
export function looksLikeCompany(types = [], { website = null } = {}) {
    const c = classifyPlace({ types, website });
    if (c.kind === 'venue') return false;
    if (c.kind === 'company' || c.kind === 'campus') return c.confidence >= 0.4;
    return false;
}

/** Is this the campus rather than a tenant of it? Tag-driven, so it holds in
    any language — `industrial_park` and `landuse=commercial` are not English. */
export function looksLikeTechPark(types = [], { osmClass = null, osmType = null } = {}) {
    return classifyPlace({ types, osmClass, osmType }).kind === 'campus';
}

/* Country as printed in a market-cap table -> the ISO 3166-1 alpha-2 code the
   Places API wants. Only the spellings that differ from the country's own name
   need to be here; anything else falls through to `undefined`, which means
   "search without a country filter" rather than a wrong guess. Written out
   because a market-cap table says "S. Korea" and "UAE", and there is no rule
   that derives "KR" from "S. Korea". */
const REGION_CODES = {
    usa: 'US', 'united states': 'US', uk: 'GB', 'united kingdom': 'GB',
    india: 'IN', china: 'CN', japan: 'JP', germany: 'DE', france: 'FR',
    netherlands: 'NL', switzerland: 'CH', canada: 'CA', australia: 'AU',
    italy: 'IT', spain: 'ES', sweden: 'SE', norway: 'NO', denmark: 'DK',
    finland: 'FI', ireland: 'IE', belgium: 'BE', austria: 'AT', portugal: 'PT',
    greece: 'GR', poland: 'PL', 'czech republic': 'CZ', hungary: 'HU',
    romania: 'RO', russia: 'RU', turkey: 'TR', israel: 'IL', brazil: 'BR',
    mexico: 'MX', chile: 'CL', colombia: 'CO', argentina: 'AR', peru: 'PE',
    'south africa': 'ZA', 'new zealand': 'NZ', singapore: 'SG',
    malaysia: 'MY', thailand: 'TH', indonesia: 'ID', philippines: 'PH',
    vietnam: 'VN', taiwan: 'TW', 'hong kong': 'HK', 'south korea': 'KR',
    's. korea': 'KR', 'saudi arabia': 'SA', 's. arabia': 'SA', uae: 'AE',
    qatar: 'QA', kuwait: 'KW', bahrain: 'BH', oman: 'OM', luxembourg: 'LU',
    bermuda: 'BM', jersey: 'JE', 'cayman islands': 'KY', kazakhstan: 'KZ',
    pakistan: 'PK', bangladesh: 'BD', egypt: 'EG', nigeria: 'NG', kenya: 'KE',
    morocco: 'MA', ukraine: 'UA', iceland: 'IS', cyprus: 'CY', malta: 'MT',
    monaco: 'MC', panama: 'PA', uruguay: 'UY', 'costa rica': 'CR'
};

/** "S. Korea" -> "KR". Undefined when unknown, which the caller reads as
    "do not filter by country" rather than as a guess. */
export function regionCodeFor(country) {
    if (!country) return undefined;
    const k = String(country).trim().toLowerCase();
    return REGION_CODES[k] || (/^[a-z]{2}$/.test(k) ? k.toUpperCase() : undefined);
}

/* Resolved head offices, kept across sessions.
   EVERY MISS IN HERE IS MONEY. One company is one billed Text Search, so a
   2,000-row table re-resolved on every launch is 2,000 requests a launch.
   Negative results are cached too — a name Google genuinely cannot place does
   not get re-bought every time the list is opened. */
const HQ_CACHE_KEY = 'jarvis.globe.hqCache.v1';
const hqCache = new Map();
try {
    const raw = globalThis.localStorage?.getItem(HQ_CACHE_KEY);
    if (raw) for (const [k, v] of Object.entries(JSON.parse(raw))) hqCache.set(k, v);
} catch { /* a corrupt cache is a slow start, not a broken app */ }

function saveHqCache() {
    try {
        globalThis.localStorage?.setItem(HQ_CACHE_KEY, JSON.stringify(Object.fromEntries(hqCache)));
    } catch { /* quota or no storage: the lookups still worked this session */ }
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
    async function searchCompanies(query, {
        pages = 2, lat, lng, radiusM, strict = true, keep = 'company', maxKm = null
    } = {}) {
        if (!bridge) return [];
        const res = await bridge('placesCompanies', { query: String(query || 'companies'), pages, lat, lng, radiusM });
        if (!res?.ok) return [];
        const out = [];
        const seen = new Set();
        let discarded = 0;
        for (const p of res.data?.places || []) {
            const plat = p?.location?.latitude, plng = p?.location?.longitude;
            const name = p?.displayName?.text;
            if (!Number.isFinite(plat) || !Number.isFinite(plng) || !name) continue;

            /* LOCATION BIAS IS A HINT, NOT A FENCE, and Google means it. A
               London-biased search for "IT park software technology park"
               returned 6 of 8 results in India, up to 8,366 km away, because
               "Software Technology Parks of India" simply outranks anything in
               London for that string. "tech park" biased to London returned UA
               Tech Park in Tucson, 8,532 km out.

               Nothing downstream could survive that. The caller frames the
               camera on the CENTROID of what comes back, so a handful of
               transcontinental strays drag the view into the North Atlantic and
               the real London results become a sub-pixel speck off-screen — the
               count is honest and the map shows nothing.

               Why not `locationRestriction`, which is a real fence: its circle
               caps at 50 km, so it cannot express "companies in India". The
               bound therefore lives here, scaled by the caller to the place it
               actually asked about, and strays are COUNTED rather than silently
               dropped. */
            if (Number.isFinite(maxKm) && Number.isFinite(lat) && Number.isFinite(lng)) {
                if (haversineKm(lat, lng, plat, plng) > maxKm) { discarded++; continue; }
            }

            const key = p.id || name.toLowerCase();
            if (seen.has(key)) continue;      // Google can repeat across pages
            seen.add(key);
            const types = p.types || [];
            const website = p.websiteUri || null;
            /* Classified from tags, then filtered on what the caller asked for.
               The classification travels WITH the result rather than being
               thrown away after the filter, so the globe can colour a pin by
               what it is and say how sure it is. */
            const cls = classifyPlace({ types, website });
            if (strict) {
                /* GOOGLE IS NOT THE CAMPUS AUTHORITY, and measuring proved it:
                   across a live "tech park" search, not one result carried
                   `industrial_park`, `business_park` or `office_park`. Google
                   tags Bagmane Tech Park `corporate_office` — the same tag it
                   gives a single tenant's office inside it. Demanding a campus
                   tag from Google therefore rejected every campus there is.

                   So a tech-park search returns CANDIDATES: anything that is
                   not a venue. OSM decides which of them are really campuses,
                   by `landuse=commercial`, and supplies the boundary at the
                   same time. Nothing is called a campus on Google's say-so. */
                if (keep === 'techpark' && cls.kind === 'venue') continue;
                if (keep === 'company' && (cls.kind === 'venue' || cls.confidence < 0.5)) continue;
            }
            out.push({
                id: p.id || null,
                name,
                lat: plat, lng: plng,
                address: p.formattedAddress || null,
                website,
                type: types[0] || null,
                types,
                kind: cls.kind,
                confidence: cls.confidence,
                evidence: cls.evidence
            });
        }
        if (discarded) {
            console.log(`[places] ${discarded} result(s) beyond ${Math.round(maxKm)} km of the target discarded`);
        }
        return out;
    }

    /* Great-circle distance. Local rather than imported so this module keeps
       its single dependency on the bridge and stays testable in node. */
    function haversineKm(lat1, lng1, lat2, lng2) {
        const R = 6371, toRad = (d) => (d * Math.PI) / 180;
        const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
        const s = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
        return 2 * R * Math.asin(Math.sqrt(s));
    }

    /**
     * The tech parks and IT campuses at a place.
     *
     * A SEPARATE QUERY, not a filter over the company results, because Google
     * does not return them for "technology companies" — one probe of Bengaluru
     * returned sixty companies and exactly one tech park, and that one only
     * because it happened to be typed `corporate_office`. Asking for the parks
     * by name is the only way to get the campuses the city is actually built
     * around. Two pages rather than three: there are tens of these in a city,
     * not hundreds, and the third page is a billed request for nothing.
     */
    async function searchTechParks({ lat, lng, radiusM, maxKm = null } = {}) {
        /* These are SEARCH TERMS, not classification rules — the distinction
           the old code got wrong. Google needs words to search with, and
           there is no tag-based "list everything tagged industrial_park near
           here" on Text Search. What comes back is then classified purely by
           its `types`, so a result that matches the words but is tagged
           `shopping_mall` is dropped, and one that never mentions "park" but
           carries `industrial_park` is kept. The words affect RECALL only;
           they have no say in what a result is judged to be. */
        const queries = ['tech park', 'IT park software technology park'];
        const merged = new Map();
        for (const q of queries) {
            const found = await searchCompanies(q, { pages: 2, lat, lng, radiusM, keep: 'techpark', maxKm })
                .catch(() => []);
            for (const p of found) merged.set(p.id || p.name.toLowerCase(), p);
        }
        return [...merged.values()];
    }

    /**
     * One named company -> the coordinates of its head office.
     *
     * `country` is the country as a HUMAN wrote it (the column in a market-cap
     * table: "S. Korea", "UAE"), mapped here to the ISO code the API wants.
     *
     * VERIFIED, NOT ASSUMED. The first candidate is not trusted blindly: the
     * ISO country on the result must match the country asked for, or the next
     * candidate is tried. If none match, this returns null and the caller
     * reports the company as unresolved — a company is left OFF the globe
     * rather than pinned to the wrong continent. That is the whole difference
     * between a map and a decoration.
     */
    async function resolveCompanyHQ(name, country) {
        if (!bridge || !name) return null;
        const want = regionCodeFor(country);
        const res = await bridge('placesCompanyHQ', { name, country: country || null, regionCode: want });
        if (!res?.ok) return null;
        const candidates = res.data?.candidates || [];
        if (!candidates.length) return null;
        /* No expected country means nothing to verify against, so the top hit
           stands — stated, not hidden, via `verified`. */
        const hit = want ? candidates.find((c) => c.countryCode === want) : candidates[0];
        if (!hit) return null;
        return {
            name,
            matchedName: hit.matchedName,
            lat: hit.lat,
            lng: hit.lng,
            address: hit.address,
            countryCode: hit.countryCode,
            country: country || null,
            /* True only when the result's own country came back equal to the
               one requested. A caller that wants to show only confirmed pins
               has the flag to do it with. */
            verified: !!(want && hit.countryCode === want),
            source: 'google-places'
        };
    }

    /**
     * A whole list of companies -> pins, resolved a few at a time.
     *
     * SEQUENTIAL-ISH ON PURPOSE. Each name is one billed Text Search, so a
     * thousand-row table is a thousand requests: the concurrency cap keeps
     * that from arriving as a thousand-deep burst, and `onResolved` lets the
     * globe draw each pin the moment it lands instead of showing nothing for
     * two minutes and then everything at once.
     *
     * The cache is the reason this is affordable to run twice. It is keyed on
     * name+country and persists, so re-running a list costs nothing for every
     * company already looked up — including the ones that came back empty,
     * which are cached as misses so a name Google cannot resolve is not
     * re-bought on every run.
     */
    async function resolveCompanyList(entries, { concurrency = 4, onResolved = null, limit = 0 } = {}) {
        const list = (entries || []).filter((e) => e && e.name);
        const wanted = limit > 0 ? list.slice(0, limit) : list;
        const resolved = [], unresolved = [];
        let cursor = 0, fromCache = 0, billed = 0;

        async function worker() {
            for (;;) {
                const i = cursor++;
                if (i >= wanted.length) return;
                const e = wanted[i];
                const key = `${e.name}|${e.country || ''}`.toLowerCase();
                let hit = hqCache.get(key);
                if (hit === undefined) {
                    hit = await resolveCompanyHQ(e.name, e.country).catch(() => null);
                    hqCache.set(key, hit);
                    billed++;
                } else {
                    fromCache++;
                }
                if (hit) {
                    /* The financials travel with the pin. The globe draws size
                       from marketCap and colour from todayChangePct, so losing
                       them here would silently flatten every marker to the
                       same grey dot — which looks like a working map and is
                       not one. */
                    const pin = {
                        ...hit,
                        ticker: e.ticker || null,
                        rank: e.rank ?? null,
                        marketCap: e.marketCap ?? null,
                        marketCapText: e.marketCapText ?? null,
                        price: e.price ?? null,
                        priceText: e.priceText ?? null,
                        todayChangePct: e.todayChangePct ?? null,
                        todayChangeText: e.todayChangeText ?? null
                    };
                    resolved.push(pin);
                    onResolved?.(pin, resolved.length, wanted.length);
                } else {
                    unresolved.push(e);
                }
            }
        }
        await Promise.all(Array.from({ length: Math.max(1, Math.min(8, concurrency)) }, worker));
        saveHqCache();
        return { resolved, unresolved, requested: wanted.length, fromCache, billed };
    }

    return {
        available, geocode, reverseGeocode, dossier, route, staticMap, findPlace,
        searchCompanies, searchTechParks, resolveCompanyHQ, resolveCompanyList,
        hqCacheSize: () => hqCache.size
    };
}

export default {
    createGoogleServices, describeDossier, parseGeocode, describeRoute, localTime
};
