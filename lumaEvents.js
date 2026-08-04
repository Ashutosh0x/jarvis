/* =========================================================================
   LUMA EVENTS — the events on YOUR calendar, placed on the globe.

   READ THIS BEFORE EXPECTING A WORLD EVENT LAYER.

   Luma's public API has 66 endpoints and NOT ONE of them searches or
   discovers events. Their own documentation is explicit:

     "API keys are scoped to a single calendar. Each calendar you want to
      manage via the API needs its own key, and each key only grants access
      to the calendar it was created on."

   Verified against the live OpenAPI document at
   public-api.luma.com/openapi.json — there is no /search, /discover,
   /explore or /browse path. So "show me every AI meetup in Tokyo" cannot be
   answered by this API at any price. What CAN be answered is "show me MY
   events, wherever in the world they are", and that is what this module does.

   That distinction is load-bearing. A layer that silently shows one calendar
   while claiming to show the world is the exact species of quiet lie this
   project keeps deleting, so the feed is named for the calendar and reports
   how many events it actually holds.

   MAIN PROCESS ONLY. LUMA_API_KEY grants full write access to the calendar it
   belongs to — it can create events, cancel them, and read the guest list with
   every attendee's email. It never crosses the IPC bridge, and the whitelist
   below is READ-ONLY: the write half of the API is deliberately not reachable
   from the renderer, because a bug in a map layer must not be able to cancel
   an event.

   Requires a Luma Plus subscription. Rate limit is 200 requests per minute per
   calendar; this polls at most once every ten minutes and caches.
   ========================================================================= */

const BASE = 'https://public-api.luma.com';
const TIMEOUT_MS = 10000;
/* Their limit is 200/min. Nothing here approaches it, but a runaway loop
   should be impossible rather than merely unlikely. */
const MAX_PAGES = 5;
const CACHE_MS = 10 * 60 * 1000;

const key = () => process.env.LUMA_API_KEY || '';

function isConfigured() {
    return !!key();
}

let cache = { at: 0, events: null };

async function call(path, params = {}) {
    if (!key()) return { ok: false, reason: 'no-key' };
    const qs = Object.entries(params)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    try {
        const res = await fetch(`${BASE}${path}${qs ? `?${qs}` : ''}`, {
            headers: { 'x-luma-api-key': key(), accept: 'application/json' },
            signal: AbortSignal.timeout(TIMEOUT_MS)
        });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* handled below */ }
        if (!res.ok) {
            /* 401 means the key is wrong; 403 usually means the calendar has
               no Luma Plus. Those are different problems for the user and must
               not both surface as "unavailable". */
            return {
                ok: false,
                reason: res.status === 401 ? 'bad-key'
                    : res.status === 403 ? 'needs-luma-plus'
                        : res.status === 429 ? 'rate-limited'
                            : `http-${res.status}`,
                detail: (json?.message || text || '').slice(0, 300)
            };
        }
        return { ok: true, data: json };
    } catch (error) {
        return {
            ok: false,
            reason: error.name === 'TimeoutError' ? 'timeout' : 'network',
            detail: error.message
        };
    }
}

/**
 * Flatten one API entry into the shape the globe speaks.
 *
 * PURE and exported: the response is deeply nested behind allOf/oneOf and the
 * field names are the only thing standing between a real event and a marker at
 * (0, 0). Field names verified against the live OpenAPI schema — `coordinate`
 * is `{latitude, longitude}` or null, and it is explicitly documented as
 * "Null for online events or when the address can't be geocoded."
 */
function normaliseEvent(entry) {
    const e = entry?.event || entry;
    if (!e || !e.api_id && !e.id) return null;

    const c = e.coordinate;
    const lat = Number(c?.latitude);
    const lng = Number(c?.longitude);
    const geo = e.geo_address_json || {};

    return {
        id: e.api_id || e.id,
        kind: 'event',
        name: e.name || 'Untitled event',
        /* An event with no coordinate cannot be drawn. It is still returned,
           with nulls, so a caller can list it even though the globe cannot
           pin it — online events are the normal case for this. */
        lat: Number.isFinite(lat) ? lat : null,
        lng: Number.isFinite(lng) ? lng : null,
        startAt: e.start_at || null,
        endAt: e.end_at || null,
        timezone: e.timezone || null,
        coverUrl: e.cover_url || null,
        url: e.url ? (e.url.startsWith('http') ? e.url : `https://lu.ma/${e.url}`) : null,
        locationType: e.location_type || null,
        city: geo.city || null,
        region: geo.region || null,
        country: geo.country || null,
        address: geo.full_address || geo.address || null,
        spotsRemaining: Number.isFinite(e.spots_remaining) ? e.spots_remaining : null,
        price: e.display_price
            ? { amount: e.display_price.amount ?? null, currency: e.display_price.currency ?? null }
            : null,
        visibility: e.visibility || null,
        /* `place` is what every other feed calls its human label, so the
           ticker and the dossier can treat all events alike. */
        place: geo.city ? `${e.name} — ${geo.city}` : (e.name || 'event'),
        time: e.start_at ? Date.parse(e.start_at) || null : null,
        /* Ripple weight. Events are not disasters; they get a small, uniform
           mark rather than one scaled by attendance, which would make a
           popular party look like an earthquake. */
        weight: 0.25
    };
}

function normaliseList(json) {
    const entries = json?.entries || [];
    return entries.map(normaliseEvent).filter(Boolean);
}

/**
 * Every event on the calendar this key belongs to.
 *
 * Paginated with `pagination_cursor` / `next_cursor` / `has_more`, capped at
 * MAX_PAGES so a calendar with thousands of events cannot turn one refresh
 * into an unbounded crawl.
 */
async function listEvents({ after, before, limit = 100, force = false } = {}) {
    if (!key()) return { ok: false, reason: 'no-key' };
    if (!force && cache.events && Date.now() - cache.at < CACHE_MS) {
        return { ok: true, data: { events: cache.events, cached: true } };
    }

    const events = [];
    let cursor = null;
    for (let page = 0; page < MAX_PAGES; page++) {
        const res = await call('/v1/calendars/events/list', {
            after, before,
            pagination_limit: Math.min(100, Math.max(1, limit)),
            pagination_cursor: cursor || undefined
        });
        if (!res.ok) {
            /* A partial crawl is still worth keeping — page three failing
               should not discard pages one and two. */
            if (events.length) break;
            return res;
        }
        events.push(...normaliseList(res.data));
        if (!res.data?.has_more || !res.data?.next_cursor) break;
        cursor = res.data.next_cursor;
    }

    cache = { at: Date.now(), events };
    return { ok: true, data: { events, cached: false } };
}

/** One event in full, by its api_id. */
async function getEvent({ eventId } = {}) {
    if (!eventId) return { ok: false, reason: 'no-event-id' };
    const res = await call('/v1/events/get', { api_id: eventId });
    if (!res.ok) return res;
    return { ok: true, data: normaliseEvent(res.data) };
}

/** Which calendar is this key actually for? Answers "whose events are these". */
async function calendar() {
    const res = await call('/v1/calendars/get');
    if (!res.ok) return res;
    return {
        ok: true,
        data: { name: res.data?.name || null, apiId: res.data?.api_id || null }
    };
}

/** What is available, in words — the doctor for this subsystem. */
async function status() {
    if (!key()) {
        return {
            ok: true,
            data: {
                configured: false,
                state: 'needs LUMA_API_KEY (Luma Plus, calendar Settings -> Developer)',
                /* Stated up front so nobody builds on a promise this API does
                   not make. */
                scope: 'one calendar only — Luma has no public event search'
            }
        };
    }
    const cal = await calendar();
    return {
        ok: true,
        data: {
            configured: true,
            state: cal.ok ? 'live' : `${cal.reason}${cal.detail ? ` — ${cal.detail}` : ''}`,
            calendar: cal.ok ? cal.data.name : null,
            scope: 'one calendar only — Luma has no public event search'
        }
    };
}

/* READ ONLY, deliberately. The key can create and cancel events and read every
   guest's email; none of that is reachable from the renderer. */
const METHODS = { listEvents, getEvent, calendar, status };

async function invoke(method, params = {}) {
    const fn = METHODS[method];
    if (!fn) return { ok: false, reason: 'unknown-method', detail: String(method).slice(0, 40) };
    return fn(params || {});
}

module.exports = {
    invoke, isConfigured, methods: Object.keys(METHODS),
    normaliseEvent, normaliseList,
    listEvents, getEvent, calendar, status
};
