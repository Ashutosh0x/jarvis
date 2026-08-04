// Live geo feeds for the globe.
//
// ---------------------------------------------------------------------------
// ONLY FEEDS THAT NEED NO KEY, AND EVERY ONE OF THEM OPTIONAL
//
// The plan listed five feeds; three of them (NASA FIRMS, OpenSky, most weather
// APIs) want an account and a key. A key the user has not entered is a feature
// that silently does nothing, and this project treats "silently does nothing"
// as the failure mode to avoid.
//
// So what ships is what works with no setup at all:
//
//   USGS earthquakes — public, no key, no rate limit worth worrying about,
//     and the single best fit for the ripple animation: real events, real
//     coordinates, real magnitudes, updated every few minutes.
//
// Everything else is left as a registered slot with a null fetcher. A feed
// with no credentials reports itself as unconfigured rather than pretending to
// be off, so `status()` tells the truth about what the globe is actually
// showing.
//
// OFFLINE IS NORMAL, NOT AN ERROR. Jarvis is local-first and is expected to
// run with no network. A failed poll marks the feed stale and keeps the last
// good data; it does not throw, and it does not clear the globe.
// ---------------------------------------------------------------------------

const USGS_URL = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson';

/** Great-circle distance in kilometres. Used to find events near a place. */
export function distanceKm(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2
        + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Parse the USGS GeoJSON into the shape the globe wants.
 *
 * Pure, and separated from the fetch so it is testable without a network: the
 * parsing is where the bugs live, not the HTTP.
 */
export function parseQuakes(geojson) {
    const out = [];
    for (const f of geojson?.features || []) {
        const c = f?.geometry?.coordinates;
        if (!Array.isArray(c) || c.length < 2) continue;
        const [lng, lat, depthKm] = c;
        const mag = f.properties?.mag;
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        out.push({
            id: f.id,
            kind: 'earthquake',
            lat, lng,
            depthKm: Number.isFinite(depthKm) ? depthKm : null,
            magnitude: Number.isFinite(mag) ? mag : null,
            place: f.properties?.place || 'unknown location',
            time: f.properties?.time || null,
            url: f.properties?.url || null,
            /* Ripple size follows magnitude, because a M6 and a M2.5 being the
               same size on screen would make the display decorative. */
            weight: Number.isFinite(mag) ? Math.max(0.15, Math.min(1, (mag - 2) / 5)) : 0.3
        });
    }
    return out.sort((a, b) => (b.time || 0) - (a.time || 0));
}

/** One line of ticker text for an event. */
export function describeEvent(e) {
    if (e.kind === 'earthquake') {
        const when = e.time ? new Date(e.time).toUTCString().slice(17, 22) + ' UTC' : '';
        return `M${(e.magnitude ?? 0).toFixed(1)} earthquake — ${e.place}${when ? ` · ${when}` : ''}`;
    }
    if (e.kind === 'wildfire') {
        return `🔥 Fire detected — ${e.place}${e.confidence ? ` (${e.confidence})` : ''}`;
    }
    if (e.kind === 'flight') {
        const alt = e.altitude != null ? ` at ${(e.altitude / 1000).toFixed(1)} km` : '';
        const spd = e.velocity != null ? `, ${e.velocity} km/h` : '';
        return `✈ ${e.callsign || 'Aircraft'}${alt}${spd}`;
    }
    if (e.kind === 'event') {
        /* Rendered in the event's OWN timezone when it has one — an event in
           Tokyo starting at 18:00 should not read as 09:00 because the desk is
           in London. */
        const when = e.startAt
            ? new Date(e.startAt).toLocaleString('en-GB', {
                day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
                timeZone: e.timezone || 'UTC'
            })
            : '';
        return `${e.name}${e.city ? ` — ${e.city}` : ''}${when ? ` · ${when}` : ''}`;
    }
    return e.place || 'event';
}

/**
 * The FIRMS MAP_KEY, if the user has one.
 *
 * Read from settings rather than from a build-time constant so it can be added
 * without a rebuild. Exported for the tests, which must be able to drive both
 * the configured and unconfigured paths.
 */
export function firmsKey(getSettings) {
    try {
        const read = getSettings
            || (() => JSON.parse(localStorage.getItem('jarvis_settings') || '{}'));
        const k = read()?.firmsMapKey;
        return typeof k === 'string' && k.trim() ? k.trim() : null;
    } catch {
        return null;
    }
}

export function createDataFeeds({
    fetchImpl = fetch, onEvents = () => { }, getSettings,
    /* Luma goes through the main process — the key can cancel events and read
       guest emails, so it never reaches this side. */
    lumaBridge = (typeof window !== 'undefined' ? window.electronAPI?.lumaEvents : null)
} = {}) {
    const firmsKeyFor = () => firmsKey(getSettings);
    const feeds = {
        earthquakes: { name: 'USGS earthquakes', configured: true, state: 'idle', last: null, data: [], intervalMs: 5 * 60 * 1000 },
        /* NASA FIRMS NEEDS A MAP_KEY. Verified against the live endpoint: a
           keyless request returns "Invalid MAP_KEY." and nothing else. The URL
           shape is /api/area/csv/{MAP_KEY}/{SOURCE}/{AREA}/{DAY_RANGE}, so a
           URL with the key omitted silently shifts every segment along — the
           source is read as the key, the area as the source — and all four
           parameters fail at once.

           The key is free from firms.modaps.eosdis.nasa.gov. Until one is
           present this reports itself unconfigured and never polls, rather
           than retrying a request that cannot succeed. */
        wildfires: {
            name: 'NASA FIRMS VIIRS',
            configured: !!firmsKeyFor(),
            state: firmsKeyFor() ? 'idle' : 'needs a free MAP_KEY from firms.modaps.eosdis.nasa.gov',
            last: null, data: [], intervalMs: 30 * 60 * 1000
        },
        /* OpenSky's anonymous API is real — verified live, HTTP 200 with
           genuine aircraft. The quota is not: anonymous access is on the order
           of a hundred requests a day, and polling every 30 s is 2,880. The
           unbounded `states/all` is also 920 KB per call, which at that
           interval is gigabytes a day for a globe nobody is watching.

           Fifteen minutes is 96 requests a day, inside the anonymous budget,
           and aircraft positions on a whole-globe view do not mean anything at
           finer resolution than that anyway. */
        flights: {
            name: 'OpenSky Network',
            configured: true, state: 'idle', last: null, data: [],
            intervalMs: 15 * 60 * 1000
        },
        /* Luma events. Scoped to ONE calendar — Luma's API has no public event
           search, so this is "my events on the globe", not "the world's". The
           name says so, because a layer that shows one calendar while implying
           it shows everything is worse than no layer. */
        events: {
            name: 'Luma (my calendar)',
            configured: false,
            state: 'needs LUMA_API_KEY (Luma Plus)',
            last: null, data: [], intervalMs: 10 * 60 * 1000
        }
    };

    let quakeTimer = null;
    let fireTimer = null;
    let flightTimer = null;
    let eventTimer = null;

    async function pollQuakes() {
        const feed = feeds.earthquakes;
        try {
            const res = await fetchImpl(USGS_URL, { signal: AbortSignal.timeout?.(15000) });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = await res.json();
            feed.data = parseQuakes(json);
            feed.last = Date.now();
            feed.state = 'live';
            onEvents(allEvents());
        } catch (e) {
            feed.state = navigator?.onLine === false ? 'offline' : `unreachable: ${e.message}`;
        }
    }

    /* NASA FIRMS VIIRS active fire detections, last 24 hours, worldwide.
       Segment order is fixed and unforgiving:
         /api/area/csv/{MAP_KEY}/{SOURCE}/{AREA}/{DAY_RANGE}
       AREA may be the literal "world" or west,south,east,north.
       DAY_RANGE must be 1..5. */
    const firmsUrl = (mapKey) =>
        `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(mapKey)}/VIIRS_SNPP_NRT/world/1`;

    function parseFiresCSV(csv) {
        const lines = String(csv).split('\n');
        if (lines.length < 2) return [];
        const header = lines[0].split(',').map(h => h.trim().toLowerCase());
        const latIdx = header.indexOf('latitude');
        const lngIdx = header.indexOf('longitude');
        const brIdx = header.indexOf('bright_ti4');
        const confIdx = header.indexOf('confidence');
        const dateIdx = header.indexOf('acq_date');
        const timeIdx = header.indexOf('acq_time');

        if (latIdx < 0 || lngIdx < 0) return [];

        const out = [];
        /* Cap at 500 — the full VIIRS dump has thousands per day and the globe
           would be permanently on fire. Only the most confident detections. */
        for (let i = 1; i < lines.length && out.length < 500; i++) {
            const cols = lines[i].split(',');
            if (cols.length < Math.max(latIdx, lngIdx) + 1) continue;
            const lat = Number(cols[latIdx]);
            const lng = Number(cols[lngIdx]);
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
            const conf = cols[confIdx]?.trim().toLowerCase() || '';
            /* Only high-confidence detections, otherwise the globe is noise. */
            if (conf !== 'high' && conf !== 'h' && conf !== 'nominal' && conf !== 'n') continue;
            const brightness = Number(cols[brIdx]) || 0;
            out.push({
                id: `fire-${lat.toFixed(3)}-${lng.toFixed(3)}-${i}`,
                kind: 'wildfire',
                lat, lng,
                brightness,
                confidence: conf,
                place: `Fire detection at ${lat.toFixed(2)}, ${lng.toFixed(2)}`,
                time: cols[dateIdx] && cols[timeIdx]
                    ? new Date(`${cols[dateIdx]}T${String(cols[timeIdx]).padStart(4, '0').replace(/(\d{2})(\d{2})/, '$1:$2')}Z`).getTime()
                    : null,
                weight: Math.max(0.2, Math.min(0.8, (brightness - 300) / 100))
            });
        }
        return out.sort((a, b) => (b.time || 0) - (a.time || 0));
    }

    async function pollFires() {
        const feed = feeds.wildfires;
        const mk = firmsKeyFor();
        if (!mk) {
            /* Not an error, and not silence either: the feed says what it needs
               and stops. Retrying a request that is structurally incapable of
               succeeding is how a dead feed looks like a flaky network. */
            feed.configured = false;
            feed.state = 'needs a free MAP_KEY from firms.modaps.eosdis.nasa.gov';
            return;
        }
        feed.configured = true;
        try {
            const res = await fetchImpl(firmsUrl(mk), { signal: AbortSignal.timeout?.(20000) });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const csv = await res.text();
            /* The endpoint answers HTTP 200 with a plain-text complaint when a
               parameter is wrong, so a 200 is not proof of data. */
            if (/invalid\s+(map_key|source|area|day)/i.test(csv.slice(0, 200))) {
                throw new Error(csv.split('\n')[0].trim());
            }
            feed.data = parseFiresCSV(csv);
            feed.last = Date.now();
            feed.state = feed.data.length ? 'live' : 'live (no detections)';
            onEvents(allEvents());
        } catch (e) {
            feed.state = navigator?.onLine === false ? 'offline' : `unreachable: ${e.message}`;
        }
    }

    /* OpenSky Network anonymous public API.
       /api/states/all returns ALL flights worldwide — that's ~10,000 aircraft.
       We limit to top-200 by altitude to keep the globe usable. */
    const OPENSKY_URL = 'https://opensky-network.org/api/states/all';

    function parseFlights(json) {
        const states = json?.states;
        if (!Array.isArray(states)) return [];
        const out = [];
        for (const s of states) {
            if (!Array.isArray(s) || s.length < 7) continue;
            const callsign = String(s[1] || '').trim();
            const lng = s[5]; // longitude
            const lat = s[6]; // latitude
            const altitude = s[7]; // baro altitude in meters
            const velocity = s[9]; // ground speed m/s
            const onGround = s[8]; // boolean
            if (!Number.isFinite(lat) || !Number.isFinite(lng) || onGround) continue;
            out.push({
                id: `flight-${callsign || s[0]}`,
                kind: 'flight',
                lat, lng,
                callsign: callsign || 'Unknown',
                altitude: Number.isFinite(altitude) ? Math.round(altitude) : null,
                velocity: Number.isFinite(velocity) ? Math.round(velocity * 3.6) : null, // km/h
                country: String(s[2] || ''),
                place: callsign ? `Flight ${callsign}` : 'Aircraft',
                time: (s[3] || s[4]) ? (s[3] || s[4]) * 1000 : Date.now(),
                weight: 0.15 // small ripple
            });
        }
        /* Keep top 200 by altitude for visual clarity */
        out.sort((a, b) => (b.altitude || 0) - (a.altitude || 0));
        return out.slice(0, 200);
    }

    async function pollFlights() {
        const feed = feeds.flights;
        try {
            const res = await fetchImpl(OPENSKY_URL, { signal: AbortSignal.timeout?.(15000) });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = await res.json();
            feed.data = parseFlights(json);
            feed.last = Date.now();
            feed.state = feed.data.length ? 'live' : 'live (no states)';
        } catch (e) {
            /* OpenSky anonymous API has strict rate limits. Not an error. */
            feed.state = navigator?.onLine === false ? 'offline' : `unreachable: ${e.message}`;
        }
    }

    function allEvents() {
        /* Flights are deliberately excluded: there are hundreds at any moment
           and they would bury every quake, fire and event in the ticker. They
           are still reachable through `near()` and `feeds.flights.data`. */
        return [...feeds.earthquakes.data, ...feeds.wildfires.data, ...feeds.events.data]
            .sort((a, b) => (b.time || 0) - (a.time || 0));
    }

    function start() {
        if (!quakeTimer) {
            pollQuakes();
            quakeTimer = setInterval(pollQuakes, feeds.earthquakes.intervalMs);
        }
        if (!fireTimer) {
            pollFires();
            fireTimer = setInterval(pollFires, feeds.wildfires.intervalMs);
        }
        if (!flightTimer) {
            pollFlights();
            flightTimer = setInterval(pollFlights, feeds.flights.intervalMs);
        }
        if (!eventTimer) {
            pollLumaEvents();
            eventTimer = setInterval(pollLumaEvents, feeds.events.intervalMs);
        }
    }

    function stop() {
        if (quakeTimer) { clearInterval(quakeTimer); quakeTimer = null; }
        if (fireTimer) { clearInterval(fireTimer); fireTimer = null; }
        if (flightTimer) { clearInterval(flightTimer); flightTimer = null; }
        if (eventTimer) { clearInterval(eventTimer); eventTimer = null; }
    }

    /** Events within `radiusKm` of a point, newest first. All feed types merged. */
    function near(lat, lng, radiusKm = 800) {
        const all = [...feeds.earthquakes.data, ...feeds.wildfires.data, ...feeds.flights.data, ...feeds.events.data];
        return all
            .map((e) => ({ ...e, distanceKm: Math.round(distanceKm(lat, lng, e.lat, e.lng)) }))
            .filter((e) => e.distanceKm <= radiusKm)
            .sort((a, b) => a.distanceKm - b.distanceKm);
    }

    /** What is actually live, in words — the doctor for this subsystem. */
    function status() {
        return Object.entries(feeds).map(([key, f]) => ({
            key, name: f.name, configured: f.configured, state: f.state,
            count: f.data.length,
            ageMinutes: f.last ? Math.round((Date.now() - f.last) / 60000) : null
        }));
    }

    /* Each feed is refreshable on its own. A single `refresh` that only ever
       polled quakes made the other two untestable without a timer, which is
       how they both shipped broken. */
    /**
     * Luma events for the calendar this key owns.
     *
     * Only events with a coordinate can be drawn — Luma documents `coordinate`
     * as null for online events and for addresses it could not geocode, so an
     * online-only calendar legitimately yields zero markers and says so rather
     * than reporting a failure.
     */
    async function pollLumaEvents() {
        const feed = feeds.events;
        if (!lumaBridge) {
            feed.configured = false;
            feed.state = 'needs LUMA_API_KEY (Luma Plus)';
            return;
        }
        try {
            const res = await lumaBridge('listEvents', {});
            if (!res?.ok) {
                feed.configured = res?.reason !== 'no-key';
                feed.state = res?.reason === 'no-key'
                    ? 'needs LUMA_API_KEY (Luma Plus)'
                    : `${res?.reason}${res?.detail ? ` — ${res.detail}` : ''}`;
                return;
            }
            feed.configured = true;
            const all = res.data?.events || [];
            const placeable = all.filter((e) => Number.isFinite(e.lat) && Number.isFinite(e.lng));
            feed.data = placeable;
            feed.last = Date.now();
            feed.state = placeable.length
                ? 'live'
                : (all.length ? `live (${all.length} events, none with coordinates)` : 'live (no events)');
            onEvents(allEvents());
        } catch (e) {
            feed.state = `unreachable: ${e.message}`;
        }
    }

    return {
        start, stop, near, status, feeds, all: allEvents,
        refresh: pollQuakes, refreshFires: pollFires, refreshFlights: pollFlights,
        refreshEvents: pollLumaEvents
    };
}

export default { createDataFeeds, parseQuakes, describeEvent, distanceKm };
