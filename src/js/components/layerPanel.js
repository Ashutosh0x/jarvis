// The layer switchboard.
//
// ---------------------------------------------------------------------------
// STYLES ARE INJECTED HERE, NOT IN index.html
//
// There is no CSS directory in this project — the globe's styles live in
// index.html and its components own their own. A panel that exists only when
// the globe does should not add 120 lines to a file the orb also loads, so it
// appends one <style> tag on construction and removes it on dispose.
//
// IT RENDERS FROM THE MANAGER, NEVER FROM ITS OWN STATE. Every row reflects
// `layerManager.getAll()`, and the manager notifies on change. A satellite
// layer that refuses to switch on (no network, no elements) must not leave a
// switch showing "on" — the only way to guarantee that is to have no local
// copy of the truth to drift.
//
// LOADING AND FAILURE ARE VISIBLE. A layer mid-fetch pulses; one that failed
// shows its reason on the row. Both beat a switch that is on with nothing
// drawn, which is indistinguishable from a quiet world.
// ---------------------------------------------------------------------------

import { CATEGORIES } from './globeLayers.js';

const STYLE_ID = 'globe-layer-panel-style';

const CSS = `
.globe-layers {
  position: fixed; left: 18px; top: 50%; transform: translateY(-50%) translateX(-120%);
  width: 232px; max-height: 74vh; overflow-y: auto; z-index: 1006;
  /* Glass, matched to the amber network rather than a neutral grey — the
     panel has to look like it belongs to this globe. */
  background: rgba(8, 10, 20, 0.88);
  backdrop-filter: blur(24px) saturate(1.3);
  -webkit-backdrop-filter: blur(24px) saturate(1.3);
  border: 1px solid rgba(255, 157, 46, 0.15);
  box-shadow: 0 4px 30px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,157,46,0.06);
  border-radius: 12px;
  padding: 12px 0 10px;
  font-family: 'Rajdhani', sans-serif;
  opacity: 0; pointer-events: none;
  transition: transform 260ms cubic-bezier(.16,1,.3,1), opacity 200ms ease;
}
.globe-layers.visible { transform: translateY(-50%) translateX(0); opacity: 1; pointer-events: auto; }
.globe-layers::-webkit-scrollbar { width: 6px; }
.globe-layers::-webkit-scrollbar-thumb { background: rgba(255,157,46,0.25); border-radius: 3px; }

.gl-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 0 14px 10px; margin-bottom: 4px;
  border-bottom: 1px solid rgba(255,255,255,0.06);
}
.gl-title {
  font-family: 'Orbitron', sans-serif; font-size: 10px; letter-spacing: 2px;
  text-transform: uppercase; color: rgba(255,157,46,0.85);
}
.gl-count {
  font-size: 10px; color: rgba(255,255,255,0.45);
  background: rgba(255,157,46,0.12); border-radius: 10px; padding: 2px 8px;
}
.gl-cat {
  font-size: 9px; letter-spacing: 1.6px; text-transform: uppercase;
  color: rgba(255,255,255,0.32); padding: 10px 14px 4px;
}
.gl-row {
  display: flex; align-items: center; gap: 9px;
  padding: 7px 14px; cursor: pointer; user-select: none;
  transition: background 140ms ease;
}
.gl-row:hover { background: rgba(255,255,255,0.04); }
.gl-dot { width: 7px; height: 7px; border-radius: 50%; flex: 0 0 7px; }
.gl-name { flex: 1; font-size: 13px; color: rgba(255,255,255,0.8); }
.gl-row.on .gl-name { color: #fff; }
.gl-err { font-size: 10px; color: rgba(255,120,120,0.75); flex-basis: 100%; padding-left: 30px; }

/* A CSS-only switch — no library, and it reads as a switch to a screen
   reader because the row carries role and state. */
.gl-sw {
  width: 30px; height: 17px; border-radius: 9px; flex: 0 0 30px;
  background: rgba(255,255,255,0.13); position: relative;
  transition: background 180ms ease;
}
.gl-sw::after {
  content: ''; position: absolute; top: 2px; left: 2px;
  width: 13px; height: 13px; border-radius: 50%;
  background: rgba(255,255,255,0.55);
  transition: transform 180ms cubic-bezier(.16,1,.3,1), background 180ms ease;
}
.gl-row.on .gl-sw { background: rgba(255,157,46,0.4); }
.gl-row.on .gl-sw::after { transform: translateX(13px); background: #ff9d2e; }
.gl-row.loading .gl-sw { animation: gl-pulse 1.1s ease-in-out infinite; }
@keyframes gl-pulse { 0%,100% { opacity: 1 } 50% { opacity: .45 } }

.gl-hint {
  padding: 9px 14px 0; margin-top: 6px;
  border-top: 1px solid rgba(255,255,255,0.06);
  font-size: 10px; color: rgba(255,255,255,0.3); letter-spacing: 1px;
}
`;

export function createLayerPanel(layerManager, { mount = document.body } = {}) {
    if (!document.getElementById(STYLE_ID)) {
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = CSS;
        document.head.appendChild(style);
    }

    const root = document.createElement('div');
    root.className = 'globe-layers';
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', 'Globe data layers');
    mount.appendChild(root);

    let visible = false;

    function render(list) {
        const rows = list || layerManager.getAll();
        root.innerHTML = '';

        const head = document.createElement('div');
        head.className = 'gl-head';
        const title = document.createElement('span');
        title.className = 'gl-title';
        title.textContent = 'Layers';
        const count = document.createElement('span');
        count.className = 'gl-count';
        count.textContent = `${layerManager.activeCount()} on`;
        head.append(title, count);
        root.appendChild(head);

        let lastCat = null;
        for (const l of rows) {
            if (l.category !== lastCat) {
                lastCat = l.category;
                const c = document.createElement('div');
                c.className = 'gl-cat';
                c.textContent = CATEGORIES[l.category]?.label || l.category;
                root.appendChild(c);
            }

            const row = document.createElement('div');
            row.className = `gl-row${l.visible ? ' on' : ''}${l.loading ? ' loading' : ''}`;
            row.setAttribute('role', 'switch');
            row.setAttribute('aria-checked', String(l.visible));
            row.setAttribute('tabindex', '0');
            row.setAttribute('aria-label', l.name);

            const dot = document.createElement('span');
            dot.className = 'gl-dot';
            dot.style.background = CATEGORIES[l.category]?.colour || '#888';

            const name = document.createElement('span');
            name.className = 'gl-name';
            name.textContent = l.name;

            const sw = document.createElement('span');
            sw.className = 'gl-sw';

            row.append(dot, name, sw);

            const fire = () => { void layerManager.toggle(l.id); };
            row.addEventListener('click', fire);
            row.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fire(); }
            });
            root.appendChild(row);

            if (l.error) {
                const err = document.createElement('div');
                err.className = 'gl-err';
                err.textContent = l.error;
                root.appendChild(err);
            }
        }

        const hint = document.createElement('div');
        hint.className = 'gl-hint';
        hint.textContent = 'L to close';
        root.appendChild(hint);
    }

    /* Re-render on every manager change — the panel keeps no state of its own,
       so it cannot drift from what is actually drawn. */
    const off = layerManager.onChange(render);
    render();

    function setVisible(on) {
        visible = !!on;
        root.classList.toggle('visible', visible);
        if (visible) render();
    }

    function dispose() {
        off?.();
        root.remove();
        document.getElementById(STYLE_ID)?.remove();
    }

    return {
        root,
        show: () => setVisible(true),
        hide: () => setVisible(false),
        toggle: () => setVisible(!visible),
        setVisible,
        isVisible: () => visible,
        dispose
    };
}

export default { createLayerPanel };
