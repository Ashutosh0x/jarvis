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

function animate() {
    requestAnimationFrame(animate);

    camera.position.x += (mouseX - camera.position.x) * 0.05;
    camera.position.y += (-mouseY - camera.position.y) * 0.05;
    camera.lookAt(scene.position);

    uniforms.u_time.value = clock.getElapsedTime();
    let frequency = window.visualizerVolume || 0;
    uniforms.u_frequency.value = frequency;

    if (visualizerModes) {
        visualizerModes.update(frequency, clock.getElapsedTime(), uniforms);
        if (params.autoColor) {
            visualizerModes.setColorFromFrequency(frequency, uniforms);
        }
    }

    // ✅ Direct render - NO bloom composer = true transparency
    renderer.render(scene, camera);
}
animate();

// Resize handling
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});
