// ---------------------------------------------------------------------------
// Background meeting awareness.
//
// Polls the calendar and warns before a meeting starts, escalating as it gets
// closer, until acknowledged.
//
// TWO DEPARTURES FROM THE OBVIOUS DESIGN, both from thinking about what the
// user actually experiences:
//
//  1. FIXED-INTERVAL RE-ALERTS ARE WRONG. Reminding every 5 minutes from 40
//     minutes out means eight identical warnings, and the one at 2 minutes —
//     the only one that matters — sounds exactly like the seven that did not.
//     People learn to ignore it. This escalates instead: one warning at ~30
//     minutes, one at 10, one at 5, one at 1. Fewer, and each means something
//     different.
//
//  2. POLLING EVERY 2 MINUTES IS BOTH TOO MUCH AND TOO LITTLE. Too much
//     because a calendar rarely changes; too little because a poll landing at
//     T-11:30 misses the 10-minute mark by 90 seconds. So the calendar is
//     FETCHED every 5 minutes, and the fetched events are CHECKED every 20
//     seconds against local clocks. Alert timing no longer depends on when a
//     network call happened to land.
//
// Acknowledgement is per-meeting and survives a reload, so dismissing one at
// 30 minutes does not silence the 5-minute warning for a different meeting.
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'jarvis.meetings.ack.v1';

/** Minutes before start at which to speak, and what each one means. */
const STAGES = [
    { at: 30, tone: 'heads-up' },
    { at: 10, tone: 'soon' },
    { at: 5, tone: 'now' },
    { at: 1, tone: 'starting' },
];

export class MeetingMonitor {
    /**
     * @param {object} deps
     * @param {() => Promise<Array>} deps.fetchEvents  Returns normalised events
     * @param {(alert) => void} deps.onAlert
     * @param {Storage} [deps.storage]
     */
    constructor({ fetchEvents, onAlert, storage } = {}) {
        this.fetchEvents = fetchEvents;
        this.onAlert = onAlert || (() => {});
        this.storage = storage || (typeof localStorage !== 'undefined' ? localStorage : null);

        this.events = [];
        this.running = false;
        this.lastFetch = null;
        this.lastError = null;

        /** `${eventId}:${stage}` that have already fired. */
        this.fired = new Set();
        /** Event ids the user has dismissed entirely. */
        this.acknowledged = new Set(this._loadAck());

        this.fetchIntervalMs = 5 * 60000;
        this.tickIntervalMs = 20000;
    }

    start() {
        if (this.running) return { started: false, reason: 'already running' };
        this.running = true;

        this._refresh();
        this._fetchTimer = setInterval(() => this._refresh(), this.fetchIntervalMs);
        this._tickTimer = setInterval(() => this._tick(), this.tickIntervalMs);
        return { started: true };
    }

    stop() {
        this.running = false;
        clearInterval(this._fetchTimer);
        clearInterval(this._tickTimer);
        return { stopped: true };
    }

    /** Silence every remaining warning for one meeting. */
    acknowledge(eventId) {
        this.acknowledged.add(eventId);
        this._saveAck();
        return true;
    }

    /** Silence the meeting currently being warned about. */
    acknowledgeCurrent() {
        const next = this.nextMeeting();
        if (!next) return null;
        this.acknowledge(next.id);
        return next;
    }

    /** Soonest upcoming meeting that has not been dismissed. */
    nextMeeting(now = Date.now()) {
        return this.upcoming(now)[0] || null;
    }

    upcoming(now = Date.now()) {
        return this.events
            .filter((e) => e.startMs > now && !this.acknowledged.has(e.id))
            .sort((a, b) => a.startMs - b.startMs);
    }

    async _refresh() {
        if (!this.fetchEvents) return;
        try {
            const events = await this.fetchEvents();
            this.events = (events || [])
                // All-day events have no start time to count down to, and
                // warning "your day is in 10 minutes" is noise.
                .filter((e) => e.start && !e.allDay)
                .map((e) => ({ ...e, startMs: Date.parse(e.start) }))
                .filter((e) => Number.isFinite(e.startMs));
            this.lastFetch = Date.now();
            this.lastError = null;

            // Forget acknowledgements for meetings that have passed, so the
            // set does not grow forever and a recurring event's next instance
            // still warns.
            const live = new Set(this.events.map((e) => e.id));
            for (const id of [...this.acknowledged]) {
                if (!live.has(id)) this.acknowledged.delete(id);
            }
            this._saveAck();
        } catch (e) {
            // Keep the last known events rather than blanking the schedule on
            // one failed poll. Surfaced through status(), never invented.
            this.lastError = e.message;
        }
    }

    _tick() {
        const now = Date.now();
        for (const event of this.events) {
            if (this.acknowledged.has(event.id)) continue;

            const minutesUntil = (event.startMs - now) / 60000;
            if (minutesUntil < 0) continue;

            // The MOST URGENT stage the clock has reached — the smallest `at`
            // that `minutesUntil` has fallen below. Taking the first match in
            // a descending list instead would announce a meeting six minutes
            // away with the relaxed thirty-minute phrasing, because the
            // 30-minute stage also matches at six minutes.
            const stage = [...STAGES].reverse().find((s) => minutesUntil <= s.at);
            if (!stage) continue;

            const key = `${event.id}:${stage.at}`;
            if (this.fired.has(key)) continue;

            // Mark this stage and every EARLIER one (larger `at`), so a meeting
            // added six minutes before it starts emits one warning rather than
            // replaying the 30 and 10 it never had a chance to give.
            for (const s of STAGES) {
                if (s.at >= stage.at) this.fired.add(`${event.id}:${s.at}`);
            }

            this.onAlert({
                event,
                minutesUntil: Math.max(0, Math.round(minutesUntil)),
                tone: stage.tone,
                isFinal: stage.at === 1,
            });
        }
    }

    /** What the monitor actually knows, for "what's my schedule". */
    status() {
        return {
            running: this.running,
            eventCount: this.events.length,
            lastFetch: this.lastFetch,
            lastError: this.lastError,
            next: this.nextMeeting(),
        };
    }

    _loadAck() {
        try { return JSON.parse(this.storage?.getItem(STORAGE_KEY) || '[]'); }
        catch { return []; }
    }

    _saveAck() {
        try { this.storage?.setItem(STORAGE_KEY, JSON.stringify([...this.acknowledged])); }
        catch { /* quota is not worth breaking the monitor over */ }
    }
}

/** Phrasing for one alert. Escalates in urgency, not just in number. */
export function describeAlert({ event, minutesUntil, tone }) {
    const title = event.summary;
    const link = event.meetLink ? ' The Meet link is ready.' : '';

    switch (tone) {
        case 'heads-up':
            return `Sir, ${title} starts in ${minutesUntil} minutes.${link}`;
        case 'soon':
            return `Sir, ${title} is in ${minutesUntil} minutes.${link}`;
        case 'now':
            return `Sir, ${title} starts in ${minutesUntil} minutes. You should join shortly.${link}`;
        case 'starting':
            return `Sir, ${title} is starting now.${link}`;
        default:
            return `Sir, ${title} is in ${minutesUntil} minutes.`;
    }
}
