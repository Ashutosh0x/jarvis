// JARVIS Companion — visualizer host.
//
// This is the desktop app's src/js/scripts.js with the desktop-only pieces
// removed (Jarvis engine, dat.gui, Electron telemetry HUD) and mouse parallax
// swapped for touch. The scene graph, uniforms, shader wiring and the FFT
// blend in animate() are kept identical so the orb looks and reacts the same.
//
// visualizerModes.js is imported unmodified from the desktop source.

import * as THREE from 'three';
import VisualizerModes from './visualizerModes.js';

/* ---- renderer (identical to desktop, minus the transparent-window bits) ---- */
const renderer = new THREE.WebGLRenderer({
    alpha: true,
    antialias: true,
    premultipliedAlpha: false
});
// Cap DPR: phones routinely report 3-4x, and a 30-subdivision icosahedron at
// native 4x is what turns this from 60fps into a handwarmer.
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x000000, 0);
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);
renderer.domElement.style.background = 'transparent';

const scene = new THREE.Scene();
scene.background = null;

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(0, -2, 14);
camera.lookAt(scene.position);

/* ---- params + uniforms (verbatim) ---- */
const params = {
    red: 0.1,
    green: 0.8,
    blue: 1.0,
    autoColor: true
};

const uniforms = {
    u_time: { value: 0 },
    u_frequency: { value: 0 },
    u_red: { value: params.red },
    u_green: { value: params.green },
    u_blue: { value: params.blue }
};

/* ---- geometry + material (verbatim) ---- */
const geo = new THREE.IcosahedronGeometry(4, 30);
const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: document.getElementById('vertexshader').textContent,
    fragmentShader: document.getElementById('fragmentshader').textContent,
    wireframe: true,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false
});

const mesh = new THREE.Mesh(geo, mat);
scene.add(mesh);

const visualizerModes = new VisualizerModes(scene, camera, renderer);
visualizerModes.meshes.push(mesh);
visualizerModes.currentMode = 'sphere';

window.visualizerModes = visualizerModes;
window.visualizerVolume = 0;

/* ---- native audio bridge ----------------------------------------------
   Desktop fills window.jarvisFrequencyData through a WebAudio AnalyserNode.
   Android has no WebAudio mic access inside a WebView, so AudioRecord does
   the FFT natively and writes the bins straight into this array.

   The analyser shim exists purely so the animate() loop below stays
   byte-identical to the desktop version: it still calls
   getByteFrequencyData(), which is simply a no-op here because the buffer
   has already been filled by the native side.
------------------------------------------------------------------------ */
const FFT_BINS = 64;
window.jarvisFrequencyData = new Uint8Array(FFT_BINS);
window.jarvisAnalyser = {
    getByteFrequencyData() { /* buffer is populated natively */ }
};

// Called from Kotlin via evaluateJavascript on each audio frame.
window.jarvisPushAudio = function (volume, bins) {
    window.visualizerVolume = volume || 0;
    if (bins && bins.length) {
        const n = Math.min(bins.length, FFT_BINS);
        for (let i = 0; i < n; i++) window.jarvisFrequencyData[i] = bins[i];
    }
};

// Link-state readout, driven from Kotlin.
const hud = document.getElementById('link-hud');
window.jarvisSetLinkState = function (text, online) {
    if (!hud) return;
    hud.textContent = 'Neural Link: ' + text;
    hud.classList.toggle('offline', !online);
};

// Desktop can switch modes remotely (sphere / cube / particles / torus).
window.jarvisSetMode = function (mode) {
    if (visualizerModes && visualizerModes.modes && visualizerModes.modes[mode]) {
        visualizerModes.currentMode = mode;
    }
};

/* ---- touch parallax (replaces desktop mouse parallax) ---- */
let pointerX = 0;
let pointerY = 0;
function trackPointer(clientX, clientY) {
    pointerX = (clientX - window.innerWidth / 2) / 100;
    pointerY = (clientY - window.innerHeight / 2) / 100;
}
document.addEventListener('touchmove', (e) => {
    if (e.touches && e.touches.length) trackPointer(e.touches[0].clientX, e.touches[0].clientY);
}, { passive: true });
document.addEventListener('touchend', () => { pointerX = 0; pointerY = 0; }, { passive: true });

/* ---- animation loop (FFT blend copied verbatim from desktop) ---- */
const clock = new THREE.Clock();

function animate() {
    requestAnimationFrame(animate);

    camera.position.x += (pointerX - camera.position.x) * 0.05;
    camera.position.y += (-pointerY - camera.position.y) * 0.05;
    camera.lookAt(scene.position);

    uniforms.u_time.value = clock.getElapsedTime();

    let frequency = window.visualizerVolume || 0;
    if (window.jarvisAnalyser && window.jarvisFrequencyData) {
        window.jarvisAnalyser.getByteFrequencyData(window.jarvisFrequencyData);
        const bins = window.jarvisFrequencyData;
        const third = Math.floor(bins.length / 3);
        let bass = 0, mid = 0, treble = 0;
        for (let i = 0; i < third; i++) bass += bins[i];
        for (let i = third; i < third * 2; i++) mid += bins[i];
        for (let i = third * 2; i < bins.length; i++) treble += bins[i];
        bass /= third; mid /= third; treble /= (bins.length - third * 2);
        const fftEnergy = (bass * 0.5 + mid * 0.35 + treble * 0.15) / 255 * 100;
        frequency = Math.max(frequency, fftEnergy);
        window.visualizerBands = { bass, mid, treble };
    }
    uniforms.u_frequency.value = frequency;

    if (visualizerModes) {
        visualizerModes.update(frequency, clock.getElapsedTime(), uniforms);
        if (params.autoColor) {
            visualizerModes.setColorFromFrequency(frequency, uniforms);
        }
    }

    renderer.render(scene, camera);
}
animate();

/* ---- resize / rotation ---- */
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

// Signal readiness so Kotlin knows evaluateJavascript calls will land.
if (window.JarvisBridge && window.JarvisBridge.onVisualizerReady) {
    window.JarvisBridge.onVisualizerReady();
}
