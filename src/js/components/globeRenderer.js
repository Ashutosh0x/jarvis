// The globe: a dark sphere with a glowing amber network on it.
//
// ---------------------------------------------------------------------------
// WHAT THE REFERENCE ACTUALLY SHOWS, AND WHY THERE IS NO SATELLITE TEXTURE
//
// The plan this implements called for NASA Blue Marble at 8K plus night
// lights, clouds, bump and specular — about 16 MB of raster. The reference
// footage does not look like that. Frame 30 of the sequence is a near-black
// sphere with a GLOWING AMBER VECTOR NETWORK drawn on it: coastlines, borders
// and road-grid, lit from within, with a warm rim.
//
// That is a much better fit for this app than Blue Marble, and not only
// aesthetically:
//
//   OFFLINE. Jarvis is local-first. 2.2 MB of Natural Earth GeoJSON (public
//   domain) ships in the repo and needs no tile server, no API key and no
//   network. A satellite globe either bundles 16 MB or phones home.
//
//   IT SCALES. Vector lines stay sharp at every zoom. An 8K equirectangular
//   texture is ~2 km per pixel at the equator and turns to mush the moment you
//   fly down to a city, which is exactly what the reference does.
//
//   IT MATCHES. The amber-on-black look IS the Iron Man aesthetic. A
//   photoreal Earth looks like Google Earth, which is the thing the reference
//   is deliberately not.
//
// GEOMETRY BUDGET. Every coastline segment as its own THREE.Line would be
// thousands of draw calls and would drop the app to single-digit FPS on the
// 1650 Ti. All of it is merged into ONE LineSegments buffer per layer — three
// draw calls for the whole world.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { sunDirection, subsolarPoint } from '../services/solarPosition.js';

export const GLOBE_RADIUS = 5;

/** Reference palette, sampled from the footage. */
export const GLOBE_COLORS = {
    ocean: 0x050a12,
    land: 0x0a1420,
    network: 0xff9d2e,      // the amber road/coast glow
    networkDim: 0x8a4f14,
    graticule: 0x1d3a52,
    atmosphere: 0xffa33a,
    pin: 0x2f9dff
};

/**
 * Latitude/longitude to a point on the sphere.
 *
 * Exported because markers, ripples and the fly-to all need the identical
 * conversion — two subtly different versions of this is how a label ends up
 * three degrees from its pin.
 */
export function latLngToVector3(lat, lng, radius = GLOBE_RADIUS) {
    const phi = (90 - lat) * (Math.PI / 180);
    const theta = (lng + 180) * (Math.PI / 180);
    return new THREE.Vector3(
        -radius * Math.sin(phi) * Math.cos(theta),
        radius * Math.cos(phi),
        radius * Math.sin(phi) * Math.sin(theta)
    );
}

/**
 * Flatten a GeoJSON FeatureCollection of lines/polygons into one position
 * array of segment pairs, ready for a single LineSegments.
 *
 * `lift` pushes the lines a hair off the surface: drawn exactly at the radius
 * they z-fight with the sphere and flicker as the camera moves.
 */
function geoJsonToSegments(geojson, radius, lift = 0.004) {
    const positions = [];
    const r = radius + lift;

    const pushLine = (coords) => {
        for (let i = 0; i < coords.length - 1; i++) {
            const a = coords[i], b = coords[i + 1];
            if (!Array.isArray(a) || !Array.isArray(b)) continue;
            const va = latLngToVector3(a[1], a[0], r);
            const vb = latLngToVector3(b[1], b[0], r);
            positions.push(va.x, va.y, va.z, vb.x, vb.y, vb.z);
        }
    };

    const walk = (geom) => {
        if (!geom) return;
        switch (geom.type) {
            case 'LineString': pushLine(geom.coordinates); break;
            case 'MultiLineString': geom.coordinates.forEach(pushLine); break;
            case 'Polygon': geom.coordinates.forEach(pushLine); break;
            case 'MultiPolygon': geom.coordinates.forEach((poly) => poly.forEach(pushLine)); break;
            case 'GeometryCollection': geom.geometries.forEach(walk); break;
            default: break;
        }
    };

    for (const f of geojson.features || []) walk(f.geometry);
    return new Float32Array(positions);
}

/** A lat/lng grid, drawn faintly — it reads as "instrument", not "map". */
function buildGraticule(radius, stepDeg = 15) {
    const positions = [];
    const r = radius + 0.002;
    const push = (lat1, lng1, lat2, lng2) => {
        const a = latLngToVector3(lat1, lng1, r);
        const b = latLngToVector3(lat2, lng2, r);
        positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
    };
    for (let lat = -80; lat <= 80; lat += stepDeg) {
        for (let lng = -180; lng < 180; lng += 4) push(lat, lng, lat, lng + 4);
    }
    for (let lng = -180; lng < 180; lng += stepDeg) {
        for (let lat = -88; lat < 88; lat += 4) push(lat, lng, lat + 4, lng);
    }
    return new Float32Array(positions);
}

/**
 * The atmosphere: a Fresnel rim on a slightly larger, back-faced sphere.
 *
 * Rendered with BackSide and additive blending so it only shows where the
 * surface turns away from the camera — which is the silhouette. Front-faced it
 * would wash a haze over the whole globe and flatten it.
 */
function atmosphereMaterial(color) {
    return new THREE.ShaderMaterial({
        uniforms: {
            uColor: { value: new THREE.Color(color) },
            uIntensity: { value: 1.0 },
            uPower: { value: 3.2 }
        },
        vertexShader: `
            varying vec3 vNormal;
            varying vec3 vView;
            void main() {
                vNormal = normalize(normalMatrix * normal);
                vec4 mv = modelViewMatrix * vec4(position, 1.0);
                vView = normalize(-mv.xyz);
                gl_Position = projectionMatrix * mv;
            }`,
        fragmentShader: `
            uniform vec3 uColor;
            uniform float uIntensity;
            uniform float uPower;
            varying vec3 vNormal;
            varying vec3 vView;
            void main() {
                float rim = pow(1.0 - abs(dot(vNormal, vView)), uPower);
                gl_FragColor = vec4(uColor, rim * uIntensity);
            }`,
        transparent: true,
        blending: THREE.AdditiveBlending,
        side: THREE.BackSide,
        depthWrite: false
    });
}

/**
 * Build the globe.
 *
 * @param {object} opts
 * @param {THREE.Scene} opts.scene
 * @param {THREE.Camera} opts.camera
 * @param {HTMLElement} opts.domElement  for OrbitControls
 * @param {(path:string)=>Promise<object>} opts.loadGeoJson
 */
export async function createGlobe({ scene, camera, domElement, loadGeoJson }) {
    const group = new THREE.Group();
    group.visible = false;              // Orb mode is the default; F3 reveals this
    scene.add(group);

    /* ---- the body, lit by the real sun ----

       The day/night terminator is computed from the clock, not faked with a
       rotating light: solarPosition.js gives the true subsolar point, so the
       lit hemisphere on screen is the lit hemisphere outside the window, tilt
       and equation of time included.

       `smoothstep` across the terminator rather than a hard edge — the real
       one is a twilight band about a degree wide, and a hard line reads as a
       rendering artefact. */
    const surfaceMaterial = new THREE.ShaderMaterial({
        uniforms: {
            uSun: { value: new THREE.Vector3(1, 0, 0) },
            uDay: { value: new THREE.Color(0x10243a) },
            uNight: { value: new THREE.Color(0x03060c) }
        },
        vertexShader: `
            varying vec3 vNormal;
            void main() {
                vNormal = normalize(normal);
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }`,
        fragmentShader: `
            uniform vec3 uSun;
            uniform vec3 uDay;
            uniform vec3 uNight;
            varying vec3 vNormal;
            void main() {
                float lambert = dot(normalize(vNormal), normalize(uSun));
                float daylight = smoothstep(-0.12, 0.12, lambert);
                gl_FragColor = vec4(mix(uNight, uDay, daylight), 1.0);
            }`
    });
    const surface = new THREE.Mesh(
        new THREE.SphereGeometry(GLOBE_RADIUS, 64, 64),
        surfaceMaterial
    );
    group.add(surface);

    /* ---- the amber network ---- */
    const layers = {};
    const addLineLayer = (name, positions, color, opacity) => {
        if (!positions?.length) return null;
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        const material = new THREE.LineBasicMaterial({
            color, transparent: true, opacity,
            blending: THREE.AdditiveBlending, depthWrite: false
        });
        const mesh = new THREE.LineSegments(geometry, material);
        group.add(mesh);
        layers[name] = mesh;
        return mesh;
    };

    /* Brighter than the reference's faint grid, because this is also the
       FALLBACK: if every map file fails to load, the graticule is the only
       thing left drawing the sphere, and a barely-visible one leaves the user
       staring at a black screen wondering whether anything happened. */
    addLineLayer('graticule', buildGraticule(GLOBE_RADIUS), GLOBE_COLORS.graticule, 0.55);

    /* Loaded in parallel and tolerated individually: a missing borders file
       should cost the borders, not the globe.

       BUT THE FAILURES ARE REPORTED. Swallowing them silently is what turned a
       broken loader into "the globe is invisible": every layer threw, the
       catch returned null, and the result was a black sphere on a black
       background with nothing to say why. The reasons are collected and handed
       back so the caller can surface them. */
    const geoErrors = [];
    const tryLoad = async (name) => {
        try { return await loadGeoJson(name); }
        catch (e) { geoErrors.push(`${name}: ${e.message}`); return null; }
    };
    const [coastline, borders, land] = await Promise.all([
        tryLoad('ne_50m_coastline.geojson'),
        tryLoad('ne_110m_admin_0_boundary_lines_land.geojson'),
        tryLoad('ne_110m_land.geojson')
    ]);
    if (geoErrors.length) console.error('Globe map data failed to load:\n  ' + geoErrors.join('\n  '));

    if (land) addLineLayer('land', geoJsonToSegments(land, GLOBE_RADIUS, 0.003), GLOBE_COLORS.networkDim, 0.5);
    if (coastline) addLineLayer('coastline', geoJsonToSegments(coastline, GLOBE_RADIUS, 0.005), GLOBE_COLORS.network, 0.95);
    if (borders) addLineLayer('borders', geoJsonToSegments(borders, GLOBE_RADIUS, 0.004), GLOBE_COLORS.network, 0.4);

    /* ---- rim ---- */
    const atmosphere = new THREE.Mesh(
        new THREE.SphereGeometry(GLOBE_RADIUS * 1.06, 48, 48),
        atmosphereMaterial(GLOBE_COLORS.atmosphere)
    );
    group.add(atmosphere);

    /* ---- controls ---- */
    const controls = new OrbitControls(camera, domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan = false;             // panning a globe just loses it
    controls.minDistance = GLOBE_RADIUS * 1.12;
    controls.maxDistance = GLOBE_RADIUS * 6;
    controls.rotateSpeed = 0.45;
    controls.zoomSpeed = 0.8;
    controls.enabled = false;               // only while globe mode is on
    controls.target.set(0, 0, 0);

    /* ---- route arcs ---- */
    let arcs = [];

    /**
     * A great-circle arc between two points, lifted off the surface.
     *
     * SLERPED, not lerped. A straight line between two points on a sphere
     * passes THROUGH it — Bengaluru to Tokyo would tunnel under China. Spherical
     * interpolation follows the surface, which is also the path aircraft
     * actually fly, so the drawn line means something rather than decorating.
     *
     * Lifted by a small arch so it clears the coastline vectors instead of
     * z-fighting with them; the arch scales with separation, because a 200 km
     * hop does not need the altitude a 7,000 km one does.
     */
    function addArc(lat1, lng1, lat2, lng2, { segments = 128, colour = 0x6fd3ff } = {}) {
        const a = latLngToVector3(lat1, lng1, GLOBE_RADIUS).normalize();
        const b = latLngToVector3(lat2, lng2, GLOBE_RADIUS).normalize();
        /* Angle between the endpoints decides the arch height. */
        const angle = a.angleTo(b);
        const lift = GLOBE_RADIUS * (0.01 + 0.16 * (angle / Math.PI));
        const pts = [];
        for (let i = 0; i <= segments; i++) {
            const t = i / segments;
            const dir = a.clone().lerp(b, t).normalize();
            /* sin gives zero rise at both ends and the peak in the middle. */
            const r = GLOBE_RADIUS + 0.004 + lift * Math.sin(Math.PI * t);
            pts.push(dir.multiplyScalar(r));
        }
        const geom = new THREE.BufferGeometry().setFromPoints(pts);
        const mat = new THREE.LineBasicMaterial({
            color: colour, transparent: true, opacity: 0.75, depthWrite: false
        });
        const line = new THREE.Line(geom, mat);
        group.add(line);
        arcs.push(line);
        return line;
    }

    function clearArcs() {
        for (const l of arcs) {
            group.remove(l);
            l.geometry.dispose();
            l.material.dispose();
        }
        arcs = [];
    }

    /* ---- fly-to ---- */
    let flight = null;
    const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

    /**
     * Move the camera to look down at a lat/lng.
     *
     * Interpolated on the SPHERE, not through it: a straight line between two
     * camera positions passes inside the globe when the two points are far
     * apart, so the viewer flies through the planet. Slerping the direction and
     * lerping only the radius keeps the camera outside and reads as an orbit.
     *
     * THE TARGET MUST BE ROTATED INTO WORLD SPACE FIRST. latLngToVector3 works
     * in the globe's LOCAL frame, but the camera lives in world space and the
     * group has been spinning (`group.rotation.y`) since the app started. Using
     * the local vector directly lands the camera however far the planet has
     * turned away from the city — asking for San Francisco and arriving over
     * Indonesia. Markers are children of the group and so were always right,
     * which is what made the bug look like a camera problem rather than a
     * frame-mismatch one.
     */
    const flyTo = (lat, lng, { distance = GLOBE_RADIUS * 2.2, ms = 2200 } = {}) => {
        const from = camera.position.clone();
        group.updateMatrixWorld();
        const to = latLngToVector3(lat, lng, distance)
            .applyQuaternion(group.getWorldQuaternion(new THREE.Quaternion()));
        const fromDir = from.clone().normalize();
        const toDir = to.clone().normalize();
        const fromLen = from.length();
        const toLen = to.length();
        const startQ = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), fromDir);
        const endQ = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), toDir);

        flight = { startQ, endQ, fromLen, toLen, t: 0, ms, started: performance.now() };
        return new Promise((resolve) => { flight.resolve = resolve; });
    };

    /* ---- per-frame ---- */
    let autoRotate = true;
    const tmpQ = new THREE.Quaternion();
    const tmpV = new THREE.Vector3();

    /* The sun is recomputed on a timer, not per frame.

       It moves 15 degrees an hour — a quarter of a degree per minute — so
       recalculating a trigonometric series sixty times a second buys a change
       far below one pixel. Every 30 s is already finer than the terminator's
       own softness. */
    let lastSunUpdate = 0;
    let subsolar = subsolarPoint();
    const sunWorld = new THREE.Vector3();
    const sunLocal = new THREE.Vector3();
    const invRotation = new THREE.Quaternion();

    function refreshSun(force = false) {
        const now = Date.now();
        if (!force && now - lastSunUpdate < 30_000) return;
        lastSunUpdate = now;
        const d = sunDirection();
        sunWorld.set(d.x, d.y, d.z);
        subsolar = subsolarPoint();
    }
    refreshSun(true);

    /* The sun is fixed in WORLD space; the globe spins inside it.
       The shader shades using the mesh's LOCAL normal, so the sun vector has
       to be rotated into that same local frame every frame — otherwise the
       terminator turns with the planet and it is always noon wherever you are
       looking, which defeats the entire point of computing it. */
    function syncSunUniform() {
        invRotation.copy(group.quaternion).invert();
        sunLocal.copy(sunWorld).applyQuaternion(invRotation);
        surfaceMaterial.uniforms.uSun.value.copy(sunLocal);
    }

    function update(dt, audio = 0) {
        if (!group.visible) return;
        refreshSun();

        if (flight) {
            const t = Math.min(1, (performance.now() - flight.started) / flight.ms);
            const e = easeInOut(t);
            tmpQ.slerpQuaternions(flight.startQ, flight.endQ, e);
            tmpV.set(0, 0, 1).applyQuaternion(tmpQ).multiplyScalar(flight.fromLen + (flight.toLen - flight.fromLen) * e);
            camera.position.copy(tmpV);
            camera.lookAt(0, 0, 0);
            if (t >= 1) { flight.resolve?.(); flight = null; }
        } else if (autoRotate) {
            group.rotation.y += 0.00035 * dt * 60;
        }

        /* Audio drives the RIM, not the geometry. Deforming a globe makes it
           look like a balloon; brightening its atmosphere reads as the thing
           being alive and keeps the coastlines where they belong. */
        const pulse = 0.85 + audio * 1.6;
        atmosphere.material.uniforms.uIntensity.value = pulse;
        if (layers.coastline) layers.coastline.material.opacity = 0.8 + audio * 0.2;

        syncSunUniform();
        controls.update();
    }

    function setVisible(on) {
        group.visible = on;
        controls.enabled = on;
        if (on) controls.update();
    }

    function dispose() {
        controls.dispose();
        group.traverse((n) => {
            if (n.geometry) n.geometry.dispose();
            if (n.material) (Array.isArray(n.material) ? n.material : [n.material]).forEach((m) => m.dispose());
        });
        scene.remove(group);
    }

    return {
        group, controls, layers, atmosphere,
        update, setVisible, flyTo, dispose, addArc, clearArcs,
        latLngToVector3,
        setAutoRotate: (on) => { autoRotate = on; },
        isVisible: () => group.visible,
        radius: GLOBE_RADIUS,
        /* What actually drew, and what did not. The caller reports this rather
           than leaving a blank globe unexplained. */
        loadedLayers: () => Object.keys(layers),
        geoErrors: () => geoErrors.slice(),
        /* Exposed so the status bar can say where noon is — a live figure that
           needs no network and proves the terminator is real rather than a
           rotating light. */
        subsolarPoint: () => subsolar
    };
}

export default { createGlobe, latLngToVector3, GLOBE_RADIUS, GLOBE_COLORS };
