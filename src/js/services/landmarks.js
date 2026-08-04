// The WIRE labels that ring the target city.
//
// ---------------------------------------------------------------------------
// WHY THIS IS NOT GOOGLE PLACES BY DEFAULT
//
// `showLocation` has always accepted a `landmarks` array and nothing ever
// filled it, so the globe flew to a city and labelled exactly one thing: the
// city. The reference shot has a ring of named points around the target, which
// is what this fills in.
//
// Google's Places API (New) is the obvious source and it is wired up below —
// but it cannot be the default, for three reasons that come straight out of
// its own documentation:
//
//   1. It needs an API key AND an enabled billing account. A feed the user has
//      not configured is a feature that silently does nothing, which is the
//      failure mode this project keeps deleting (see dataFeeds.js).
//   2. Showing Places results on a map that is not a Google map requires the
//      Google logo, to their style guide. Our globe is Natural Earth vectors,
//      so that obligation lands on us the moment the provider is switched on.
//   3. Places content may not be cached or stored — only `place_id` is exempt.
//      Jarvis is local-first and caches aggressively, so the Google path here
//      deliberately BYPASSES the cache rather than quietly breaking the terms.
//
// Wikipedia's geosearch has none of those strings: no key, no billing, no
// caching prohibition, and it returns precisely the kind of thing that deserves
// a label on a command centre — bridges, towers, stations, museums — rather
// than the restaurants and shops that dominate a Places search ranked by
// popularity. It ships on, and Google is there for anyone who wants it.
//
// OFFLINE IS NORMAL. A failed lookup returns an empty list, never throws. No
// landmarks is a slightly plainer globe; an exception here would abort the
// fly-to and leave the camera halfway.
// ---------------------------------------------------------------------------

import { distanceKm } from './dataFeeds.js';
import { normalise } from './geocode.js';

/* MediaWiki caps gsradius at 10 km. That is not a limitation worth working
   around: past 10 km the labels belong to the next town, not this one. */
const WIKI_MAX_RADIUS_M = 10000;
/* Places caps the circle at 50 km. */
const GOOGLE_MAX_RADIUS_M = 50000;

/**
 * Parse a MediaWiki geosearch response.
 *
 * Pure and separated from the fetch, for the same reason parseQuakes is: the
 * parsing is where the bugs live.
 */
export function parseWikiGeosearch(json) {
    const out = [];
    for (const r of json?.query?.geosearch || []) {
        if (!Number.isFinite(r?.lat) || !Number.isFinite(r?.lon)) continue;
        if (!r.title) continue;
        out.push({
            name: r.title,
            lat: r.lat,
            lng: r.lon,
            /* MediaWiki reports metres; everything else on the globe is km. */
            distanceKm: Number.isFinite(r.dist) ? r.dist / 1000 : null,
            source: 'wikipedia',
            url: r.pageid ? `https://en.wikipedia.org/?curid=${r.pageid}` : null
        });
    }
    return out;
}

/**
 * Parse a Places API (New) searchNearby response.
 *
 * Field names verified against the Place resource reference: coordinates live
 * in `location` as a LatLng, and the name in `displayName.text`.
 */
export function parseGooglePlaces(json) {
    const out = [];
    for (const p of json?.places || []) {
        const lat = p?.location?.latitude;
        const lng = p?.location?.longitude;
        const name = p?.displayName?.text;
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || !name) continue;
        out.push({
            name,
            lat,
            lng,
            distanceKm: null,
            source: 'google',
            types: Array.isArray(p.types) ? p.types : [],
            /* Exempt from the caching restriction, and the only part of a
               Places response that is — worth keeping for that reason alone. */
            placeId: p.id || null
        });
    }
    return out;
}

/**
 * Dedupe, measure and trim a candidate list.
 *
 * Wikipedia happily returns "Golden Gate Bridge" and "Golden Gate Bridge
 * (disambiguation)"-shaped near-duplicates, and a globe with the same label
 * stacked twice looks broken rather than busy.
 */
export function rankLandmarks(list, { lat, lng, limit = 5, minSeparationKm = 3, exclude = [] } = {}) {
    const seen = new Set();
    const out = [];
    for (const item of list || []) {
        if (!Number.isFinite(item?.lat) || !Number.isFinite(item?.lng)) continue;
        const key = normalise(item.name);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push({
            ...item,
            distanceKm: Number.isFinite(item.distanceKm)
                ? item.distanceKm
                : (Number.isFinite(lat) && Number.isFinite(lng)
                    ? distanceKm(lat, lng, item.lat, item.lng)
                    : null)
        });
    }
    /* Nearest first: the labels closest to the pin are the ones that read as
       "this place", and the leader lines stay short. */
    out.sort((a, b) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9));

    /* THEN SPREAD THEM OUT. Taking the five nearest results gives five labels
       from the same three blocks — flying to San Francisco returned Moscone
       Center, SFMOMA, Benu and the W, all within a kilometre of each other,
       and on screen they printed on top of one another as one unreadable
       smear. Keeping the nearest and then skipping anything too close to a
       label already chosen walks outward across the city instead, which is
       both legible and what the reference shot actually shows: bridge, island,
       wharf, downtown.

       Thinning is NOT allowed to fall back to the unthinned list when it comes
       up short. An earlier version did, and in a dense downtown — where every
       one of the fifty nearest articles is inside the separation floor — that
       fallback fired every time and handed back the same stacked cluster it
       was written to prevent. Two legible labels beat five printed on top of
       one another; only an empty result is worth the nearest-first list. */
    /* Points already on the map count as taken. The city pin is drawn
       separately from this list, so without seeding it here the nearest
       landmark lands on top of it and the two labels print through each other
       — "BENGALURU (OSM)" and "SOMETHING (GOOGLE)" overlapping read as one
       nonsense string with two source tags. */
    const spread = [];
    const taken = (exclude || []).filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lng));
    for (const item of out) {
        if (spread.length >= limit) break;
        const clash = spread.concat(taken)
            .some((s) => distanceKm(s.lat, s.lng, item.lat, item.lng) < minSeparationKm);
        if (!clash) spread.push(item);
    }
    return spread.length ? spread : out.slice(0, limit);
}

/** Read an optional Google key the same way every other renderer setting is read. */
function readGoogleKey(getSettings) {
    try {
        const s = getSettings();
        const key = s?.googleMapsApiKey;
        return typeof key === 'string' && key.trim() ? key.trim() : null;
    } catch {
        return null;
    }
}

export function createLandmarkService({
    fetchImpl = fetch,
    getSettings = () => JSON.parse(localStorage.getItem('jarvis_settings') || '{}'),
    /* Main-process Places call. PREFERRED over the in-renderer path below,
       because it keeps GOOGLE_MAPS_API_KEY in the main process where the
       credential vault rule says secrets belong. The renderer path survives
       only for `npm run dev` in a plain browser, where there is no bridge. */
    placesBridge = (typeof window !== 'undefined' ? window.electronAPI?.placesNearby : null)
} = {}) {
    /* Wikipedia results are cacheable, so asking for the same city twice costs
       one request. Google results are NOT put in here — see the header. */
    const cache = new Map();

    async function fetchWikipedia(lat, lng, { radiusKm, limit }) {
        const radius = Math.min(WIKI_MAX_RADIUS_M, Math.max(10, radiusKm * 1000));
        const url = 'https://en.wikipedia.org/w/api.php'
            + '?action=query&list=geosearch&format=json&origin=*'
            + `&gscoord=${lat}%7C${lng}`
            + `&gsradius=${Math.round(radius)}`
            /* Over-fetch hard, because thinning discards most of these: in a
               dense downtown the first twenty hits can all be one block. */
            + `&gslimit=${Math.min(50, Math.max(20, limit * 10))}`;
        const res = await fetchImpl(url, {
            headers: { 'Api-User-Agent': 'Jarvis/0.5 (local assistant; github.com/ashutosh0x)' },
            signal: AbortSignal.timeout?.(8000)
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return parseWikiGeosearch(await res.json());
    }

    async function fetchGoogle(lat, lng, { radiusKm, limit, key }) {
        const res = await fetchImpl('https://places.googleapis.com/v1/places:searchNearby', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Goog-Api-Key': key,
                /* The field mask is REQUIRED and it is also the bill: asking
                   for fields we do not draw costs money for nothing. */
                'X-Goog-FieldMask': 'places.id,places.displayName,places.location,places.types'
            },
            body: JSON.stringify({
                locationRestriction: {
                    circle: {
                        center: { latitude: lat, longitude: lng },
                        radius: Math.min(GOOGLE_MAX_RADIUS_M, Math.max(1, radiusKm * 1000))
                    }
                },
                includedTypes: ['tourist_attraction', 'museum', 'park', 'stadium'],
                /* Landmarks, not the nearest doorway. */
                rankPreference: 'POPULARITY',
                maxResultCount: Math.min(20, Math.max(1, limit * 2))
            }),
            signal: AbortSignal.timeout?.(8000)
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return parseGooglePlaces(await res.json());
    }

    const providers = {
        wikipedia: { name: 'Wikipedia geosearch', configured: true, state: 'idle', attribution: 'Wikipedia' },
        google: {
            name: 'Google Places',
            configured: false,
            state: 'needs an API key and a billing account',
            attribution: 'Google',
            /* Their policy: on a non-Google map the LOGO is required, not just
               the word. Surfaced so the caller cannot enable this by accident
               and quietly be out of terms. */
            logoRequired: true
        }
    };

    /**
     * Landmarks near a point.
     *
     * @returns {Promise<{items: Array, source: string|null, attribution: string|null}>}
     */
    async function near(lat, lng, { radiusKm = 10, limit = 5, exclude = [] } = {}) {
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
            return { items: [], source: null, attribution: null };
        }

        /* Bridge first: it knows whether main has a key without the renderer
           ever seeing one. `no-key` is a normal answer, not a failure. */
        if (placesBridge) {
            try {
                const res = await placesBridge({ lat, lng, radiusM: radiusKm * 1000, limit: limit * 4 });
                if (res?.ok) {
                    providers.google.configured = true;
                    providers.google.state = 'live';
                    /* Deliberately not cached — their terms forbid it. */
                    return {
                        items: rankLandmarks(parseGooglePlaces(res.data), { lat, lng, limit, exclude }),
                        source: 'google', attribution: 'Google'
                    };
                }
                providers.google.configured = res?.reason !== 'no-key';
                providers.google.state = res?.reason === 'no-key'
                    ? 'needs an API key and a billing account'
                    /* Google's own words for why, kept verbatim. */
                    : `${res?.reason}${res?.detail ? ` — ${res.detail}` : ''}`;
            } catch (e) {
                providers.google.state = `bridge failed: ${e.message}`;
            }
            /* Any miss falls through to Wikipedia: a bad key should degrade
               the labels, not delete them. */
        } else {
            const key = readGoogleKey(getSettings);
            providers.google.configured = !!key;
            if (key) {
                try {
                    const items = rankLandmarks(await fetchGoogle(lat, lng, { radiusKm, limit, key }), { lat, lng, limit, exclude });
                    providers.google.state = 'live';
                    return { items, source: 'google', attribution: 'Google' };
                } catch (e) {
                    providers.google.state = `unreachable: ${e.message}`;
                }
            }
        }

        const cacheKey = `${lat.toFixed(3)},${lng.toFixed(3)},${radiusKm},${limit}`;
        if (cache.has(cacheKey)) return cache.get(cacheKey);

        try {
            const items = rankLandmarks(await fetchWikipedia(lat, lng, { radiusKm, limit }), { lat, lng, limit, exclude });
            providers.wikipedia.state = 'live';
            const result = { items, source: 'wikipedia', attribution: 'Wikipedia' };
            cache.set(cacheKey, result);
            return result;
        } catch (e) {
            providers.wikipedia.state = navigator?.onLine === false ? 'offline' : `unreachable: ${e.message}`;
            /* No landmarks is a plainer globe, not a broken one. */
            return { items: [], source: null, attribution: null };
        }
    }

    /** What is actually available, in words. */
    function status() {
        /* With the bridge in play the renderer cannot see whether main holds a
           key, so `configured` is whatever the last call learned rather than a
           guess from settings — which would always read false and report a
           working provider as unconfigured. */
        if (!placesBridge) providers.google.configured = !!readGoogleKey(getSettings);
        return Object.entries(providers).map(([k, p]) => ({
            key: k, name: p.name, configured: p.configured, state: p.state,
            attribution: p.attribution, logoRequired: !!p.logoRequired
        }));
    }

    return { near, status, providers };
}

export default { createLandmarkService, parseWikiGeosearch, parseGooglePlaces, rankLandmarks };
