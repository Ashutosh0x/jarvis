// Per-company EDGAR filings: name resolution, feed parsing, query parsing.
//
// The Atom fixture is REAL, captured 24 Jul 2026 from
//   www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001652044&type=10-K&output=atom
// trimmed to two entries. The second one is the one that matters: it is a
// 10-K/A, which the feed returns for a 10-K request because EDGAR prefix-matches
// the form. An answer that presents an amendment as the original is wrong, so
// the parser has to surface the distinction rather than normalise it away.
//
// The resolver fixture is a slice of the real company_tickers.json, including
// the two entries that make the OpenAI/Opendoor collision reproducible.

import {
    resolveCompany, parseCompanyFeed, parseCompanyFilingsQuery,
    toMemoryText, describeFilings, normaliseName, NAME_ALIASES,
    formMateriality, formPurpose, rankFilings, describeSuppressed,
    itemSignificance, classifyEvent, describeEvents, filingScore, shortItemTitle,
} from '../edgarCompany.js';

let pass = 0, fail = 0;
const check = (n, c, d = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

/* --- fixtures ---------------------------------------------------------------- */

const ROWS = [
    { cik_str: 1045810, ticker: 'NVDA', title: 'NVIDIA CORP' },
    { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' },
    { cik_str: 1652044, ticker: 'GOOGL', title: 'Alphabet Inc.' },
    { cik_str: 1652044, ticker: 'GOOG', title: 'Alphabet Inc.' },
    { cik_str: 1652044, ticker: 'GOOGM', title: 'Alphabet Inc.' },
    { cik_str: 1326801, ticker: 'META', title: 'Meta Platforms, Inc.' },
    { cik_str: 1318605, ticker: 'TSLA', title: 'Tesla, Inc.' },
    { cik_str: 886982, ticker: 'GS', title: 'GOLDMAN SACHS GROUP INC' },
    { cik_str: 886982, ticker: 'GS-PA', title: 'GOLDMAN SACHS GROUP INC' },
    // The collision that killed prefix matching: "openai" shares four leading
    // characters with OPEN, exactly as "google" does with GOOG.
    { cik_str: 1801169, ticker: 'OPEN', title: 'Opendoor Technologies Inc.' },
    { cik_str: 1418121, ticker: 'APLE', title: 'Apple Hospitality REIT, Inc.' },
];

const ATOM = `<?xml version="1.0" encoding="ISO-8859-1" ?>
  <feed xmlns="http://www.w3.org/2005/Atom">
    <author><email>webmaster@sec.gov</email><name>Webmaster</name></author>
    <company-info>
      <assigned-sic>7370</assigned-sic>
      <assigned-sic-desc>SERVICES-COMPUTER PROGRAMMING, DATA PROCESSING, ETC.</assigned-sic-desc>
      <cik>0001652044</cik>
      <conformed-name>Alphabet Inc.</conformed-name>
      <fiscal-year-end>1231</fiscal-year-end>
      <state-of-incorporation>DE</state-of-incorporation>
    </company-info>
    <entry>
      <category label="form type" scheme="https://www.sec.gov/" term="10-K" />
      <content type="text/xml">
        <accession-number>0001652044-26-000018</accession-number>
        <act>34</act>
        <file-number>001-37580</file-number>
        <filing-date>2026-02-05</filing-date>
        <filing-href>https://www.sec.gov/Archives/edgar/data/1652044/000165204426000018/0001652044-26-000018-index.htm</filing-href>
        <filing-type>10-K</filing-type>
        <form-name>Annual report [Section 13 and 15(d), not S-K Item 405]</form-name>
        <size>15 MB</size>
      </content>
      <id>urn:tag:sec.gov,2008:accession-number=0001652044-26-000018</id>
      <title>10-K  - Annual report [Section 13 and 15(d), not S-K Item 405]</title>
      <updated>2026-02-04T21:56:03-05:00</updated>
    </entry>
    <entry>
      <category label="form type" scheme="https://www.sec.gov/" term="10-K/A" />
      <content type="text/xml">
        <accession-number>0001193125-19-028757</accession-number>
        <amend>[Amend]</amend>
        <filing-date>2019-02-06</filing-date>
        <filing-href>https://www.sec.gov/Archives/edgar/data/1652044/000119312519028757/0001193125-19-028757-index.htm</filing-href>
        <filing-type>10-K/A</filing-type>
        <form-name>Annual report [Section 13 and 15(d), not S-K Item 405]</form-name>
        <size>83 KB</size>
      </content>
      <id>urn:tag:sec.gov,2008:accession-number=0001193125-19-028757</id>
      <title>10-K/A [Amend]  - Annual report [Section 13 and 15(d), not S-K Item 405]</title>
      <updated>2019-02-06T06:07:02-05:00</updated>
    </entry>
  </feed>`;

/* What EDGAR actually serves for a CIK that does not exist: HTTP 200, HTML.
   Abbreviated, but the shape is the point — there is no <feed> anywhere. */
const NOT_A_FEED = `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.0 Transitional//EN">
<html lang="ENG"><head><title>Company Information: </title></head>
<body style="margin: 0"><h1>No matching companies.</h1></body></html>`;

/* --- name resolution ---------------------------------------------------------- */

console.log('\n--- resolveCompany ---');

check('exact ticker resolves', (() => {
    const r = resolveCompany('AAPL', ROWS);
    return r[0]?.cik === '0000320193' && r[0].how === 'ticker';
})(), JSON.stringify(resolveCompany('AAPL', ROWS)[0]));

check('exact name resolves', resolveCompany('tesla', ROWS)[0]?.cik === '0001318605');

check('corporate suffix is ignored on both sides',
    resolveCompany('Tesla Inc', ROWS)[0]?.cik === '0001318605');

/* THE CASE THIS MODULE EXISTS FOR. "google" appears in no title in the real
   file and Alphabet has no former names, so only the alias table reaches it. */
check('"google" resolves to Alphabet via the alias table', (() => {
    const r = resolveCompany('google', ROWS);
    return r.length === 1 && r[0].cik === '0001652044' && r[0].how === 'alias';
})(), JSON.stringify(resolveCompany('google', ROWS)));

check('"facebook" resolves to Meta', resolveCompany('facebook', ROWS)[0]?.cik === '0001326801');
check('the alias table stays small', Object.keys(NAME_ALIASES).length <= 4,
    `${Object.keys(NAME_ALIASES).length} entries`);

/* THE REGRESSION THAT REJECTED PREFIX MATCHING. A ticker-prefix rule resolves
   "google" -> GOOG correctly and "openai" -> OPEN (Opendoor Technologies)
   wrongly, with identical four-of-six-character overlap. OpenAI does not file
   with the SEC, so the only correct answer is none. */
check('"openai" resolves to NOTHING, not Opendoor',
    resolveCompany('openai', ROWS).length === 0,
    JSON.stringify(resolveCompany('openai', ROWS)));

check('an unknown private company resolves to nothing',
    resolveCompany('stripe', ROWS).length === 0);

check('share classes collapse to one filer per CIK', (() => {
    const r = resolveCompany('GOOGL', ROWS);
    return r.length === 1 && r[0].cik === '0001652044';
})(), JSON.stringify(resolveCompany('GOOGL', ROWS)));

check('multi-ticker name collapses too',
    resolveCompany('goldman sachs', ROWS).length === 1);

/* A name prefix must not outrank an exact name. "apple" is Apple Inc., not
   Apple Hospitality REIT, and both are in the file. */
check('exact name beats name-prefix', (() => {
    const r = resolveCompany('apple', ROWS);
    return r[0]?.cik === '0000320193' && r[0].how === 'name';
})(), JSON.stringify(resolveCompany('apple', ROWS).map(x => x.title)));

check('CIK is padded to EDGAR ten-digit form',
    resolveCompany('nvidia', ROWS)[0]?.cik === '0001045810');

check('empty query resolves to nothing', resolveCompany('', ROWS).length === 0);
check('missing rows resolve to nothing', resolveCompany('apple', null).length === 0);
check('normaliseName strips punctuation and suffix', normaliseName('Meta Platforms, Inc.') === 'meta platforms');

/* --- feed parsing -------------------------------------------------------------- */

console.log('\n--- parseCompanyFeed ---');

const feed = parseCompanyFeed(ATOM);

check('feed parses', feed.ok === true, feed.error || '');
check('conformed name is read', feed.company === 'Alphabet Inc.', String(feed.company));
check('cik is read', feed.cik === '0001652044', String(feed.cik));
check('sic description is read', /COMPUTER PROGRAMMING/.test(feed.sic || ''), String(feed.sic));
check('both entries parse', feed.filings.length === 2, String(feed.filings.length));

const [first, second] = feed.filings;
check('form type is read', first.form === '10-K', String(first.form));
check('form name is read', /Annual report/.test(first.formName || ''), String(first.formName));
check('filing date is read', first.filedAt === '2026-02-05', String(first.filedAt));
check('accession is read', first.accession === '0001652044-26-000018', String(first.accession));
check('size is read', first.size === '15 MB', String(first.size));

/* The index URL is named for what it IS. Fetching it as though it were the
   filing yields ~11KB of table markup that reads like a document — the exact
   trap investigation.js resolves via index.json. */
check('the link is the filing INDEX, not the document',
    /-index\.htm$/.test(first.indexUrl || ''), String(first.indexUrl));

check('filedTs is a real timestamp',
    first.filedTs === Date.parse('2026-02-05T00:00:00Z'), String(first.filedTs));

/* EDGAR prefix-matches the form. A 10-K request returns 10-K/A, and the two
   must stay distinguishable or an amendment gets reported as the original. */
check('the amendment keeps its own form type', second.form === '10-K/A', String(second.form));
check('the amendment is not normalised into 10-K', first.form !== second.form);

/* An unknown CIK is HTTP 200 + HTML. "Not a feed" and "no filings" are
   different claims and this is the check that keeps them apart. */
check('an HTML page is reported as not-a-feed, not as zero filings', (() => {
    const r = parseCompanyFeed(NOT_A_FEED);
    return r.ok === false && r.filings.length === 0 && /unknown filer/.test(r.error || '');
})(), JSON.stringify(parseCompanyFeed(NOT_A_FEED)));

check('empty input is not-a-feed', parseCompanyFeed('').ok === false);

check('limit is honoured', parseCompanyFeed(ATOM, { limit: 1 }).filings.length === 1);

/* An entry with no accession cannot be cited or fetched, so it is dropped. */
check('an entry without an accession is dropped', (() => {
    const stripped = ATOM.replace('<accession-number>0001652044-26-000018</accession-number>', '');
    return parseCompanyFeed(stripped).filings.length === 1;
})());

/* --- memory + summary ---------------------------------------------------------- */

console.log('\n--- toMemoryText / describeFilings ---');

const line = toMemoryText('Alphabet Inc.', first);
check('memory line carries the date', line.startsWith('[2026-02-05]'), line);
check('memory line names the filer', line.includes('Alphabet Inc.'), line);
check('memory line carries the form and accession',
    line.includes('10-K') && line.includes('0001652044-26-000018'), line);
check('memory line carries the url', line.includes('https://www.sec.gov/Archives/'), line);
check('a filing with no form produces no memory line',
    toMemoryText('Alphabet Inc.', { accession: 'x' }) === null);
check('no company produces no memory line', toMemoryText(null, first) === null);

const spoken = describeFilings('Alphabet Inc.', feed.filings, { forms: ['10-K'] });
check('summary names the filer and the count',
    spoken.includes('Alphabet Inc.') && spoken.includes('2'), spoken);
check('summary quotes only real dates', spoken.includes('2026-02-05'), spoken);
check('empty results say so rather than inventing',
    /no 10-K filings/.test(describeFilings('Alphabet Inc.', [], { forms: ['10-K'] })),
    describeFilings('Alphabet Inc.', [], { forms: ['10-K'] }));

/* --- spoken query parsing ------------------------------------------------------- */

console.log('\n--- parseCompanyFilingsQuery ---');

const nameOf = (s) => parseCompanyFilingsQuery(s)?.name ?? null;
const formsOf = (s) => parseCompanyFilingsQuery(s)?.forms?.join(',') ?? null;

// The prompt that started this.
check('"sec filings of google"', nameOf('sec filings of google') === 'google', String(nameOf('sec filings of google')));
check('"filings of apple"', nameOf('filings of apple') === 'apple');
check('"show me the sec filings for tesla"', nameOf('show me the sec filings for tesla') === 'tesla',
    String(nameOf('show me the sec filings for tesla')));
check('possessive: "apple\'s sec filings"', nameOf("apple's sec filings") === 'apple', String(nameOf("apple's sec filings")));
check('possessive with recency: "google\'s latest filings"',
    nameOf("google's latest filings") === 'google', String(nameOf("google's latest filings")));
check('"what did tesla file"', nameOf('what did tesla file') === 'tesla', String(nameOf('what did tesla file')));
check('"what has nvidia filed"', nameOf('what has nvidia filed') === 'nvidia', String(nameOf('what has nvidia filed')));
check('a multi-word name survives', nameOf('sec filings of goldman sachs') === 'goldman sachs',
    String(nameOf('sec filings of goldman sachs')));
check('trailing politeness is stripped', nameOf('sec filings of google please') === 'google',
    String(nameOf('sec filings of google please')));

check('form type is extracted', formsOf('10-Ks of apple') === '10-K', String(formsOf('10-Ks of apple')));
check('the form is removed from the name', nameOf('10-Ks of apple') === 'apple', String(nameOf('10-Ks of apple')));
check('"annual report for tesla" is a 10-K', formsOf('annual report for tesla') === '10-K');
check('"8-Ks of nvidia"', formsOf('8-Ks of nvidia') === '8-K' && nameOf('8-Ks of nvidia') === 'nvidia');
check('"proxy statement for apple"', formsOf('proxy statement for apple') === 'DEF 14A');

/* --- what it must NOT steal ------------------------------------------------------
   Every one of these already has a working answer elsewhere, and a greedy
   parser here turns each into a wasted SEC round-trip against a company name
   that is not one. */

console.log('\n--- non-interference ---');

check('does not steal the feed brief: "any new sec filings"',
    parseCompanyFilingsQuery('any new sec filings') === null,
    JSON.stringify(parseCompanyFilingsQuery('any new sec filings')));
check('does not steal "latest sec filings"',
    parseCompanyFilingsQuery('latest sec filings') === null,
    JSON.stringify(parseCompanyFilingsQuery('latest sec filings')));
check('does not steal a full-text search: "which companies mention stablecoin in their filings"',
    parseCompanyFilingsQuery('which companies mention stablecoin in their filings') === null);
check('does not steal "search edgar for tokenized securities"',
    parseCompanyFilingsQuery('search edgar for tokenized securities') === null);
check('does not steal "any filings that mention lithium"',
    parseCompanyFilingsQuery('any filings that mention lithium') === null);
check('does not fire on ordinary conversation',
    parseCompanyFilingsQuery('what is the weather like') === null);
check('does not fire on a price query',
    parseCompanyFilingsQuery('how much is bitcoin') === null);
check('an unresolvable pronoun is refused rather than searched',
    parseCompanyFilingsQuery('what did they file') === null,
    JSON.stringify(parseCompanyFilingsQuery('what did they file')));
check('empty input is refused', parseCompanyFilingsQuery('') === null);
check('the raw utterance is carried through for the synthesis question',
    parseCompanyFilingsQuery('sec filings of google')?.raw === 'sec filings of google');

/* --- materiality ranking ---------------------------------------------------------
   REPLAYED FROM THE LIVE FAILURE of 24 Jul 2026. "sec filings of google"
   returned exactly this shape: fifteen Form 4s and four Form 144s around a
   single 10-Q, S-8 and 8-K. Fed in feed order, gemma3:4b answered entirely
   about beneficial-ownership reports and never mentioned the quarterly report.
   The fixture below is that distribution. */

console.log('\n--- rankFilings ---');

const mk = (form, day) => ({
    form, accession: `acc-${form}-${day}`, filedAt: `2026-07-${String(day).padStart(2, '0')}`,
    filedTs: Date.parse(`2026-07-${String(day).padStart(2, '0')}T00:00:00Z`),
    indexUrl: `https://www.sec.gov/x/${form}-${day}-index.htm`,
});

const LIVE_SHAPE = [
    mk('4', 23), mk('S-8', 23), mk('10-Q', 23), mk('8-K', 22), mk('4', 21),
    mk('4', 17), mk('144', 9), mk('144', 8), mk('144', 7), mk('4', 6),
    mk('4', 5), mk('4', 4), mk('4', 3), mk('4', 2), mk('4', 1),
];

const R = rankFilings(LIVE_SHAPE);

check('materiality: a 10-Q outranks a Form 4', formMateriality('10-Q') > formMateriality('4'));
check('materiality: a 10-K outranks a 10-Q', formMateriality('10-K') > formMateriality('10-Q'));
check('materiality: an 8-K outranks an S-8', formMateriality('8-K') > formMateriality('S-8'));
check('materiality: an amendment inherits its form\'s rank',
    formMateriality('10-K/A') === formMateriality('10-K'));
check('materiality: an unknown form sits above insider noise, below periodic reports',
    formMateriality('ABS-EE') > formMateriality('4') && formMateriality('ABS-EE') < formMateriality('10-Q'));
check('materiality: an empty form scores nothing', formMateriality('') === 0);

/* THE REGRESSION. The 10-Q must reach position 1; in the live run it was
   third behind a Form 4 and an S-8 and was never mentioned in the answer. */
check('the 10-Q is ranked FIRST, not third', R.ranked[0]?.form === '10-Q',
    R.ranked.map((f) => f.form).join(','));
check('the 8-K reaches the top three', R.ranked.slice(0, 3).some((f) => f.form === '8-K'),
    R.ranked.map((f) => f.form).join(','));
check('the S-8 is kept but demoted below the event report',
    R.ranked.findIndex((f) => f.form === 'S-8') > R.ranked.findIndex((f) => f.form === '8-K'));

/* Fifteen near-identical Form 4 lines are what crowded the ledger. */
check('runs of Form 4 are capped', R.ranked.filter((f) => f.form === '4').length <= 2,
    String(R.ranked.filter((f) => f.form === '4').length));
check('runs of Form 144 are capped', R.ranked.filter((f) => f.form === '144').length <= 2);
check('capping is not dropping — the rest are returned as suppressed',
    R.ranked.length + R.suppressed.length === LIVE_SHAPE.length,
    `${R.ranked.length}+${R.suppressed.length} vs ${LIVE_SHAPE.length}`);
check('every material filing survives the cap',
    ['10-Q', '8-K', 'S-8'].every((f) => R.ranked.some((x) => x.form === f)));

/* High-materiality forms must NOT be capped: three 8-Ks are three separate
   material events, not three copies of one. */
check('material forms are never capped', (() => {
    const many = [mk('8-K', 1), mk('8-K', 2), mk('8-K', 3), mk('8-K', 4)];
    return rankFilings(many).ranked.filter((f) => f.form === '8-K').length === 4;
})(), JSON.stringify(rankFilings([mk('8-K', 1), mk('8-K', 2), mk('8-K', 3), mk('8-K', 4)]).ranked.length));

check('ties inside a form break on recency (newest first)', (() => {
    const only4s = rankFilings([mk('4', 1), mk('4', 20), mk('4', 10)]).ranked;
    return only4s[0]?.filedAt === '2026-07-20';
})());

check('the ranked list respects the limit', rankFilings(LIVE_SHAPE, { limit: 3 }).ranked.length === 3);
check('empty input is handled', rankFilings([]).ranked.length === 0 && rankFilings(null).ranked.length === 0);

check('suppressed filings are counted out loud, not hidden', (() => {
    const s = describeSuppressed(R.suppressed, R.counts);
    return /more 4\b/.test(s) && /Also filed/.test(s);
})(), describeSuppressed(R.suppressed, R.counts));
check('nothing suppressed means nothing said', describeSuppressed([], {}) === '');

/* The SEC's own purpose line — the absence of which let the model invent that a
   Form 144 is the issuer selling its own stock and diluting shareholders. */
check('form purpose is available for Form 144', /affiliate/i.test(formPurpose('144') || ''), String(formPurpose('144')));
check('the 144 purpose does NOT say issuer or dilution',
    !/issuer|dilut/i.test(formPurpose('144') || ''), String(formPurpose('144')));
check('form purpose is available for 10-Q', /quarterly/i.test(formPurpose('10-Q') || ''));
check('an unknown form has no invented purpose', formPurpose('ZZZ-9') === null);

/* The spoken count must be the REAL feed count even when the list is ranked
   down to a subset — otherwise the summary understates what the company filed. */
check('the spoken count reports the full total, not the ranked subset',
    describeFilings('Alphabet Inc.', R.ranked, { total: LIVE_SHAPE.length }).includes('15'),
    describeFilings('Alphabet Inc.', R.ranked, { total: LIVE_SHAPE.length }));
check('the summary says "most significant", not "most recent"',
    describeFilings('Alphabet Inc.', R.ranked, { total: 15 }).includes('Most significant'));

/* --- 8-K event detection ----------------------------------------------------------
   The fixture is Alphabet's REAL 8-K entry of 22 Jul 2026, captured 24 Jul from
   the live company feed. It is the reason this exists: form-type-only parsing
   reported it as "8-K (Current report)", indistinguishable from every other
   8-K, when the feed was carrying "items 2.02 and 9.01" and the SEC's own
   titles for both the whole time. */

console.log('\n--- 8-K item codes and events ---');

const EIGHTK = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
  <company-info><cik>0001652044</cik><conformed-name>Alphabet Inc.</conformed-name></company-info>
  <entry>
    <category label="form type" scheme="https://www.sec.gov/" term="8-K" />
    <content type="text/xml">
      <accession-number>0001652044-26-000066</accession-number>
      <filing-date>2026-07-22</filing-date>
      <filing-href>https://www.sec.gov/Archives/edgar/data/1652044/000165204426000066/0001652044-26-000066-index.htm</filing-href>
      <filing-type>8-K</filing-type>
      <form-name>Current report</form-name>
      <items-desc>items 2.02 and 9.01</items-desc>
      <size>815 KB</size>
    </content>
    <summary type="html"> &lt;b&gt;Filed:&lt;/b&gt; 2026-07-22 &lt;b&gt;AccNo:&lt;/b&gt; 0001652044-26-000066 &lt;b&gt;Size:&lt;/b&gt; 815 KB&lt;br&gt;Item 2.02: Results of Operations and Financial Condition&lt;br&gt;Item 9.01: Financial Statements and Exhibits</summary>
    <title>8-K  - Current report</title>
    <updated>2026-07-22T16:01:36-04:00</updated>
  </entry>
</feed>`;

const ek = parseCompanyFeed(EIGHTK).filings[0];

check('items are parsed from the real 8-K', ek.items?.length === 2, JSON.stringify(ek.items));
check('item codes are read', ek.items.map((i) => i.code).join(',') === '2.02,9.01', JSON.stringify(ek.items));
/* The SEC supplies the wording. Inventing a description for a code is worse
   than printing the bare number, because the number is checkable. */
check('the SEC\'s own item title is kept verbatim',
    ek.items[0].title === 'Results of Operations and Financial Condition', String(ek.items[0].title));
check('the second item title is kept too',
    ek.items[1].title === 'Financial Statements and Exhibits', String(ek.items[1].title));
check('items are ordered by code', parseFloat(ek.items[0].code) < parseFloat(ek.items[1].code));

/* items-desc must fill gaps when the summary carries no titles, without
   inventing a title. */
check('codes are recovered from items-desc alone when the summary has none', (() => {
    const noSummary = EIGHTK.replace(/<summary[\s\S]*?<\/summary>/, '<summary type="html">Filed: 2026-07-22</summary>');
    const f = parseCompanyFeed(noSummary).filings[0];
    return f.items.length === 2 && f.items.every((i) => i.title === null);
})(), JSON.stringify(parseCompanyFeed(EIGHTK.replace(/<summary[\s\S]*?<\/summary>/, '<summary type="html">x</summary>')).filings[0].items));

check('a filing with no items has none, not a guess', (() => {
    const tenq = parseCompanyFeed(ATOM).filings[0];
    return Array.isArray(tenq.items) && tenq.items.length === 0;
})(), JSON.stringify(parseCompanyFeed(ATOM).filings[0].items));

/* --- classification --- */
const ev = classifyEvent(ek);
check('the earnings release is identified as the significant item', ev.code === '2.02', JSON.stringify(ev));
check('the event uses the SEC wording', ev.fromSec === true && /Results of Operations/.test(ev.title));
check('an exhibits-only item does not become the headline', ev.code !== '9.01');
check('this 8-K is not routine', ev.isRoutine === false);
check('a filing with no items classifies to null', classifyEvent({ form: '10-Q' }) === null);

/* Ordering across the item vocabulary — the point of the whole table. */
check('a restatement outranks an earnings release',
    itemSignificance('4.02') > itemSignificance('2.02'));
check('an officer departure outranks an earnings release',
    itemSignificance('5.02') > itemSignificance('2.02'));
check('an acquisition outranks a Reg FD disclosure',
    itemSignificance('2.01') > itemSignificance('7.01'));
check('exhibits rank at the floor', itemSignificance('9.01') < itemSignificance('8.01'));
check('an unrecognised item is not silenced', itemSignificance('3.03') >= 50, String(itemSignificance('3.03')));
check('an empty code scores nothing', itemSignificance('') === 0);

/* --- the ranking consequence --- */
const mkEv = (code, title, day) => ({
    form: '8-K', accession: `a-${code}-${day}`, filedAt: `2026-07-${String(day).padStart(2, '0')}`,
    filedTs: Date.parse(`2026-07-${String(day).padStart(2, '0')}T00:00:00Z`),
    items: [{ code, title }], indexUrl: 'https://www.sec.gov/x-index.htm',
});

check('an 8-K is scored by its EVENT, not by being an 8-K',
    filingScore(mkEv('4.02', 'Non-Reliance', 1)) > filingScore(mkEv('9.01', 'Exhibits', 1)),
    `${filingScore(mkEv('4.02', 'Non-Reliance', 1))} vs ${filingScore(mkEv('9.01', 'Exhibits', 1))}`);
check('a restatement 8-K outranks the quarterly report',
    filingScore(mkEv('4.02', 'Non-Reliance', 1)) > formMateriality('10-Q'));
check('an exhibits-only 8-K falls below a routine insider filing',
    filingScore(mkEv('9.01', 'Exhibits', 1)) < formMateriality('4'));
check('an 8-K with unreadable items keeps the form\'s base rank',
    filingScore({ form: '8-K' }) === formMateriality('8-K'));
check('non-8-K forms are unaffected by event scoring',
    filingScore({ form: '10-Q' }) === formMateriality('10-Q'));

check('a restatement is ranked above everything else present', (() => {
    const mixed = [mk('10-K', 5), mkEv('9.01', 'Exhibits', 6), mkEv('4.02', 'Non-Reliance', 4), mk('4', 7)];
    return rankFilings(mixed).ranked[0].items?.[0].code === '4.02';
})(), rankFilings([mk('10-K', 5), mkEv('9.01', 'Exhibits', 6), mkEv('4.02', 'Non-Reliance', 4), mk('4', 7)]).ranked.map(f => f.form + (f.items?.[0]?.code ? ':' + f.items[0].code : '')).join(','));

/* --- what gets said --- */
const spokenEv = describeEvents('Alphabet Inc.', [ek]);
check('the event is announced with its code and the SEC title',
    /2\.02/.test(spokenEv) && /Results of Operations/.test(spokenEv), spokenEv);
check('the event names the filer', spokenEv.includes('Alphabet Inc.'), spokenEv);

/* THE LINE THIS MODULE MUST NOT CROSS. Ordering events is a decision it is
   entitled to make; publishing a confidence, conviction or probability is
   inventing a measurement that does not exist. */
check('no score, percentage or confidence is ever published',
    !/%|confidence|conviction|probability|\bscore\b/i.test(spokenEv), spokenEv);
check('an exhibits-only 8-K is not announced as news',
    describeEvents('X', [mkEv('9.01', 'Financial Statements and Exhibits', 1)]) === '',
    describeEvents('X', [mkEv('9.01', 'Financial Statements and Exhibits', 1)]));
check('no events means nothing said', describeEvents('X', []) === '' && describeEvents('X', [mk('10-Q', 1)]) === '');

/* "What changed" means the newest change. Sorting purely by significance led
   Tesla's real answer with a director change from Nov 2025 while that
   morning's earnings release sat below it. */
check('events lead with the most RECENT, not the most severe', (() => {
    const old5 = mkEv('5.02', 'Departure of Directors', 1);      // severe, old
    const new2 = mkEv('2.02', 'Results of Operations', 22);      // less severe, today
    return describeEvents('X', [old5, new2]).indexOf('2.02') < describeEvents('X', [old5, new2]).indexOf('5.02');
})(), describeEvents('X', [mkEv('5.02', 'Departure of Directors', 1), mkEv('2.02', 'Results of Operations', 22)]));

/* The real 5.02 title is 138 characters covering four different possible
   events. Speaking one clause as if it were the whole item would assert a
   departure when it may have been an appointment. */
{
    const LONG = 'Departure of Directors or Certain Officers; Election of Directors; Appointment of Certain Officers: Compensatory Arrangements of Certain Officers';
    const s = shortItemTitle({ code: '5.02', title: LONG });
    check('a long item title is shortened for speech', s.length < 70, `${s.length}: ${s}`);
    check('the truncation is MARKED, not silently asserted', s.endsWith('…'), s);
    check('a short title is left alone',
        shortItemTitle({ code: '2.02', title: 'Results of Operations and Financial Condition' })
        === 'Results of Operations and Financial Condition');
    check('a missing title falls back to the bare code',
        shortItemTitle({ code: '8.01', title: null }) === 'item 8.01');
    /* The full wording must survive where there is room for it. */
    check('memory keeps the untruncated title',
        toMemoryText('X', { form: '8-K', accession: 'a', filedAt: '2026-07-22', items: [{ code: '5.02', title: LONG }] }).includes(LONG));
}

/* --- memory --- */
const evLine = toMemoryText('Alphabet Inc.', ek);
check('the stored memory line carries the item codes', /2\.02/.test(evLine) && /9\.01/.test(evLine), evLine);
check('the stored line carries the SEC item title', /Results of Operations/.test(evLine), evLine);
check('a filing without items stores no invented items',
    !/Items:/.test(toMemoryText('Alphabet Inc.', first)), toMemoryText('Alphabet Inc.', first));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
