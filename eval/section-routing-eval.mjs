#!/usr/bin/env node
/**
 * Section-routing benchmark — the retrieval stage, measured WITHOUT a model.
 *
 * WHY THIS EXISTS SEPARATELY FROM answer-eval.mjs. That harness measures the
 * whole pipeline and takes ~40 minutes, because every question costs a
 * gemma3:4b generation. Fin-RATE (arXiv:2602.07294) reports that the dominant
 * bottleneck in financial RAG is retrieval rather than generation — "the
 * retriever's failure to surface essential evidence, not deficiencies in
 * generation" — and their EC-QA Missing Evidence rate is 75.44%. If that is
 * where the errors are, the retriever should be measurable on its own, in
 * milliseconds, deterministically, with no model in the loop and nothing to
 * ablate.
 *
 * Two metrics, both reproducible:
 *
 *   TOPIC ACCURACY  — does the query understanding layer name the right topic?
 *                     This is the layer that failed silently: `\b(acquisi|…)\b`
 *                     could not match "acquisitions", so the single most
 *                     obvious acquisition query in existence routed to the
 *                     revenue note.
 *
 *   SECTION RECALL@1 / @k — is the section that actually contains the answer in
 *                     the retrieved set, and is it first?
 *
 * The corpus is labelled against ONE real filing (Alphabet's 10-Q for the
 * quarter ended 30 Jun 2026, accession 0001652044-26-000071), because a label
 * that names a section which exists is checkable and a synthetic one is not.
 * The filing is fetched live; the labels name sections by pattern, not by
 * offset, so they survive Alphabet reorganising its notes.
 *
 * Usage:  node eval/section-routing-eval.mjs [--verbose]
 *         node eval/section-routing-eval.mjs --selftest   (no network)
 */

import { parseSections, parseSubsections, topicsFor, planSectionRetrieval, coverage } from '../src/js/services/secSections.js';
import { extractDocumentText } from '../src/js/services/investigation.js';

const SEC_UA = 'Jarvis/1.0 (ashutoshkumarsingh0x@gmail.com)';
const FILING_URL = 'https://www.sec.gov/Archives/edgar/data/1652044/000165204426000071/goog-20260630.htm';

/* --- labels ---------------------------------------------------------------------
   `topics`  — what the query understanding layer must name.
   `section` — a pattern the correct section's title must match.
   Questions with `topics: []` are the voice path's real shape: STT gives a
   routing utterance with no financial term in it, and the planner must still
   return something useful rather than nothing. */
const CASES = [
    // --- acquisitions: the class that was silently broken ---
    { q: 'what acquisitions did google make', topics: ['acquisitions'], section: /Acquisitions/i },
    { q: 'the acquisition of Wiz', topics: ['acquisitions'], section: /Acquisitions/i },
    { q: 'who did alphabet acquire this quarter', topics: ['acquisitions'], section: /Acquisitions/i },
    { q: 'any business combinations', topics: ['acquisitions'], section: /Acquisitions|Goodwill/i },
    { q: 'how much goodwill was recorded', topics: ['acquisitions'], section: /Goodwill|Acquisitions/i },
    { q: 'did they divest anything', topics: ['acquisitions'], section: /Acquisitions/i },
    { q: 'what did they pay for Wiz', topics: ['acquisitions'], section: /Acquisitions/i },

    // --- revenue ---
    { q: 'how much revenue', topics: ['revenue'], section: /Revenue/i },
    { q: 'what were revenues this quarter', topics: ['revenue'], section: /Revenue/i },
    { q: 'google cloud growth', topics: ['revenue'], section: /Revenue|Segment|MANAGEMENT/i },
    { q: 'revenue by segment', topics: ['revenue'], section: /Revenue|Segment|Information about Segments/i },
    { q: 'advertising sales', topics: ['revenue'], section: /Revenue|MANAGEMENT/i },

    // --- debt ---
    { q: 'how much debt do they have', topics: ['debt'], section: /Debt/i },
    { q: 'what are their borrowings', topics: ['debt'], section: /Debt/i },
    { q: 'any credit facilities', topics: ['debt'], section: /Debt/i },

    // --- legal ---
    { q: 'any litigation', topics: ['legal'], section: /Commitments|Contingencies|Legal/i },
    { q: 'what are the legal proceedings', topics: ['legal'], section: /Commitments|Contingencies|Legal/i },
    { q: 'any antitrust matters', topics: ['legal'], section: /Commitments|Contingencies|Legal/i },

    // --- taxes / compensation / equity / leases ---
    { q: 'what was the tax rate', topics: ['taxes'], section: /Income Taxes/i },
    { q: 'stock based compensation', topics: ['compensation'], section: /Compensation/i },
    { q: 'any share repurchases', topics: ['equity'], section: /Stockholders|Equity|MANAGEMENT/i },
    { q: 'earnings per share', topics: ['equity'], section: /Per Common Share|Net Income/i },
    { q: 'what are their lease obligations', topics: ['leases'], section: /Leases/i },

    // --- multi-topic ---
    { q: 'how much revenue after acquiring Wiz', topics: ['revenue', 'acquisitions'], section: /Revenue|Acquisitions/i },
    /* `risk` is expected here and the first version of this label omitted it —
       a LABEL bug, not a routing bug. "exposure" is a risk word, the extra
       topic only adds a place to look, and marking a correct behaviour wrong
       would have driven a regex change that made routing worse. */
    { q: 'debt and legal exposure', topics: ['debt', 'legal', 'risk'], section: /Debt|Commitments|Contingencies/i },

    // --- the voice path: a routing utterance with no topic in it ---
    { q: 'sec filings of google', topics: [], section: null },
    { q: 'as cc filings of google', topics: [], section: null },   // real STT output, 24 Jul 2026
    { q: 'scc filing of google', topics: [], section: null },      // real STT output, 24 Jul 2026

    // --- must NOT fire ---
    { q: 'what is the weather like', topics: [], section: null },
    { q: 'how much is bitcoin', topics: [], section: null },
];

/* --- grader self-test ------------------------------------------------------------
   The grader is the part that can silently lie, so it is checked against
   hand-written passes and failures before any number is reported. */
function selfTest() {
    let pass = 0, fail = 0;
    const check = (n, c, d = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

    check('exact topic set scores', scoreTopics(['revenue'], ['revenue']).ok);
    check('missing a required topic fails', !scoreTopics([], ['revenue']).ok);
    check('a spurious topic fails', !scoreTopics(['revenue', 'debt'], ['revenue']).ok);
    check('expecting no topic and getting none passes', scoreTopics([], []).ok);
    check('expecting no topic and getting one fails', !scoreTopics(['revenue'], []).ok);
    check('multi-topic order does not matter',
        scoreTopics(['acquisitions', 'revenue'], ['revenue', 'acquisitions']).ok);

    const secs = [{ title: 'Acquisitions and Divestitures' }, { title: 'Revenues' }];
    check('recall@1 hits when the right section is first', rank(secs, /Acquisitions/i) === 1);
    check('recall@2 when it is second', rank(secs, /Revenue/i) === 2);
    check('absent section reports 0', rank(secs, /Debt/i) === 0);
    check('an empty plan reports 0', rank([], /Debt/i) === 0);

    console.log(`\n${pass} passed, ${fail} failed`);
    return fail === 0;
}

const scoreTopics = (got, want) => {
    const g = [...new Set(got)].sort().join(',');
    const w = [...new Set(want)].sort().join(',');
    return { ok: g === w, got: g || '(none)', want: w || '(none)' };
};

/** 1-based position of the first section matching `pattern`, or 0 if absent. */
const rank = (sections, pattern) => {
    if (!pattern) return 0;
    const i = (sections || []).findIndex((s) => pattern.test(s.title));
    return i === -1 ? 0 : i + 1;
};

/* --- main ------------------------------------------------------------------------ */

async function main() {
    const verbose = process.argv.includes('--verbose');

    if (process.argv.includes('--selftest')) {
        process.exit(selfTest() ? 0 : 1);
    }

    console.log(`fetching ${FILING_URL}`);
    let html;
    try {
        const res = await fetch(FILING_URL, { headers: { 'User-Agent': SEC_UA } });
        if (!res.ok) throw new Error(`http ${res.status}`);
        html = await res.text();
    } catch (e) {
        /* Report and exit rather than scoring zeros — the same rule
           answer-eval.mjs follows when Ollama is down. A benchmark that emits
           0% because the network failed is worse than one that emits nothing. */
        console.error(`\nCOULD NOT FETCH THE FILING: ${e.message}`);
        console.error('No numbers reported. Re-run with a working connection.');
        process.exit(2);
    }

    const t0 = Date.now();
    const text = extractDocumentText(html);
    const sections = parseSections(text);
    const parseMs = Date.now() - t0;

    console.log(`filing: ${html.length.toLocaleString()} bytes -> ${text.length.toLocaleString()} chars`);
    console.log(`parsed: ${sections.length} sections in ${parseMs}ms`);
    const oversized = sections.filter((s) => s.text.length > 6000).sort((a, b) => b.text.length - a.text.length);
    console.log(`oversized (>6000 chars): ${oversized.length}`);
    /* The LARGEST, not the first in document order — reporting subsection
       counts for whichever section happened to appear first is a number that
       looks measured and describes nothing. */
    const largest = oversized[0] || sections[0];
    console.log(`largest: ${largest.title.slice(0, 40)} — ${largest.text.length.toLocaleString()} chars, `
        + `${parseSubsections(largest).length} subsections\n`);

    let topicOk = 0, r1 = 0, rk = 0, sectionCases = 0;
    let totalChars = 0, worstChars = 0;
    const failures = [];

    for (const c of CASES) {
        const got = topicsFor(c.q);
        const ts = scoreTopics(got, c.topics);
        if (ts.ok) topicOk++;
        else failures.push(`TOPIC  "${c.q}" -> got [${ts.got}] want [${ts.want}]`);

        const plan = planSectionRetrieval(sections, c.q, { maxChars: 6000 });
        const chars = plan.parts.reduce((n, p) => n + p.text.length, 0);
        totalChars += chars;
        worstChars = Math.max(worstChars, chars);

        if (c.section) {
            sectionCases++;
            const pos = rank(plan.sections, c.section);
            if (pos === 1) r1++;
            if (pos >= 1) rk++;
            if (pos === 0) failures.push(`SECTION "${c.q}" -> ${plan.sections.map((s) => s.title.slice(0, 28)).join(' | ') || '(none)'}`);
        } else {
            /* No labelled section: the requirement is that a contentless query
               still returns SOMETHING, because returning nothing on the voice
               path is the failure that started all of this. */
            if (!plan.parts.length) failures.push(`EMPTY   "${c.q}" -> planner returned nothing`);
        }

        if (verbose) {
            console.log(`  ${ts.ok ? 'ok ' : 'TOPIC'} "${c.q}"`);
            console.log(`        topics [${got.join(',')}] | ${plan.reason}`);
            console.log(`        -> ${plan.parts.map((p) => p.title.slice(0, 30)).join(' | ')} (${chars} chars)`);
        }
    }

    const pct = (n, d) => d ? `${(100 * n / d).toFixed(1)}%` : 'n/a';

    console.log('\n--- results ---');
    console.log(`Topic accuracy      ${pct(topicOk, CASES.length).padStart(7)}   (${topicOk}/${CASES.length})`);
    console.log(`Section Recall@1    ${pct(r1, sectionCases).padStart(7)}   (${r1}/${sectionCases})`);
    console.log(`Section Recall@k    ${pct(rk, sectionCases).padStart(7)}   (${rk}/${sectionCases}, k<=4)`);
    console.log(`Mean context        ${Math.round(totalChars / CASES.length).toLocaleString().padStart(7)} chars  (~${Math.round(totalChars / CASES.length / 4).toLocaleString()} tokens)`);
    console.log(`Worst context       ${worstChars.toLocaleString().padStart(7)} chars  (~${Math.round(worstChars / 4).toLocaleString()} tokens)`);
    /* The budget that matters is the model's, not the retriever's. */
    console.log(`Model context window   4,096 tokens (gemma3:4b, as loaded)`);
    console.log(`Whole filing would be  ${Math.round(text.length / 4).toLocaleString()} tokens — ${(text.length / 4 / 4096).toFixed(1)}x the window`);

    if (failures.length) {
        console.log(`\n--- ${failures.length} failure(s) ---`);
        for (const f of failures) console.log(`  ${f}`);
    }

    console.log(`\n${topicOk === CASES.length && r1 === sectionCases ? 'all cases routed correctly' : `${failures.length} case(s) need work`}`);
    process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
