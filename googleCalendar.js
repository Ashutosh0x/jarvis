// ---------------------------------------------------------------------------
// Google Calendar v3 and Meet v2, over plain fetch.
//
// WHY NOT `googleapis`. That package is ~50 MB and pulls a discovery layer,
// its own HTTP stack and a code generator, to reach four endpoints. Everything
// below is fetch against documented REST URLs, which is what the library would
// do anyway. The app already ships a Node 22 runtime with global fetch.
//
// WHY THE LOOPBACK FLOW. Desktop apps cannot keep a client secret, so Google's
// installed-app flow is: open the system browser, receive the code on
// 127.0.0.1, exchange it. The browser is where the user can see the real
// consent screen and the real URL — an embedded WebView for a Google login is
// the same mistake as an embedded WebView for a passport scan.
//   https://developers.google.com/identity/protocols/oauth2/native-app
//
// A LIMIT THAT SHAPES THIS FILE: creating a Meet link through
// `conferenceData` requires a PAID GOOGLE WORKSPACE ACCOUNT. A personal Gmail
// silently gets an event with no link. So `createEvent` reports whether a link
// was actually returned rather than assuming one, and the caller says so.
// ---------------------------------------------------------------------------

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CAL_BASE = 'https://www.googleapis.com/calendar/v3';
const MEET_BASE = 'https://meet.googleapis.com/v2';

const SCOPES = [
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/calendar.readonly',
    // Only requested when Meet-space creation is wanted; harmless otherwise.
    'https://www.googleapis.com/auth/meetings.space.created',
].join(' ');

class GoogleCalendar {
    /**
     * @param {object} opts
     * @param {string} opts.clientId     From Google Cloud Console, Desktop app
     * @param {string} opts.clientSecret Not secret for installed apps, but the
     *                                   token endpoint still requires it
     * @param {string} opts.tokenPath    Where the refresh token is stored
     */
    constructor({ clientId, clientSecret, tokenPath }) {
        this.clientId = clientId;
        this.clientSecret = clientSecret;
        this.tokenPath = tokenPath;
        this.tokens = null;
    }

    get isConfigured() { return Boolean(this.clientId && this.clientSecret); }
    get isConnected() { return Boolean(this.tokens?.refresh_token); }

    // ── auth ───────────────────────────────────────────────────────────────

    async loadTokens() {
        try {
            this.tokens = JSON.parse(await fs.readFile(this.tokenPath, 'utf-8'));
            return true;
        } catch {
            return false;
        }
    }

    async _saveTokens(tokens) {
        // A refresh response omits refresh_token, so merge rather than replace.
        // Overwriting would drop the only credential that survives an hour.
        this.tokens = { ...(this.tokens || {}), ...tokens };
        await fs.mkdir(path.dirname(this.tokenPath), { recursive: true });
        await fs.writeFile(this.tokenPath, JSON.stringify(this.tokens, null, 2), {
            mode: 0o600,   // the refresh token is a long-lived credential
        });
    }

    /**
     * Runs the installed-app flow. Resolves once the browser has redirected
     * back to the loopback server.
     *
     * @param {(url: string) => void} openBrowser
     */
    async connect(openBrowser) {
        if (!this.isConfigured) {
            throw new Error('Google client ID and secret are not set. See docs/GOOGLE-CALENDAR.md.');
        }

        // PKCE. Not optional for installed apps — without it, anything that can
        // intercept the redirect can exchange the code.
        const verifier = crypto.randomBytes(32).toString('base64url');
        const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
        const state = crypto.randomBytes(16).toString('base64url');

        const { server, port, codePromise } = await this._startLoopback(state);

        const params = new URLSearchParams({
            client_id: this.clientId,
            redirect_uri: `http://127.0.0.1:${port}`,
            response_type: 'code',
            scope: SCOPES,
            code_challenge: challenge,
            code_challenge_method: 'S256',
            state,
            access_type: 'offline',
            // Without this a second authorisation returns no refresh token,
            // and reconnecting appears to work until the hour is up.
            prompt: 'consent',
        });

        openBrowser(`${AUTH_URL}?${params}`);

        try {
            const code = await codePromise;
            const res = await fetch(TOKEN_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    client_id: this.clientId,
                    client_secret: this.clientSecret,
                    code,
                    code_verifier: verifier,
                    grant_type: 'authorization_code',
                    redirect_uri: `http://127.0.0.1:${port}`,
                }),
            });
            const tokens = await res.json();
            if (!res.ok) throw new Error(tokens.error_description || tokens.error || 'Token exchange failed');

            tokens.expires_at = Date.now() + (tokens.expires_in ?? 3600) * 1000;
            await this._saveTokens(tokens);
            return { connected: true };
        } finally {
            server.close();
        }
    }

    _startLoopback(expectedState) {
        return new Promise((resolve) => {
            let settle;
            const codePromise = new Promise((res, rej) => { settle = { res, rej }; });

            const server = http.createServer((req, res) => {
                const url = new URL(req.url, 'http://127.0.0.1');
                const code = url.searchParams.get('code');
                const state = url.searchParams.get('state');
                const error = url.searchParams.get('error');

                const reply = (title, body) => {
                    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end(`<!doctype html><meta charset="utf-8">
<title>${title}</title>
<body style="font:16px system-ui;display:grid;place-items:center;height:90vh;margin:0">
<div style="text-align:center"><h2>${title}</h2><p>${body}</p></div>`);
                };

                if (error) {
                    reply('Not connected', 'You can close this tab.');
                    settle.rej(new Error(error));
                    return;
                }
                // A mismatched state means this redirect did not come from the
                // request we started. Never exchange that code.
                if (!code || state !== expectedState) {
                    reply('Not connected', 'That response could not be verified. Close this tab and try again.');
                    settle.rej(new Error('State mismatch — authorisation rejected.'));
                    return;
                }
                reply('Connected', 'Jarvis now has access to your calendar. You can close this tab.');
                settle.res(code);
            });

            // Port 0 lets the OS choose, so nothing collides with the phone
            // bridge or a second Jarvis window.
            server.listen(0, '127.0.0.1', () => {
                resolve({ server, port: server.address().port, codePromise });
            });
        });
    }

    async _accessToken() {
        if (!this.tokens?.refresh_token) throw new Error('Not connected to Google Calendar.');

        // 60s of slack, so a request does not start with 3s of validity left.
        if (this.tokens.access_token && Date.now() < (this.tokens.expires_at ?? 0) - 60000) {
            return this.tokens.access_token;
        }

        const res = await fetch(TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: this.clientId,
                client_secret: this.clientSecret,
                refresh_token: this.tokens.refresh_token,
                grant_type: 'refresh_token',
            }),
        });
        const tokens = await res.json();
        if (!res.ok) {
            // A revoked or expired refresh token is unrecoverable without the
            // user. Say that rather than retrying forever.
            throw new Error(
                tokens.error === 'invalid_grant'
                    ? 'Google access was revoked. Say "connect my calendar" to reconnect.'
                    : (tokens.error_description || 'Could not refresh Google access.')
            );
        }
        tokens.expires_at = Date.now() + (tokens.expires_in ?? 3600) * 1000;
        await this._saveTokens(tokens);
        return this.tokens.access_token;
    }

    async _call(url, { method = 'GET', body, base = CAL_BASE } = {}) {
        const token = await this._accessToken();
        const res = await fetch(url.startsWith('http') ? url : `${base}${url}`, {
            method,
            headers: {
                Authorization: `Bearer ${token}`,
                ...(body ? { 'Content-Type': 'application/json' } : {}),
            },
            body: body ? JSON.stringify(body) : undefined,
        });

        const text = await res.text();
        const data = text ? JSON.parse(text) : {};
        if (!res.ok) {
            throw new Error(data.error?.message || `Google API error ${res.status}`);
        }
        return data;
    }

    // ── calendar ───────────────────────────────────────────────────────────

    /**
     * Upcoming events.
     *
     * NOTE: `conferenceDataVersion` is deliberately NOT sent here. It is a
     * parameter of insert/update/patch only; conferenceData comes back on a
     * list regardless. Guides that show it on `events.list` are wrong, and
     * sending an unknown parameter is at best ignored.
     */
    async listEvents({ hoursAhead = 24, maxResults = 20 } = {}) {
        const now = new Date();
        const params = new URLSearchParams({
            timeMin: now.toISOString(),
            timeMax: new Date(now.getTime() + hoursAhead * 3600000).toISOString(),
            maxResults: String(maxResults),
            singleEvents: 'true',      // expand recurrences into instances
            orderBy: 'startTime',      // requires singleEvents
        });
        const data = await this._call(`/calendars/primary/events?${params}`);
        return (data.items || []).map(normaliseEvent);
    }

    /**
     * Create an event, with a Meet link when the account can produce one.
     *
     * Returns `meetLink: null` and `meetUnavailable: true` when the account is
     * a personal Gmail — the API accepts the request and silently returns an
     * event with no conference. Reporting that honestly is the difference
     * between "here is your link" and a user turning up to nothing.
     */
    async createEvent({
        summary, description, startISO, endISO, attendees = [],
        timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
        withMeet = true, reminderMinutes = [40, 10],
    }) {
        const body = {
            summary,
            description: description || undefined,
            start: { dateTime: startISO, timeZone },
            end: { dateTime: endISO, timeZone },
            reminders: {
                useDefault: false,
                overrides: reminderMinutes.map((minutes) => ({ method: 'popup', minutes })),
            },
        };
        if (attendees.length) body.attendees = attendees.map((email) => ({ email }));
        if (withMeet) {
            body.conferenceData = {
                createRequest: {
                    // Idempotency key. Reusing it returns the same conference
                    // instead of minting a second one on a retry.
                    requestId: crypto.randomUUID(),
                    conferenceSolutionKey: { type: 'hangoutsMeet' },
                },
            };
        }

        const params = new URLSearchParams({
            // REQUIRED for conferenceData to be honoured. Without it the field
            // is silently ignored and the event is created with no link.
            conferenceDataVersion: '1',
            sendUpdates: attendees.length ? 'all' : 'none',
        });

        const event = await this._call(`/calendars/primary/events?${params}`, {
            method: 'POST', body,
        });

        const normalised = normaliseEvent(event);
        return {
            ...normalised,
            meetUnavailable: withMeet && !normalised.meetLink,
        };
    }

    async deleteEvent(eventId) {
        await this._call(`/calendars/primary/events/${encodeURIComponent(eventId)}`, {
            method: 'DELETE',
        });
        return { deleted: true };
    }

    /**
     * A standalone Meet room, no calendar event.
     * Also Workspace-only — the error is surfaced rather than swallowed.
     */
    async createMeetSpace() {
        const data = await this._call('/spaces', { method: 'POST', body: {}, base: MEET_BASE });
        return { uri: data.meetingUri, code: data.meetingCode, name: data.name };
    }

    async disconnect() {
        try {
            if (this.tokens?.refresh_token) {
                await fetch(`https://oauth2.googleapis.com/revoke?token=${this.tokens.refresh_token}`,
                    { method: 'POST' });
            }
        } catch { /* revocation is best-effort; the local token still goes */ }
        this.tokens = null;
        try { await fs.unlink(this.tokenPath); } catch { /* already gone */ }
        return { disconnected: true };
    }
}

/** Flatten the API shape into what the renderer actually uses. */
function normaliseEvent(event) {
    let meetLink = null;
    for (const entry of event.conferenceData?.entryPoints || []) {
        if (entry.entryPointType === 'video') { meetLink = entry.uri; break; }
    }
    // Fallback for events where the link lives on hangoutLink instead.
    if (!meetLink && event.hangoutLink) meetLink = event.hangoutLink;

    return {
        id: event.id,
        summary: event.summary || '(no title)',
        description: event.description || '',
        // All-day events carry `date`, not `dateTime`.
        start: event.start?.dateTime || event.start?.date || null,
        end: event.end?.dateTime || event.end?.date || null,
        allDay: Boolean(event.start?.date && !event.start?.dateTime),
        meetLink,
        location: event.location || '',
        attendees: (event.attendees || []).map((a) => a.email).filter(Boolean),
        status: event.status,
        htmlLink: event.htmlLink,
    };
}

module.exports = { GoogleCalendar, normaliseEvent, SCOPES };
