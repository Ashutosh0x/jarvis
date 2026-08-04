// The orbit viewer: the actual mesh, in 3D, in Electron.
//
// Pure JavaScript. three.js runs on Chromium's WebGL stack inside the renderer
// — Blender is not involved once the GLB has been written, and nothing here
// crosses a process boundary while you are dragging.
//
// ---------------------------------------------------------------------------
// LOADED ON DEMAND
//
// Reached through a dynamic import() the first time a 3D view is opened, so
// Vite splits it into its own chunk — measured at 61 KB.
//
// Note what that number is and is not: three.js CORE is already in the startup
// bundle, because scripts.js and visualizerModes.js use it for the HUD
// visualiser. So the saving here is the addons (GLTFLoader, OrbitControls,
// RoomEnvironment) and this file, not the 700 KB of three itself. Worth doing,
// and a tenth of what it would be worth in a project that did not already draw
// with three.
//
// WHY GLB AND NOT THE STL
//
// glTF carries the PBR material model that Blender's Principled BSDF maps onto,
// so base colour, metallic, roughness and emission arrive intact. STL carries
// triangles and nothing else — the bracket would orbit in flat grey, and the
// viewer would disagree with the render sitting next to it.
//
// WHY THE RENDERER IS NOT WebGPU
//
// three r158 ships a WebGPU renderer, and it is still marked experimental in
// this version. This runs on a GTX 1650 Ti behind an Electron/Chromium GPU
// process that is also compositing the rest of Jarvis; WebGL2 is the path with
// the fewest ways to fail silently here. Nothing in this file depends on the
// choice — it is one constructor if that changes.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

/**
 * Mount an orbit viewer into a container.
 *
 * @param {HTMLElement} container
 * @returns {{load:(base64:string)=>Promise<object>, dispose:()=>void, resetView:()=>void, setWireframe:(on:boolean)=>void, resize:()=>void}}
 */
export function createViewer(container) {
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth || 640, container.clientHeight || 360);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    /* The render next to this one came out of Blender with a filmic-ish
       response. ACES here is not an exact match for AgX, and it is far closer
       than linear — without tone mapping the metallic bracket clips to white
       and the viewer looks broken beside its own render. */
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    container.appendChild(renderer.domElement);
    renderer.domElement.style.display = 'block';
    /* Square corners: the panel is frameless, and a rounded canvas inside it
       reintroduces the box that was removed. */
    renderer.domElement.style.borderRadius = '0';
    renderer.domElement.style.cursor = 'grab';

    const scene = new THREE.Scene();

    /* An image-based environment, not a pair of point lights.

       The models this pipeline makes are mostly metal and plastic, and a
       metallic surface has no diffuse response at all — lit by point lights it
       renders as a black shape with two specular dots. RoomEnvironment is a
       procedural studio generated on the GPU at startup, so it ships no HDR
       file and gives every material something real to reflect. */
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

    /* A soft key on top of the environment: the environment alone is flat and
       shadowless, and a single directional light restores the sense of form. */
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(4, 6, 5);
    scene.add(key);
    scene.add(new THREE.AmbientLight(0xbcd6ff, 0.25));

    const camera = new THREE.PerspectiveCamera(45, (container.clientWidth || 640) / (container.clientHeight || 360), 0.01, 2000);
    camera.position.set(3, 2.4, 3);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;          // inertia; without it dragging feels stuck
    controls.dampingFactor = 0.07;
    controls.enablePan = true;
    controls.screenSpacePanning = true;     // pan follows the cursor rather than the ground plane
    controls.minDistance = 0.05;
    controls.maxDistance = 500;
    controls.addEventListener('start', () => { renderer.domElement.style.cursor = 'grabbing'; });
    controls.addEventListener('end', () => { renderer.domElement.style.cursor = 'grab'; });

    /* Z-up, because Blender is Z-up and three.js is Y-up.

       The glTF exporter already converts to Y-up, so the mesh arrives correct
       and this only sets which way the ORBIT feels — dragging sideways should
       spin the object about its vertical axis, which is what a person expects
       from a turntable. */
    controls.target.set(0, 0, 0);

    /* A ground grid, for a sense of scale and of which way is down. Rescaled to
       the subject once its bounds are known. */
    const grid = new THREE.GridHelper(10, 20, 0x2f6ea8, 0x1b3550);
    grid.material.transparent = true;
    grid.material.opacity = 0.35;
    scene.add(grid);

    let model = null;
    let raf = 0;
    let disposed = false;
    let bounds = null;

    function frameObject(object) {
        const box = new THREE.Box3().setFromObject(object);
        if (box.isEmpty()) return null;
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const radius = Math.max(size.length() / 2, 1e-4);

        controls.target.copy(center);
        const fov = THREE.MathUtils.degToRad(camera.fov);
        const distance = (radius / Math.sin(fov / 2)) * 1.3;
        /* Same three-quarter angle the render uses, so the two agree. */
        const dir = new THREE.Vector3(1, 0.7, 1).normalize();
        camera.position.copy(center).addScaledVector(dir, distance);

        camera.near = Math.max(distance / 1000, 0.001);
        camera.far = distance * 100;
        camera.updateProjectionMatrix();
        controls.update();

        /* Scale the grid to the subject so a 0.2-unit part is not sitting on a
           10-unit floor, and a 40-unit one is not floating off the edge. */
        const step = Math.pow(10, Math.floor(Math.log10(radius)));
        grid.scale.setScalar(Math.max(step * 2, 0.01));
        grid.position.set(center.x, box.min.y, center.z);

        return { radius, center: center.toArray(), size: size.toArray() };
    }

    function tick() {
        if (disposed) return;
        raf = requestAnimationFrame(tick);
        controls.update();
        renderer.render(scene, camera);
    }
    tick();

    function resize() {
        const w = container.clientWidth, h = container.clientHeight;
        if (!w || !h) return;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
    }
    const observer = new ResizeObserver(resize);
    observer.observe(container);

    function clearModel() {
        if (!model) return;
        scene.remove(model);
        model.traverse((node) => {
            if (node.isMesh) {
                node.geometry?.dispose?.();
                const mats = Array.isArray(node.material) ? node.material : [node.material];
                for (const m of mats) m?.dispose?.();
            }
        });
        model = null;
    }

    /**
     * Load a GLB from base64.
     *
     * parse() rather than load(): the bytes came over IPC, so there is no URL
     * to fetch and no blob to create and revoke.
     */
    function load(base64) {
        return new Promise((resolve, reject) => {
            let buffer;
            try {
                const binary = atob(base64);
                buffer = new ArrayBuffer(binary.length);
                const view = new Uint8Array(buffer);
                for (let i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i);
            } catch (e) {
                reject(new Error(`the mesh data was not valid base64: ${e.message}`));
                return;
            }

            new GLTFLoader().parse(buffer, '', (gltf) => {
                clearModel();
                model = gltf.scene;

                let meshes = 0, triangles = 0;
                model.traverse((node) => {
                    if (!node.isMesh) return;
                    meshes++;
                    const index = node.geometry?.index;
                    const position = node.geometry?.attributes?.position;
                    triangles += index ? index.count / 3 : (position ? position.count / 3 : 0);
                    node.castShadow = node.receiveShadow = true;
                });

                scene.add(model);
                bounds = frameObject(model);

                if (!meshes) {
                    /* A GLB that loaded but contains no drawable geometry is a
                       real outcome — a scene of only cutters, for instance —
                       and an empty viewport with no explanation looks broken. */
                    resolve({ meshes: 0, triangles: 0, empty: true, bounds });
                    return;
                }
                resolve({ meshes, triangles: Math.round(triangles), empty: false, bounds });
            }, (err) => reject(new Error(err?.message || 'the mesh could not be parsed')));
        });
    }

    function setWireframe(on) {
        model?.traverse((node) => {
            if (!node.isMesh) return;
            const mats = Array.isArray(node.material) ? node.material : [node.material];
            for (const m of mats) if (m) m.wireframe = !!on;
        });
    }

    function resetView() { if (model) frameObject(model); }

    function dispose() {
        disposed = true;
        cancelAnimationFrame(raf);
        observer.disconnect();
        controls.dispose();
        clearModel();
        /* The environment texture and the PMREM generator hold GPU memory, and
           this runs on a 4 GB card that Ollama is also using. Leaking a render
           target per viewer open would be felt. */
        scene.environment?.dispose?.();
        pmrem.dispose();
        renderer.dispose();
        renderer.domElement.remove();
    }

    return { load, dispose, resetView, setWireframe, resize };
}

export default { createViewer };
