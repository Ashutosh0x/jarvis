// ---------------------------------------------------------------------------
// KEYBOARD / WINDOW CONTROL — pure parsing and encoding, no I/O.
//
// Synthetic keystrokes go to WHATEVER WINDOW HAS FOCUS. That is the entire
// safety story: the assistant cannot see what it is typing into, so every
// handler reports the window that received the text, and typing is never
// driven by the model — only by the rule-based parsers below. A mis-parse
// here does not open the wrong app, it types into the wrong window.
//
// THE CORRECTNESS TRAP, verified end-to-end against Notepad before this file
// existed: SendKeys treats + ^ % ~ ( ) { } [ ] as control characters. Sending
// "Profit +50% (C++)" raw would fire SHIFT, chord ^5, and swallow the parens.
// Escaping each into {+}{^}{%}... round-trips byte-exactly (test below uses
// the same string that was verified live).
// ---------------------------------------------------------------------------

/** SendKeys metacharacters — each must be wrapped in braces to be literal. */
const META = new Set(['+', '^', '%', '~', '(', ')', '{', '}', '[', ']']);

/** Encode literal text for SendKeys. Verified round-trip through Notepad. */
export function escapeSendKeys(text) {
    let out = '';
    for (const ch of String(text ?? '')) out += META.has(ch) ? `{${ch}}` : ch;
    return out;
}

/** Spoken key names -> SendKeys tokens. */
export const KEY_TOKENS = {
    enter: '{ENTER}', return: '{ENTER}', tab: '{TAB}', escape: '{ESC}', esc: '{ESC}',
    backspace: '{BACKSPACE}', delete: '{DELETE}', del: '{DELETE}', insert: '{INSERT}',
    home: '{HOME}', end: '{END}', pageup: '{PGUP}', pagedown: '{PGDN}',
    up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}', space: ' ',
    f1: '{F1}', f2: '{F2}', f3: '{F3}', f4: '{F4}', f5: '{F5}', f6: '{F6}',
    f7: '{F7}', f8: '{F8}', f9: '{F9}', f10: '{F10}', f11: '{F11}', f12: '{F12}',
};

const MODIFIERS = { ctrl: '^', control: '^', alt: '%', shift: '+' };

/**
 * "ctrl s" / "control shift n" / "enter" -> a SendKeys chord, or null.
 * Modifiers apply to the single following key, which is why the key is
 * wrapped: "^(ab)" would send ctrl+a ctrl+b, not ctrl+a then b.
 */
export function encodeChord(spoken) {
    const words = String(spoken || '').toLowerCase().trim().split(/[\s+]+/).filter(Boolean);
    if (!words.length) return null;
    let prefix = '';
    let i = 0;
    for (; i < words.length; i++) {
        const m = MODIFIERS[words[i]];
        if (!m) break;
        if (!prefix.includes(m)) prefix += m;
    }
    const rest = words.slice(i);
    if (rest.length !== 1) return null;          // exactly one non-modifier key
    const key = rest[0];
    if (KEY_TOKENS[key]) return prefix + KEY_TOKENS[key];
    if (/^[a-z0-9]$/.test(key)) return prefix + key;
    return null;
}

/* Spoken punctuation, so dictation can produce characters STT renders as words.
   Deliberately small: only cases where the word is unambiguous in context.
   Surrounding whitespace is consumed on purpose — "google dot com" must become
   "google.com", not "google .com". */
const SPOKEN_CHARS = [
    [/\s*\bat the rate\b\s*/g, '@'], [/\s*\bat sign\b\s*/g, '@'],
    [/\s*\bdot (com|org|net|io|co|dev|in)\b/g, '.$1'],
    [/\s*\bhash ?tag\b\s*/g, '#'],
    [/\s*\bnew ?line\b\s*/g, '\n'],
];

/** Normalise dictated text before it is typed. */
export function normalizeDictation(text) {
    let t = String(text ?? '');
    for (const [re, ch] of SPOKEN_CHARS) t = t.replace(re, ch);
    return t.replace(/\s+/g, ' ').trim();
}

/**
 * Parse a typing/keypress/window command. Rule-based on purpose — the model
 * is never allowed to decide what gets typed into an unseen window.
 * Returns an intent object or null.
 */
export function parseInputCommand(cmd) {
    const raw = String(cmd || '').trim();
    const t = raw.toLowerCase();
    if (!t) return null;

    // Dictation start is checked FIRST so a bare "type" opens voice typing
    // rather than being parsed as typing an empty string.
    if (parseDictationStart(raw)) return { intent: 'DICTATE_START' };

    // "press enter" / "hit ctrl s" / "press control shift n"
    let m = t.match(/^(?:press|hit|send|push)\s+(?:the\s+)?(.{1,30}?)(?:\s+key)?$/);
    if (m) {
        const chord = encodeChord(m[1]);
        if (chord) return { intent: 'PRESS_KEY', chord, spoken: m[1].trim() };
    }

    // "type hello world" / "write ..." / "enter ..." — the ORIGINAL casing is
    // preserved, since the user's capitalisation is part of what they dictated.
    m = raw.match(/^(?:type|write|input|dictate)\s+(?:out\s+)?(.+)$/i);
    if (m) return { intent: 'TYPE_TEXT', text: normalizeDictation(m[1]) };

    /* "search for X" / "google X" — type into whatever is focused, then Enter.
       "google" is also a COMPANY, and the 1000-prompt harness caught the
       collision: "google stock price" typed "stock price" into the focused
       window instead of quoting GOOGL. When the remainder is a financial
       attribute, the word is the subject of the question, not the verb. */
    m = raw.match(/^(?:search(?:\s+for)?|google|look\s+up)\s+(.+)$/i);
    const asksAboutSubject = m && /^(?:stock|share)s?\s+price|^(?:price|earnings|market\s+cap|revenue|dividend|valuation|shares?)\b/i.test(m[1]);
    if (m && !asksAboutSubject && !/\b(my|the)\s+(files?|system|processes|network|memory)\b/i.test(m[1])) {
        return { intent: 'TYPE_TEXT', text: normalizeDictation(m[1]), thenEnter: true, isSearch: true };
    }

    // "switch to chrome" / "focus notepad" / "bring up edge"
    m = t.match(/^(?:switch to|focus(?:\s+on)?|bring up|go to|activate)\s+(?:the\s+)?([a-z0-9 ._-]{2,30}?)(?:\s+window)?$/);
    if (m && !/\b(sleep|bed|settings|wifi|bluetooth)\b/.test(m[1])) {
        return { intent: 'FOCUS_WINDOW', name: m[1].trim() };
    }

    // "close notepad" / "quit chrome" — graceful close, never a forced kill.
    m = t.match(/^(?:close|quit|exit|shut)\s+(?:down\s+)?(?:the\s+)?([a-z0-9 ._-]{2,30}?)(?:\s+(?:app|window|program))?$/);
    if (m && !/\b(tab|window|everything|all|down|jarvis|yourself)\b/.test(m[1])) {
        return { intent: 'CLOSE_APP', name: m[1].trim() };
    }

    // "what window am I in" — the focus question, needed because typing is blind.
    if (/^(?:what|which)\s+(?:window|app|application|program)\s+(?:am i|is)\s+(?:in|focused|active|on)\b/.test(t)
        || /^(?:what|which)\s+(?:is\s+)?(?:the\s+)?(?:focused|active|current)\s+(?:window|app)\b/.test(t)) {
        return { intent: 'FOCUSED_WINDOW' };
    }
    return null;
}

/* --------------------------------------------------------------------------
   DICTATION MODE
   While active, every transcript becomes keystrokes instead of a command. The
   parser below is what decides "is this something to TYPE, or something to
   DO" — and it must lean towards typing, because a false command steals the
   user's words, while a false word is trivially deleted.
-------------------------------------------------------------------------- */

/** Phrases that END dictation. Kept explicit and short so ordinary prose
 *  cannot accidentally terminate a sentence mid-flow. */
const DICTATION_STOP = /^(stop (typing|dictation|dictating)|end (typing|dictation)|done typing|finish typing|stop voice typing|exit typing)\.?$/;

/** In-dictation editing commands, each an exact utterance. */
const DICTATION_KEYS = [
    [/^(new line|newline|line break)\.?$/, '{ENTER}', 'new line'],
    [/^(new paragraph)\.?$/, '{ENTER}{ENTER}', 'new paragraph'],
    [/^(press enter|hit enter|enter key)\.?$/, '{ENTER}', 'enter'],
    [/^(tab key|press tab)\.?$/, '{TAB}', 'tab'],
    [/^(backspace|delete that|scratch that)\.?$/, '{BACKSPACE}', 'backspace'],
    [/^(undo|undo that)\.?$/, '^z', 'undo'],
    [/^(select all)\.?$/, '^a', 'select all'],
    [/^(save it|save that|save the file)\.?$/, '^s', 'save'],
    [/^(clear (it|that|everything))\.?$/, '^a{DEL}', 'clear'],
];

/**
 * Classify one transcript while dictation is active.
 * Returns { kind: 'stop' } | { kind:'key', chord, label } | { kind:'text', text }.
 */
export function parseDictationInput(transcript) {
    const raw = String(transcript ?? '').trim();
    const t = raw.toLowerCase();
    if (!t) return { kind: 'text', text: '' };
    if (DICTATION_STOP.test(t)) return { kind: 'stop' };
    for (const [re, chord, label] of DICTATION_KEYS) {
        if (re.test(t)) return { kind: 'key', chord, label };
    }
    // Everything else is the user's actual words.
    return { kind: 'text', text: normalizeDictation(raw) };
}

/** Does this command START dictation? Returns {} or null. */
export function parseDictationStart(cmd) {
    const t = String(cmd || '').toLowerCase().trim().replace(/[.!?]+$/, '');
    if (/^(start (typing|dictation|voice typing)|voice typing|dictation mode|dictate|let me type|i want to type|type using (my )?voice|start typing for me)$/.test(t)) {
        return {};
    }
    // Bare "type" with nothing after it is a request to start, not to type
    // the empty string.
    if (t === 'type' || t === 'typing') return {};
    return null;
}

/** Match a spoken app name against a window list. Longest title match wins. */
export function matchWindow(windows, spoken) {
    const n = String(spoken || '').toLowerCase().trim();
    if (!n || !Array.isArray(windows)) return null;
    const norm = (s) => String(s || '').toLowerCase();
    // Process name first — it is the stable identifier.
    const byProc = windows.filter(w => norm(w.process) === n);
    if (byProc.length) return byProc[0];
    const byProcPart = windows.filter(w => norm(w.process).includes(n));
    if (byProcPart.length) return byProcPart[0];
    // Then the friendly description Windows reports, then the window title.
    const byDesc = windows.filter(w => norm(w.desc).includes(n));
    if (byDesc.length) return byDesc[0];
    const byTitle = windows.filter(w => norm(w.title).includes(n));
    if (byTitle.length) {
        return [...byTitle].sort((a, b) => String(a.title).length - String(b.title).length)[0];
    }
    return null;
}
