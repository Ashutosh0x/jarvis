// Geomagnetic activity, drawn where it actually happens.
//
// ---------------------------------------------------------------------------
// THE AURORA OVAL IS NOT A CIRCLE AROUND THE POLE
//
// It is a ring centred on the GEOMAGNETIC pole, which sits about 11° off the
// geographic one — near 80.6°N 72.6°W, over northern Greenland. Drawing it
// around the spin axis would put it symmetrically over Siberia and Canada,
// which is visibly wrong to anyone who has seen an aurora forecast map.
//
// The ring's radius grows as Kp rises: quiet nights it hugs the pole, and a
// storm pushes it toward the equator. The mapping below is the standard
// "equatorward boundary" rule of thumb — roughly 66° magnetic latitude at
// Kp 0, moving about 2° equatorward per Kp step.
//
// NOTHING IS DRAWN BELOW Kp 4. An aurora oval painted during quiet conditions
// would be decoration; at Kp 4 there is genuinely activity to show. The layer
// says "quiet" rather than drawing a ring nobody could see.
//
// SOLAR WIND IS NOT INCLUDED. The plasma endpoint named in the plan
// (products/solar-wind/plasma-5-minute.json) answers 404, and rather than
// guess at a replacement path this ships with the Kp index alone, which was
// verified live.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { latLngToVector3, GLOBE_RADIUS } from '../globeRenderer.js';

const KP_URL = 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json';

/* Geomagnetic north, and its antipode in the south. */
const NORTH_MAG = { lat: 80.6, lng: -72.6 };
const SOUTH_MAG = { lat: -80.6, lng: 107.4 };

/** Aurora shows from here up. Below this there is nothing worth drawing. */
export const KP_VISIBLE = 4;
/** A storm, worth interrupting the ticker for. */
export const KP_STORM = 5;

/**
 * How far the oval reaches from the magnetic pole, in degrees.
 *
 * PURE and exported: this is the only piece of real physics in the file and it
 * is the thing worth pinning in a test. Kp 0 sits near 66° magnetic latitude —
 * i.e. 24° from the pole — and each Kp step pushes it about 2° equatorward.
 */
export function ovalRadiusDeg(kp) {
    const k = Math.max(0, Math.min(9, Number(kp) || 0));
    return 24 + k * 2;
}

/** The most recent Kp reading from NOAA's product feed. */
export function latestKp(json) {
    if (!Array.isArray(json) || !json.length) return null;
    /* The feed is chronological; the useful reading is the last one that
       actually carries a number. */
    for (let i = json.length - 1; i >= 0; i--) {
        const row = json[i];
        const kp = Number(row?.Kp ?? row?.kp_index ?? row?.estimated_kp);
        if (Number.isFinite(kp)) {
            return { kp, at: row.time_tag ? Date.parse(row.time_tag) : null };
        }
    }
    return null;
}

/** Words for a Kp value, using NOAA's own G-scale wording. */
export function describeKp(kp) {
    if (!Number.isFinite(kp)) return 'unknown';
    if (kp < 4) return 'quiet';
    if (kp < 5) return 'unsettled';
    if (kp < 6) return 'minor storm (G1)';
    if (kp < 7) return 'moderate storm (G2)';
    if (kp < 8) return 'strong storm (G3)';
    if (kp < 9) return 'severe storm (G4)';
    return 'extreme storm (G5)';
}

/**
 * A ring of points at a fixed angular distance from a pole.
 *
 * Built by rotating an offset vector about the pole axis, which gives a true
 * small circle on the sphere — stepping latitude/longitude directly would
 * produce an oval that distorts badly near the pole.
 */
function ringPoints(poleLat, poleLng, radiusDeg, radius, segments = 128) {
    const axis = latLngToVector3(poleLat, poleLng, 1).normalize();
    /* Any vector not parallel to the axis works as a starting arm. */
    const seed = Math.abs(axis.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const arm = seed.clone().sub(axis.clone().multiplyScalar(seed.dot(axis))).normalize();
    const tilt = new THREE.Quaternion().setFromAxisAngle(
        arm.clone().cross(axis).normalize(), THREE.MathUtils.degToRad(radiusDeg)
    );
    const start = axis.clone().applyQuaternion(tilt);

    const pts = [];
    for (let i = 0; i <= segments; i++) {
        const spin = new THREE.Quaternion().setFromAxisAngle(axis, (i / segments) * Math.PI * 2);
        pts.push(start.clone().applyQuaternion(spin).multiplyScalar(radius));
    }
    return pts;
}

export function createSpaceWeatherLayer(globe, { statusBar = null } = {}) {
    const group = new THREE.Group();
    group.visible = false;
    (globe?.group || globe).add(group);

    let rings = [];
    let kp = null;
    let announced = null;

    function clearRings() {
        for (const r of rings) {
            group.remove(r);
            r.geometry.dispose();
            r.material.dispose();
        }
        rings = [];
    }

    function build() {
        clearRings();
        if (!Number.isFinite(kp) || kp < KP_VISIBLE) return;

        const deg = ovalRadiusDeg(kp);
        /* Brighter and thicker as the storm grows, so the ring carries the
           magnitude without needing a number beside it. */
        const strength = Math.min(1, (kp - KP_VISIBLE) / 4);
        for (const pole of [NORTH_MAG, SOUTH_MAG]) {
            /* Two concentric rings a couple of degrees apart read as a band
               rather than a wire, which is closer to what an oval looks like. */
            for (const [d, o] of [[deg - 1.5, 0.34], [deg, 0.55], [deg + 1.5, 0.34]]) {
                const line = new THREE.LineLoop(
                    new THREE.BufferGeometry().setFromPoints(
                        ringPoints(pole.lat, pole.lng, d, GLOBE_RADIUS + 0.02)
                    ),
                    new THREE.LineBasicMaterial({
                        color: 0x00ff88,
                        transparent: true,
                        opacity: o * (0.5 + strength * 0.5),
                        blending: THREE.AdditiveBlending,
                        depthWrite: false
                    })
                );
                group.add(line);
                rings.push(line);
            }
        }
    }

    /** Hand it a NOAA product payload. */
    function setData(json) {
        const latest = latestKp(json);
        kp = latest?.kp ?? null;
        build();

        if (!Number.isFinite(kp)) return;
        /* Announced once per level change, not per poll — a storm that lasts
           six hours should not push the same alert twelve times. */
        const level = Math.floor(kp);
        if (level !== announced && kp >= KP_STORM) {
            announced = level;
            statusBar?.pushAlert?.(
                `Geomagnetic storm — Kp ${kp.toFixed(1)}, ${describeKp(kp)}`,
                kp >= 7 ? 'breaking' : 'alert'
            );
        } else if (kp < KP_STORM) {
            announced = null;
        }
    }

    let t = 0;
    function update(dt = 0) {
        if (!group.visible || !rings.length) return;
        /* A slow breath. The aurora is not static and a fixed ring reads as a
           drawn annotation rather than something happening. */
        t += dt;
        const pulse = 0.82 + Math.sin(t * 1.1) * 0.18;
        for (const r of rings) {
            /* The ring's own opacity is captured once, on first update, and
               the pulse multiplies THAT — reading the live value back each
               frame would compound and fade the ring to nothing. */
            if (r.userData.baseOpacity === undefined) {
                r.userData.baseOpacity = r.material.opacity;
            }
            r.material.opacity = r.userData.baseOpacity * pulse;
        }
    }

    function setVisible(on) { group.visible = !!on; }

    function dispose() {
        clearRings();
        group.parent?.remove(group);
    }

    return {
        group, update, setData, setVisible, dispose,
        kp: () => kp,
        describe: () => (Number.isFinite(kp) ? `Kp ${kp.toFixed(1)} — ${describeKp(kp)}` : 'no reading')
    };
}

/** Keyless. A failure here is a real network or upstream problem. */
export async function fetchKp(fetchImpl = fetch) {
    const res = await fetchImpl(KP_URL, { signal: AbortSignal.timeout?.(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

export default { createSpaceWeatherLayer, fetchKp, latestKp, ovalRadiusDeg, describeKp };
