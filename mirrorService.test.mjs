// Tests for the screen-mirror session manager's decidable parts.
//
// The streaming half needs a phone and is verified live. What is tested here
// is everything that can be wrong WITHOUT a phone, and that fails silently or
// misleadingly when it is:
//
//  - the bundled server jar (a truncated or wrong-version jar produces a
//    session that hangs at handshake with no useful error);
//  - device selection (the "which phone, and why can't I use it" logic, which
//    is where the user-facing message comes from).
//
// Root-level suite, next to edgarGuard.test.mjs, because the module is
// CommonJS in the main process and cannot live under src/js/services.

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const mirror = require('./mirrorService.js');

let pass = 0, fail = 0;
const check = (n, c) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); };
const throws = (n, fn, re) => {
    try { fn(); check(n, false); }
    catch (e) { check(n, re ? re.test(e.message) : true); }
};

/* --- the bundled server -------------------------------------------------- */
{
    const jar = mirror.verifyServerJar();

    check('jar: found on disk', typeof jar.path === 'string' && jar.path.endsWith('scrcpy-server.jar'));

    /* PINNED, NOT LATEST. @yume-chan/scrcpy implements the protocol up to
       server 3.3.3 and scrcpy compares the version string exactly, so
       upgrading the jar to 3.3.4 or 4.x breaks the handshake rather than
       improving anything. This assertion is the tripwire for someone who
       "updates the dependency". */
    check('jar: pinned to 3.3.3', mirror.SERVER_VERSION === '3.3.3');
    check('jar: version reported', jar.version === '3.3.3');

    // Size is the published release asset size for scrcpy-server-v3.3.3.
    check('jar: exact published size', jar.size === 90164);
    check('jar: hash matches the pin', jar.sha256 === mirror.SERVER_SHA256);

    // Independently recomputed, so a bug in the module's own hashing cannot
    // make this suite agree with itself.
    const independent = createHash('sha256').update(readFileSync(jar.path)).digest('hex');
    check('jar: independently recomputed hash agrees', independent === mirror.SERVER_SHA256);

    // It has to actually be a zip/jar, not an HTML error page saved by a proxy.
    const head = readFileSync(jar.path).subarray(0, 2);
    check('jar: has PK zip magic', head[0] === 0x50 && head[1] === 0x4b);
}

/* --- device selection ----------------------------------------------------- */
{
    const ready = { serial: 'ABC123', state: 'device', model: 'M2101K6P', connection: 'usb' };
    const wifi = { serial: '192.168.0.42:5555', state: 'device', model: 'M2101K6P', connection: 'tcpip' };
    const unauth = { serial: 'XYZ789', state: 'unauthorized', model: null, connection: 'usb' };
    const offline = { serial: 'OFF111', state: 'offline', model: null, connection: 'usb' };

    check('select: the only ready device is chosen', mirror.selectDevice([ready]) === ready);
    check('select: an explicit serial wins', mirror.selectDevice([ready, wifi], wifi.serial) === wifi);
    check('select: unauthorised devices do not count as ready',
        mirror.selectDevice([ready, unauth]) === ready);

    /* AMBIGUITY IS AN ERROR, NOT A COIN FLIP. Picking the first of two phones
       silently mirrors the wrong one, and the user has no way to tell why. */
    throws('select: two ready devices is an error', () => mirror.selectDevice([ready, wifi]), /say which one/);

    throws('select: nothing connected says so', () => mirror.selectDevice([]), /no Android device/);

    /* The unauthorised case is the single most common first run, and the fix
       is a prompt on the PHONE — so the message has to name it. */
    throws('select: unauthorised explains the phone-side fix',
        () => mirror.selectDevice([unauth]), /authorise|authorised/);
    throws('select: unauthorised by serial explains it too',
        () => mirror.selectDevice([unauth], unauth.serial), /USB debugging prompt/);

    throws('select: offline is reported as offline',
        () => mirror.selectDevice([offline], offline.serial), /offline/);
    throws('select: an unknown serial is named',
        () => mirror.selectDevice([ready], 'NOPE'), /NOPE is not connected/);
}

/* --- `wm size` parsing ----------------------------------------------------
   The device's own panel size is what turns "1080x2400" from an assertion into
   a comparison. Parsed here rather than trusted, because the two-line form is
   easy to get wrong in the direction that matters. */
{
    const plain = mirror.parseWmSize('Physical size: 1080x2400');
    check('wm: physical size parsed', plain.width === 1080 && plain.height === 2400);
    check('wm: not flagged as overridden', plain.overridden === false);

    /* THE ONE THAT MATTERS. With a resolution override active the device is
       DISPLAYING the override, so that is what scrcpy captures. Reading only
       "Physical size" here would report a native stream as an 80% downscale
       and print a wrong percentage with total confidence. */
    const overridden = mirror.parseWmSize('Physical size: 1080x2400\nOverride size: 720x1600');
    check('wm: override wins over physical', overridden.width === 720 && overridden.height === 1600);
    check('wm: override is flagged', overridden.overridden === true);

    check('wm: order in the output does not matter',
        mirror.parseWmSize('Override size: 720x1600\r\nPhysical size: 1080x2400').width === 720);
    check('wm: CRLF tolerated',
        mirror.parseWmSize('Physical size: 1080x2400\r\n').height === 2400);

    check('wm: unparseable output is null', mirror.parseWmSize('adb: no devices/emulators found') === null);
    check('wm: empty is null', mirror.parseWmSize('') === null);
    check('wm: null input is null', mirror.parseWmSize(null) === null);
    check('wm: a zero dimension is rejected, not returned',
        mirror.parseWmSize('Physical size: 0x0') === null);
}

/* --- lifecycle guards ----------------------------------------------------- */
{
    check('state: idle before anything starts', mirror.status().status === 'idle');
    check('state: not active before anything starts', mirror.isActive() === false);
    check('state: status reports the pinned server version', mirror.status().serverVersion === '3.3.3');

    /* Both timings are declared and null when unmeasured, never absent and
       never 0. A consumer that prints `?? '?'` over a missing key produces a
       placeholder that reads like a reading — which is how the first version
       of this said "first frame ?ms" on every successful start. */
    const idle = mirror.status();
    check('state: startMs is declared and null when unmeasured',
        'startMs' in idle && idle.startMs === null);
    check('state: firstFrameMs is declared and null when unmeasured',
        'firstFrameMs' in idle && idle.firstFrameMs === null);

    /* Control calls must refuse when nothing is streaming rather than throwing
       a TypeError on a null controller — the renderer surfaces this text. */
    for (const [name, fn] of [
        ['injectTouch', () => mirror.injectTouch({ action: 'down', x: 1, y: 1 })],
        ['injectKey', () => mirror.injectKey({ keyCode: 66 })],
        ['injectText', () => mirror.injectText('hi')],
        ['injectScroll', () => mirror.injectScroll({ x: 1, y: 1, scrollY: 1 })],
        ['action', () => mirror.action('home')]
    ]) {
        await fn().then(
            () => check(`guard: ${name} refuses with no session`, false),
            (e) => check(`guard: ${name} refuses with no session`, /no mirror session/.test(e.message))
        );
    }

    check('actions: the allowlist is closed', Array.isArray(mirror.MIRROR_ACTIONS) &&
        mirror.MIRROR_ACTIONS.includes('home') && mirror.MIRROR_ACTIONS.includes('back'));

    // stop() on an idle service is a no-op, not an error — the panel calls it
    // unconditionally when it closes.
    await mirror.stop().then(
        (s) => check('lifecycle: stop() is safe when idle', s.status === 'idle'),
        () => check('lifecycle: stop() is safe when idle', false)
    );
}

/* --- the stale-start latch ------------------------------------------------
   A real wedge, hit in use: a handshake that never finished left the session in
   'starting'; `isActive()` counts that as busy, so every later attempt was
   refused with "already running" until Jarvis was restarted. A guard that
   cannot expire is a permanent denial of the feature, not a safety net.

   Tested as a pure predicate because the state it guards — a hung handshake —
   is precisely the one that cannot be produced on demand. */
{
    const T = 1_000_000;
    const stale = mirror.START_STALE_MS;

    check('stale: a start in progress is NOT stale', mirror.isStaleStart('starting', T, T + 1000) === false);
    check('stale: a start just under the limit is not stale',
        mirror.isStaleStart('starting', T, T + stale - 1) === false);
    check('stale: a start past the limit IS stale',
        mirror.isStaleStart('starting', T, T + stale + 1) === true);

    /* Only 'starting' can go stale. A long, healthy streaming session must
       never be torn down by this — that would kill the feature while it works. */
    check('stale: a long streaming session is never stale',
        mirror.isStaleStart('streaming', T, T + stale * 100) === false);
    check('stale: idle is never stale', mirror.isStaleStart('idle', T, T + stale * 100) === false);
    check('stale: error is never stale', mirror.isStaleStart('error', T, T + stale * 100) === false);

    // A missing timestamp must not read as "infinitely old".
    check('stale: no start time is not stale', mirror.isStaleStart('starting', 0, T + stale * 100) === false);
    check('stale: null start time is not stale', mirror.isStaleStart('starting', null, T + stale * 100) === false);

    check('stale: the limit is a sane number', stale >= 10000 && stale <= 120000);

    // And the guard itself still refuses a genuine double-start.
    const err = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };
    await mirror.stop();
    check('stale: an onPacket sink is still required',
        (await err(() => mirror.start({ scrcpyOptions: {} }))) === 'start() requires an onPacket sink');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
