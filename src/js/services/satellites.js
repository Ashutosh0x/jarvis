// Satellites, where they actually are.
//
// ---------------------------------------------------------------------------
// PROPAGATED, NOT PLOTTED
//
// A TLE is not a position. It is a set of orbital elements valid at an epoch,
// and turning it into "where is the ISS right now" means running SGP4 — the
// same model NORAD publishes the elements for. `satellite.js` is that model,
// has zero dependencies, and is what Osiris uses for the same job.
//
// This matters because the naive alternative — drawing a satellite at the
// sub-point of its epoch — is wrong by thousands of kilometres within minutes.
// The ISS covers about 7.7 km every second.
//
// CELESTRAK IS KEYLESS AND ASKS FOR RESTRAINT. Their guidance is to fetch a
// given group at most every couple of hours; elements simply do not change
// faster than that. Positions are then propagated locally at whatever rate the
// screen wants, from one download.
//
// EVERY FAILURE IS REPORTED. No key is needed, so a failure here is a real
// network or upstream problem, and the layer says so rather than showing an
// empty sky that looks the same as "no satellites".
// ---------------------------------------------------------------------------

import * as satellite from 'satellite.js';

const BASE = 'https://celestrak.org/NORAD/elements/gp.php';

/* Groups worth showing on a command centre, and small enough to be honest
   about. `active` is ~11,000 objects and would bury the globe; these are the
   ones a person actually recognises. */
export const GROUPS = {
    stations: { label: 'Space stations', colour: 0x6fd3ff },
    'visual-100': { label: 'Brightest', colour: 0xffd27f },
    gps: { label: 'GPS', colour: 0x9ae66e },
    weather: { label: 'Weather', colour: 0xff9d2e },
    science: { label: 'Science', colour: 0xd6a3ff }
};

/* CelesTrak asks callers not to re-fetch a group more often than this. */
export const TLE_TTL_MS = 2 * 60 * 60 * 1000;

/**
 * Parse CelesTrak's JSON (OMM) into satrec objects.
 *
 * PURE, so the propagation can be tested without a network. Records that
 * SGP4 cannot initialise are dropped rather than allowed to produce NaN
 * positions that render at the centre of the globe.
 */
export function buildSatrecs(json) {
    if (!Array.isArray(json)) return [];
    const out = [];
    for (const o of json) {
        const l1 = o?.TLE_LINE1, l2 = o?.TLE_LINE2;
        let rec = null;
        try {
            if (typeof l1 === 'string' && typeof l2 === 'string') {
                rec = satellite.twoline2satrec(l1, l2);
            } else if (o?.OBJECT_NAME && Number.isFinite(o?.MEAN_MOTION)) {
                /* CelesTrak's JSON format omits the raw TLE lines, so the
                   elements are assembled from the OMM fields instead. */
                rec = satrecFromOmm(o);
            }
        } catch {
            rec = null;
        }
        /* `error` is non-zero when the elements are unusable. */
        if (!rec || rec.error) continue;
        out.push({
            name: String(o.OBJECT_NAME || o.OBJECT_ID || 'UNKNOWN').trim(),
            id: String(o.NORAD_CAT_ID ?? o.OBJECT_ID ?? out.length),
            rec
        });
    }
    return out;
}

/** Assemble a satrec from OMM fields when raw TLE lines are absent. */
function satrecFromOmm(o) {
    const pad = (n, w, d) => Number(n).toFixed(d).padStart(w, '0');
    const epoch = new Date(o.EPOCH);
    const yy = String(epoch.getUTCFullYear()).slice(-2);
    const start = Date.UTC(epoch.getUTCFullYear(), 0, 1);
    const doy = (epoch.getTime() - start) / 86400000 + 1;
    const noradId = String(o.NORAD_CAT_ID ?? '00000').padStart(5, '0');

    const l1 = `1 ${noradId}U ${String(o.OBJECT_ID || '').replace(/-/g, '').padEnd(8, ' ').slice(0, 8)} `
        + `${yy}${pad(doy, 12, 8)} .00000000  00000-0  00000-0 0  9999`;
    const l2 = `2 ${noradId} ${pad(o.INCLINATION, 8, 4)} ${pad(o.RA_OF_ASC_NODE, 8, 4)} `
        + `${String(Number(o.ECCENTRICITY).toFixed(7)).slice(2)} ${pad(o.ARG_OF_PERICENTER, 8, 4)} `
        + `${pad(o.MEAN_ANOMALY, 8, 4)} ${pad(o.MEAN_MOTION, 11, 8)}00000`;
    return satellite.twoline2satrec(l1, l2);
}

/**
 * Where a satellite is, right now.
 *
 * Returns null rather than a guess when SGP4 declines — a decayed or
 * badly-conditioned orbit produces no position, and inventing one would put a
 * marker somewhere no satellite is.
 */
export function positionAt(rec, when = new Date()) {
    try {
        const pv = satellite.propagate(rec, when);
        if (!pv?.position) return null;
        const gmst = satellite.gstime(when);
        const geo = satellite.eciToGeodetic(pv.position, gmst);
        const lat = satellite.degreesLat(geo.latitude);
        const lng = satellite.degreesLong(geo.longitude);
        const altKm = geo.height;
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(altKm)) return null;
        /* Below the Kármán line means the elements are stale or the object has
           re-entered; either way it is not in orbit and must not be drawn. */
        if (altKm < 80) return null;
        return { lat, lng, altKm };
    } catch {
        return null;
    }
}

/** Propagate a whole set at one instant. */
export function positionsAt(sats, when = new Date()) {
    const out = [];
    for (const s of sats) {
        const p = positionAt(s.rec, when);
        if (p) out.push({ id: s.id, name: s.name, ...p });
    }
    return out;
}

/**
 * The ground track ahead of a satellite.
 *
 * Sampled forward in time rather than interpolated between two points: an
 * orbit is a curve in a rotating frame, and a straight line between two
 * positions ten minutes apart misses the ground track badly.
 */
export function groundTrack(rec, { minutes = 90, stepSec = 60, from = new Date() } = {}) {
    const pts = [];
    for (let t = 0; t <= minutes * 60; t += stepSec) {
        const p = positionAt(rec, new Date(from.getTime() + t * 1000));
        if (p) pts.push(p);
    }
    return pts;
}

export function createSatelliteService({ fetchImpl = fetch } = {}) {
    /* One entry per group, so switching groups does not refetch what is
       already held and still fresh. */
    const cache = new Map();

    async function load(group = 'stations', { force = false } = {}) {
        if (!GROUPS[group]) return { ok: false, reason: 'unknown-group', sats: [] };
        const hit = cache.get(group);
        if (!force && hit && Date.now() - hit.at < TLE_TTL_MS) {
            return { ok: true, sats: hit.sats, cached: true, at: hit.at };
        }
        try {
            const res = await fetchImpl(`${BASE}?GROUP=${encodeURIComponent(group)}&FORMAT=json`, {
                signal: AbortSignal.timeout?.(15000)
            });
            if (!res.ok) return { ok: false, reason: `http-${res.status}`, sats: [] };
            const sats = buildSatrecs(await res.json());
            if (!sats.length) return { ok: false, reason: 'no-elements', sats: [] };
            cache.set(group, { at: Date.now(), sats });
            return { ok: true, sats, cached: false, at: Date.now() };
        } catch (e) {
            return {
                ok: false,
                reason: e.name === 'TimeoutError' ? 'timeout' : 'network',
                detail: e.message,
                sats: []
            };
        }
    }

    return {
        load,
        groups: () => Object.entries(GROUPS).map(([id, g]) => ({ id, ...g })),
        status: () => [...cache.entries()].map(([g, v]) => ({
            group: g, count: v.sats.length, ageMinutes: Math.round((Date.now() - v.at) / 60000)
        }))
    };
}

export default {
    createSatelliteService, buildSatrecs, positionAt, positionsAt, groundTrack, GROUPS
};
