// The globe's colour, in three flavours.
//
// ---------------------------------------------------------------------------
// ONE SOURCE OF TRUTH, PUSHED THREE PLACES
//
// The globe's colour lives in three unrelated systems: the shader uniform on
// the atmosphere, the material colours on the merged coastline/border lines,
// and a CSS variable the HUD panels read. A theme is only coherent if all
// three move together, so this owns the mapping and pushes to each — nobody
// else sets a colour.
//
// GLOBE_COLORS IS MUTATED ON PURPOSE. New layers read GLOBE_COLORS.network at
// construction (ripples, arcs, the graticule). Updating the object means a
// layer added AFTER a theme change picks up the current theme rather than the
// amber default — without it, switching to violet and then flying somewhere
// would draw amber ripples on a violet globe.
//
// AMBER IS THE DEFAULT AND STAYS THAT WAY. This is the Iron Man look the globe
// was built around; the other two are alternates, not a replacement.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { GLOBE_COLORS } from './globeRenderer.js';

export const THEMES = {
    amber: {
        label: 'Amber',
        network: 0xff9d2e, networkDim: 0x8a4f14, atmosphere: 0xffa33a,
        css: '#ff9d2e', cssDim: 'rgba(255, 157, 46, 0.55)'
    },
    ghost: {
        label: 'Ghost',
        network: 0x8a5cf6, networkDim: 0x4a3080, atmosphere: 0xa855f7,
        css: '#a78bfa', cssDim: 'rgba(138, 92, 246, 0.55)'
    },
    tactical: {
        label: 'Tactical',
        network: 0x3b82f6, networkDim: 0x1e4585, atmosphere: 0x60a5fa,
        css: '#60a5fa', cssDim: 'rgba(59, 130, 246, 0.55)'
    }
};

const ORDER = ['amber', 'ghost', 'tactical'];

export function createThemeManager(globe, { codeOverlay = null } = {}) {
    let current = 'amber';
    const listeners = new Set();

    function apply(name) {
        const t = THEMES[name];
        if (!t) return current;
        current = name;

        /* 1. GLOBE_COLORS — so future layers are born in the theme. */
        GLOBE_COLORS.network = t.network;
        GLOBE_COLORS.networkDim = t.networkDim;
        GLOBE_COLORS.atmosphere = t.atmosphere;

        /* 2. The atmosphere shader uniform. */
        const uColor = globe?.atmosphere?.material?.uniforms?.uColor?.value;
        if (uColor) uColor.set(t.atmosphere);

        /* 3. The already-built line layers. Each is a merged LineSegments with
              one material — recolouring is one assignment, not a rebuild. */
        const layers = globe?.layers || {};
        const net = new THREE.Color(t.network);
        const dim = new THREE.Color(t.networkDim);
        if (layers.coastline) layers.coastline.material.color.copy(net);
        if (layers.borders) layers.borders.material.color.copy(net);
        if (layers.land) layers.land.material.color.copy(dim);

        /* 4. The CSS variable the HUD reads. Guarded so the pure colour logic
              above stays testable in node, where there is no document. */
        if (typeof document !== 'undefined' && document.documentElement) {
            const root = document.documentElement;
            root.style.setProperty('--globe-amber', t.css);
            root.style.setProperty('--globe-amber-dim', t.cssDim);
            root.dataset.globeTheme = name;
        }

        codeOverlay?.log?.(`theme -> ${name}`);
        for (const fn of listeners) { try { fn(name); } catch { /* keep going */ } }
        return current;
    }

    function cycle() {
        const i = ORDER.indexOf(current);
        return apply(ORDER[(i + 1) % ORDER.length]);
    }

    return {
        setTheme: apply,
        cycle,
        getTheme: () => current,
        getThemes: () => ORDER.map((id) => ({ id, label: THEMES[id].label })),
        onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
        /* Restore the default when the globe is torn down, so the HUD var does
           not stay violet under the orb. */
        dispose: () => { apply('amber'); listeners.clear(); }
    };
}

export default { createThemeManager, THEMES };
