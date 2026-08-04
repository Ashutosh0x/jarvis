// Recognising a request to build something in 3D.
//
// PURE. Parsing only, in the pattern mirrorIntent and spotifyIntent already
// set: this decides WHAT was asked for, foundryService.js does it.
//
// ---------------------------------------------------------------------------
// WHY A DETERMINISTIC PARSE AND NOT THE SEMANTIC ROUTER
//
// capabilities.js draws the line at blast radius: `read` capabilities are
// reachable by embedding similarity, `write` ones are not. Building a model
// spawns a process, writes files, and can occupy the GPU for twenty minutes,
// so it is `write` and it gets a parser.
//
// The specific failure that rule exists to prevent is live here. These three
// are embedding neighbours and the middle one must not build anything:
//
//     "make me a 3D model of a gear"
//     "how would I model a gear in Blender"
//     "what is a 3D model"
//
// Cosine similarity has no reliable signal for the difference. A question
// guard does, exactly as it does in systemCommands.js — and the guard is the
// first thing this file applies.
// ---------------------------------------------------------------------------

/** What the user wants done. `print` is separate because it commits physical material. */
export const FOUNDRY_ACTIONS = Object.freeze({
    CREATE: 'create',       // build a scene and render it
    SHOW: 'show',           // display what was already built — reads, builds nothing
    REFINE: 'refine',       // change the scene that was just built
    EXPORT: 'export',       // write the existing scene to a file format
    PRINT: 'print'          // send to a 3D printer
});

/* A question about modelling is not a request to model.

   `make` is excluded from the interrogative list on purpose even though "how
   do I make" begins with one: the guard below tests the question word, and
   "how do i make a cube" is genuinely a question. "make me a cube" is not, and
   the difference is the `how`/`what`/`can` prefix rather than the verb. */
const QUESTION = /^(what|how|why|when|where|which|does|do(?!\s+(?:me|us)\b)|is|are|can|could|would|should|did|explain|tell me (?:about|how))\b/i;

/* Verbs that mean "produce geometry". Deliberately broad on the making side
   and narrow on everything else — a false negative here is a command that
   falls through to the general assistant and gets a sentence back, which is
   recoverable. A false positive starts a render. */
const CREATE_VERB = /\b(model|create|make|build|design|generate|sculpt|construct)\b/i;

/* Four of those words are also NOUNS, and three of them name the very thing
   this feature produces: a model, a design, a build, a make.

   From the interaction log, 3 Aug 2026 12:57 — "show me the model" was routed
   to FOUNDRY_CREATE and built a six-polygon cube named "model". The user asked
   to SEE the thing that had just been built and got a second, empty build. The
   noun was read as the verb.

   English marks the difference reliably enough here: a determiner immediately
   before the word makes it a noun. "model me a stand" is a verb; "the model",
   "that design", "my build" are not. */
const DETERMINER_BEFORE = /\b(the|a|an|this|that|those|these|my|your|our|its|another|last|latest|previous|first|second|new|old)\s+$/i;
const NOUN_CAPABLE = /^(model|design|build|make)$/i;

/* Verbs that mean "let me see what already exists". They are not creation, and
   the sentences they head are the ones most likely to contain the noun above. */
const DISPLAY_VERB = /^(?:jarvis[,\s]+)?(?:show|display|view|open|see|find|get|where(?:'?s| is)|look at|pull up|bring up)\b/i;

/* Things this feature produces. A display verb pointed at one of these opens
   the viewer; pointed at anything else it is not Foundry's sentence to claim
   — "show me my screen" belongs to READ_SCREEN and "show files" to the file
   operations, and both would otherwise be swallowed here. */
/* Plurals are spelled out rather than left to a trailing `s?` outside the
   group: "show me all the renders" failed because \brender\b does not match
   inside "renders" — the boundary is after the s. */
const SHOWABLE = /\b(models?|render(?:ing)?s?|scenes?|meshe?s?|builds?|designs?|3-?d|foundry|blender|stls?|glbs?|prints?|gallery|galleries)\b/i;

/* Words that describe WHICH job rather than name one. Stripped before what is
   left is treated as a name, so "the last model" does not become a search for
   a job called "last model". */
const POSITIONAL = /\b(last|latest|previous|recent|newest|most|current|final|one|thing|it|result|output)\b/gi;

/**
 * Which job the user means: the newest, one by name, or the whole gallery.
 *
 * Works by SUBTRACTION — strip the verb, the determiners, the nouns this
 * feature owns and the positional words, and see whether anything is left. A
 * capture-based version read "show me the model" as a job named "model",
 * because the noun and the name occupy the same slot in the sentence.
 */
function whichJob(q) {
    if (/\b(first|oldest|earliest)\b/i.test(q)) return { position: 'oldest' };
    if (/\b(all|every|gallery|galleries|history)\b/i.test(q)) return { position: 'all' };

    let s = String(q)
        .replace(/^(?:jarvis[,\s]+)?(?:show|display|view|open|see|find|get|where(?:'?s| is)|look at|pull up|bring up)\s*/i, '')
        .replace(/^\s*(?:me|us)\s+/i, '')
        .replace(/^\s*(?:the|that|this|my|a|an)\s+/i, '')
        .replace(SHOWABLE, ' ')
        .replace(POSITIONAL, ' ')
        .replace(/\b(of|for|from|please)\b/gi, ' ')
        .replace(/[^\w\s-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    if (s.length < 2) return { position: 'newest' };
    return { position: 'named', name: s };
}

/**
 * Find a creation verb that is actually being used as a verb.
 *
 * @returns {string|null} the matched verb, or null if every occurrence is a noun
 */
function createVerbUse(q) {
    const re = /\b(model|create|make|build|design|generate|sculpt|construct)\b/gi;
    let m;
    while ((m = re.exec(q)) !== null) {
        if (NOUN_CAPABLE.test(m[1]) && DETERMINER_BEFORE.test(q.slice(0, m.index))) continue;
        return m[1];
    }
    return null;
}

/* The thing that makes it a 3D request rather than any other kind of making.
   "make me a sandwich" and "create a spreadsheet" must not reach Blender. */
const THREE_D = /\b(3-?d|three[- ]dimensional|mesh|model|render|blender|scene|geometry|sculpt|stl|obj|glb|gltf|print(?:able)?)\b/i;

const REFINE_VERB = /\b(make it|change it|adjust|tweak|refine|instead|more|less|brighter|darker|shinier|rougher|smoother|bigger|smaller|redder|bluer|again)\b/i;

const EXPORT_VERB = /\b(export|save|write|give me)\b/i;
const EXPORT_FORMAT = /\b(stl|obj|ply|glb|gltf|blend|fbx)\b/i;

const PRINT_VERB = /\b(print|3-?d print|send to (?:the )?printer|slice)\b/i;

/* Render engine hints. "photorealistic" is the word people actually use when
   they mean the path tracer, and it is worth honouring because the difference
   between EEVEE and Cycles on this hardware is seconds versus minutes. */
const WANTS_CYCLES = /\b(photo-?realistic|realistic|ray[- ]?trac|path[- ]?trac|cycles|caustic|refract|glass|accurate light)\b/i;
const WANTS_FAST = /\b(quick|fast|preview|draft|rough|eevee)\b/i;

/**
 * Strip the wrapper words to leave the subject.
 *
 * "create a 3D model of a gear and render it" -> "a gear"
 * The subject is what the planner model is asked to build, so leaving "3D
 * model of" in it wastes tokens and, more importantly, invites the model to
 * treat the words as part of the thing.
 */
export function extractSubject(text) {
    let s = String(text ?? '').trim();

    s = s.replace(/^(?:hey\s+)?jarvis[,\s]+/i, '');
    s = s.replace(new RegExp(`^\\s*(?:please\\s+)?(?:${CREATE_VERB.source.slice(2, -2)})\\s+`, 'i'), '');
    s = s.replace(/^\s*(?:me|us)\s+/i, '');
    s = s.replace(/^\s*(?:a|an|the)\s+/i, '');
    s = s.replace(/^\s*(?:3-?d|three[- ]dimensional)\s+/i, '');
    s = s.replace(/^\s*(?:model|mesh|scene|render(?:ing)?)\s+(?:of\s+)?/i, '');
    s = s.replace(/^\s*(?:a|an|the)\s+/i, '');

    /* Trailing instructions are not part of the subject. "and render it" and
       "then print it" describe what to do with the thing, not the thing.

       The optional `as <format>` tail matters: "and export it as stl" left
       "and export it as stl" glued to the subject, so the planner was asked to
       model a "hex nut and export it as stl". The format has already been
       captured by the caller as wantsExport by this point. */
    s = s.replace(/\s*(?:,)?\s*(?:and|then)\s+(?:render|print|export|save|show)\s+(?:it|them|that)?\s*(?:as\s+(?:an?\s+)?[\w.]+)?\s*\.?$/i, '');
    s = s.replace(/\s+(?:in|with)\s+blender\s*\.?$/i, '');
    s = s.replace(/\s*\.$/, '');

    return s.trim();
}

/**
 * Parse a Foundry command.
 *
 * @returns {{action:string, subject?:string, format?:string, engine?:string, render?:boolean}|null}
 *   null means "not a Foundry command", which is the common case and not a
 *   failure — the caller keeps routing.
 */
export function parseFoundryCommand(text) {
    const raw = String(text ?? '').trim();
    if (!raw) return null;
    const q = raw.toLowerCase().replace(/\s+/g, ' ');

    /* Questions never build. Applied before anything else so no later branch
       can bypass it.

       ONE EXCEPTION, and it is the same shape as the two systemCommands.js
       allows through its guard: "where is my model" and "where's the render"
       are questions whose answer IS the action — showing it. They read
       nothing, build nothing, and refusing them means the obvious phrasing
       silently does nothing. Every other question still stops here. */
    if (QUESTION.test(q)) {
        if (/^(?:jarvis[,\s]+)?where(?:'?s| is)?\b/i.test(q) && SHOWABLE.test(q)) {
            return { action: FOUNDRY_ACTIONS.SHOW, which: whichJob(q) };
        }
        return null;
    }

    /* Negation. "don't render it" and "no, don't make that" are neighbours of
       the affirmative in every embedding space and are handled exactly, here,
       for the same reason the recycle bin is. */
    if (/\b(don'?t|do not|never|no,?\s+don'?t|cancel|stop|abort)\b/.test(q)) return null;

    /* "show me the model" is a request to SEE what exists, not to build
       another one. Checked before anything else claims the sentence.

       When it names something this feature produces, it becomes a SHOW —
       `read` effects, so it opens the viewer and builds nothing. When it does
       not, it is somebody else's command ("show me my screen", "show files")
       and this parser declines. */
    if (DISPLAY_VERB.test(q)) {
        return SHOWABLE.test(q) ? { action: FOUNDRY_ACTIONS.SHOW, which: whichJob(q) } : null;
    }
    /* The bare forms, with no display verb at all. */
    if (/^(?:jarvis[,\s]+)?(?:the\s+)?(?:last|latest|previous)\s+(?:model|render|scene|build)\b/i.test(q)
        || /^(?:jarvis[,\s]+)?foundry(?:\s+(?:gallery|viewer|history))?\s*$/i.test(q)) {
        return { action: FOUNDRY_ACTIONS.SHOW, which: whichJob(q) };
    }

    /* --- print: checked first, because it is the one that spends material --- */
    if (PRINT_VERB.test(q) && !/\bprintable\b/.test(q)) {
        /* "print it" with no subject refers to the current scene. */
        const subject = extractSubject(raw.replace(/\b(3-?d )?print(?: me)?\b/i, '').trim());
        return { action: FOUNDRY_ACTIONS.PRINT, subject: subject || null };
    }

    /* --- create ---

       CHECKED BEFORE EXPORT, and the order is the whole point. "design a 3d
       model of a hex nut and export it as stl" is one request, not two: it
       contains an export verb and a format, so an export-first ordering
       claimed it and routed a build to the export path, which does nothing on
       its own. Create already carries `wantsExport`, so the combined sentence
       is handled here in one job and the export branch below is left to the
       case it is actually for — a bare "export that as stl" with no verb of
       creation in it. */
    if (createVerbUse(q) && THREE_D.test(q)) {
        const subject = extractSubject(raw);
        if (!subject) return null;      // "make a 3D model" with no subject is not actionable
        return {
            action: FOUNDRY_ACTIONS.CREATE,
            subject,
            engine: WANTS_CYCLES.test(q) ? 'CYCLES' : WANTS_FAST.test(q) ? 'BLENDER_EEVEE' : null,
            render: !/\bdon'?t render\b/.test(q),
            wantsExport: EXPORT_FORMAT.test(q) ? (q.match(EXPORT_FORMAT)[1].toLowerCase() === 'gltf' ? 'glb' : q.match(EXPORT_FORMAT)[1].toLowerCase()) : null
        };
    }

    /* --- export, on its own --- */
    if (EXPORT_VERB.test(q) && EXPORT_FORMAT.test(q)) {
        const fmt = q.match(EXPORT_FORMAT)[1].toLowerCase();
        return { action: FOUNDRY_ACTIONS.EXPORT, format: fmt === 'gltf' ? 'glb' : fmt };
    }

    /* --- refine: only meaningful with a scene already open, which the caller
       knows and this parser does not. It returns the instruction and lets the
       service decide whether there is anything to refine. --- */
    if (REFINE_VERB.test(q) && (THREE_D.test(q) || /\b(it|that|this)\b/.test(q))) {
        /* Guarded hard: "make it louder" is a volume command and "make it
           bigger" during a 3D session is not. Without a subject noun the only
           thing distinguishing them is session state, so a bare refinement is
           only claimed when something 3D is named or the caller has a scene. */
        if (!THREE_D.test(q) && !/\b(bigger|smaller|shinier|rougher|smoother|metallic|matte|redder|bluer|brighter|darker)\b/.test(q)) {
            return null;
        }
        return { action: FOUNDRY_ACTIONS.REFINE, instruction: raw };
    }

    return null;
}

export default { parseFoundryCommand, extractSubject, FOUNDRY_ACTIONS };
