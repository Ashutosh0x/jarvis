// Windows system commands that were missing a voice route.
//
// PURE. Parsing only — the PowerShell lives in electron.js, the same way
// mirrorIntent parses and mirrorService acts.
//
// SCOPE, AND WHY IT IS SMALL. A review suggested ~90 new commands here. Most
// of them already existed: this project has 111 intents, and the list included
// close-window, maximize, list-processes, top-by-CPU, open-app, open-settings
// and system-overview as "to build" when every one of them ships today. What
// is actually absent is the set below — checked one at a time against
// classifyIntent rather than taken from the list.
//
// THE DESTRUCTIVE ONES ARE MARKED. Sleep, sign-out and emptying the recycle
// bin all destroy something the user cannot get back by asking again: unsaved
// work, or the files themselves. They carry `destructive: true`, which is what
// makes the `warn` haptic fire before they run — pulse, pause, pulse, the one
// pattern in the vocabulary that cannot be mistaken for a confirmation.

/** Recognised commands. `destructive` drives the warning, not the phrasing. */
export const SYSTEM_INTENTS = Object.freeze({
    LOCK_SCREEN: { destructive: false },
    SLEEP: { destructive: true },
    HIBERNATE: { destructive: true },
    SIGN_OUT: { destructive: true },
    EMPTY_TRASH: { destructive: true },
    DARK_MODE: { destructive: false },
    LIGHT_MODE: { destructive: false },
    DND_ON: { destructive: false },
    DND_OFF: { destructive: false },
    DISK_SPACE: { destructive: false },
    UPTIME: { destructive: false },
    RADIO_TOGGLE: { destructive: false }
});

/* A question about a thing is not a request for it. The trap every routing bug
   in this repo has been, and it bites hardest on the destructive entries —
   "should I sign out?" must not sign you out.

   `do` is qualified with a negative lookahead because "do not disturb" is a
   FEATURE NAME that begins with a question word. Caught by a test: the bare
   `do` swallowed the whole DND route. Interrogative "do" is always followed by
   a subject ("do I", "do you"), never by "not". */
const QUESTION = /^(what|how|why|when|does|do(?!\s+not\b)|is|are|can|could|would|will|should|did)\b/;

/**
 * Parse a spoken command.
 * @returns {{intent:string, destructive:boolean, ...}|null}
 */
export function parseSystemCommand(text) {
    const q = String(text ?? '').toLowerCase().trim().replace(/\s+/g, ' ');
    if (!q) return null;

    const hit = (intent, extra = {}) => ({
        intent,
        destructive: SYSTEM_INTENTS[intent].destructive,
        ...extra
    });

    /* Radio first: "turn off bluetooth" also contains "off", which several
       matchers below would otherwise claim. The IPC for this already existed
       and only the voice route was missing. */
    const radio = q.match(/\b(bluetooth|wi-?fi|wireless)\b/);
    if (radio && /\b(turn|switch|enable|disable)\b/.test(q)) {
        const on = /\b(on|enable)\b/.test(q) && !/\b(off|disable)\b/.test(q);
        const kind = /bluetooth/.test(radio[1]) ? 'bluetooth' : 'wifi';
        /* "turn on wifi" is a radio toggle; "connect to <ssid>" is not, and is
           handled by the existing WIFI_CONNECT route. Guarded so this cannot
           swallow it. */
        if (!/\bconnect\b/.test(q)) return hit('RADIO_TOGGLE', { kind, on });
    }

    if (QUESTION.test(q)) {
        /* Two questions ARE requests for information and are safe to answer,
           so they are allowed through the guard explicitly. */
        if (/\b(space|storage)\b/.test(q) && /\b(left|free|remaining|much)\b/.test(q)) {
            return hit('DISK_SPACE');
        }
        if (/\b(uptime|how long)\b/.test(q) && /\b(on|running|up|been)\b/.test(q)) {
            return hit('UPTIME');
        }
        return null;
    }

    if (/\b(lock)\b/.test(q) && /\b(screen|computer|pc|workstation|desktop|it)\b/.test(q)) {
        return hit('LOCK_SCREEN');
    }
    if (/\bhibernate\b/.test(q)) return hit('HIBERNATE');
    /* "go to sleep and learn" is the REFLECT command — memory consolidation,
       not suspend-to-RAM. It routes earlier than this parser, but the guard
       lives here too so the rule survives a reordering rather than depending
       on one. Same for alarms: "set an alarm to wake me" mentions sleep
       without asking for it. */
    if (/\b(sleep|suspend)\b/.test(q)
        && !/\b(alarm|timer|remind|learn|reflect|consolidate|memory)\b/.test(q)) {
        return hit('SLEEP');
    }
    /* "sign ME out" and "log ME off" put a pronoun between the verb and the
       particle, which a contiguous match misses. Found by the routing
       measurement: "sign me out of windows" fell through here and was then
       picked up SEMANTICALLY as screen_vision, because "windows" the operating
       system embeds close to "window" the UI element. Harmless in that
       direction — the worst case was describing the screen — but it is a
       destructive command reaching the wrong layer, and destructive commands
       are supposed to be settled deterministically before the router sees
       them. */
    if (/\b(sign|log)\s+(?:me\s+|us\s+)?(out|off)\b/.test(q) || /\b(signout|logoff|logout)\b/.test(q)) {
        return hit('SIGN_OUT');
    }
    if (/\b(recycle bin|trash|rubbish)\b/.test(q) && /\b(empty|clear|clean)\b/.test(q)) {
        return hit('EMPTY_TRASH');
    }
    if (/\bdark (mode|theme)\b/.test(q) || /\blights off\b/.test(q)) return hit('DARK_MODE');
    if (/\blight (mode|theme)\b/.test(q) || /\blights on\b/.test(q)) return hit('LIGHT_MODE');

    if (/\b(do not disturb|dnd|focus mode|focus assist)\b/.test(q)) {
        const off = /\b(off|disable|stop|end|turn off)\b/.test(q);
        return hit(off ? 'DND_OFF' : 'DND_ON');
    }
    if (/\bnotifications?\b/.test(q) && /\b(on|enable|resume|back)\b/.test(q)) {
        return hit('DND_OFF');
    }

    if (/\b(disk|drive|storage)\b/.test(q) && /\b(space|free|full|usage)\b/.test(q)) {
        return hit('DISK_SPACE');
    }
    if (/\buptime\b/.test(q)) return hit('UPTIME');

    return null;
}

export default { parseSystemCommand, SYSTEM_INTENTS };
