// Spotify — the half that touches the network and the OS.
//
// Parsing and phrasing live in src/js/services/spotifyIntent.js. This resolves
// a spoken request to a real track and hands it to whatever can actually play
// it on this machine.
//
// ---------------------------------------------------------------------------
// MEASURED CONSTRAINTS, 2 Aug 2026. The integration plan this implements
// assumed a playback path that does not exist here, so each was checked:
//
//   GET /v1/search ............ 200, real results. Search is genuinely live.
//   PUT /v1/me/player/play .... Premium only. The dashboard states the app is
//                               blocked from the Web API without Premium, and
//                               the issued token returned 401 "Permissions
//                               missing" for /me/player/devices regardless.
//   spotify: URI .............. Spotify is NOT installed on this machine and
//                               the protocol is NOT registered, so the plan's
//                               `Start-Process "spotify:..."` fallback fails
//                               silently — the worst possible failure, since
//                               it looks like success.
//   open.spotify.com .......... Works. No install, Free accounts included.
//
// So: resolve for real, then hand off to the best player PRESENT, and report
// which one. Never report playback that did not start.
//
// TOKENS ARE NOT STORED HERE. They go in the existing safeStorage vault
// (DPAPI on Windows) through the credential IPC, the same as every other
// secret. Nothing in this file writes a token to disk, and none is committed.
// ---------------------------------------------------------------------------

const { exec } = require('child_process');
const { shell } = require('electron');

const API = 'https://api.spotify.com/v1';

/** Is the `spotify:` protocol actually registered on this machine? */
function desktopAvailable() {
    return new Promise((resolve) => {
        exec('reg query HKCR\\spotify /ve', { windowsHide: true, timeout: 5000 },
            (err) => resolve(!err));
    });
}

/**
 * Search for one track.
 *
 * Returns the raw response so the pure layer shapes it — the parsing rules and
 * their tests live together there, not split across the process boundary.
 */
async function search(token, query, limit = 1) {
    if (!token) return { ok: false, status: 0, error: 'not connected to Spotify' };
    const url = `${API}/search?q=${encodeURIComponent(query)}&type=track&limit=${limit}`;
    try {
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        if (res.status === 401) return { ok: false, status: 401, error: 'token expired' };
        if (res.status === 403) return { ok: false, status: 403, error: 'this account cannot use the Web API' };
        if (res.status === 429) {
            /* Spotify's rate limit is per-app and the header is authoritative;
               guessing a backoff instead of reading it is how an integration
               gets an app suspended. */
            const retry = Number(res.headers.get('retry-after')) || 5;
            return { ok: false, status: 429, error: `rate limited, retry in ${retry}s`, retryAfter: retry };
        }
        if (!res.ok) return { ok: false, status: res.status, error: `search failed (${res.status})` };
        return { ok: true, status: 200, json: await res.json() };
    } catch (e) {
        return { ok: false, status: 0, error: e.message };
    }
}

/**
 * Try real playback through the Web API.
 *
 * Expected to fail on a non-Premium account, and that is handled as a normal
 * outcome rather than an error: the caller falls through to a handoff. Returns
 * `{ played: false, reason }` rather than throwing, so a missing subscription
 * reads as a routing fact instead of a crash.
 */
async function play(token, uri) {
    if (!token) return { played: false, reason: 'not connected' };
    try {
        const res = await fetch(`${API}/me/player/play`, {
            method: 'PUT',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ uris: [uri] })
        });
        // 204 is the documented success; 202 appears when a device is waking.
        if (res.status === 204 || res.status === 202) return { played: true };
        if (res.status === 403) return { played: false, reason: 'premium-required' };
        if (res.status === 404) return { played: false, reason: 'no-active-device' };
        if (res.status === 401) return { played: false, reason: 'token-expired' };
        return { played: false, reason: `status-${res.status}` };
    } catch (e) {
        return { played: false, reason: e.message };
    }
}

/**
 * Hand a resolved track to whatever can play it.
 *
 * Order is by how close it gets the user to hearing audio: real playback, then
 * the desktop app, then a browser tab. The desktop step is skipped entirely
 * when the protocol is not registered — attempting it would open nothing and
 * report success.
 */
/**
 * @param {object} opts
 * @param {boolean} [opts.allowBrowser=false] open open.spotify.com as a last
 *   resort. OFF by default: a browser tab is not background playback, it is a
 *   window appearing and still no music until someone presses play.
 *
 * THERE IS NO BACKGROUND PATH WITHOUT A PLAYER, and that is a platform fact
 * rather than a gap here. Measured on this machine:
 *   - Web API playback needs Premium AND an already-running Spotify device, so
 *     it does not remove the install requirement, it adds to it.
 *   - The desktop app plays with no browser and works on Free accounts, but
 *     Spotify is not installed and the `spotify:` protocol is unregistered.
 *   - Playing the web player inside a hidden Electron window would need
 *     Widevine, and Electron 39.2.4 ships no CDM — it would load and fail.
 * So with no player present this returns `handoff: null` and says so, rather
 * than opening something and calling it playback.
 */
async function handoff(track, { token, webPlayerUrl, allowBrowser = false }) {
    let reason = null;

    if (token) {
        const r = await play(token, track.uri);
        if (r.played) return { handoff: 'web-api', detail: null };
        reason = r.reason;
    }

    if (await desktopAvailable()) {
        exec(`start "" "${track.uri}"`, { windowsHide: true });
        return { handoff: 'desktop-uri', detail: reason };
    }

    if (allowBrowser && webPlayerUrl) {
        await shell.openExternal(webPlayerUrl);
        return { handoff: 'web-player', detail: reason };
    }

    return {
        handoff: null,
        detail: reason,
        /* Named so the caller can say the actionable thing — the track WAS
           found, and the only missing piece is a player. */
        error: 'no player available: Spotify desktop is not installed'
    };
}

module.exports = { search, play, handoff, desktopAvailable };
