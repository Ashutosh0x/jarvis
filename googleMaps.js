/* =========================================================================
   GOOGLE MAPS PLATFORM — every endpoint this app actually has a use for.

   MAIN PROCESS ONLY. GOOGLE_MAPS_API_KEY is read here and never leaves; the
   renderer calls through the `google-maps` IPC channel and receives results,
   not credentials. That is the same rule the credential vault enforces for
   every other secret in this app, and it matters more here than usual because
   the renderer displays third-party content.

   WHAT IS AND IS NOT HERE
   Sixteen Maps Platform endpoints were probed against the live key and all
   sixteen answered. This module implements the twelve that serve a command
   centre — turning a name into a place, a place into coordinates, and
   coordinates into what is true there right now.

   Left out deliberately, because a wrapper nobody calls is dead code that
   still has to be maintained and still bills when someone finds it:
     - Address Validation, Geolocation, Roads/snapToRoads — postal and fleet
       problems. The globe has no addresses to validate and no GPS trace to
       snap. (Geolocation also answered from Bengaluru on this machine, i.e.
       IP geolocation, which is not where the user is.)
     - Solar buildingInsights — per-rooftop panel economics, a different app.
     - Map Tiles / Photorealistic 3D — the globe is a deliberate amber vector
       look; photoreal tiles would replace the design, not extend it, and they
       are the most expensive SKU on the list.

   EVERY CALL IS OPTIONAL AND EVERY FAILURE IS REPORTED. No key is a normal
   state: callers fall back to the keyless paths that already exist. When
   Google refuses, its own reason is passed through verbatim — a disabled API
   and an unreachable network are different problems and must not both read as
   "offline".

   BILLING IS REAL. Each helper is one request. Nothing here polls, retries in
   a loop, or runs on a timer; calls happen when the user asks for a place.
   ========================================================================= */

const TIMEOUT_MS = 8000;

const key = () => process.env.GOOGLE_MAPS_API_KEY || '';

/** Is Google configured at all? Callers branch on this rather than guessing. */
function isConfigured() {
    return !!key();
}

/**
 * One request, one shape of answer.
 *
 * Returns `{ ok, data }` or `{ ok: false, reason, detail }`. It never throws:
 * a map layer that explodes takes the globe down with it, and "no weather" is
 * not a reason to lose the planet.
 */
async function call(url, { method = 'GET', body = null, fieldMask = null } = {}) {
    if (!key()) return { ok: false, reason: 'no-key' };
    const headers = { 'X-Goog-Api-Key': key() };
    if (body) headers['Content-Type'] = 'application/json';
    if (fieldMask) headers['X-Goog-FieldMask'] = fieldMask;

    try {
        const res = await fetch(url, {
            method, headers,
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(TIMEOUT_MS)
        });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* non-JSON handled below */ }

        if (!res.ok) {
            /* Google says why — bad key, API not enabled, billing off, quota.
               Guessing at this is how a disabled API gets reported as an
               outage for a week. */
            const reason = json?.error?.status || json?.status || `http-${res.status}`;
            const detail = json?.error?.message || json?.error_message || text.slice(0, 300);
            return { ok: false, reason, detail };
        }
        /* The legacy maps.googleapis.com endpoints return HTTP 200 with a
           status field carrying the real outcome — ZERO_RESULTS is a 200. */
        if (json?.status && json.status !== 'OK' && json.status !== 'ZERO_RESULTS') {
            return { ok: false, reason: json.status, detail: json.error_message || '' };
        }
        return { ok: true, data: json ?? text };
    } catch (error) {
        return {
            ok: false,
            reason: error.name === 'TimeoutError' ? 'timeout' : 'network',
            detail: error.message
        };
    }
}

const q = (o) => Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

const LEGACY = 'https://maps.googleapis.com/maps/api';

/* ---------------------------------------------------------------- places -- */

/**
 * Landmarks near a point.
 *
 * The field mask is REQUIRED by the API and is also the bill: every field
 * asked for is charged whether or not it is drawn, so this asks for exactly
 * what the globe puts on screen.
 */
async function placesNearby({ lat, lng, radiusM = 10000, limit = 20, types } = {}) {
    return call('https://places.googleapis.com/v1/places:searchNearby', {
        method: 'POST',
        fieldMask: 'places.id,places.displayName,places.location,places.types',
        body: {
            locationRestriction: {
                circle: {
                    center: { latitude: lat, longitude: lng },
                    /* Their circle caps at 50 km; clamp rather than be rejected. */
                    radius: Math.min(50000, Math.max(1, radiusM))
                }
            },
            includedTypes: types || ['tourist_attraction', 'museum', 'park', 'stadium'],
            rankPreference: 'POPULARITY',
            maxResultCount: Math.min(20, Math.max(1, limit))
        }
    });
}

/** Free-text place lookup — "the Golden Gate Bridge", not a city name. */
async function placesText({ query, limit = 5 } = {}) {
    return call('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST',
        fieldMask: 'places.id,places.displayName,places.location,places.formattedAddress,places.types',
        /* `pageSize`, not `maxResultCount`: the latter is deprecated on Text
           Search as of 13 May 2024. Nearby Search still takes maxResultCount
           and is deliberately left alone — the deprecation is Text Search only. */
        body: { textQuery: String(query || ''), pageSize: Math.min(20, Math.max(1, limit)) }
    });
}

/**
 * Businesses matching a query, paginated — "software companies in Bengaluru".
 *
 * WHY PAGINATE. A single Text Search page is 20 results; the fuller answer to
 * "the companies here" is up to 60, reached with the `nextPageToken`. Google
 * caps it at three pages regardless, so this is not an unbounded crawl — and it
 * is NOT a registry. It is the top matches Google returns for a query near a
 * place, which is an honest "show me companies here", not a claim to have found
 * every one.
 *
 * `websiteUri` is on the field mask because a company marker that links to the
 * company is worth more than one that does not — and the field is only billed
 * when asked for, which is exactly when it is used.
 */
async function placesCompanies({ query, pages = 3, lat, lng, radiusM } = {}) {
    const results = [];
    let token = null;
    const wanted = Math.min(3, Math.max(1, pages));
    for (let i = 0; i < wanted; i++) {
        const body = { textQuery: String(query || 'companies'), pageSize: 20 };
        /* locationBias is what makes this coordinate-driven rather than
           name-driven: "technology companies" biased to a point returns the
           companies NEAR that point, for any place on Earth, with no city name
           baked into the query and nothing hardcoded. The circle caps at 50 km,
           Google's limit. */
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
            body.locationBias = {
                circle: {
                    center: { latitude: lat, longitude: lng },
                    radius: Math.min(50000, Math.max(500, Number(radiusM) || 15000))
                }
            };
        }
        if (token) body.pageToken = token;
        const res = await call('https://places.googleapis.com/v1/places:searchText', {
            method: 'POST',
            fieldMask: 'places.id,places.displayName,places.location,places.formattedAddress,places.types,places.websiteUri,nextPageToken',
            body
        });
        if (!res.ok) return results.length ? { ok: true, data: { places: results } } : res;
        for (const p of res.data?.places || []) results.push(p);
        token = res.data?.nextPageToken || null;
        if (!token) break;
        /* Google requires a short pause before a page token is valid. */
        if (i < wanted - 1) await new Promise((r) => setTimeout(r, 1600));
    }
    return { ok: true, data: { places: results } };
}

/**
 * A named company's headquarters — "Stellantis", not "companies near here".
 *
 * THE INVERSE OF placesCompanies. That one asks "what businesses are at this
 * point"; this one asks "where on Earth is this named company", which is what
 * turns a ranked list of tickers into pins on a globe.
 *
 * TWO THINGS MAKE THE ANSWER TRUSTWORTHY, and both were learned from getting
 * it wrong against the live API:
 *
 *  1. The country goes in the QUERY TEXT, not just `regionCode`. regionCode is
 *     a bias and Places overrides it for a strong global name — "Reliance"
 *     with regionCode US returned Reliance Retail in Bengaluru, because the
 *     Indian conglomerate outranks the American steel distributor by every
 *     signal Google has. Naming the country in the text changes the ranking
 *     rather than merely nudging it.
 *  2. `addressComponents` is on the field mask so the ISO country of the
 *     result can be CHECKED. Without it the caller can only hope; with it, a
 *     result in the wrong country is detectable and can be refused. A company
 *     plotted on the wrong continent is worse than a company left off the map.
 *
 * Three candidates rather than one, so the caller can walk down the list to
 * the first that passes its country check instead of throwing the search away.
 *
 * The word "corporate headquarters" in the query is what pins the head office
 * rather than the nearest branch: "Riyad Bank" alone returns a high-street
 * branch, which is a real place and the wrong one.
 */
async function placesCompanyHQ({ name, country, regionCode, bare = false, ticker = null, biasLat = null, biasLng = null } = {}) {
    const clean = String(name || '').trim();
    if (!clean) return { ok: false, reason: 'no-name' };
    const body = {
        /* `bare` drops the "corporate headquarters" phrasing. That phrasing is
           what pins a head office instead of a branch and is right nearly
           everywhere — but it returns zero results for a large block of
           mainland Chinese listings that Google indexes by name only. The
           caller falls back to this when the first shape finds nothing, so the
           precision is kept where it works and recall is recovered where it
           does not. */
        /* THREE QUERY SHAPES, tried in order of precision by the caller:
             1. "<name> corporate headquarters <country>"  — pins the head
                office rather than a branch. Right nearly everywhere.
             2. bare: "<name> <country>"                   — recovers mainland
                Chinese listings Google indexes by name only.
             3. ticker: "<name> (<TICKER>) corporate headquarters <country>"
                — the ticker is a strong disambiguator when the trading name
                and the signage differ. It found Schneider Electric's actual
                office where shape 1 returned only the town it sits in.

           Shape 3 is NOT safe on its own — it sent "RTX" to an RTX subsidiary
           in India — which is precisely why the caller runs every shape
           through the same country and name checks. A stronger query is
           allowed to find more candidates; it is not allowed to lower the bar
           they have to clear. */
        textQuery: ticker
            ? `${clean} (${String(ticker).split('.')[0]}) corporate headquarters${country ? ` ${country}` : ''}`
            : bare
                ? `${clean}${country ? ` ${country}` : ''}`
                : `${clean} corporate headquarters${country ? ` ${country}` : ''}`,
        /* EIGHT, NOT THREE — and it costs nothing extra. One Text Search is one
           billed request whatever the page size, and the country check walks
           down the list until something matches. With three candidates, a
           mainland Chinese company whose first three hits are all Hong Kong
           subsidiaries was rejected outright; ICBC, China Mobile and Bank of
           Communications all failed exactly that way. More candidates is more
           chances for the right country to appear, for the same money. */
        pageSize: 8
    };
    /* Bias towards the country asked for. `regionCode` alone is a hint Google
       overrides for strong global names; a location bias pulls the ranking
       towards the right landmass as well. */
    if (Number.isFinite(biasLat) && Number.isFinite(biasLng)) {
        body.locationBias = {
            circle: { center: { latitude: biasLat, longitude: biasLng }, radius: 50000 }
        };
    }
    if (regionCode) body.regionCode = String(regionCode).toUpperCase().slice(0, 2);
    const res = await call('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST',
        fieldMask: 'places.id,places.displayName,places.location,places.formattedAddress,places.addressComponents,places.types',
        body
    });
    if (!res.ok) return res;
    const candidates = [];
    for (const p of res.data?.places || []) {
        if (!Number.isFinite(p.location?.latitude)) continue;
        candidates.push({
            id: p.id || null,
            matchedName: p.displayName?.text || clean,
            lat: p.location.latitude,
            lng: p.location.longitude,
            address: p.formattedAddress || null,
            countryCode: (p.addressComponents || [])
                .find((c) => (c.types || []).includes('country'))?.shortText || null,
            type: (p.types || [])[0] || null,
            /* The FULL type list, not just the first. A caller checking whether
               a result is a corporate office cannot do it from `types[0]`,
               which is frequently the generic `point_of_interest`. It is the
               difference between accepting "Xfinity Corporate Office" as
               Comcast and accepting a town called Rueil-Malmaison as
               Schneider Electric. */
            types: p.types || []
        });
    }
    return { ok: true, data: { candidates } };
}

/**
 * A photograph of a place we already have the ID for.
 *
 * TWO REQUESTS, AND BOTH ARE BILLED — Place Details for the photo reference,
 * then the media endpoint for the bytes. That is why this is called ON DEMAND
 * rather than swept over the whole database: photographing all 10,959 resolved
 * companies would be roughly $263 and 877 MB of disk, to show pictures nobody
 * asked to see. Clicking one company costs about half a cent.
 *
 * The place ID is already known from the HQ resolution, which is what makes
 * this two requests instead of three — no search is needed to find the place
 * again.
 *
 * ATTRIBUTION IS NOT OPTIONAL. Google's terms require the author attribution
 * to be displayed with the image, so a photo whose attribution did not come
 * back is unusable and is reported as absent rather than shown bare.
 */
async function placePhotoForCompany({ placeId, maxWidthPx = 800 } = {}) {
    const id = String(placeId || '').trim();
    if (!id) return { ok: false, reason: 'no-place-id' };
    if (!key()) return { ok: false, reason: 'no-key' };

    const details = await call(`https://places.googleapis.com/v1/places/${encodeURIComponent(id)}`, {
        fieldMask: 'id,displayName,photos'
    });
    if (!details.ok) return details;

    const photos = details.data?.photos || [];
    if (!photos.length) return { ok: true, data: { found: false, reason: 'no-photos' } };

    const photo = photos[0];
    const attributions = (photo.authorAttributions || []).map((a) => ({
        displayName: a.displayName, uri: a.uri
    }));
    if (!attributions.length) return { ok: true, data: { found: false, reason: 'no-attribution' } };

    const media = await placePhotoMedia({ photoName: photo.name, maxWidthPx });
    if (!media.ok) return media;

    return {
        ok: true,
        data: {
            found: true,
            placeName: details.data?.displayName?.text || null,
            dataUri: media.data.dataUri,
            bytes: media.data.bytes,
            widthPx: photo.widthPx,
            heightPx: photo.heightPx,
            attributions,
            /* How many more exist, so a caller can offer "next photo" without
               having to buy one to find out. */
            available: photos.length
        }
    };
}

/** Type-ahead completions. Cheap, and the only endpoint billed per session. */
async function placesAutocomplete({ input, lat, lng } = {}) {
    const body = { input: String(input || '') };
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
        body.locationBias = { circle: { center: { latitude: lat, longitude: lng }, radius: 50000 } };
    }
    return call('https://places.googleapis.com/v1/places:autocomplete', { method: 'POST', body });
}

/* ------------------------------------------------------------- geocoding -- */

/**
 * Name to coordinates.
 *
 * This is the one that closes the gaps in the bundled gazetteer: Natural Earth
 * 110m has "New Delhi" but not "Delhi", and no Trichardt at all. Google
 * resolves both. It is a FALLBACK, not the default — the offline index still
 * answers first, because a globe that needs the internet to find a city is a
 * globe that does not work on a train.
 */
async function geocode({ address, region, language = 'en' } = {}) {
    if (!key()) return { ok: false, reason: 'no-key' };
    /* V4, which is generally available and is the reason this resolves a
       country, a state, a city, a street and a building with one call. It also
       returns `granularity` and a `viewport`, which is what lets the globe
       frame Japan differently from a doorway without anyone hardcoding a zoom
       level per place type.
       `languageCode` matters: without it "Tokyo" comes back as 日本、東京都,
       which is correct and unreadable as a map label here. */
    const path = encodeURIComponent(String(address || ''));
    const res = await call(`https://geocode.googleapis.com/v4/geocode/address/${path}?${q({
        key: key(), languageCode: language, regionCode: region
    })}`);
    if (res.ok) return res;
    /* V3 is still supported and stays as the fallback: a v4 outage or a quota
       that was only ever uplifted on v3 should degrade, not fail. */
    return call(`${LEGACY}/geocode/json?${q({ address, region, key: key() })}`);
}

/** Coordinates to a place name — what am I looking at? */
async function reverseGeocode({ lat, lng, resultType = 'locality' } = {}) {
    return call(`${LEGACY}/geocode/json?${q({ latlng: `${lat},${lng}`, result_type: resultType, key: key() })}`);
}

/* ----------------------------------------------------- what is true there -- */

/** Metres above sea level. */
async function elevation({ lat, lng } = {}) {
    return call(`${LEGACY}/elevation/json?${q({ locations: `${lat},${lng}`, key: key() })}`);
}

/** IANA zone and offset — so the globe can say what time it is there. */
async function timezone({ lat, lng, timestamp = Math.floor(Date.now() / 1000) } = {}) {
    return call(`${LEGACY}/timezone/json?${q({ location: `${lat},${lng}`, timestamp, key: key() })}`);
}

/** Current conditions. */
async function weather({ lat, lng } = {}) {
    return call(`https://weather.googleapis.com/v1/currentConditions:lookup?${q({
        key: key(), 'location.latitude': lat, 'location.longitude': lng
    })}`);
}

/** Universal AQI plus the dominant pollutant. */
async function airQuality({ lat, lng } = {}) {
    return call(`https://airquality.googleapis.com/v1/currentConditions:lookup?key=${encodeURIComponent(key())}`, {
        method: 'POST',
        body: { location: { latitude: lat, longitude: lng } }
    });
}

/** Grass/tree/weed indices for the day. */
async function pollen({ lat, lng, days = 1 } = {}) {
    return call(`https://pollen.googleapis.com/v1/forecast:lookup?${q({
        key: key(), 'location.latitude': lat, 'location.longitude': lng, days
    })}`);
}

/* ------------------------------------------------------------- movement --- */

/** Distance and duration between two points. */
async function route({ fromLat, fromLng, toLat, toLng, travelMode = 'DRIVE' } = {}) {
    return call('https://routes.googleapis.com/directions/v2:computeRoutes', {
        method: 'POST',
        fieldMask: 'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline',
        body: {
            origin: { location: { latLng: { latitude: fromLat, longitude: fromLng } } },
            destination: { location: { latLng: { latitude: toLat, longitude: toLng } } },
            travelMode
        }
    });
}

/* ------------------------------------------------------------ photographs -- */

/**
 * Photo REFERENCES for a place — not the bytes.
 *
 * Two steps on purpose: references are cheap and reusable, the media fetch is
 * the expensive half. `authorAttributions` is requested because Google's terms
 * make displaying it mandatory, so a reference without it is unusable and must
 * not be treated as a result.
 */
async function placePhotos({ query, limit = 5 } = {}) {
    const res = await call('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST',
        fieldMask: 'places.id,places.displayName,places.photos',
        /* pageSize — maxResultCount is deprecated on Text Search. */
        body: { textQuery: String(query || ''), pageSize: Math.min(10, Math.max(1, limit)) }
    });
    if (!res.ok) return res;
    const place = res.data?.places?.[0];
    return {
        ok: true,
        data: {
            placeName: place?.displayName?.text || null,
            photos: (place?.photos || []).slice(0, limit).map((p) => ({
                name: p.name,
                widthPx: p.widthPx,
                heightPx: p.heightPx,
                attributions: (p.authorAttributions || []).map((a) => ({
                    displayName: a.displayName, uri: a.uri, photoUri: a.photoUri
                }))
            }))
        }
    };
}

/**
 * The bytes for one photo reference, as a data URI.
 *
 * Base64 rather than handing the renderer a URL, because that URL carries the
 * API key. Same reason staticMap does it.
 */
async function placePhotoMedia({ photoName, maxWidthPx = 1200 } = {}) {
    if (!key()) return { ok: false, reason: 'no-key' };
    /* The reference comes back from Google, but it is still a path segment
       built into a URL — anything shaped unlike a photo reference is refused
       rather than fetched. */
    if (!/^places\/[\w-]+\/photos\/[\w-]+$/.test(String(photoName || ''))) {
        return { ok: false, reason: 'bad-photo-reference' };
    }
    const width = Math.min(4800, Math.max(64, Number(maxWidthPx) || 1200));
    try {
        const res = await fetch(
            `https://places.googleapis.com/v1/${photoName}/media?maxWidthPx=${width}&key=${encodeURIComponent(key())}`,
            { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) }
        );
        if (!res.ok) return { ok: false, reason: `http-${res.status}`, detail: (await res.text()).slice(0, 200) };
        const buf = Buffer.from(await res.arrayBuffer());
        const type = res.headers.get('content-type') || 'image/jpeg';
        return { ok: true, data: { dataUri: `data:${type};base64,${buf.toString('base64')}`, bytes: buf.length } };
    } catch (error) {
        return { ok: false, reason: error.name === 'TimeoutError' ? 'timeout' : 'network', detail: error.message };
    }
}

/**
 * A Street View still.
 *
 * CALLERS MUST CHECK `streetViewMeta` FIRST — metadata is free and says
 * whether imagery exists at all, while this endpoint bills for a grey "no
 * imagery" placeholder just as happily as for a photograph.
 */
async function streetViewImage({ lat, lng, heading = 0, pitch = 0, fov = 90, size = '640x400' } = {}) {
    if (!key()) return { ok: false, reason: 'no-key' };
    /* Their documented ceiling without the premium plan. */
    const safeSize = /^\d{2,4}x\d{2,4}$/.test(size) ? size : '640x400';
    try {
        const res = await fetch(`${LEGACY}/streetview?${q({
            location: `${lat},${lng}`, size: safeSize,
            heading, pitch, fov: Math.min(120, Math.max(1, fov)), key: key()
        })}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!res.ok) return { ok: false, reason: `http-${res.status}` };
        const buf = Buffer.from(await res.arrayBuffer());
        return { ok: true, data: { dataUri: `data:image/jpeg;base64,${buf.toString('base64')}`, bytes: buf.length } };
    } catch (error) {
        return { ok: false, reason: error.name === 'TimeoutError' ? 'timeout' : 'network', detail: error.message };
    }
}

/* ---------------------------------------------------------------- imagery -- */

/**
 * Is there Street View here, and how old is it?
 *
 * METADATA ONLY, and that is deliberate: the metadata endpoint is free while
 * fetching the panorama is not, so this answers "is imagery available" without
 * buying an image nobody asked to see.
 */
async function streetViewMeta({ lat, lng } = {}) {
    return call(`${LEGACY}/streetview/metadata?${q({ location: `${lat},${lng}`, key: key() })}`);
}

/**
 * A Street View photograph, returned as a data URI.
 *
 * Same security pattern as staticMap: the image is fetched here and sent as
 * base64 so the API key never reaches the renderer. Always preceded by a
 * streetViewMeta call in placeImages.js — the metadata is free, this is not,
 * so paying for a grey "no imagery" placeholder is the caller's responsibility
 * to avoid, not this function's.
 */
async function streetViewImage({ lat, lng, heading = 0, pitch = 0, fov = 90, size = '640x400' } = {}) {
    if (!key()) return { ok: false, reason: 'no-key' };
    const url = `${LEGACY}/streetview?${q({
        location: `${lat},${lng}`, size, heading, pitch, fov, key: key()
    })}`;
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!res.ok) {
            return { ok: false, reason: `http-${res.status}`, detail: (await res.text()).slice(0, 200) };
        }
        const buf = Buffer.from(await res.arrayBuffer());
        return { ok: true, data: { dataUri: `data:image/jpeg;base64,${buf.toString('base64')}`, bytes: buf.length } };
    } catch (error) {
        return { ok: false, reason: error.name === 'TimeoutError' ? 'timeout' : 'network', detail: error.message };
    }
}

/**
 * Photo references for a place.
 *
 * Text-searches for the query and returns the photo array with attribution
 * metadata. The media bytes are NOT fetched here — the caller picks which
 * photo(s) to materialise and calls placePhotoMedia for each, so the bill is
 * proportional to what is actually drawn.
 */
async function placePhotos({ query, limit = 5 } = {}) {
    const res = await call('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST',
        fieldMask: 'places.id,places.displayName,places.photos',
        /* pageSize — maxResultCount is deprecated on Text Search. */
        body: { textQuery: String(query || ''), pageSize: Math.min(10, Math.max(1, limit)) }
    });
    if (!res.ok) return res;
    const place = res.data?.places?.[0];
    return {
        ok: true,
        data: {
            placeName: place?.displayName?.text || String(query),
            photos: (place?.photos || []).map(p => ({
                name: p.name,
                widthPx: p.widthPx,
                heightPx: p.heightPx,
                attributions: p.authorAttributions || []
            }))
        }
    };
}

/**
 * A single place photo, returned as a data URI.
 *
 * The photo `name` comes from placePhotos above. The media endpoint either
 * redirects (302) to the image bytes or, with skipHttpRedirect=true, returns a
 * JSON object with a signed photoUri. We follow the redirect and return base64
 * — same security pattern as every other image endpoint in this module.
 */
async function placePhotoMedia({ photoName, maxWidthPx = 1200 } = {}) {
    if (!key()) return { ok: false, reason: 'no-key' };
    if (!photoName) return { ok: false, reason: 'no-photo-name' };
    const url = `https://places.googleapis.com/v1/${photoName}/media?maxWidthPx=${maxWidthPx}&key=${encodeURIComponent(key())}`;
    try {
        const res = await fetch(url, {
            signal: AbortSignal.timeout(TIMEOUT_MS),
            redirect: 'follow'
        });
        if (!res.ok) {
            return { ok: false, reason: `http-${res.status}`, detail: (await res.text()).slice(0, 200) };
        }
        const buf = Buffer.from(await res.arrayBuffer());
        const ct = res.headers.get('content-type') || 'image/jpeg';
        return { ok: true, data: { dataUri: `data:${ct};base64,${buf.toString('base64')}`, bytes: buf.length } };
    } catch (error) {
        return { ok: false, reason: error.name === 'TimeoutError' ? 'timeout' : 'network', detail: error.message };
    }
}

/**
 * A flat map thumbnail, returned as a data URI.
 *
 * Base64 rather than a URL because a URL would carry the API key into the
 * renderer and into the DOM, which is the exact leak this module exists to
 * prevent.
 */
async function staticMap({ lat, lng, zoom = 12, size = '480x320', mapType = 'roadmap' } = {}) {
    if (!key()) return { ok: false, reason: 'no-key' };
    const url = `${LEGACY}/staticmap?${q({
        center: `${lat},${lng}`, zoom, size, maptype: mapType, scale: 2, key: key()
    })}`;
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!res.ok) {
            return { ok: false, reason: `http-${res.status}`, detail: (await res.text()).slice(0, 200) };
        }
        const buf = Buffer.from(await res.arrayBuffer());
        return { ok: true, data: { dataUri: `data:image/png;base64,${buf.toString('base64')}`, bytes: buf.length } };
    } catch (error) {
        return { ok: false, reason: error.name === 'TimeoutError' ? 'timeout' : 'network', detail: error.message };
    }
}

/* ------------------------------------------------------------------ misc -- */

/**
 * Everything true at one point, in one call from the renderer's side.
 *
 * Settled rather than awaited in series: five sequential round trips is five
 * chances to stall the fly-to, and one dead endpoint must not withhold the
 * four that answered. Partial truth is reported as partial, not as failure.
 */
async function dossier({ lat, lng } = {}) {
    const [elev, tz, wx, aq, sv] = await Promise.allSettled([
        elevation({ lat, lng }), timezone({ lat, lng }),
        weather({ lat, lng }), airQuality({ lat, lng }), streetViewMeta({ lat, lng })
    ]);
    const val = (s) => (s.status === 'fulfilled' && s.value.ok ? s.value.data : null);
    const why = (s) => (s.status === 'fulfilled' && !s.value.ok ? s.value.reason : null);
    return {
        ok: true,
        data: {
            elevationM: val(elev)?.results?.[0]?.elevation ?? null,
            timeZoneId: val(tz)?.timeZoneId ?? null,
            /* Seconds east of UTC, DST included — enough to render a clock. */
            utcOffsetSec: val(tz) ? (val(tz).rawOffset ?? 0) + (val(tz).dstOffset ?? 0) : null,
            temperatureC: val(wx)?.temperature?.degrees ?? null,
            condition: val(wx)?.weatherCondition?.description?.text ?? null,
            aqi: val(aq)?.indexes?.[0]?.aqi ?? null,
            aqiCategory: val(aq)?.indexes?.[0]?.category ?? null,
            streetViewDate: val(sv)?.date ?? null,
            /* Which parts did not answer, and why. Absent data is stated, not
               rendered as a zero. */
            unavailable: Object.fromEntries(
                [['elevation', why(elev)], ['timezone', why(tz)], ['weather', why(wx)],
                ['airQuality', why(aq)], ['streetView', why(sv)]].filter(([, v]) => v)
            )
        }
    };
}

/* The renderer may only reach these, by name. An unchecked method string from
   the renderer is an open proxy to anything this module can call. */
const METHODS = {
    placesNearby, placesText, placesAutocomplete,
    geocode, reverseGeocode,
    elevation, timezone, weather, airQuality, pollen,
    route, streetViewMeta, staticMap, dossier,
    placePhotos, placePhotoMedia, streetViewImage, placesCompanies, placesCompanyHQ,
    placePhotoForCompany
};

async function invoke(method, params = {}) {
    const fn = METHODS[method];
    if (!fn) return { ok: false, reason: 'unknown-method', detail: String(method).slice(0, 40) };
    return fn(params || {});
}

module.exports = { invoke, isConfigured, methods: Object.keys(METHODS), ...METHODS };
