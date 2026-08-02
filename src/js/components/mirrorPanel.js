// Live Android screen mirror panel.
//
// Decodes the encoded video the main process forwards, draws it with the GPU,
// and relays pointer and keyboard input back to the phone.
//
// WHY THE DECODE IS HERE AND NOT IN THE MAIN PROCESS
// --------------------------------------------------
// WebCodecs is a renderer API, and it hands decoded frames to WebGL without
// them ever entering JavaScript memory. Decoding in the main process would
// mean moving raw frames across IPC — 1920*1080*4 bytes at 60 fps is about
// 500 MB/s — to draw the same picture. What crosses IPC instead is the
// compressed elementary stream, roughly 1 MB/s.
//
// WHAT "LATENCY" MEANS ON THE OVERLAY
// -----------------------------------
// Glass-to-glass latency cannot be measured from inside this process: the
// device's capture clock and the host's clock have no shared origin, so their
// difference is an unknown constant. What IS measurable is how that difference
// MOVES. The badge shows arrival delay above the best value observed this
// session — queueing on top of the fastest path actually seen. It is a real
// measurement of buffering, and it is not the end-to-end number; the label
// says LAG rather than latency for that reason.

import {
    WebCodecsVideoDecoder,
    WebGLVideoFrameRenderer,
    BitmapVideoFrameRenderer
} from '@yume-chan/scrcpy-decoder-webcodecs';
import { ScrcpyVideoCodecId } from '@yume-chan/scrcpy';
import { Int16PcmPlayer } from '@yume-chan/pcm-player';
import {
    mapPointerToDevice,
    webKeyToAndroid,
    metaStateFrom,
    isTextKey,
    buildMirrorOptions,
    createPreroll,
    describeScale,
    panelBoxFor,
    virtualFingerPoint,
    pinchPoints,
    nextPinchSpread,
    PINCH_SPREAD
} from '../services/mirrorIntent.js';
import HapticManager from '../services/hapticManager.js';

const api = () => window.electronAPI?.mirror;

/* ---------- elements ---------- */

const panel = document.getElementById('mirror-panel');
const stage = document.getElementById('mirror-stage');
const statusEl = document.getElementById('mirror-status');
const titleEl = document.getElementById('mirror-title');
const fpsEl = document.getElementById('mirror-fps');
const lagEl = document.getElementById('mirror-lag');
const rateEl = document.getElementById('mirror-rate');
const linkEl = document.getElementById('mirror-link');
const closeBtn = document.getElementById('mirror-close');
const fullscreenBtn = document.getElementById('mirror-fullscreen');
const muteBtn = document.getElementById('mirror-mute');
const navBar = document.getElementById('mirror-nav');

/* ---------- session state ---------- */

let decoder = null;
let writer = null;
let canvas = null;
let usingBitmap = false;
let codecName = 'h264';

/* A stall repairs itself once, on the software path. STALLED means packets are
   arriving and nothing is being drawn, which is a decoder fault, not a device
   one — and the fix that works is rebuilding on the bitmap renderer. Bounded to
   a single attempt: if the second decoder is dead too the cause is not
   transient, and a rebuild loop would hide that behind a flicker. */
let recovering = false;
let recoveryUsed = false;

async function recoverDecoder(reason) {
    if (recovering || recoveryUsed || !open) return;
    recovering = true;
    recoveryUsed = true;
    console.warn(`[mirror] ${reason} — rebuilding the decoder on the software path`);
    setStatus('Recovering the video decoder…');

    try {
        if (writer) { try { writer.releaseLock(); } catch { /* already released */ } writer = null; }
        if (decoder) { try { decoder.dispose(); } catch { /* already gone */ } decoder = null; }

        decoder = createDecoder(codecName, true);   // force bitmap
        writer = decoder.writable.getWriter();

        /* The new decoder starts cold and cannot use mid-GOP frames, so ask the
           device for a fresh keyframe rather than waiting for its next one —
           on a static screen that could be a very long wait. */
        await api()?.input('action', { name: 'reset-video' });

        timing.stalledSamples = 0;
        timing.lastRendered = 0;
        setStatus('');
        resizePanel();
    } catch (e) {
        console.error('[mirror] decoder recovery failed:', e.message);
        setStatus(`Video decoder failed: ${e.message}`, 'err');
    } finally {
        recovering = false;
    }
}
let unsubscribeVideo = null;
let unsubscribeStatus = null;
let open = false;
let starting = false;

/* NO LATCH WITHOUT A TIMEOUT.
   `starting` guards against a double open, and it wedged the panel: it was
   cleared only on success or in the catch, so when `mirror.start()` never
   settled — a handshake left half-finished by a killed client — the flag stayed
   true for the life of the app. Every later attempt answered "a mirror session
   is already starting" and the panel sat on "Connecting to your phone…" with no
   way back except restarting Jarvis.

   Two rules now hold everywhere: the flag is cleared in a `finally`, so no exit
   path can skip it, and the await it guards is bounded, so it cannot wait
   forever in the first place. */
const OPEN_TIMEOUT_MS = 25000;

function withTimeout(promise, ms, message) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(message)), ms);
        promise.then(
            (v) => { clearTimeout(timer); resolve(v); },
            (e) => { clearTimeout(timer); reject(e); }
        );
    });
}

const frame = { width: 0, height: 0 };

/* Latency estimation. `minOffset` is the smallest (arrival − pts) seen this
   session and stands in for the unknown clock difference; anything above it is
   queueing we actually added. Reset per session because the device clock
   changes when the encoder restarts. */
const timing = {
    minOffset: Infinity, lagMs: 0,
    lastRendered: 0, lastSampleAt: 0, fps: 0,
    packetsSinceSample: 0, bytesSinceSample: 0, mbps: 0,
    stalledSamples: 0
};

let metricsTimer = null;

/* ---------- audio ---------- */

let audioPlayer = null;
let unsubscribeAudio = null;
let muted = false;
const audioStats = { chunks: 0, samples: 0 };

async function startAudio(meta) {
    if (!meta?.enabled) return;
    try {
        /* Int16, because scrcpy's raw audio is PCM s16le — the player is
           picked to match the wire format so nothing has to convert. */
        audioPlayer = new Int16PcmPlayer(meta.sampleRate || 48000, meta.channels || 2);
        await audioPlayer.start();
        unsubscribeAudio = api().onAudio((chunk) => {
            if (!audioPlayer || muted || !chunk?.data) return;
            try {
                const bytes = chunk.data;
                if (bytes.byteLength < 2) return;

                /* COPIED, not viewed. Two hazards, both avoided by one copy:
                   `new Int16Array(buffer, byteOffset, …)` THROWS if the offset
                   is odd, and IPC gives no alignment guarantee; and PcmPlayer
                   transfers the buffer when the view covers all of it, so
                   handing it a view onto a buffer we do not own risks
                   detaching memory something else is still reading. A fresh
                   buffer per chunk is ~190 KB/s of memcpy at 48 kHz stereo,
                   which is nothing next to a renderer crash. */
                const copy = bytes.slice();
                const samples = new Int16Array(copy.buffer, copy.byteOffset, copy.byteLength >> 1);

                audioStats.chunks++;
                audioStats.samples += samples.length;
                audioPlayer.feed(samples);
            } catch (e) {
                /* Audio must never take the picture down with it. */
                console.warn('[mirror] dropping an audio chunk:', e.message);
            }
        });
        console.log(`[mirror] audio ${meta.codec} ${meta.sampleRate}Hz x${meta.channels}`);
    } catch (e) {
        console.warn('[mirror] audio playback unavailable:', e.message);
        audioPlayer = null;
    }
}

async function stopAudio() {
    try { unsubscribeAudio?.(); } catch { /* already gone */ }
    unsubscribeAudio = null;
    if (audioPlayer) {
        try { await audioPlayer.stop(); } catch { /* already stopped */ }
        audioPlayer = null;
    }
    audioStats.chunks = 0;
    audioStats.samples = 0;
}

export function setMirrorMuted(on) {
    muted = Boolean(on);
    if (muteBtn) {
        muteBtn.textContent = muted ? '\u{1F507}' : '\u{1F50A}';
        muteBtn.title = muted ? 'Unmute phone audio' : 'Mute phone audio';
    }
    return muted;
}

/* ---------- status line ---------- */

function setStatus(text, kind = '') {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.className = kind;
    // A blank status is invisible rather than an empty bar taking up room.
    statusEl.style.display = text ? '' : 'none';
}

/* Each badge takes a finished string, or null to hide it. A badge that reads
   "0 MS LAG" while nothing is being drawn is a number about nothing. */
function setBadge(el, text, kind = '') {
    if (!el || text === undefined) return;
    el.textContent = text ?? '';
    el.style.display = text ? '' : 'none';
    el.className = `mirror-badge${kind ? ' ' + kind : ''}`;
}

function setBadges({ fps, fpsKind, lag, rate, link } = {}) {
    setBadge(fpsEl, fps, fpsKind);
    setBadge(lagEl, lag);
    setBadge(rateEl, rate);
    setBadge(linkEl, link);
}

/* ---------- decoder ---------- */

function codecIdFromName(name) {
    const key = String(name || 'h264').toUpperCase();
    return ScrcpyVideoCodecId[key] ?? ScrcpyVideoCodecId.H264;
}

function createDecoder(codecName, forceBitmap = false) {
    /* WebGL first. The bitmap path goes through createImageBitmap and a 2D
       context, which is a second full copy of every frame; WebGL uploads the
       VideoFrame as a texture directly. Falling back rather than failing
       because a machine with a blocklisted GPU still deserves a picture.

       CONSTRUCTION IS TRIED, NOT ASSUMED. `isSupported` only reports what the
       browser advertises, and the GPU process can die independently — this
       machine's log has `GPU process exited unexpectedly: exit_code=34`. After
       that, the capability check still says yes and the constructor throws, so
       the check alone would take the whole session down with it. */
    let renderer = null;
    if (WebGLVideoFrameRenderer.isSupported && !forceBitmap) {
        try {
            const candidate = new WebGLVideoFrameRenderer();
            /* VERIFY THE CONTEXT IS ALIVE, do not assume it.
               A GPU process that crashed moments earlier hands back a context
               that is lost from birth — and because it never worked, it never
               fires `webglcontextlost`. That is the black panel seen in use:
               the log had `GPU process exited unexpectedly: exit_code=34`,
               decode ran, draw silently did nothing, and the badge sat on
               STALLED. `isContextLost()` catches it in one call. */
            const gl = candidate.canvas.getContext('webgl2') || candidate.canvas.getContext('webgl');
            if (gl && !gl.isContextLost()) {
                renderer = candidate;
            } else {
                console.warn('[mirror] WebGL context is dead on arrival — using the bitmap renderer');
            }
        } catch (e) {
            console.warn('[mirror] WebGL renderer unavailable, falling back to bitmap:', e.message);
        }
    }
    if (!renderer) renderer = new BitmapVideoFrameRenderer();
    usingBitmap = !(renderer instanceof WebGLVideoFrameRenderer);

    const dec = new WebCodecsVideoDecoder({
        codec: codecIdFromName(codecName),
        renderer,
        /* "prefer-hardware", not "require": a hardware decoder is the point —
           it is what keeps decode off the main thread and under a frame — but
           a machine without one should degrade, not go black. Which one was
           actually used is reported in the console at first frame. */
        hardwareAcceleration: 'prefer-hardware'
    });

    canvas = renderer.canvas;
    canvas.id = 'mirror-canvas';
    canvas.tabIndex = 0;                      // focusable, so it can take keys
    stage.replaceChildren(canvas);

    /* A GPU process restart takes the WebGL context with it. Without this the
       canvas simply stops updating and the badge reads STALLED forever with no
       explanation — say what happened and how to get the picture back. */
    canvas.addEventListener('webglcontextlost', (e) => {
        e.preventDefault();
        console.warn('[mirror] WebGL context lost — the GPU process restarted');
        setStatus('Graphics driver restarted — reopen the mirror', 'err');
    }, { once: true });

    dec.sizeChanged?.(({ width, height }) => {
        frame.width = width;
        frame.height = height;
        /* Re-size HERE, not only at open(). The canvas has no real dimensions
           until the first frame has been decoded, so a trim run during the
           handshake measures a 300x150 placeholder and leaves the bars it was
           meant to remove. This event is the first moment the geometry is
           knowable — and it fires again on rotation. */
        resizePanel();
    });

    return dec;
}

/* ---------- video pump ---------- */

/* Packets that arrive before the decoder exists. The subscription is opened
   BEFORE start(), because scrcpy's configuration packet lands during the
   handshake and losing it means every frame after it is rejected — see
   createPreroll() for the measurement that found this. */
const preroll = createPreroll();

function flushPreroll() {
    for (const p of preroll.drain()) handlePacket(p);
}

function handlePacket(packet) {
    if (!writer) { preroll.push(packet); return; }

    if (packet.type === 'data') {
        timing.packetsSinceSample++;
        timing.bytesSinceSample += packet.data?.byteLength || 0;
    }

    if (packet.type === 'data' && typeof packet.pts === 'number') {
        const arrival = performance.now();
        const ptsMs = packet.pts / 1000;
        const offset = arrival - ptsMs;
        if (offset < timing.minOffset) timing.minOffset = offset;
        timing.lagMs = Math.max(0, Math.round(offset - timing.minOffset));
    }

    /* Fire-and-forget. Awaiting the write would serialise the IPC callback
       against decode backpressure and turn a momentary GPU stall into a
       growing queue of pending IPC messages; the decoder already drops frames
       it cannot keep up with, and that is the correct behaviour for a live
       mirror — a late frame has no value. */
    writer.write(packet).catch((e) => {
        if (open) console.warn('[mirror] decode write failed:', e?.message || e);
    });
}

function startMetrics() {
    stopMetrics();
    timing.lastRendered = 0;
    timing.lastSampleAt = performance.now();
    timing.packetsSinceSample = 0;
    timing.bytesSinceSample = 0;
    timing.stalledSamples = 0;

    metricsTimer = setInterval(() => {
        if (!decoder) return;
        const now = performance.now();
        const rendered = decoder.framesRendered;
        const dt = (now - timing.lastSampleAt) / 1000;
        const renderedDelta = rendered - timing.lastRendered;
        if (dt > 0) {
            timing.fps = Math.round(renderedDelta / dt);
            timing.mbps = (timing.bytesSinceSample * 8) / dt / 1e6;
        }

        /* "0 FPS" IS TRUE AND READS AS BROKEN.
           scrcpy only encodes when the screen changes, so a phone sitting on a
           static launcher legitimately renders nothing — and a mirror showing
           a perfect picture next to a 0 was reported as a bug. But zero also
           happens when the decoder has stopped consuming, which is what the
           black-canvas failure looked like. The two are distinguishable and
           must be distinguished, because they need opposite reactions:

             packets arriving + nothing rendered  -> STALLED  (real fault)
             no packets + nothing rendered        -> IDLE     (nothing to draw)

           Counting arriving packets INSTEAD of rendered frames — the obvious
           "fix" — would have reported a healthy 60 fps through the entire
           black-canvas bug. */
        /* TWO CONSECUTIVE SAMPLES, not one. The very first sample after open
           legitimately has packets buffered and no frame presented yet — the
           first keyframe is still being decoded — and a one-shot test showed
           STALLED for a second on every healthy start. A warning that cries
           wolf on every launch is a warning nobody reads. */
        const looksStalled = renderedDelta === 0 && timing.packetsSinceSample > 2;
        timing.stalledSamples = looksStalled ? timing.stalledSamples + 1 : 0;

        const stalled = timing.stalledSamples >= 2;
        const idle = renderedDelta === 0 && !stalled;

        // A stall is a fault to fix, not just a label to show.
        if (stalled) recoverDecoder('frames are arriving but nothing is rendering');

        setBadges({
            fps: stalled ? (recoveryUsed ? 'STALLED' : 'RECOVERING') : idle ? 'IDLE' : `${timing.fps} FPS`,
            fpsKind: stalled ? 'warn' : '',
            lag: idle ? null : `${timing.lagMs} MS LAG`,
            rate: timing.mbps >= 0.01 ? `${timing.mbps.toFixed(1)} MBPS` : null
        });

        timing.lastRendered = rendered;
        timing.lastSampleAt = now;
        timing.packetsSinceSample = 0;
        timing.bytesSinceSample = 0;
    }, 1000);
}

function stopMetrics() {
    if (metricsTimer) clearInterval(metricsTimer);
    metricsTimer = null;
}

/* ---------- lifecycle ---------- */

/**
 * Opens the panel and starts a session.
 * @param {{serial?: string, settings?: object}} [opts]
 * @returns {Promise<{ok: boolean, error?: string, status?: object}>}
 */
export async function openMirror(opts = {}) {
    if (!api()) {
        return { ok: false, error: 'the mirror is only available inside the Jarvis desktop app' };
    }
    if (starting) return { ok: false, error: 'a mirror session is already starting' };
    if (open) return { ok: true, status: null };

    if (!WebCodecsVideoDecoder.isSupported) {
        return { ok: false, error: 'this build has no WebCodecs video decoder' };
    }

    starting = true;
    panel?.classList.add('visible');
    setStatus('Connecting to your phone…');
    setBadges({ fps: 0, lag: 0, link: '' });
    timing.minOffset = Infinity;
    timing.lagMs = 0;

    try {
        const scrcpyOptions = buildMirrorOptions(opts.settings || {});

        /* Subscribed FIRST, decoder built second. See the note above
           queuePacket: the configuration packet arrives before start() has
           returned, and without a listener in place it is simply lost. */
        preroll.clear();
        unsubscribeVideo = api().onVideo(handlePacket);
        unsubscribeStatus = api().onStatus?.((_e, s) => applyStatus(s));

        /* The decoder itself is built AFTER the session reports its codec: the
           device chooses the encoder, and a decoder configured for h264
           silently produces nothing when the phone hands back h265. */
        const res = await withTimeout(
            api().start({ serial: opts.serial, scrcpyOptions }),
            OPEN_TIMEOUT_MS,
            'the phone did not finish connecting within 25 seconds'
        );
        if (!res?.ok) throw new Error(res?.error || 'the mirror failed to start');

        const st = res.status || {};
        frame.width = st.width || 0;
        frame.height = st.height || 0;

        codecName = st.codec || 'h264';
        recoveryUsed = false;
        decoder = createDecoder(codecName);
        writer = decoder.writable.getWriter();
        flushPreroll();

        await startAudio(st.audio);

        open = true;

        titleEl && (titleEl.textContent = st.model || st.serial || 'Android');

        /* The size is reported against the device's OWN panel, so "native" is a
           comparison rather than a claim. When the device did not answer
           `wm size` the label falls back to the bare dimensions — unknown, not
           assumed native. */
        const scale = describeScale({ width: st.width, height: st.height }, st.native);
        setBadges({
            fps: 'IDLE',
            lag: null,
            rate: null,
            link: `${(st.connection || '').toUpperCase()} · ${(st.codec || '').toUpperCase()} · ${scale.label}` +
                (st.audio?.enabled ? ' · AUDIO' : '')
        });
        // Hidden when the device gave no audio, rather than offering a mute
        // button for a stream that does not exist.
        if (muteBtn) muteBtn.style.display = st.audio?.enabled ? '' : 'none';
        setMirrorMuted(false);
        setStatus('');
        resizePanel();
        startMetrics();
        canvas?.focus();

        console.log(`[mirror] ${st.width}x${st.height} ${st.codec} from ${st.model || st.serial}` +
            (st.startMs != null ? `, handshake ${st.startMs}ms` : '') +
            (st.firstFrameMs != null ? `, first frame ${st.firstFrameMs}ms` : '') +
            // The renderer actually built, not the one that was available.
            `, renderer ${usingBitmap ? 'bitmap' : 'webgl'}`);

        return { ok: true, status: st };
    } catch (e) {
        const error = e?.message || String(e);
        setStatus(error, 'err');
        /* Tear down BOTH sides. A timeout here means the main process may still
           believe it is starting, and leaving it that way reproduces the wedge
           one layer down — its own `isActive()` covers 'starting', so the next
           attempt would be refused there instead. */
        await teardown();
        panel?.classList.remove('visible');
        return { ok: false, error };
    } finally {
        // The one place this is cleared. No success path, no error path, and no
        // early return can leave it latched.
        starting = false;
    }
}

/** Closes the panel and stops the session. Safe to call when already closed. */
export async function closeMirror() {
    if (!open && !starting) {
        panel?.classList.remove('visible');
        return;
    }
    setStatus('Disconnecting…');
    await teardown();
    setMirrorFullscreen(false);      // never reopen into a fullscreen ghost
    panel?.classList.remove('visible');
    clearPanelBox();
    setStatus('');
}

async function teardown() {
    open = false;
    /* Cleared here too, not only in openMirror's `finally`. Teardown is the
       recovery path — "close the mirror" has to work when the session is stuck
       half-open, and it could not while this stayed true. */
    starting = false;
    stopMetrics();
    endPinch();
    virtualFingerDown = false;
    preroll.clear();
    await stopAudio();

    try { unsubscribeVideo?.(); } catch { /* already gone */ }
    try { unsubscribeStatus?.(); } catch { /* already gone */ }
    unsubscribeVideo = unsubscribeStatus = null;

    if (writer) {
        // releaseLock, not close: closing the writable tells the decoder the
        // stream ended normally and it waits to flush. The session is over.
        try { writer.releaseLock(); } catch { /* already released */ }
        writer = null;
    }
    if (decoder) {
        try { decoder.dispose(); } catch { /* already disposed */ }
        decoder = null;
    }
    canvas = null;
    stage?.replaceChildren();

    try { await api()?.stop(); } catch { /* the main process may already have stopped */ }
}

/** Status pushed from the main process — an error there ends the session here. */
function applyStatus(s) {
    if (!s) return;
    if (s.status === 'error') {
        setStatus(s.error || 'the mirror stopped', 'err');
        teardown();
        return;
    }
    if (s.width && s.height) {
        const changed = s.width !== frame.width || s.height !== frame.height;
        frame.width = s.width;
        frame.height = s.height;
        /* A rotation restarts the encoder at a new size, which flips the panel
           from portrait to landscape shape. Without this the picture keeps its
           old box and letterboxes inside it until the session restarts. */
        if (changed) {
            resizePanel();
            const scale = describeScale({ width: s.width, height: s.height }, s.native);
            if (scale.label) setBadge(linkEl, `${(s.connection || '').toUpperCase()} · ${(s.codec || '').toUpperCase()} · ${scale.label}`);
        }
    }
}

export function isMirrorOpen() {
    return open;
}

/* ---------- geometry ---------- */

let fullscreen = false;

/**
 * Sizes the panel so the picture fills it instead of sitting inside letterbox
 * bars. On a 20:9 phone in the old fixed 420px panel the bars were most of the
 * width — the mirror was smaller than the box holding it.
 *
 * In fullscreen the panel is the window, so only the stage letterboxes and the
 * inline width is removed rather than fought with.
 */
/* How much of the window the mirror may occupy. Not the full width: the orb
   behind it is the app, and a mirror that covers everything is what fullscreen
   is for. Height is unrestricted because a portrait phone at full height is
   still narrow. */
const MAX_WIDTH_FRACTION = 0.92;

function clearPanelBox() {
    if (!panel) return;
    panel.style.width = '';
    panel.style.height = '';
    panel.style.top = '';
}

/**
 * Fits the panel to the phone, in both axes.
 *
 * The chrome is measured rather than assumed so this is correct whether the
 * panel is frameless (header and nav absolutely positioned, so the stage is
 * the whole panel) or an inset card with real borders.
 */
function resizePanel() {
    if (!panel || !stage) return;
    if (fullscreen || !open) { clearPanelBox(); return; }
    if (!frame.width || !frame.height) return;

    const pr = panel.getBoundingClientRect();
    const sr = stage.getBoundingClientRect();
    const chromeW = Math.max(0, pr.width - sr.width);
    const chromeH = Math.max(0, pr.height - sr.height);

    const box = panelBoxFor({
        frameWidth: frame.width,
        frameHeight: frame.height,
        availableWidth: window.innerWidth * MAX_WIDTH_FRACTION - chromeW,
        availableHeight: window.innerHeight - chromeH
    });
    if (!box) return;

    const width = Math.round(box.width + chromeW);
    const height = Math.round(box.height + chromeH);

    panel.style.width = `${width}px`;
    panel.style.height = `${height}px`;
    /* Vertically centred by an explicit `top` rather than a transform: the
       transform is already carrying the slide-in animation, and stacking a
       translateY on it would fight that transition. */
    panel.style.top = `${Math.max(0, Math.round((window.innerHeight - height) / 2))}px`;
}

export function setMirrorFullscreen(on) {
    fullscreen = Boolean(on);
    panel?.classList.toggle('fullscreen', fullscreen);
    if (fullscreenBtn) {
        fullscreenBtn.textContent = fullscreen ? '⤡' : '⤢';
        fullscreenBtn.title = fullscreen ? 'Exit fullscreen (F11)' : 'Fullscreen (F11)';
    }
    resizePanel();
    canvas?.focus();
}

export function toggleMirrorFullscreen() {
    setMirrorFullscreen(!fullscreen);
}

/* A window resize changes the height the picture can use, so the width that
   matches its aspect ratio changes with it. */
window.addEventListener('resize', () => { if (open) resizePanel(); });

/**
 * Captures the current frame.
 * @returns {Promise<string|null>} a PNG data URL, or null when nothing is up.
 */
export async function snapshotMirror() {
    if (!decoder || !open) return null;
    const blob = await decoder.snapshot();
    if (!blob) return null;
    return await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(String(reader.result));
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(blob);
    });
}

/* ---------- pointer relay ---------- */

function deviceCoords(e) {
    if (!canvas) return null;
    return mapPointerToDevice({
        clientX: e.clientX,
        clientY: e.clientY,
        rect: canvas.getBoundingClientRect(),
        videoWidth: frame.width,
        videoHeight: frame.height
    });
}

function send(kind, payload) {
    api()?.input(kind, payload).then((r) => {
        if (r && !r.ok) console.warn(`[mirror] ${kind} rejected:`, r.error);
    }).catch(() => { /* the session ended mid-gesture */ });
}

/* ---------- local cursor ----------

   A touch takes a real round trip: IPC, control socket, injection, the app's
   own response, encode, decode, draw. Even at the measured single-digit
   milliseconds there is a window where the user has clicked and nothing has
   visibly happened, and that window is what a mirror feels slow in.

   This paints the press LOCALLY, on the frame that handled the event, so the
   feedback is immediate and honest — it marks where you pressed, which is a
   fact this side already knows. It does not pretend the device has responded;
   the ripple fades on its own schedule and never reports success. */
function showCursor(clientX, clientY, kind = 'tap') {
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const dot = document.createElement('div');
    dot.className = `mirror-cursor ${kind}`;
    dot.style.left = `${clientX - rect.left}px`;
    dot.style.top = `${clientY - rect.top}px`;
    stage.appendChild(dot);
    // Self-removing so a long session cannot accumulate thousands of nodes.
    dot.addEventListener('animationend', () => dot.remove(), { once: true });
    setTimeout(() => dot.remove(), 1000);
}

/* Whether the drag in progress is carrying a virtual second finger. Held for
   the whole gesture: releasing Ctrl mid-drag must still lift the finger it put
   down, or the device is left believing two fingers are still touching. */
let virtualFingerDown = false;

function virtualFor(p, e) {
    return virtualFingerPoint({
        x: p.x, y: p.y,
        width: frame.width, height: frame.height,
        ctrl: e.ctrlKey, shift: e.shiftKey
    });
}

stage?.addEventListener('pointerdown', (e) => {
    if (!open || e.target !== canvas) return;
    const p = deviceCoords(e);
    // A press that starts on a letterbox bar is not a press on the phone.
    if (!p || !p.inside) return;
    e.preventDefault();
    canvas.focus();
    /* Pointer capture so a drag that leaves the panel still reports moves and
       still delivers its Up. Without it, dragging off the edge strands the
       device with a finger permanently down. */
    try { canvas.setPointerCapture(e.pointerId); } catch { /* not capturable */ }

    const v = virtualFor(p, e);
    showCursor(e.clientX, e.clientY, v ? 'pinch' : 'tap');
    /* The ripple marks WHERE; this marks THAT. Together they close the gap the
       round trip opens — see the showCursor note above. Audio only: the ripple
       is already the positioned visual, so `mirror-tap` carries no css channel
       and cannot double it. */
    HapticManager.mirrorTap();
    send('touch', { action: 'down', x: p.x, y: p.y, pressure: 1, pointerId: 'mouse' });
    if (v) {
        virtualFingerDown = true;
        send('touch', { action: 'down', x: v.x, y: v.y, pressure: 1, pointerId: 'virtual-finger' });
    }
});

stage?.addEventListener('pointermove', (e) => {
    if (!open || !canvas?.hasPointerCapture?.(e.pointerId)) return;
    const p = deviceCoords(e);
    if (!p) return;
    e.preventDefault();
    send('touch', { action: 'move', x: p.x, y: p.y, pressure: 1, pointerId: 'mouse' });

    if (virtualFingerDown) {
        /* Recomputed from the CURRENT modifiers, so switching Ctrl to
           Ctrl+Shift mid-drag changes the axis being mirrored — matching
           scrcpy — while the finger itself stays down. */
        const v = virtualFor(p, e) || { x: frame.width - 1 - p.x, y: frame.height - 1 - p.y };
        send('touch', { action: 'move', x: v.x, y: v.y, pressure: 1, pointerId: 'virtual-finger' });
    }
});

function releasePointer(e) {
    if (!open || !canvas?.hasPointerCapture?.(e.pointerId)) return;
    const p = deviceCoords(e);
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    if (!p) return;
    e.preventDefault();
    send('touch', { action: 'up', x: p.x, y: p.y, pressure: 0, pointerId: 'mouse' });

    if (virtualFingerDown) {
        const v = virtualFor(p, e) || { x: frame.width - 1 - p.x, y: frame.height - 1 - p.y };
        send('touch', { action: 'up', x: v.x, y: v.y, pressure: 0, pointerId: 'virtual-finger' });
        virtualFingerDown = false;
    }
}

stage?.addEventListener('pointerup', releasePointer);
/* pointercancel matters: the browser fires it instead of pointerup when the
   window loses the pointer (an OS drag, a focus steal). Treating it as a
   release is what keeps the device from being stuck mid-gesture. */
stage?.addEventListener('pointercancel', releasePointer);

stage?.addEventListener('contextmenu', (e) => {
    if (!open || e.target !== canvas) return;
    // Right-click is BACK, matching scrcpy — and the browser menu over a live
    // mirror is never what was wanted.
    e.preventDefault();
    send('action', { name: 'back' });
});

/* ---------- trackpad pinch ----------

   A trackpad pinch reaches the page as a `wheel` event with ctrlKey set — the
   same shape browsers use for page zoom. Consuming it is not optional: left
   alone it zooms the JARVIS window rather than the phone.

   The gesture is continuous, so it is held open between events and closed by
   an idle timer; putting two fingers down and lifting them per wheel tick
   would read on the device as a burst of separate pinches. */
const pinch = { active: false, spread: PINCH_SPREAD.start, x: 0, y: 0, idle: null };

function endPinch() {
    if (!pinch.active) return;
    const pts = pinchPoints({
        centerX: pinch.x, centerY: pinch.y, spread: pinch.spread,
        width: frame.width, height: frame.height
    });
    send('touch', { action: 'up', x: pts.a.x, y: pts.a.y, pressure: 0, pointerId: 'finger' });
    send('touch', { action: 'up', x: pts.b.x, y: pts.b.y, pressure: 0, pointerId: 'virtual-finger' });
    pinch.active = false;
    clearTimeout(pinch.idle);
    pinch.idle = null;
}

stage?.addEventListener('wheel', (e) => {
    if (!open || e.target !== canvas) return;
    const p = deviceCoords(e);
    if (!p || !p.inside) return;
    e.preventDefault();

    if (e.ctrlKey) {
        if (!pinch.active) {
            pinch.active = true;
            pinch.spread = PINCH_SPREAD.start;
            pinch.x = p.x;
            pinch.y = p.y;
            const s = pinchPoints({ centerX: p.x, centerY: p.y, spread: pinch.spread, width: frame.width, height: frame.height });
            send('touch', { action: 'down', x: s.a.x, y: s.a.y, pressure: 1, pointerId: 'finger' });
            send('touch', { action: 'down', x: s.b.x, y: s.b.y, pressure: 1, pointerId: 'virtual-finger' });
            showCursor(e.clientX, e.clientY, 'pinch');
        }
        pinch.spread = nextPinchSpread(pinch.spread, e.deltaY);
        const pts = pinchPoints({
            centerX: pinch.x, centerY: pinch.y, spread: pinch.spread,
            width: frame.width, height: frame.height
        });
        send('touch', { action: 'move', x: pts.a.x, y: pts.a.y, pressure: 1, pointerId: 'finger' });
        send('touch', { action: 'move', x: pts.b.x, y: pts.b.y, pressure: 1, pointerId: 'virtual-finger' });

        clearTimeout(pinch.idle);
        pinch.idle = setTimeout(endPinch, 160);
        return;
    }

    // A plain scroll while a pinch is open ends it first.
    endPinch();
    /* deltaY is in pixels here and scrcpy wants a unit-ish value; one notch is
       ~100px in Chromium, so a notch becomes 1. Inverted because a positive
       deltaY means "content moves up", which on Android is a negative scroll. */
    send('scroll', {
        x: p.x,
        y: p.y,
        scrollX: -e.deltaX / 100,
        scrollY: -e.deltaY / 100
    });
}, { passive: false });

/* ---------- keyboard relay ---------- */

/* Only while the canvas has focus. Jarvis owns the keyboard otherwise — the
   command box, F2 for the HUD, space for push-to-talk — and a mirror that
   swallowed those would break the app around it. */
document.addEventListener('keydown', (e) => {
    if (!open || document.activeElement !== canvas) return;

    // Alt+Shift+M closes, so there is always a keyboard way out.
    if (e.altKey && e.shiftKey && e.code === 'KeyM') {
        e.preventDefault();
        e.stopPropagation();
        closeMirror();
        return;
    }

    /* F11 toggles fullscreen. Deliberately NOT double-tap-on-canvas, which
       reads as the obvious gesture but is a real Android one — double tap is
       wake, zoom, and "like" in different apps, and stealing it makes those
       unreachable through the mirror. */
    if (e.code === 'F11' || (e.altKey && e.shiftKey && e.code === 'KeyF')) {
        e.preventDefault();
        e.stopPropagation();
        toggleMirrorFullscreen();
        return;
    }

    e.preventDefault();
    e.stopPropagation();

    /* Printable characters go as TEXT, not as a keycode. A keycode replays a
       physical key and is resolved through the DEVICE's layout, so on a phone
       set to anything but the host layout the wrong character appears; text
       carries the character itself. */
    if (isTextKey(e) && !e.repeat) {
        send('text', { text: e.key });
        return;
    }

    const keyCode = webKeyToAndroid(e);
    if (keyCode === null) return;      // no Android equivalent — drop, never 0
    send('key', { action: 'down', keyCode, metaState: metaStateFrom(e), repeat: e.repeat ? 1 : 0 });
}, true);

document.addEventListener('keyup', (e) => {
    if (!open || document.activeElement !== canvas) return;
    e.preventDefault();
    e.stopPropagation();
    if (isTextKey(e)) return;          // text has no separate release
    const keyCode = webKeyToAndroid(e);
    if (keyCode === null) return;
    send('key', { action: 'up', keyCode, metaState: metaStateFrom(e) });
}, true);

/* ---------- chrome ---------- */

/* The panel chrome is the one place in the mirror where a click is handled
   locally and returns instantly, so it gets the full press feedback — unlike a
   touch on the canvas, which is a round trip and uses the positioned ripple. */
closeBtn?.addEventListener('click', () => { HapticManager.click(closeBtn); closeMirror(); });
fullscreenBtn?.addEventListener('click', () => {
    HapticManager.toggle(fullscreenBtn);
    toggleMirrorFullscreen();
});
muteBtn?.addEventListener('click', () => {
    HapticManager.toggle(muteBtn);
    setMirrorMuted(!muted);
    canvas?.focus();
});

navBar?.addEventListener('click', (e) => {
    const name = e.target?.dataset?.action;
    if (!open || !name) return;
    HapticManager.click(e.target);
    send('action', { name });
    canvas?.focus();
});

/* Exposed the same way the companion overlay is, so the voice router and any
   HUD button reach it without importing the module. */
window.jarvisMirror = {
    open: openMirror,
    close: closeMirror,
    isOpen: isMirrorOpen,
    snapshot: snapshotMirror,
    toggle: () => (isMirrorOpen() ? closeMirror() : openMirror()),
    fullscreen: setMirrorFullscreen,
    toggleFullscreen: toggleMirrorFullscreen,
    isFullscreen: () => fullscreen,
    mute: setMirrorMuted,
    isMuted: () => muted,
    audioStats: () => ({ ...audioStats, playing: Boolean(audioPlayer) })
};
