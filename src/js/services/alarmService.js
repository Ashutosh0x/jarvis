// ---------------------------------------------------------------------------
// Alarm and timer scheduling.
//
// Design constraints, in the order they mattered:
//
//  1. FIRE ON TIME. The existing calendar reminder polled every 60 seconds,
//     which makes a 30-second timer impossible and every alarm up to a minute
//     late. This schedules a setTimeout for the exact instant instead.
//
//  2. SURVIVE A RESTART. An alarm that evaporates when the app reloads is not
//     an alarm. They persist, and re-arm on construction.
//
//  3. NEVER SILENTLY FAIL. If an alarm was missed while the app was closed,
//     say so on return rather than deleting it quietly. If sound cannot play,
//     the speech and the notification still happen.
//
// HONEST LIMITATION, stated once here and surfaced to the user when they set
// one: this is a renderer-side scheduler. If Jarvis is not running, the alarm
// does not fire. It is not an OS-level alarm and must not be described as one.
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'jarvis.alarms.v1';

/** setTimeout overflows past this and fires immediately, so long waits chain. */
const MAX_TIMEOUT_MS = 2_147_483_647;

export class AlarmService {
    /**
     * @param {object} deps
     * @param {(text: string) => void} deps.speak
     * @param {(text: string) => void} [deps.display]
     * @param {Storage} [deps.storage]
     */
    constructor({ speak, display, storage } = {}) {
        this.speak = speak || (() => {});
        this.display = display || (() => {});
        this.storage = storage || (typeof localStorage !== 'undefined' ? localStorage : null);

        /** @type {Map<string, {id, kind, at, label, timer}>} */
        this.alarms = new Map();
        this._ringing = null;

        this._restore();
    }

    // ── scheduling ─────────────────────────────────────────────────────────

    /**
     * @returns {{ id: string, at: Date, missed?: boolean }}
     */
    schedule({ kind, at, label }) {
        const id = `${kind}_${at.getTime().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
        const entry = { id, kind, at: at.getTime(), label: label || null };
        this.alarms.set(id, entry);
        this._persist();
        this._arm(entry);
        return { id, at };
    }

    cancel(id) {
        const entry = this.alarms.get(id);
        if (!entry) return false;
        if (entry.timer) clearTimeout(entry.timer);
        this.alarms.delete(id);
        this._persist();
        return true;
    }

    cancelAll() {
        const n = this.alarms.size;
        for (const entry of this.alarms.values()) {
            if (entry.timer) clearTimeout(entry.timer);
        }
        this.alarms.clear();
        this._persist();
        return n;
    }

    /** Pending alarms, soonest first. */
    list() {
        return [...this.alarms.values()]
            .sort((a, b) => a.at - b.at)
            .map((e) => ({
                id: e.id,
                kind: e.kind,
                at: new Date(e.at),
                label: e.label,
                remainingMs: e.at - Date.now(),
            }));
    }

    /** Stop whatever is currently ringing. */
    dismiss() {
        if (!this._ringing) return false;
        clearInterval(this._ringing.repeat);
        this._ringing = null;
        return true;
    }

    get isRinging() { return this._ringing !== null; }

    // ── internals ──────────────────────────────────────────────────────────

    _arm(entry) {
        const delay = entry.at - Date.now();

        if (delay <= 0) {
            this._fire(entry);
            return;
        }
        // setTimeout silently fires immediately past ~24.8 days, so chain.
        if (delay > MAX_TIMEOUT_MS) {
            entry.timer = setTimeout(() => this._arm(entry), MAX_TIMEOUT_MS);
            return;
        }
        entry.timer = setTimeout(() => this._fire(entry), delay);
    }

    _fire(entry) {
        this.alarms.delete(entry.id);
        this._persist();

        const what = entry.label
            ? `${entry.kind === 'timer' ? 'Timer' : 'Alarm'}: ${entry.label}`
            : (entry.kind === 'timer' ? 'Timer finished' : 'Alarm');

        this.display(`⏰ ${what}`);
        this.speak(entry.label
            ? `${entry.label}. Your ${entry.kind} is up, Sir.`
            : `Your ${entry.kind} is up, Sir.`);

        this._notify(what, entry.label || 'Time is up.');
        this._startRinging(entry, what);
    }

    /**
     * Repeat until dismissed.
     *
     * An alarm that announces itself once and goes quiet is a notification.
     * Repeating is what makes it an alarm — but it stops itself after two
     * minutes so an unattended machine is not left making noise indefinitely.
     */
    _startRinging(entry, what) {
        this.dismiss();
        const started = Date.now();
        let beats = 0;

        this._playTone();
        const repeat = setInterval(() => {
            beats += 1;
            if (Date.now() - started > 120000) {
                clearInterval(repeat);
                this._ringing = null;
                this.display(`${what} — stopped after two minutes.`);
                return;
            }
            this._playTone();
            if (beats % 3 === 0) this.speak(`Your ${entry.kind} is still going, Sir.`);
        }, 5000);

        this._ringing = { entry, repeat };
    }

    /**
     * A short tone through WebAudio.
     *
     * Synthesised rather than shipped as an asset: it is two oscillator notes,
     * and an mp3 for that would be another file to load and another thing to
     * fail. Wrapped in try/catch because a suspended AudioContext must not stop
     * the speech and the notification from happening.
     */
    _playTone() {
        try {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (!Ctx) return;
            this._audio = this._audio || new Ctx();
            if (this._audio.state === 'suspended') this._audio.resume().catch(() => {});

            const now = this._audio.currentTime;
            for (const [i, freq] of [880, 1174].entries()) {
                const osc = this._audio.createOscillator();
                const gain = this._audio.createGain();
                osc.type = 'sine';
                osc.frequency.value = freq;
                gain.gain.setValueAtTime(0.0001, now + i * 0.18);
                gain.gain.exponentialRampToValueAtTime(0.25, now + i * 0.18 + 0.02);
                gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.18 + 0.16);
                osc.connect(gain).connect(this._audio.destination);
                osc.start(now + i * 0.18);
                osc.stop(now + i * 0.18 + 0.18);
            }
        } catch { /* speech and the notification still carry the alarm */ }
    }

    _notify(title, body) {
        try {
            if (typeof Notification === 'undefined') return;
            if (Notification.permission === 'granted') {
                new Notification(title, { body, requireInteraction: true });
            }
        } catch { /* not fatal — the alarm has already been spoken */ }
    }

    // ── persistence ────────────────────────────────────────────────────────

    _persist() {
        if (!this.storage) return;
        try {
            const plain = [...this.alarms.values()]
                .map(({ id, kind, at, label }) => ({ id, kind, at, label }));
            this.storage.setItem(STORAGE_KEY, JSON.stringify(plain));
        } catch { /* a full quota must not break an alarm already armed */ }
    }

    /**
     * Re-arm on startup, and report anything missed.
     *
     * A missed alarm is announced rather than dropped. Silently deleting one
     * the user set is the same failure as never having set it, except they do
     * not find out.
     */
    _restore() {
        if (!this.storage) return;
        let stored = [];
        try {
            stored = JSON.parse(this.storage.getItem(STORAGE_KEY) || '[]');
        } catch { return; }
        if (!Array.isArray(stored)) return;

        const now = Date.now();
        const missed = [];

        for (const entry of stored) {
            if (!entry?.id || typeof entry.at !== 'number') continue;
            if (entry.at <= now) {
                missed.push(entry);
                continue;
            }
            this.alarms.set(entry.id, entry);
            this._arm(entry);
        }

        this._persist();
        if (missed.length) this._reportMissed(missed);
    }

    _reportMissed(missed) {
        // Deferred so the caller can finish wiring speak/display first.
        setTimeout(() => {
            const one = missed.length === 1;
            const when = new Date(missed[0].at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
            const labels = missed.map((m) => m.label).filter(Boolean);

            this.display(
                one
                    ? `Missed ${missed[0].kind} from ${when}${labels[0] ? `: ${labels[0]}` : ''}`
                    : `Missed ${missed.length} alarms while Jarvis was closed.`
            );
            this.speak(
                one
                    ? `You missed ${labels[0] ? `your ${labels[0]} ` : 'an '}${missed[0].kind} from ${when}, Sir.`
                    : `You missed ${missed.length} alarms while I was closed, Sir.`
            );
        }, 2500);
    }
}
