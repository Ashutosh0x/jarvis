// SEC filing structure: section parsing and topic routing.
//
// The fixture is cut from Alphabet's REAL 10-Q (goog-20260630.htm, filed
// 23 Jul 2026), including the two things that broke the first implementation:
// a table of contents that looks exactly like the document, and printed page
// numbers that survive extraction and land inside body text.

import {
    parseSections, parseSubsections, narrowSection, topicsFor, sectionsForTopics,
    planSectionRetrieval, coverage, describeSections, SECTION_TOPICS,
} from '../secSections.js';

let pass = 0, fail = 0;
const check = (n, c, d = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

/* Contents page first, then the body — the real filing's shape. The offsets
   are compressed but the ORDER and the traps are verbatim. */
const FILING = [
    'goog-20260630 UNITED STATES SECURITIES AND EXCHANGE COMMISSION FORM 10-Q ',
    // --- table of contents: looks like headings, is not ---
    'PART I FINANCIAL INFORMATION Item 1 Financial Statements 4 Consolidated Balance Sheets - December 31 2025 ',
    'Item 2 Management s Discussion and Analysis of Financial Condition 43 ',
    'Item 3 Quantitative and Qualitative Disclosures About Market Risk 56 ',
    'PART II OTHER INFORMATION Item 1 Legal Proceedings 57 Item 1A Risk Factors 57 ',
    // --- a cross-reference to a DIFFERENT document ---
    'For a discussion of risks see Item 1A, "Risk Factors" in our Annual Report on Form 10-K for the fiscal year ended December 31, 2025. ',
    // --- body starts here ---
    'PART I FINANCIAL INFORMATION ITEM 1. FINANCIAL STATEMENTS Alphabet Inc. CONSOLIDATED BALANCE SHEETS unaudited ',
    'Note 1. Summary of Significant Accounting Policies Nature of Operations Google was incorporated in California in September 1998. ',
    'Note 2. Revenues Disaggregated Revenues The following table presents revenues by type in millions Google Search 56,123 Google Cloud 15,208 Total revenues 119,800 ',
    'Note 5. Variable Interest Entities Consolidated VIEs We consolidate VIEs where we are the primary beneficiary. ',
    // A backwards reference to Note 4 AFTER Note 5 — prose, not a heading.
    'Note 4. The maximum exposure arising from leases with VIEs is limited to the carrying amount. ',
    'Note 6. Debt Short-Term Debt We have a commercial paper program. ',
    // THE ONE THAT MATTERS: a page number ("28") flattened into body text
    // directly after the heading. This deleted the section in v1.
    'Note 8. Acquisitions and Divestitures Wiz Acquisition 28 On March 11, 2026, we completed our acquisition of Wiz for $ 29.5 billion, after purchase price adjustments. ',
    'Note 9. Goodwill and Intangible Assets Goodwill 29 Changes in the carrying amount of goodwill were as follows. ',
    'Note 10. Commitments and Contingencies Legal Matters We record a liability when a loss is probable. ',
    'ITEM 2. MANAGEMENT S DISCUSSION AND ANALYSIS OF FINANCIAL CONDITION AND RESULTS OF OPERATIONS Revenues increased. ',
].join('');

const sections = parseSections(FILING);

console.log('--- parseSections ---');
check('sections are found', sections.length >= 8, String(sections.length));

const byNote = (n) => sections.find((s) => s.kind === 'note' && s.number === String(n));

/* THE REGRESSION. A "heading followed by a page number is a contents line"
   heuristic looked right and deleted Note 8 (the Wiz acquisition) and Note 9
   (Goodwill) — the two sections an acquisition question exists to reach —
   because printed page numbers survive extraction into body text. */
check('Note 8 survives the page number in its body text', Boolean(byNote(8)),
    sections.map((s) => `${s.kind}${s.number}`).join(','));
check('Note 8 keeps its real title', /Acquisitions and Divestitures/.test(byNote(8)?.title || ''), String(byNote(8)?.title));
check('Note 9 survives too', /Goodwill/.test(byNote(9)?.title || ''), String(byNote(9)?.title));
check('the Wiz figure is inside Note 8\'s text', /29\.5 billion/.test(byNote(8)?.text || ''));

/* Multi-word titles. v1's alternation had no whitespace between branches, so
   it could only ever match one word and every title collapsed to its first
   token — which silently broke topic routing. */
check('titles keep more than one word', /Summary of Significant/.test(byNote(1)?.title || ''), String(byNote(1)?.title));
check('a title does not end on a connective', !/\b(and|of|the)$/i.test(byNote(9)?.title || ''), String(byNote(9)?.title));
check('the page number is not part of the title', !/\b28\b/.test(byNote(8)?.title || ''), String(byNote(8)?.title));

/* Contents page and cross-references must not become sections. */
check('the contents page does not become sections', !sections.some((s) => /^Financial Statements 4/.test(s.title)));
check('sections start after the body marker, not the contents page',
    sections[0].start > FILING.indexOf('PART II OTHER INFORMATION Item 1 Legal'),
    `first section @${sections[0].start}`);
check('a cross-reference to the 10-K is not a section',
    !sections.some((s) => /Annual Report/.test(s.title)), describeSections(sections));

/* A note number that goes backwards is prose about an earlier note. */
check('a backwards note number is not a new section',
    !sections.some((s) => s.kind === 'note' && s.number === '4'),
    sections.filter((s) => s.kind === 'note').map((s) => s.number).join(','));

check('sections are ordered by position', sections.every((s, i) => i === 0 || s.start > sections[i - 1].start));
check('sections carry their text and end where the next begins',
    sections.every((s) => s.text.length > 0 && s.end > s.start));
check('short input yields nothing rather than throwing', parseSections('abc').length === 0 && parseSections(null).length === 0);

/* --- topic routing --- */
console.log('\n--- topicsFor ---');

/* THE BUG THAT SENT AN ACQUISITION QUESTION TO THE REVENUE NOTE. `\b(acquisi|…)\b`
   cannot match "acquisitions": the trailing \b demands a boundary right after
   "acquisi", and the word continues with a "t". */
check('"what acquisitions did google make" is an acquisitions question',
    topicsFor('what acquisitions did google make').includes('acquisitions'),
    JSON.stringify(topicsFor('what acquisitions did google make')));
check('the singular works too', topicsFor('the acquisition of Wiz').includes('acquisitions'));
check('past tense works', topicsFor('who did google acquire').includes('acquisitions'));
check('"business combinations" works', topicsFor('any business combinations').includes('acquisitions'));
check('"revenues" plural works', topicsFor('what were revenues').includes('revenue'));
check('"litigation" works', topicsFor('any litigation').includes('legal'));
check('"liabilities" works', topicsFor('what are the liabilities').includes('financials'));
check('a question can carry several topics', (() => {
    const t = topicsFor('how much revenue after acquiring Wiz');
    return t.includes('revenue') && t.includes('acquisitions');
})(), JSON.stringify(topicsFor('how much revenue after acquiring Wiz')));
check('a contentless routing utterance names no topic',
    topicsFor('sec filings of google').length === 0, JSON.stringify(topicsFor('sec filings of google')));

console.log('\n--- planSectionRetrieval ---');

const acq = planSectionRetrieval(sections, 'what acquisitions did google make');
check('an acquisition question routes to the acquisition note',
    acq.sections.some((s) => /Acquisitions/.test(s.title)), describeSections(acq.sections));
check('it also picks up the goodwill note, the other half of the transaction',
    acq.sections.some((s) => /Goodwill/.test(s.title)), describeSections(acq.sections));
check('the reason names the topic', /acquisitions/.test(acq.reason), acq.reason);

const rev = planSectionRetrieval(sections, 'how much revenue');
check('a revenue question routes to the revenue note',
    rev.sections.some((s) => /Revenues/.test(s.title)), describeSections(rev.sections));

/* The voice path's common case: no topic in the utterance at all. Returning
   nothing would be worse than a sensible default. */
const bare = planSectionRetrieval(sections, 'as cc filings of google');
check('a contentless query still returns high-value sections',
    bare.sections.length > 0, describeSections(bare.sections));
check('the default includes the revenue note',
    bare.sections.some((s) => /Revenues/.test(s.title)), describeSections(bare.sections));
check('the default admits it had no topic', /no topic/.test(bare.reason), bare.reason);
check('an unparseable filing plans nothing rather than throwing',
    planSectionRetrieval([], 'anything').sections.length === 0);

/* --- hierarchical descent -------------------------------------------------------
   Alphabet's MD&A is 51,176 characters — about 12,794 tokens against gemma3:4b's
   4,096-token window. Retrieving the right SECTION is only half the job when the
   section is three times the model's entire context. */
console.log('\n--- subsections and narrowing ---');
{
    const MDNA = 'ITEM 2. MANAGEMENT S DISCUSSION AND ANALYSIS OF FINANCIAL CONDITION '
        + 'Executive Overview  We generated strong results this quarter. '
        + 'Google Cloud  Revenues increased driven by AI infrastructure demand and consumption growth. '
        + 'As of June 30, 2026, we had commitments outstanding under various arrangements. '
        + 'Capital Expenditures  We expect capital expenditures to increase substantially in 2026. '
        + 'In January we announced a new program that expands our data centre footprint further. '
        + 'Share Repurchase Program  We repurchased shares of Class A and Class C stock during the period. '
        + 'Acquisitions and Divestitures  On March 11, 2026 we completed our acquisition of Wiz. ';
    const section = { kind: 'item', number: '2', title: 'MANAGEMENT S DISCUSSION', start: 1000, end: 1000 + MDNA.length, text: MDNA };

    const subs = parseSubsections(section);
    const titles = subs.map((s) => s.title);
    check('subsections are found inside a section', subs.length >= 4, titles.join(' | '));
    check('a real subsection heading is captured', titles.some((t) => /Capital Expenditures/.test(t)), titles.join(' | '));
    check('the acquisitions subsection is captured', titles.some((t) => /Acquisitions/.test(t)), titles.join(' | '));

    /* Sentence openings look exactly like headings after extraction. Every one
       of the false positives measured on the real filing — "As of June", "In
       January", "On March", "In Google" — begins with a preposition. */
    check('"As of June…" is not treated as a heading', !titles.some((t) => /^As\b/.test(t)), titles.join(' | '));
    check('"In January…" is not treated as a heading', !titles.some((t) => /^In\b/.test(t)), titles.join(' | '));

    check('subsection offsets are absolute, so a citation still resolves',
        subs.every((s) => s.start >= section.start && s.end <= section.end),
        JSON.stringify(subs.map((s) => [s.start, s.end])));
    check('subsections tile the section without gaps',
        subs.every((s, i) => i === 0 || s.start === subs[i - 1].end));

    /* Narrowing only when it is needed. */
    const small = { title: 'Acquisitions and Divestitures', start: 0, end: 300, text: 'Acquisitions and Divestitures Wiz Acquisition ' + 'x'.repeat(250) };
    check('a section that already fits is NOT narrowed',
        narrowSection(small, ['acquisitions'], { maxChars: 6000 }).narrowed === false);
    check('an oversized section IS narrowed',
        narrowSection(section, ['acquisitions'], { maxChars: 200 }).narrowed === true);
    check('narrowing keeps the topic-matching subsection', (() => {
        const n = narrowSection(section, ['acquisitions'], { maxChars: 200 });
        return n.parts.some((p) => /Acquisitions/.test(p.title));
    })(), JSON.stringify(narrowSection(section, ['acquisitions'], { maxChars: 200 }).parts.map((p) => p.title)));
    check('narrowing with no topic keeps the OPENING, not an arbitrary middle', (() => {
        const n = narrowSection(section, [], { maxChars: 200 });
        return n.narrowed && n.parts[0].text.startsWith('ITEM 2.');
    })());
    check('a section with no detectable subsections is left whole', (() => {
        const flat = { title: 'X', start: 0, end: 900, text: 'word '.repeat(180) };
        return narrowSection(flat, ['revenue'], { maxChars: 200 }).narrowed === false;
    })());
    check('tiny input yields no subsections', parseSubsections({ text: 'short', start: 0 }).length === 0);

    /* The plan must expose the post-descent parts, since that is what is sent. */
    const plan = planSectionRetrieval([section], 'capital expenditures', { maxChars: 300 });
    check('the plan exposes narrowed parts', Array.isArray(plan.parts) && plan.parts.length > 0);
    check('the plan reports that it narrowed', plan.narrowed > 0 && /narrowed/.test(plan.reason), plan.reason);
    /* A topic that fires but matches no section TITLE is a different situation
       from a query with no topic in it, and the trace must say which. */
    check('the reason distinguishes "topic matched nothing" from "no topic"',
        /matched no section title/.test(plan.reason), plan.reason);
    check('a genuinely topic-free query says so',
        /no topic named/.test(planSectionRetrieval([section], 'hello there', { maxChars: 300 }).reason),
        planSectionRetrieval([section], 'hello there', { maxChars: 300 }).reason);
    check('parts stay within the budget',
        plan.parts.reduce((n, p) => n + p.text.length, 0) <= MDNA.length);
    check('each part remembers its parent section', plan.parts.every((p) => p.section === section.title));
}

console.log('\n--- coverage ---');
const cov = coverage(sections, ['revenue', 'acquisitions', 'debt']);
check('present topics are listed', cov.present.includes('revenue') && cov.present.includes('acquisitions'), JSON.stringify(cov));
check('an absent topic is named, not silently zero', (() => {
    const c = coverage(sections, ['taxes']);
    return c.missing.includes('taxes') && c.found === 0;
})(), JSON.stringify(coverage(sections, ['taxes'])));
/* Coverage must not be published as a percentage-shaped confidence. */
check('coverage returns lists, not a score',
    typeof cov.present === 'object' && cov.score === undefined, JSON.stringify(cov));

check('every topic in the ontology has at least one pattern',
    Object.values(SECTION_TOPICS).every((v) => Array.isArray(v) && v.length > 0));

/* --- lettered items and Part II ---------------------------------------------
   The monotonic guard ordered items with parseInt, and parseInt('1A') is 1 —
   equal to Item 1 — so every lettered item was rejected as a backwards
   reference. Item 1A is RISK FACTORS. A 10-Q compounded it: Part II legitimately
   restarts at Item 1, so everything after Part I was discarded too. */
{
    const filler = (n, w) => (w + ' ').repeat(n);

    const tenK = [
        'PART I ', filler(60, 'contents'), 'PART I ',
        'ITEM 1. Business ' + filler(200, 'business'),
        'ITEM 1A. Risk Factors ' + filler(200, 'risk'),
        'ITEM 7. Management Discussion and Analysis ' + filler(200, 'md'),
        'ITEM 7A. Quantitative and Qualitative Disclosures ' + filler(200, 'qqd'),
    ].join('');
    const kItems = parseSections(tenK).filter((s) => s.kind === 'item').map((s) => s.number);
    check('10-K: Item 1A (Risk Factors) survives', kItems.includes('1A'), kItems.join(', '));
    check('10-K: Item 7A survives', kItems.includes('7A'), kItems.join(', '));
    check('10-K: unlettered items still parsed', kItems.includes('1') && kItems.includes('7'));
    check('10-K: document order preserved', kItems.join(',') === '1,1A,7,7A', kItems.join(','));

    const tenQ = [
        'PART I Item 1 Financial Statements 4 Item 2 Management Discussion 20 ',
        'PART II Item 1 Legal Proceedings 40 Item 1A Risk Factors 41 ',
        filler(200, 'contents'),
        'PART I FINANCIAL INFORMATION ',
        'ITEM 1. Financial Statements ' + filler(200, 'balance'),
        'ITEM 2. Management Discussion and Analysis ' + filler(200, 'revenue'),
        'ITEM 4. Controls and Procedures ' + filler(200, 'controls'),
        'PART II OTHER INFORMATION ',
        'ITEM 1. Legal Proceedings ' + filler(200, 'lawsuit'),
        'ITEM 1A. Risk Factors ' + filler(200, 'risk'),
        'ITEM 5. Other Information ' + filler(200, 'other'),
    ].join('');
    const q = parseSections(tenQ);
    check('10-Q: Part II Legal Proceedings is not discarded',
        q.some((s) => /Legal Proceedings/i.test(s.title)));
    check('10-Q: Part II Risk Factors is not discarded',
        q.some((s) => s.kind === 'item' && s.number === '1A'));
    check('10-Q: Part I items are still there',
        ['1', '2', '4'].every((n) => q.some((s) => s.kind === 'item' && s.number === n)));
    check('10-Q: the contents page is still skipped — no ToC duplicates',
        q.filter((s) => /Financial Statements/i.test(s.title)).length === 1);

    /* Notes must NOT reset at a Part boundary: they run continuously, and
       "Note 4 — the maximum exposure…" appearing after Note 5 is still prose. */
    const notes = [
        'PART I ', filler(60, 'contents'), 'PART I ',
        'Note 2 Revenues ' + filler(150, 'rev'),
        'Note 5 Debt ' + filler(150, 'debt'),
        'PART II OTHER INFORMATION ',
        'Note 4 The maximum exposure arising from leases ' + filler(150, 'back'),
    ].join('');
    const noteNums = parseSections(notes).filter((s) => s.kind === 'note').map((s) => s.number);
    check('notes: a backwards note after a Part boundary is still prose',
        !noteNums.includes('4'), noteNums.join(', '));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
