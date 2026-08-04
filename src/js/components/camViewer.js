// A live road view, floating on the globe.
//
// ---------------------------------------------------------------------------
// FRAMELESS, LIKE THE DOSSIER
//
// No window chrome, no card, no border. The picture sits on the background
// with its own rounded crop, a caption under it, and nothing else. The globe
// keeps showing around it, which is the whole reason the dossier lost its
// panel too.
//
// EVERY FRAME COMES THROUGH THE MAIN PROCESS. The renderer never sets an
// <img src> to a camera host: the URL belongs to a third party chosen from a
// list this app did not write, and loading it directly would mean an
// arbitrary remote origin fetching from a page that also holds the session.
// Main fetches it, checks it against an allowlist, and returns a data URI.
//
// IT REFRESHES, RATHER THAN STREAMING. TfL publishes a still that updates
// every few minutes and a short MP4 clip; neither is a live stream, and
// pretending otherwise with a <video> that loops the same ten seconds would
// imply a liveness the source does not have. The caption states the age of
// the frame for the same reason.
// ---------------------------------------------------------------------------

const STYLE_ID = 'globe-camviewer-style';

const CSS = `
.globe-cam {
  position: fixed; left: 50%; bottom: 96px; transform: translateX(-50%) translateY(14px);
  width: min(460px, 42vw); z-index: 1005;
  font-family: 'Rajdhani', sans-serif;
  opacity: 0; pointer-events: none;
  transition: opacity 260ms ease, transform 320ms cubic-bezier(.16,1,.3,1);
}
.globe-cam.visible { opacity: 1; transform: translateX(-50%) translateY(0); pointer-events: auto; }

.globe-cam-frame {
  position: relative; width: 100%; aspect-ratio: 16 / 9;
  border-radius: 16px; overflow: hidden;
  background: rgba(255,255,255,0.03);
  /* The only shadow in the component, and it is there to lift the picture off
     a bright coastline rather than to draw a box. */
  box-shadow: 0 18px 60px rgba(0,0,0,0.55);
}
.globe-cam-frame img, .globe-cam-frame video {
  position: absolute; inset: 0; width: 100%; height: 100%;
  object-fit: cover; display: block;
}
.globe-cam-loading {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  color: rgba(255,255,255,0.35); font-size: 12px; letter-spacing: 1px;
}
.globe-cam-close {
  position: absolute; top: 8px; right: 10px; z-index: 2;
  background: rgba(0,0,0,0.45); border: none; border-radius: 50%;
  width: 26px; height: 26px; color: rgba(255,255,255,0.8);
  font-size: 16px; line-height: 1; cursor: pointer;
  backdrop-filter: blur(8px);
}
.globe-cam-close:hover { color: #fff; background: rgba(0,0,0,0.65); }

.globe-cam-cap {
  display: flex; align-items: baseline; gap: 8px;
  padding: 9px 4px 0;
}
.globe-cam-name {
  font-size: 14px; font-weight: 600; color: #f2f6fb;
  text-shadow: 0 1px 10px rgba(0,0,0,0.9);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.globe-cam-meta {
  margin-left: auto; font-size: 11px; color: rgba(255,255,255,0.45);
  white-space: nowrap;
}
.globe-cam-strip {
  display: flex; gap: 6px; overflow-x: auto; padding: 10px 4px 0;
  scrollbar-width: none;
}
.globe-cam-strip::-webkit-scrollbar { height: 0; }
.globe-cam-chip {
  flex: 0 0 auto; padding: 5px 11px; border-radius: 999px;
  background: rgba(255,255,255,0.06); border: none; cursor: pointer;
  font-family: 'Rajdhani', sans-serif; font-size: 11.5px; font-weight: 600;
  color: rgba(255,255,255,0.68); white-space: nowrap;
  transition: background 150ms ease, color 150ms ease;
}
.globe-cam-chip:hover { background: rgba(255,157,46,0.18); color: #fff; }
.globe-cam-chip.on { background: rgba(255,157,46,0.28); color: #fff; }
`;

/* TfL refreshes its stills every few minutes; asking faster spends bandwidth
   on the same picture. */
const REFRESH_MS = 60_000;

export function createCamViewer({ mount = document.body } = {}) {
    if (!document.getElementById(STYLE_ID)) {
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = CSS;
        document.head.appendChild(style);
    }

    const root = document.createElement('div');
    root.className = 'globe-cam';
    root.innerHTML = `
        <div class="globe-cam-frame">
          <button class="globe-cam-close" title="Close">&times;</button>
          <div class="globe-cam-loading">Acquiring feed…</div>
        </div>
        <div class="globe-cam-cap">
          <span class="globe-cam-name">—</span>
          <span class="globe-cam-meta"></span>
        </div>
        <div class="globe-cam-strip"></div>`;
    mount.appendChild(root);

    const frameEl = root.querySelector('.globe-cam-frame');
    const loadEl = root.querySelector('.globe-cam-loading');
    const nameEl = root.querySelector('.globe-cam-name');
    const metaEl = root.querySelector('.globe-cam-meta');
    const stripEl = root.querySelector('.globe-cam-strip');

    let cameras = [];
    let current = null;
    let timer = null;
    let media = null;
    /* Guards against a slow fetch for camera A landing after the user has
       already switched to camera B. */
    let token = 0;

    root.querySelector('.globe-cam-close').addEventListener('click', () => hide());

    function clearMedia() {
        if (media) { media.remove(); media = null; }
    }

    async function paint(cam, { silent = false } = {}) {
        if (!cam) return;
        const mine = ++token;
        if (!silent) loadEl.style.display = '';

        const bridge = window.electronAPI?.trafficCams;
        if (!bridge) {
            loadEl.textContent = 'Camera feed needs the desktop build.';
            return;
        }
        const res = await bridge('frame', { url: cam.image || cam.video, kind: cam.image ? 'image' : 'video' })
            .catch(() => null);
        if (mine !== token) return;   // superseded

        if (!res?.ok) {
            loadEl.style.display = '';
            /* Named, not hidden — "unavailable" and "the camera is down" are
               different facts and the user can act on the second. */
            loadEl.textContent = res?.reason === 'timeout'
                ? 'Feed timed out.'
                : `Feed unavailable (${res?.reason || 'unknown'})`;
            clearMedia();
            return;
        }

        clearMedia();
        const el = document.createElement('img');
        el.src = res.data.dataUri;
        el.alt = cam.name;
        frameEl.insertBefore(el, loadEl);
        media = el;
        loadEl.style.display = 'none';

        nameEl.textContent = cam.name;
        const bits = [];
        if (cam.view) bits.push(cam.view);
        if (Number.isFinite(cam.distanceKm)) bits.push(`${cam.distanceKm} km`);
        bits.push(cam.operator);
        metaEl.textContent = bits.join(' · ');
    }

    function renderStrip() {
        stripEl.innerHTML = '';
        for (const c of cameras.slice(0, 10)) {
            const b = document.createElement('button');
            b.className = `globe-cam-chip${c.id === current?.id ? ' on' : ''}`;
            b.type = 'button';
            b.textContent = c.name.length > 26 ? `${c.name.slice(0, 25)}…` : c.name;
            b.setAttribute('aria-label', `Show ${c.name}`);
            b.addEventListener('click', () => { current = c; renderStrip(); void paint(c); });
            stripEl.appendChild(b);
        }
    }

    /**
     * Show the cameras near a place.
     * @returns {number} how many were found — the caller reports it
     */
    async function showNear(lat, lng, { radiusKm = 25, name = '' } = {}) {
        const bridge = window.electronAPI?.trafficCams;
        if (!bridge) return 0;
        const res = await bridge('near', { lat, lng, radiusKm, limit: 10 }).catch(() => null);
        cameras = res?.ok ? res.data.cameras : [];
        if (!cameras.length) { hide(); return 0; }

        current = cameras[0];
        renderStrip();
        root.classList.add('visible');
        await paint(current);

        clearInterval(timer);
        timer = setInterval(() => { if (current) void paint(current, { silent: true }); }, REFRESH_MS);
        return cameras.length;
    }

    function hide() {
        root.classList.remove('visible');
        clearInterval(timer);
        timer = null;
        token++;            // abandon any in-flight paint
        clearMedia();
    }

    function dispose() {
        hide();
        root.remove();
        document.getElementById(STYLE_ID)?.remove();
    }

    return {
        root, showNear, hide, dispose,
        isVisible: () => root.classList.contains('visible'),
        count: () => cameras.length
    };
}

export default { createCamViewer };
