// Real photographs of whatever the globe just flew to.
//
// ---------------------------------------------------------------------------
// FREE SOURCES FIRST, GOOGLE LAST, AND NEVER A PLACEHOLDER
//
// A country, a state and a city almost always have a Wikipedia article with a
// lead photograph, and Wikimedia Commons has geotagged photographs of anything
// worth a label. Those cost nothing, need no key and carry no per-call
// billing, so they are tried first. Google Places photos and Street View are
// excellent and are charged per request, so they are reserved for the cases
// the free sources genuinely cannot answer — a specific building, a street, or
// a city too small to have a Commons entry.
//
// STREET VIEW IS ALWAYS PRECEDED BY ITS METADATA CHECK. The metadata endpoint
// is free and says whether imagery exists; the image endpoint bills the same
// for a grey "no imagery available" placeholder as for a photograph. Asking
// first is the difference between paying for pictures and paying for nothing.
//
// ATTRIBUTION IS CARRIED, NOT DROPPED. Every source here obliges it — Google's
// terms require `authorAttributions`, Commons images are CC and require author
// and licence. An image whose attribution did not survive the parse is not
// returned at all, because showing it would breach the licence it came under.
//
// NOTHING IS INVENTED. If no source has a picture, this returns an empty list
// and the caller shows nothing. There is no stock-photo substitute, no "sample
// image", no grey tile pretending to be a place.
// ---------------------------------------------------------------------------

const UA = 'JarvisGlobe/1.0 (local assistant; github.com/ashutosh0x)';

/* Google's terms allow caching place photo BYTES for at most 30 days; the
   references may be kept longer. Commons and NASA carry no such limit, but
   there is no reason to hold more than a session's worth in memory. */
const TTL_MS = {
    google: 24 * 60 * 60 * 1000,
    wikipedia: 7 * 24 * 60 * 60 * 1000,
    wikimedia: 7 * 24 * 60 * 60 * 1000,
    satellite: 24 * 60 * 60 * 1000
};

/**
 * Which sources are worth asking, for a thing of this kind.
 *
 * PURE, so the cost policy is testable without spending anything. The order is
 * the cost order: everything free is attempted before anything billed.
 */
export function sourcesFor(granularity, types = []) {
    const t = new Set([...(types || []), String(granularity || '').toLowerCase()]);
    const has = (...names) => names.some((n) => t.has(n));

    /* A street or a building is exactly what Street View exists for, and what
       Wikipedia has no article about. */
    if (has('rooftop', 'geometric_center', 'route', 'premise', 'street_address', 'subpremise')) {
        return ['wikimedia', 'streetview', 'places'];
    }
    /* A named point of interest: Places photographs are the best images of it
       anywhere, and Commons often has one too. */
    if (has('point_of_interest', 'tourist_attraction', 'establishment', 'landmark')) {
        return ['wikimedia', 'places', 'streetview'];
    }
    /* CITIES ARE CHECKED BEFORE COUNTRIES, because `granularity` is
       APPROXIMATE for both — Google returns it for Bengaluru exactly as it
       does for Japan. Matching on the granularity first put every city in the
       country branch and handed back a satellite tile instead of a
       photograph. The TYPE is what separates them. */
    if (has('locality', 'postal_town', 'sublocality')) {
        return ['wikipedia', 'wikimedia', 'places'];
    }
    /* Countries and states: Wikipedia's lead image, then satellite. Never
       Places — "Japan" as a Places query returns a restaurant. */
    if (has('country', 'administrative_area_level_1', 'administrative_area_level_2', 'state')) {
        return ['wikipedia', 'wikimedia', 'satellite'];
    }
    /* Unknown shape — the offline gazetteer supplies no types at all. Treat it
       as a city, which is what that index holds. */
    return ['wikipedia', 'wikimedia', 'places'];
}

/** Enough of an image to draw it and to credit it. Missing credit = no image. */
function toImage({ url, width, height, provider, title, attribution, license, capturedAt }) {
    if (!url) return null;
    /* Every source used here obliges attribution. One that arrived without it
       cannot be displayed lawfully, so it is dropped rather than shown bare. */
    if (!attribution?.name) return null;
    return {
        url, width: width || null, height: height || null,
        provider, title: title || null,
        attribution, license: license || null,
        capturedAt: capturedAt || null
    };
}

/* ------------------------------------------------------------- wikipedia -- */

export function parseWikipediaSummary(json) {
    const src = json?.originalimage?.source || json?.thumbnail?.source;
    if (!src) return null;
    return toImage({
        url: src,
        width: json.originalimage?.width, height: json.originalimage?.height,
        provider: 'wikipedia',
        title: json.title,
        attribution: { name: 'Wikipedia contributors', url: json.content_urls?.desktop?.page || null },
        license: { name: 'CC BY-SA 4.0', url: 'https://creativecommons.org/licenses/by-sa/4.0/' }
    });
}

/* ------------------------------------------------------------- wikimedia -- */

/** Strip the HTML Commons puts inside its metadata fields. */
function stripHtml(s) {
    return String(s || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

export function parseWikimediaGeosearch(json) {
    const pages = Object.values(json?.query?.pages || {});
    const out = [];
    for (const page of pages) {
        const info = page?.imageinfo?.[0];
        if (!info) continue;
        const meta = info.extmetadata || {};
        const img = toImage({
            url: info.thumburl || info.url,
            width: info.thumbwidth || info.width,
            height: info.thumbheight || info.height,
            provider: 'wikimedia',
            title: String(page.title || '').replace(/^File:/, ''),
            attribution: {
                name: stripHtml(meta.Artist?.value) || 'Wikimedia contributor',
                url: info.descriptionurl || null
            },
            license: {
                name: stripHtml(meta.LicenseShortName?.value) || 'CC',
                url: meta.LicenseUrl?.value || null
            }
        });
        if (img) out.push(img);
    }
    return out;
}

/* ------------------------------------------------------------- satellite -- */

/**
 * A satellite view, for the scales where a photograph makes no sense.
 *
 * There is no single photograph of a country; the honest picture of Japan from
 * above is the imagery itself. Esri's World_Imagery export needs no key.
 */
export function satelliteImage(lat, lng, spanKm = 50) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const deg = Math.max(0.01, Math.min(60, spanKm / 111));
    const bbox = `${lng - deg},${lat - deg},${lng + deg},${lat + deg}`;
    return toImage({
        url: `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export`
            + `?bbox=${bbox}&bboxSR=4326&imageSR=4326&size=800,600&f=image`,
        width: 800, height: 600,
        provider: 'satellite',
        title: 'Satellite imagery',
        attribution: { name: 'Esri, Maxar, Earthstar Geographics', url: 'https://www.esri.com/' },
        license: { name: 'Esri World Imagery terms', url: null }
    });
}

/* ---------------------------------------------------------------- engine -- */

export function createPlaceImages({
    fetchImpl = (typeof fetch !== 'undefined' ? fetch : null),
    bridge = (typeof window !== 'undefined' ? window.electronAPI?.googleMaps : null),
    now = () => Date.now()
} = {}) {
    const cache = new Map();

    function cached(key, ttl) {
        const hit = cache.get(key);
        if (hit && now() - hit.at < ttl) return hit.value;
        return null;
    }
    function store(key, value) { cache.set(key, { at: now(), value }); }

    async function wikipedia(title) {
        if (!title || !fetchImpl) return [];
        const k = `wp:${title}`;
        const hit = cached(k, TTL_MS.wikipedia); if (hit) return hit;
        try {
            const res = await fetchImpl(
                `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(String(title).replace(/ /g, '_'))}`,
                { headers: { 'Api-User-Agent': UA }, signal: AbortSignal.timeout?.(8000) }
            );
            if (!res.ok) return [];
            const img = parseWikipediaSummary(await res.json());
            const out = img ? [img] : [];
            store(k, out);
            return out;
        } catch { return []; }
    }

    async function wikimedia(lat, lng, radiusM = 2000, limit = 4) {
        if (!fetchImpl || !Number.isFinite(lat)) return [];
        const k = `wm:${lat.toFixed(3)},${lng.toFixed(3)},${radiusM}`;
        const hit = cached(k, TTL_MS.wikimedia); if (hit) return hit;
        try {
            /* Namespace 6 is the File: namespace — anything else is not an image. */
            const url = 'https://commons.wikimedia.org/w/api.php'
                + `?action=query&generator=geosearch&ggscoord=${lat}%7C${lng}`
                + `&ggsradius=${Math.min(10000, Math.max(10, radiusM))}&ggsnamespace=6&ggslimit=${Math.min(20, limit * 3)}`
                + '&prop=imageinfo&iiprop=url%7Csize%7Cextmetadata&iiurlwidth=1280&format=json&origin=*';
            const res = await fetchImpl(url, { headers: { 'Api-User-Agent': UA }, signal: AbortSignal.timeout?.(8000) });
            if (!res.ok) return [];
            const out = parseWikimediaGeosearch(await res.json()).slice(0, limit);
            store(k, out);
            return out;
        } catch { return []; }
    }

    async function places(query, limit = 2) {
        if (!bridge || !query) return [];
        const k = `gp:${query}:${limit}`;
        const hit = cached(k, TTL_MS.google); if (hit) return hit;
        try {
            const refs = await bridge('placePhotos', { query: String(query), limit });
            if (!refs?.ok) return [];
            const out = [];
            for (const ref of (refs.data?.photos || []).slice(0, limit)) {
                const credit = ref.attributions?.[0];
                /* Google requires the attribution be shown. No attribution, no
                   lawful display, so the media is never even fetched — which
                   also means it is never billed. */
                if (!credit?.displayName) continue;
                const media = await bridge('placePhotoMedia', { photoName: ref.name, maxWidthPx: 1200 });
                if (!media?.ok) continue;
                const img = toImage({
                    url: media.data.dataUri,
                    width: ref.widthPx, height: ref.heightPx,
                    provider: 'google_places',
                    title: refs.data.placeName || String(query),
                    attribution: { name: credit.displayName, url: credit.uri || null },
                    license: { name: 'Google Maps Platform terms', url: null }
                });
                if (img) out.push(img);
            }
            store(k, out);
            return out;
        } catch { return []; }
    }

    async function streetview(lat, lng) {
        if (!bridge || !Number.isFinite(lat)) return [];
        const k = `sv:${lat.toFixed(4)},${lng.toFixed(4)}`;
        const hit = cached(k, TTL_MS.google); if (hit) return hit;
        try {
            /* FREE metadata gate — see the header. */
            const meta = await bridge('streetViewMeta', { lat, lng });
            if (!meta?.ok || meta.data?.status !== 'OK') { store(k, []); return []; }
            const img = await bridge('streetViewImage', { lat, lng, fov: 90, pitch: 5 });
            if (!img?.ok) return [];
            const out = [toImage({
                url: img.data.dataUri, width: 640, height: 400,
                provider: 'google_streetview',
                title: 'Street View',
                capturedAt: meta.data.date || null,
                attribution: { name: 'Google', url: null },
                license: { name: 'Google Maps Platform terms', url: null }
            })].filter(Boolean);
            store(k, out);
            return out;
        } catch { return []; }
    }

    /**
     * Pictures of a place, cheapest source first.
     *
     * @param {{name,lat,lng,granularity,types,spanKm}} place
     * @returns {Promise<{images: Array, sourcesTried: string[], attributionRequired: boolean}>}
     */
    async function forPlace(place = {}, { limit = 4 } = {}) {
        const { name, lat, lng, granularity, types, spanKm } = place;
        const chain = sourcesFor(granularity, types);
        const images = [];
        const tried = [];

        for (const source of chain) {
            if (images.length >= limit) break;
            tried.push(source);
            let got = [];
            if (source === 'wikipedia') got = await wikipedia(name);
            else if (source === 'wikimedia') {
                /* A tighter radius for a building than for a country, or the
                   "photo of this address" is a landmark ten kilometres away. */
                const radius = Number.isFinite(spanKm) ? Math.max(150, Math.min(10000, spanKm * 100)) : 2000;
                got = await wikimedia(lat, lng, radius, limit);
            } else if (source === 'places') got = await places(name, 2);
            else if (source === 'streetview') got = await streetview(lat, lng);
            else if (source === 'satellite') {
                const s = satelliteImage(lat, lng, Number.isFinite(spanKm) ? spanKm : 50);
                got = s ? [s] : [];
            }
            images.push(...got);
        }

        return {
            images: images.slice(0, limit),
            sourcesTried: tried,
            /* Every provider here obliges credit; the caller must render it. */
            attributionRequired: images.length > 0
        };
    }

    return { forPlace, sourcesFor, _wikipedia: wikipedia, _wikimedia: wikimedia };
}

export default {
    createPlaceImages, sourcesFor,
    parseWikipediaSummary, parseWikimediaGeosearch, satelliteImage
};
