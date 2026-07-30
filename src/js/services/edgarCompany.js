/**
 * @fileoverview Per-company EDGAR filings — name resolution, feed URL, feed parsing.
 *
 * PURE: no network, no DOM, no clock except where passed in. The fetches live in
 * the main process (SEC requires a declared User-Agent) and the URL is built
 * there from validated primitives, so nothing here can reach the network.
 *
 * WHAT THIS ADDS THAT THE OTHER TWO EDGAR PATHS DO NOT.
 *   feeds.js       — pushes. "What was filed most recently, by anyone."
 *   edgarSearch.js — full-text pull. "Who has SAID this phrase."
 *   this module    — "What has THIS COMPANY filed." Neither of the others can
 *                    answer it: the registry's SEC feeds are global firehoses,
 *                    and full-text search for "google" returns every filing that
 *                    MENTIONS Google, which is not the same question.
 *
 * Routed from "sec filings of google", which before this module reached the
 * MODEL — the single worst destination for that question, and the one the log of
 * 22 Jul 2026 shows inventing eight turns of filing contents.
 *
 * EVERY SHAPE BELOW WAS PROBED LIVE (24 Jul 2026). Four of the findings are
 * things a reasonable implementation would have got wrong:
 *
 *   1. THE COMPANY-NAME SEARCH IS A TRAP, TWICE OVER. The obvious endpoint is
 *      `browse-edgar?action=getcompany&company=google&output=atom`. Its first
 *      hit for "google" is CIK 0001678226 — CapitalG GP LLC, Alphabet's growth
 *      fund, which last filed in 2024. Answering "Google's SEC filings" with a
 *      venture fund's Form 4s is precisely the deceptive-grounding failure
 *      investigation.js exists to gate. Worse, that feed cannot even name its
 *      own results: it emits `title="ARRAY(0x558f95430aa8)"` and
 *      `<company-info name="ARRAY(0x558f953adc30)">` — a Perl array reference
 *      stringified into the name field. It is not used anywhere here.
 *
 *   2. `count` IS IGNORED. Requesting count=3 returns ten entries, measured.
 *      The caller slices; the parameter is not a limit you can rely on.
 *
 *   3. AN UNKNOWN CIK RETURNS HTTP 200 WITH HTML. Not a 404, not an Atom error
 *      document — a full HTML page with an empty company name. A parser that
 *      only counts <entry> elements reports zero filings, which reads as "this
 *      company has never filed anything". That is a false claim about a real
 *      company, so `parseCompanyFeed` distinguishes not-a-feed from no-filings.
 *
 *   4. `type=10-K` ALSO MATCHES 10-K/A. EDGAR prefix-matches the form, so an
 *      annual-report request includes its amendments. Correct, and worth saying
 *      out loud rather than silently presenting an amendment as the original.
 */

/* --- name -> filer ------------------------------------------------------------
   SEC publishes the authoritative ticker/CIK/name map at
   https://www.sec.gov/files/company_tickers.json — 798KB, ~10k entries, shaped
   {"0":{"cik_str":1045810,"ticker":"NVDA","title":"NVIDIA CORP"}, ...}.
   That file is the ONLY resolver source used here. */

export const SEC_TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';

/* Corporate suffixes differ between how a person speaks and how EDGAR spells a
   conformed name ("Tesla" vs "Tesla, Inc.", "walmart" vs "Walmart Inc."). */
const SUFFIX = /\b(inc|incorporated|corp|corporation|co|company|group|holdings?|plc|ltd|limited|llc|lp|sa|ag|nv|the|com)\b/g;

export function normaliseName(s) {
    return String(s || '')
        .toLowerCase()
        .replace(/[.,&'/\-]/g, ' ')
        .replace(SUFFIX, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Consumer name -> ticker, for the cases where the company the user names is
 * not the company that files.
 *
 * THIS TABLE IS DELIBERATELY TINY, AND THE MEASUREMENT BELOW IS WHY IT IS A
 * TABLE AT ALL RATHER THAN A HEURISTIC.
 *
 * The string "google" appears in NO title in company_tickers.json — checked
 * across all ~10k entries. Alphabet Inc. has no `formerNames` in EDGAR either
 * (data.sec.gov/submissions/CIK0001652044.json returns an empty array), so
 * there is no published record anywhere linking the word to the filer. The
 * probe failed, and that failure is the evidence for hard-coding the two
 * entries below rather than guessing at runtime.
 *
 * THE HEURISTIC THAT LOOKS LIKE IT WOULD WORK, AND WHY IT IS NOT HERE.
 * Prefix-matching the query against tickers resolves "google" -> GOOG ->
 * Alphabet Inc., correctly. It also resolves "openai" -> OPEN -> Opendoor
 * Technologies, Inc., confidently and wrongly — OpenAI is not a public filer at
 * all. Both are six-letter words sharing their first four characters with a
 * real ticker, so no length or ratio rule separates them; measured against the
 * live file, not reasoned about. A resolver that invents a filer for a private
 * company is worse than one that says it does not know, so ticker-prefix
 * matching is rejected outright and an unrecognised name returns nothing.
 *
 * Adding an entry here means asserting a corporate fact. Both of these are:
 * Google LLC is Alphabet's operating subsidiary and Alphabet is the registrant;
 * Facebook, Inc. renamed itself Meta Platforms, Inc. in October 2021.
 */
export const NAME_ALIASES = {
    google: 'GOOGL',
    facebook: 'META',
};

/**
 * Resolve a spoken company name to filers, best first.
 *
 * Only exact and prefix evidence is used, each labelled with `how` so the
 * caller can say which rule fired. Multiple share classes collapse to one
 * result per CIK — "goldman sachs" matches ten tickers and one company.
 *
 * @param {string} query
 * @param {Array<{cik_str:number, ticker:string, title:string}>} rows
 * @returns {Array<{cik:string, ticker:string, title:string, how:string, score:number}>}
 */
export function resolveCompany(query, rows) {
    const raw = String(query || '').trim();
    if (!raw || !Array.isArray(rows) || !rows.length) return [];

    const aliased = NAME_ALIASES[raw.toLowerCase()];
    const upper = (aliased || raw).toUpperCase();
    const q = aliased ? null : normaliseName(raw);

    const byCik = new Map();
    for (const r of rows) {
        if (!r) continue;
        const ticker = String(r.ticker || '').toUpperCase();
        const title = normaliseName(r.title);
        let score = 0, how = '';

        if (ticker && ticker === upper) { score = 100; how = aliased ? 'alias' : 'ticker'; }
        else if (q && title && title === q) { score = 90; how = 'name'; }
        else if (q && q.length >= 4 && title.startsWith(`${q} `)) { score = 70; how = 'name-prefix'; }

        if (!score) continue;
        // Pad to EDGAR's ten-digit form here so every consumer gets one shape.
        const cik = String(r.cik_str ?? '').replace(/\D/g, '').padStart(10, '0');
        const prev = byCik.get(cik);
        if (!prev || score > prev.score || (score === prev.score && ticker.length < prev.ticker.length)) {
            byCik.set(cik, { cik, ticker, title: String(r.title || ''), how, score });
        }
    }

    return [...byCik.values()].sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
}

/* --- feed parsing -------------------------------------------------------------
   The per-company filings feed is Atom with SEC's own extension elements inside
   <content>. feeds.js's generic parseFeed reads this well enough to get a title
   and a date, and drops everything that makes a filing citable: the form type,
   the accession number, the filing date as EDGAR states it. Those are the
   fields an answer has to carry, so this parser is separate rather than a flag
   on that one. */

const decode = (s) => String(s || '')
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .trim();

function tagOf(block, name) {
    const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
    return m ? decode(m[1]) : '';
}

/**
 * 8-K item codes out of one <entry>.
 *
 * The TITLES come from the SEC and are never invented here. That matters more
 * than it looks: an item code with a made-up description is worse than a bare
 * code, because "5.02" is checkable and a wrong sentence about it is not. When
 * the feed gives no title, the code is returned with `title: null` and the
 * caller says the number.
 *
 * @returns {Array<{code: string, title: string|null}>}
 */
function parseItems(block) {
    const byCode = new Map();

    /* Titled form, from <summary>: "Item 2.02: Results of Operations and
       Financial Condition<br>Item 9.01: Financial Statements and Exhibits".
       The summary is HTML-escaped inside the XML, so decode before matching. */
    const summary = decode(tagOf(block, 'summary'));
    for (const m of summary.matchAll(/Item\s+(\d+\.\d+)\s*:\s*([^<\n]+?)(?=\s*(?:<br|<\/|Item\s+\d+\.\d+|$))/gi)) {
        byCode.set(m[1], m[2].replace(/\s+/g, ' ').trim() || null);
    }

    /* Bare form, from <items-desc>: "items 2.02 and 9.01". Fills in anything
       the summary omitted; never overwrites a title we already have. */
    const desc = tagOf(block, 'items-desc');
    for (const m of desc.matchAll(/(\d+\.\d+)/g)) {
        if (!byCode.has(m[1])) byCode.set(m[1], null);
    }

    return [...byCode.entries()]
        .sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]))
        .map(([code, title]) => ({ code, title }));
}

/**
 * Company filings Atom -> {company, cik, filings[]}.
 *
 * @param {string} xml
 * @param {{limit?: number}} [opts]
 * @returns {{ok: boolean, error?: string, company: string|null, cik: string|null,
 *            sic: string|null, filings: object[]}}
 */
export function parseCompanyFeed(xml, { limit = 20 } = {}) {
    const text = String(xml || '');
    const empty = { company: null, cik: null, sic: null, filings: [] };

    /* Finding 3: an unknown CIK is served as HTTP 200 + HTML. "Not a feed" and
       "a feed with no entries" are different answers to the user and must not
       collapse into each other. */
    if (!/<feed[\s>]/i.test(text)) {
        return { ok: false, error: 'not an atom feed — EDGAR serves an HTML page for an unknown filer', ...empty };
    }

    const info = text.match(/<company-info>[\s\S]*?<\/company-info>/i)?.[0] || '';
    const company = tagOf(info, 'conformed-name') || null;
    const cik = (tagOf(info, 'cik') || '').replace(/\D/g, '') || null;
    const sic = tagOf(info, 'assigned-sic-desc') || null;

    const filings = [];
    for (const m of text.matchAll(/<entry>[\s\S]*?<\/entry>/gi)) {
        if (filings.length >= limit) break;
        const block = m[0];
        const accession = tagOf(block, 'accession-number') || null;
        // Without an accession the filing cannot be cited or fetched, so it is
        // not reported — the same rule parseSearchResults applies.
        if (!accession) continue;

        const filedAt = tagOf(block, 'filing-date') || null;
        filings.push({
            accession,
            form: tagOf(block, 'filing-type') || null,
            formName: tagOf(block, 'form-name') || null,
            /* 8-K ITEM CODES — the single most valuable field in this feed, and
               one a form-type-only parser throws away. "8-K" says a material
               event happened; the ITEM says which one, in the SEC's own closed
               vocabulary. Probed 24 Jul 2026: the feed carries them twice, as
               <items-desc>items 2.02 and 9.01</items-desc> and as titled lines
               inside <summary> ("Item 2.02: Results of Operations and Financial
               Condition"). Both are read, because the summary is the only place
               the TITLE appears and the desc is the only reliable place the
               codes appear when the summary is truncated. */
            items: parseItems(block),
            filedAt,
            // Milliseconds for sorting and freshness; null when EDGAR omits it
            // rather than a fabricated "now".
            filedTs: filedAt ? Date.parse(`${filedAt}T00:00:00Z`) || null : null,
            size: tagOf(block, 'size') || null,
            /* This is the filing INDEX page, not the document. The investigation
               pipeline already knows to resolve one via index.json — see
               pickPrimaryDocument. Naming the field for what it is stops it
               being fetched as if it were the filing. */
            indexUrl: tagOf(block, 'filing-href') || null,
        });
    }

    return { ok: true, company, cik, sic, filings };
}

/* --- materiality ranking --------------------------------------------------------
 * THE FAILURE THIS FIXES, from the live run of 24 Jul 2026. "sec filings of
 * google" returned 20 filings: fifteen Form 4s, four Form 144s, and — buried at
 * positions 2, 3 and 4 — the S-8, the 10-Q and the 8-K. gemma3:4b was handed all
 * twenty as an undifferentiated ledger and answered:
 *
 *   "The vast majority of the filings are Statement of Changes in Beneficial
 *    Ownership of Securities ... Filing #19 is a Report of Proposed Sale of
 *    Securities. This type of filing must be filed when a company (in this case,
 *    Alphabet) intends to sell a significant block of its own stock. It alerts
 *    the market to potential dilution"
 *
 * Two failures in one answer. It never mentioned the quarterly report, which is
 * the only filing anyone asking that question wants. And its description of
 * Form 144 is wrong: a 144 is filed by an AFFILIATE selling restricted or
 * control securities, not by the issuer selling its own stock, and it has
 * nothing to do with dilution.
 *
 * SEFD (arXiv:2606.18192, Bettencourt/Ding/Giesecke, Stanford, Jun 2026)
 * measured exactly why this happens: across an 18.5M-filing archive sample,
 * Form 4 filings are "roughly one quarter of sampled filings but only 1.7% of
 * tokens", and the paper states the theme directly — "filing frequency and
 * training mass follow very different distributions". Recency order is
 * therefore the wrong order. The most FREQUENT filing is close to the least
 * INFORMATIVE one, and a reverse-chronological ledger is sorted by the wrong
 * axis entirely.
 *
 * Fin-RATE (arXiv:2602.07294, KDD '26) names the resulting failure and
 * quantifies it as a retrieval problem rather than a generation one:
 * "Distractor Evidence" is the case where the gold chunk IS in the context but
 * is crowded out by noisier chunks ranked around it, and the paper concludes
 * that "the dominant bottleneck in the RAG pipeline is the retriever's failure
 * to surface essential evidence, not deficiencies in generation." A stronger
 * model would not have fixed the answer above. A better-ordered ledger does.
 */

/** Tiers, highest first. The reason column is the disclosure each form carries;
 *  it is what makes the ordering defensible rather than a taste ranking. */
export const FORM_MATERIALITY = [
    [/^10-K/i, 100, 'annual report — audited financials, risk factors, MD&A'],
    [/^10-Q/i, 95, 'quarterly report — current financials and period changes'],
    [/^8-K/i, 90, 'current report — a material event the issuer had to disclose'],
    [/^20-F/i, 88, 'annual report, foreign private issuer'],
    [/^6-K/i, 80, 'interim report, foreign private issuer'],
    [/^DEF ?14A/i, 78, 'proxy statement — governance and executive compensation'],
    [/^S-1/i, 75, 'registration statement for a securities offering'],
    [/^424B/i, 70, 'prospectus — terms of a live offering'],
    [/^SC 13[DG]/i, 60, 'beneficial ownership above 5% — a control-relevant stake'],
    [/^13F/i, 55, 'institutional holdings report'],
    [/^S-8/i, 40, 'registration of shares for employee benefit plans'],
    [/^144/i, 20, 'notice of a proposed sale by an affiliate'],
    [/^[35](\/A)?$/i, 15, 'insider ownership statement'],
    [/^4(\/A)?$/i, 10, 'insider transaction report'],
];

/** Materiality score for a form type. Unknown forms sit above the insider
 *  noise floor and below the periodic reports: an unrecognised form might
 *  matter, so it is not silenced, but it does not outrank a 10-Q either. */
export function formMateriality(form) {
    const f = String(form || '').trim();
    if (!f) return 0;
    for (const [re, score] of FORM_MATERIALITY) if (re.test(f)) return score;
    return 50;
}

/** The SEC's own one-line description of a form, when we have one. */
export function formPurpose(form) {
    const f = String(form || '').trim();
    for (const [re, , why] of FORM_MATERIALITY) if (re.test(f)) return why;
    return null;
}

/**
 * Order filings by what they DISCLOSE, then by when they were filed, and cap
 * runs of the same low-materiality form.
 *
 * The cap is the operative part. Fifteen Form 4s are fifteen near-identical
 * lines that say the same thing; they consume the evidence budget that the
 * 10-Q needs and give a small model fifteen chances to conclude that insider
 * transactions are what the company did this month. Capping is NOT dropping:
 * the suppressed filings are returned separately and reported, because
 * "Alphabet filed fifteen Form 4s" is itself a true and sometimes useful fact.
 *
 * @returns {{ranked: object[], suppressed: object[], counts: Record<string, number>}}
 */
export function rankFilings(filings, { limit = 8, perFormCap = 2 } = {}) {
    const list = (Array.isArray(filings) ? filings : []).filter(Boolean);
    const counts = {};
    for (const f of list) {
        const k = String(f.form || 'unknown');
        counts[k] = (counts[k] || 0) + 1;
    }

    const ordered = [...list].sort((a, b) => {
        const m = filingScore(b) - filingScore(a);
        if (m) return m;
        return (b.filedTs || 0) - (a.filedTs || 0);
    });

    const seen = {};
    const ranked = [], suppressed = [];
    for (const f of ordered) {
        const k = String(f.form || 'unknown');
        seen[k] = (seen[k] || 0) + 1;
        /* Capping is per form, and the score decides which forms are eligible:
           three 8-Ks in a month are three separate material events, not three
           copies of one, and any that were merely exhibit attachments have
           already been scored down to the floor by filingScore(). */
        const capped = filingScore(f) < 50 && seen[k] > perFormCap;
        if (capped || ranked.length >= limit) suppressed.push(f);
        else ranked.push(f);
    }
    return { ranked, suppressed, counts };
}

/**
 * A filing's rank: its form's materiality, EXCEPT for an 8-K, where it is the
 * significance of what the 8-K actually reports.
 *
 * All 8-Ks are the same form and are not remotely the same news. One says prior
 * financial statements can no longer be relied upon; another says exhibits are
 * attached to something. Ranking both as "8-K" files a restatement and a cover
 * sheet in the same place, which is the entire reason item codes exist.
 */
export function filingScore(filing) {
    const base = formMateriality(filing?.form);
    if (!/^8-K/i.test(String(filing?.form || ''))) return base;
    const event = classifyEvent(filing);
    /* An 8-K whose items could not be read keeps the form's base rank. Unknown
       is not the same as unimportant, and a parse gap must never silence a
       real event. */
    return event ? event.significance : base;
}

/* --- event significance ----------------------------------------------------------
 * "What changed today that materially affects this company, and what evidence
 * supports it" is answerable WITHOUT a model, for the one form built to answer
 * it. An 8-K exists because something happened that the SEC decided
 * shareholders must be told about within four business days, and the item code
 * says which of a closed list of somethings it was.
 *
 * NOTHING BELOW GENERATES A NUMBER ABOUT THE FUTURE. The table ranks how much
 * an item disturbs a company's disclosed position, which is a statement about
 * the filing. It is not a probability, a conviction, a confidence or a price
 * target, and it must never be presented as one — see the note in
 * describeEvents(). The item TITLES come from the SEC via the feed and are not
 * stored here; only the weighting is a judgement, and it is one a reader can
 * disagree with and re-tune without touching anything else.
 */
export const EVENT_SIGNIFICANCE = [
    /* Something is wrong with numbers already published. The most consequential
       thing an 8-K can say, and the rarest.

       Scored ABOVE the 10-K's 100 on purpose, and the tie it broke is the
       reason the number is 105: a 4.02 says the annual or quarterly report
       cannot be relied upon, so it does not merely compete with that report for
       attention — it invalidates it. Ranking them equal let the 10-K win on
       sort order and buried the notice saying the 10-K was wrong. */
    [/^4\.02$/, 105, 'prior financial statements should no longer be relied upon'],
    [/^1\.03$/, 98, 'bankruptcy or receivership'],
    [/^2\.04$/, 92, 'a debt obligation has been accelerated or triggered'],
    [/^5\.02$/, 90, 'a director or principal officer arrived or departed'],
    [/^2\.01$/, 88, 'an acquisition or disposition of assets completed'],
    [/^1\.01$/, 85, 'entry into a material definitive agreement'],
    [/^1\.02$/, 82, 'termination of a material definitive agreement'],
    [/^3\.01$/, 80, 'delisting notice or a failure to satisfy a listing rule'],
    [/^2\.03$/, 75, 'a direct financial obligation was created'],
    [/^2\.02$/, 72, 'results of operations — the earnings release'],
    [/^5\.07$/, 55, 'shareholder vote results'],
    [/^7\.01$/, 45, 'Regulation FD disclosure'],
    [/^8\.01$/, 40, 'other events the registrant chose to report'],
    /* Not an event at all — it says exhibits are attached to one. Weighted at
       the floor so an 8-K that is ONLY 9.01 is not announced as news. */
    [/^9\.01$/, 5, 'financial statements and exhibits accompanying this filing'],
];

/** How much a single item code disturbs the company's disclosed position. */
export function itemSignificance(code) {
    const c = String(code || '').trim();
    if (!c) return 0;
    for (const [re, score] of EVENT_SIGNIFICANCE) if (re.test(c)) return score;
    /* An unrecognised item is a real SEC item this table has not been tuned
       for. It sits above pure attachment noise and below the named events —
       silence would be the wrong default for a disclosure nobody classified. */
    return 50;
}

/** Our plain-language note for an item, used ONLY when the SEC feed gave no
 *  title. Never used to override the SEC's own wording. */
export function itemNote(code) {
    const c = String(code || '').trim();
    for (const [re, , note] of EVENT_SIGNIFICANCE) if (re.test(c)) return note;
    return null;
}

/**
 * The most significant thing a filing reports, or null.
 *
 * Only 8-Ks carry item codes, so only 8-Ks produce events. A 10-Q is important
 * but it is not an event: it is scheduled, and reporting it as something that
 * "happened today" would misdescribe it.
 *
 * @returns {{code, title, significance, isRoutine}|null}
 */
export function classifyEvent(filing) {
    const items = filing?.items;
    if (!Array.isArray(items) || !items.length) return null;

    const scored = items
        .map((it) => ({
            code: it.code,
            /* SEC wording first, ours only as a fallback. */
            title: it.title || itemNote(it.code),
            fromSec: Boolean(it.title),
            significance: itemSignificance(it.code),
        }))
        .sort((a, b) => b.significance - a.significance);

    const top = scored[0];
    return {
        ...top,
        all: scored,
        /* An 8-K whose only content is "exhibits are attached" is not news. */
        isRoutine: top.significance <= 40,
    };
}

/**
 * Say what happened, in the SEC's words, with the filing as the citation.
 *
 * DELIBERATELY WITHOUT A SCORE. The obvious next step is to print
 * "Significance: 90%", and that number would be fabricated — there is no
 * measurement behind it, and this project's log already contains the cost of
 * emitting confident-sounding numbers that nothing produced ("$17,500" for
 * bitcoin, "$8.5 billion" of invented Goldman compensation). The ranking is
 * used to ORDER events, which is a decision this module is entitled to make.
 * It is not published as a confidence, because it is not one.
 */
export function describeEvents(company, filings, { limit = 3 } = {}) {
    const events = (filings || [])
        .map((f) => ({ filing: f, event: classifyEvent(f) }))
        .filter((e) => e.event && !e.event.isRoutine)
        /* RECENCY FIRST, significance only to break ties. Significance decides
           what counts as an event at all (the isRoutine filter above); once
           something qualifies, "what changed" means the newest one. Sorting
           globally by significance led Tesla's answer with a director change
           from November 2025 while an earnings release from that morning sat
           below it — a correct ranking of importance and the wrong answer to
           the question. */
        .sort((a, b) => (b.filing.filedTs || 0) - (a.filing.filedTs || 0)
            || b.event.significance - a.event.significance);

    if (!events.length) return '';

    const lines = events.slice(0, limit).map(({ filing, event }) => {
        const when = filing.filedAt ? ` on ${filing.filedAt}` : '';
        return `${filing.form}${when}, item ${event.code} — ${shortItemTitle(event)}`;
    });
    const n = events.length;
    return `${n} reportable event${n === 1 ? '' : 's'} for ${company}, most recent first: ${lines.join('; ')}.`;
}

/**
 * An item title short enough to say out loud.
 *
 * SEC item titles are written to cover every sub-case the item can carry, so
 * 5.02 arrives as "Departure of Directors or Certain Officers; Election of
 * Directors; Appointment of Certain Officers: Compensatory Arrangements of
 * Certain Officers" — 138 characters describing four different possible events,
 * only one of which happened. That is unspeakable, and picking one clause would
 * be worse: choosing "Departure" when it was an appointment states the opposite
 * of the truth.
 *
 * So the first clause is kept and the truncation is MARKED, which says "there
 * is more to this item than I am reading you" rather than silently asserting
 * one branch. The untruncated title stays in memory and on screen.
 */
export function shortItemTitle(event, { maxChars = 60 } = {}) {
    if (!event?.title) return `item ${event?.code || 'unknown'}`;
    const full = String(event.title).replace(/\s+/g, ' ').trim();
    if (full.length <= maxChars) return full;
    const head = full.split(/[;:]/)[0].trim();
    return `${head.slice(0, maxChars)}…`;
}

/** What was held back, stated rather than silently dropped. */
export function describeSuppressed(suppressed, counts) {
    if (!suppressed?.length) return '';
    const byForm = {};
    for (const f of suppressed) {
        const k = String(f.form || 'unknown');
        byForm[k] = (byForm[k] || 0) + 1;
    }
    const parts = Object.entries(byForm)
        .sort((a, b) => b[1] - a[1])
        .map(([form, n]) => `${n} more ${form}`);
    return `Also filed, not detailed: ${parts.join(', ')}.`;
}

/* --- what a filing contributes to memory --------------------------------------
   One line per filing, dated and linkable. Deliberately short for the same
   reason feeds.js's is: the retrieval corpus is small and best-first, and a
   company's Form 4 stream should not crowd out the user's own notes. */

export function toMemoryText(company, filing) {
    if (!company || !filing?.form) return null;
    const when = filing.filedAt || 'undated';
    const what = filing.formName && filing.formName !== filing.form ? ` (${filing.formName})` : '';
    /* The item codes go into memory with the filing. Without them, every 8-K
       stored here reads "filed 8-K (Current report)" — indistinguishable from
       every other 8-K, and a later question about what happened retrieves a
       row that cannot answer it. With them, the stored line names the event in
       the SEC's own words and stays checkable against the accession. */
    const ev = classifyEvent(filing);
    const items = ev
        ? ` Items: ${ev.all.map((i) => `${i.code}${i.title ? ` ${i.title}` : ''}`).join('; ')}.`
        : '';
    return `[${when}] SEC EDGAR: ${company} filed ${filing.form}${what}.${items} Accession ${filing.accession}. ${filing.indexUrl || ''}`.trim();
}

/**
 * The spoken summary. Every fact in it came out of the feed; nothing is
 * inferred, and in particular nothing is said about what any filing MEANS.
 */
export function describeFilings(company, filings, { limit = 3, forms = [], total = null } = {}) {
    const scope = forms.length ? `${forms.join(' and ')} filings` : 'filings';
    if (!filings?.length) {
        return `EDGAR lists no ${scope} for ${company || 'that filer'}, Sir.`;
    }
    const lead = filings.slice(0, limit)
        .map((f) => `${f.form}${f.filedAt ? ` on ${f.filedAt}` : ''}`)
        .join('; ');
    /* `total` is the full feed count; `filings` may be the ranked subset. The
       count spoken has to be the real one — saying "8 filings" when EDGAR
       returned 20 is a false statement about the company, not a summary. */
    const n = Number.isFinite(total) ? total : filings.length;
    /* "Most significant" rather than "most recent": the caller passes a
       materiality-ranked list, and calling that recency would misdescribe it. */
    return `${company} has ${n} recent ${n === 1 ? 'filing' : scope} on EDGAR, Sir. Most significant: ${lead}.`;
}

/* --- spoken query -> company + forms -------------------------------------------
   Rule-based, like every other parser on this path. The hard part is the same
   one edgarSearch.js has and in the opposite direction: this must fire when a
   COMPANY is named and stay silent when one is not, so "any new sec filings"
   keeps reaching the feed brief that already answers it. Both directions are
   asserted in the tests. */

/* Form words, longest-first so "10-K" is not eaten by a shorter pattern.
   Every entry ends `s?\b` for the reason edgarSearch.js documents: people say
   "8-Ks", and a \b straight after the noun refuses the plural. */
const FORM_WORDS = [
    [/\b(?:10-?ks?|ten\s?ks?|annual reports?)\b/i, '10-K'],
    [/\b(?:10-?qs?|ten\s?qs?|quarterly reports?)\b/i, '10-Q'],
    [/\b(?:8-?ks?|eight\s?ks?)\b/i, '8-K'],
    [/\b(?:s-?1s?|ipo filings?|registration statements?)\b/i, 'S-1'],
    [/\b(?:def ?14a|proxy statements?|proxies|proxy)\b/i, 'DEF 14A'],
    [/\b(?:13-?fs?|holdings? reports?)\b/i, '13F-HR'],
    [/\b(?:20-?fs?)\b/i, '20-F'],
    [/\b(?:6-?ks?)\b/i, '6-K'],
    [/\b(?:424b\d?|prospectus(?:es)?)\b/i, '424B2'],
];

/* The two orders a person actually uses: filings-of-COMPANY, and COMPANY's
   filings. Anything before the lead-in is discarded, so "hey jarvis show me the
   sec filings of google please" works. */
const OF_FORM = /\b(?:sec\s+)?(?:filings?|forms?|disclosures?|submissions?|8-?ks?|10-?ks?|10-?qs?|annual reports?|quarterly reports?|proxy statements?|prospectus(?:es)?)\s+(?:of|for|from|by|filed by)\s+(.+)$/i;
const POSSESSIVE = /^(.+?)(?:'s|s')\s+(?:recent\s+|latest\s+|last\s+|new\s+)?(?:sec\s+)?(?:filings?|forms?|disclosures?|submissions?|8-?ks?|10-?ks?|10-?qs?|annual reports?|quarterly reports?|proxy statements?|prospectus(?:es)?)\b/i;
const HAS_FILED = /\bwhat\s+(?:has|did)\s+(.+?)\s+(?:file|filed|filed with the sec)\b/i;

/* Words that arrive attached to the company name and are not part of it. */
const TRIM = /\b(?:the|any|all|some|recent|recently|latest|newest|last|new|most recent|sec|edgar|filings?|forms?|please|sir|for me|show me|list|give me|pull up|find|get|me)\b/gi;

/**
 * @returns {{name: string, forms: string[], raw: string}|null}
 */
export function parseCompanyFilingsQuery(text) {
    const raw = String(text || '').trim();
    if (!raw) return null;

    /* A full-text search lead-in belongs to edgarSearch.js. "which companies
       mention lithium in their filings" is not a question about one company,
       and stealing it would send a phrase to this resolver as if it were a
       name. */
    if (/\b(?:mention(?:s|ed|ing)?|search|containing|contains|talk(?:s|ing) about)\b/i.test(raw)) return null;

    let candidate = null;
    const m1 = raw.match(OF_FORM);
    const m2 = raw.match(POSSESSIVE);
    const m3 = raw.match(HAS_FILED);
    if (m1) candidate = m1[1];
    else if (m2) candidate = m2[1];
    else if (m3) candidate = m3[1];
    if (!candidate) return null;

    const forms = [];
    for (const [re, form] of FORM_WORDS) if (re.test(raw)) forms.push(form);

    const name = candidate
        .replace(/[?.!,]+$/, '')
        .replace(TRIM, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    /* No name left means the sentence was about filings in general — "show me
       the latest sec filings". That is the feed brief's question, and refusing
       here is what leaves it alone. */
    if (name.length < 2) return null;
    /* A leftover pronoun is not a company. "what did they file" cannot be
       resolved and must not be sent to the resolver as the literal word. */
    if (/^(?:it|they|them|he|she|we|you|i|that|this|these|those|who|anyone|someone|everyone)$/i.test(name)) return null;

    return { name, forms, raw };
}

export default {
    SEC_TICKERS_URL, NAME_ALIASES, FORM_MATERIALITY, EVENT_SIGNIFICANCE,
    normaliseName, resolveCompany, parseCompanyFeed,
    formMateriality, formPurpose, filingScore, rankFilings, describeSuppressed,
    itemSignificance, itemNote, classifyEvent, describeEvents,
    toMemoryText, describeFilings, parseCompanyFilingsQuery,
};
