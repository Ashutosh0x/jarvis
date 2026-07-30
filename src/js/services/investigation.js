/**
 * @fileoverview Investigation pipeline — collect, READ, corroborate, then answer.
 *
 * PURE: planning, extraction and evidence accounting. No network, no DOM, no
 * clock except where passed in. The fetches live in the caller.
 *
 * WHY THIS EXISTS — the failure it is built from, verbatim from the interaction
 * log of 22 Jul 2026. The user asked about new SEC filings. The feed store held
 * three Goldman Sachs events whose entire summary text was the string "424B2":
 * a title, a form type, a date, a link. Over eight turns the model produced a
 * complete executive-compensation structure ending at "$8.5 billion" and a
 * "1.25 skew factor". None of it existed.
 *
 * The real document was ONE request away. Measured: 0.68s, 354KB of HTML,
 * 76,076 characters of text. It is a $17,320,000 contingent income
 * auto-callable note linked to NVIDIA stock — nothing to do with compensation.
 *
 * So the missing stage was never smarter prompting. It was READING THE
 * DOCUMENT. This module is that stage, and its contract is:
 *
 *     no evidence -> no answer.
 *
 * The model is called ONCE, at the end, over text that was actually fetched.
 * It is never asked what a filing says; it is asked to summarise text placed in
 * front of it, and every claim it makes is checkable against that text.
 *
 * LATENCY IS THE DELIBERATE TRADE. The 23rd pass measured gemma3:4b at ~3.0s
 * per planning call and concluded a multi-step agent loop (5-20 steps) would be
 * 15-60s — unusable on the spoken path. That finding stands. Investigation is
 * therefore an EXPLICIT, typed, slow capability: the user asks to investigate
 * and accepts that it takes time. It must never sit on the voice hot path.
 */

/* --- evidence ---------------------------------------------------------------
   Every item carries where it came from. An item whose origin cannot be named
   is not evidence and does not enter the ledger — the same rule extraction.js
   applies to memory, for the same reason. */

export const EVIDENCE_KINDS = {
    document: { weight: 3, label: 'primary document' },  // fetched filing text
    search: { weight: 2, label: 'full-text search' },    // EDGAR hit metadata
    feed: { weight: 2, label: 'feed event' },            // ingested, dated, linked
    memory: { weight: 1, label: 'long-term memory' },    // prior RAG chunk
    web: { weight: 1, label: 'web result' },             // keyless search snippet
};

/** Total characters of evidence handed to the model. Sized from the measured
 *  cost of the real filing: 76k chars is ~19k tokens, which gemma3:4b will
 *  accept and reason over badly. Selection, not truncation, gets us under it —
 *  and the 22nd pass measured late sentence selection at an 81% reduction with
 *  the right passage still at rank 1. */
export const EVIDENCE_BUDGET_CHARS = 6000;

/**
 * What an investigation should do, derived from the question alone.
 * Rule-based: a mis-planned investigation spends real network requests, and the
 * model that would plan it is the same one whose unsupported claims caused this
 * module to exist.
 *
 * @returns {{subject: string, steps: string[], forms: string[]}}
 */
export function planInvestigation(query) {
    const q = String(query || '').trim();
    if (!q) return null;

    const steps = ['memory'];
    const forms = [];

    // A filing-shaped question earns the EDGAR steps.
    const filingish = /\b(filing|filed|8-?k|10-?k|10-?q|424b|prospectus|sec|edgar|proxy|s-?1|disclosure)\b/i.test(q);
    if (filingish) { steps.push('search', 'document'); }

    // A named company or ticker is worth corroborating on the open web.
    const named = /\b[A-Z][A-Za-z&.]+(?:\s+[A-Z][A-Za-z&.]+)*\b/.test(q) || /\b[A-Z]{2,5}\b/.test(q);
    if (named) steps.push('web');

    if (/\b8-?ks?\b/i.test(q)) forms.push('8-K');
    if (/\b10-?ks?\b/i.test(q)) forms.push('10-K');
    if (/\b424b\d?\b/i.test(q)) forms.push('424B2');

    return { subject: q, steps, forms };
}

/* --- document extraction -----------------------------------------------------
   SEC documents are HTML with inline styling and, for inline XBRL, a large
   volume of ix: tags carrying no prose. Everything below was written against
   the real Goldman 424B2 body, not against a guess at what EDGAR serves. */

export function extractDocumentText(html, { maxChars = 200000 } = {}) {
    const raw = String(html || '');
    if (!raw) return '';
    const text = raw
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        /* INLINE XBRL SCAFFOLDING. Measured on Alphabet's 10-Q of 23 Jul 2026
           (goog-20260630.htm, 2,464,133 bytes): the <ix:header> block is
           281,415 bytes on its own — LARGER THAN THIS FUNCTION'S ENTIRE 200,000
           CHARACTER BUDGET. It holds no prose. It is context definitions, unit
           declarations and taxonomy URIs, so stripping tags turns it into
           thousands of repetitions of "http://fasb.org/us-gaap/2026#Revenues".

           The damage was not cosmetic. Before this line the extracted text
           began 49,963 characters into XBRL URIs, "Total revenues" appeared at
           char 84,614, and the condensed consolidated statements never
           appeared at all — the cap was reached first. After it, the document
           starts at char 682 with "UNITED STATES SECURITIES AND EXCHANGE
           COMMISSION ... FORM 10-Q", revenues arrive at 35,333, and the count
           of surviving XBRL noise tokens drops from 641 to 0.

           SEFD (arXiv:2606.18192) names this class directly: SEC documents
           carry "a large volume of ix: tags carrying no prose." <ix:hidden> is
           the same problem an order of magnitude smaller (4,943 bytes here) and
           goes with it. Only these two containers are removed — inline ix:
           tags WRAPPING real values stay, because their text is the filing. */
        .replace(/<ix:header[\s\S]*?<\/ix:header>/gi, ' ')
        .replace(/<ix:hidden[\s\S]*?<\/ix:hidden>/gi, ' ')
        // Tables carry the numbers, so their cells are kept but separated —
        // without a boundary "1.25" and "90" run together into "1.2590".
        .replace(/<\/(td|th|tr|p|div|br|li)>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;|&#160;/g, ' ')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&#\d+;|&[a-z]+;/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return text.slice(0, maxChars);
}

/**
 * Pick the primary document out of an EDGAR filing-index listing.
 * The index also carries the complete submission .txt (every exhibit
 * concatenated, often megabytes) and the header html; neither is the filing.
 */
export function pickPrimaryDocument(items, { accession = '' } = {}) {
    const list = Array.isArray(items) ? items : [];
    const named = list
        .map((i) => ({ name: String(i.name || ''), size: Number(i.size) || 0 }))
        .filter((i) => /\.html?$/i.test(i.name))
        .filter((i) => !/-index|index-headers|^0*\d{10}-\d{2}-\d{6}\.txt$/i.test(i.name))
        // The full-submission text file is not html, but its index twin is.
        .filter((i) => !accession || !i.name.startsWith(accession));
    if (!named.length) return null;
    // The primary document is the largest remaining html file: exhibits and
    // certifications are small, the filing itself is not.
    named.sort((a, b) => b.size - a.size);
    return named[0].name;
}

/* --- evidence ledger ---------------------------------------------------------- */

/**
 * Build the ledger. Deduplicates on normalised text so the same fact arriving
 * from a feed and from a search does not count twice — the origin-counting rule
 * from extraction.js, applied to retrieval instead of memory.
 */
export function buildLedger(items = []) {
    const seen = new Set();
    const out = [];
    for (const it of items) {
        if (!it || !it.text || !it.kind || !EVIDENCE_KINDS[it.kind]) continue;
        const text = String(it.text).replace(/\s+/g, ' ').trim();
        if (text.length < 8) continue;
        const key = text.slice(0, 160).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
            kind: it.kind,
            weight: EVIDENCE_KINDS[it.kind].weight,
            text,
            source: it.source || null,
            // Whose document this is. Carried separately from `source` because
            // entity attribution is checked against it.
            entity: it.entity || null,
            url: it.url || null,
            published: it.published || null,
        });
    }
    // Primary documents first: the whole point is that a fetched filing
    // outranks a headline about it.
    out.sort((a, b) => b.weight - a.weight);
    return out;
}

/** Characters of evidence, per kind — reported so a thin investigation is
 *  visible as thin rather than reading like a confident answer. */
export function describeLedger(ledger = []) {
    const byKind = {};
    for (const e of ledger) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
    const chars = ledger.reduce((n, e) => n + e.text.length, 0);
    return { items: ledger.length, chars, byKind, hasPrimary: ledger.some((e) => e.kind === 'document') };
}

/**
 * Render the ledger into a context block, newest and heaviest first, stopping
 * at the budget. Every line is numbered so the answer can cite [n] and a human
 * can check it.
 */
export function renderEvidence(ledger = [], { budget = EVIDENCE_BUDGET_CHARS } = {}) {
    const lines = [];
    let used = 0;
    for (let i = 0; i < ledger.length; i++) {
        const e = ledger[i];
        const head = `[${lines.length + 1}] (${EVIDENCE_KINDS[e.kind].label}${e.published ? `, ${String(e.published).slice(0, 10)}` : ''})`;
        const room = budget - used - head.length - 2;
        if (room < 200) break;
        const body = e.text.length > room ? `${e.text.slice(0, room)}…` : e.text;
        lines.push(`${head} ${body}${e.url ? `\n    ${e.url}` : ''}`);
        used += head.length + body.length + 2;
    }
    return lines.join('\n');
}

/**
 * The synthesis prompt. Deliberately hostile to invention: the model is told
 * the evidence is all there is, told to cite, and told what to say when the
 * evidence does not answer the question — which is the case the log shows it
 * cannot handle on its own.
 */
export function buildSynthesisPrompt(question, ledger, { budget = EVIDENCE_BUDGET_CHARS, freshness = null } = {}) {
    const evidence = renderEvidence(ledger, { budget });
    if (!evidence) return null;                 // no evidence -> no call, no answer
    /* Rule 6 exists because rules 1-3 do not cover it: an answer can cite
       correctly, invent nothing, and still mislead by presenting month-old
       evidence in the present tense. */
    const temporal = freshness && freshness.stale
        ? ['7. This evidence is NOT current. Say so in your first sentence, and give every finding'
            + ` in the past tense as the position on ${freshness.newest ? freshness.newest.toISOString().slice(0, 10) : 'the dates shown'}.`]
        : [];
    return [
        'You are analysing evidence that was retrieved for a specific question.',
        'The numbered evidence below is the ONLY information you have. You cannot look anything up.',
        'Rules, in order of importance:',
        '1. Every factual claim must come from the evidence. Cite it as [n].',
        '2. If the evidence does not answer the question, say precisely what is missing and stop.',
        '3. Never state a figure, date, name or amount that is not in the evidence above.',
        '4. Do not offer to retrieve, display or elaborate on anything further.',
        '5. Be concise and concrete. Lead with what the evidence establishes.',
        /* Rule 6 is here because rules 1-3 do not reach it. Explaining what a
           DOCUMENT TYPE means is not a claim about a figure, a date or a name,
           so nothing above forbade it — and on 24 Jul 2026 the model used that
           gap to state that a Form 144 is filed "when a company intends to sell
           a significant block of its own stock" and "alerts the market to
           potential dilution". A 144 is filed by an affiliate selling
           restricted or control securities; it is not the issuer and not about
           dilution. The evidence carries the SEC's own purpose line for each
           form, so the correct description is already in front of it. */
        '6. Do not explain what a form, filing or document TYPE means beyond the wording the evidence'
        + ' gives for it. If the evidence states a form\'s purpose, you may restate that and nothing more.',
        ...temporal,
        '',
        `QUESTION: ${question}`,
        '',
        'EVIDENCE:',
        evidence,
    ].join('\n');
}

/* --- entity-attribution verification ------------------------------------------
 * Deceptive grounding (arXiv 2607.09349, Caruzzo et al., Jul 2026): a response
 * that accurately relays retrieved evidence but attributes it to the WRONG
 * entity. It passes hallucination, faithfulness and citation checks by
 * construction, because every claim really is sourced from a real document —
 * about someone else.
 *
 * NOT TAKEN ON FAITH. Reproduced here on 22 Jul 2026 with two real 424B2
 * filings. The ledger was given the Morgan Stanley filing and nothing else;
 * asked about Goldman Sachs, gemma3:4b answered:
 *
 *   "The Goldman Sachs filing is about a contingent income memory
 *    auto-callable security ... Aggregate principal amount: $700,000 ...
 *    Estimated value on the pricing date: $950.40 per security"
 *
 * Those are Morgan Stanley's numbers. The money guard PASSED it, correctly by
 * its own rule: every figure appears verbatim in the evidence. Figure-presence
 * is not entity-ownership, and no check in this codebase knew the difference.
 *
 * The paper's own ablation says the highest-leverage fix is retrieval, not
 * prompting: evidence about the queried entity suppresses the failure, and
 * prompt-based entity anchoring helps some model families and not others. So
 * the primary defence here is a GATE, applied before the model is called —
 * deterministic, and it cannot be talked around.
 */

/** Words that look like entity names but never are. */
const ENTITY_STOP = new Set(['the', 'a', 'an', 'what', 'when', 'where', 'which', 'who', 'why', 'how',
    'is', 'are', 'was', 'were', 'about', 'and', 'or', 'of', 'for', 'from', 'its', 'their',
    'filing', 'filings', 'document', 'report', 'key', 'numbers', 'sir', 'me', 'tell', 'investigate']);

/** Normalise a company name for comparison: case, punctuation and the
 *  corporate suffixes that differ between a feed title and a filing body
 *  ("GOLDMAN SACHS GROUP INC" vs "The Goldman Sachs Group, Inc."). */
export function normaliseEntity(name) {
    return String(name || '')
        .toLowerCase()
        .replace(/[.,&']/g, ' ')
        .replace(/\b(inc|incorporated|corp|corporation|co|company|group|holdings?|plc|ltd|limited|llc|lp|sa|ag|nv|the)\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Content words of a query that could name an entity. */
export function queryEntityTerms(query) {
    return String(query || '')
        .replace(/[^A-Za-z0-9 ]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 2 && !ENTITY_STOP.has(w.toLowerCase()))
        .map((w) => w.toLowerCase());
}

/**
 * Does the ledger actually contain evidence about the entity the question asks
 * about?
 *
 * Deliberately conservative in one direction: when the query names no entity at
 * all ("what changed this week"), there is nothing to mis-attribute and the
 * check passes. It only fires when the question is ABOUT someone and the
 * evidence is about someone else — the exact shape of the reproduced failure.
 *
 * @returns {{applies: boolean, ok: boolean, queried: string[], evidence: string[]}}
 */
export function verifyEntityAttribution(query, ledger = []) {
    const evidenceNames = [...new Set(ledger.map((e) => e.entity || e.source).filter(Boolean))];
    const evidenceNorm = evidenceNames.map(normaliseEntity).filter(Boolean);
    if (!evidenceNorm.length) return { applies: false, ok: true, queried: [], evidence: evidenceNames };

    /* The queried entity is whichever evidence-entity words the question uses.
       Matching against the evidence vocabulary rather than guessing names from
       capitalisation keeps this robust to speech input, which arrives without
       reliable case. */
    const qTerms = new Set(queryEntityTerms(query));
    const evidenceWords = new Set(evidenceNorm.flatMap((n) => n.split(' ')).filter((w) => w.length > 2));

    /* Words in the question that name SOME company but not one in the ledger
       are the danger signal. To find them we need a vocabulary of company-ish
       words beyond the ledger, which we do not have — so instead we ask the
       inverse, which is answerable: does ANY ledger entity share a
       distinctive word with the question? */
    const matched = evidenceNorm.filter((n) => n.split(' ').some((w) => w.length > 2 && qTerms.has(w)));

    /* If the question shares no distinctive word with any evidence entity, but
       DOES contain a word that looks like a proper name the evidence lacks,
       the question is about someone the evidence does not cover. */
    const unmatchedQueryWords = [...qTerms].filter((w) => !evidenceWords.has(w));
    const namesSomethingElse = matched.length === 0 && unmatchedQueryWords.length > 0;

    return {
        applies: true,
        ok: !namesSomethingElse,
        queried: unmatchedQueryWords,
        evidence: evidenceNames,
        matched,
    };
}

/**
 * The refusal that replaces a deceptively-grounded answer. States what the
 * evidence IS about, which is the useful half of the answer and the half the
 * model was burying.
 */
export function describeAttributionMismatch(query, check) {
    const names = (check.evidence || []).slice(0, 3).join(', ');
    return `I have no document about that, Sir. The evidence I retrieved is about ${names || 'a different entity'}, `
        + `and reporting its figures as an answer to "${query}" would be wrong even though every number in it is real.`;
}

/* --- temporal validity ---------------------------------------------------------
 * WorldReasoner (arXiv 2606.11816, Chi/Chamoun/Ding/Vlachos, Cambridge, Jun 2026)
 * measured six agent conditions on 345 resolved forecasting tasks and reported
 * one dominant effect: temporally valid retrieval. Search-Enabled 68.8% vs
 * Vanilla 58.7%; moving the evidence boundary to one day before resolution took
 * it to 74.7%. WHEN the evidence is from mattered more than any reasoning
 * machinery layered on top.
 *
 * The same paper is the reason nothing here builds a causal-graph simulator.
 * Causal Simulation scored 56.6% — BELOW the no-retrieval baseline — and adding
 * graph construction to search dropped accuracy from 68.8% to 64.4%. Graphs
 * improved the reasoning metric and hurt the answers. Those runs used Gemini 3
 * Pro and GPT-5.4; this machine runs gemma3:4b.
 *
 * Two failures are gated below, both deterministic, both pre-model:
 *
 *   HINDSIGHT LEAK — "what did the market know before the July 17 pricing"
 *   answered with evidence published on July 21. The answer is sourced and
 *   entity-correct and still wrong, because the evidence did not exist yet at
 *   the time asked about. This is the paper's Temporal Gateway.
 *
 *   STALE-AS-CURRENT — "what is the latest filing" answered from a feed event
 *   ingested weeks ago, with nothing in the reply admitting its age. In finance
 *   this is the more expensive of the two: the figure is real, the citation
 *   resolves, and the number is out of date.
 */

/** A "current" question answered from evidence older than this is reported with
 *  its age rather than presented as current. Not a claim about how fast any
 *  particular market moves — a threshold past which silence about age becomes a
 *  misrepresentation. */
export const STALE_AFTER_DAYS = 2;

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
    'august', 'september', 'october', 'november', 'december'];

/** Parse the date forms that actually appear in these questions and in EDGAR
 *  prose. Returns null rather than guessing — a mis-parsed boundary silently
 *  discards good evidence, which is worse than not gating at all. */
export function parseDateHint(text) {
    const s = String(text || '');

    const iso = s.match(/\b(\d{4})-(\d{2})(?:-(\d{2}))?\b/);
    if (iso) {
        const d = new Date(Date.UTC(+iso[1], +iso[2] - 1, iso[3] ? +iso[3] : 1));
        return Number.isNaN(d.getTime()) ? null : d;
    }

    // "July 17, 2026" and "17 July 2026"
    const mName = MONTHS.join('|');
    const mdy = s.match(new RegExp(`\\b(${mName})\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'i'));
    if (mdy) return new Date(Date.UTC(+mdy[3], MONTHS.indexOf(mdy[1].toLowerCase()), +mdy[2]));
    const dmy = s.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${mName})\\s+(\\d{4})\\b`, 'i'));
    if (dmy) return new Date(Date.UTC(+dmy[3], MONTHS.indexOf(dmy[2].toLowerCase()), +dmy[1]));

    return null;
}

/**
 * What time the question is asking about.
 *
 *   as-of   — an explicit boundary was named. Evidence after it is inadmissible.
 *   current — the question asks for the present. Age of the evidence must be
 *             disclosed, but nothing is excluded.
 *   none    — timeless. No gate.
 *
 * @returns {{kind: 'as-of'|'current'|'none', asOf: Date|null, phrase: string}}
 */
export function parseTemporalScope(query) {
    const q = String(query || '');

    /* An as-of boundary needs BOTH a backward-looking lead-in and a parseable
       date. "the July 2026 prospectus" names a date but scopes a subject, not a
       horizon, and must not silently discard everything newer. */
    const leadIn = q.match(/\b(as of|before|prior to|up to|by|through|until|ahead of|at the time of)\b/i);
    if (leadIn) {
        const after = q.slice(q.indexOf(leadIn[0]) + leadIn[0].length);
        const d = parseDateHint(after);
        if (d) return { kind: 'as-of', asOf: d, phrase: leadIn[0].toLowerCase() };
    }

    const cur = q.match(/\b(current(?:ly)?|latest|most recent|right now|today|as it stands|newest|so far)\b/i);
    if (cur) return { kind: 'current', asOf: null, phrase: cur[0].toLowerCase() };

    return { kind: 'none', asOf: null, phrase: '' };
}

/**
 * The Temporal Gateway. Drops evidence published after an as-of boundary.
 *
 * Undated evidence is KEPT and counted separately. Dropping it would silently
 * discard the primary documents — an EDGAR filing body carries no publication
 * field — and a gate that removes the strongest evidence class is worse than no
 * gate. The count is surfaced instead so the uncertainty is visible.
 *
 * @returns {{ledger: object[], excluded: object[], undated: number, applied: boolean}}
 */
export function applyTemporalGate(ledger = [], scope = { kind: 'none' }) {
    if (!scope || scope.kind !== 'as-of' || !scope.asOf) {
        return { ledger, excluded: [], undated: 0, applied: false };
    }
    const kept = [], excluded = [];
    let undated = 0;
    for (const e of ledger) {
        const d = e.published ? new Date(e.published) : null;
        if (!d || Number.isNaN(d.getTime())) { undated++; kept.push(e); continue; }
        (d > scope.asOf ? excluded : kept).push(e);
    }
    return { ledger: kept, excluded, undated, applied: true };
}

/**
 * How old the evidence is. Reported for every investigation, not only stale
 * ones — an answer that does not say when its evidence is from is asserting
 * currency it has not earned.
 *
 * @returns {{newest: Date|null, ageDays: number|null, dated: number, stale: boolean, note: string}}
 */
export function describeFreshness(ledger = [], { now = new Date(), scope = { kind: 'none' }, staleAfterDays = STALE_AFTER_DAYS } = {}) {
    const dates = ledger
        .map((e) => (e.published ? new Date(e.published) : null))
        .filter((d) => d && !Number.isNaN(d.getTime()));

    if (!dates.length) {
        const undatedNote = 'None of the evidence carries a publication date, so I cannot tell you how current it is.';
        return { newest: null, ageDays: null, dated: 0, stale: scope.kind === 'current', note: scope.kind === 'current' ? undatedNote : '' };
    }

    const newest = new Date(Math.max(...dates.map((d) => d.getTime())));
    const ageDays = Math.floor((now - newest) / 86400000);
    const stale = scope.kind === 'current' && ageDays > staleAfterDays;

    const when = newest.toISOString().slice(0, 10);
    let note = '';
    if (stale) {
        note = `The newest evidence I have is ${ageDays} days old (${when}). Treat this as the position as of then, not as current.`;
    } else if (scope.kind === 'current') {
        note = `Newest evidence: ${when}.`;
    }
    return { newest, ageDays, dated: dates.length, stale, note };
}

export default {
    EVIDENCE_KINDS, EVIDENCE_BUDGET_CHARS, STALE_AFTER_DAYS,
    planInvestigation, extractDocumentText, pickPrimaryDocument,
    buildLedger, describeLedger, renderEvidence, buildSynthesisPrompt,
    normaliseEntity, queryEntityTerms, verifyEntityAttribution, describeAttributionMismatch,
    parseDateHint, parseTemporalScope, applyTemporalGate, describeFreshness,
};
