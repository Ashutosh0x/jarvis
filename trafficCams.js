/* =========================================================================
   PUBLIC TRAFFIC CAMERAS — live road views, on the globe.

   WHAT THIS IS, AND WHAT IT IS DELIBERATELY NOT.

   These are government ROAD cameras: Transport for London's JamCams and
   Singapore LTA's traffic images. They exist to show congestion, they are
   published openly by the authorities that run them, and they point at
   carriageways. This is not a surveillance layer and nothing here searches for
   cameras pointed at people, private property, or anything a third party did
   not publish for this purpose.

   THE RENDERER NEVER TOUCHES A THIRD-PARTY URL. Every frame is fetched HERE and
   handed across as a data URI. That matters more than usual: a camera feed is
   an arbitrary remote host chosen from a list this app did not write, and
   letting the renderer load it directly would mean an <img src> pointed at an
   untrusted origin from a page that also holds the user's session. Fetching in
   main keeps the renderer's origin clean and means one place can enforce the
   host allowlist below.

   HOSTS ARE ALLOWLISTED. A feed that changed its image host — or an upstream
   response that carried an unexpected URL — cannot make this fetch anything
   else. The check is on the parsed hostname, not a substring, because
   "tfl.gov.uk.evil.com" contains "tfl.gov.uk".

   NOTHING IS CACHED TO DISK. These are live views; a stale frame is worse than
   no frame, and writing road imagery to the user's disk is not something this
   feature needs to do.
   ========================================================================= */

const TIMEOUT_MS = 12000;
/* The camera LIST changes rarely — positions are fixed infrastructure. The
   images do not, so only the list is cached. */
const LIST_TTL_MS = 6 * 60 * 60 * 1000;

/** Only these hosts may be fetched. Parsed hostname, exact or suffix match. */
const ALLOWED_HOSTS = [
    'api.tfl.gov.uk',
    's3-eu-west-1.amazonaws.com',
    'api.data.gov.sg',
    'images.data.gov.sg',
    /* Windy serves its webcam frames through an image proxy. */
    'imgproxy.windy.com',
    'api.windy.com'
];

const windyKey = () => process.env.WINDY_WEBCAMS_API_KEY || '';

function hostAllowed(url) {
    try {
        const h = new URL(url).hostname.toLowerCase();
        return ALLOWED_HOSTS.some((a) => h === a || h.endsWith(`.${a}`));
    } catch {
        return false;
    }
}

let cache = { at: 0, cams: null };

/* URLs this process has handed to the renderer recently, so `frame()` can
   accept them. Windy's image URLs are token-signed and expire in ten minutes,
   so they cannot live in the six-hour list cache — they are recorded here as
   each `near()` call offers them, and pruned. Without this a Windy frame would
   be refused as "unknown-camera" the moment it was clicked. */
const recentUrls = new Map();
const RECENT_TTL_MS = 12 * 60 * 1000;

function rememberUrl(url) {
    if (url) recentUrls.set(url, Date.now());
    /* Prune opportunistically rather than on a timer. */
    if (recentUrls.size > 400) {
        const cutoff = Date.now() - RECENT_TTL_MS;
        for (const [u, t] of recentUrls) if (t < cutoff) recentUrls.delete(u);
    }
}

function urlOffered(url) {
    const t = recentUrls.get(url);
    return !!t && Date.now() - t < RECENT_TTL_MS;
}

/** TfL JamCams — 882 cameras across London, each with a JPEG and a short MP4. */
async function fetchTfl() {
    const res = await fetch('https://api.tfl.gov.uk/Place/Type/JamCam', {
        signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!res.ok) throw new Error(`TfL HTTP ${res.status}`);
    const json = await res.json();
    const prop = (c, k) => (c.additionalProperties || []).find((a) => a.key === k)?.value;

    const out = [];
    for (const c of Array.isArray(json) ? json : []) {
        /* `available` is TfL's own word for "this camera is working". A
           camera that says it is down must not become a marker that opens on
           to nothing. */
        if (String(prop(c, 'available')).toLowerCase() !== 'true') continue;
        const lat = Number(c.lat), lng = Number(c.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        const image = prop(c, 'imageUrl');
        const video = prop(c, 'videoUrl');
        if (!image && !video) continue;
        out.push({
            id: `tfl:${c.id}`,
            name: String(c.commonName || 'London camera'),
            lat, lng,
            image: image || null,
            video: video || null,
            view: prop(c, 'view') || null,
            operator: 'Transport for London',
            city: 'London'
        });
    }
    return out;
}

/** Singapore LTA — a handful of expressway cameras, JPEG only. */
async function fetchSingapore() {
    const res = await fetch('https://api.data.gov.sg/v1/transport/traffic-images', {
        signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!res.ok) throw new Error(`LTA HTTP ${res.status}`);
    const json = await res.json();
    const cams = json?.items?.[0]?.cameras || [];
    const out = [];
    for (const c of cams) {
        const lat = Number(c?.location?.latitude), lng = Number(c?.location?.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || !c.image) continue;
        out.push({
            id: `sg:${c.camera_id}`,
            name: `Expressway camera ${c.camera_id}`,
            lat, lng,
            image: c.image,
            video: null,
            view: null,
            operator: 'LTA Singapore',
            city: 'Singapore'
        });
    }
    return out;
}

/**
 * Windy webcams near a point.
 *
 * QUERIED PER-LOCATION, unlike the government feeds. Windy indexes ~70,000
 * opt-in public webcams worldwide and answers a nearby-radius query directly,
 * so there is no global list to cache — and its image URLs expire in ten
 * minutes, which would make caching them wrong anyway.
 *
 * Optional: with no key this returns nothing and the government feeds still
 * cover London and Singapore.
 */
async function fetchWindyNear(lat, lng, radiusKm, limit) {
    if (!windyKey()) return [];
    /* Windy's nearby filter is lat,lng,radius-in-km. */
    const url = `https://api.windy.com/webcams/api/v3/webcams`
        + `?nearby=${lat},${lng},${Math.min(250, Math.max(1, radiusKm))}`
        + `&limit=${Math.min(50, Math.max(1, limit))}`
        + `&include=location,images`;
    const res = await fetch(url, {
        headers: { 'x-windy-api-key': windyKey() },
        signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!res.ok) throw new Error(`Windy HTTP ${res.status}`);
    const json = await res.json();
    const out = [];
    for (const w of json?.webcams || []) {
        /* Only cameras Windy marks live. */
        if (w.status && w.status !== 'active') continue;
        const loc = w.location || {};
        const wlat = Number(loc.latitude), wlng = Number(loc.longitude);
        if (!Number.isFinite(wlat) || !Number.isFinite(wlng)) continue;
        /* `preview` is the largest still; `thumbnail` the small one. Neither is
           a stream — Windy stills refresh on the webcam owner's schedule. */
        const image = w.images?.current?.preview || w.images?.current?.thumbnail;
        if (!image) continue;
        out.push({
            id: `windy:${w.webcamId}`,
            name: String(w.title || 'Webcam'),
            lat: wlat, lng: wlng,
            image, video: null,
            view: loc.city || null,
            operator: 'Windy webcams',
            city: loc.city || loc.region || null
        });
    }
    return out;
}

/**
 * Every fixed-list camera we know about (TfL + Singapore).
 *
 * One source failing must not take the others down — a London outage should
 * not remove Singapore from the globe.
 */
async function list({ force = false } = {}) {
    if (!force && cache.cams && Date.now() - cache.at < LIST_TTL_MS) {
        return { ok: true, data: { cameras: cache.cams, cached: true } };
    }
    const settled = await Promise.allSettled([fetchTfl(), fetchSingapore()]);
    const cams = [];
    const failed = [];
    const names = ['TfL', 'Singapore LTA'];
    settled.forEach((s, i) => {
        if (s.status === 'fulfilled') cams.push(...s.value);
        else failed.push(`${names[i]}: ${s.reason?.message || 'unavailable'}`);
    });

    if (!cams.length) {
        return { ok: false, reason: 'all-sources-failed', detail: failed.join('; ') };
    }
    cache = { at: Date.now(), cams };
    return { ok: true, data: { cameras: cams, cached: false, partial: failed.length ? failed : null } };
}

/**
 * One frame, as a data URI.
 *
 * The URL is checked against the allowlist AND against the camera list this
 * process built — the renderer cannot ask for an arbitrary address even if it
 * is on an allowed host.
 */
async function frame({ url, kind = 'image' } = {}) {
    const target = String(url || '');
    if (!hostAllowed(target)) return { ok: false, reason: 'host-not-allowed' };
    /* It must be a URL this process handed out — from the fixed list OR offered
       by a recent nearby query (Windy). An allowed host is not enough, or the
       renderer would get to choose the address. */
    const known = urlOffered(target)
        || (cache.cams || []).some((c) => c.image === target || c.video === target);
    if (!known) return { ok: false, reason: 'unknown-camera' };

    try {
        /* Cache-busted: these endpoints serve the latest frame at a fixed URL,
           so without this a proxy or the runtime can hand back the same
           picture indefinitely and the "live" view would be frozen. */
        const bust = `${target}${target.includes('?') ? '&' : '?'}_t=${Date.now()}`;
        const res = await fetch(bust, { signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!res.ok) return { ok: false, reason: `http-${res.status}` };
        const type = res.headers.get('content-type') || (kind === 'video' ? 'video/mp4' : 'image/jpeg');
        const buf = Buffer.from(await res.arrayBuffer());
        /* A few bytes is an error page, not a frame. */
        if (buf.length < 512) return { ok: false, reason: 'empty-frame' };
        return {
            ok: true,
            data: {
                dataUri: `data:${type};base64,${buf.toString('base64')}`,
                bytes: buf.length,
                contentType: type,
                at: Date.now()
            }
        };
    } catch (e) {
        return { ok: false, reason: e.name === 'TimeoutError' ? 'timeout' : 'network', detail: e.message };
    }
}

/** Cameras within a radius of a point, nearest first. */
async function near({ lat, lng, radiusKm = 25, limit = 12 } = {}) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return { ok: false, reason: 'bad-coordinates' };
    }
    /* The fixed government list and a fresh Windy query, in parallel. Either
       failing must not sink the other — Windy being down should still leave
       London's road cameras, and no Windy key should degrade to exactly the
       previous behaviour rather than an error. */
    const [fixed, windy] = await Promise.allSettled([
        list(),
        fetchWindyNear(lat, lng, radiusKm, limit).catch(() => [])
    ]);

    const R = 6371, rad = Math.PI / 180;
    const dist = (aLat, aLng, bLat, bLng) => {
        const dLat = (bLat - aLat) * rad, dLng = (bLng - aLng) * rad;
        const h = Math.sin(dLat / 2) ** 2
            + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2;
        return 2 * R * Math.asin(Math.sqrt(h));
    };

    const pool = [];
    let coverage = 0;
    if (fixed.status === 'fulfilled' && fixed.value.ok) {
        pool.push(...fixed.value.data.cameras);
        coverage += fixed.value.data.cameras.length;
    }
    if (windy.status === 'fulfilled') pool.push(...windy.value);

    if (!pool.length) return { ok: false, reason: 'no-cameras', detail: 'no cameras near this point' };

    const cameras = pool
        .map((c) => ({ ...c, distanceKm: Math.round(dist(lat, lng, c.lat, c.lng)) }))
        .filter((c) => c.distanceKm <= radiusKm)
        .sort((a, b) => a.distanceKm - b.distanceKm)
        .slice(0, Math.max(1, Math.min(50, limit)));

    /* Record every URL handed out so frame() will accept it — this is what
       makes a token-signed Windy URL fetchable after the user clicks it. */
    for (const c of cameras) { rememberUrl(c.image); rememberUrl(c.video); }

    return { ok: true, data: { cameras, coverage } };
}

async function status() {
    const sources = ['Transport for London JamCams', 'LTA Singapore'];
    if (windyKey()) sources.push('Windy webcams (~70k, worldwide)');
    return {
        ok: true,
        data: {
            configured: true,
            sources,
            windy: !!windyKey(),
            cached: cache.cams ? cache.cams.length : 0,
            note: windyKey()
                ? 'Public road cameras plus opt-in Windy webcams'
                : 'Public road cameras (London, Singapore). Add WINDY_WEBCAMS_API_KEY for worldwide webcams.'
        }
    };
}

const METHODS = { list, near, frame, status };

async function invoke(method, params = {}) {
    const fn = METHODS[method];
    if (!fn) return { ok: false, reason: 'unknown-method', detail: String(method).slice(0, 40) };
    return fn(params || {});
}

module.exports = { invoke, methods: Object.keys(METHODS), hostAllowed, list, near, frame, status };
