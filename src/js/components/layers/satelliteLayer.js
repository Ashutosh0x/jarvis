// Satellites on the globe.
//
// ---------------------------------------------------------------------------
// PROPAGATED EVERY FRAME, DRAWN IN ONE CALL
//
// The service (services/satellites.js) turns CelesTrak elements into positions
// with SGP4. This draws them, and the two halves are deliberately separate: the
// maths is testable without a canvas, and the rendering has no opinion about
// where a satellite is.
//
// ONE InstancedMesh FOR THE WHOLE SET. A few hundred satellites as individual
// Meshes would be a few hundred draw calls on a card that is also running the
// orb's shader, the globe's terminator and the atmosphere pass. Instancing
// makes it one, which is the same reasoning that merged every coastline
// segment into a single LineSegments.
//
// POSITIONS ARE RECOMPUTED EVERY FRAME AND THAT IS NOT WASTEFUL. SGP4 for a few
// hundred objects is cheap, and the alternative — interpolating between polls —
// is wrong: the ISS moves 7.7 km a second, so anything but live propagation
// visibly lags. What is NOT refetched is the element set; that is cached for
// two hours, which is what CelesTrak asks for.
//
// ALTITUDE IS DRAWN TO SCALE, COMPRESSED. LEO is ~400 km against a 6,371 km
// radius — at true scale the ISS sits 6% above the surface and reads as
// touching it. The exaggeration is stated in one constant rather than hidden,
// and the ORDER of orbits is preserved, so LEO still sits below GPS.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { latLngToVector3, GLOBE_RADIUS } from '../globeRenderer.js';
import { positionAt, positionsAt, groundTrack, GROUPS } from '../../services/satellites.js';

const EARTH_RADIUS_KM = 6371;
/* Altitude above the surface is multiplied by this before it is drawn. At 1.0
   the ISS would sit 6% of a radius up and read as sitting on the ground. */
const ALTITUDE_EXAGGERATION = 4;
/* Anything past this is clamped, so a geostationary bird at 35,786 km does not
   fly off into the camera's far plane. */
const MAX_DRAW_ALTITUDE = GLOBE_RADIUS * 1.6;

/** Where a satellite is drawn, given its real altitude. */
export function drawRadius(altKm) {
    const scaled = (altKm / EARTH_RADIUS_KM) * GLOBE_RADIUS * ALTITUDE_EXAGGERATION;
    return GLOBE_RADIUS + Math.min(MAX_DRAW_ALTITUDE, scaled);
}

/** The one everybody looks for. */
const isStation = (name) => /ZARYA|ISS|CSS|TIANGONG/i.test(String(name || ''));

export function createSatelliteLayer(globe, { colour = GROUPS.stations.colour } = {}) {
    const group = new THREE.Group();
    group.visible = false;
    /* A child of the globe's group, so it inherits the planet's rotation and
       the auto-spin without a second transform to keep in step. */
    (globe?.group || globe).add(group);

    let sats = [];
    let track = null;
    let issLabel = null;
    let issMesh = null;
    let mesh = null;
    let capacity = 0;

    const dummy = new THREE.Object3D();
    const colourObj = new THREE.Color(colour);

    function buildMesh(count) {
        if (mesh) {
            group.remove(mesh);
            mesh.geometry.dispose();
            mesh.material.dispose();
        }
        capacity = count;
        if (!count) { mesh = null; return; }
        mesh = new THREE.InstancedMesh(
            new THREE.SphereGeometry(GLOBE_RADIUS * 0.006, 8, 8),
            new THREE.MeshBasicMaterial({
                color: colourObj, transparent: true, opacity: 0.95,
                blending: THREE.AdditiveBlending, depthWrite: false
            }),
            count
        );
        /* Positions change every frame; telling three.js that avoids a
           per-frame buffer re-upload decision it would otherwise re-derive. */
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.frustumCulled = false;
        group.add(mesh);
    }

    /**
     * Give the layer a set of satellites.
     * @param {Array<{id,name,rec}>} next from services/satellites.js
     */
    function setData(next) {
        sats = Array.isArray(next) ? next : [];
        buildMesh(sats.length);
        clearIss();
        if (!sats.length) return;

        /* The station gets its own marker and a ground track — one object out
           of a few hundred is worth pointing at; all of them would be noise. */
        const station = sats.find((s) => isStation(s.name));
        if (station) {
            issMesh = new THREE.Mesh(
                new THREE.SphereGeometry(GLOBE_RADIUS * 0.016, 12, 12),
                new THREE.MeshBasicMaterial({
                    color: 0xffffff, transparent: true, opacity: 0.95,
                    blending: THREE.AdditiveBlending, depthWrite: false
                })
            );
            group.add(issMesh);

            const el = document.createElement('div');
            el.className = 'globe-label kind-satellite';
            el.textContent = station.name.replace(/\s*\(.*\)$/, '').toUpperCase();
            issLabel = new CSS2DObject(el);
            group.add(issLabel);

            buildTrack(station);
        }
    }

    /** The path ahead, sampled forward rather than interpolated. */
    function buildTrack(station) {
        clearTrack();
        const pts = groundTrack(station.rec, { minutes: 92, stepSec: 60 });
        if (pts.length < 2) return;
        const verts = pts.map((p) => latLngToVector3(p.lat, p.lng, drawRadius(p.altKm)));
        track = new THREE.Line(
            new THREE.BufferGeometry().setFromPoints(verts),
            new THREE.LineBasicMaterial({
                color: colourObj, transparent: true, opacity: 0.32, depthWrite: false
            })
        );
        group.add(track);
    }

    function clearTrack() {
        if (!track) return;
        group.remove(track);
        track.geometry.dispose();
        track.material.dispose();
        track = null;
    }

    function clearIss() {
        if (issMesh) {
            group.remove(issMesh);
            issMesh.geometry.dispose();
            issMesh.material.dispose();
            issMesh = null;
        }
        if (issLabel) {
            issLabel.element?.remove();
            group.remove(issLabel);
            issLabel = null;
        }
    }

    let trackAge = 0;

    function update(dt = 0) {
        if (!group.visible || !sats.length) return;

        const now = new Date();
        const fixes = positionsAt(sats, now);

        if (mesh && capacity) {
            let i = 0;
            for (const f of fixes) {
                if (i >= capacity) break;
                dummy.position.copy(latLngToVector3(f.lat, f.lng, drawRadius(f.altKm)));
                dummy.updateMatrix();
                mesh.setMatrixAt(i++, dummy.matrix);
            }
            /* Instances beyond what propagated are pushed inside the planet
               rather than left at the last frame's position — an InstancedMesh
               always draws its full count. */
            for (; i < capacity; i++) {
                dummy.position.set(0, 0, 0);
                dummy.updateMatrix();
                mesh.setMatrixAt(i, dummy.matrix);
            }
            mesh.count = capacity;
            mesh.instanceMatrix.needsUpdate = true;
        }

        const station = sats.find((s) => isStation(s.name));
        if (station && (issMesh || issLabel)) {
            const p = positionAt(station.rec, now);
            if (p) {
                const v = latLngToVector3(p.lat, p.lng, drawRadius(p.altKm));
                issMesh?.position.copy(v);
                issLabel?.position.copy(v);
            }
        }

        /* The track is 92 minutes of future; rebuilding it every frame would
           be 92 SGP4 runs per frame for a line that barely changes. Once a
           minute keeps it honest for a fraction of the cost. */
        trackAge += dt;
        if (station && trackAge > 60) { trackAge = 0; buildTrack(station); }
    }

    function setVisible(on) {
        group.visible = !!on;
        if (issLabel?.element) issLabel.element.style.display = on ? '' : 'none';
    }

    function dispose() {
        clearTrack();
        clearIss();
        if (mesh) {
            group.remove(mesh);
            mesh.geometry.dispose();
            mesh.material.dispose();
            mesh = null;
        }
        group.parent?.remove(group);
        sats = [];
    }

    return { group, update, setData, setVisible, dispose, count: () => sats.length };
}

export default { createSatelliteLayer, drawRadius };
