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
    return e.place || 'event';
}

export function createDataFeeds({ fetchImpl = fetch, onEvents = () => { } } = {}) {
    const feeds = {
        earthquakes: { name: 'USGS earthquakes', configured: true, state: 'idle', last: null, data: [], intervalMs: 5 * 60 * 1000 },
        /* Registered but not wired: they need keys, and a feed that silently
           does nothing is worse than one that says it is not set up. */
        wildfires: { name: 'NASA FIRMS', configured: false, state: 'needs an API key', last: null, data: [], intervalMs: null },
        flights: { name: 'OpenSky', configured: false, state: 'needs an account', last: null, data: [], intervalMs: null }
    };

    let timer = null;

    async function pollQuakes() {
        const feed = feeds.earthquakes;
        try {
            const res = await fetchImpl(USGS_URL, { signal: AbortSignal.timeout?.(15000) });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = await res.json();
            feed.data = parseQuakes(json);
            feed.last = Date.now();
            feed.state = 'live';
            onEvents(feed.data);
        } catch (e) {
            /* Keep the last good data. Offline is the normal case here, and
               clearing the globe because a poll failed would be worse than
               showing data that is twenty minutes old and labelled as such. */
            feed.state = navigator?.onLine === false ? 'offline' : `unreachable: ${e.message}`;
        }
    }

    function start() {
        if (timer) return;
        pollQuakes();
        timer = setInterval(pollQuakes, feeds.earthquakes.intervalMs);
    }

    function stop() { if (timer) { clearInterval(timer); timer = null; } }

    /** Events within `radiusKm` of a point, newest first. */
    function near(lat, lng, radiusKm = 800) {
        return feeds.earthquakes.data
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

    return { start, stop, near, status, feeds, all: () => feeds.earthquakes.data, refresh: pollQuakes };
}

export default { createDataFeeds, parseQuakes, describeEvent, distanceKm };
