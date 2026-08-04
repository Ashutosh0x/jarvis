// NASA EONET natural events — volcanoes, storms, ice.
//
// ---------------------------------------------------------------------------
// EONET IS 99% WILDFIRES, AND JARVIS ALREADY HAS THOSE
//
// A blind pull of EONET's open events is ~7,000 markers, of which ~6,950 are
// wildfires — the exact thing the FIRMS layer draws, from a feed with better
// coverage. Drawing them again would bury the globe and duplicate a layer that
// exists. So this pulls ONLY the categories FIRMS and USGS do not: volcanoes,
// severe storms, sea and lake ice, floods, landslides. That is what EONET adds
// over what Jarvis already tracks.
//
// THE LATEST GEOMETRY IS THE POSITION. A storm is a track, not a point —
// EONET carries every recorded position and the last one is where it is now.
// Taking the first would draw a hurricane where it made landfall days ago.
//
// COORDINATES ARE [lng, lat], NOT [lat, lng]. GeoJSON order. Reading them the
// other way puts a Pacific typhoon in the Sahara, which is the single easiest
// mistake to make here and the one the test pins.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { latLngToVector3, GLOBE_RADIUS } from '../globeRenderer.js';

/* The categories worth showing — everything EONET tracks that Jarvis does not
   already cover from a better source. Wildfires (FIRMS) and earthquakes (USGS)
   are deliberately absent. */
export const EONET_CATEGORIES = {
    volcanoes: { label: 'Volcanoes', colour: 0xff5a2a },
    severeStorms: { label: 'Severe storms', colour: 0x6fd3ff },
    seaLakeIce: { label: 'Sea & lake ice', colour: 0xbfe8ff },
    floods: { label: 'Floods', colour: 0x4a9dff },
    landslides: { label: 'Landslides', colour: 0xd6a060 }
};

const BASE = 'https://eonet.gsfc.nasa.gov/api/v3/events';

/**
 * Parse an EONET events payload.
 *
 * PURE, so the [lng,lat] handling and the latest-geometry rule can be tested
 * without a network. An event with no usable point is dropped rather than
 * pinned at (0,0).
 */
export function parseEonet(json) {
    const out = [];
    for (const e of json?.events || []) {
        const geoms = Array.isArray(e.geometry) ? e.geometry : [];
        /* Most recent position: a storm's track ends where it is now. */
        const g = [...geoms].reverse().find((x) => x?.type === 'Point' && Array.isArray(x.coordinates));
        if (!g) continue;
        const [lng, lat] = g.coordinates;            // GeoJSON order
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        const catId = e.categories?.[0]?.id || '';
        if (!EONET_CATEGORIES[catId]) continue;      // only the ones we draw
        out.push({
            id: e.id,
            title: e.title,
            category: catId,
            lat, lng,
            magnitude: Number.isFinite(g.magnitudeValue) ? g.magnitudeValue : null,
            magnitudeUnit: g.magnitudeUnit || null,
            date: g.date || null,
            url: e.link || null
        });
    }
    return out;
}

/** Keyless. A failure here is a real network or upstream problem. */
export async function fetchEonet(fetchImpl = fetch) {
    /* One request per category is cleaner than filtering ~7,000 events client
       side, and EONET's category filter is cheap. Settled in parallel; one
       category failing does not lose the others. */
    const cats = Object.keys(EONET_CATEGORIES);
    const settled = await Promise.allSettled(cats.map(async (c) => {
        const res = await fetchImpl(`${BASE}?status=open&category=${c}&limit=80`, {
            signal: AbortSignal.timeout?.(15000)
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return parseEonet(await res.json());
    }));
    const events = [];
    for (const s of settled) if (s.status === 'fulfilled') events.push(...s.value);
    if (!events.length && settled.every((s) => s.status === 'rejected')) {
        throw new Error(settled[0]?.reason?.message || 'EONET unreachable');
    }
    return events;
}

export function createNaturalEventsLayer(globe) {
    const group = new THREE.Group();
    group.visible = false;
    (globe?.group || globe).add(group);

    let events = [];
    let mesh = null;
    const dummy = new THREE.Object3D();

    function build() {
        if (mesh) {
            group.remove(mesh);
            mesh.geometry.dispose();
            mesh.material.dispose();
            mesh = null;
        }
        if (!events.length) return;

        mesh = new THREE.InstancedMesh(
            /* An octahedron reads as a diamond marker, distinct from the round
               satellite dots and the ripples. */
            new THREE.OctahedronGeometry(GLOBE_RADIUS * 0.011),
            new THREE.MeshBasicMaterial({
                transparent: true, opacity: 0.92,
                blending: THREE.AdditiveBlending, depthWrite: false,
                vertexColors: true
            }),
            events.length
        );
        mesh.frustumCulled = false;

        events.forEach((e, i) => {
            dummy.position.copy(latLngToVector3(e.lat, e.lng, GLOBE_RADIUS + 0.02));
            /* Face outward so the diamond reads as sitting on the surface. */
            dummy.lookAt(dummy.position.clone().multiplyScalar(2));
            dummy.updateMatrix();
            mesh.setMatrixAt(i, dummy.matrix);
            mesh.setColorAt(i, new THREE.Color(EONET_CATEGORIES[e.category].colour));
        });
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        group.add(mesh);
    }

    function setData(next) {
        events = Array.isArray(next) ? next : [];
        build();
    }

    let t = 0;
    function update(dt = 0) {
        if (!group.visible || !mesh) return;
        /* A slow shared pulse so the markers read as live rather than plotted. */
        t += dt;
        mesh.material.opacity = 0.75 + Math.sin(t * 1.6) * 0.17;
    }

    function setVisible(on) { group.visible = !!on; }

    function dispose() {
        if (mesh) {
            group.remove(mesh);
            mesh.geometry.dispose();
            mesh.material.dispose();
            mesh = null;
        }
        group.parent?.remove(group);
        events = [];
    }

    return { group, update, setData, setVisible, dispose, count: () => events.length };
}

export default { createNaturalEventsLayer, parseEonet, fetchEonet, EONET_CATEGORIES };
