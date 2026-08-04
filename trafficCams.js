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
    'images.data.gov.sg'
];

function hostAllowed(url) {
    try {
        const h = new URL(url).hostname.toLowerCase();
        return ALLOWED_HOSTS.some((a) => h === a || h.endsWith(`.${a}`));
    } catch {
        return false;
    }
}

let cache = { at: 0, cams: null };

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
 * Every camera we know about.
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
    /* It must be a URL this process handed out. */
    const known = (cache.cams || []).some((c) => c.image === target || c.video === target);
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
    const all = await list();
    if (!all.ok) return all;

    const R = 6371, rad = Math.PI / 180;
    const dist = (aLat, aLng, bLat, bLng) => {
        const dLat = (bLat - aLat) * rad, dLng = (bLng - aLng) * rad;
        const h = Math.sin(dLat / 2) ** 2
            + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2;
        return 2 * R * Math.asin(Math.sqrt(h));
    };

    const cameras = all.data.cameras
        .map((c) => ({ ...c, distanceKm: Math.round(dist(lat, lng, c.lat, c.lng)) }))
        .filter((c) => c.distanceKm <= radiusKm)
        .sort((a, b) => a.distanceKm - b.distanceKm)
        .slice(0, Math.max(1, Math.min(50, limit)));

    return { ok: true, data: { cameras, coverage: all.data.cameras.length } };
}

async function status() {
    return {
        ok: true,
        data: {
            configured: true,
            sources: ['Transport for London JamCams', 'LTA Singapore'],
            cached: cache.cams ? cache.cams.length : 0,
            note: 'Public road cameras published by transport authorities'
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
