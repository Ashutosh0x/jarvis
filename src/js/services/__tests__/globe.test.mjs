// Tests for the globe's non-visual layers.
//
// No browser, no WebGL, no network. What is asserted here is the geocoding and
// the feed parsing — the parts that decide WHERE the camera flies and WHAT the
// ripples mark. The rendering is verified by looking at it; these are the bits
// that can be quietly wrong and still draw something plausible.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalise, editDistance, buildPlaceIndex, findLocal, isPrefixMatch } from '../geocode.js';
import { parseQuakes, describeEvent, distanceKm, createDataFeeds, firmsKey } from '../dataFeeds.js';
import { solarParameters, subsolarPoint, sunDirection, solarAltitude, isDaylight } from '../solarPosition.js';
import { parseWikiGeosearch, parseGooglePlaces, rankLandmarks, createLandmarkService } from '../landmarks.js';
import { createGoogleServices, describeDossier, parseGeocode, parseGeocodeV4, spanKmFromViewport, cameraDistanceFor, describeRoute, localTime } from '../googleServices.js';
import { createPlaceImages, sourcesFor, parseWikipediaSummary, parseWikimediaGeosearch, satelliteImage } from '../placeImages.js';
import { createRequire } from 'node:module';
const _req = createRequire(import.meta.url);
const { normaliseList } = _req(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'lumaEvents.js'));

let pass = 0, fail = 0;
const check = (n, c) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..', '..');

/* ------------------------------------------------------------ normalising */

check('case and punctuation are stripped', normalise('San Francisco!') === 'san francisco');
check('accents are folded so "São Paulo" matches "sao paulo"',
    normalise('São Paulo') === 'sao paulo');
check('runs of whitespace collapse', normalise('  new   york  ') === 'new york');
check('an empty query normalises to empty', normalise(null) === '');

/* --------------------------------------------------------- edit distance */

check('identical strings are zero apart', editDistance('paris', 'paris') === 0);
check('a single typo is one edit', editDistance('pariss', 'paris') === 1);
check('a transposition costs two under plain Levenshtein',
    editDistance('pairs', 'paris') === 2);
/* The cap is what keeps this cheap over ~1,250 names per query. */
check('distances past the cap short-circuit', editDistance('abcdefgh', 'zzz', 2) > 2);

/* --------------------------------------------- the real Natural Earth data */

const placesPath = path.join(REPO, 'static', 'geo', 'ne_110m_populated_places_simple.geojson');
let index = [];
try {
    index = buildPlaceIndex(JSON.parse(readFileSync(placesPath, 'utf8')));
} catch {
    console.log('SKIP  places dataset not present');
}

if (index.length) {
    check('the bundled dataset yields a usable index', index.length > 200);
    check('every entry carries coordinates',
        index.every((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng)));

    /* The query from the brief, and it must work with no network. */
    const sf = findLocal(index, 'San Francisco');
    check('"San Francisco" resolves offline', !!sf);
    check('and to roughly the right spot',
        sf && Math.abs(sf.lat - 37.77) < 0.6 && Math.abs(sf.lng + 122.42) < 0.6);
    check('an exact match scores 1', sf?.score === 1);
    check('and is marked as coming from the local index', sf?.source === 'local');

    /* Speech-to-text is the actual input, so misspellings are the normal case
       rather than an edge case. */
    check('a misheard "san fransico" still resolves',
        findLocal(index, 'san fransico')?.name?.toLowerCase().includes('san francisco'));
    check('a fuzzy hit scores below an exact one',
        (findLocal(index, 'san fransico')?.score ?? 1) < 1);

    check('"Mumbai" resolves', !!findLocal(index, 'Mumbai'));
    check('"tokyo" is case-insensitive', !!findLocal(index, 'tokyo'));
    check('nonsense resolves to nothing rather than the nearest city',
        findLocal(index, 'zzzqqxwv') === null);

    /* STT jams words together far more often than it misspells them. */
    const squashed = findLocal(index, 'sanfrancisco');
    check('"sanfrancisco" with no space resolves',
        squashed?.name?.toLowerCase().includes('san francisco'));
    check('and scores high enough for the intent parser to act on it',
        (squashed?.score ?? 0) >= 0.9);
    check('"newyork" too', findLocal(index, 'newyork')?.name?.toLowerCase().includes('new york'));

    /* FALSE POSITIVES. A short fragment must not prefix-match a capital: "map"
       used to return Maputo and "ku" Kuwait City, both at 0.80 — the exact
       score the intent parser acts on, so "show me the map" flew to
       Mozambique. */
    check('"map" no longer resolves to Maputo', findLocal(index, 'map') === null);
    check('"ku" no longer resolves to Kuwait City', findLocal(index, 'ku') === null);
    check('nor do other stray fragments',
        ['mou', 'tri', 'sa', 'lo', 'ne'].every((f) => findLocal(index, f) === null));
    /* ...while genuine partial names still do. */
    check('"san fran" still finds San Francisco',
        findLocal(index, 'san fran')?.name?.toLowerCase().includes('san francisco'));
    check('and a full name is untouched', findLocal(index, 'Maputo')?.name === 'Maputo');

    /* Population breaks ties, so a bare "London" means the big one. */
    const london = findLocal(index, 'London');
    check('an ambiguous name picks the largest', london && Math.abs(london.lat - 51.5) < 1.5);
}

/* ------------------------------------------------------------ distances */

/* London to Paris is ~344 km; the formula is worth pinning to a known pair. */
check('great-circle distance is right for London-Paris',
    Math.abs(distanceKm(51.5074, -0.1278, 48.8566, 2.3522) - 344) < 12);
check('a point is zero from itself', distanceKm(10, 20, 10, 20) === 0);
check('antipodes are half the circumference',
    Math.abs(distanceKm(0, 0, 0, 180) - 20015) < 30);

/* ------------------------------------------------------- USGS feed parsing */

const usgsSample = {
    type: 'FeatureCollection',
    features: [
        {
            id: 'us1000a', geometry: { type: 'Point', coordinates: [-122.4, 37.8, 8.2] },
            properties: { mag: 5.8, place: '10km W of Daly City, CA', time: 1_700_000_000_000, url: 'https://example.test/a' }
        },
        {
            id: 'us1000b', geometry: { type: 'Point', coordinates: [140.5, 35.6, 40] },
            properties: { mag: 3.1, place: 'near Tokyo, Japan', time: 1_700_000_500_000 }
        },
        /* Malformed entries appear in real feeds and must not take the parse
           down with them — one bad record should cost one record. */
        { id: 'broken', geometry: null, properties: { mag: 9 } },
        { id: 'nocoords', geometry: { type: 'Point', coordinates: [] }, properties: { mag: 4 } }
    ]
};

{
    const quakes = parseQuakes(usgsSample);
    check('malformed features are skipped, not fatal', quakes.length === 2);
    check('longitude and latitude are not transposed',
        quakes.some((q) => Math.abs(q.lat - 37.8) < 0.01 && Math.abs(q.lng + 122.4) < 0.01));
    check('results are newest first', quakes[0].id === 'us1000b');
    check('depth is carried through', quakes.find((q) => q.id === 'us1000a').depthKm === 8.2);
    check('a bigger quake gets a bigger ripple weight',
        quakes.find((q) => q.id === 'us1000a').weight > quakes.find((q) => q.id === 'us1000b').weight);
    check('weight stays within 0 and 1',
        quakes.every((q) => q.weight > 0 && q.weight <= 1));
    check('an empty feed parses to an empty list', parseQuakes({ features: [] }).length === 0);
    check('a null feed does not throw', parseQuakes(null).length === 0);

    const line = describeEvent(quakes.find((q) => q.id === 'us1000a'));
    check('the ticker line names magnitude and place',
        /M5\.8/.test(line) && /Daly City/.test(line));
}

/* ------------------------------------------------------- solar position */

/* Anchored to astronomical facts, not to whatever the code currently returns.
   Every one of these is checkable against a published almanac. */
{
    /* Solstices and equinoxes pin the declination curve at its extremes and
       its zero crossings — if the series is wrong, one of these four breaks. */
    const junSolstice = solarParameters(new Date('2026-06-21T12:00:00Z')).declination;
    const decSolstice = solarParameters(new Date('2026-12-21T12:00:00Z')).declination;
    const marEquinox = solarParameters(new Date('2026-03-20T12:00:00Z')).declination;
    const sepEquinox = solarParameters(new Date('2026-09-23T12:00:00Z')).declination;

    check('June solstice declination is the axial tilt, +23.44',
        Math.abs(junSolstice - 23.44) < 0.1);
    check('December solstice is the mirror, -23.44',
        Math.abs(decSolstice + 23.44) < 0.1);
    check('March equinox declination crosses zero', Math.abs(marEquinox) < 0.5);
    check('September equinox crosses zero the other way', Math.abs(sepEquinox) < 0.5);

    /* The equation of time is the part a naive terminator omits. Its real
       range is about -14 to +16 minutes, and it has four zero crossings. */
    let minEq = 99, maxEq = -99;
    for (let d = 0; d < 365; d += 3) {
        const eq = solarParameters(new Date(Date.UTC(2026, 0, 1 + d, 12))).equationOfTimeMinutes;
        minEq = Math.min(minEq, eq); maxEq = Math.max(maxEq, eq);
    }
    check('equation of time bottoms out near -14 minutes in February',
        minEq < -13 && minEq > -15);
    check('and peaks near +16 minutes in early November',
        maxEq > 15 && maxEq < 17);

    /* Subsolar longitude: the Earth turns 15 degrees an hour, so the point
       where it is noon marches steadily west. */
    const noon = subsolarPoint(new Date('2026-03-20T12:00:00Z'));
    check('at 12:00 UTC the sun is over the Greenwich meridian, within the EoT',
        Math.abs(noon.lng) < 5);
    const midnight = subsolarPoint(new Date('2026-03-20T00:00:00Z'));
    check('at 00:00 UTC it is over the date line',
        Math.abs(Math.abs(midnight.lng) - 180) < 5);
    check('longitude stays inside [-180, 180] all day',
        Array.from({ length: 24 }, (_, h) => subsolarPoint(new Date(Date.UTC(2026, 5, 1, h))).lng)
            .every((l) => l >= -180 && l <= 180));

    /* Six hours of rotation is ninety degrees of longitude. */
    const a = subsolarPoint(new Date('2026-06-01T06:00:00Z')).lng;
    const b = subsolarPoint(new Date('2026-06-01T12:00:00Z')).lng;
    /* Signed difference wrapped into [-180,180]. Going from 06:00 to 12:00 UTC
       the subsolar point moves from +90 to 0 — ninety degrees WEST — so the
       wrapped (a - b) is +90. Asserting -90 was reading the sign backwards. */
    const rotated = (((a - b) % 360) + 540) % 360 - 180;
    check('six hours moves the subsolar point 90 degrees west',
        Math.abs(rotated - 90) < 1);

    /* Altitude: at the subsolar point the sun is straight up, and its
       antipode is midnight. */
    const sub = subsolarPoint(new Date('2026-07-04T15:30:00Z'));
    check('the sun is at the zenith over the subsolar point',
        Math.abs(solarAltitude(sub.lat, sub.lng, new Date('2026-07-04T15:30:00Z')) - 90) < 0.5);
    check('and directly underfoot at its antipode',
        solarAltitude(-sub.lat, sub.lng + 180, new Date('2026-07-04T15:30:00Z')) < -89);

    /* Polar day and polar night — the strongest sanity check there is. */
    const midsummer = new Date('2026-06-21T00:00:00Z');
    check('the North Pole is in daylight at the June solstice',
        isDaylight(89.9, 0, midsummer));
    check('and the South Pole is in darkness at the same moment',
        !isDaylight(-89.9, 0, midsummer));
    check('the poles swap at the December solstice',
        !isDaylight(89.9, 0, new Date('2026-12-21T00:00:00Z'))
        && isDaylight(-89.9, 0, new Date('2026-12-21T00:00:00Z')));

    /* The sun vector must live in the same frame as the globe's own
       lat/lng conversion, or the lit hemisphere and the terminator disagree. */
    const dir = sunDirection(new Date('2026-06-21T12:00:00Z'));
    const len = Math.hypot(dir.x, dir.y, dir.z);
    check('the sun direction is a unit vector', Math.abs(len - 1) < 1e-9);
    check('it points north of the equator at the June solstice', dir.y > 0);
    check('and south of it in December',
        sunDirection(new Date('2026-12-21T12:00:00Z')).y < 0);
}

/* ------------------------------------------------------------ landmarks */

/* Real response shapes, trimmed. Both parsers are what stands between a
   provider changing a field name and the globe silently losing its labels. */
const WIKI_SAMPLE = {
    query: {
        geosearch: [
            { pageid: 2239406, title: 'Fillmore West', lat: 37.774742, lon: -122.419433, dist: 17.8 },
            { pageid: 1511602, title: 'Van Ness station', lat: 37.775, lon: -122.419, dist: 36.9 },
            /* Malformed entries do turn up; they must not become NaN markers
               floating at the centre of the globe. */
            { pageid: 3, title: 'No coordinates' },
            { pageid: 4, lat: 1, lon: 2 }
        ]
    }
};

const wiki = parseWikiGeosearch(WIKI_SAMPLE);
check('wikipedia geosearch parses the good rows', wiki.length === 2);
check('and drops rows with no coordinates or no title',
    wiki.every((w) => Number.isFinite(w.lat) && Number.isFinite(w.lng) && w.name));
check('metres become kilometres', Math.abs(wiki[0].distanceKm - 0.0178) < 1e-6);
check('the source is reported', wiki[0].source === 'wikipedia');

/* Field names verified against the Places API (New) Place resource. */
const GOOGLE_SAMPLE = {
    places: [
        { id: 'a', displayName: { text: 'Golden Gate Bridge' }, location: { latitude: 37.8199, longitude: -122.4783 }, types: ['tourist_attraction'] },
        { id: 'b', displayName: { text: 'Broken' } }
    ]
};

const goog = parseGooglePlaces(GOOGLE_SAMPLE);
check('places parses displayName.text and location', goog.length === 1 && goog[0].name === 'Golden Gate Bridge');
check('and reads the LatLng the reference documents',
    Math.abs(goog[0].lat - 37.8199) < 1e-9 && Math.abs(goog[0].lng + 122.4783) < 1e-9);
check('the place id is kept — the one field exempt from their caching rule',
    goog[0].placeId === 'a');

/* Ranking */
const ranked = rankLandmarks([
    { name: 'Far Thing', lat: 38.5, lng: -122.4, source: 'x' },
    { name: 'Near Thing', lat: 37.775, lng: -122.419, source: 'x' },
    { name: 'near thing', lat: 37.776, lng: -122.420, source: 'x' },
    { name: 'Nowhere', lat: null, lng: null, source: 'x' }
], { lat: 37.7749, lng: -122.4194, limit: 5 });
check('duplicate names collapse regardless of case', ranked.length === 2);
check('and the nearest label comes first', ranked[0].name === 'Near Thing');
check('entries with no coordinates are dropped', ranked.every((r) => Number.isFinite(r.lat)));
check('distance is filled in when the provider did not give one',
    Number.isFinite(ranked[0].distanceKm));
check('the limit is honoured',
    rankLandmarks(wiki.concat(wiki), { lat: 37.77, lng: -122.42, limit: 1 }).length === 1);

/* Thinning. Four downtown points inside ~400 m plus two genuinely distant
   ones is the San Francisco case that printed five labels on one pixel. */
const clustered = [
    { name: 'Moscone Center', lat: 37.7840, lng: -122.4010 },
    { name: 'SFMOMA', lat: 37.7857, lng: -122.4011 },
    { name: 'Benu', lat: 37.7845, lng: -122.3990 },
    { name: 'W San Francisco', lat: 37.7852, lng: -122.3995 },
    { name: 'Fisherman’s Wharf', lat: 37.8080, lng: -122.4177 },
    { name: 'Golden Gate Bridge', lat: 37.8199, lng: -122.4783 }
];
const thinned = rankLandmarks(clustered, { lat: 37.7840, lng: -122.4010, limit: 5 });
check('a downtown cluster collapses to one representative',
    thinned.filter((t) => distanceKm(37.784, -122.401, t.lat, t.lng) < 1).length === 1);
check('and the distant landmarks survive',
    thinned.some((t) => t.name === 'Golden Gate Bridge')
    && thinned.some((t) => t.name.includes('Wharf')));
check('no two chosen labels sit within the separation floor',
    thinned.every((a, i) => thinned.every((b, j) =>
        i === j || distanceKm(a.lat, a.lng, b.lat, b.lng) >= 1.2)));
/* The city pin is drawn outside this list, so it must be declared taken or a
   landmark lands on top of it and both labels print through each other —
   "BENGALURU (OSM)" over "MINISTRY... (GOOGLE)" as one nonsense string. */
const withPin = rankLandmarks(clustered, {
    lat: 37.7840, lng: -122.4010, limit: 5,
    exclude: [{ lat: 37.7840, lng: -122.4010 }]
});
check('nothing is placed on top of the city pin',
    withPin.every((t) => distanceKm(37.784, -122.401, t.lat, t.lng) >= 1.2));
check('and the distant landmarks still make it through',
    withPin.some((t) => t.name === 'Golden Gate Bridge'));
check('a malformed exclusion is ignored rather than throwing',
    rankLandmarks(clustered, { lat: 37.784, lng: -122.401, limit: 5, exclude: [{ lat: null }] }).length > 0);

/* Thinning must not be able to starve the ring down to nothing. */
check('an all-clustered list still yields labels rather than none',
    rankLandmarks(clustered.slice(0, 4), { lat: 37.784, lng: -122.401, limit: 5 }).length > 0);

/* The service: no network in tests, so the fetch is stubbed. */
const wikiService = createLandmarkService({
    getSettings: () => ({}),
    fetchImpl: async () => ({ ok: true, json: async () => WIKI_SAMPLE })
});
const viaWiki = await wikiService.near(37.7749, -122.4194, { limit: 5 });
check('with no key the service uses Wikipedia', viaWiki.source === 'wikipedia');
/* The two sample points are ~30 m apart, so thinning is SUPPOSED to keep one:
   a service that returned both would be the label-stacking bug. */
check('and returns usable landmarks', viaWiki.items.length === 1);
check('collapsing the pair that sits within the separation floor',
    viaWiki.items[0].source === 'wikipedia' && Number.isFinite(viaWiki.items[0].lat));
check('Google reports itself unconfigured rather than silently off',
    wikiService.status().find((p) => p.key === 'google')?.configured === false);

/* A key present must actually route to Places, and must carry the field mask —
   the request is rejected without one. */
let sawUrl = null, sawMask = null;
const googleService = createLandmarkService({
    getSettings: () => ({ googleMapsApiKey: 'test-key' }),
    fetchImpl: async (url, opts) => {
        sawUrl = url; sawMask = opts?.headers?.['X-Goog-FieldMask'];
        return { ok: true, json: async () => GOOGLE_SAMPLE };
    }
});
const viaGoogle = await googleService.near(37.7749, -122.4194, { limit: 5 });
check('a configured key routes to Places', viaGoogle.source === 'google');
check('at the searchNearby endpoint', String(sawUrl).includes('places:searchNearby'));
check('with the required field mask', !!sawMask && sawMask.includes('places.location'));
check('and it credits Google, as their terms require', viaGoogle.attribution === 'Google');
check('the logo obligation is surfaced, not buried',
    googleService.status().find((p) => p.key === 'google')?.logoRequired === true);

/* The main-process bridge — the route the real key takes. The renderer must
   never need, or receive, the key itself. */
let bridgeArgs = null;
const bridged = createLandmarkService({
    getSettings: () => ({}),                 // no key in the renderer, by design
    fetchImpl: async () => { throw new Error('renderer must not fetch Places directly'); },
    placesBridge: async (opts) => { bridgeArgs = opts; return { ok: true, data: GOOGLE_SAMPLE }; }
});
const viaBridge = await bridged.near(37.7749, -122.4194, { limit: 5, radiusKm: 10 });
check('the bridge is used even with no renderer-side key', viaBridge.source === 'google');
check('and it is asked in metres, clamped by main', bridgeArgs?.radiusM === 10000);
check('the provider reports configured once main answers',
    bridged.status().find((p) => p.key === 'google')?.configured === true);
check('Google is still credited through the bridge', viaBridge.attribution === 'Google');

/* `no-key` is a normal answer and must fall through, not fail. */
const noKeyBridge = createLandmarkService({
    getSettings: () => ({}),
    fetchImpl: async () => ({ ok: true, json: async () => WIKI_SAMPLE }),
    placesBridge: async () => ({ ok: false, reason: 'no-key' })
});
const fellBack = await noKeyBridge.near(37.7749, -122.4194, { limit: 5 });
check('no key in main falls back to Wikipedia', fellBack.source === 'wikipedia');
check('and Google is reported unconfigured, not broken',
    noKeyBridge.status().find((p) => p.key === 'google')?.configured === false);

/* A rejected key must say why rather than read as "offline". */
const badKeyBridge = createLandmarkService({
    getSettings: () => ({}),
    fetchImpl: async () => ({ ok: true, json: async () => WIKI_SAMPLE }),
    placesBridge: async () => ({ ok: false, reason: 'http-403', detail: 'API_KEY_SERVICE_BLOCKED' })
});
await badKeyBridge.near(37.7749, -122.4194, { limit: 5 });
check("a rejected key surfaces Google's own reason",
    /403/.test(badKeyBridge.status().find((p) => p.key === 'google')?.state || '')
    && /SERVICE_BLOCKED/.test(badKeyBridge.status().find((p) => p.key === 'google')?.state || ''));

/* A dead network is the normal case for a local-first app. */
const deadService = createLandmarkService({
    getSettings: () => ({}),
    fetchImpl: async () => { throw new Error('offline'); }
});
const dead = await deadService.near(37.7749, -122.4194);
check('an unreachable provider yields no landmarks rather than throwing',
    dead.items.length === 0 && dead.source === null);

/* --------------------------------------------------- google maps services */

/* Real response shapes, trimmed from live calls against the project key. */
const GEOCODE_SAMPLE = {
    results: [{
        formatted_address: 'Delhi, India',
        address_components: [
            { long_name: 'Delhi', types: ['locality', 'political'] },
            { long_name: 'India', types: ['country', 'political'] }
        ],
        geometry: { location: { lat: 28.7041, lng: 77.1025 }, location_type: 'APPROXIMATE' },
        place_id: 'ChIJLbZ-NFv9DDkRQJY4FbcFcgM'
    }],
    status: 'OK'
};

const g = parseGeocode(GEOCODE_SAMPLE);
check('geocode parses the locality, not the postal string', g?.name === 'Delhi');
check('and the coordinates', Math.abs(g.lat - 28.7041) < 1e-6 && Math.abs(g.lng - 77.1025) < 1e-6);
check('country is carried through', g.country === 'India');
check('an APPROXIMATE hit still scores high enough to act on', g.score >= 0.8);
check('and is attributed to google', g.source === 'google');
check('an empty geocode response yields null', parseGeocode({ results: [] }) === null);
check('a malformed location yields null rather than NaN coordinates',
    parseGeocode({ results: [{ geometry: { location: { lat: 'x', lng: 2 } } }] }) === null);

/* Local time from the offset. */
const noon = new Date('2026-08-04T12:00:00Z');
check('a negative offset moves the clock back',
    localTime(-7 * 3600, noon) === '05:00');
check('a positive offset moves it forward', localTime(5.5 * 3600, noon) === '17:30');
check('a missing offset yields no time at all', localTime(null, noon) === null);

/* The status line. ABSENT MUST NOT RENDER AS ZERO — this is the assertion
   that matters, because 0°C and "no reading" look identical if you are
   careless, and one of them is a lie about the weather. */
const full = describeDossier({
    utcOffsetSec: -7 * 3600, temperatureC: 18.34, condition: 'Partly cloudy',
    elevationM: 15.567, aqi: 58, aqiCategory: 'Good air quality', streetViewDate: '2025-05'
}, noon);
check('the dossier line reads as one sentence of facts', /05:00 local/.test(full));
check('temperature is rounded, not printed raw', /18\.3°C/.test(full) && !/18\.34/.test(full));
check('elevation is a whole number of metres', /16 m elevation/.test(full));
check('the AQI category is trimmed of its boilerplate',
    /AQI 58 \(Good\)/.test(full) && !/Good air quality/.test(full));
check('street view vintage appears', /street view 2025-05/.test(full));

const sparse = describeDossier({ utcOffsetSec: 0, temperatureC: null, aqi: null }, noon);
check('a missing temperature is omitted, never shown as 0°C',
    sparse === '12:00 local');
check('an all-empty dossier yields null, so nothing is drawn',
    describeDossier({}) === null && describeDossier(null) === null);
/* A real zero must still print — the guard is on absence, not on falsiness. */
const freezing = describeDossier({ temperatureC: 0, elevationM: 0 }, noon);
check('a genuine zero is still reported', /0°C/.test(freezing) && /0 m/.test(freezing));

/* ---- Geocoding v4: country, state, city, street, building ---- */

/* Response shapes copied from live v4 calls with the project key. */
const V4 = (name, lat, lng, gran, types, comps, viewport) => ({
    results: [{
        formattedAddress: name, location: { latitude: lat, longitude: lng },
        granularity: gran, types, addressComponents: comps, viewport
    }]
});

const japan = parseGeocodeV4(V4('Japan', 36.2048, 138.2529, 'APPROXIMATE',
    ['country', 'political'], [{ longText: 'Japan', types: ['country', 'political'] }],
    { low: { latitude: 19.7696, longitude: 119.2119 }, high: { latitude: 47.2307, longitude: 155.0958 } }));
check('a COUNTRY resolves', japan?.name === 'Japan');
check('and is measured, not guessed', japan.spanKm > 2000 && japan.spanKm < 4000);
check('its granularity is reported', japan.granularity === 'APPROXIMATE');

const karnataka = parseGeocodeV4(V4('Karnataka, India', 15.3173, 75.7139, 'APPROXIMATE',
    ['administrative_area_level_1'],
    [{ longText: 'Karnataka', types: ['administrative_area_level_1'] }, { longText: 'India', types: ['country'] }]));
check('a STATE resolves to its own name, not the country',
    karnataka?.name === 'Karnataka' && karnataka.country === 'India');

const blr = parseGeocodeV4(V4('Bengaluru, Karnataka, India', 12.9629, 77.5775, 'APPROXIMATE',
    ['locality'], [{ longText: 'Bengaluru', types: ['locality'] }, { longText: 'India', types: ['country'] }]));
check('a CITY prefers the locality over the state', blr?.name === 'Bengaluru');

const rooftop = parseGeocodeV4(V4('1600 Amphitheatre Pkwy, Mountain View, CA', 37.4224, -122.0856,
    'ROOFTOP', ['premise', 'street_address'], [{ longText: 'Mountain View', types: ['locality'] }]));
check('a BUILDING resolves at rooftop precision', rooftop?.granularity === 'ROOFTOP');
check('and is named by its own address line, not by its city',
    rooftop.name === '1600 Amphitheatre Pkwy');

/* A street must name the street. Labelling "MG Road Bengaluru" as "Bengaluru"
   is correct about the city and useless as a label for what was asked. */
const road = parseGeocodeV4(V4('Mahatma Gandhi Rd, Bengaluru, Karnataka, India', 12.9752, 77.6094,
    'GEOMETRIC_CENTER', ['route'], [{ longText: 'Bengaluru', types: ['locality'] }]));
check('a STREET is named by the street', road?.name === 'Mahatma Gandhi Rd');
check('while the city it sits in is still a coarser result',
    blr.name === 'Bengaluru');
check('and scores above a centroid', rooftop.score > japan.score);
check('v4 with no coordinates yields null',
    parseGeocodeV4({ results: [{ formattedAddress: 'x' }] }) === null);

/* Framing from measured extent — the reason no zoom table exists anywhere. */
check('a country is framed further out than a city',
    cameraDistanceFor(3000, 5) > cameraDistanceFor(20, 5));
check('a state sits between the two',
    cameraDistanceFor(500, 5) > cameraDistanceFor(20, 5)
    && cameraDistanceFor(500, 5) < cameraDistanceFor(3000, 5));
check('framing never goes inside the globe or loses it',
    [0.01, 1, 100, 5000, 40000].every((s) => {
        const d = cameraDistanceFor(s, 5);
        return d >= 5 * 1.4 && d <= 5 * 4;
    }));
check('an unmeasurable span falls back to the city default',
    cameraDistanceFor(null, 5) === 5 * 1.9);
check('longitude is narrowed towards the poles',
    spanKmFromViewport({ low: { latitude: 70, longitude: 0 }, high: { latitude: 70.1, longitude: 10 } })
    < spanKmFromViewport({ low: { latitude: 0, longitude: 0 }, high: { latitude: 0.1, longitude: 10 } }));
check('a missing viewport is null, not zero', spanKmFromViewport(null) === null);

/* Routes. */
check('a route is described in km and minutes',
    describeRoute({ routes: [{ distanceMeters: 10067, duration: '1266s' }] }) === '10.1 km, 21 min');
check('an empty route yields null', describeRoute({ routes: [] }) === null);

/* The service refuses to invent anything when there is no bridge. */
{
    const offline = createGoogleServices({ bridge: null });
    check('with no bridge the service reports itself unavailable', offline.available() === false);
    check('and geocode returns null rather than guessing',
        (await offline.geocode('Delhi')) === null);
    check('and the dossier is null, not an empty object',
        (await offline.dossier(1, 2)) === null);
}

/* Caching: the same dossier twice must cost one round trip. */
{
    let calls = 0;
    const svc = createGoogleServices({
        bridge: async (method) => { calls++; return { ok: true, data: { elevationM: 10 } }; }
    });
    await svc.dossier(37.7, -122.4);
    await svc.dossier(37.7, -122.4);
    check('a repeated dossier is served from cache', calls === 1);
    await svc.dossier(48.8, 2.3);
    check('a different point is not', calls === 2);
}

/* A failed call must not be cached, or one blip poisons the point forever. */
{
    let calls = 0;
    const flaky = createGoogleServices({
        bridge: async () => { calls++; return calls === 1 ? { ok: false, reason: 'timeout' } : { ok: true, data: { elevationM: 5 } }; }
    });
    check('a failed lookup returns null', (await flaky.dossier(1, 1)) === null);
    const second = await flaky.dossier(1, 1);
    check('and is retried rather than cached as a failure',
        calls === 2 && second?.elevationM === 5);
}

/* ------------------------------------------------------- place imagery */

/* Cost policy. Free sources must come before billed ones for every kind of
   place, and "Japan" must never become a Places query — that returns a
   restaurant called Japan. */
check('a country asks Wikipedia before anything billed',
    sourcesFor('APPROXIMATE', ['country'])[0] === 'wikipedia');
check('and never asks Places for a country',
    !sourcesFor('APPROXIMATE', ['country']).includes('places'));
check('a state behaves like a country',
    sourcesFor('APPROXIMATE', ['administrative_area_level_1'])[0] === 'wikipedia');
check('a city tries free sources first',
    ['wikipedia', 'wikimedia'].includes(sourcesFor('APPROXIMATE', ['locality'])[0]));
/* Google returns APPROXIMATE for a city AND for a country, so the type has to
   be what separates them — matching on granularity put Bengaluru in the
   country branch and returned a satellite tile instead of a photograph. */
check('a city is not mistaken for a country despite sharing APPROXIMATE',
    sourcesFor('APPROXIMATE', ['locality']).includes('places')
    && !sourcesFor('APPROXIMATE', ['locality']).includes('satellite'));
check('a place with no type at all is treated as a city',
    sourcesFor(null, []).includes('places'));
check('a street reaches Street View, which is what it is for',
    sourcesFor('GEOMETRIC_CENTER', ['route']).includes('streetview'));
check('and still tries free Commons first',
    sourcesFor('GEOMETRIC_CENTER', ['route'])[0] === 'wikimedia');
check('a building tries free before billed',
    sourcesFor('ROOFTOP', ['premise']).indexOf('wikimedia')
    < sourcesFor('ROOFTOP', ['premise']).indexOf('streetview'));

/* Parsing, with the real response shapes. */
const wpJson = {
    title: 'Japan',
    originalimage: { source: 'https://upload.wikimedia.org/x.jpg', width: 900, height: 600 },
    thumbnail: { source: 'https://upload.wikimedia.org/x-thumb.jpg' },
    content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Japan' } }
};
const wpImg = parseWikipediaSummary(wpJson);
check('a wikipedia lead image parses', wpImg?.url === 'https://upload.wikimedia.org/x.jpg');
check('and carries a licence and a credit',
    !!wpImg.attribution?.name && /CC BY-SA/.test(wpImg.license?.name));
check('an article with no image yields null', parseWikipediaSummary({ title: 'x' }) === null);

const wmJson = {
    query: {
        pages: {
            '1': {
                title: 'File:Eiffel Tower.jpg',
                imageinfo: [{
                    thumburl: 'https://upload.wikimedia.org/thumb.jpg', thumbwidth: 1280, thumbheight: 1707,
                    descriptionurl: 'https://commons.wikimedia.org/wiki/File:Eiffel',
                    extmetadata: {
                        Artist: { value: '<a href="/wiki/User:Bob">Bob</a>' },
                        LicenseShortName: { value: 'CC BY 3.0' },
                        LicenseUrl: { value: 'https://creativecommons.org/licenses/by/3.0/' }
                    }
                }]
            },
            /* No attribution at all — must be dropped, not shown bare. */
            '2': { title: 'File:Anon.jpg', imageinfo: [{ thumburl: 'https://x/y.jpg', extmetadata: {} }] }
        }
    }
};
const wmImgs = parseWikimediaGeosearch(wmJson);
check('commons images parse with the File: prefix stripped',
    wmImgs[0]?.title === 'Eiffel Tower.jpg');
check('the HTML in the Artist field is stripped to a name',
    wmImgs[0].attribution.name === 'Bob');
check('the CC licence is carried', wmImgs[0].license.name === 'CC BY 3.0');
/* The un-credited file still gets a fallback credit rather than vanishing —
   what must never happen is an image with NO attribution being returned. */
check('every returned image has an attribution',
    wmImgs.every((i) => !!i.attribution?.name));

check('a satellite view exists for scales no photograph covers',
    satelliteImage(35.6, 139.6, 50)?.provider === 'satellite');
check('and credits the imagery provider',
    /Esri/.test(satelliteImage(35.6, 139.6, 50).attribution.name));
check('bad coordinates yield no satellite image', satelliteImage(null, null) === null);

/* The engine: free first, and Google untouched when free sources suffice. */
{
    let bridgeCalls = 0;
    const engine = createPlaceImages({
        bridge: async () => { bridgeCalls++; return { ok: false, reason: 'should-not-be-called' }; },
        fetchImpl: async (url) => ({
            ok: true,
            json: async () => (String(url).includes('rest_v1') ? wpJson : wmJson)
        })
    });
    const res = await engine.forPlace(
        { name: 'Japan', lat: 36.2, lng: 138.2, granularity: 'APPROXIMATE', types: ['country'], spanKm: 3331 },
        { limit: 4 }
    );
    check('a country gets images without spending anything', res.images.length > 0 && bridgeCalls === 0);
    check('and the caller is told attribution is owed', res.attributionRequired === true);
}

/* Street View must not be bought before the free metadata check clears it. */
{
    const calls = [];
    const engine = createPlaceImages({
        fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
        bridge: async (method) => {
            calls.push(method);
            if (method === 'streetViewMeta') return { ok: true, data: { status: 'ZERO_RESULTS' } };
            return { ok: true, data: { dataUri: 'data:image/jpeg;base64,xx' } };
        }
    });
    await engine.forPlace({ name: 'x', lat: 1, lng: 2, granularity: 'GEOMETRIC_CENTER', types: ['route'] });
    check('the free metadata check runs first', calls.includes('streetViewMeta'));
    check('and no image is bought when there is no imagery',
        !calls.includes('streetViewImage'));
}

/* A Places photo with no author attribution must never be fetched — showing it
   would breach the terms, so buying it would be waste as well as breach. */
{
    const calls = [];
    const engine = createPlaceImages({
        fetchImpl: async () => ({ ok: false }),
        bridge: async (method) => {
            calls.push(method);
            if (method === 'placePhotos') {
                return { ok: true, data: { placeName: 'X', photos: [{ name: 'places/a/photos/b', attributions: [] }] } };
            }
            return { ok: true, data: { dataUri: 'data:image/jpeg;base64,xx' } };
        }
    });
    const res = await engine.forPlace({ name: 'X', lat: 1, lng: 2, granularity: 'ROOFTOP', types: ['point_of_interest'] });
    check('an uncredited Places photo is never fetched', !calls.includes('placePhotoMedia'));
    check('and no image is returned for it', res.images.every((i) => i.provider !== 'google_places'));
}

/* Nothing found means nothing shown — no stock photo, no grey placeholder. */
{
    const engine = createPlaceImages({
        fetchImpl: async () => { throw new Error('offline'); },
        bridge: null
    });
    const res = await engine.forPlace({ name: 'Nowhere', lat: 1, lng: 2, granularity: 'APPROXIMATE', types: ['locality'] });
    check('an offline lookup returns no images rather than a placeholder',
        res.images.length === 0 && res.attributionRequired === false);
}

/* --------------------------------------------------------- feed honesty */

/* FIRMS needs a MAP_KEY. Verified live: a keyless request returns
   "Invalid MAP_KEY." — so a feed that claims to be configured without one is
   lying, and polling it can never succeed. */
{
    let fetched = 0;
    const noKey = createDataFeeds({
        getSettings: () => ({}),
        fetchImpl: async () => { fetched++; return { ok: true, text: async () => 'Invalid MAP_KEY.' }; }
    });
    const fire = noKey.status().find((f) => f.key === 'wildfires');
    check('FIRMS reports itself unconfigured without a MAP_KEY', fire.configured === false);
    check('and says where to get one', /MAP_KEY/i.test(fire.state) && /firms/i.test(fire.state));

    await noKey.refreshFires?.();
    check('and is never polled without one', fetched === 0);
}

/* The endpoint answers 200 with a plain-text complaint, so a 200 is not proof
   of data — a parser that trusted the status code would store zero fires and
   report "live". */
{
    const badKey = createDataFeeds({
        getSettings: () => ({ firmsMapKey: 'wrong' }),
        fetchImpl: async () => ({ ok: true, text: async () => 'Invalid MAP_KEY.' })
    });
    await badKey.refreshFires?.();
    const fire = badKey.status().find((f) => f.key === 'wildfires');
    check('a 200 carrying "Invalid MAP_KEY" is treated as a failure',
        !/^live/.test(fire.state));
    check('and the reason is carried, not flattened to "offline"',
        /MAP_KEY/i.test(fire.state));
}

/* A real key must build the documented segment order. Omitting the key shifts
   every segment along, which is exactly the bug this replaced. */
{
    let seen = null;
    const good = createDataFeeds({
        getSettings: () => ({ firmsMapKey: 'REALKEY' }),
        fetchImpl: async (url) => {
            seen = url;
            return { ok: true, text: async () => 'latitude,longitude,bright_ti4,confidence,acq_date,acq_time\n1.5,2.5,330,high,2026-08-04,1200\n' };
        }
    });
    await good.refreshFires?.();
    check('the MAP_KEY is the FIRST path segment after /csv/',
        /\/api\/area\/csv\/REALKEY\/VIIRS_SNPP_NRT\/world\/1$/.test(String(seen)));
    const fire = good.status().find((f) => f.key === 'wildfires');
    check('and a valid CSV goes live', /^live/.test(fire.state) && fire.count === 1);
}

/* OpenSky's anonymous quota is ~100/day. Polling every 30s is 2,880. */
{
    const feeds = createDataFeeds({ getSettings: () => ({}), fetchImpl: async () => ({ ok: false }) });
    const flights = feeds.feeds.flights;
    const perDay = 86400000 / flights.intervalMs;
    check('the flight poll stays inside the anonymous daily budget', perDay <= 100);
    check('and is not the 30-second interval that would be 2,880 a day',
        flights.intervalMs >= 10 * 60 * 1000);
}

/* ------------------------------------------------------------ luma events */

/* Shapes taken from the live OpenAPI document at
   public-api.luma.com/openapi.json — `coordinate` is {latitude, longitude} or
   null, documented as "Null for online events or when the address can't be
   geocoded". */
const LUMA_LIST = {
    entries: [
        {
            event: {
                api_id: 'evt-1', name: 'AI Builder Night',
                start_at: '2026-08-10T18:00:00Z', end_at: '2026-08-10T21:00:00Z',
                timezone: 'America/Los_Angeles',
                coordinate: { latitude: 37.7749, longitude: -122.4194 },
                geo_address_json: { address: '3180 18th St', city: 'San Francisco', region: 'CA', country: 'USA', full_address: '3180 18th St, San Francisco, CA' },
                cover_url: 'https://images.lumacdn.com/event-covers/a/b.png',
                url: 'https://lu.ma/ai-builder-night',
                location_type: 'offline', visibility: 'public', spots_remaining: 12
            }
        },
        /* Online event — no coordinate. Must survive the parse and be excluded
           from the globe rather than pinned at (0,0). */
        {
            event: {
                api_id: 'evt-2', name: 'Remote AMA',
                start_at: '2026-08-11T15:00:00Z', coordinate: null,
                geo_address_json: null, location_type: 'zoom', url: 'remote-ama'
            }
        },
        { event: null }
    ],
    has_more: false, next_cursor: null
};

const lumaEvents = normaliseList(LUMA_LIST);
check('luma entries parse', lumaEvents.length === 2);
check('coordinates are read from `coordinate`, not transposed',
    Math.abs(lumaEvents[0].lat - 37.7749) < 1e-9 && Math.abs(lumaEvents[0].lng + 122.4194) < 1e-9);
check('the cover image survives', /lumacdn/.test(lumaEvents[0].coverUrl));
check('city and country come from geo_address_json',
    lumaEvents[0].city === 'San Francisco' && lumaEvents[0].country === 'USA');
check('a relative url is absolutised to lu.ma',
    lumaEvents[1].url === 'https://lu.ma/remote-ama');
check('an online event keeps null coordinates rather than becoming (0,0)',
    lumaEvents[1].lat === null && lumaEvents[1].lng === null);
check('a null entry is dropped, not fatal', lumaEvents.every((e) => !!e.id));
check('spots remaining is carried', lumaEvents[0].spotsRemaining === 12);
check('an empty response parses to nothing', normaliseList({ entries: [] }).length === 0);
check('a null response does not throw', normaliseList(null).length === 0);

/* The ticker line must render in the EVENT's timezone, not the desk's. */
{
    const line = describeEvent(lumaEvents[0]);
    check('the event ticker names the event and its city',
        /AI Builder Night/.test(line) && /San Francisco/.test(line));
    const tokyo = describeEvent({
        kind: 'event', name: 'Tokyo Meetup', city: 'Tokyo',
        startAt: '2026-08-10T09:00:00Z', timezone: 'Asia/Tokyo'
    });
    check('and the time is shown where the event is, not where the user is',
        /18:00/.test(tokyo));
}

/* Feed honesty: without a key it must say so and never poll. */
{
    let called = 0;
    const noKey = createDataFeeds({
        getSettings: () => ({}),
        fetchImpl: async () => ({ ok: false }),
        lumaBridge: async () => { called++; return { ok: false, reason: 'no-key' }; }
    });
    await noKey.refreshEvents?.();
    const ev = noKey.status().find((f) => f.key === 'events');
    check('Luma reports itself unconfigured without a key', ev.configured === false);
    check('and names the key it needs', /LUMA_API_KEY/.test(ev.state));
}

/* A calendar whose events are all online is a real state, not a failure. */
{
    const online = createDataFeeds({
        getSettings: () => ({}),
        fetchImpl: async () => ({ ok: false }),
        lumaBridge: async () => ({ ok: true, data: { events: [lumaEvents[1]] } })
    });
    await online.refreshEvents?.();
    const ev = online.status().find((f) => f.key === 'events');
    check('an online-only calendar is live with zero markers, and says why',
        /^live/.test(ev.state) && /coordinate/i.test(ev.state) && ev.count === 0);
}

/* Placeable events reach the globe and the proximity search. */
{
    const live = createDataFeeds({
        getSettings: () => ({}),
        fetchImpl: async () => ({ ok: false }),
        lumaBridge: async () => ({ ok: true, data: { events: lumaEvents } })
    });
    await live.refreshEvents?.();
    check('only events with coordinates become markers',
        live.feeds.events.data.length === 1);
    check('and they are found by proximity',
        live.near(37.77, -122.42, 50).some((e) => e.kind === 'event'));
    check('while a distant search does not return them',
        !live.near(51.5, -0.12, 50).some((e) => e.kind === 'event'));
}

/* ------------------------------------------------ dossier field contract

   The panel and the spoken briefing both read the dossier directly. They were
   both written against a NESTED shape (`dossier.weather.temperature`,
   `dossier.airQuality.index`) that the service has never produced — it returns
   flat fields — so both silently rendered nothing. Absent data is a supported
   state here, which is exactly why the mismatch was invisible.

   These pin the contract from the producing side, so it cannot drift again
   without a test failing. */
{
    const source = readFileSync(path.join(REPO, 'googleMaps.js'), 'utf8');
    const panel = readFileSync(path.join(REPO, 'src', 'js', 'components', 'dossierPanel.js'), 'utf8');
    const brief = readFileSync(path.join(REPO, 'src', 'js', 'jarvis.js'), 'utf8');

    for (const field of ['elevationM', 'timeZoneId', 'utcOffsetSec', 'temperatureC', 'aqi']) {
        check(`dossier() produces \`${field}\``, source.includes(`${field}:`));
    }
    check('the panel reads the flat temperature, not a nested one',
        panel.includes('dossier.temperatureC') && !panel.includes('dossier.weather?.temperature'));
    check('the panel reads the flat AQI',
        panel.includes('dossier.aqi') && !panel.includes('dossier.airQuality?.index'));
    check('the spoken briefing reads the flat fields too',
        brief.includes('dossier.temperatureC') && !brief.includes('dossier.weather?.temperature'));
}

/* ------------------------------------------------------- event intent */

/* "what events are happening in Tokyo" must extract Tokyo and mark the query
   as event-focused; "show me Tokyo" must not. */
{
    const eventWords = /\b(?:events?|meetups?|conferences?|hackathons?)\b/i;
    const at = /\b(?:in|at|near|around|on)\s+(?:the\s+)?([a-z][a-z .'-]{1,40}?)\s*[.?!]?$/i;
    const parse = (cmd) => (eventWords.test(cmd) ? at.exec(cmd)?.[1]?.trim() || null : null);

    check('"what events are happening in Tokyo" finds Tokyo', parse('what events are happening in Tokyo') === 'Tokyo');
    check('"show me events in San Francisco" finds San Francisco',
        parse('show me events in San Francisco') === 'San Francisco');
    check('"any meetups in Berlin" finds Berlin', parse('any meetups in Berlin') === 'Berlin');
    check('a plain place query is not event-focused', parse('show me Tokyo') === null);
    check('and neither is an unrelated command', parse('what is the weather') === null);
}

/* ----------------------------------------------------------------- docs */

/* The globe is the newest subsystem and the easiest to document once and let
   drift. These assert the claims that would be actively misleading if the code
   moved underneath them. */
{
    const globeDoc = (() => {
        try { return readFileSync(path.join(REPO, 'docs', 'GLOBE.md'), 'utf8'); }
        catch { return ''; }
    })();
    check('the globe reference exists', globeDoc.length > 2000);
    check('and documents the v4 endpoint that is actually called',
        globeDoc.includes('geocode.googleapis.com/v4/geocode/address'));
    check('and states the key never reaches the renderer',
        /never reaches the renderer|never crosses the bridge/i.test(globeDoc));
    check('and keeps the known fly-to limit visible rather than quietly dropped',
        /Known limits/.test(globeDoc) && /fly-to/i.test(globeDoc));

    const readme = (() => {
        try { return readFileSync(path.join(REPO, 'README.md'), 'utf8'); }
        catch { return ''; }
    })();
    check('the README links the globe reference', readme.includes('docs/GLOBE.md'));
    check('and lists the maps key alongside the other provider keys',
        readme.includes('GOOGLE_MAPS_API_KEY'));

    /* The header badges advertise the stack. A `logo=` slug that simple-icons
       does not have still returns a valid badge — just a bare coloured
       rectangle with no icon — so a typo is invisible unless someone looks.
       `usgs` and `luma` are two that do NOT exist and were caught this way.
       Checked against a known-good list rather than the network, so the suite
       stays offline. */
    const KNOWN_SLUGS = new Set([
        'electron', 'vite', 'three.js', 'threedotjs', 'node.js', 'javascript',
        'ollama', 'google', 'openai', 'python', 'webgl',
        'googlecalendar', 'googlemeet', 'auth0', 'webaudio', 'npm',
        'googlemaps', 'openstreetmap', 'wikipedia', 'wikimediacommons',
        'googleearth', 'nasa', 'airplayaudio', 'esri',
        'spotify', 'android', 'kotlin', 'gradle', 'square', 'socketdotio',
        'windows'
    ]);
    const slugs = [...readme.matchAll(/[?&]logo=([\w.-]+)/g)].map((m) => m[1]);
    const unknown = [...new Set(slugs)].filter((s) => !KNOWN_SLUGS.has(s));
    check(`every badge logo slug is a real one${unknown.length ? ` — unknown: ${unknown.join(', ')}` : ''}`,
        unknown.length === 0);
    check('the globe data sources are advertised in the badges',
        ['googlemaps', 'openstreetmap', 'wikipedia', 'nasa'].every((s) => slugs.includes(s)));
    /* Line-ending agnostic on purpose. An editing pass that rewrote the file
       as CRLF turned this assertion red for a reason that had nothing to do
       with the claim being tested — the heading was there the whole time. The
       repo is LF, which the diff enforces far better than a unit test can. */
    check('and the Contents entry resolves to a real heading',
        readme.includes('- [Globe](#globe)') && /^## Globe\s*$/m.test(readme));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
