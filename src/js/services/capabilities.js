// Capability manifests — what Jarvis can do, described rather than hardcoded.
//
// The routing problem this replaces: every new ability meant another regex in
// classifyIntent, and the regexes only recognised the phrasings someone thought
// of. "latest trending meme coin search" reached the local model because the
// verb was at the END, which no pattern anticipated. Adding a pattern for that
// fixes that sentence and not the next one.
//
// A manifest describes a capability by what it is FOR, with real examples, and
// the router matches meaning instead of spelling.
//
// ---------------------------------------------------------------------------
// THE LINE THAT MATTERS: BLAST RADIUS DECIDES THE ROUTER
//
// Semantic routing is safe for retrieval and unsafe for destruction, and the
// reason is a property of embeddings rather than of any particular model:
//
//     "empty the recycle bin"
//     "don't empty the recycle bin"
//     "what happens if I empty the recycle bin"
//
// These are neighbours in embedding space. Cosine similarity has no reliable
// signal for negation or interrogation — the content words dominate. A regex
// with a question guard separates them exactly, which is why that guard exists
// in systemCommands.js and why it was worth a test.
//
// Getting a retrieval wrong costs a wasted search. Getting a destructive
// action wrong costs files. So:
//
//   effects: 'read'       -> reachable by embedding similarity
//   effects: 'write'      -> deterministic parse required, then confirmation
//   effects: 'destructive'-> deterministic parse required, always confirmed
//
// This is not a rejection of semantic routing. It is semantic routing applied
// where being approximately right is good enough, and deterministic parsing
// kept where it is not.
// ---------------------------------------------------------------------------

/**
 * How old the answer is allowed to be.
 *
 * This is the real lever, and it is measurable rather than stylistic. A local
 * model answering a REALTIME question is not recalling — the answer postdates
 * its training, so it is generating. That is the fabrication path
 * groundingGuard.js exists to catch, and freshness is how it gets caught
 * BEFORE the model is asked rather than after it answers.
 */
export const FRESHNESS = Object.freeze({
    STATIC: 'static',       // "who invented C" — stable, weights are fine
    DYNAMIC: 'dynamic',     // "how does X work" — drifts slowly
    REALTIME: 'realtime'    // "ethereum gas right now" — weights cannot know
});

/**
 * @typedef {object} Capability
 * @property {string} name
 * @property {string} description   what it is FOR, in one line
 * @property {string[]} examples    real utterances; the router embeds these
 * @property {'read'|'write'|'destructive'} effects
 * @property {string} freshness     the FRESHNESS this capability serves
 * @property {string[]} requires    'internet', 'phone', 'ollama', ...
 * @property {boolean} confirmation
 * @property {string} intent        the existing intent this maps onto
 */

/** @type {Capability[]} */
export const CAPABILITIES = Object.freeze([
    {
        name: 'web_search',
        description: 'Retrieve current information from the public internet.',
        /* Examples are the router's entire training signal, so they are drawn
           from real utterances — including the one that failed. Phrasings
           deliberately vary in shape: verb-first, verb-last, and no verb at
           all, because that variation is what the regex could not cover. */
        examples: [
            'latest trending meme coin search',
            'search the web for rust async runtimes',
            'what is happening with solana',
            'can you check online for me',
            'current ethereum gas fees',
            'who won the match today',
            'find the tokio documentation',
            'bitcoin price search',
            'look up the nvidia stock price'
        ],
        effects: 'read',
        freshness: FRESHNESS.REALTIME,
        requires: ['internet'],
        confirmation: false,
        intent: 'WEB_SEARCH'
    },
    {
        name: 'local_memory',
        description: 'Answer from things the user told Jarvis or documents it ingested.',
        examples: [
            'what did i tell you about the deployment',
            'what do you remember about my project',
            'find my notes on the audit',
            'what did i copy earlier',
            'recall what we discussed about pricing'
        ],
        effects: 'read',
        freshness: FRESHNESS.STATIC,
        requires: [],
        confirmation: false,
        intent: 'RECALL'
    },
    {
        name: 'screen_vision',
        description: 'Look at the screen and describe or read what is on it.',
        examples: [
            'what is on my screen',
            'read this error for me',
            'can you see what i am looking at',
            'describe the window in front of me'
        ],
        effects: 'read',
        freshness: FRESHNESS.REALTIME,
        requires: [],
        confirmation: false,
        intent: 'READ_SCREEN'
    },
    {
        name: 'system_state',
        description: 'Report measured facts about this machine: disk, uptime, processes, network.',
        examples: [
            'how much disk space is left',
            'how long has this machine been on',
            'what is eating my cpu',
            'what is my network like',
            'how much memory is in use'
        ],
        effects: 'read',
        freshness: FRESHNESS.REALTIME,
        requires: [],
        confirmation: false,
        intent: 'SYSTEM_COMMAND'
    },
    {
        name: 'phone_mirror',
        description: 'Show the paired phone screen on the desktop with touch control.',
        examples: [
            'mirror my phone',
            'show me my phone screen',
            'cast my android to the desktop'
        ],
        effects: 'read',
        freshness: FRESHNESS.REALTIME,
        requires: ['phone'],
        confirmation: false,
        intent: 'MIRROR_START'
    },

    /* ---- below this line: NOT reachable by embedding ----
       Listed so the planner can reason about them, describe them, and tell the
       user they exist — but selection requires a deterministic parse. See the
       blast-radius note at the top. */
    {
        name: 'empty_recycle_bin',
        description: 'Permanently delete everything in the recycle bin.',
        examples: ['empty the recycle bin', 'empty the trash'],
        effects: 'destructive',
        freshness: FRESHNESS.STATIC,
        requires: [],
        confirmation: true,
        intent: 'SYSTEM_COMMAND'
    },
    {
        name: 'session_end',
        description: 'Lock, sleep, hibernate or sign out of Windows.',
        examples: ['lock the screen', 'go to sleep', 'sign out'],
        effects: 'destructive',
        freshness: FRESHNESS.STATIC,
        requires: [],
        confirmation: true,
        intent: 'SYSTEM_COMMAND'
    },
    {
        name: 'radio_toggle',
        description: 'Turn Wi-Fi or Bluetooth on or off.',
        examples: ['turn off bluetooth', 'turn wifi on'],
        effects: 'write',
        freshness: FRESHNESS.STATIC,
        requires: [],
        confirmation: true,
        intent: 'SYSTEM_COMMAND'
    },
    {
        name: 'computer_use',
        description: 'Move the mouse and click on this machine.',
        examples: ['click the save button', 'take over my screen'],
        effects: 'destructive',
        freshness: FRESHNESS.STATIC,
        requires: ['armed'],
        confirmation: true,
        intent: 'COMPUTER_USE'
    }
]);

/** Only these may be chosen by similarity. */
export function semanticallyRoutable() {
    return CAPABILITIES.filter((c) => c.effects === 'read');
}

/** Everything, for describing what Jarvis can do. */
export function allCapabilities() {
    return CAPABILITIES.slice();
}

export function capabilityByName(name) {
    return CAPABILITIES.find((c) => c.name === name) || null;
}

/**
 * How fresh must the answer be?
 *
 * Deliberately a cheap lexical pass rather than an LLM call. Three reasons,
 * and the third is the one that decides it:
 *
 *   1. It runs on every utterance, before anything else — an Ollama round trip
 *      here would add latency to the path whose whole point is being fast.
 *   2. A 4B model classifying its own knowledge age is the least reliable
 *      possible judge of it: it does not know what it does not know.
 *   3. It is checkable. This function can be tested against a labelled set;
 *      a model's opinion of freshness can only be spot-checked.
 *
 * Wrong in the safe direction by construction: an unrecognised question is
 * DYNAMIC, and DYNAMIC prefers the network. Over-searching costs a request;
 * under-searching costs a fabricated answer.
 */
export function classifyFreshness(text) {
    const q = String(text ?? '').toLowerCase();
    if (!q.trim()) return FRESHNESS.STATIC;

    // Explicit time anchors — the answer changes by the hour.
    if (/\b(latest|current|currently|right now|today|todays|today's|tonight|this (morning|week|month)|recent|recently|trending|breaking|live|so far|as of|up to date|news)\b/.test(q)) {
        return FRESHNESS.REALTIME;
    }
    // Quantities that move: prices, rates, counts, scores, weather.
    if (/\b(price|cost|worth|rate|gas fee|market cap|stock|score|weather|forecast|temperature|traffic|status|outage|release[ds]?|version)\b/.test(q)) {
        return FRESHNESS.REALTIME;
    }
    // Settled facts — history, definitions, arithmetic, authorship.
    if (/\b(who (invented|created|wrote|founded)|what does .* mean|definition of|history of|why is .* called|how does .* work|explain)\b/.test(q)) {
        return FRESHNESS.STATIC;
    }
    return FRESHNESS.DYNAMIC;
}

/**
 * Should this go to the network?
 *
 * REALTIME always. DYNAMIC when local confidence is weak — the confidence
 * routing idea, with the threshold in one place so it can be tuned against a
 * labelled set instead of argued about.
 */
export function needsNetwork(freshness, localConfidence = 0) {
    if (freshness === FRESHNESS.REALTIME) return true;
    if (freshness === FRESHNESS.STATIC) return false;
    return localConfidence < 0.5;
}

export default {
    CAPABILITIES, FRESHNESS,
    semanticallyRoutable, allCapabilities, capabilityByName,
    classifyFreshness, needsNetwork
};
