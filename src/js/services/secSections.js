/**
 * @fileoverview SEC filing structure — section parsing and topic-targeted retrieval.
 *
 * PURE: no network, no DOM, no clock. Operates on the text that
 * investigation.extractDocumentText() produces.
 *
 * WHY THIS EXISTS, measured rather than argued. On 24 Jul 2026 the company
 * pipeline fetched Alphabet's real 10-Q (2.4MB, 198,885 characters of prose),
 * handed it to the generic sentence selector with the spoken utterance as the
 * query, and got back:
 *
 *   "'Alphabet,' 'Google,' and other trademarks of ours appearing in this
 *    report are our property. ... Google was incorporated in California in
 *    September 1998 and re-incorporated in the State of Delaware in August 2003"
 *
 * Zero revenue figures. The selector was working correctly; it was asked the
 * wrong question. "sec filings of google" is a ROUTING signal — it contains no
 * financial term for BM25 to match, so the best-matching sentences in a
 * quarterly report are the ones that happen to say "Google".
 *
 * A 10-Q is not a bag of sentences. It has a mandated structure, and the thing
 * you want is almost always IN A NAMED SECTION. Retrieval that knows the
 * structure does not need to guess.
 *
 * EVERY OFFSET BELOW WAS MEASURED against goog-20260630.htm, because the
 * failure modes are not the obvious ones:
 *
 *   1. THE TABLE OF CONTENTS LOOKS EXACTLY LIKE THE DOCUMENT. "Item 1 Financial
 *      Statements 4 Consolidated Balance Sheets" sits at offset 5,061 and is a
 *      ToC line with a page number in it. The real body begins at 9,424. A
 *      parser that takes the first match indexes the entire filing to its
 *      contents page and returns nothing.
 *   2. CROSS-REFERENCES ARE NOT HEADINGS. "Item 1A, 'Risk Factors' in our
 *      Annual Report on Form 10-K" appears five times in this filing. It is a
 *      pointer to a DIFFERENT document.
 *   3. NOTE NUMBERS GO BACKWARDS. "Note 4 — The maximum exposure arising from
 *      leases with VIEs" sits at 65,389, AFTER Note 5 at 63,569. It is prose
 *      referring back to Note 4, not the start of it. Monotonicity is the only
 *      thing that separates them.
 *
 * The notes are the payload. In this filing they are where the answers live:
 * Note 2 Revenues (34,716), Note 8 Acquisitions and Divestitures — Wiz
 * Acquisition (75,774), Note 9 Goodwill and Intangible Assets (78,896).
 */

/* --- heading detection ---------------------------------------------------------- */

/* Financial-statement notes: "Note 8 — Acquisitions and Divestitures".
   The separator varies by filer and by converter; all of the dash forms and the
   colon are accepted, and so is a bare space. */
const NOTE_RE = /\bNote\s+(\d{1,2})\s*[—–\-.:]?\s+([A-Z][A-Za-z0-9 ,&'()\/-]{3,70})/g;

/* Body item headings. The body uses "ITEM 1." in caps where the contents page
   uses "Item 1"; that is a real distinction in this filer's output but not a
   reliable one across filers, so it is a hint and not the test. The test is
   position relative to the contents page — see parseSections. */
const ITEM_RE = /\b(?:ITEM|Item)\s+(\d{1,2}[A-Z]?)\s*[.:]?\s+([A-Z][A-Za-z0-9 ,&'()\/-]{3,90})/g;

const PART_RE = /\bPART\s+(I{1,3}V?|IV)\b/g;

/* NO "looks like a table of contents" TEXT HEURISTIC, deliberately.
   The obvious one — "a heading followed by a page number is a contents line" —
   was written, and it deleted the answer. Printed page numbers survive HTML
   extraction and land INSIDE body text: the real Note 8 reads "Acquisitions and
   Divestitures Wiz Acquisition 28 On March 11, 2026, we completed…", where 28
   is the page. That test dropped Note 8 (the Wiz acquisition) and Note 9
   (Goodwill) — the two sections an acquisition question exists to find.
   Position relative to the contents page already separates them, so the text
   heuristic was redundant as well as wrong. */

/* "in our Annual Report on Form 10-K", "of this Quarterly Report" — a pointer
   to a section, not the section. */
const looksLikeCrossRef = (before, title) =>
    /\b(?:see|in|of|under|described in|refer to|as updated in|included in)\s*$/i.test(before)
    || /\b(?:Annual Report|Quarterly Report|Form 10-[KQ]|this Report)\b/i.test(title);

/* ORDERING A SECTION NUMBER.
 *
 * This was `parseInt(number, 10)`, and parseInt('1A') is 1 — exactly equal to
 * Item 1, so the monotonic check below rejected every lettered item as a
 * backwards reference. Measured on a 10-K shaped document: items 1 and 7 were
 * kept, 1A and 7A were dropped. Item 1A is RISK FACTORS, which is close to the
 * most-asked section in the filing, and 7A is the market-risk disclosure.
 *
 * The suffix is the tie-break instead, giving 1 < 1A < 1B < 2. A missing suffix
 * sorts first, which is the real document order.
 */
function rankSection(number) {
    const m = /^(\d{1,2})([A-Z]?)$/.exec(String(number || '').toUpperCase());
    return m ? { n: parseInt(m[1], 10), suffix: m[2] } : null;
}

/** Strictly after, in document-numbering order. */
function isAfter(a, b) {
    return a.n !== b.n ? a.n > b.n : a.suffix > b.suffix;
}

/**
 * Split filing text into sections.
 *
 * @param {string} text  output of extractDocumentText
 * @returns {Array<{kind: 'note'|'item', number: string, title: string, start: number, end: number, text: string}>}
 */
export function parseSections(text) {
    const src = String(text || '');
    if (src.length < 200) return [];

    /* WHERE THE DOCUMENT STARTS. The contents page and the body both contain
       "PART I". Measured on the real filing: contents at 5,031, body at 9,424.
       When PART I appears more than once, everything before the LAST occurrence
       in the first fifth of the document is contents and is skipped. Filings
       with no contents page are unaffected, because there is then only one. */
    const parts = [...src.matchAll(PART_RE)].map((m) => m.index);
    const firstFifth = src.length / 5;
    const early = parts.filter((i) => i < firstFifth);
    const bodyStart = early.length > 1 ? early[early.length - 1] : 0;

    /* PART BOUNDARIES INSIDE THE BODY. A 10-Q numbers Part I as Items 1-4 and
       then RESTARTS Part II at Item 1 — so a monotonic item counter that runs
       across the whole filing throws away everything after Part I, which is
       where Legal Proceedings and the quarterly Risk Factors update live. The
       counter is reset at each Part instead. Notes are NOT reset: financial
       statement notes run continuously to the end of the filing. */
    const partBoundaries = parts.filter((i) => i > bodyStart);

    const found = [];

    for (const [re, kind] of [[NOTE_RE, 'note'], [ITEM_RE, 'item']]) {
        re.lastIndex = 0;
        for (const m of src.matchAll(re)) {
            if (m.index < bodyStart) continue;                       // contents page
            const title = m[2].replace(/\s+/g, ' ').trim();
            if (looksLikeCrossRef(src.slice(Math.max(0, m.index - 24), m.index), title)) continue;
            found.push({ kind, number: m[1], title: trimTitle(title), start: m.index });
        }
    }

    found.sort((a, b) => a.start - b.start);

    /* MONOTONICITY. Within a kind, a number that goes backwards is prose
       referring to an earlier section, not the start of a new one — "Note 4 —
       The maximum exposure…" at 65,389 arrives after Note 5 at 63,569. */
    const kept = [];
    const highest = { note: { n: 0, suffix: '' }, item: { n: 0, suffix: '' } };
    let partIdx = 0;
    for (const s of found) {
        while (partIdx < partBoundaries.length && partBoundaries[partIdx] <= s.start) {
            highest.item = { n: 0, suffix: '' };
            partIdx++;
        }
        const r = rankSection(s.number);
        if (!r) continue;
        if (!isAfter(r, highest[s.kind])) continue;
        highest[s.kind] = r;
        kept.push(s);
    }

    /* A section runs to the next heading of ANY kind, or to the end. */
    return kept.map((s, i) => {
        const end = i + 1 < kept.length ? kept[i + 1].start : src.length;
        return { ...s, end, text: src.slice(s.start, end) };
    });
}

/* Words that belong inside a heading even though they are lower-case. */
const CONNECTIVE = /^(?:and|of|the|to|about|for|in|on|per|from|with|&|,)$/i;

/**
 * Headings run straight into their body text after extraction, so the captured
 * span has to be cut back to the title.
 *
 * Two things end a heading: the printed page number that follows it ("…Wiz
 * Acquisition 28 On March 11, 2026…"), and the first lower-case word that is
 * not a connective, which is where ordinary prose begins.
 *
 * The first version of this had `(?:[A-Z]\w*|and|of|the)+` with NO whitespace
 * between the alternatives, so it could only ever match ONE word — every
 * multi-word heading was truncated to its first token and "Summary of
 * Significant Accounting Policies" became "Summary". That silently broke topic
 * routing, because a one-word title matches almost no topic pattern.
 */
function trimTitle(title) {
    const t = String(title).replace(/\s+/g, ' ').trim();
    const beforePage = t.split(/\s\d{1,4}\s/)[0];

    const out = [];
    for (const w of beforePage.split(' ')) {
        const bare = w.replace(/^[("']+/, '');
        if (/^[A-Z0-9]/.test(bare) || CONNECTIVE.test(bare)) out.push(w);
        else break;
    }
    /* A heading must not END on a connective — "Goodwill and" is worse than
       "Goodwill". */
    while (out.length && CONNECTIVE.test(out[out.length - 1])) out.pop();

    const head = out.join(' ').replace(/[,\s]+$/, '');
    return head.length >= 3 ? head.slice(0, 70) : beforePage.slice(0, 70);
}

/* --- subsections -------------------------------------------------------------------
 * WHY DESCENDING IS NOT OPTIONAL. Measured on the real 10-Q: Item 2 (MD&A) is
 * 51,176 characters, roughly 12,794 tokens. Ollama reports gemma3:4b loaded
 * with context_length 4096. The single most useful section in the filing is
 * THREE TIMES the model's entire context window, so "retrieve the right
 * section" is only half an answer — the section still has to be narrowed.
 *
 * MD&A subsection headings are clean and useful: "Google Cloud", "Capital
 * Expenditures", "Share Repurchase Program", "Liquidity and Material Cash
 * Requirements", "Acquisitions and Divestitures".
 *
 * The trap is that ordinary sentences look identical after extraction. "As of
 * June", "In January", "On March", "In Google" all match a title-case run.
 * They are sentence openings, not headings, and every one of them is a
 * preposition or temporal lead-in — which is what distinguishes them.
 */

/* A heading candidate: 2-8 title-case or all-caps words, followed by prose. */
const SUBHEAD_RE = /(?:^|\.\s|\s{2})((?:[A-Z][a-z]+|[A-Z]{2,})(?:\s(?:[A-Z][a-z]+|[A-Z]{2,}|and|of|the|&)){1,7})\s+(?=[A-Z][a-z]|We\b|The\b|Our\b|\$|\d)/g;

/* Words that begin a sentence, never a heading. */
const NOT_A_HEADING = /^(?:As|In|On|At|By|For|During|Following|After|Before|Since|Through|Under|With|We|Our|The|This|These|Those|If|When|While|Additionally|However|Refer|See)\b/i;

/**
 * Split one section into its subsections.
 * Offsets are ABSOLUTE, carried from the parent, so a subsection can be cited
 * against the filing rather than against a fragment of it.
 *
 * @returns {Array<{title: string, start: number, end: number, text: string}>}
 */
export function parseSubsections(section) {
    const body = String(section?.text || '');
    if (body.length < 400) return [];
    const base = Number(section?.start) || 0;

    const heads = [];
    const seen = new Set();
    for (const m of body.matchAll(SUBHEAD_RE)) {
        const title = m[1].replace(/\s+/g, ' ').trim();
        if (title.length < 8) continue;
        if (NOT_A_HEADING.test(title)) continue;
        /* The first occurrence is the heading; later ones are references back
           to it in the prose. */
        if (seen.has(title)) continue;
        seen.add(title);
        heads.push({ title, offset: m.index + m[0].indexOf(m[1]) });
    }
    if (!heads.length) return [];

    return heads.map((h, i) => {
        const end = i + 1 < heads.length ? heads[i + 1].offset : body.length;
        return {
            title: h.title,
            start: base + h.offset,
            end: base + end,
            text: body.slice(h.offset, end),
        };
    });
}

/**
 * A section, narrowed to the parts that match the topics — but only when it is
 * too big to use whole.
 *
 * Narrowing a section that already fits costs precision for nothing: the whole
 * of Note 8 (3,122 characters) is exactly what an acquisition question wants,
 * and slicing it into "Wiz Acquisition" alone would drop the purchase-price
 * allocation table that follows.
 *
 * @returns {{parts: Array<{title, text, start, end}>, narrowed: boolean}}
 */
export function narrowSection(section, topics, { maxChars = 6000 } = {}) {
    const whole = [{ title: section.title, text: section.text, start: section.start, end: section.end }];
    if (!section?.text || section.text.length <= maxChars) return { parts: whole, narrowed: false };

    const subs = parseSubsections(section);
    if (!subs.length) return { parts: whole, narrowed: false };

    const patterns = (topics || []).flatMap((t) => SECTION_TOPICS[t] || []);
    const hits = patterns.length ? subs.filter((s) => patterns.some((re) => re.test(s.title))) : [];

    /* No topic, or no subsection matched it: keep the section's OPENING rather
       than an arbitrary middle. A section's first paragraphs are its summary in
       almost every filing, and an arbitrary slice is worse than a truncation
       the reader can recognise as one. */
    if (!hits.length) return { parts: [{ ...whole[0], text: section.text.slice(0, maxChars) }], narrowed: true };

    return { parts: hits, narrowed: true };
}

/* --- topic ontology ---------------------------------------------------------------
 * The mapping from what a person asks to where SEC filings put the answer.
 *
 * This is a vocabulary problem, not a semantic one, which is why it is a table
 * and not an embedding. Nobody writes "acquisitions" in a 10-Q; they write
 * "Business Combinations", and the goodwill note carries the other half of the
 * same transaction. A dense retriever has to LEARN that those are the same
 * topic. A filing's own table of contents already knows.
 */
export const SECTION_TOPICS = {
    revenue: [/revenue/i, /disaggregat/i, /segment/i],
    acquisitions: [/acquisit/i, /business combination/i, /divestiture/i, /goodwill/i, /intangible/i],
    debt: [/\bdebt\b/i, /borrowing/i, /notes payable/i, /credit facilit/i],
    risk: [/risk factor/i, /market risk/i, /quantitative and qualitative/i],
    legal: [/legal proceeding/i, /contingenc/i, /commitments/i, /litigation/i],
    mdna: [/management.{0,3}s discussion/i, /results of operations/i, /financial condition/i],
    taxes: [/income tax/i, /\btaxes\b/i],
    compensation: [/compensation plan/i, /stock-?based/i, /share-?based/i],
    equity: [/stockholders/i, /shareholders/i, /repurchase/i, /buyback/i, /per common share/i],
    leases: [/\bleases?\b/i],
    financials: [/financial statement/i, /balance sheet/i, /statements of income/i, /cash flow/i],
};

/* What a spoken question is ABOUT. Deliberately generous on the input side and
   strict on the output side: several topics may fire, and each one only adds a
   place to look. */
/* EVERY PREFIX ENDS `\w*`, NOT `\b`.
   The first version wrote `\b(acquisi|acquired|…)\b`, and the trailing \b
   requires a word boundary immediately after "acquisi" — which the word
   "acquisitions" does not have, because it continues with a "t". So the single
   most obvious acquisition query in existence, "what acquisitions did google
   make", matched NO topic and fell through to the revenue default.

   This is the third time this exact mistake has been made in this codebase:
   edgarSearch.js documents it for form plurals ("8-Ks"), and eval/RESULTS.md
   records a `mustNot: /\b12\s?%\b/` that could never fire because % is not a
   word character. A \b after a prefix or a symbol is almost always wrong. */
const TOPIC_CUES = {
    revenue: /\b(?:revenue\w*|sales|top ?line|growth|segment\w*|cloud|advertising|billings?)\b/i,
    /* "what did they pay for Wiz" named no topic until the price vocabulary
        was added — the question is about an acquisition but says none of the
        acquisition words, only the consideration. `paid`/`pay for` can also
        appear around dividends, which is harmless: dividends have their own
        cue, and an extra topic only adds a place to look. */
    acquisitions: /\b(?:acquisi\w*|acquir\w*|merger?s?|merged|bought|buyout|purchas\w*|takeover|divest\w*|goodwill|business combination\w*|paid|pay for|consideration)\b/i,
    debt: /\b(?:debt|borrow\w*|leverage|credit facilit\w*|notes payable|interest expense|maturit\w*)\b/i,
    risk: /\b(?:risks?|threat\w*|exposure|headwind\w*|uncertaint\w*)\b/i,
    legal: /\b(?:legal|lawsuits?|litigat\w*|antitrust|regulat\w*|contingenc\w*|settlement\w*|proceeding\w*)\b/i,
    mdna: /\b(?:performance|results|outlook|guidance|discussion|margins?|profit\w*|operations)\b/i,
    taxes: /\b(?:taxe?s?|effective rate|deferred tax)\b/i,
    compensation: /\b(?:compensation|stock-?based|sbc|payroll|executive\w*)\b/i,
    equity: /\b(?:buybacks?|repurchas\w*|dividend\w*|shares outstanding|eps|per share|dilut\w*|stockholder\w*)\b/i,
    leases: /\b(?:leases?|leasing|rent\w*)\b/i,
    financials: /\b(?:balance sheet|cash flow\w*|income statement|financial statements?|assets|liabilit\w*|capex|capital expenditure\w*)\b/i,
};

/** Topics a question touches, best-guess first. Empty means "no topic named". */
export function topicsFor(query) {
    const q = String(query || '');
    return Object.entries(TOPIC_CUES).filter(([, re]) => re.test(q)).map(([name]) => name);
}

/** Sections whose title matches any of the given topics. */
export function sectionsForTopics(sections, topics) {
    if (!topics?.length) return [];
    const patterns = topics.flatMap((t) => SECTION_TOPICS[t] || []);
    return (sections || []).filter((s) => patterns.some((re) => re.test(s.title)));
}

/**
 * The sections a filing-reading question should be answered from.
 *
 * FALLBACK IS THE IMPORTANT PART. When the question names no topic — which is
 * the common case on the voice path, where "sec filings of google" is all we
 * get — targeting nothing would return nothing. The default is then the
 * highest-value sections a reader would open first, by name, which is still
 * enormously better than sentence-matching a contentless query against 198,885
 * characters and landing on the trademark notice.
 *
 * @returns {{sections: object[], topics: string[], reason: string}}
 */
export function planSectionRetrieval(sections, query, { maxSections = 4, maxChars = 6000 } = {}) {
    const all = sections || [];
    if (!all.length) return { sections: [], parts: [], topics: [], reason: 'no sections parsed' };

    const topics = topicsFor(query);
    let chosen, reason;

    const targeted = sectionsForTopics(all, topics);
    if (targeted.length) {
        chosen = targeted.slice(0, maxSections);
        reason = `topic: ${topics.join(', ')}`;
    } else {
        const defaults = sectionsForTopics(all, ['revenue', 'mdna', 'financials', 'acquisitions']);
        chosen = (defaults.length ? defaults : all).slice(0, maxSections);
        /* "No topic named" and "a topic was named but no section title matched
           it" are different failures and must not share a message. The first is
           the voice path working as expected; the second means the ontology and
           this filing's headings disagree, which is the thing worth fixing. The
           trace said "no topic named" for both, hiding the second entirely. */
        const how = topics.length ? `topic ${topics.join(', ')} matched no section title` : 'no topic named';
        reason = `${how} — ${defaults.length ? 'default sections' : 'first sections'}`;
    }

    /* HIERARCHICAL DESCENT. A section that fits is used whole; one that does
       not is narrowed to its topic-matching subsections. Splitting the budget
       across the chosen sections keeps one oversized section (MD&A is 51,176
       characters) from consuming everything the others needed.
       The floor stops a small overall budget divided across several sections
       from slicing each one below the point where it says anything. */
    const perSection = Math.max(Math.min(1200, maxChars), Math.floor(maxChars / Math.max(1, chosen.length)));
    const parts = [];
    let narrowed = 0;
    for (const s of chosen) {
        const n = narrowSection(s, topics, { maxChars: perSection });
        if (n.narrowed) narrowed++;
        for (const p of n.parts) parts.push({ ...p, section: s.title, kind: s.kind, number: s.number });
    }

    return {
        sections: chosen,
        parts,
        topics,
        narrowed,
        reason: narrowed ? `${reason}; ${narrowed} section(s) narrowed to subsections` : reason,
    };
}

/**
 * Evidence Coverage — which of the sections a question needs were actually
 * found, reported as a fraction with the missing ones named.
 *
 * NOT published as a percentage-shaped confidence. It says which named sections
 * are present and which are absent, both of which are facts about the document.
 * "Coverage 0.75" invites being read as "75% correct", so the caller gets the
 * lists and decides what to say.
 */
export function coverage(sections, topics) {
    const wanted = topics?.length ? topics : ['revenue', 'mdna', 'financials'];
    const present = [], missing = [];
    for (const t of wanted) {
        (sectionsForTopics(sections, [t]).length ? present : missing).push(t);
    }
    return { present, missing, found: present.length, wanted: wanted.length };
}

/** A one-line description of what was retrieved, for the trace and the display. */
export function describeSections(sections) {
    if (!sections?.length) return 'no sections identified';
    return sections.map((s) => `${s.kind === 'note' ? 'Note' : 'Item'} ${s.number} ${s.title}`).join('; ');
}

export default {
    SECTION_TOPICS, parseSections, parseSubsections, narrowSection,
    topicsFor, sectionsForTopics, planSectionRetrieval, coverage, describeSections,
};
