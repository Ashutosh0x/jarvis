// Tests for screen-mirror routing and input translation.
//
// Two things are checked here that unit tests in this project have repeatedly
// failed to catch on their own:
//
//  1. PRECEDENCE. Every routing bug recorded in this repo (edgar->TYPE_TEXT,
//     "watch for whales"->WATCHLIST_ADD, "open chrome on my phone"->desktop)
//     was an ordering problem, not a regex problem. So the phone matchers this
//     parser has to run in front of are imported and asserted against directly.
//
//  2. COORDINATE ARITHMETIC. A wrong transform still injects a touch, just in
//     the wrong place, and the only symptom is "the mirror feels off". The
//     letterbox cases below are the ones that break the naive implementation.

import {
    parseMirrorCommand,
    mapPointerToDevice,
    webKeyToAndroid,
    metaStateFrom,
    isTextKey,
    buildMirrorOptions,
    createPreroll,
    describeScale,
    panelWidthFor,
    panelBoxFor,
    virtualFingerPoint,
    pinchPoints,
    nextPinchSpread,
    PINCH_SPREAD,
    MIRROR_LIMITS
} from '../mirrorIntent.js';
import { targetsPhone, routePhoneCommand } from '../phoneTools.js';
import { AndroidKeyCode, AndroidKeyEventMeta } from '@yume-chan/scrcpy';

let pass = 0, fail = 0;
const check = (n, c) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); };

/* --- start ---------------------------------------------------------------- */
{
    const starts = [
        'mirror my phone',
        'Mirror my phone',
        'show my phone screen',
        'mirror my phone screen',
        'cast my phone',
        'start mirroring my phone',
        'screen mirror my android',
        'stream my phone screen',
        'bring up my phone screen',
        'mirror my redmi',
        'mirror'
    ];
    for (const s of starts) {
        check(`start: "${s}"`, parseMirrorCommand(s)?.action === 'start');
    }
}

/* --- stop ----------------------------------------------------------------- */
{
    const stops = [
        'stop mirroring',
        'stop mirroring my phone',
        'close mirror',
        'close the mirror',
        'stop the mirror',
        'end mirroring',
        'stop casting my phone',
        'disconnect the phone mirror'
    ];
    for (const s of stops) {
        check(`stop: "${s}"`, parseMirrorCommand(s)?.action === 'stop');
    }
    // "stop" beats "start" when both words are present — this is the whole
    // reason the stop branch runs first.
    check('stop: beats the start verb it contains', parseMirrorCommand('stop mirroring').action === 'stop');
}

/* --- snapshot ------------------------------------------------------------- */
{
    check('snapshot: "take a phone screenshot"', parseMirrorCommand('take a phone screenshot')?.action === 'snapshot');
    check('snapshot: "screenshot my phone screen"', parseMirrorCommand('screenshot my phone screen')?.action === 'snapshot');
    check('snapshot: "grab my phone screen"', parseMirrorCommand('grab my phone screen')?.action === 'snapshot');
    // The DESKTOP screenshot command must survive untouched.
    check('snapshot: plain "take a screenshot" is not ours', parseMirrorCommand('take a screenshot') === null);
    check('snapshot: "screenshot this window" is not ours', parseMirrorCommand('screenshot this window') === null);
}

/* --- non-matches: the parser must decline everything it does not own ------- */
{
    const notOurs = [
        'what is the time',
        'read my screen',
        'what is on my screen',
        "what's on my phone screen",   // -> existing phone/desktop screen reading
        'open chrome on my phone',     // -> PHONE_TOOL
        'battery on my phone',         // -> PHONE_TOOL
        'why is my phone offline',     // -> COMPANION_STATUS
        'connect to my mobile',        // -> COMPANION_PAIR
        'start the chain stream',      // 'stream' with no phone subject
        'stream the latest news',
        /* Asking ABOUT mirroring is not asking TO mirror. This block was
           written before the guard existed and caught the false positive:
           the first line below satisfied both the verb and the subject. */
        'search for android screen mirroring apps',
        'google screen mirroring for redmi',
        'what is screen mirroring',
        'how do i mirror my phone',
        'tell me about phone mirroring',
        'show me my calendar',
        ''
    ];
    for (const s of notOurs) {
        check(`decline: "${s}"`, parseMirrorCommand(s) === null);
    }
}

/* --- PRECEDENCE against the phone matchers -------------------------------- */
{
    /* detectIntent checks targetsPhone() first today. Any mirror utterance that
       ALSO satisfies targetsPhone must therefore be routed by placing this
       parser above it — assert the overlap explicitly so the ordering
       requirement is visible rather than folklore. */
    const overlap = ['mirror to my phone', 'cast to my phone', 'stop mirroring to my phone'];
    for (const s of overlap) {
        check(`precedence: "${s}" is claimed by targetsPhone`, targetsPhone(s) === true);
        check(`precedence: "${s}" is a mirror command`, parseMirrorCommand(s) !== null);
    }

    // And the plain phrasings do NOT collide, so nothing is stolen from
    // phoneTools by putting the mirror parser first.
    for (const s of ['mirror my phone', 'show my phone screen', 'stop mirroring']) {
        check(`precedence: "${s}" is not a phone tool`, routePhoneCommand(s) === null);
    }

    // The reverse direction: real phone-tool commands must not become mirrors.
    for (const s of ['open whatsapp on my phone', 'flashlight on my phone', 'battery on my phone']) {
        check(`precedence: "${s}" stays a phone tool`, routePhoneCommand(s) !== null && parseMirrorCommand(s) === null);
    }
}

/* --- a pasted document is not a command ----------------------------------- */
{
    const doc = 'Android screen mirroring has become a common feature. '.repeat(12);
    check('paste: long text containing "mirror" is declined', doc.length > 280 && parseMirrorCommand(doc) === null);
}

/* --- pointer mapping ------------------------------------------------------ */
{
    // Exact fit: a 1080x2400 device in a 1080x2400 box, no letterbox at all.
    const exact = { left: 0, top: 0, width: 1080, height: 2400 };
    check('pointer: exact fit centre',
        JSON.stringify(mapPointerToDevice({ clientX: 540, clientY: 1200, rect: exact, videoWidth: 1080, videoHeight: 2400 }))
        === JSON.stringify({ x: 540, y: 1200, inside: true }));

    // Uniform downscale: same box, half size.
    const half = { left: 0, top: 0, width: 540, height: 1200 };
    const m = mapPointerToDevice({ clientX: 270, clientY: 600, rect: half, videoWidth: 1080, videoHeight: 2400 });
    check('pointer: uniform downscale doubles back', m.x === 540 && m.y === 1200 && m.inside);

    /* PILLARBOX — the case the naive "clientX/rect.width * videoWidth"
       implementation gets wrong. A tall 1080x2400 device drawn into a WIDE
       800x1200 box: scale = min(800/1080, 1200/2400) = 0.5, drawn 540x1200,
       so there are 130px bars on each side. The centre of the ELEMENT is the
       centre of the IMAGE; the naive version agrees here...  */
    const wide = { left: 0, top: 0, width: 800, height: 1200 };
    const centre = mapPointerToDevice({ clientX: 400, clientY: 600, rect: wide, videoWidth: 1080, videoHeight: 2400 });
    check('pointer: pillarbox centre maps to device centre', centre.x === 540 && centre.y === 1200);

    // ...and disagrees everywhere else. Left edge of the IMAGE is x=130 in the
    // element; the naive version would call that device x=175.
    const leftEdge = mapPointerToDevice({ clientX: 130, clientY: 600, rect: wide, videoWidth: 1080, videoHeight: 2400 });
    check('pointer: pillarbox left image edge is device x=0', leftEdge.x === 0 && leftEdge.inside);

    // A point over the black bar is reported as outside, but still clamped.
    const bar = mapPointerToDevice({ clientX: 40, clientY: 600, rect: wide, videoWidth: 1080, videoHeight: 2400 });
    check('pointer: letterbox bar reports inside=false', bar.inside === false);
    check('pointer: letterbox bar still clamps into range', bar.x === 0 && bar.y === 1200);

    /* LETTERBOX — landscape device in a portrait box. */
    const tall = { left: 0, top: 0, width: 600, height: 1000 };
    const land = mapPointerToDevice({ clientX: 300, clientY: 500, rect: tall, videoWidth: 2400, videoHeight: 1080 });
    check('pointer: letterbox centre maps to device centre', land.x === 1200 && land.y === 540);

    // Element offset in the viewport must be subtracted.
    const offset = { left: 200, top: 100, width: 1080, height: 2400 };
    const off = mapPointerToDevice({ clientX: 200, clientY: 100, rect: offset, videoWidth: 1080, videoHeight: 2400 });
    check('pointer: rect offset subtracted', off.x === 0 && off.y === 0);

    // Clamping: bottom-right corner must be a valid index, never width/height.
    const corner = mapPointerToDevice({ clientX: 1080, clientY: 2400, rect: exact, videoWidth: 1080, videoHeight: 2400 });
    check('pointer: bottom-right clamps to w-1/h-1', corner.x === 1079 && corner.y === 2399);

    // Degenerate inputs return something injectable rather than NaN.
    check('pointer: zero frame size is inside=false',
        mapPointerToDevice({ clientX: 10, clientY: 10, rect: exact, videoWidth: 0, videoHeight: 0 }).inside === false);
    check('pointer: missing rect does not throw',
        mapPointerToDevice({ clientX: 10, clientY: 10, rect: null, videoWidth: 1080, videoHeight: 2400 }).x === 0);
    check('pointer: NaN pointer clamps rather than emitting NaN',
        Number.isInteger(mapPointerToDevice({ clientX: NaN, clientY: 0, rect: exact, videoWidth: 1080, videoHeight: 2400 }).x));
}

/* --- key mapping ---------------------------------------------------------- */
{
    check('key: letters map straight through', webKeyToAndroid({ code: 'KeyA' }) === AndroidKeyCode.KeyA);
    check('key: Enter', webKeyToAndroid({ code: 'Enter' }) === AndroidKeyCode.Enter);
    check('key: Backspace', webKeyToAndroid({ code: 'Backspace' }) === AndroidKeyCode.Backspace);
    check('key: arrows', webKeyToAndroid({ code: 'ArrowUp' }) === AndroidKeyCode.ArrowUp);
    check('key: NumpadEnter aliases to Enter', webKeyToAndroid({ code: 'NumpadEnter' }) === AndroidKeyCode.Enter);

    /* An unmapped key must be null, NOT 0. Keycode 0 is AKEYCODE_UNKNOWN and
       injecting it is a silent no-op that looks like a dropped keystroke; the
       caller needs to be able to tell "no equivalent" from "keycode zero". */
    check('key: unknown code is null', webKeyToAndroid({ code: 'Fn' }) === null);
    check('key: missing code is null', webKeyToAndroid({}) === null);
    check('key: null event is null', webKeyToAndroid(null) === null);
    check('key: null is not 0', webKeyToAndroid({ code: 'Fn' }) !== 0);
}

/* --- modifier packing ----------------------------------------------------- */
{
    check('meta: none', metaStateFrom({}) === AndroidKeyEventMeta.None);
    const shift = metaStateFrom({ shiftKey: true });
    check('meta: shift sets the generic bit', (shift & AndroidKeyEventMeta.Shift) !== 0);
    check('meta: shift also sets the side bit', (shift & AndroidKeyEventMeta.ShiftLeft) !== 0);
    const combo = metaStateFrom({ ctrlKey: true, shiftKey: true });
    check('meta: ctrl+shift combine', (combo & AndroidKeyEventMeta.Ctrl) !== 0 && (combo & AndroidKeyEventMeta.Shift) !== 0);
    check('meta: null event is None', metaStateFrom(null) === AndroidKeyEventMeta.None);
}

/* --- text vs keycode ------------------------------------------------------ */
{
    check('text: a letter is text', isTextKey({ key: 'a' }) === true);
    check('text: a digit is text', isTextKey({ key: '7' }) === true);
    check('text: a space is text', isTextKey({ key: ' ' }) === true);
    check('text: an accented char is text', isTextKey({ key: 'é' }) === true);
    check('text: Enter is not text', isTextKey({ key: 'Enter' }) === false);
    check('text: ArrowUp is not text', isTextKey({ key: 'ArrowUp' }) === false);
    check('text: ctrl+c is a shortcut, not text', isTextKey({ key: 'c', ctrlKey: true }) === false);
    check('text: missing key is not text', isTextKey({}) === false);
    /* An emoji is a single code point but two UTF-16 units; length would say 2
       and drop it. The spread counts code points. */
    check('text: astral character counts as one', isTextKey({ key: '😀' }) === true);
}

/* --- pre-decoder buffer ---------------------------------------------------
   This exists because of a bug found only by driving the real renderer: the
   subscription was opened after start() returned, the configuration packet had
   already gone by, and WebCodecs then rejected every single frame with
   "Decoder not configured" — a black canvas while every other layer reported a
   healthy session. The property that matters is that configuration SURVIVES
   and stays AHEAD of the frames it configures. */
{
    const cfg = (n) => ({ type: 'configuration', data: `cfg${n}` });
    const key = (n) => ({ type: 'data', keyframe: true, data: `key${n}` });
    const delta = (n) => ({ type: 'data', keyframe: false, data: `d${n}` });

    {
        const p = createPreroll();
        p.push(cfg(1)); p.push(key(1)); p.push(delta(1)); p.push(delta(2));
        const out = p.drain();
        check('preroll: keeps everything within one GOP', out.length === 4);
        check('preroll: configuration comes first', out[0].type === 'configuration');
        check('preroll: order preserved', out.map((x) => x.data).join(',') === 'cfg1,key1,d1,d2');
        check('preroll: drain empties the buffer', p.size === 0);
        check('preroll: draining twice yields nothing', p.drain().length === 0);
    }

    {
        /* THE BOUND. A slow handshake must not buffer megabytes, and frames
           older than the newest keyframe are undecodable from cold anyway. */
        const p = createPreroll();
        p.push(cfg(1));
        p.push(key(1));
        for (let i = 0; i < 500; i++) p.push(delta(i));
        p.push(key(2));
        for (let i = 0; i < 3; i++) p.push(delta(1000 + i));
        const out = p.drain();
        check('preroll: a keyframe discards the frames before it', out.length === 5);
        check('preroll: configuration is NEVER discarded', out[0].type === 'configuration');
        check('preroll: the newest keyframe leads the frames', out[1].data === 'key2');
        check('preroll: only the frames after it survive',
            out.map((x) => x.data).join(',') === 'cfg1,key2,d1000,d1001,d1002');
    }

    {
        // Two configuration packets (a mid-session encoder restart) both survive.
        const p = createPreroll();
        p.push(cfg(1)); p.push(key(1)); p.push(cfg(2)); p.push(key(2));
        const out = p.drain();
        check('preroll: every configuration packet is kept',
            out.filter((x) => x.type === 'configuration').length === 2);
        check('preroll: a keyframe does not drop configuration',
            out.map((x) => x.data).join(',') === 'cfg1,cfg2,key2');
    }

    {
        const p = createPreroll();
        p.push(null); p.push(undefined);
        check('preroll: junk is ignored rather than queued', p.size === 0);
        p.push(cfg(1));
        p.clear();
        check('preroll: clear empties it', p.size === 0);
    }
}

/* --- the virtual finger (pinch / rotate) ----------------------------------
   scrcpy's own convention, reimplemented here so muscle memory transfers:
   Ctrl inverts both axes, Shift inverts x, Ctrl+Shift inverts y. */
{
    const W = 1080, H = 2400;
    const at = (x, y, mods) => virtualFingerPoint({ x, y, width: W, height: H, ...mods });

    const ctrl = at(300, 600, { ctrl: true });
    check('virtual: ctrl inverts both axes', ctrl.x === 779 && ctrl.y === 1799);

    const shift = at(300, 600, { shift: true });
    check('virtual: shift inverts x only', shift.x === 779 && shift.y === 600);

    const both = at(300, 600, { ctrl: true, shift: true });
    check('virtual: ctrl+shift inverts y only', both.x === 300 && both.y === 1799);

    /* NO MODIFIER MUST BE null, NOT (0,0). A second finger silently placed at
       the origin turns every ordinary drag into a pinch against the corner. */
    check('virtual: no modifier means no second finger', at(300, 600, {}) === null);

    // The centre is its own mirror image, so a pinch there is symmetric.
    const mid = at((W - 1) / 2, (H - 1) / 2, { ctrl: true });
    check('virtual: the centre maps to itself', mid.x === Math.round((W - 1) / 2) && mid.y === Math.round((H - 1) / 2));

    // Inversion must stay a valid index, never equal to the dimension.
    const corner = at(0, 0, { ctrl: true });
    check('virtual: corner inverts to the far corner', corner.x === W - 1 && corner.y === H - 1);
    check('virtual: never returns an out-of-range index',
        at(W - 1, H - 1, { ctrl: true }).x === 0);

    check('virtual: a zero-size frame yields null',
        virtualFingerPoint({ x: 1, y: 1, width: 0, height: 0, ctrl: true }) === null);
}

/* --- trackpad pinch geometry ---------------------------------------------- */
{
    const W = 1080, H = 2400;
    const pts = pinchPoints({ centerX: 540, centerY: 1200, spread: 200, width: W, height: H });
    check('pinch: two points straddle the anchor', pts.a.y === 1000 && pts.b.y === 1400);
    check('pinch: both share the anchor x', pts.a.x === 540 && pts.b.x === 540);
    check('pinch: the points are distinct', pts.a.y !== pts.b.y);

    // Near an edge the points clamp rather than leaving the screen.
    const edge = pinchPoints({ centerX: 540, centerY: 10, spread: 400, width: W, height: H });
    check('pinch: clamps to the top edge', edge.a.y === 0);
    check('pinch: stays in range at the edge', edge.b.y < H);

    // Spread accumulation is bounded in both directions.
    check('pinch: spread grows on negative delta', nextPinchSpread(120, -10) === 140);
    check('pinch: spread shrinks on positive delta', nextPinchSpread(120, 10) === 100);
    check('pinch: spread has a floor', nextPinchSpread(PINCH_SPREAD.min, 999) === PINCH_SPREAD.min);
    check('pinch: spread has a ceiling', nextPinchSpread(PINCH_SPREAD.max, -999) === PINCH_SPREAD.max);
    check('pinch: garbage delta leaves the spread alone', nextPinchSpread(120, NaN) === 120);
}

/* --- native vs scaled reporting ------------------------------------------- */
{
    const native = { width: 1080, height: 2400 };

    check('scale: exact match is native',
        describeScale({ width: 1080, height: 2400 }, native).native === true);
    check('scale: native label says so',
        /native/.test(describeScale({ width: 1080, height: 2400 }, native).label));

    /* THE ROTATION TRAP. A phone held sideways streams 2400x1080 while
       `wm size` still reports 1080x2400. Comparing width-to-width would call a
       perfectly native landscape stream "scaled" and print a bogus percentage,
       which is exactly the kind of confident wrong number this project bans. */
    check('scale: a rotated native stream is still native',
        describeScale({ width: 2400, height: 1080 }, native).native === true);

    // The real downscale this feature was built to expose.
    const scaled = describeScale({ width: 864, height: 1920 }, native);
    check('scale: 864x1920 against 1080x2400 is not native', scaled.native === false);
    check('scale: reports 80%', scaled.percent === 80);
    check('scale: names the device size', /1080×2400/.test(scaled.label));

    /* UNKNOWN IS NOT NATIVE. A device that did not answer `wm size` must not
       have its stream labelled native by default. */
    const unknown = describeScale({ width: 1080, height: 2400 }, null);
    check('scale: no device size means unknown, not native', unknown.native === null);
    check('scale: unknown label does not claim native', !/native/.test(unknown.label));
    check('scale: unknown still shows the dimensions', unknown.label === '1080×2400');

    check('scale: a missing stream size yields nothing', describeScale(null, native).label === '');
    check('scale: zero dimensions yield nothing',
        describeScale({ width: 0, height: 0 }, native).native === null);
}

/* --- panel box: BOTH axes, so rotation leaves no bars ---------------------
   Measured on a real rotation before this existed: a landscape 2400x1080 phone
   in a full-height 600px panel drew a 600x270 picture with 530px of black
   above and below. Sizing only the width cannot fix that — the box has to take
   the device's shape in both directions. */
{
    const VW = 1200, VH = 800;
    const avail = { availableWidth: VW * 0.92, availableHeight: VH };

    const portrait = panelBoxFor({ frameWidth: 1080, frameHeight: 2400, ...avail });
    check('box: portrait is height-limited', portrait.height === 800);
    check('box: portrait width follows the aspect', portrait.width === 360);
    check('box: portrait aspect matches the device',
        Math.abs(portrait.width / portrait.height - 1080 / 2400) < 0.005);

    const landscape = panelBoxFor({ frameWidth: 2400, frameHeight: 1080, ...avail });
    check('box: landscape is width-limited', landscape.width === Math.round(VW * 0.92));
    check('box: landscape height follows the aspect',
        Math.abs(landscape.width / landscape.height - 2400 / 1080) < 0.005);
    /* THE BUG, pinned. The old width-only fit left 530px of black here; the
       box now shrinks in height instead, so there is nowhere for bars to be. */
    check('box: landscape is far shorter than the window', landscape.height < VH * 0.7);
    check('box: landscape fits inside the window', landscape.width <= VW && landscape.height <= VH);

    // Rotating back and forth must be stable, not drift.
    const back = panelBoxFor({ frameWidth: 1080, frameHeight: 2400, ...avail });
    check('box: rotation is reversible', back.width === portrait.width && back.height === portrait.height);

    // A square-ish tablet takes whichever limit binds first.
    const square = panelBoxFor({ frameWidth: 2000, frameHeight: 2000, ...avail });
    check('box: a square device is height-limited here', square.height === 800 && square.width === 800);

    /* THE ASPECT RATIO IS THE ONLY RULE. There is no minimum size: one was
       written and these cases proved it unreachable, because a floor can only
       be honoured by stretching. A small correct picture beats a distorted
       one, so an awkward window simply gets a small mirror. */
    for (const [aw, ah, label] of [
        [900, 120, 'a very short window'],
        [120, 2000, 'a very narrow window'],
        [40, 40, 'a tiny window']
    ]) {
        const box = panelBoxFor({ frameWidth: 1080, frameHeight: 2400, availableWidth: aw, availableHeight: ah });
        check(`box: ${label} keeps the device aspect`,
            Math.abs(box.width / box.height - 1080 / 2400) < 0.02);
        check(`box: ${label} still fits`, box.width <= aw && box.height <= ah);
    }

    check('box: unusable input is null',
        panelBoxFor({ frameWidth: 0, frameHeight: 0, ...avail }) === null);
    check('box: zero space is null',
        panelBoxFor({ frameWidth: 1080, frameHeight: 2400, availableWidth: 0, availableHeight: 0 }) === null);

    // The width-only helper still agrees with the box it delegates to.
    check('box: panelWidthFor delegates to panelBoxFor',
        panelWidthFor({ frameWidth: 1080, frameHeight: 2400, availableHeight: 800, viewportWidth: 1200, maxFraction: 0.92 })
        === portrait.width);
}

/* --- panel geometry ------------------------------------------------------- */
{
    // A 20:9 portrait phone in a 1000px-tall stage wants 1000*(1080/2400)=450px.
    const w = panelWidthFor({
        frameWidth: 1080, frameHeight: 2400, availableHeight: 1000, viewportWidth: 1920
    });
    check('panel: portrait width matches the aspect ratio', w === 450);

    /* A LANDSCAPE device would ask for a panel wider than the window; the
       ceiling has to win, and the stage letterboxes vertically instead. */
    const land = panelWidthFor({
        frameWidth: 2400, frameHeight: 1080, availableHeight: 1000, viewportWidth: 1920
    });
    check('panel: landscape is capped at the viewport fraction', land === 960);
    check('panel: landscape never exceeds the window', land <= 1920);

    /* An 800px-tall window leaves ~542px of stage; a 20:9 phone wants 244px.
       The floor must sit BELOW that or it forces side bars back on — measured,
       a 260 floor left 16px of them. */
    const typical = panelWidthFor({
        frameWidth: 1080, frameHeight: 2400, availableHeight: 542, viewportWidth: 1200
    });
    check('panel: a 20:9 phone in an 800px window fits exactly', typical === 244);

    /* A very short window yields a small mirror, not a stretched one. There is
       no floor — see the panelBoxFor block above for why one cannot exist
       without breaking the aspect ratio. */
    const short = panelWidthFor({
        frameWidth: 1080, frameHeight: 2400, availableHeight: 200, viewportWidth: 1920
    });
    check('panel: a very short window stays proportional', short === 90);

    // ...unless the window itself is narrower than the floor.
    const tiny = panelWidthFor({
        frameWidth: 1080, frameHeight: 2400, availableHeight: 200, viewportWidth: 400
    });
    check('panel: the floor never exceeds the ceiling', tiny <= 200);

    check('panel: integer result', Number.isInteger(w));
    check('panel: unusable inputs return null',
        panelWidthFor({ frameWidth: 0, frameHeight: 0, availableHeight: 100, viewportWidth: 100 }) === null);
    check('panel: a zero viewport returns null',
        panelWidthFor({ frameWidth: 1080, frameHeight: 2400, availableHeight: 100, viewportWidth: 0 }) === null);
}

/* --- option building ------------------------------------------------------ */
{
    const d = buildMirrorOptions();

    /* DEVICE NATIVE by default, expressed as maxSize 0.
       Measured on the 1080x2400 M2101K6P: maxSize 1920 caps the LONGER edge,
       so it produced 864x1920 — the "1080p" setting silently made the picture
       narrower than 1080. The stream at native size measured 1.35 Mbps against
       an 8 Mbps ceiling, so the downscale bought nothing. */
    check('options: default is device native', d.maxSize === 0);
    check('options: default 8 Mbps', d.videoBitRate === 8_000_000);
    check('options: default 60 fps', d.maxFps === 60);
    check('options: default codec h264', d.videoCodec === 'h264');
    check('options: control on', d.control === true);
    check('options: stayAwake on', d.stayAwake === true);
    check('options: powerOffOnClose off', d.powerOffOnClose === false);

    /* AUDIO IS ON by default, and RAW.
       It shipped off, because Jarvis runs an always-on microphone and phone
       audio out of the speakers can be transcribed back as a user turn. It is
       on now by explicit request, mitigated by the acoustic echo canceller
       that already covers WebAudio TTS plus a mute — and `raw` because PCM
       adds no decoder latency, which is the thing being optimised. */
    check('options: audio is on by default', d.audio === true);
    check('options: audio can be switched off', buildMirrorOptions({ audio: false }).audio === false);
    check('options: raw PCM, so there is no decode step', d.audioCodec === 'raw');

    check('options: bitrate clamped to the ceiling',
        buildMirrorOptions({ videoBitRate: 999_000_000 }).videoBitRate === MIRROR_LIMITS.videoBitRate.max);
    check('options: fps clamped to the floor',
        buildMirrorOptions({ maxFps: 0 }).maxFps === MIRROR_LIMITS.maxFps.min);
    check('options: garbage falls back to the default',
        buildMirrorOptions({ maxSize: 'huge' }).maxSize === MIRROR_LIMITS.maxSize.default);

    /* 0 is a VALUE here, not a missing setting. Sending it through the same
       clamp as the other numbers would floor it to 320 and mirror a postage
       stamp — the exact bug this branch exists to prevent. */
    check('options: an explicit 0 stays 0 (native)', buildMirrorOptions({ maxSize: 0 }).maxSize === 0);
    check('options: a negative size means native, not 320',
        buildMirrorOptions({ maxSize: -1 }).maxSize === 0);
    check('options: a real cap is still honoured',
        buildMirrorOptions({ maxSize: 1280 }).maxSize === 1280);
    check('options: a cap below the floor is raised to it',
        buildMirrorOptions({ maxSize: 100 }).maxSize === MIRROR_LIMITS.maxSize.min);
    check('options: a cap above the ceiling is lowered to it',
        buildMirrorOptions({ maxSize: 99999 }).maxSize === MIRROR_LIMITS.maxSize.max);
    check('options: unknown codec falls back to h264',
        buildMirrorOptions({ videoCodec: 'vp9' }).videoCodec === 'h264');
    check('options: h265 is accepted',
        buildMirrorOptions({ videoCodec: 'h265' }).videoCodec === 'h265');
    check('options: fractional sizes are rounded to integers',
        Number.isInteger(buildMirrorOptions({ maxSize: 1279.6 }).maxSize));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
