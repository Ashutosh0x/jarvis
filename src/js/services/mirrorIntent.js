// Screen-mirror routing and input translation.
//
// PURE by construction: no DOM, no IPC, no scrcpy session. Everything here is
// a function of its arguments, so the parts that are easy to get subtly wrong
// — which utterance starts a mirror, where a click lands on a rotated device,
// which Android keycode a browser key is — are testable without a phone.
//
// The mapping half exists because the two failure modes are silent. A wrong
// coordinate transform still injects a touch, just in the wrong place; a wrong
// keycode still types, just the wrong character. Neither throws.

import { AndroidKeyCode, AndroidKeyEventMeta } from '@yume-chan/scrcpy';

/* =========================================================================
   1. VOICE ROUTING
   ========================================================================= */

/* "my phone" is not enough on its own: phoneTools.targetsPhone() already
   claims "on my phone"/"to my phone", and COMPANION_STATUS claims
   phone+status. A mirror utterance is identified by a MIRRORING VERB, and
   detectIntent must check this parser BEFORE targetsPhone — the ordering is
   asserted in the tests, because every routing bug this project has recorded
   was precedence, not the regex. */
const SUBJECT = /\b(phone|mobile|android|redmi|screen|display)\b/;

// "mirror", "cast", "screen mirror", "show my phone screen", "stream my phone"
const START_VERB = /\b(mirror|mirroring|cast|casting|screencast|stream)\b/;
const START_PHRASE = /\b(show|see|view|open|bring up|pull up)\b.*\b(phone|mobile|android|redmi)\b.*\bscreen\b/;

const STOP = /\b(stop|close|end|kill|quit|hide|disconnect|shut)\b/;

/* Grabbing a still out of a live mirror. Deliberately distinct from
   PHONE_TOOL's phone.screenshot, which goes over the companion
   AccessibilityService and needs the APK — this one reads the frame Jarvis
   already has, so it works whenever the mirror is up. */
const SNAPSHOT = /\b(screenshot|screen shot|snapshot|capture|grab|freeze|still)\b/;

/* ASKING ABOUT mirroring is not asking TO mirror. Caught by a test:
   "search for android screen mirroring apps" satisfied both the verb and the
   subject and would have opened a session. Leading search verbs and question
   forms are the two shapes that carry the topic without the request. */
const NOT_A_REQUEST = /^(search|google|look ?up|find|what|what'?s|how|why|when|who|tell me|explain|define)\b/;

/**
 * Maps an utterance to a mirror action.
 *
 * @param {string} text
 * @returns {{action: 'start'|'stop'|'snapshot'}|null} null when the utterance
 *   is not about mirroring at all, so the caller falls through untouched.
 */
export function parseMirrorCommand(text) {
    const q = String(text || '').toLowerCase().trim();
    if (!q) return null;

    /* A pasted document is not a command. detectIntent already guards this
       globally, but this parser is also called from tests and tools, and one
       long paragraph containing the word "mirror" must not start a session. */
    if (q.length > 280) return null;

    /* Checked before anything else: a question about mirroring belongs to the
       model or to web search, and answering it by opening a mirror is the
       worst possible response. */
    if (NOT_A_REQUEST.test(q)) return null;

    const mirrorish = START_VERB.test(q) || START_PHRASE.test(q);

    // Stopping is checked first: "stop mirroring" contains the start verb.
    if (mirrorish && STOP.test(q)) return { action: 'stop' };

    /* "take a phone screenshot" / "screenshot my phone screen". Requires the
       subject so a plain "take a screenshot" still reaches the DESKTOP
       screenshot handler — that is the command the user already has. */
    if (SNAPSHOT.test(q) && SUBJECT.test(q) &&
        /\b(phone|mobile|android|redmi)\b/.test(q)) {
        return { action: 'snapshot' };
    }

    if (mirrorish && SUBJECT.test(q)) return { action: 'start' };

    /* Bare "mirror" / "stop mirroring" with no subject. Unambiguous in this
       app: nothing else here is called mirroring. */
    if (/^(stop|close|end) (the )?(mirror|mirroring|cast|casting)$/.test(q)) return { action: 'stop' };
    if (/^(mirror|start mirroring|start the mirror|cast)$/.test(q)) return { action: 'start' };

    return null;
}

/* =========================================================================
   2. POINTER MAPPING
   ========================================================================= */

/**
 * Maps a pointer position inside the displayed canvas to a device pixel.
 *
 * The canvas is letterboxed: it preserves the device aspect ratio inside
 * whatever box the panel gives it, so the drawn image is usually smaller than
 * the element and offset within it. Using the element's own box as the
 * coordinate space — the obvious implementation — puts every touch in the
 * wrong place by the size of the letterbox bars, worst at the edges where
 * buttons live.
 *
 * @param {object} p
 * @param {number} p.clientX  pointer x in viewport coordinates
 * @param {number} p.clientY  pointer y in viewport coordinates
 * @param {DOMRect|{left:number,top:number,width:number,height:number}} p.rect
 *        bounding box of the canvas element
 * @param {number} p.videoWidth   device frame width in pixels
 * @param {number} p.videoHeight  device frame height in pixels
 * @returns {{x:number, y:number, inside:boolean}} integer device coordinates,
 *   clamped to the frame. `inside` is false when the pointer was over a
 *   letterbox bar rather than the image.
 */
export function mapPointerToDevice({ clientX, clientY, rect, videoWidth, videoHeight }) {
    const W = Number(videoWidth) || 0;
    const H = Number(videoHeight) || 0;
    if (W <= 0 || H <= 0 || !rect || rect.width <= 0 || rect.height <= 0) {
        return { x: 0, y: 0, inside: false };
    }

    // `object-fit: contain` arithmetic — the scale is the limiting dimension.
    const scale = Math.min(rect.width / W, rect.height / H);
    const drawnW = W * scale;
    const drawnH = H * scale;
    const offsetX = (rect.width - drawnW) / 2;
    const offsetY = (rect.height - drawnH) / 2;

    const localX = clientX - rect.left - offsetX;
    const localY = clientY - rect.top - offsetY;

    const inside = localX >= 0 && localY >= 0 && localX <= drawnW && localY <= drawnH;

    /* Clamped, not rejected. A drag that leaves the image should keep
       injecting at the edge — releasing the pointer outside the panel
       otherwise strands the device mid-gesture with no Up event. */
    const x = clamp(Math.round(localX / scale), 0, W - 1);
    const y = clamp(Math.round(localY / scale), 0, H - 1);

    return { x, y, inside };
}

function clamp(v, lo, hi) {
    if (!Number.isFinite(v)) return lo;
    return v < lo ? lo : v > hi ? hi : v;
}

/* =========================================================================
   3. KEYBOARD MAPPING
   ========================================================================= */

/* KeyboardEvent.code names ARE the AndroidKeyCode names in @yume-chan/scrcpy
   ("KeyA", "Digit1", "Enter", "ArrowUp"), so the common case is a direct
   lookup rather than a table this project would have to maintain. Only the
   handful where the two vocabularies genuinely differ is listed. */
const KEY_ALIASES = {
    Backspace: 'Backspace',
    // Browsers report the numeric keypad separately; Android has its own set.
    NumpadEnter: 'Enter',
    ContextMenu: 'Menu',
    // Chromium reports OS/Meta as "MetaLeft"/"MetaRight"; scrcpy has them.
    OSLeft: 'MetaLeft',
    OSRight: 'MetaRight'
};

/**
 * Translates a browser key event to an Android keycode.
 *
 * @param {{code?: string, key?: string}} e
 * @returns {number|null} null when there is no Android equivalent, which the
 *   caller must treat as "do not inject" rather than as keycode 0.
 */
export function webKeyToAndroid(e) {
    if (!e) return null;
    const code = KEY_ALIASES[e.code] || e.code;
    const mapped = code ? AndroidKeyCode[code] : undefined;
    return typeof mapped === 'number' ? mapped : null;
}

/**
 * Packs modifier state into scrcpy's metaState bitfield.
 *
 * Both the side-specific and the generic bit are set: Android checks the
 * generic `Shift`/`Ctrl`/`Alt`/`Meta` bits for most shortcuts, and an event
 * carrying only `ShiftLeft` reads as no-shift to that check.
 */
export function metaStateFrom(e) {
    let m = AndroidKeyEventMeta.None;
    if (!e) return m;
    if (e.shiftKey) m |= AndroidKeyEventMeta.Shift | AndroidKeyEventMeta.ShiftLeft;
    if (e.ctrlKey) m |= AndroidKeyEventMeta.Ctrl | AndroidKeyEventMeta.CtrlLeft;
    if (e.altKey) m |= AndroidKeyEventMeta.Alt | AndroidKeyEventMeta.AltLeft;
    if (e.metaKey) m |= AndroidKeyEventMeta.Meta | AndroidKeyEventMeta.MetaLeft;
    return m;
}

/**
 * True when a key press should be sent as TEXT rather than as a keycode.
 *
 * Injecting a keycode reproduces a physical key: it obeys the device's own
 * layout, so on a non-US layout the wrong character appears. Printable
 * characters therefore go through injectText, which carries the character
 * itself. Everything else — Enter, Backspace, arrows, modifiers — has no text
 * and must be a keycode.
 */
export function isTextKey(e) {
    if (!e || typeof e.key !== 'string') return false;
    if (e.ctrlKey || e.metaKey || e.altKey) return false;  // a shortcut, not typing
    // Named keys ("Enter", "ArrowUp") are longer than one code point; a
    // printable key's `key` is the character itself.
    return [...e.key].length === 1;
}

/* =========================================================================
   4. PRE-DECODER PACKET BUFFER
   ========================================================================= */

/**
 * Holds video packets that arrive before the decoder exists.
 *
 * WHY THIS IS NEEDED AT ALL. scrcpy's first packet is the `configuration` one
 * carrying SPS/PPS, and WebCodecs rejects every frame with "Decoder not
 * configured" until it has been fed. But the decoder cannot be constructed
 * until the session reports which codec the device chose — so there is a
 * window, the whole length of the handshake, in which packets are already
 * flowing and nothing can consume them.
 *
 * Measured with the real device: subscribing after `start()` returned lost the
 * configuration packet and produced a black canvas with one warning per frame,
 * indefinitely. Every other layer reported success, which is why it has to be
 * caught here rather than upstream.
 *
 * BOUNDED BY CONSTRUCTION. Configuration packets are always kept. Data packets
 * older than the newest keyframe are dropped, because a decoder starting cold
 * cannot use them anyway — so a slow handshake costs one group-of-pictures,
 * not a growing pile of megabytes.
 */
export function createPreroll() {
    let buf = [];
    return {
        push(packet) {
            if (!packet) return;
            if (packet.type === 'configuration') { buf.push(packet); return; }
            if (packet.keyframe) buf = buf.filter((p) => p.type !== 'data');
            buf.push(packet);
        },
        /** Returns the buffered packets in arrival order and empties the buffer. */
        drain() {
            const out = buf;
            buf = [];
            return out;
        },
        clear() { buf = []; },
        get size() { return buf.length; }
    };
}

/* =========================================================================
   5. MULTI-TOUCH — THE VIRTUAL FINGER
   ========================================================================= */

/**
 * The second touch point for a pinch/rotate gesture.
 *
 * This is scrcpy's own convention, not an invention: holding a modifier while
 * dragging adds a "virtual finger" at the point inverted through the centre of
 * the screen, and apps that support multi-touch see a real two-finger gesture.
 * The library ships `ScrcpyPointerId.VirtualFinger` for exactly this.
 *
 *   Ctrl        -> invert BOTH axes  (pinch to zoom)
 *   Shift       -> invert x only     (horizontal, reads as rotate)
 *   Ctrl+Shift  -> invert y only
 *
 * Implemented to match scrcpy so muscle memory transfers, and because "invert
 * through the centre" is what makes the gesture symmetric — a second finger
 * placed anywhere else pinches around the wrong point.
 *
 * @returns {{x:number,y:number}|null} null when no modifier is held, which the
 *   caller must treat as "single touch", never as a point at the origin.
 */
export function virtualFingerPoint({ x, y, width, height, ctrl, shift }) {
    const w = Number(width) || 0;
    const h = Number(height) || 0;
    if (w <= 0 || h <= 0) return null;
    if (!ctrl && !shift) return null;

    const invertX = ctrl ? !shift : shift;   // ctrl:yes  shift:yes  ctrl+shift:no
    const invertY = ctrl;                    // ctrl and ctrl+shift invert y

    const cx = Number(x) || 0;
    const cy = Number(y) || 0;
    return {
        x: clamp(Math.round(invertX ? w - 1 - cx : cx), 0, w - 1),
        y: clamp(Math.round(invertY ? h - 1 - cy : cy), 0, h - 1)
    };
}

/**
 * Turns accumulated trackpad pinch deltas into a pair of touch points.
 *
 * A trackpad pinch arrives as `wheel` events with `ctrlKey` set — the same
 * shape a browser uses for page zoom, which is also why it MUST be consumed
 * here: left alone it zooms the Jarvis window instead of the phone.
 *
 * @param {object} p
 * @param {number} p.centerX  device-space anchor
 * @param {number} p.centerY
 * @param {number} p.spread   current half-distance between the fingers, px
 * @param {number} p.width
 * @param {number} p.height
 * @returns {{a:{x:number,y:number}, b:{x:number,y:number}}}
 */
export function pinchPoints({ centerX, centerY, spread, width, height }) {
    const w = Number(width) || 1;
    const h = Number(height) || 1;
    const s = Math.max(1, Number(spread) || 1);
    const cx = clamp(Math.round(Number(centerX) || 0), 0, w - 1);
    const cy = clamp(Math.round(Number(centerY) || 0), 0, h - 1);
    /* Vertical separation: a phone is far taller than it is wide, so a vertical
       pinch has more room before either finger hits an edge and the gesture
       stops scaling. */
    return {
        a: { x: cx, y: clamp(Math.round(cy - s), 0, h - 1) },
        b: { x: cx, y: clamp(Math.round(cy + s), 0, h - 1) }
    };
}

/** Clamps a pinch spread to something both fingers can actually occupy. */
export const PINCH_SPREAD = { min: 20, max: 900, start: 120 };

export function nextPinchSpread(current, deltaY) {
    const d = Number(deltaY) || 0;
    // Trackpads report ~1-10 per notch for pinch; scale so a full pinch is quick
    // without a single flick slamming into the limit.
    const next = (Number(current) || PINCH_SPREAD.start) - d * 2;
    return clamp(Math.round(next), PINCH_SPREAD.min, PINCH_SPREAD.max);
}

/* =========================================================================
   6. RESOLUTION REPORTING AND PANEL GEOMETRY
   ========================================================================= */

/**
 * Compares the streamed size against the device's own panel.
 *
 * ROTATION IS THE TRAP. A phone held sideways streams 2400x1080 while `wm size`
 * still reports 1080x2400, so comparing width to width and height to height
 * calls a perfectly native landscape stream "scaled". The comparison is done on
 * the sorted edge pair, which is rotation-invariant.
 *
 * @returns {{native: boolean|null, label: string, percent: number|null}}
 *   `native: null` means the device did not report a size — stated as unknown
 *   rather than assumed native.
 */
export function describeScale(stream, native) {
    const sw = Number(stream?.width) || 0;
    const sh = Number(stream?.height) || 0;
    if (!sw || !sh) return { native: null, label: '', percent: null };
    if (!native?.width || !native?.height) {
        return { native: null, label: `${sw}×${sh}`, percent: null };
    }

    const [sMin, sMax] = [Math.min(sw, sh), Math.max(sw, sh)];
    const [nMin, nMax] = [Math.min(native.width, native.height), Math.max(native.width, native.height)];

    if (sMin === nMin && sMax === nMax) {
        return { native: true, label: `${sw}×${sh} native`, percent: 100 };
    }
    const percent = Math.round((sMax / nMax) * 100);
    return { native: false, label: `${sw}×${sh} · ${percent}% of ${nMin}×${nMax}`, percent };
}

/**
 * The largest box with the device's aspect ratio that fits the space allowed.
 *
 * BOTH DIMENSIONS, because sizing only the width cannot remove the bars.
 * Measured on a real rotation: a landscape 2400x1080 phone in a full-height
 * 600px panel drew a 600x270 picture with 530px of black above and below it —
 * and since the panel is pure black, that dead space reads as the mirror being
 * broken. Fitting the box to the picture in both axes makes the bars go away
 * in every orientation, because there is nowhere left for them to be.
 *
 * Width and height are capped separately: a phone can be wider than the window
 * in landscape and taller than it in portrait, and whichever limit binds first
 * decides the scale.
 *
 * @param {object} p
 * @param {number} p.frameWidth
 * @param {number} p.frameHeight
 * @param {number} p.availableWidth   most the picture may occupy horizontally
 * @param {number} p.availableHeight  ...and vertically
 * @returns {{width:number, height:number}|null} null when not yet measurable
 *
 * NO MINIMUM SIZE, deliberately. A floor was written here and the tests proved
 * it could never fire: if the box is width-limited its width already equals
 * the space available, and if it is height-limited then growing to a floor
 * always overflows the height. The only way to honour a minimum is to break
 * the aspect ratio, and a stretched mirror is worse than a small one — so the
 * fit is the whole rule, and there is no second rule to conflict with it.
 */
export function panelBoxFor({ frameWidth, frameHeight, availableWidth, availableHeight }) {
    const fw = Number(frameWidth) || 0;
    const fh = Number(frameHeight) || 0;
    const aw = Number(availableWidth) || 0;
    const ah = Number(availableHeight) || 0;
    if (fw <= 0 || fh <= 0 || aw <= 0 || ah <= 0) return null;

    // `contain` again: the limiting dimension sets the scale.
    const scale = Math.min(aw / fw, ah / fh);
    return {
        width: Math.round(fw * scale),
        height: Math.round(fh * scale)
    };
}

/**
 * Width alone, for callers that only position horizontally.
 * Kept as a thin wrapper over `panelBoxFor` so there is one implementation of
 * the arithmetic rather than two that can drift.
 */
export function panelWidthFor({
    frameWidth, frameHeight, availableHeight, viewportWidth, maxFraction = 0.5
}) {
    const box = panelBoxFor({
        frameWidth, frameHeight,
        availableWidth: (Number(viewportWidth) || 0) * maxFraction,
        availableHeight
    });
    return box ? box.width : null;
}

/* =========================================================================
   7. SESSION OPTION BUILDING
   ========================================================================= */

/** Bounds that keep a spoken or stored setting from producing a dead session. */
export const MIRROR_LIMITS = {
    /* 0 means DEVICE NATIVE, and it is the default.
       Measured on a 1080x2400 phone: `maxSize` caps the LONGER edge, so the
       obvious-looking 1920 produced 864x1920 — a 20 % downscale of a screen
       that was already going to fit. "1080p" is not a maxSize on a 20:9
       display; native is, and at 8 Mbps the measured stream was 1.35 Mbps,
       so there was never a bandwidth reason to shrink it. */
    maxSize: { min: 320, max: 3840, default: 0 },
    videoBitRate: { min: 500_000, max: 40_000_000, default: 8_000_000 },
    maxFps: { min: 1, max: 120, default: 60 }
};

const CODECS = ['h264', 'h265', 'av1'];

/**
 * Builds the scrcpy option bag from user settings.
 *
 * Separated from the service so the defaults are assertable. `audio` is FALSE
 * and not configurable here — see mirrorService.js for why forwarding device
 * audio into a machine running an always-on microphone is a feedback loop, not
 * a feature.
 */
export function buildMirrorOptions(settings = {}) {
    const num = (v, spec) => {
        const n = Number(v);
        if (!Number.isFinite(n)) return spec.default;
        return clamp(Math.round(n), spec.min, spec.max);
    };

    /* maxSize takes 0 as a real value meaning "no limit", so it cannot go
       through the same clamp — `num` would floor it to 320 and mirror a
       postage stamp. */
    const size = (v) => {
        if (v === undefined || v === null || v === '') return MIRROR_LIMITS.maxSize.default;
        const n = Number(v);
        if (!Number.isFinite(n)) return MIRROR_LIMITS.maxSize.default;
        if (n <= 0) return 0;
        return clamp(Math.round(n), MIRROR_LIMITS.maxSize.min, MIRROR_LIMITS.maxSize.max);
    };

    const codec = CODECS.includes(String(settings.videoCodec)) ? settings.videoCodec : 'h264';

    return {
        maxSize: size(settings.maxSize),
        videoBitRate: num(settings.videoBitRate, MIRROR_LIMITS.videoBitRate),
        maxFps: num(settings.maxFps, MIRROR_LIMITS.maxFps),
        videoCodec: codec,

        /* AUDIO IS ON, AND RAW.
           It was off in the first build for a real reason: Jarvis runs an
           always-on microphone, so phone audio out of the speakers can be
           transcribed and fed back as a user turn — the self-echo class this
           project has already fixed twice. The mitigation is not to disable it
           but to rely on the same acoustic echo canceller that covers TTS:
           WebAudio playback in the renderer goes through Chromium's render
           path and IS seen by AEC, unlike the SAPI voice that bypassed it.
           The panel also offers a mute, and the risk is measured rather than
           assumed — see docs/SCREEN-MIRROR.md.

           `raw` rather than `opus`: scrcpy's raw audio is PCM s16le at 48 kHz
           stereo, about 1.5 Mbps, which is free on USB or a LAN — and it skips
           the decoder entirely, so it adds no codec latency at all. Opus would
           save bandwidth that is not scarce and cost the one thing that is. */
        audio: settings.audio !== false,
        audioCodec: 'raw',
        control: true,
        /* The device must not sleep under us while it is being watched, but
           the screen must not be forced on either: `--no-power-on` is how you
           mirror a phone that is face-down on the desk. */
        stayAwake: true,
        powerOn: settings.powerOn !== false,
        powerOffOnClose: false,
        clipboardAutosync: true,
        showTouches: settings.showTouches === true
    };
}
