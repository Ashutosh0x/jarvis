/* =========================================================================
   AVIATION — real flights between two airports.

   WHY THIS EXISTS AT ALL. OpenSky already gives live aircraft positions for
   free, and the globe uses it. What OpenSky does NOT publish is where an
   aircraft came from or where it is going: its state vectors carry callsign,
   position, altitude, heading and speed and nothing else. Its departure
   endpoint does report an airport pair, but on anonymous access a 24-hour
   window answers `403 "You cannot access historical flights"`, and inside the
   ~2-hour window that IS allowed, `estArrivalAirport` was null for 10 of 10
   departures measured from Bengaluru — OpenSky only estimates the arrival once
   the aircraft has landed.

   So "flights from Bengaluru to Tokyo" is not answerable from the free feed.
   It needs a commercial schedule/status provider, and that is what this is.

   MAIN PROCESS ONLY, like every other credential in this app. The renderer
   sends a whitelisted method name and receives flights back.

   THE FREE TIER IS SMALL — AviationStack's is on the order of 100 to 500
   requests a MONTH, not a day. Nothing here polls, and results are cached for
   fifteen minutes, because a route query that silently burns the month's quota
   on a repeated question is worse than one that occasionally shows stale data.
   ========================================================================= */

const BASE = 'https://api.aviationstack.com/v1';
const TIMEOUT_MS = 12000;
const CACHE_MS = 15 * 60 * 1000;

const key = () => process.env.AVIATIONSTACK_API_KEY || '';

function isConfigured() {
    return !!key();
}

const cache = new Map();

/**
 * Normalise one AviationStack flight record.
 *
 * PURE and exported. Field names come from their documented response shape:
 * `departure.iata`, `arrival.iata`, `flight.iata`, `airline.name`,
 * `flight_status`, and `live` (null unless the aircraft is airborne and the
 * plan covers live tracking).
 */
function normaliseFlight(f) {
    if (!f) return null;
    const dep = f.departure || {};
    const arr = f.arrival || {};
    const live = f.live || null;
    const num = f.flight?.iata || f.flight?.icao || f.flight?.number;
    if (!num && !dep.iata) return null;

    return {
        kind: 'flight',
        number: num || null,
        airline: f.airline?.name || null,
        status: f.flight_status || null,
        from: dep.iata || null,
        fromAirport: dep.airport || null,
        to: arr.iata || null,
        toAirport: arr.airport || null,
        scheduledDeparture: dep.scheduled || null,
        scheduledArrival: arr.scheduled || null,
        /* Minutes, and null is not zero — "no delay reported" and "on time"
           are different claims and only one of them is evidence. */
        departureDelayMin: Number.isFinite(dep.delay) ? dep.delay : null,
        arrivalDelayMin: Number.isFinite(arr.delay) ? arr.delay : null,
        terminal: arr.terminal || null,
        gate: arr.gate || null,
        /* Present only while airborne, and only on plans that include live
           tracking. Absent is the normal case, not a failure. */
        lat: Number.isFinite(live?.latitude) ? live.latitude : null,
        lng: Number.isFinite(live?.longitude) ? live.longitude : null,
        altitudeM: Number.isFinite(live?.altitude) ? Math.round(live.altitude) : null,
        speedKph: Number.isFinite(live?.speed_horizontal) ? Math.round(live.speed_horizontal) : null,
        heading: Number.isFinite(live?.direction) ? live.direction : null,
        isLive: !!live && !live.is_ground,
        source: 'aviationstack'
    };
}

function normaliseList(json) {
    return (json?.data || []).map(normaliseFlight).filter(Boolean);
}

async function call(path, params = {}) {
    if (!key()) return { ok: false, reason: 'no-key' };
    const qs = new URLSearchParams({ access_key: key(), ...params }).toString();
    try {
        const res = await fetch(`${BASE}${path}?${qs}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* handled below */ }

        /* AviationStack reports its errors INSIDE a 200 as often as not, so the
           body decides, not the status line. A quota that has run out returns
           `usage_limit_reached`, which must not read as an outage. */
        const err = json?.error;
        if (err) {
            const code = err.code || err.type || '';
            return {
                ok: false,
                reason: /usage_limit|rate_limit/i.test(code) ? 'quota-exhausted'
                    : /access_key|invalid_access|missing_access/i.test(code) ? 'bad-key'
                        : /function_access_restricted|https_access_restricted/i.test(code) ? 'plan-restricted'
                            : code || `http-${res.status}`,
                detail: String(err.message || err.info || '').slice(0, 250)
            };
        }
        if (!res.ok) return { ok: false, reason: `http-${res.status}`, detail: text.slice(0, 200) };
        return { ok: true, data: json };
    } catch (error) {
        return {
            ok: false,
            reason: error.name === 'TimeoutError' ? 'timeout' : 'network',
            detail: error.message
        };
    }
}

/**
 * Flights on a route, by IATA airport code.
 *
 * This is the thing OpenSky cannot answer: real flight numbers with a stated
 * origin and destination.
 */
async function route({ from, to, limit = 20 } = {}) {
    const dep = String(from || '').toUpperCase().trim();
    const arr = String(to || '').toUpperCase().trim();
    if (!/^[A-Z]{3}$/.test(dep) || !/^[A-Z]{3}$/.test(arr)) {
        return { ok: false, reason: 'bad-airport-code', detail: `${from} -> ${to}` };
    }

    const cacheKey = `${dep}-${arr}-${limit}`;
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_MS) {
        return { ok: true, data: { ...hit.value, cached: true } };
    }

    const res = await call('/flights', {
        dep_iata: dep, arr_iata: arr, limit: String(Math.min(100, Math.max(1, limit)))
    });
    if (!res.ok) return res;

    const flights = normaliseList(res.data);
    const value = { flights, from: dep, to: arr, cached: false };
    cache.set(cacheKey, { at: Date.now(), value });
    return { ok: true, data: value };
}

/** One flight by its number, e.g. "AI2814". */
async function flight({ number } = {}) {
    const n = String(number || '').toUpperCase().replace(/\s+/g, '');
    if (!n) return { ok: false, reason: 'no-flight-number' };
    const res = await call('/flights', { flight_iata: n, limit: '5' });
    if (!res.ok) return res;
    return { ok: true, data: { flights: normaliseList(res.data) } };
}

/** What is available, and why not, in words. */
async function status() {
    if (!key()) {
        return {
            ok: true,
            data: {
                configured: false,
                provider: 'AviationStack',
                state: 'needs AVIATIONSTACK_API_KEY (free tier available)',
                note: 'OpenSky publishes no origin or destination; route queries need a schedule provider'
            }
        };
    }
    /* One cheap real call, so "configured" means "actually works" rather than
       "a string is present in the environment". */
    const probe = await call('/flights', { limit: '1' });
    return {
        ok: true,
        data: {
            configured: true,
            provider: 'AviationStack',
            state: probe.ok ? 'live' : `${probe.reason}${probe.detail ? ` — ${probe.detail}` : ''}`
        }
    };
}

const METHODS = { route, flight, status };

async function invoke(method, params = {}) {
    const fn = METHODS[method];
    if (!fn) return { ok: false, reason: 'unknown-method', detail: String(method).slice(0, 40) };
    return fn(params || {});
}

module.exports = {
    invoke, isConfigured, methods: Object.keys(METHODS),
    normaliseFlight, normaliseList, route, flight, status
};
