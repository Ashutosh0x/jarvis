// WIRE labels, pins and ripples on the globe.
//
// Everything positioned here uses latLngToVector3 from globeRenderer, never a
// second copy of the maths — two subtly different conversions is how a label
// ends up three degrees from its own pin.
//
// ---------------------------------------------------------------------------
// BUILT FOR ELEVEN THOUSAND MARKERS, NOT FIFTY
//
// The first version of this file gave every marker its own THREE.Mesh, its own
// SphereGeometry, its own material and its own DOM element. That is fine for
// the twenty landmarks around a city and catastrophic for a world market-cap
// map. Measured with 10,996 companies on screen:
//
//     draw calls        ~11,000     one per marker mesh
//     DOM nodes          10,996     one per label, all of them laid out
//     update()            25.4 ms   per frame, before anything rendered
//     heap                 179 MB
//
// 25 ms of scripting caps the frame rate at 39 fps on its own, and the browser
// still has to composite eleven thousand absolutely-positioned elements.
//
// THREE CHANGES FIX IT, in descending order of effect:
//
//   1. ONE InstancedMesh for every dot. One geometry, one material, one draw
//      call for all eleven thousand, with per-instance colour and scale. This
//      is the difference between 11,000 draw calls and 1.
//   2. A POOL of label elements, not one per marker. At most a few dozen names
//      are legible at any zoom — the declutter pass already proved that — so
//      the DOM holds that many and they are reassigned each frame. 10,996
//      elements become 64.
//   3. The camera is transformed into the globe's LOCAL space once per frame,
//      instead of transforming every marker into world space. Same answer,
//      one matrix operation instead of eleven thousand.
//
// The per-frame loop after this allocates nothing: every vector it touches is
// preallocated and reused, because eleven thousand short-lived Vector3s per
// frame is a garbage collector pause you can feel.
//
// ---------------------------------------------------------------------------
// LABELS ARE DOM, NOT SPRITES
//
// The reference labels are crisp uppercase text with a thin leader line to a
// point on the globe. Rendered as a canvas texture on a sprite they would be
// resampled every frame and read soft, and the text would need re-rasterising
// on every zoom to stay sharp.
//
// CSS2DRenderer projects a real DOM element to a 3D position instead: the
// browser renders the text at native resolution with the app's own font, and
// it costs a transform per label per frame. It also means the labels are
// selectable, themeable in CSS, and identical to the rest of the HUD.
//
// The leader LINE cannot be DOM — it has to be occluded by the globe when its
// anchor rotates to the far side — so it is drawn in WebGL, and the label is
// hidden in the same moment by testing the anchor against the view direction.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { latLngToVector3, GLOBE_RADIUS, GLOBE_COLORS } from './globeRenderer.js';

/** How far off the surface a label floats, as a fraction of the radius. */
const LABEL_LIFT = 0.42;

/* The most names that can be legible at once. The declutter pass never got
   past about forty on a 1200x800 window; sixty-four is headroom, and it is the
   number of DOM elements this layer will ever create. */
const LABEL_POOL = 64;

/**
 * The blue teardrop pin from the reference.
 *
 * Drawn to a canvas rather than shipped as a PNG: it is thirty lines of arc
 * calls, it scales to the device pixel ratio, and it means no binary asset to
 * keep in step with the palette.
 */
function pinTexture(color = '#2f9dff') {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');

    ctx.translate(size / 2, size * 0.42);
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.3, Math.PI * 0.85, Math.PI * 0.15, false);
    ctx.lineTo(0, size * 0.52);          // the point of the drop
    ctx.closePath();

    const grad = ctx.createLinearGradient(0, -size * 0.3, 0, size * 0.5);
    grad.addColorStop(0, '#7cc4ff');
    grad.addColorStop(1, color);
    ctx.fillStyle = grad;
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 3;
    ctx.fill();

    ctx.shadowColor = 'transparent';
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.13, 0, Math.PI * 2);
    ctx.fillStyle = '#eaf6ff';
    ctx.fill();

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
}

export function createMarkerLayer({ scene, camera, globeGroup }) {
    const group = new THREE.Group();
    globeGroup.add(group);

    const sharedPin = pinTexture(`#${GLOBE_COLORS.pin.toString(16).padStart(6, '0')}`);
    /* Plain data, not scene objects. A marker is a latitude, a colour and a
       size; giving each one a Mesh was the whole performance problem. */
    const markers = [];
    const ripples = [];

    /* ---------------------------------------------------------- instanced -- */

    /* A single unit sphere, drawn once per frame however many markers exist.
       Six segments rather than eight: at four to nine pixels on screen the
       difference is invisible and it is a third fewer triangles. */
    const dotGeometry = new THREE.SphereGeometry(1, 6, 4);
    const dotMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.9 });
    let capacity = 0;
    let dots = null;

    function ensureCapacity(n) {
        if (dots && n <= capacity) return;
        /* Doubling, so a list that grows to eleven thousand reallocates
           fourteen times rather than eleven thousand. */
        const next = Math.max(1024, 1 << Math.ceil(Math.log2(Math.max(1, n))));
        const mesh = new THREE.InstancedMesh(dotGeometry, dotMaterial, next);
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.frustumCulled = false;     // instances are spread over a sphere
        mesh.renderOrder = 2;
        mesh.count = 0;
        if (dots) group.remove(dots);
        dots = mesh;
        capacity = next;
        group.add(dots);
    }

    /* --------------------------------------------------------- label pool -- */

    const labelPool = [];
    const linePool = [];
    const lineGeometry = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 1)
    ]);
    const lineMaterial = new THREE.LineBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.45, depthWrite: false
    });

    for (let i = 0; i < LABEL_POOL; i++) {
        const el = document.createElement('div');
        el.className = 'globe-label';
        el.style.opacity = '0';
        const obj = new CSS2DObject(el);
        obj.visible = false;
        group.add(obj);
        labelPool.push({ el, obj });

        const line = new THREE.Line(lineGeometry, lineMaterial);
        line.visible = false;
        group.add(line);
        linePool.push(line);
    }

    /**
     * Add a marker.
     *
     * Returns a plain record. It deliberately holds NO scene objects — the dot
     * is an instance index and the label is borrowed from the pool when it is
     * actually drawn.
     */
    function addMarker({ lat, lng, label, kind = 'wire', boxed = false, pin = false, labelless = false, dotColour = 0xffffff, priority = 5, lift = LABEL_LIFT, dotPx = null, meta = null }) {
        const anchor = latLngToVector3(lat, lng, GLOBE_RADIUS);
        const out = anchor.clone().normalize();

        let pinSprite = null;
        if (pin) {
            /* Real sprites only for the handful of place pins; there is never
               a crowd of these. */
            pinSprite = new THREE.Sprite(new THREE.SpriteMaterial({
                map: sharedPin, transparent: true, depthWrite: false, depthTest: false
            }));
            pinSprite.scale.set(GLOBE_RADIUS * 0.16, GLOBE_RADIUS * 0.16, 1);
            pinSprite.position.copy(anchor.clone().addScaledVector(out, GLOBE_RADIUS * 0.09));
            group.add(pinSprite);
        }

        const marker = {
            lat, lng, label: labelless ? null : label, kind, boxed,
            anchor, out, lift, priority, pinSprite,
            /* Whatever the caller needs back when this marker is clicked —
               ticker, place ID, market cap. The layer never reads it. */
            meta,
            colour: new THREE.Color(dotColour),
            dotPx: dotPx ?? (labelless ? 5 : 7),
            /* Filled by update(): screen position, and the pool slot currently
               showing this marker's name. */
            sx: 0, sy: 0, w: 0, h: 0, visible: false,
            born: performance.now()
        };
        markers.push(marker);
        ensureCapacity(markers.length);
        return marker;
    }

    /** Ripple at a location: three rings, staggered, expanding and fading. */
    const RIPPLE_POOL = 24;
    const ringGeometry = new THREE.RingGeometry(0.94, 1.0, 48);
    const ripplePool = [];
    for (let i = 0; i < RIPPLE_POOL; i++) {
        const mesh = new THREE.Mesh(ringGeometry, new THREE.MeshBasicMaterial({
            color: GLOBE_COLORS.network, transparent: true, opacity: 0,
            side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false
        }));
        mesh.visible = false;
        group.add(mesh);
        ripplePool.push(mesh);
    }
    let poolCursor = 0;

    function addRipple({ lat, lng, colour = GLOBE_COLORS.network, maxScale = 0.9, ms = 3000, rings = 3 }) {
        const anchor = latLngToVector3(lat, lng, GLOBE_RADIUS + 0.01);
        const normal = anchor.clone().normalize();
        for (let i = 0; i < rings; i++) {
            const mesh = ripplePool[poolCursor];
            poolCursor = (poolCursor + 1) % RIPPLE_POOL;
            mesh.position.copy(anchor);
            /* Lie the ring flat ON the surface — a ring facing the camera
               floats above the globe and detaches from its own location. */
            mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
            mesh.material.color.setHex(colour);
            mesh.visible = true;
            ripples.push({ mesh, start: performance.now() + i * (ms / rings), ms, maxScale });
        }
    }

    /* ---------------------------------------------------------- outlines -- */

    const outlines = [];

    /**
     * A REAL BOUNDARY, drawn where a pin would have been a lie about size.
     *
     * Manyata Tech Park is 120 hectares. As a marker it was a five-pixel dot,
     * the same mark used for a two-person consultancy across the road. OSM has
     * its actual footprint, so this draws that.
     */
    function addOutline({ geojson, colour = 0xffb648, opacity = 0.9 }) {
        if (!geojson?.coordinates) return null;
        /* GeoJSON nests differently per type: Polygon is [ring][pt], and
           MultiPolygon is [poly][ring][pt]. */
        const rings = geojson.type === 'MultiPolygon'
            ? geojson.coordinates.flat()
            : geojson.coordinates;

        const holder = new THREE.Group();
        const material = new THREE.LineBasicMaterial({
            color: colour, transparent: true, opacity, depthWrite: false
        });
        let points = 0;
        for (const ring of rings) {
            if (!Array.isArray(ring) || ring.length < 3) continue;
            const pts = [];
            for (const c of ring) {
                /* GeoJSON is [lng, lat] — the reverse of every other coordinate
                   in this codebase, and the easiest way to draw a campus in the
                   wrong hemisphere. */
                if (!Array.isArray(c) || c.length < 2) continue;
                pts.push(latLngToVector3(c[1], c[0], GLOBE_RADIUS * 1.0004));
            }
            if (pts.length < 3) continue;
            pts.push(pts[0].clone());
            points += pts.length;
            holder.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), material));
        }
        if (!points) return null;
        group.add(holder);
        const outline = { group: holder, material, points };
        outlines.push(outline);
        return outline;
    }

    function clearOutlines() {
        for (const o of outlines) {
            for (const line of o.group.children) line.geometry.dispose();
            o.material.dispose();
            group.remove(o.group);
        }
        outlines.length = 0;
    }

    function clear() {
        for (const m of markers) {
            if (m.pinSprite) { group.remove(m.pinSprite); m.pinSprite.material.dispose(); }
        }
        markers.length = 0;
        if (dots) dots.count = 0;
        for (const p of labelPool) { p.obj.visible = false; p.el.style.opacity = '0'; }
        for (const l of linePool) l.visible = false;
        clearOutlines();
    }

    /** Remove ONE marker without touching the rest. */
    function remove(marker) {
        const i = markers.indexOf(marker);
        if (i === -1) return;
        if (marker.pinSprite) { group.remove(marker.pinSprite); marker.pinSprite.material.dispose(); }
        markers.splice(i, 1);
    }

    /* ------------------------------------------------------------ update -- */

    /* Every one of these is allocated ONCE. Eleven thousand markers times sixty
       frames is 660,000 vectors a second if they are created in the loop, and
       that is a garbage-collection pause you can see. */
    const ZERO_QUAT = new THREE.Quaternion();
    const UNIT_Z = new THREE.Vector3(0, 0, 1);
    const R2 = GLOBE_RADIUS * GLOBE_RADIUS;
    const byPriority = (a, b) => (a.priority - b.priority) || (a.sy - b.sy);
    let drawnLabels = 0;

    const instanceOwner = [];
    const localCam = new THREE.Vector3();
    const tmp = new THREE.Vector3();
    const matrix = new THREE.Matrix4();
    const scaleVec = new THREE.Vector3();
    const invGlobe = new THREE.Matrix4();
    const placed = [];
    const candidates = [];

    function update() {
        if (!dots) return;
        const now = performance.now();

        const camDist = camera.position.length();
        const altitude = Math.max(camDist - GLOBE_RADIUS, GLOBE_RADIUS * 0.0005);
        const LABEL_FADE_FROM = GLOBE_RADIUS * 3.2;
        const LABEL_FADE_TO = GLOBE_RADIUS * 4.4;
        const lodLabel = camDist <= LABEL_FADE_FROM ? 1
            : camDist >= LABEL_FADE_TO ? 0
                : 1 - (camDist - LABEL_FADE_FROM) / (LABEL_FADE_TO - LABEL_FADE_FROM);

        const vw = window.innerWidth || 1200;
        const vh = window.innerHeight || 800;

        /* THE CAMERA COMES TO THE MARKERS, not the other way round. One matrix
           inversion per frame replaces eleven thousand localToWorld calls. */
        invGlobe.copy(globeGroup.matrixWorld).invert();
        localCam.copy(camera.position).applyMatrix4(invGlobe);
        const localCamLen = localCam.length();

        /* Constant apparent size: radius proportional to altitude, so a dot is
           the same few pixels whether the camera frames a planet or a street. */
        const perPixel = (camera.fov * Math.PI / 180) / Math.max(240, vh);
        const radiusPerPx = altitude * Math.tan(perPixel / 2);

        candidates.length = 0;
        let count = 0;

        for (let i = 0; i < markers.length; i++) {
            const m = markers[i];
            const a = m.anchor;

            /* BACK-FACE CULL FIRST, and in local space. A point `a` on a
               sphere of radius R is over the horizon from a camera at `c`
               exactly when a·c <= R². That is the whole test: one dot product
               and one compare, no normalising, no square roots. At world zoom
               it discards half the markers before anything else is computed. */
            const facing = (a.x * localCam.x + a.y * localCam.y + a.z * localCam.z) > R2;
            m.visible = facing;
            if (!facing) continue;

            const r = Math.max(1e-6, radiusPerPx * m.dotPx);
            scaleVec.set(r, r, r);
            matrix.compose(a, ZERO_QUAT, scaleVec);
            dots.setMatrixAt(count, matrix);
            dots.setColorAt(count, m.colour);
            /* Instances are packed by whatever survived the cull, so the row a
               marker occupies changes every frame. Raycasting an InstancedMesh
               returns an `instanceId` and nothing else, so this is the only
               way back from a click to the company that was clicked. */
            instanceOwner[count] = m;
            count++;

            if (m.label && lodLabel > 0) candidates.push(m);
        }

        dots.count = count;
        dots.instanceMatrix.needsUpdate = true;
        if (dots.instanceColor) dots.instanceColor.needsUpdate = true;

        /* ---- names: project only the ones that could be labelled ---- */

        for (let i = 0; i < candidates.length; i++) {
            const m = candidates[i];
            tmp.copy(m.anchor).applyMatrix4(globeGroup.matrixWorld).project(camera);
            m.sx = (tmp.x * 0.5 + 0.5) * vw;
            m.sy = (-tmp.y * 0.5 + 0.5) * vh;
            m.onScreen = tmp.z < 1 && m.sx > -200 && m.sx < vw + 200 && m.sy > -50 && m.sy < vh + 50;
        }

        /* DECLUTTER: every name that fits without landing on one already
           drawn. Priority decides a contested spot — the place pin first, then
           campuses, then companies by rank — so zooming out degrades to the
           landmarks rather than to an arbitrary alphabetical few. */
        candidates.sort(byPriority);

        placed.length = 0;
        let slot = 0;
        for (let i = 0; i < candidates.length && slot < LABEL_POOL; i++) {
            const m = candidates[i];
            if (!m.onScreen) continue;
            /* Width is estimated from the text length rather than measured:
               reading offsetWidth here would force a synchronous layout, and
               with sixty labels a frame that is the whole budget. Half a
               character of error costs nothing at this job. */
            const halfW = (m.w || (m.label.length * 4.2)) + 4;
            const halfH = 9;
            let clash = false;
            for (let j = 0; j < placed.length; j += 4) {
                if (Math.abs(m.sx - placed[j]) < halfW + placed[j + 2]
                    && Math.abs(m.sy - placed[j + 1]) < halfH + placed[j + 3]) { clash = true; break; }
            }
            if (clash) continue;
            placed.push(m.sx, m.sy, halfW, halfH);

            const p = labelPool[slot];
            const line = linePool[slot];
            slot++;

            if (p.el.textContent !== m.label) {
                p.el.textContent = m.label;
                p.el.className = `globe-label${m.boxed ? ' boxed' : ''} kind-${m.kind}`;
            }
            const age = Math.min(1, (now - m.born) / 420);
            p.el.style.opacity = String(age * 0.95 * lodLabel);
            p.obj.visible = true;

            /* Lift is altitude-relative: 0.42 globe-radii is a hand's breadth
               with the planet in frame and 2,675 km of empty sky at city zoom,
               which shoots the name off the top of the screen. */
            const liftWorld = Math.min(GLOBE_RADIUS * m.lift, Math.max(altitude * 0.16, radiusPerPx * 20));
            p.obj.position.copy(m.anchor).addScaledVector(m.out, liftWorld);
            line.position.copy(m.anchor);
            line.scale.setScalar(liftWorld);
            line.quaternion.setFromUnitVectors(UNIT_Z, m.out);
            line.visible = true;

            if (m.pinSprite) {
                const pinSize = Math.min(GLOBE_RADIUS * 0.16, Math.max(altitude * 0.10, 1e-5));
                m.pinSprite.scale.set(pinSize, pinSize, 1);
                m.pinSprite.position.copy(m.anchor).addScaledVector(m.out, pinSize * 0.55);
                m.pinSprite.visible = true;
            }
        }

        /* Retire the slots nothing claimed this frame. */
        for (let i = slot; i < LABEL_POOL; i++) {
            if (!labelPool[i].obj.visible) continue;
            labelPool[i].obj.visible = false;
            labelPool[i].el.style.opacity = '0';
            linePool[i].visible = false;
        }
        drawnLabels = slot;

        for (let i = ripples.length - 1; i >= 0; i--) {
            const r = ripples[i];
            const t = (now - r.start) / r.ms;
            if (t < 0) { r.mesh.material.opacity = 0; continue; }
            if (t >= 1) {
                r.mesh.visible = false;
                r.mesh.material.opacity = 0;
                ripples.splice(i, 1);
                continue;
            }
            const s = 0.02 + t * r.maxScale;
            r.mesh.scale.set(s, s, s);
            r.mesh.material.opacity = 0.65 * (1 - t);
        }
    }


    function dispose() {
        clear();
        for (const m of ripplePool) { m.material.dispose(); group.remove(m); }
        ringGeometry.dispose();
        dotGeometry.dispose();
        dotMaterial.dispose();
        lineGeometry.dispose();
        lineMaterial.dispose();
        for (const p of labelPool) p.el.remove();
        sharedPin.dispose();
        globeGroup.remove(group);
    }

    return {
        addMarker, addRipple, clear, remove, update, dispose, markers, group,
        addOutline, clearOutlines, outlines,
        /* How many names the declutter pass actually drew on the last frame. */
        labelsDrawn: () => drawnLabels,

        /**
         * Which marker is under this ray?
         *
         * Raycasting the instanced mesh gives an `instanceId`, which is a row
         * in a buffer that gets repacked every frame — meaningless on its own.
         * `instanceOwner` is what turns it back into the company that was
         * clicked. Nearest hit wins, as a click should.
         */
        pick(raycaster) {
            if (!dots || !dots.count) return null;
            const hits = raycaster.intersectObject(dots, false);
            for (const h of hits) {
                if (h.instanceId == null) continue;
                const m = instanceOwner[h.instanceId];
                if (m) return m;
            }
            return null;
        }
    };
}

export default { createMarkerLayer };
