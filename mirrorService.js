/* =========================
   JARVIS SCREEN MIRROR SERVICE

   Live Android screen mirroring with interactive control, over the scrcpy
   protocol. Sits alongside adbService.js (Tier 3) and uses the same ADB
   transport, but talks the protocol directly rather than shelling out: the
   `adb` CLI can screenshot and screenrecord, it cannot stream.

   WHAT RUNS WHERE, AND WHY
   ------------------------
   The scrcpy session lives HERE, in the main process, because it needs a TCP
   socket to the local ADB server (127.0.0.1:5037) and the renderer cannot open
   one. Decoding lives in the RENDERER, because WebCodecs is a browser API and
   decoding in the main process would mean shipping raw RGBA frames — ~250 MB/s
   at 1080p60 — across IPC. What crosses the boundary is the ENCODED elementary
   stream: ~1 MB/s at the default 8 Mbps, one structured-clone memcpy per frame.

   NO AUDIO, DELIBERATELY
   ----------------------
   scrcpy can forward device audio and this machine can decode it. It is off
   because Jarvis runs an always-on microphone: phone audio played out of the
   speakers is heard, transcribed, and fed back in as a user turn. That is the
   same self-echo class already fixed twice in this project (the "[n]" citation
   loop and the bare-numeric price echo), and enabling it here would reopen it.
   `buildMirrorOptions` hard-codes `audio: false` and ignores any setting that
   says otherwise.
========================= */

const path = require('path');
const fs = require('fs');
const adbService = require('./adbService');

const SERVER_JAR = 'scrcpy-server.jar';

/* The client library implements the scrcpy protocol up to server 3.3.3, and
   scrcpy refuses a session whose client version string does not match the
   server exactly. So the bundled jar is PINNED to 3.3.3 — not "latest". A
   newer jar (4.x exists) is not an upgrade here, it is a session that dies at
   handshake with "The server version does not match the client". */
const SERVER_VERSION = '3.3.3';
const SERVER_SHA256 = '7e70323ba7f259649dd4acce97ac4fefbae8102b2c6d91e2e7be613fd5354be0';

const ADB_SERVER_PORT = 5037;

/* Lazily imported ESM. The @yume-chan packages are ESM-only and this file is
   CommonJS (electron.js requires it synchronously at startup), so they load on
   first use via dynamic import. Cached — the import graph is ~50 modules and
   re-resolving it per session would show up in start latency. */
let esm = null;
async function loadEsm() {
    if (esm) return esm;
    const [adbMod, scrcpyMod, adbScrcpyMod, tcpMod] = await Promise.all([
        import('@yume-chan/adb'),
        import('@yume-chan/scrcpy'),
        import('@yume-chan/adb-scrcpy'),
        import('@yume-chan/adb-server-node-tcp')
    ]);
    esm = {
        AdbServerClient: adbMod.AdbServerClient,
        DefaultServerPath: scrcpyMod.DefaultServerPath,
        AndroidKeyCode: scrcpyMod.AndroidKeyCode,
        AndroidKeyEventAction: scrcpyMod.AndroidKeyEventAction,
        AndroidMotionEventAction: scrcpyMod.AndroidMotionEventAction,
        AndroidMotionEventButton: scrcpyMod.AndroidMotionEventButton,
        ScrcpyPointerId: scrcpyMod.ScrcpyPointerId,
        ScrcpyVideoCodecId: scrcpyMod.ScrcpyVideoCodecId,
        AdbScrcpyClient: adbScrcpyMod.AdbScrcpyClient,
        AdbScrcpyOptionsLatest: adbScrcpyMod.AdbScrcpyOptionsLatest,
        AdbScrcpyExitedError: adbScrcpyMod.AdbScrcpyExitedError,
        AdbServerNodeTcpConnector: tcpMod.AdbServerNodeTcpConnector
    };
    return esm;
}

/* ---------- bundled server jar ---------- */

/**
 * Locates the bundled scrcpy server.
 *
 * Two layouts, because `resources/` is shipped through electron-builder's
 * extraResources and therefore sits outside the asar in a packaged build.
 */
function serverJarPath() {
    const candidates = [
        path.join(__dirname, 'resources', SERVER_JAR),
        process.resourcesPath ? path.join(process.resourcesPath, 'resources', SERVER_JAR) : null,
        process.resourcesPath ? path.join(process.resourcesPath, SERVER_JAR) : null
    ].filter(Boolean);

    for (const p of candidates) {
        try { if (fs.existsSync(p)) return p; } catch { /* keep looking */ }
    }
    return null;
}

/**
 * Reads the jar and verifies it byte-for-byte.
 *
 * Checked rather than trusted because the failure it prevents is unreadable:
 * a truncated or substituted jar produces a server that starts, prints
 * nothing useful and hangs, and the visible symptom is "the mirror never
 * connects". A hash mismatch says exactly what is wrong.
 */
function readServerJar() {
    const p = serverJarPath();
    if (!p) {
        throw new Error(`scrcpy server not found. Expected resources/${SERVER_JAR} next to the app.`);
    }
    const bytes = fs.readFileSync(p);
    const digest = require('crypto').createHash('sha256').update(bytes).digest('hex');
    if (digest !== SERVER_SHA256) {
        throw new Error(
            `scrcpy server at ${p} does not match the pinned v${SERVER_VERSION} build ` +
            `(sha256 ${digest.slice(0, 12)}… , expected ${SERVER_SHA256.slice(0, 12)}…)`
        );
    }
    return { bytes: new Uint8Array(bytes), path: p, size: bytes.length, sha256: digest };
}

/** Integrity check without the payload — for tests and the diagnostics view. */
function verifyServerJar() {
    const { path: p, size, sha256 } = readServerJar();
    return { path: p, size, sha256, version: SERVER_VERSION };
}

/* ---------- session state ---------- */

const session = {
    status: 'idle',        // idle | starting | streaming | stopping | error
    error: null,
    serial: null,
    model: null,
    connection: null,      // 'usb' | 'tcpip'
    width: 0,
    height: 0,
    native: null,          // the device's own panel size, or null if it did not say
    codec: null,
    startedAt: 0,
    startMs: null,         // start() call -> first frame arriving
    firstFrameMs: null,    // start() call -> first packet, pushed when it lands
    packets: 0,
    bytes: 0,

    _client: null,
    _adb: null,
    _controller: null,
    audio: null,           // {codec, sampleRate, channels} once the stream is up
    _onPacket: null,
    _onAudio: null,
    _onStatus: null,
    /* EPOCH, not a boolean.
       A `_stopping` flag was not enough: `client.exited` resolves AFTER
       close() returns, so by the time it fired the flag had already been
       cleared and a perfectly clean stop published "the scrcpy server exited"
       as an error — which the panel then rendered in red and used to tear
       itself down a second time. Every async continuation now carries the
       epoch it belongs to and does nothing if the session has moved on. */
    _epoch: 0
};

function publish(patch) {
    Object.assign(session, patch);
    const cb = session._onStatus;
    if (cb) {
        try { cb(statusSnapshot()); } catch (e) { console.error('[mirror] status callback:', e.message); }
    }
}

function statusSnapshot() {
    return {
        status: session.status,
        error: session.error,
        serial: session.serial,
        model: session.model,
        connection: session.connection,
        width: session.width,
        height: session.height,
        native: session.native,
        codec: session.codec,
        audio: session.audio,
        serverVersion: SERVER_VERSION,
        uptimeMs: session.startedAt ? Date.now() - session.startedAt : 0,
        startMs: session.startMs,
        firstFrameMs: session.firstFrameMs,
        packets: session.packets,
        bytes: session.bytes
    };
}

function isActive() {
    return session.status === 'starting' || session.status === 'streaming';
}

/* ---------- device discovery ---------- */

/**
 * Ensures the local ADB server is up.
 *
 * `AdbServerNodeTcpConnector` speaks to an ADB server, it does not start one.
 * On a machine where nothing has run `adb` yet, port 5037 is simply closed and
 * every call fails with ECONNREFUSED, which reads like a device problem.
 */
async function ensureAdbServer() {
    try {
        await adbService.adb(['start-server'], { timeout: 20000 });
    } catch (e) {
        throw new Error(`could not start the ADB server: ${e.message}`);
    }
}

async function createServerClient() {
    const { AdbServerClient, AdbServerNodeTcpConnector } = await loadEsm();
    const connector = new AdbServerNodeTcpConnector({ host: '127.0.0.1', port: ADB_SERVER_PORT });
    return new AdbServerClient(connector);
}

/**
 * Lists devices ADB can actually see, with the state included.
 *
 * `unauthorized` is reported rather than filtered out: it is the single most
 * common first-run state (the phone has not shown the RSA prompt yet) and the
 * fix is on the phone, so the UI has to be able to say so.
 */
async function listDevices() {
    await ensureAdbServer();
    const client = await createServerClient();
    const devices = await client.getDevices(['device', 'unauthorized', 'offline']);
    return devices.map((d) => ({
        serial: d.serial,
        state: d.state,
        model: d.model || null,
        product: d.product || null,
        // A serial of the form host:port is a device reached over Wi-Fi ADB.
        connection: /^[\d.]+:\d+$/.test(d.serial) ? 'tcpip' : 'usb'
    }));
}

/**
 * Reads the device's physical display size.
 *
 * Exists so "1080x2400" can be reported as NATIVE rather than just asserted.
 * scrcpy reports the size of the stream it produced; only the device knows the
 * size of the panel, and the difference between them is the one number that
 * says whether the picture was downscaled.
 *
 * `-s <serial>` is not optional. Without it adb targets "the" device, which
 * fails outright with two connected and — worse — silently answers for the
 * wrong one when the mirror is running against the other.
 *
 * Best-effort: a device that will not answer `wm size` still mirrors fine, so
 * this returns null rather than failing the session.
 */
async function getDeviceResolution(serial) {
    try {
        return parseWmSize(await adbService.adb(['-s', serial, 'shell', 'wm', 'size'], { timeout: 5000 }));
    } catch {
        return null;
    }
}

/**
 * Parses `wm size` output. Pure, so it can be tested without a phone.
 *
 * `wm size` prints one or two lines:
 *
 *     Physical size: 1080x2400
 *     Override size: 720x1600
 *
 * The override, when present, is what the device is ACTUALLY displaying and
 * therefore what scrcpy captures — so reading only "Physical size" on a device
 * with an override active reports the stream as downscaled when it is native to
 * what is on screen.
 */
function parseWmSize(text) {
    const s = String(text ?? '');
    const override = /Override size:\s*(\d+)x(\d+)/.exec(s);
    const physical = /Physical size:\s*(\d+)x(\d+)/.exec(s);
    const m = override || physical;
    if (!m) return null;
    const width = Number(m[1]);
    const height = Number(m[2]);
    if (!width || !height) return null;
    return { width, height, overridden: Boolean(override) };
}

/** Picks the device to mirror: the requested serial, else the only ready one. */
function selectDevice(devices, serial) {
    if (serial) {
        const match = devices.find((d) => d.serial === serial);
        if (!match) throw new Error(`device ${serial} is not connected`);
        if (match.state !== 'device') {
            throw new Error(match.state === 'unauthorized'
                ? `device ${serial} has not authorised this computer — accept the USB debugging prompt on the phone`
                : `device ${serial} is ${match.state}`);
        }
        return match;
    }

    const ready = devices.filter((d) => d.state === 'device');
    if (ready.length === 1) return ready[0];
    if (ready.length > 1) {
        throw new Error(`${ready.length} devices are connected — say which one, or unplug the others`);
    }

    const unauth = devices.find((d) => d.state === 'unauthorized');
    if (unauth) {
        throw new Error('your phone has not authorised this computer — accept the USB debugging prompt on the phone');
    }
    throw new Error('no Android device is connected over USB or Wi-Fi ADB');
}

/* ---------- session lifecycle ---------- */

/**
 * Starts a mirroring session.
 *
 * @param {object} opts
 * @param {string} [opts.serial]        device to mirror; omitted picks the only one
 * @param {object} opts.scrcpyOptions   from mirrorIntent.buildMirrorOptions()
 * @param {(packet: object) => void} opts.onPacket   encoded video packets
 * @param {(status: object) => void} [opts.onStatus] lifecycle updates
 */
/* How long a session may sit in 'starting' before it is presumed dead.
   The same latch that wedged the renderer exists here: `isActive()` covers
   'starting', so a handshake that never finishes refuses every later attempt
   with "a mirror session is already running" until the app is restarted. A
   start that has not produced a stream in this long is not in progress, it is
   stuck, and the correct response is to clear it rather than to guard it. */
const START_STALE_MS = 30000;

/**
 * Has a start been sitting in 'starting' long enough to be presumed dead?
 *
 * Pure, so the rule can be tested without a phone — the bug it fixes only
 * appears when a handshake hangs, which is exactly the state that is hard to
 * reproduce on demand.
 */
function isStaleStart(status, startedAt, now = Date.now(), staleMs = START_STALE_MS) {
    return status === 'starting' && Boolean(startedAt) && (now - startedAt) > staleMs;
}

async function start({ serial, scrcpyOptions, onPacket, onAudio, onStatus } = {}) {
    if (isStaleStart(session.status, session.startedAt)) {
        console.warn('[mirror] discarding a start that stalled for',
            Math.round((Date.now() - session.startedAt) / 1000), 'seconds');
        session._epoch++;
        await hardStop();
        resetSession();
    }

    if (isActive()) {
        throw new Error(session.status === 'starting'
            ? 'a mirror session is already starting'
            : 'a mirror session is already running');
    }
    if (typeof onPacket !== 'function') {
        throw new Error('start() requires an onPacket sink');
    }

    resetSession();
    const epoch = ++session._epoch;
    session._onPacket = onPacket;
    session._onAudio = typeof onAudio === 'function' ? onAudio : null;
    session._onStatus = onStatus || null;
    publish({ status: 'starting', error: null, startedAt: Date.now() });

    const t0 = Date.now();
    try {
        const jar = readServerJar();
        const {
            AdbScrcpyClient, AdbScrcpyOptionsLatest, DefaultServerPath, ScrcpyVideoCodecId
        } = await loadEsm();

        await ensureAdbServer();
        const serverClient = await createServerClient();
        const devices = await listDevices();
        const target = selectDevice(devices, serial);

        publish({ serial: target.serial, model: target.model, connection: target.connection });

        const adb = await serverClient.createAdb({ serial: target.serial });
        session._adb = adb;

        /* Kicked off here and awaited after the stream is up, so the ~100 ms
           `wm size` shell call overlaps the jar push and the handshake instead
           of being added to the time before the first frame. */
        const nativePromise = getDeviceResolution(target.serial);

        // Push every time. The jar is 90 KB over a USB or LAN link and this
        // removes a whole class of stale-server bugs: a device that still has
        // last month's build in /data/local/tmp fails the version handshake.
        await AdbScrcpyClient.pushServer(adb, ReadableStream.from([jar.bytes]), DefaultServerPath);

        const options = new AdbScrcpyOptionsLatest(
            {
                ...scrcpyOptions,
                /* Reverse tunnel: the device dials the host, which is scrcpy's
                   own default and avoids the connect race. The client library
                   falls back to a forward tunnel by itself when the device
                   does not support reverse, so no fallback is written here. */
                tunnelForward: false,
                logLevel: 'info'
            },
            { version: SERVER_VERSION }
        );

        const client = await AdbScrcpyClient.start(adb, DefaultServerPath, options);
        session._client = client;

        /* The server's stdout MUST be drained or the process blocks on a full
           pipe. It is also the only place a protocol mismatch is explained in
           words, so it is logged rather than discarded. */
        pump(client.output, (line) => console.log('[mirror][server]', line));

        session._controller = client.controller || null;

        const video = await client.videoStream;
        if (!video) throw new Error('the server started but produced no video stream');

        const meta = video.metadata || {};
        const codecName = codecLabel(ScrcpyVideoCodecId, meta.codec);
        publish({
            width: meta.width || 0,
            height: meta.height || 0,
            codec: codecName,
            model: session.model || meta.deviceName || null
        });

        /* A rotation or a resize on the device restarts the encoder at a new
           size. The renderer's decoder learns this from the stream itself, but
           the panel needs it to re-letterbox, so it is forwarded too. */
        video.sizeChanged?.((size) => {
            publish({ width: size.width, height: size.height });
        });

        pumpVideo(video.stream, epoch);

        await startAudio(client, epoch);

        // Resolved by now in practice; awaited rather than raced so the status
        // the caller receives already carries it.
        publish({ native: await nativePromise });

        client.exited
            .then(() => fail(new Error('the scrcpy server exited'), epoch))
            .catch((e) => fail(e, epoch));

        publish({ status: 'streaming', startMs: Date.now() - t0 });
        console.log(`[mirror] streaming ${session.width}x${session.height} ${codecName} from ` +
            `${target.model || target.serial} over ${target.connection} in ${session.startMs}ms`);

        /* Waits for the first frame before returning, up to a bound.
           `streaming` means the handshake succeeded, which is NOT the same as
           a picture existing — the first measurement of this returned
           firstFrameMs: null every time, because the snapshot was taken before
           any packet had arrived, and the spoken line said "first frame ?ms"
           forever. Either the number is real or it is not reported. */
        await waitForFirstFrame(epoch, 4000);

        return statusSnapshot();
    } catch (e) {
        await hardStop();
        publish({ status: 'error', error: describeStartError(e) });
        throw new Error(session.error);
    }
}

/**
 * Resolves once a frame has actually arrived, or after `timeoutMs`.
 *
 * Deliberately NOT an error on timeout: a session that has handshaken but not
 * yet produced a frame is still a live session (a static screen with the
 * encoder waiting on content is the ordinary case), and failing it would turn
 * a working mirror into an error message. The absent number is reported as
 * absent instead.
 */
function waitForFirstFrame(epoch, timeoutMs) {
    if (session.firstFrameMs !== null) return Promise.resolve();
    return new Promise((resolve) => {
        const deadline = Date.now() + timeoutMs;
        const tick = () => {
            if (session._epoch !== epoch || session.firstFrameMs !== null || Date.now() > deadline) {
                resolve();
                return;
            }
            setTimeout(tick, 25);
        };
        tick();
    });
}

/* Raw scrcpy audio is PCM signed 16-bit little-endian, 48 kHz, stereo. These
   are the format's constants, not a guess — they are what the device produces
   with `--audio-codec=raw`, and the player has to be built to match. */
const RAW_AUDIO = { sampleRate: 48000, channels: 2, format: 's16le' };

/**
 * Attaches the audio stream, if the session has one.
 *
 * NEVER fatal. Audio is unavailable on Android 10 and below, can be refused by
 * the device, and can simply fail — none of which is a reason to lose the
 * picture. A failure here downgrades to video-only and says so in the status.
 */
async function startAudio(client, epoch) {
    if (!client.audioStream) {
        publish({ audio: { enabled: false, reason: 'not requested' } });
        return;
    }
    try {
        const meta = await client.audioStream;
        if (session._epoch !== epoch) return;

        if (!meta || meta.type !== 'success') {
            /* 'errored' is what a device that cannot capture playback audio
               returns — Android 10 and below have no API for it at all. */
            publish({
                audio: {
                    enabled: false,
                    reason: meta?.type === 'disabled' ? 'disabled by the device' : 'the device refused audio capture'
                }
            });
            return;
        }

        const codec = meta.codec?.optionValue || 'raw';
        publish({
            audio: {
                enabled: true,
                codec,
                sampleRate: RAW_AUDIO.sampleRate,
                channels: RAW_AUDIO.channels,
                format: codec === 'raw' ? RAW_AUDIO.format : null
            }
        });

        pumpAudio(meta.stream, epoch);
    } catch (e) {
        // Video keeps running; only the audio half is reported as unavailable.
        console.warn('[mirror] audio unavailable:', e.message);
        publish({ audio: { enabled: false, reason: e.message } });
    }
}

/** Forwards decoded-ready PCM to the renderer. Same shape as the video pump. */
function pumpAudio(stream, epoch) {
    (async () => {
        const reader = stream.getReader();
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                if (session._epoch !== epoch) break;
                if (value.type !== 'data' || !value.data?.byteLength) continue;
                session._onAudio?.({ data: value.data });
            }
        } catch (e) {
            /* Audio ending is not a session failure. Losing the picture because
               the speaker stream hiccupped would be a bad trade. */
            if (session._epoch === epoch) {
                console.warn('[mirror] audio stream ended:', e?.message || e);
                publish({ audio: { ...(session.audio || {}), enabled: false, reason: 'stream ended' } });
            }
        } finally {
            try { reader.releaseLock(); } catch { /* already released */ }
        }
    })();
}

function codecLabel(ScrcpyVideoCodecId, id) {
    for (const [name, value] of Object.entries(ScrcpyVideoCodecId)) {
        if (value === id) return name.toLowerCase();
    }
    return null;
}

/**
 * Turns a library error into something worth speaking aloud.
 *
 * Left raw, the common failures surface as "ECONNREFUSED 127.0.0.1:5037" or
 * "scrcpy server exited prematurely", neither of which tells the user which of
 * the three things they control is wrong.
 */
function describeStartError(e) {
    const msg = String(e?.message || e);
    if (/ECONNREFUSED/.test(msg)) return 'the ADB server is not reachable on port 5037';
    if (/does not match|version/i.test(msg) && /server/i.test(msg)) {
        return `the phone is running a different scrcpy server than the bundled v${SERVER_VERSION}`;
    }
    if (/exited prematurely/i.test(msg)) {
        return 'the scrcpy server exited on the phone — check that USB debugging is still authorised';
    }
    return msg;
}

/** Drains a ReadableStream<string> without blocking the caller. */
function pump(stream, onLine) {
    if (!stream) return;
    (async () => {
        const reader = stream.getReader();
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                onLine(value);
            }
        } catch { /* the stream ends when the session does */ }
        finally { try { reader.releaseLock(); } catch { /* already released */ } }
    })();
}

/**
 * Forwards encoded video packets to the renderer.
 *
 * `pts` arrives as a BigInt of microseconds. It is converted to a Number here
 * rather than in the renderer: BigInt does survive structured clone, but every
 * consumer downstream (latency maths, the overlay) wants a Number, and one
 * conversion at the boundary beats a cast at each use. Microseconds fit in a
 * double for ~285 years of uptime.
 */
function pumpVideo(stream, epoch) {
    (async () => {
        const reader = stream.getReader();
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                if (session._epoch !== epoch) break;   // a newer session owns the state

                if (session.firstFrameMs === null) {
                    publish({ firstFrameMs: Date.now() - session.startedAt });
                }
                session.packets++;
                session.bytes += value.data?.byteLength || 0;

                session._onPacket?.({
                    type: value.type,
                    keyframe: value.keyframe === true,
                    pts: value.pts === undefined ? undefined : Number(value.pts),
                    data: value.data
                });
            }
        } catch (e) {
            fail(e, epoch);
        } finally {
            try { reader.releaseLock(); } catch { /* already released */ }
        }
    })();
}

/**
 * Reports a session failure — but only for the session that is still current.
 *
 * The epoch check is the whole point. `client.exited` and the video reader both
 * settle after teardown, so without it an ordinary stop() published an error
 * the user then saw in red.
 */
function fail(e, epoch) {
    if (epoch !== undefined && session._epoch !== epoch) return;
    if (!isActive()) return;
    console.error('[mirror] session failed:', e?.message || e);
    session._epoch++;                       // this session is over; late callbacks are stale
    publish({ status: 'error', error: describeStartError(e) });
    hardStop().catch(() => { /* already tearing down */ });
}

function resetSession() {
    Object.assign(session, {
        status: 'idle', error: null, serial: null, model: null, connection: null,
        width: 0, height: 0, native: null, codec: null, audio: null,
        startedAt: 0, startMs: null, firstFrameMs: null,
        packets: 0, bytes: 0,
        _client: null, _adb: null, _controller: null
    });
}

/** Tears down without publishing a status — callers decide what to report. */
async function hardStop() {
    const client = session._client;
    session._client = null;
    session._controller = null;

    if (client) {
        try { await client.close(); } catch (e) { console.warn('[mirror] close:', e.message); }
    }
    session._adb = null;
}

async function stop() {
    if (!isActive() && session.status !== 'error') {
        return statusSnapshot();
    }
    /* Retire the epoch BEFORE closing. close() is what makes `exited` resolve,
       so anything that races it must already be looking at a stale epoch. */
    session._epoch++;
    publish({ status: 'stopping' });
    await hardStop();
    const snapshot = statusSnapshot();
    resetSession();
    publish({ status: 'idle' });
    session._onPacket = null;
    session._onAudio = null;
    return snapshot;
}

/* ---------- control ---------- */

function requireController() {
    if (session.status !== 'streaming') throw new Error('no mirror session is running');
    if (!session._controller) throw new Error('this session has control disabled');
    return session._controller;
}

/** Clamps a coordinate into the current frame. Defence in depth: the renderer
 *  already maps and clamps, but this side must not trust a value it did not
 *  compute — an out-of-range touch is rejected by the device with no error. */
function clampToFrame(x, y) {
    const w = session.width || 1;
    const h = session.height || 1;
    const c = (v, hi) => {
        const n = Math.round(Number(v));
        if (!Number.isFinite(n)) return 0;
        return n < 0 ? 0 : n > hi - 1 ? hi - 1 : n;
    };
    return { x: c(x, w), y: c(y, h) };
}

/**
 * Injects a touch.
 * @param {{action: 'down'|'up'|'move', x: number, y: number, pressure?: number, pointerId?: string}} e
 */
async function injectTouch(e) {
    const controller = requireController();
    const { AndroidMotionEventAction, AndroidMotionEventButton, ScrcpyPointerId } = await loadEsm();

    const ACTIONS = {
        down: AndroidMotionEventAction.Down,
        up: AndroidMotionEventAction.Up,
        move: AndroidMotionEventAction.Move
    };
    const action = ACTIONS[e?.action];
    if (action === undefined) throw new Error(`unknown touch action '${e?.action}'`);

    const { x, y } = clampToFrame(e.x, e.y);

    /* Pressure must be 0 on Up. scrcpy derives "still touching" from it, and a
       release sent with pressure 1 leaves the device believing the finger is
       down — the symptom is a stuck drag that only clears on the next tap. */
    const pressure = action === AndroidMotionEventAction.Up
        ? 0
        : Math.max(0, Math.min(1, Number(e.pressure ?? 1)));

    /* Distinct ids are what make a gesture MULTI-touch. Two simultaneous
       touches sharing one pointer id are read by Android as one finger
       teleporting, which is not a pinch — it is a very fast swipe. */
    const POINTERS = {
        mouse: ScrcpyPointerId.Mouse,
        finger: ScrcpyPointerId.Finger,
        'virtual-finger': ScrcpyPointerId.VirtualFinger,
        'virtual-mouse': ScrcpyPointerId.VirtualMouse
    };

    await controller.injectTouch({
        action,
        pointerId: POINTERS[e.pointerId] ?? ScrcpyPointerId.Finger,
        screenWidth: session.width,
        screenHeight: session.height,
        pointerX: x,
        pointerY: y,
        pressure,
        actionButton: AndroidMotionEventButton.Primary,
        buttons: action === AndroidMotionEventAction.Up ? 0 : AndroidMotionEventButton.Primary
    });
}

/** Injects a wheel scroll at a point. */
async function injectScroll(e) {
    const controller = requireController();
    const { x, y } = clampToFrame(e.x, e.y);
    await controller.injectScroll({
        screenWidth: session.width,
        screenHeight: session.height,
        pointerX: x,
        pointerY: y,
        scrollX: clampUnit(e.scrollX),
        scrollY: clampUnit(e.scrollY),
        buttons: 0
    });
}

function clampUnit(v) {
    const n = Number(v) || 0;
    return n < -1 ? -1 : n > 1 ? 1 : n;
}

/** Injects a key event. `keyCode` is an Android keycode from mirrorIntent. */
async function injectKey(e) {
    const controller = requireController();
    const { AndroidKeyEventAction } = await loadEsm();
    const action = e?.action === 'up' ? AndroidKeyEventAction.Up : AndroidKeyEventAction.Down;
    const keyCode = Number(e?.keyCode);
    if (!Number.isInteger(keyCode) || keyCode <= 0) {
        throw new Error('injectKey needs a positive Android keycode');
    }
    await controller.injectKeyCode({
        action,
        keyCode,
        repeat: Number(e?.repeat) || 0,
        metaState: Number(e?.metaState) || 0
    });
}

/** Types text on the device. Layout-independent, unlike a keycode. */
async function injectText(text) {
    const controller = requireController();
    const s = String(text ?? '');
    if (!s) return;
    // A bounded write: this is reachable from the renderer, and an unbounded
    // string here is a stall on the control socket that also blocks input.
    await controller.injectText(s.slice(0, 4096));
}

/**
 * Hardware and navigation keys, by name.
 *
 * An allowlist rather than a passthrough, matching adbService's rule: the
 * renderer and any tool call can reach this, and "press an arbitrary named
 * action" is how a control channel grows a hole.
 */
const ACTIONS = {
    /* BACK is `backOrScreenOn`, not a plain BACK keycode: on a device whose
       screen is off it wakes it instead of navigating, which is what a user
       pressing back on a dark mirror means. */
    back: (c, m) => c.backOrScreenOn(m.AndroidKeyEventAction.Down),
    'back-up': (c, m) => c.backOrScreenOn(m.AndroidKeyEventAction.Up),
    home: (c, m) => pressAndRelease(c, m, m.AndroidKeyCode.AndroidHome),
    'app-switch': (c, m) => pressAndRelease(c, m, m.AndroidKeyCode.AndroidAppSwitch),
    notifications: (c) => c.expandNotificationPanel(),
    settings: (c) => c.expandSettingPanel(),
    collapse: (c) => c.collapseNotificationPanel(),
    rotate: (c) => c.rotateDevice(),
    'reset-video': (c) => c.resetVideo()
};

async function pressAndRelease(controller, esmMod, keyCode) {
    await controller.injectKeyCode({ action: esmMod.AndroidKeyEventAction.Down, keyCode, repeat: 0, metaState: 0 });
    await controller.injectKeyCode({ action: esmMod.AndroidKeyEventAction.Up, keyCode, repeat: 0, metaState: 0 });
}

async function action(name) {
    const controller = requireController();
    const fn = ACTIONS[name];
    if (!fn) throw new Error(`unknown mirror action '${name}'`);
    const esmMod = await loadEsm();
    await fn(controller, esmMod);
}

/** Pushes host clipboard text to the device. */
async function setClipboard(text) {
    const controller = requireController();
    await controller.setClipboard({ content: String(text ?? '').slice(0, 8192), sequence: 0n, paste: false });
}

module.exports = {
    SERVER_VERSION,
    SERVER_SHA256,
    serverJarPath,
    verifyServerJar,
    listDevices,
    getDeviceResolution,
    parseWmSize,           // exported for tests: pure
    isStaleStart,          // exported for tests: pure
    START_STALE_MS,
    selectDevice,          // exported for tests: pure given a device list
    start,
    stop,
    isActive,
    status: statusSnapshot,
    injectTouch,
    injectScroll,
    injectKey,
    injectText,
    setClipboard,
    action,
    MIRROR_ACTIONS: Object.keys(ACTIONS)
};
