/**
 * GROUNDING GUARD — deterministic anti-fabrication check on model output.
 *
 * The system prompt already forbids inventing concrete identifiers, at length.
 * It does not work. From the interaction log of 21 Jul 2026, one session:
 *
 *   13:44:52  "whats the ip of pr haven"
 *             -> "The IP address associated with 'Pro Haven' is 192.168.1.10"
 *   13:55:46  "them."
 *             -> "The detected devices are: 'HeadphonesXYZ' and 'SmartwatchABC'"
 *   13:56:47  (challenged: "my bluetooth was turned off, how did you scan")
 *             -> repeated the same two invented names as fact
 *
 * Nothing resolved that host and no scan ran. A 4B model will not reliably
 * obey a negative instruction, so the rule is enforced in code instead: any
 * concrete identifier in an answer must appear VERBATIM in the context the
 * model was given. If it does not, the sentence is ungrounded and is never
 * spoken.
 *
 * Deliberately narrow. It only catches identifier classes that are (a) high
 * harm because the user acts on them, and (b) cheap to verify by substring.
 * It is not a general hallucination detector and does not try to be.
 */

// Identifier classes worth blocking. Each has a matcher and a normaliser used
// to compare an answer token against the context.
const PATTERNS = [
    {
        name: 'ipv4',
        // Matches both "192.168.1.10" and the space-separated form that reaches
        // the TTS filter ("192. 168. 1. 10").
        re: /\b\d{1,3}\s*\.\s*\d{1,3}\s*\.\s*\d{1,3}\s*\.\s*\d{1,3}\b/g,
        normalise: (s) => s.replace(/\s+/g, ''),
        // A dotted quad whose octets are all <= 255. Version strings like
        // "1.2.3.4" are indistinguishable and are treated as addresses too;
        // that is the safe direction to err in.
        valid: (s) => s.replace(/\s+/g, '').split('.').every(o => Number(o) <= 255),
    },
    {
        name: 'mac',
        re: /\b[0-9a-f]{2}(?:[:-][0-9a-f]{2}){5}\b/gi,
        normalise: (s) => s.toLowerCase().replace(/-/g, ':'),
    },
    {
        name: 'placeholder-name',
        // The exact shape the model reaches for when it needs a device name it
        // does not have: HeadphonesXYZ, Smartwatch_ABC, Device_123.
        re: /\b[A-Za-z][A-Za-z0-9]*[_-]?(?:XYZ|ABC|123|Example|Placeholder)\b/g,
        normalise: (s) => s.toLowerCase().replace(/[_-]/g, ''),
        // These are fabrication tells on their own. Even if the string somehow
        // appears in context, speaking it as a device name is wrong.
        alwaysUngrounded: true,
    },
];

/**
 * Normalise context once so every lookup is a cheap substring test. Spaces are
 * stripped from dotted quads so "192. 168. 1. 10" in an answer still matches
 * "192.168.1.10" in the context.
 */
function buildHaystack(context) {
    const raw = String(context || '');
    return {
        lower: raw.toLowerCase(),
        // Address-normalised copy: whitespace around dots and colons removed.
        tight: raw.toLowerCase().replace(/\s*([.:-])\s*/g, '$1'),
    };
}

function isGrounded(token, pattern, hay) {
    if (pattern.alwaysUngrounded) return false;
    const n = pattern.normalise(token).toLowerCase();
    return hay.tight.includes(n) || hay.lower.includes(n);
}

/**
 * Find every ungrounded identifier in `text`.
 * @param {string} text    model output (a sentence or a whole answer)
 * @param {string} context everything the model was actually given
 * @returns {Array<{value: string, kind: string}>}
 */
export function findUngrounded(text, context) {
    const s = String(text || '');
    if (!s) return [];
    const hay = buildHaystack(context);
    const found = [];
    const seen = new Set();

    for (const p of PATTERNS) {
        p.re.lastIndex = 0;
        let m;
        while ((m = p.re.exec(s)) !== null) {
            const value = m[0];
            if (p.valid && !p.valid(value)) continue;
            if (isGrounded(value, p, hay)) continue;
            const key = `${p.name}:${value.toLowerCase()}`;
            if (seen.has(key)) continue;
            seen.add(key);
            found.push({ value, kind: p.name });
        }
    }
    return found;
}

/**
 * Guard one unit of model output before it is spoken or displayed.
 *
 * An ungrounded identifier is not redacted mid-sentence — a sentence with a
 * hole in it still asserts that Jarvis knows the answer. The whole unit is
 * replaced with a refusal, which is the behaviour the prompt asked for and
 * never got.
 *
 * @returns {{ text: string, blocked: boolean, found: Array }}
 */
export function guardOutput(text, context) {
    const found = findUngrounded(text, context);
    if (!found.length) return { text: String(text || ''), blocked: false, found: [] };

    const kinds = [...new Set(found.map(f => f.kind))];
    const what = kinds.includes('ipv4') ? 'that address'
        : kinds.includes('mac') ? 'that hardware address'
            : 'that name';

    return {
        text: `I do not have ${what}, Sir — I have no measurement that contains it, and I will not guess one.`,
        blocked: true,
        found,
    };
}

export default { findUngrounded, guardOutput };
