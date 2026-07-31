// ---------------------------------------------------------------------------
// Spoken alarm and timer parsing.
//
//   "set a timer for 40 minutes"
//   "set an alarm for tomorrow at 2:30 pm"
//   "wake me at 6"
//   "remind me in an hour and a half to check the oven"
//
// RULE-BASED. An alarm the user cannot rely on is worse than no alarm, so
// nothing here guesses: a phrase that does not resolve to an unambiguous
// instant returns null, and the caller says it did not understand rather than
// silently picking a time. The existing calendar parser did guess — "in 40
// minutes" resolved to 12:00 because a default was returned when the match
// failed — which is exactly the failure this replaces.
//
// TIMER vs ALARM is only a labelling difference: a timer is a duration from
// now, an alarm is a clock time. Both produce an absolute `at` instant.
// ---------------------------------------------------------------------------

/** Spoken number words, up to the range people actually dictate for time. */
const NUMBER_WORDS = {
    a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
    eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
    fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
    nineteen: 19, twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50,
    sixty: 60, ninety: 90,
};

const UNIT_MS = {
    second: 1000, seconds: 1000, sec: 1000, secs: 1000,
    minute: 60000, minutes: 60000, min: 60000, mins: 60000,
    hour: 3600000, hours: 3600000, hr: 3600000, hrs: 3600000,
    day: 86400000, days: 86400000,
};

/** Longest duration we will accept. Beyond this it is a calendar entry. */
const MAX_DURATION_MS = 7 * 86400000;

function wordToNumber(token) {
    if (/^\d+$/.test(token)) return parseInt(token, 10);
    return NUMBER_WORDS[token] ?? null;
}

/**
 * Total milliseconds for a duration phrase, or null.
 *
 * Handles compounds ("1 hour 30 minutes", "an hour and a half") by summing
 * every unit mentioned, rather than taking the first and discarding the rest.
 */
export function parseDuration(text) {
    const t = String(text || '').toLowerCase();
    let total = 0;
    let matched = false;

    // Both orderings occur in speech and they mean the same thing:
    //   "two and a half hours"   -> number, "and a half", unit
    //   "an hour and a half"     -> number, unit, "and a half"
    // Only the first was handled, so "an hour and a half" fell through to the
    // generic matcher, which saw "hour" and returned 60 minutes — silently
    // dropping the half.
    const halfBefore = t.match(/\b([a-z0-9]+)\s+and\s+a\s+half\s+(hours?|minutes?)\b/);
    if (halfBefore) {
        const n = wordToNumber(halfBefore[1]);
        if (n !== null) {
            const unit = halfBefore[2].startsWith('hour') ? UNIT_MS.hour : UNIT_MS.minute;
            return n * unit + unit / 2;
        }
    }
    const halfAfter = t.match(/\b([a-z0-9]+)\s+(hours?|minutes?)\s+and\s+a\s+half\b/);
    if (halfAfter) {
        const n = wordToNumber(halfAfter[1]);
        if (n !== null) {
            const unit = halfAfter[2].startsWith('hour') ? UNIT_MS.hour : UNIT_MS.minute;
            return n * unit + unit / 2;
        }
    }
    if (/\bhalf an hour\b/.test(t)) return 30 * UNIT_MS.minute;
    if (/\bquarter of an hour\b/.test(t)) return 15 * UNIT_MS.minute;

    // "1 hour 30 minutes", "40 minutes", "ninety seconds"
    const re = /\b([a-z0-9]+)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?)\b/g;
    let m;
    while ((m = re.exec(t)) !== null) {
        const n = wordToNumber(m[1]);
        if (n === null) continue;
        total += n * UNIT_MS[m[2]];
        matched = true;
    }

    if (!matched || total <= 0) return null;
    if (total > MAX_DURATION_MS) return null;
    return total;
}

/**
 * Clock times said as words: "seven thirty", "half past six", "quarter to
 * eight", "at seven".
 *
 * parseClockTime matched digits only, so every word form resolved to nothing —
 * including "set an alarm for seven thirty", which is the example the failure
 * message itself offers the user. Advertising a syntax the parser cannot read
 * is worse than not supporting it, because the user has no way to discover
 * what would have worked.
 *
 * Returns {hour, minute} on a 12-hour clock, or null. Never guesses: an
 * unrecognised word yields null so the caller can say it did not understand.
 */
function parseSpokenClock(t) {
    // "half past six" -> 6:30, "quarter past six" -> 6:15, "quarter to seven" -> 6:45
    const rel = t.match(/\b(half|quarter)\s+(past|to)\s+([a-z]+)\b/);
    if (rel) {
        const h = wordToNumber(rel[3]);
        if (h === null || h < 1 || h > 12) return null;
        const mins = rel[1] === 'half' ? 30 : 15;
        if (rel[2] === 'past') return { hour: h, minute: mins };
        return { hour: h === 1 ? 12 : h - 1, minute: 60 - mins };
    }

    // "at seven", "for seven thirty", "for seven forty five".
    //
    // The preposition is required, mirroring the digit form: a bare number is
    // only a clock time when "at" or a colon or a meridiem marks it as one.
    const m = t.match(/\b(?:at|for)\s+([a-z]+)(?:\s+([a-z]+))?(?:\s+([a-z]+))?/);
    if (!m) return null;

    const hour = wordToNumber(m[1]);
    if (hour === null || hour < 1 || hour > 12) return null;

    // "for seven minutes" is a duration. Durations are resolved before this is
    // reached from parseAlarmCommand, but parseClockTime is exported and must
    // not misread one when called directly.
    if (m[2] && UNIT_MS[m[2]]) return null;

    let minute = 0;
    if (m[2] && !/^o'?clock$/.test(m[2])) {
        const tens = wordToNumber(m[2]);
        if (tens === null) return null;
        const units = m[3] ? wordToNumber(m[3]) : null;
        // "forty five" -> 45, but "thirty" -> 30 and "seven ten" -> 7:10.
        minute = (units !== null && tens % 10 === 0 && units < 10) ? tens + units : tens;
        if (minute > 59) return null;
    }
    return { hour, minute };
}

/**
 * Absolute clock time, or null.
 *
 * Returns a Date. When the spoken time has already passed today it rolls to
 * tomorrow — "set an alarm for 6" said at 9pm means tomorrow morning, and
 * scheduling it in the past would either fire instantly or never.
 */
export function parseClockTime(text, now = new Date()) {
    const t = String(text || '').toLowerCase();

    // 24-hour "at 18:00", 12-hour "at 2:30 pm", bare "at 6"
    const m = t.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/)
        || t.match(/\b(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)?/)
        // "for 8pm", "the 8 pm", "wake me 7am" — no "at" and no colon. Both
        // patterns above need one or the other, so "set an alarm for 8pm" used
        // to resolve to nothing and be answered with "I did not catch when".
        //
        // The meridiem is mandatory in this form. Without it a bare number is
        // far more likely to be a duration than a clock time, and durations are
        // already resolved before parseClockTime is reached.
        || t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/);

    let hour, minute, meridiem;
    if (m) {
        hour = parseInt(m[1], 10);
        minute = m[2] ? parseInt(m[2], 10) : 0;
        meridiem = m[3] ? m[3].replace(/\./g, '') : null;
    } else {
        // No digits anywhere — try the spoken form before giving up.
        const spoken = parseSpokenClock(t);
        if (!spoken) return null;
        hour = spoken.hour;
        minute = spoken.minute;
        const mer = t.match(/\b(a\.?m\.?|p\.?m\.?)\b/);
        meridiem = mer ? mer[1].replace(/\./g, '') : null;
    }

    if (hour > 23 || minute > 59) return null;

    if (meridiem === 'pm' && hour < 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;

    // No meridiem and an ambiguous hour: assume the NEXT occurrence. "at 6"
    // said at 9am means 6pm today; said at 9pm it means 6am tomorrow. Rolling
    // forward is the only reading that is never in the past.
    const target = new Date(now);
    target.setSeconds(0, 0);
    target.setHours(hour, minute);

    const explicitDay = /\btomorrow\b/.test(t) ? 1 : (/\btoday\b|\btonight\b/.test(t) ? 0 : null);
    if (explicitDay === 1) {
        target.setDate(target.getDate() + 1);
        return target;
    }

    if (target <= now) {
        if (explicitDay === 0 && !meridiem && hour < 12) {
            // "tonight at 8" with hour=8 -> 20:00 today.
            target.setHours(hour + 12, minute);
            if (target > now) return target;
        }
        if (!meridiem && hour <= 12) {
            // Try the PM reading before rolling to tomorrow.
            const pm = new Date(target);
            pm.setHours(hour + 12, minute);
            if (pm > now && hour + 12 <= 23) return pm;
        }
        target.setDate(target.getDate() + 1);
    }
    return target;
}

/**
 * Strip the scheduling phrase so only the subject survives as the label.
 *
 * A label is only kept when it was introduced explicitly — "…to check the
 * oven", "…called standup". Trying to salvage a label from whatever words
 * remain after stripping produced labels like "minutes" and "for half", which
 * is worse than no label: the confirmation would read "timer for 30 minutes:
 * minutes".
 */
function extractLabel(text) {
    const t = String(text || '');

    // "for 20 minutes TO check the oven" / "at 6 TO take the bins out"
    const infinitive = t.match(/\bto\s+(.+)$/i);
    if (infinitive) {
        const label = infinitive[1]
            .replace(/\b(?:tomorrow|today|tonight)\b/gi, '')
            .replace(/\s{2,}/g, ' ')
            .trim();
        if (label && !/^\d/.test(label)) return label;
    }

    // "called standup" / "labelled laundry"
    const named = t.match(/\b(?:called|labell?ed|named)\s+(.+)$/i);
    if (named) {
        const label = named[1].replace(/\s{2,}/g, ' ').trim();
        if (label) return label;
    }

    // "…for the pasta" / "…for laundry", but not "for 20 minutes".
    const forSubject = t.match(/\bfor\s+(?:the\s+|my\s+)?([a-z][a-z\s]{2,30})$/i);
    if (forSubject) {
        const candidate = forSubject[1].trim();
        const isTimeWord = /\b(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|half|hour|am|pm|tomorrow|today|tonight)\b/i.test(candidate);
        if (!isTimeWord) return candidate;
    }

    return null;
}

/**
 * Parse an alarm or timer command.
 *
 * @returns {null | {
 *   kind: 'timer'|'alarm',
 *   at: Date,
 *   durationMs: number,
 *   label: string|null,
 *   spoken: string
 * }}
 */
export function parseAlarmCommand(transcript, now = new Date()) {
    const raw = String(transcript || '').trim();
    if (!raw) return null;
    const t = raw.toLowerCase();

    // Must actually be asking for one. "how long is my timer" is a question.
    const isRequest = /\b(?:set|start|create|make|put on|wake me)\b/.test(t)
        && /\b(?:alarm|timer|reminder)\b/.test(t);
    const isBareWake = /\bwake me\b/.test(t);
    if (!isRequest && !isBareWake) return null;

    // Explicitly a timer if the word was used, otherwise an alarm.
    const saidTimer = /\btimer\b/.test(t);

    // Duration first: "for 40 minutes" is unambiguous, and a clock parse would
    // otherwise pick up the bare number.
    const durationMs = parseDuration(t);
    if (durationMs !== null) {
        return {
            kind: saidTimer ? 'timer' : 'alarm',
            at: new Date(now.getTime() + durationMs),
            durationMs,
            label: extractLabel(raw),
            spoken: formatDuration(durationMs),
        };
    }

    const at = parseClockTime(t, now);
    if (at) {
        return {
            kind: saidTimer ? 'timer' : 'alarm',
            at,
            durationMs: at.getTime() - now.getTime(),
            label: extractLabel(raw),
            spoken: formatClock(at, now),
        };
    }

    // Recognised as a request but the time did not resolve. Returning null here
    // would fall through to conversation and the model would answer as if it
    // had set something. The explicit shape lets the caller say what is wrong.
    return { kind: saidTimer ? 'timer' : 'alarm', at: null, durationMs: null, label: null, spoken: null };
}

/** "40 minutes", "1 hour 30 minutes" — for speaking back a confirmation. */
export function formatDuration(ms) {
    const total = Math.round(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;

    const parts = [];
    if (h) parts.push(`${h} hour${h === 1 ? '' : 's'}`);
    if (m) parts.push(`${m} minute${m === 1 ? '' : 's'}`);
    if (s && !h) parts.push(`${s} second${s === 1 ? '' : 's'}`);
    return parts.join(' ') || '0 seconds';
}

/** "2:30 PM", or "2:30 PM tomorrow" when it is not today. */
export function formatClock(date, now = new Date()) {
    const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const sameDay = date.toDateString() === now.toDateString();
    if (sameDay) return time;

    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    if (date.toDateString() === tomorrow.toDateString()) return `${time} tomorrow`;

    return `${time} on ${date.toLocaleDateString([], { weekday: 'long' })}`;
}

/** "cancel the timer", "cancel my alarm", "stop the alarm". */
export function parseAlarmCancel(transcript) {
    const t = String(transcript || '').toLowerCase().trim();
    if (!/\b(?:cancel|stop|clear|delete|turn off|dismiss)\b/.test(t)) return null;
    if (!/\b(?:alarm|timer|reminder)s?\b/.test(t)) return null;
    return { all: /\b(?:all|every)\b/.test(t) };
}

/** "what timers do i have", "list my alarms". */
export function parseAlarmList(transcript) {
    const t = String(transcript || '').toLowerCase().trim();
    if (!/\b(?:alarm|timer)s?\b/.test(t)) return false;
    return /\b(?:list|show|what|how much|how long|any|do i have|remaining|left)\b/.test(t);
}
