// WIRE labels, pins and ripples on the globe.
//
// Everything positioned here uses latLngToVector3 from globeRenderer, never a
// second copy of the maths — two subtly different conversions is how a label
// ends up three degrees from its own pin.
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
    const markers = [];
    const ripples = [];

    /* Ripple rings are pooled. Each event spawns three, feeds arrive
       continuously, and allocating a geometry per ring would churn the heap
       and stutter the frame every time a quake came in. */
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

    /**
     * Add a labelled marker.
     *
     * @param {{lat:number,lng:number,label:string,kind?:string,boxed?:boolean}} spec
     */
    function addMarker({ lat, lng, label, kind = 'wire', boxed = false, pin = false, labelless = false, dotColour = 0xffffff }) {
        const anchor = latLngToVector3(lat, lng, GLOBE_RADIUS);
        const out = anchor.clone().normalize();
        const labelPos = anchor.clone().addScaledVector(out, GLOBE_RADIUS * LABEL_LIFT);

        /* Leader line and label are skipped for a `labelless` marker — that is
           how "show ALL the companies" draws sixty dots without sixty labels
           printing on top of one another. The dot is coloured so the layer
           still reads as one set. */
        let line = null, el = null, labelObject = null;
        if (!labelless) {
            const lineGeom = new THREE.BufferGeometry().setFromPoints([anchor, labelPos]);
            line = new THREE.Line(lineGeom, new THREE.LineBasicMaterial({
                color: 0xffffff, transparent: true, opacity: 0.45, depthWrite: false
            }));
            group.add(line);
        }

        const dot = new THREE.Mesh(
            new THREE.SphereGeometry(GLOBE_RADIUS * (labelless ? 0.006 : 0.008), 8, 8),
            new THREE.MeshBasicMaterial({ color: dotColour, transparent: true, opacity: labelless ? 0.85 : 1 })
        );
        dot.position.copy(anchor);
        group.add(dot);

        if (!labelless) {
            el = document.createElement('div');
            el.className = `globe-label${boxed ? ' boxed' : ''} kind-${kind}`;
            el.textContent = label;
            labelObject = new CSS2DObject(el);
            labelObject.position.copy(labelPos);
            group.add(labelObject);
        }

        let pinSprite = null;
        if (pin) {
            pinSprite = new THREE.Sprite(new THREE.SpriteMaterial({
                map: sharedPin, transparent: true, depthWrite: false, depthTest: false
            }));
            pinSprite.scale.set(GLOBE_RADIUS * 0.16, GLOBE_RADIUS * 0.16, 1);
            pinSprite.position.copy(anchor.clone().addScaledVector(out, GLOBE_RADIUS * 0.09));
            group.add(pinSprite);
        }

        const marker = { lat, lng, label, anchor, line, dot, el, labelObject, pinSprite, born: performance.now() };
        markers.push(marker);
        return marker;
    }

    /** Ripple at a location: three rings, staggered, expanding and fading. */
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

    /** Tear one marker down — the scene objects, geometry and DOM label. */
    function disposeMarker(m) {
        if (m.line) { group.remove(m.line); m.line.geometry.dispose(); }
        if (m.labelObject) group.remove(m.labelObject);
        if (m.el) m.el.remove();
        group.remove(m.dot);
        m.dot.geometry.dispose();
        m.dot.material.dispose?.();
        if (m.pinSprite) group.remove(m.pinSprite);
    }

    function clear() {
        for (const m of markers) disposeMarker(m);
        markers.length = 0;
    }

    /** Remove ONE marker without touching the rest — the company layer needs
        to clear its own pins without wiping the landmark ring. */
    function remove(marker) {
        const i = markers.indexOf(marker);
        if (i === -1) return;
        disposeMarker(marker);
        markers.splice(i, 1);
    }

    const camDir = new THREE.Vector3();
    const worldAnchor = new THREE.Vector3();

    function update() {
        const now = performance.now();

        /* LEVEL OF DETAIL.
           A label that is legible when the camera is close is unreadable
           clutter when the whole planet is in frame — at that distance a city
           name is a few pixels of noise over a coastline. Labels fade out past
           a threshold and the surface dots shrink with distance, so the same
           markers read at every zoom instead of being tuned for one. */
        const camDist = camera.position.length();
        const LABEL_FADE_FROM = GLOBE_RADIUS * 3.2;
        const LABEL_FADE_TO = GLOBE_RADIUS * 4.4;
        const lodLabel = camDist <= LABEL_FADE_FROM
            ? 1
            : camDist >= LABEL_FADE_TO
                ? 0
                : 1 - (camDist - LABEL_FADE_FROM) / (LABEL_FADE_TO - LABEL_FADE_FROM);
        /* Dots keep a near-constant apparent size rather than dwindling to
           nothing, which is what makes a far-off pin still findable. */
        const lodDot = Math.max(0.55, Math.min(1.9, camDist / (GLOBE_RADIUS * 2.4)));

        /* Hide anything on the far side. Without this the labels of the
           hemisphere facing away float over the globe and the scene reads as
           flat — it is the single cue that sells the sphere. */
        camera.getWorldDirection(camDir);
        for (const m of markers) {
            worldAnchor.copy(m.anchor);
            globeGroup.localToWorld(worldAnchor);
            const toCam = worldAnchor.clone().sub(camera.position).normalize();
            const surfaceNormal = worldAnchor.clone().sub(globeGroup.position).normalize();
            const facing = surfaceNormal.dot(toCam) < -0.12;

            const age = Math.min(1, (now - m.born) / 420);
            const visible = facing;
            /* Far-side occlusion AND distance both gate the label; either one
               reaching zero hides it. */
            if (m.el) {
                m.el.style.opacity = visible ? String(age * 0.95 * lodLabel) : '0';
                m.el.style.transform = `translate(-50%, -50%) scale(${0.86 + age * 0.14})`;
            }
            if (m.line) m.line.visible = visible;
            m.dot.scale.setScalar(lodDot);
            m.dot.visible = visible;
            if (m.pinSprite) m.pinSprite.visible = visible;
        }

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
        sharedPin.dispose();
        globeGroup.remove(group);
    }

    return { addMarker, addRipple, clear, remove, update, dispose, markers, group };
}

export default { createMarkerLayer };
