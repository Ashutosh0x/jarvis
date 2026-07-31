// ---------------------------------------------------------------------------
// Conversational meeting scheduling.
//
//   "jarvis schedule a meeting"
//   -> "Of course. What should I call it?"
//   -> "project review"
//   -> "And what is it about?"                      <- the question you asked for
//   -> "Q3 roadmap"
//   -> "When?"  -> "tomorrow at 3"
//   -> "How long?" -> "an hour"
//   -> "Anyone to invite?" -> "no one"
//   -> "Project Review, tomorrow at 3pm for an hour. Shall I create it?"
//
// A STATE MACHINE, NOT A MODEL. The model is used for exactly one thing —
// suggesting a title when the user cannot be bothered to think of one — and
// even then the user confirms it. Everything that determines WHAT LANDS IN THE
// CALENDAR is parsed by rule, because an event created at the wrong time with
// the wrong people invited is not recoverable by apologising.
//
// Times reuse alarmParser, which is already tested: one parser for "tomorrow
// at 2:30 pm" across alarms and meetings means one set of edge cases.
// ---------------------------------------------------------------------------

import { parseClockTime, parseDuration, formatClock, formatDuration } from './alarmParser.js';

export const STEP = {
    IDLE: 'idle',
    TITLE: 'title',
    PURPOSE: 'purpose',
    WHEN: 'when',
    DURATION: 'duration',
    ATTENDEES: 'attendees',
    CONFIRM: 'confirm',
};

/** Said to abandon the flow at any point. */
const CANCEL = /^(?:cancel|stop|never ?mind|forget it|abort|quit)$/i;
const AFFIRM = /^(?:yes|yeah|yep|yup|sure|ok(?:ay)?|do it|go ahead|create it|confirm(?:ed)?|please do|correct)$/i;
const DENY = /^(?:no|nope|nah|don'?t|cancel|stop)$/i;
const NOBODY = /^(?:no ?one|nobody|none|no|just me|skip|myself|nothing)$/i;
const SKIP = /^(?:skip|nothing|no|none|n\/a|leave it)$/i;

export class MeetingScheduler {
    constructor({ suggestTitle } = {}) {
        // Optional. Model-backed, used only to offer a title.
        this.suggestTitle = suggestTitle || null;
        this.reset();
    }

    reset() {
        this.step = STEP.IDLE;
        this.draft = {
            title: null, purpose: null, start: null,
            durationMs: null, attendees: [],
        };
    }

    get isActive() { return this.step !== STEP.IDLE; }

    /** Begin. Returns the first question. */
    start() {
        this.reset();
        this.step = STEP.TITLE;
        return { say: 'Of course, Sir. What should I call this meeting?' };
    }

    /**
     * Feed one user utterance.
     * @returns {{ say: string, done?: boolean, create?: object, cancelled?: boolean }}
     */
    async handle(input, now = new Date()) {
        const text = String(input || '').trim();
        if (!text) return { say: 'Sorry Sir, I did not catch that.' };

        if (CANCEL.test(text)) {
            this.reset();
            return { say: 'Cancelled, Sir.', cancelled: true };
        }

        switch (this.step) {
            case STEP.TITLE: return this._title(text);
            case STEP.PURPOSE: return this._purpose(text);
            case STEP.WHEN: return this._when(text, now);
            case STEP.DURATION: return this._duration(text);
            case STEP.ATTENDEES: return this._attendees(text);
            case STEP.CONFIRM: return this._confirm(text);
            default: return { say: 'I am not scheduling anything at the moment, Sir.' };
        }
    }

    // ── steps ──────────────────────────────────────────────────────────────

    _title(text) {
        this.draft.title = titleCase(text);
        this.step = STEP.PURPOSE;
        return { say: `"${this.draft.title}". And what is this meeting about, Sir?` };
    }

    async _purpose(text) {
        this.draft.purpose = SKIP.test(text) ? null : text;
        this.step = STEP.WHEN;

        // If the title was vague and a purpose was given, the model can propose
        // something better. Offered, never imposed — the user's words win
        // unless they accept the suggestion.
        if (this.suggestTitle && this.draft.purpose && isVagueTitle(this.draft.title)) {
            try {
                const suggested = await this.suggestTitle(this.draft.purpose);
                if (suggested && suggested.toLowerCase() !== this.draft.title.toLowerCase()) {
                    this.draft.suggestedTitle = titleCase(suggested);
                }
            } catch { /* a suggestion is a nicety; never block on it */ }
        }

        const nudge = this.draft.suggestedTitle
            ? ` I would suggest calling it "${this.draft.suggestedTitle}" — say "use that" if you like it.`
            : '';
        return { say: `Noted.${nudge} When should I schedule it, Sir?` };
    }

    _when(text, now) {
        if (/^use that$/i.test(text) && this.draft.suggestedTitle) {
            this.draft.title = this.draft.suggestedTitle;
            return { say: `Renamed to "${this.draft.title}". When should I schedule it, Sir?` };
        }

        const at = parseClockTime(text, now);
        if (!at) {
            // Refuses rather than guessing. A meeting at the wrong hour is
            // worse than being asked twice.
            return { say: 'I did not catch a time, Sir. Try "tomorrow at 3 pm", or "at 10:30".' };
        }
        this.draft.start = at;
        this.step = STEP.DURATION;
        return { say: `${formatClock(at, now)}. How long should it run?` };
    }

    _duration(text) {
        const ms = parseDuration(text);
        if (!ms) {
            return { say: 'How long, Sir? For example "thirty minutes", or "an hour".' };
        }
        this.draft.durationMs = ms;
        this.step = STEP.ATTENDEES;
        return { say: 'Anyone to invite? Say their email addresses, or "no one".' };
    }

    _attendees(text) {
        if (NOBODY.test(text.trim())) {
            this.draft.attendees = [];
        } else {
            const emails = extractEmails(text);
            if (!emails.length) {
                // Spoken email addresses are mangled often enough that a silent
                // failure here would invite the wrong people, or nobody.
                return {
                    say: 'I could not make out an email address, Sir. Say it like "name at example dot com", or say "no one".',
                };
            }
            this.draft.attendees = emails;
        }
        this.step = STEP.CONFIRM;
        return { say: this._summary() };
    }

    _confirm(text) {
        if (AFFIRM.test(text.trim())) {
            const payload = this.toEvent();
            this.reset();
            return { say: 'Creating it now, Sir.', done: true, create: payload };
        }
        if (DENY.test(text.trim())) {
            this.reset();
            return { say: 'Left it alone, Sir.', cancelled: true };
        }
        if (/change|edit|start over|again/i.test(text)) {
            const kept = this.draft;
            this.reset();
            this.step = STEP.TITLE;
            this.draft.attendees = kept.attendees;
            return { say: 'Starting over. What should I call it?' };
        }
        return { say: 'Shall I create it, Sir? Yes or no.' };
    }

    _summary() {
        const d = this.draft;
        const end = new Date(d.start.getTime() + d.durationMs);
        const who = d.attendees.length
            ? ` Inviting ${d.attendees.join(', ')}.`
            : '';
        const about = d.purpose ? ` About: ${d.purpose}.` : '';
        return `"${d.title}", ${formatClock(d.start)} for ${formatDuration(d.durationMs)}, `
            + `ending ${end.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`
            + `${about}${who} Shall I create it, Sir?`;
    }

    /** The draft as the API wants it. */
    toEvent() {
        const d = this.draft;
        const end = new Date(d.start.getTime() + d.durationMs);
        return {
            summary: d.title,
            description: d.purpose || '',
            startISO: d.start.toISOString(),
            endISO: end.toISOString(),
            attendees: d.attendees,
            withMeet: true,
        };
    }
}

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * Emails from dictated text.
 *
 * Speech recognition renders "ash@example.com" as "ash at example dot com"
 * about as often as it gets the symbols right, so both forms are accepted.
 */
export function extractEmails(text) {
    const spoken = String(text)
        .replace(/\s+at\s+/gi, '@')
        .replace(/\s+dot\s+/gi, '.')
        .replace(/\s+underscore\s+/gi, '_')
        .replace(/\s+dash\s+|\s+hyphen\s+/gi, '-')
        .replace(/\s*@\s*/g, '@')
        .replace(/\s*\.\s*/g, '.');

    const found = spoken.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || [];
    return [...new Set(found.map((e) => e.toLowerCase()))];
}

function titleCase(text) {
    return String(text)
        .replace(/\s{2,}/g, ' ')
        .trim()
        .replace(/^[a-z]/, (c) => c.toUpperCase());
}

/** Titles too generic to be worth keeping if the purpose says more. */
function isVagueTitle(title) {
    return /^(?:meeting|call|sync|catch ?up|chat|discussion|standup)$/i.test(String(title).trim());
}
