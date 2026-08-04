import * as THREE from 'three';
import { GUI } from 'dat.gui';
import Jarvis from './jarvis.js';
import VisualizerModes from './visualizerModes.js';

// ✅ Create renderer with alpha support for transparency
const renderer = new THREE.WebGLRenderer({
    alpha: true,
    antialias: true,
    premultipliedAlpha: false
});
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x000000, 0); // Black with 0 alpha = transparent
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

// ✅ Force canvas to be transparent
renderer.domElement.style.background = 'transparent';

const scene = new THREE.Scene();
scene.background = null; // ✅ No background = transparent

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(0, -2, 14);
camera.lookAt(scene.position);

// Parameters
const params = {
    red: 0.1,
    green: 0.8,
    blue: 1.0,
    autoColor: true
};

// Uniforms
const uniforms = {
    u_time: { value: 0 },
    u_frequency: { value: 0 },
    u_red: { value: params.red },
    u_green: { value: params.green },
    u_blue: { value: params.blue }
};

// Geometry + Material
const geo = new THREE.IcosahedronGeometry(4, 30);
const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: document.getElementById('vertexshader').textContent,
    fragmentShader: document.getElementById('fragmentshader').textContent,
    wireframe: true,
    transparent: true,
    blending: THREE.AdditiveBlending, // ✅ Additive blending for glow effect without bloom pass
    depthWrite: false
});

const mesh = new THREE.Mesh(geo, mat);
scene.add(mesh);

const visualizerModes = new VisualizerModes(scene, camera, renderer);
visualizerModes.meshes.push(mesh);
visualizerModes.currentMode = 'sphere';

window.visualizerModes = visualizerModes;
window.visualizerVolume = 0;

const jarvis = new Jarvis();

// GUI (hidden by default)
const gui = new GUI();
gui.close();
gui.domElement.style.display = 'none'; // Hide GUI for clean look

let mouseX = 0;
let mouseY = 0;
document.addEventListener('mousemove', (e) => {
    mouseX = (e.clientX - window.innerWidth / 2) / 100;
    mouseY = (e.clientY - window.innerHeight / 2) / 100;
});

// Animation loop - ✅ Direct render without bloom composer
const clock = new THREE.Clock();

/* DECLARED BEFORE animate(), and that ordering is load-bearing.

   `animate()` is invoked immediately below its definition and reads this
   binding. A `let` is in its temporal dead zone until its declaration is
   evaluated, so declaring it after the call threw
   "Cannot access 'globeMode' before initialization" on the very first frame —
   and because requestAnimationFrame is the FIRST statement in the loop, the
   frame re-scheduled itself and threw again forever. Nothing after that line
   ever ran, including renderer.render(), so the ORB went dark too and the
   symptom read as "the globe will not render". */
let globeMode = null;

function animate() {
    requestAnimationFrame(animate);

    /* The globe owns the camera while it is up.

       OrbitControls writes the camera position every frame; so does the
       mouse-follow below. Both at once produces a camera that slides back
       toward centre while you are dragging the globe, which feels like the
       input is being ignored. Whoever owns the camera owns it exclusively. */
    if (!globeMode?.ownsCamera()) {
        camera.position.x += (mouseX - camera.position.x) * 0.05;
        camera.position.y += (-mouseY - camera.position.y) * 0.05;
        camera.lookAt(scene.position);
    }

    /* ONE getDelta() per frame, and everything else reads the property.

       THREE.Clock.getElapsedTime() calls getDelta() internally, so calling
       getElapsedTime() here and getDelta() further down returns a delta of
       almost zero for the second caller — the globe's auto-rotation, which is
       scaled by dt, would simply never move. */
    const frameDelta = clock.getDelta();
    uniforms.u_time.value = clock.elapsedTime;

    // ✅ FFT-driven deformation: when the mic analyser is live, blend real
    // frequency bands (bass drives the body, treble adds shimmer) with the
    // RMS volume. Falls back to plain RMS when no analyser exists.
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
        // Weighted mix scaled to the shader's expected 0-100-ish range
        const fftEnergy = (bass * 0.5 + mid * 0.35 + treble * 0.15) / 255 * 100;
        frequency = Math.max(frequency, fftEnergy);
        window.visualizerBands = { bass, mid, treble };
    }
    uniforms.u_frequency.value = frequency;

    if (visualizerModes) {
        visualizerModes.update(frequency, clock.elapsedTime, uniforms);
        if (params.autoColor) {
            visualizerModes.setColorFromFrequency(frequency, uniforms);
        }
    }

    /* Globe mode shares this loop rather than starting its own — one WebGL
       context, one rAF, one camera. It no-ops when hidden. */
    if (globeMode) globeMode.update(frameDelta, Math.min(1, frequency / 100));

    // ✅ Direct render - NO bloom composer = true transparency
    renderer.render(scene, camera);
}
animate();

/* ---------------------------------------------------------------------------
   GLOBE MODE (F3)

   Loaded lazily and asynchronously: it pulls ~2.2 MB of GeoJSON and the
   CSS2DRenderer, and a voice assistant that starts by listening should not
   wait on a map it may never be asked to show. Until it resolves, F3 is a
   no-op rather than an error. The binding itself is declared above animate(),
   see the note there.
   --------------------------------------------------------------------------- */
import('./components/globeMode.js')
    .then(({ createGlobeMode }) => createGlobeMode({ scene, camera, renderer }))
    .then((mode) => {
        globeMode = mode;
        /* Exposed the way jarvisMirror and jarvisFoundry are, so the voice
           router reaches it without importing this module. */
        window.jarvisGlobe = mode;
        window.dispatchEvent(new CustomEvent('jarvis-globe-ready'));
        /* One warn-level line so it reaches the terminal through the main
           process forwarder. Distinguishing "loaded, layers present" from
           "never loaded" is the whole diagnosis when the globe looks empty,
           and there is no other way to see it with DevTools shut. */
        console.warn(`Globe ready — layers: ${mode.globe.loadedLayers().join(', ') || 'NONE'}`);
    })
    .catch((err) => console.error('Globe mode unavailable:', err?.stack || err));

window.addEventListener('keydown', (e) => {
    if (e.key !== 'F3') return;
    e.preventDefault();
    if (!globeMode) return;
    const on = globeMode.toggle();
    /* The orb and the globe are mutually exclusive: leaving the icosahedron
       spinning inside the Earth is exactly as odd as it sounds.

       `meshes` is the array VisualizerModes tracks — hiding only `mesh` would
       leave whichever alternative shape (cube, torus, particles) the user had
       selected still rendering inside the globe. */
    for (const m of visualizerModes?.meshes || [mesh]) if (m) m.visible = !on;
});

// Resize handling
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

// Minimal mode toggle: F2 switches between orb-only and full HUD
window.addEventListener('keydown', (e) => {
    if (e.key === 'F2') {
        document.body.classList.toggle('minimal');
    }
});

// ✅ System Diagnostics HUD — live telemetry pushed from the Electron main process
(function initDiagnosticsHud() {
    if (!window.electronAPI?.onSystemTelemetry) return; // browser dev mode: leave placeholders

    const cpuEl = document.getElementById('diag-cpu');
    const cpuBar = document.getElementById('diag-cpu-bar');
    const memEl = document.getElementById('diag-mem');
    const memBar = document.getElementById('diag-mem-bar');
    const footer = document.getElementById('diag-footer');

    const barClass = (pct) => pct >= 90 ? 'diag-bar-fill critical' : pct >= 70 ? 'diag-bar-fill warning' : 'diag-bar-fill';

    window.electronAPI.onSystemTelemetry((event, t) => {
        if (!t) return;
        cpuEl.textContent = `${t.cpu}%`;
        cpuBar.style.width = `${t.cpu}%`;
        cpuBar.className = barClass(t.cpu);
        memEl.textContent = `${t.memUsedGb}/${t.memTotalGb}G`;
        memBar.style.width = `${t.memPercent}%`;
        memBar.className = barClass(t.memPercent);
        footer.textContent = `CORES ${t.cores} · UP ${t.uptimeHours}H`;
    });
})();
