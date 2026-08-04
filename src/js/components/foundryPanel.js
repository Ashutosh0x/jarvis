// The Foundry viewer — what Jarvis has built, on screen.
//
// Self-mounting, like mirrorPanel.js: loaded by a script tag in index.html and
// exposed as window.jarvisFoundry so the voice router reaches it without an
// import. Every element is built here rather than in index.html, so the panel
// is one file to add or remove.
//
// ---------------------------------------------------------------------------
// WHY IT SHOWS THE RENDER AND NOT A LIVE 3D VIEWPORT
//
// A turntable would need the GLB shipped to the renderer and a WebGL scene, and
// on a 4 GB card that is competing for VRAM with the model that plans the
// scenes. The render is the artefact Blender actually produced — the lighting,
// the materials and the framing as they will be — and showing anything else
// risks the viewer and the file disagreeing.
//
// "Live" here means the panel follows the pipeline: it opens on the newest job,
// and when a build finishes while it is open it moves to that one by itself.
// ---------------------------------------------------------------------------

const CSS = `
/* FRAMELESS, the way #mirror-panel is: border: none, border-radius: 0, and no
   card floating inside a card. The panel IS the surface — content sits
   directly on it, edge to edge, and the 3D view gets the whole window instead
   of a box in the middle of one. */
.foundry-overlay {
    position: fixed; inset: 0; z-index: 9000;
    display: none; flex-direction: column;
    background: rgba(3, 6, 11, 0.94);
    font-family: inherit; color: #cfe6ff;
}
.foundry-overlay.open { display: flex; }
.foundry-shell {
    flex: 1 1 auto; min-height: 0;
    display: flex; flex-direction: column; gap: 12px;
    background: transparent;
    border: none; border-radius: 0; box-shadow: none;
    padding: 14px 20px 16px;
}
.foundry-head { display: flex; align-items: baseline; gap: 12px; }
.foundry-title { font-size: 17px; letter-spacing: .04em; color: #7fd4ff; text-transform: uppercase; }
.foundry-sub { font-size: 12px; opacity: .62; }
/* No outlines on the controls either — a frameless panel full of bordered
   buttons is still a panel full of boxes. Affordance comes from the hover
   fill, and the accent is kept for state that means something. */
.foundry-close {
    margin-left: auto; cursor: pointer; border: none;
    background: transparent; color: #8fb6d8; border-radius: 6px;
    padding: 4px 11px; font-size: 12px;
}
.foundry-close:hover { background: rgba(120,170,230,.12); color: #dcecff; }
.foundry-body { display: flex; gap: 18px; min-height: 0; flex: 1 1 auto; }
.foundry-stage {
    flex: 1 1 auto; min-width: 0; display: flex; align-items: center; justify-content: center;
    background: repeating-conic-gradient(rgba(255,255,255,.018) 0% 25%, transparent 0% 50%) 50% / 22px 22px;
    border: none; border-radius: 0; min-height: 0; position: relative;
}
.foundry-stage img { max-width: 100%; max-height: 100%; display: block; border-radius: 0; }
.foundry-stage.mode3d { min-height: 0; }
.foundry-3d-host { position: absolute; inset: 0; }
.foundry-modes { position: absolute; top: 8px; right: 8px; display: flex; gap: 6px; z-index: 2; }
.foundry-modes button {
    background: rgba(8,18,30,.72); color: #a9d2f5; border: none;
    border-radius: 6px; padding: 5px 11px; font-size: 11px; cursor: pointer; backdrop-filter: blur(3px);
}
.foundry-modes button:hover:not(:disabled) { background: rgba(60,130,210,.5); color: #eaf6ff; }
.foundry-modes button.active { background: rgba(50,130,220,.55); color: #eaf6ff; }
.foundry-modes button:disabled { opacity: .35; cursor: default; }
.foundry-hint {
    position: absolute; bottom: 8px; left: 10px; font-size: 10.5px; opacity: .5;
    pointer-events: none; letter-spacing: .03em;
}
.foundry-empty { opacity: .5; font-size: 13px; padding: 40px; text-align: center; line-height: 1.6; }
.foundry-side { flex: 0 0 268px; display: flex; flex-direction: column; gap: 10px; overflow-y: auto; min-height: 0; }
.foundry-facts { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; font-size: 12px; }
.foundry-facts dt { opacity: .52; }
.foundry-facts dd { margin: 0; color: #dcecff; overflow-wrap: anywhere; }
.foundry-tag {
    display: inline-block; font-size: 10.5px; padding: 2px 8px; border-radius: 20px;
    border: 1px solid currentColor; letter-spacing: .05em; text-transform: uppercase;
}
.foundry-tag.ok { color: #6ee7a8; }
.foundry-tag.bad { color: #ff8f8f; }
.foundry-tag.warn { color: #ffca6e; }
.foundry-warn { font-size: 11.5px; color: #ffca6e; line-height: 1.5; }
.foundry-files { display: flex; flex-direction: column; gap: 5px; }
.foundry-file {
    display: flex; justify-content: space-between; gap: 8px; font-size: 11.5px;
    padding: 6px 9px; border: none; border-radius: 6px;
    cursor: pointer; background: rgba(255,255,255,.045);
}
.foundry-file:hover { background: rgba(120,180,250,.18); }
.foundry-strip { display: flex; gap: 7px; overflow-x: auto; padding: 2px 1px 4px; flex: 0 0 auto; }
.foundry-thumb {
    flex: 0 0 auto; width: 92px; cursor: pointer; border-radius: 6px; padding: 6px 7px;
    border: none; background: rgba(255,255,255,.05); font-size: 10.5px;
    line-height: 1.35; text-align: left; color: #a8c4de;
    /* The selected job is marked by a bar, not a box: it reads at a glance in
       a row of thumbs and adds no rectangle to a frameless panel. */
    border-bottom: 2px solid transparent;
}
.foundry-thumb:hover { background: rgba(120,180,250,.14); color: #dcecff; }
.foundry-thumb.active { background: rgba(120,180,250,.2); border-bottom-color: #57c8ff; color: #eaf6ff; }
.foundry-thumb .t-state { opacity: .55; }
.foundry-thumb.failed .t-state { color: #ff8f8f; opacity: 1; }
.foundry-nav { display: flex; gap: 8px; align-items: center; font-size: 11.5px; opacity: .75; flex: 0 0 auto; }
.foundry-nav button {
    background: rgba(255,255,255,.05); color: #9fc8ea; border: none;
    border-radius: 6px; padding: 4px 10px; cursor: pointer; font-size: 11.5px;
}
.foundry-nav button:hover:not(:disabled) { background: rgba(120,180,250,.18); color: #eaf6ff; }
.foundry-nav button:disabled { opacity: .28; cursor: default; }
`;

let jobs = [];
let index = 0;
let open = false;
let root = null;
let els = {};
/** 'image' shows the render Blender produced; '3d' orbits the exported mesh. */
let mode = 'image';
let viewer3d = null;
let wireframe = false;
/* Images are fetched one at a time and kept, because flicking back and forth
   through a session's renders should not re-cross IPC for pictures already
   seen. Bounded by the job count, which is bounded by the listing limit. */
const imageCache = new Map();

function api() { return window.electronAPI; }

function build() {
    if (root) return;

    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    root = document.createElement('div');
    root.className = 'foundry-overlay';
    root.innerHTML = `
        <div class="foundry-shell" role="dialog" aria-label="Foundry viewer">
            <div class="foundry-head">
                <span class="foundry-title">Foundry</span>
                <span class="foundry-sub" data-el="sub"></span>
                <button class="foundry-close" data-el="close">Close &nbsp;Esc</button>
            </div>
            <div class="foundry-body">
                <div class="foundry-stage" data-el="stage">
                    <div class="foundry-empty" data-el="empty">Nothing built yet.</div>
                </div>
                <div class="foundry-side">
                    <dl class="foundry-facts" data-el="facts"></dl>
                    <div class="foundry-warn" data-el="warn"></div>
                    <div class="foundry-files" data-el="files"></div>
                </div>
            </div>
            <div class="foundry-nav">
                <button data-el="prev">&#8592; Newer</button>
                <button data-el="next">Older &#8594;</button>
                <span data-el="count"></span>
            </div>
            <div class="foundry-strip" data-el="strip"></div>
        </div>`;
    document.body.appendChild(root);

    for (const node of root.querySelectorAll('[data-el]')) els[node.dataset.el] = node;

    els.close.addEventListener('click', close);
    els.prev.addEventListener('click', () => step(-1));
    els.next.addEventListener('click', () => step(1));

    /* Click the backdrop to dismiss, but not a click that started inside the
       shell — otherwise a drag-select over the facts closes the panel. */
    root.addEventListener('mousedown', (e) => { if (e.target === root) close(); });

    document.addEventListener('keydown', (e) => {
        if (!open) return;
        if (e.key === 'Escape') { e.preventDefault(); close(); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
    });

    /* LIVE. A build finishing while the panel is open moves it to that job.
       Without this the viewer shows a stale render and looks broken in the one
       moment the user is most likely to be watching it. */
    api()?.onFoundryJobComplete?.(async (payload) => {
        await refresh({ selectJobId: payload?.jobId });
    });
}

function fact(label, value) {
    return value === null || value === undefined || value === '' ? '' : `<dt>${label}</dt><dd>${value}</dd>`;
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderFacts(job) {
    const stateTag = job.state === 'done'
        ? '<span class="foundry-tag ok">rendered</span>'
        : job.state === 'failed'
            ? '<span class="foundry-tag bad">failed</span>'
            : '<span class="foundry-tag warn">incomplete</span>';

    const print = job.printability
        ? (job.printability.watertight
            ? '<span class="foundry-tag ok">watertight</span>'
            : '<span class="foundry-tag warn">not watertight</span>')
        : null;

    els.facts.innerHTML = [
        fact('state', stateTag),
        fact('name', escapeHtml(job.name)),
        fact('objects', job.objects.length ? escapeHtml(job.objects.join(', ')) : null),
        fact('polygons', job.polygons?.toLocaleString?.() ?? job.polygons),
        fact('engine', job.engine === 'BLENDER_EEVEE' ? 'EEVEE' : escapeHtml(job.engine ?? '')),
        fact('device', escapeHtml(job.device ?? '')),
        fact('resolution', job.resolution ? `${job.resolution[0]}x${job.resolution[1]}` : null),
        fact('took', job.seconds !== null ? `${job.seconds}s` : null),
        fact('printable', print),
        fact('error', job.error ? `<span style="color:#ff8f8f">${escapeHtml(job.error)}</span>` : null),
        fact('failed at', job.state === 'failed' ? escapeHtml(job.stage ?? '') : null)
    ].join('');

    /* Non-watertight is actionable, so it says WHY rather than just flagging. */
    const bad = job.printability?.meshes?.filter((m) => !m.printable) ?? [];
    const warnings = [...(job.warnings ?? [])];
    for (const m of bad) {
        warnings.push(`${m.name}: ${m.non_manifold_edges} non-manifold edges, ${m.loose_edges} loose edges — a slicer cannot close this`);
    }
    els.warn.innerHTML = warnings.map((w) => `&#9888; ${escapeHtml(w)}`).join('<br>');

    const files = [];
    if (job.image) files.push({ label: 'render.png', path: job.image });
    for (const e of job.exports ?? []) {
        files.push({ label: `${e.format.toUpperCase()} · ${Math.round((e.bytes ?? 0) / 1024)} KB`, path: e.path });
    }
    files.push({ label: 'spec.json + job.py', path: job.dir });

    els.files.innerHTML = files
        .map((f, i) => `<div class="foundry-file" data-path-index="${i}"><span>${escapeHtml(f.label)}</span><span>&#8599;</span></div>`)
        .join('');
    for (const node of els.files.querySelectorAll('[data-path-index]')) {
        const target = files[Number(node.dataset.pathIndex)];
        node.addEventListener('click', () => api()?.revealInFolder?.(target.path));
    }
}

/* Tear the WebGL context down whenever the stage changes.

   Browsers cap live WebGL contexts (Chromium at 16) and drop the OLDEST when
   the cap is hit — so leaking one per job you click through does not fail
   loudly, it silently blanks a viewer you opened earlier. Disposing on every
   transition keeps exactly one alive. */
function teardown3d() {
    if (!viewer3d) return;
    try { viewer3d.dispose(); } catch { /* a lost context disposes noisily; not fatal */ }
    viewer3d = null;
}

function modeBar(job, active) {
    return `
        <div class="foundry-modes">
            <button data-mode="image" class="${active === 'image' ? 'active' : ''}" ${job.hasImage ? '' : 'disabled'}>Render</button>
            <button data-mode="3d" class="${active === '3d' ? 'active' : ''}">3D</button>
            ${active === '3d' ? '<button data-act="reset">Recentre</button><button data-act="wire">Wireframe</button>' : ''}
        </div>`;
}

async function renderStage(job) {
    teardown3d();
    els.stage.classList.toggle('mode3d', mode === '3d');

    if (mode === '3d') return renderStage3d(job);

    if (!job.hasImage) {
        els.stage.innerHTML = `<div class="foundry-empty">${job.state === 'failed'
            ? 'This job produced no image.<br>The failure is in the panel on the right.'
            : 'This job is still running, or was interrupted before it rendered.'}</div>${modeBar(job, 'image')}`;
        bindModeBar(job);
        return;
    }

    let dataUrl = imageCache.get(job.jobId);
    if (!dataUrl) {
        els.stage.innerHTML = '<div class="foundry-empty">Loading render…</div>';
        const res = await api()?.foundryImage?.(job.jobId);
        if (!res?.ok) {
            els.stage.innerHTML = `<div class="foundry-empty">${escapeHtml(res?.error || 'the image could not be read')}</div>`;
            return;
        }
        dataUrl = res.dataUrl;
        imageCache.set(job.jobId, dataUrl);
    }

    els.stage.innerHTML = '';
    const img = document.createElement('img');
    img.src = dataUrl;
    img.alt = `${job.name} render`;
    /* Clicking the render opens the model — that is the gesture asked for.
       Opening the PNG in Explorer moved to the file list on the right, where a
       click means "open this file" and nothing else. */
    img.title = 'Click to orbit this model in 3D';
    img.style.cursor = 'pointer';
    img.addEventListener('click', () => setMode('3d'));
    els.stage.appendChild(img);

    els.stage.insertAdjacentHTML('beforeend', modeBar(job, 'image'));
    els.stage.insertAdjacentHTML('beforeend', '<div class="foundry-hint">Click the render to open it in 3D</div>');
    bindModeBar(job);
}

async function renderStage3d(job) {
    els.stage.innerHTML = `<div class="foundry-empty">Loading mesh…</div>${modeBar(job, '3d')}`;
    bindModeBar(job);

    const res = await api()?.foundryMesh?.(job.jobId);
    if (!res?.ok) {
        /* Jobs built before GLB export became automatic have no mesh. The spec
           is still on disk, so the fix is offered rather than described. */
        const rebuild = res?.canRebuild
            ? '<br><br><button data-act="rebuild" style="background:rgba(50,130,220,.35);color:#eaf6ff;border:1px solid #57c8ff;border-radius:7px;padding:7px 14px;cursor:pointer;font-size:12px">Rebuild it for 3D</button>'
            : '';
        els.stage.innerHTML = `<div class="foundry-empty">${escapeHtml(res?.error || 'no mesh')}${rebuild}</div>${modeBar(job, '3d')}`;
        bindModeBar(job);
        return;
    }

    let host = document.createElement('div');
    host.className = 'foundry-3d-host';
    els.stage.innerHTML = '';
    els.stage.appendChild(host);
    els.stage.insertAdjacentHTML('beforeend', modeBar(job, '3d'));
    els.stage.insertAdjacentHTML('beforeend', '<div class="foundry-hint">Drag to orbit · scroll to zoom · right-drag to pan</div>');
    bindModeBar(job);

    try {
        /* Dynamic import: three.js is ~700 KB and most sessions never open a
           model, so it stays out of the startup path and Vite gives it its own
           chunk. Cached by the module system after the first open. */
        const { createViewer } = await import('./foundryViewer3d.js');
        viewer3d = createViewer(host);
        const info = await viewer3d.load(res.base64);

        if (info.empty) {
            els.stage.insertAdjacentHTML('beforeend',
                '<div class="foundry-empty" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center">The mesh loaded but contains no visible geometry.</div>');
        }
        els.sub.textContent = `${new Date(job.mtime).toLocaleString()} · ${info.triangles.toLocaleString()} triangles, ${Math.round(res.bytes / 1024)} KB`;
    } catch (e) {
        teardown3d();
        els.stage.innerHTML = `<div class="foundry-empty">The 3D view failed to start.<br>${escapeHtml(e.message)}</div>${modeBar(job, 'image')}`;
        bindModeBar(job);
    }
}

function bindModeBar(job) {
    for (const btn of els.stage.querySelectorAll('[data-mode]')) {
        btn.addEventListener('click', () => setMode(btn.dataset.mode));
    }
    for (const btn of els.stage.querySelectorAll('[data-act]')) {
        btn.addEventListener('click', async () => {
            const act = btn.dataset.act;
            if (act === 'reset') viewer3d?.resetView();
            else if (act === 'wire') { wireframe = !wireframe; viewer3d?.setWireframe(wireframe); btn.classList.toggle('active', wireframe); }
            else if (act === 'rebuild') {
                btn.disabled = true;
                btn.textContent = 'Rebuilding… this runs Blender again';
                const out = await api()?.foundryRebuild?.(job.jobId);
                if (out?.ok) await refresh({ selectJobId: out.jobId });
                else {
                    els.stage.innerHTML = `<div class="foundry-empty">The rebuild failed.<br>${escapeHtml(out?.error || 'unknown error')}</div>`;
                }
            }
        });
    }
}

function setMode(next) {
    mode = next;
    wireframe = false;
    paint();
}

function renderStrip() {
    els.strip.innerHTML = jobs.map((j, i) => `
        <div class="foundry-thumb ${i === index ? 'active' : ''} ${j.state === 'failed' ? 'failed' : ''}" data-i="${i}">
            <div>${escapeHtml(String(j.name).slice(0, 14))}</div>
            <div class="t-state">${j.state === 'done' ? `${j.polygons ?? '?'} tris` : j.state}</div>
        </div>`).join('');
    for (const node of els.strip.querySelectorAll('[data-i]')) {
        node.addEventListener('click', () => select(Number(node.dataset.i)));
    }
}

async function paint() {
    const job = jobs[index];
    if (!job) {
        els.sub.textContent = '';
        els.facts.innerHTML = '';
        els.warn.textContent = '';
        els.files.innerHTML = '';
        els.strip.innerHTML = '';
        els.count.textContent = '';
        els.stage.innerHTML = '<div class="foundry-empty">Nothing built yet.<br>Say “model me a phone stand” to start.</div>';
        els.prev.disabled = els.next.disabled = true;
        return;
    }

    els.sub.textContent = new Date(job.mtime).toLocaleString();
    els.count.textContent = `${index + 1} of ${jobs.length}`;
    els.prev.disabled = index === 0;
    els.next.disabled = index >= jobs.length - 1;

    renderFacts(job);
    renderStrip();
    await renderStage(job);
}

function select(i) {
    if (i < 0 || i >= jobs.length) return;
    index = i;
    paint();
}

function step(delta) { select(index + delta); }

/**
 * Reload the listing.
 * @param {{selectJobId?:string, which?:object}} [opts]
 */
async function refresh({ selectJobId = null, which = null } = {}) {
    build();
    const res = await api()?.foundryJobs?.(which ? { which } : undefined);
    jobs = res?.jobs ?? [];

    if (selectJobId) {
        const i = jobs.findIndex((j) => j.jobId === selectJobId);
        index = i >= 0 ? i : 0;
    } else if (res?.selected) {
        const i = jobs.findIndex((j) => j.jobId === res.selected);
        index = i >= 0 ? i : 0;
    } else {
        index = 0;
    }

    await paint();
    return { count: jobs.length, job: jobs[index] ?? null, reason: res?.reason ?? null };
}

async function openViewer(which = null) {
    build();
    const info = await refresh({ which });
    root.classList.add('open');
    open = true;
    return info;
}

function close() {
    if (!root) return;
    /* Release the GPU context on close, not just on job change. An idle WebGL
       context holds VRAM that Ollama needs for the model that plans the next
       scene, and this card has 4 GB total. */
    teardown3d();
    mode = 'image';
    root.classList.remove('open');
    open = false;
}

/* Exposed the way jarvisMirror is, so the voice router reaches it without
   importing this module. */
window.jarvisFoundry = {
    open: openViewer,
    close,
    isOpen: () => open,
    refresh,
    current: () => jobs[index] ?? null,
    toggle: (which) => (open ? close() : openViewer(which))
};
