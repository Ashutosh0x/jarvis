// Turning a place into an airport.
//
// ---------------------------------------------------------------------------
// BY COORDINATES, NOT BY NAME
//
// The obvious approach is a city→IATA table, and it is wrong twice over. It is
// a hardcoded lookup that has to be maintained, and it does not actually work:
// Delhi's airport is filed under the municipality "New Delhi", Tokyo's second
// airport under "Narita", and matching on municipality returned nothing for
// Delhi and only one of Tokyo's two.
//
// The globe already geocodes a place to a latitude and longitude. Asking which
// airports are NEAR that point answers all of those cases with no table and no
// special cases — Delhi resolves DEL at 15 km, Tokyo resolves HND at 19 km and
// NRT at 67 km, London resolves LHR, LGW and LTN in that order.
//
// THE DATA IS REAL AND PUBLIC DOMAIN. `static/geo/airports_iata.json` is
// derived from OurAirports, filtered to airports that have an IATA code, are
// classified large or medium, and actually have scheduled service — 3,269 of
// them in 332 KB. Nothing here is invented; an airport absent from that file is
// reported as not found rather than guessed at.
// ---------------------------------------------------------------------------

import { distanceKm } from './dataFeeds.js';

/** Large airports outrank medium ones before distance is considered. */
const LARGE = 1;

/**
 * Airports near a point, best first.
 *
 * PURE — takes the parsed dataset, returns an array. Ranked by size first and
 * distance second, because the airport a city is *served by* is usually the
 * big one even when a smaller field sits closer: Delhi has DXN 63 km away, but
 * nobody means DXN.
 */
export function airportsNear(index, lat, lng, { maxKm = 120, limit = 3 } = {}) {
    if (!Array.isArray(index) || !Number.isFinite(lat) || !Number.isFinite(lng)) return [];
    const out = [];
    for (const a of index) {
        const d = distanceKm(lat, lng, a.y, a.x);
        if (d > maxKm) continue;
        out.push({
            iata: a.i,
            name: a.n,
            municipality: a.m,
            country: a.c,
            lat: a.y,
            lng: a.x,
            large: a.t === LARGE,
            distanceKm: Math.round(d)
        });
    }
    out.sort((p, q) => (q.large - p.large) || (p.distanceKm - q.distanceKm));
    return out.slice(0, limit);
}

/**
 * The single airport a place most likely means.
 *
 * Returns null rather than a far-away guess: a city with no airport inside the
 * radius genuinely has no airport, and saying so is more useful than offering
 * one three hundred kilometres away as though it were local.
 */
export function primaryAirport(index, lat, lng, opts = {}) {
    return airportsNear(index, lat, lng, { ...opts, limit: 1 })[0] || null;
}

/** Build the index from the bundled JSON. Kept trivial so it can be swapped. */
export function buildAirportIndex(json) {
    return Array.isArray(json)
        ? json.filter((a) => a && typeof a.i === 'string' && Number.isFinite(a.y) && Number.isFinite(a.x))
        : [];
}

export default { airportsNear, primaryAirport, buildAirportIndex };
