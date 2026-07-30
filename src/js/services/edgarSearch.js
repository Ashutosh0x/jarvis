/**
 * @fileoverview EDGAR full-text search — query building and response shaping.
 *
 * PURE: no network, no DOM, no clock except where a timestamp is passed in.
 * The fetch lives in the main process (SEC requires a declared User-Agent and
 * the renderer cannot set one), so everything that can be got wrong — the
 * query, the document URL, the company name — is here and unit-tested.
 *
 * WHAT THIS ADDS THAT THE FEEDS DO NOT. The registered SEC feeds are pushes:
 * whatever was filed most recently, in whatever order the SEC published it.
 * They cannot answer "which companies have mentioned tokenized securities in
 * an 8-K". Full-text search is the pull side — the whole EDGAR corpus back to
 * 2001, queried by phrase, form type and date.
 *
 * SHAPES VERIFIED AGAINST THE LIVE API (22 Jul 2026), because none of this is
 * documented and three details are silent:
 *
 *   1. The endpoint is efts.sec.gov/LATEST/search-index?q=... — NOT anything
 *      under sec.gov/edgar/search, which serves the HTML app.
 *   2. `_id` is "ACCESSION:FILENAME" ("0001493152-26-025606:ex99-1.htm"). The
 *      filename is the only place the actual document name appears; nothing in
 *      _source carries it.
 *   3. `display_names` is an ARRAY of pre-formatted strings shaped
 *      "Streamex Corp.  (STEX)  (CIK 0001530766)" — with runs of multiple
 *      spaces, and with the ticker absent entirely for non-listed filers.
 *      There are no separate company / ticker fields to read instead.
 *
 * The document URL is DERIVED, and the derivation was fetched to confirm it:
 *   https://www.sec.gov/Archives/edgar/data/{cik}/{accession-no-dashes}/{file}
 * with the CIK stripped of leading zeros. Verified 200 on the example above.
 * A link that 404s is worse than no link, because the user clicks it.
 */

export const EDGAR_FTS = 'https://efts.sec.gov/LATEST/search-index';

/* EDGAR indexes full text from 2001 onward. A date filter before that silently
   returns nothing rather than erroring, which reads as "no such filings". */
export const FULL_TEXT_FROM = '2001-01-01';

/** Form types worth offering by name. EDGAR accepts many more; these are the
 *  ones a spoken question actually asks for. */
export const COMMON_FORMS = ['8-K', '10-K', '10-Q', 'S-1', 'DEF 14A', '6-K', '20-F', '13F-HR', '4', 'SC 13D'];

/**
 * Build a full-text search URL.
 *
 * Phrases are quoted. Unquoted multi-word queries are OR-ish and return
 * everything containing any term, which for "tokenized securities" means every
 * filing that says "securities" — i.e. all of them. Quoting is the difference
 * between 28 hits and hundreds of thousands, so it is the default and a caller
 * has to opt out.
 *
 * @param {{q: string, forms?: string[]|string, startdt?: string, enddt?: string, phrase?: boolean, from?: number}} opts
 */
export function buildSearchUrl({ q, forms, startdt, enddt, phrase = true, from = 0 } = {}) {
    const term = String(q || '').trim();
    if (!term) return null;

    // Already-quoted input is left alone rather than double-quoted.
    const quoted = phrase && !/^".*"$/.test(term) ? `"${term}"` : term;
    const params = new URLSearchParams({ q: quoted });

    const formList = Array.isArray(forms) ? forms : (forms ? [forms] : []);
    if (formList.length) params.set('forms', formList.join(','));

    /* Both bounds are required together: the API applies dateRange=custom and
       silently ignores a lone startdt, which looks like the filter worked. */
    if (startdt && enddt) {
        params.set('dateRange', 'custom');
        params.set('startdt', startdt);
        params.set('enddt', enddt);
    }
    if (from > 0) params.set('from', String(from));

    return `${EDGAR_FTS}?${params.toString()}`;
}

/**
 * "Streamex Corp.  (STEX)  (CIK 0001530766)" -> parts.
 * The ticker group is optional: many filers have no listed ticker and the
 * string is then "Some Trust  (CIK 0000319655)". Matching the CIK group as if
 * it were the ticker is the failure this is written to avoid.
 */
export function parseDisplayName(display) {
    const s = String(display || '').replace(/\s+/g, ' ').trim();
    const cikM = s.match(/\(CIK\s+(\d{10})\)/i);
    const cik = cikM ? cikM[1] : null;
    // A parenthesised group that is NOT the CIK group is the ticker.
    const tickerM = s.match(/\(([A-Z][A-Z0-9.\-]{0,9})\)/);
    const ticker = tickerM && !/^CIK/i.test(tickerM[1]) ? tickerM[1] : null;
    const company = s.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
    return { company: company || null, ticker, cik };
}

/** CIK with leading zeros stripped, as the Archives path wants it. */
export function cikPath(cik) {
    const digits = String(cik || '').replace(/\D/g, '');
    if (!digits) return null;
    const stripped = digits.replace(/^0+/, '');
    return stripped || '0';
}

/**
 * Derived document URL. Verified against the live archive.
 * @param {string} cik  either padded or not
 * @param {string} accession  with or without dashes
 * @param {string} filename  from the _id suffix
 */
export function documentUrl(cik, accession, filename) {
    const c = cikPath(cik);
    const adsh = String(accession || '').replace(/-/g, '');
    if (!c || !adsh) return null;
    const base = `https://www.sec.gov/Archives/edgar/data/${c}/${adsh}`;
    // Without a filename the index page is still a correct, working link.
    return filename ? `${base}/${filename}` : `${base}/`;
}

/**
 * Elasticsearch response -> normalised hits.
 * Anything missing becomes null rather than a guess; a hit whose accession
 * cannot be determined is dropped, because it cannot be linked or cited.
 */
export function parseSearchResults(json, { limit = 10 } = {}) {
    const body = typeof json === 'string' ? safeJson(json) : json;
    const hits = body?.hits?.hits;
    if (!Array.isArray(hits)) return { total: 0, results: [], truncated: false };

    /* `total.value` caps at 10000 with relation "gte" — that is the index
       saying "at least", not "exactly". Reporting 10000 as an exact count is a
       fabricated number, so the relation is carried through. */
    const totalRaw = body?.hits?.total;
    const total = typeof totalRaw === 'object' ? Number(totalRaw.value) || 0 : Number(totalRaw) || 0;
    const atLeast = typeof totalRaw === 'object' && totalRaw.relation === 'gte';

    const results = [];
    for (const h of hits.slice(0, limit)) {
        const src = h?._source || {};
        // "ACCESSION:FILENAME" — the filename exists nowhere else.
        const [idAccession, filename] = String(h?._id || '').split(':');
        const accession = src.adsh || idAccession || null;
        if (!accession) continue;

        const cik = Array.isArray(src.ciks) ? src.ciks[0] : src.ciks || null;
        const named = parseDisplayName(Array.isArray(src.display_names) ? src.display_names[0] : src.display_names);

        results.push({
            accession,
            cik: named.cik || cik || null,
            company: named.company,
            ticker: named.ticker,
            form: src.form || (Array.isArray(src.root_forms) ? src.root_forms[0] : null) || null,
            filedAt: src.file_date || null,
            periodEnding: src.period_ending || null,
            fileType: src.file_type || null,
            description: src.file_description || null,
            // 8-K item numbers ("8.01", "9.01") say what the filing was about.
            items: Array.isArray(src.items) ? src.items : [],
            location: Array.isArray(src.biz_locations) ? src.biz_locations[0] : null,
            score: typeof h._score === 'number' ? h._score : null,
            url: documentUrl(named.cik || cik, accession, filename),
            filename: filename || null,
        });
    }
    return { total, atLeast, results, truncated: hits.length > limit };
}

function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }

/**
 * A spoken summary. States the count, then the first few filings with company,
 * form and date — and nothing about what any of it MEANS. Every number here
 * came from the response; none is inferred.
 */
export function describeResults(query, parsed, { limit = 3 } = {}) {
    if (!parsed || !parsed.results?.length) {
        return `No EDGAR filings mention ${query}, Sir.`;
    }
    const { total, atLeast, results } = parsed;
    const count = atLeast ? `at least ${total.toLocaleString()}` : `${total.toLocaleString()}`;
    const noun = total === 1 ? 'filing mentions' : 'filings mention';

    const lead = results.slice(0, limit).map((r) => {
        const who = r.company || `CIK ${r.cik}`;
        const when = r.filedAt ? ` on ${r.filedAt}` : '';
        return `${who}, ${r.form || 'filing'}${when}`;
    });
    return `${count} EDGAR ${noun} ${query}, Sir. Most relevant: ${lead.join('; ')}.`;
}

/** One result as a memory line: dated, attributed, linkable. */
export function toMemoryText(r) {
    if (!r || !r.company) return null;
    const date = r.filedAt || 'undated';
    const ticker = r.ticker ? ` (${r.ticker})` : '';
    const items = r.items?.length ? `, items ${r.items.join(', ')}` : '';
    return `[${date}] SEC EDGAR: ${r.company}${ticker} filed ${r.form || 'a document'}${items}. ${r.url || ''}`.trim();
}

/* --- spoken query -> search parameters --------------------------------------
   Rule-based, not model-routed, for the same reason phoneTools.js is: a
   mis-parse here spends a live SEC request and answers a question nobody asked.

   The hard part is NOT matching enough. "any new sec filings" is a request for
   the feed brief that is already shipping; only a query with a SUBJECT is a
   full-text search. Every negative case below is asserted in the tests. */

/* Every pattern ends `s?\b`, not `\b`. People say "8-Ks" and "annual reports",
   and a trailing \b straight after the noun refuses the plural — the form then
   stays in the search term and EDGAR is asked for the phrase
   "8-Ks mentioning tokenized securities", which matches nothing. Caught by the
   tests below, and it is the same mistake as a \b placed after "%". */
const FORM_WORDS = [
    [/\b(?:8-?ks?|eight\s?ks?)\b/i, '8-K'],
    [/\b(?:10-?ks?|ten\s?ks?|annual reports?)\b/i, '10-K'],
    [/\b(?:10-?qs?|ten\s?qs?|quarterly reports?)\b/i, '10-Q'],
    [/\b(?:s-?1s?|ipo filings?|registration statements?)\b/i, 'S-1'],
    [/\b(?:def ?14a|proxy statements?|proxy)\b/i, 'DEF 14A'],
    [/\b(?:13-?fs?|thirteen ?fs?|holdings? reports?)\b/i, '13F-HR'],
    [/\b(?:20-?fs?)\b/i, '20-F'],
    [/\b(?:6-?ks?)\b/i, '6-K'],
];

/* Lead-ins that introduce a search. The subject is whatever follows. */
const LEAD = /\b(?:(?:full[- ]?text[- ]?)?search(?:\s+(?:through|in|on))?\s+(?:edgar|sec(?:'?s)?(?:\s+filings?)?)|edgar\s+search|search\s+filings?|look\s+(?:up|through)\s+(?:edgar|sec\s+filings?)|find\s+(?:me\s+)?filings?|which\s+companies?\s+(?:have\s+)?mention(?:ed|s)?|who\s+(?:has\s+)?(?:mentioned|filed\s+about)|any\s+filings?\s+(?:that\s+)?mention(?:ing)?)\b/i;

/* Words between the lead-in and the subject that carry no meaning. */
/* `says|saying` and NOT bare `say`. "search edgar for proxy statements
   mentioning say on pay" stripped "say", then "on", and searched EDGAR for
   "pay" — a different question with a different answer. Say-on-pay is a real
   governance term and it is exactly the kind of phrase someone searches proxy
   statements for. The inflected forms stay because "filings that says X" is
   not a phrase anyone is searching FOR. */
const FILLER = /^(?:for|about|regarding|on|of|the|a|an|any|me|to|that|which|mention(?:s|ed|ing)?|talk(?:s|ed|ing)?\s+about|says|saying|containing|contain(?:s|ing)?|with|in|their|its|its\s+filings?|filings?|documents?)\b\s*/i;

const TRAILER = /\b(?:in\s+(?:their|its|an?|the)\s+(?:sec\s+)?(?:filings?|8-?ks?|10-?ks?|10-?qs?|reports?)|in\s+edgar|on\s+edgar|please|sir)\b\s*$/i;

/**
 * @returns {{term: string, forms: string[], recent: boolean}|null}
 */
export function parseEdgarQuery(text) {
    const raw = String(text || '').trim();
    if (!raw) return null;
    if (!LEAD.test(raw)) return null;

    let rest = raw.slice(raw.search(LEAD)).replace(LEAD, '').trim();

    // Form type, taken from ANYWHERE in the utterance, then removed from the
    // subject so "8-Ks mentioning lithium" searches lithium, not "8-Ks lithium".
    const forms = [];
    for (const [re, form] of FORM_WORDS) {
        if (re.test(raw)) { forms.push(form); rest = rest.replace(re, ' '); }
    }

    /* "in the last month" / "this year" / "recently" — a recency ask, resolved
       to real dates by the caller, which is the only place a clock exists. */
    const recent = /\b(?:recent(?:ly)?|last\s+(?:week|month|quarter|year|\d+\s+(?:days?|weeks?|months?))|this\s+(?:week|month|quarter|year)|past\s+\w+|since\s+\w+|latest|new)\b/i.test(raw);
    rest = rest
        .replace(/\b(?:in\s+the\s+)?(?:last|past)\s+(?:week|month|quarter|year|\d+\s+(?:days?|weeks?|months?))\b/gi, ' ')
        .replace(/\bthis\s+(?:week|month|quarter|year)\b/gi, ' ')
        .replace(/\b(?:recent(?:ly)?|latest|new)\b/gi, ' ');

    // Strip filler repeatedly: "for any filings that mention lithium" -> "lithium".
    let prev;
    do { prev = rest; rest = rest.replace(FILLER, '').trim(); } while (rest !== prev && rest);
    rest = rest.replace(TRAILER, '').replace(/[?.!,]+$/, '').replace(/\s+/g, ' ').trim();

    /* No subject means this was "search edgar" or "any new filings" — a request
       the feed brief already answers. Refusing here is what keeps this parser
       from stealing that intent. */
    if (rest.length < 2) return null;

    return { term: rest, forms, recent };
}

export default {
    EDGAR_FTS, FULL_TEXT_FROM, COMMON_FORMS,
    buildSearchUrl, parseSearchResults, parseDisplayName, parseEdgarQuery,
    documentUrl, cikPath, describeResults, toMemoryText,
};
