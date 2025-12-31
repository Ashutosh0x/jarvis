// Visualizer Modes Manager
class VisualizerModes {
    constructor(scene, camera, renderer) {
        this.scene = scene;
        this.camera = camera;
        this.renderer = renderer;
        this.currentMode = 'sphere';
        this.meshes = [];
        this.particleSystem = null;

        this.modes = {
            sphere: this.createSphere.bind(this),
            cube: this.createCube.bind(this),
            particles: this.createParticles.bind(this),
            torus: this.createTorus.bind(this)
        };
    }

    // Create sphere visualizer
    createSphere(geometry, material) {
        return new THREE.Mesh(geometry, material);
    }

    // Create cube visualizer
    createCube(geometry, material) {
        const cubeGeo = new THREE.BoxGeometry(8, 8, 8, 10, 10, 10);
        return new THREE.Mesh(cubeGeo, material);
    }

    // Create torus visualizer
    createTorus(geometry, material) {
        const torusGeo = new THREE.TorusGeometry(4, 1.5, 16, 100);
        return new THREE.Mesh(torusGeo, material);
    }

    // Create particle system
    createParticles(geometry, material) {
        const particleCount = 1000;
        const particles = new THREE.BufferGeometry();
        const positions = new Float32Array(particleCount * 3);

        for (let i = 0; i < particleCount * 3; i++) {
            positions[i] = (Math.random() - 0.5) * 20;
        }

        particles.setAttribute('position', new THREE.BufferAttribute(positions, 3));

        const particleMaterial = new THREE.PointsMaterial({
            color: material.uniforms.u_red.value * 0xffffff,
            size: 0.1,
            transparent: true,
            opacity: 0.8
        });

        return new THREE.Points(particles, particleMaterial);
    }

    // Switch visualizer mode
    switchMode(modeName, existingMaterial) {
        // Get material from existing mesh if not provided
        if (!existingMaterial && this.meshes.length > 0) {
            existingMaterial = this.meshes[0].material;
        }

        if (!existingMaterial) {
            console.warn('No material provided for mode switch');
            return null;
        }

        // Remove existing meshes
        this.meshes.forEach(mesh => {
            this.scene.remove(mesh);
            if (mesh.geometry) mesh.geometry.dispose();
        });
        this.meshes = [];

        if (this.particleSystem) {
            this.scene.remove(this.particleSystem);
            if (this.particleSystem.geometry) this.particleSystem.geometry.dispose();
            if (this.particleSystem.material) this.particleSystem.material.dispose();
            this.particleSystem = null;
        }

        if (!this.modes[modeName]) {
            console.warn(`Unknown mode: ${modeName}`);
            return null;
        }

        // Create new geometry based on mode
        let geometry;
        if (modeName === 'sphere') {
            geometry = new THREE.IcosahedronGeometry(4, 30);
        } else if (modeName === 'cube') {
            geometry = new THREE.BoxGeometry(4, 4, 4, 10, 10, 10);
        } else if (modeName === 'torus') {
            geometry = new THREE.TorusGeometry(4, 1.5, 16, 100);
        } else {
            geometry = new THREE.IcosahedronGeometry(4, 30); // Default
        }

        const mesh = this.modes[modeName](geometry, existingMaterial);

        if (modeName === 'particles') {
            this.particleSystem = mesh;
            this.scene.add(this.particleSystem);
        } else {
            mesh.material = existingMaterial;
            mesh.material.wireframe = true;
            mesh.material.transparent = true;
            this.meshes.push(mesh);
            this.scene.add(mesh);
        }

        this.currentMode = modeName;
        return mesh;
    }

    // Update visualizer based on frequency
    update(frequency, time, uniforms) {
        if (this.currentMode === 'particles' && this.particleSystem) {
            const positions = this.particleSystem.geometry.attributes.position.array;
            for (let i = 0; i < positions.length; i += 3) {
                const scale = 1 + (frequency / 30) * 0.5;
                positions[i] *= scale;
                positions[i + 1] *= scale;
                positions[i + 2] *= scale;
            }
            this.particleSystem.geometry.attributes.position.needsUpdate = true;
        } else {
            this.meshes.forEach(mesh => {
                if (mesh.material.uniforms) {
                    mesh.material.uniforms.u_frequency.value = frequency;
                    mesh.material.uniforms.u_time.value = time;
                }
            });
        }
    }

    // Change color based on voice activity with smoothing + time-based cycling
    setColorFromFrequency(frequency, uniforms) {
        // Higher sensitivity: map 0-30 range to 0-1 intensity
        const intensity = Math.min(frequency / 20, 1);
        const time = Date.now() * 0.001; // Current time in seconds

        let targetRed, targetGreen, targetBlue;

        // Color shifts based on frequency thresholds
        if (intensity > 0.6) {
            // High frequency - red/orange
            targetRed = 1.0;
            targetGreen = 0.3;
            targetBlue = 0.1;
        } else if (intensity > 0.15) {
            // Medium frequency - cyan/blue
            targetRed = 0.1;
            targetGreen = 0.8;
            targetBlue = 1.0;
        } else {
            // Low/no frequency - time-based cycling for organic feel
            const hue = (time * 0.1) % 1; // Slow color cycle

            // Convert hue to RGB (simplified HSL to RGB)
            if (hue < 0.33) {
                // Purple to Cyan
                targetRed = 0.5 - hue * 1.2;
                targetGreen = 0.1 + hue * 2;
                targetBlue = 0.8 + hue * 0.6;
            } else if (hue < 0.66) {
                // Cyan to Pink
                const h = hue - 0.33;
                targetRed = 0.1 + h * 2.7;
                targetGreen = 0.8 - h * 2;
                targetBlue = 1.0 - h * 0.6;
            } else {
                // Pink to Purple
                const h = hue - 0.66;
                targetRed = 1.0 - h * 1.5;
                targetGreen = 0.1;
                targetBlue = 0.6 + h * 0.6;
            }
        }

        // Apply smoothing (lerp) to prevent jarring jumps
        const lerpFactor = 0.05;
        uniforms.u_red.value += (targetRed - uniforms.u_red.value) * lerpFactor;
        uniforms.u_green.value += (targetGreen - uniforms.u_green.value) * lerpFactor;
        uniforms.u_blue.value += (targetBlue - uniforms.u_blue.value) * lerpFactor;
    }
}

export default VisualizerModes;

