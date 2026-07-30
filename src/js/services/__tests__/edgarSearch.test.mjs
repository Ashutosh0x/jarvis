// EDGAR full-text search: query building, response shaping, URL derivation.
//
// The fixture is a REAL response captured 22 Jul 2026 from
//   efts.sec.gov/LATEST/search-index?q="tokenized securities"&forms=8-K
// trimmed to two hits. The second hit is the one that matters: it has no
// ticker, which is the shape that breaks a naive display_names parser.

import {
    buildSearchUrl, parseSearchResults, parseDisplayName, parseEdgarQuery,
    documentUrl, cikPath, describeResults, toMemoryText, EDGAR_FTS,
} from '../edgarSearch.js';

let pass = 0, fail = 0;
const check = (n, c, d = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

const RESPONSE = {
    took: 75,
    timed_out: false,
    hits: {
        total: { value: 28, relation: 'eq' },
        max_score: 19.58185,
        hits: [
            {
                _index: 'edgar_file',
                _id: '0001493152-26-025606:ex99-1.htm',
                _score: 19.58185,
                _source: {
                    ciks: ['0001530766'],
                    period_ending: '2026-05-27',
                    display_names: ['Streamex Corp.  (STEX)  (CIK 0001530766)'],
                    root_forms: ['8-K'],
                    file_date: '2026-05-28',
                    biz_states: ['FL'],
                    form: '8-K',
                    adsh: '0001493152-26-025606',
                    biz_locations: ['Winter Park, FL'],
                    file_type: 'EX-99.1',
                    file_description: 'EX-99.1',
                    items: ['8.01', '9.01'],
                },
            },
            {
                _index: 'edgar_file',
                _id: '0000319655-26-000012:d8k.htm',
                _score: 12.1,
                _source: {
                    ciks: ['0000319655'],
                    // No ticker: an unlisted trust. The only parenthesised
                    // group is the CIK, which must NOT be read as a ticker.
                    display_names: ['SAN JUAN BASIN ROYALTY TRUST  (CIK 0000319655)'],
                    form: '8-K',
                    root_forms: ['8-K'],
                    file_date: '2026-07-21',
                    adsh: '0000319655-26-000012',
                    file_type: '8-K',
                    items: [],
                },
            },
        ],
    },
};

/* --- query building -------------------------------------------------------- */
{
    const u = new URL(buildSearchUrl({ q: 'tokenized securities', forms: '8-K' }));
    check('query: hits the search-index endpoint, not the HTML app',
        `${u.origin}${u.pathname}` === EDGAR_FTS && !/sec\.gov\/edgar\/search/.test(u.href), u.href);
    /* Unquoted, "tokenized securities" matches every filing containing
       "securities". Quoting is the difference between 28 hits and the whole
       corpus, so it is the default. */
    check('query: phrases are quoted by default', u.searchParams.get('q') === '"tokenized securities"', u.searchParams.get('q'));
    check('query: forms passed through', u.searchParams.get('forms') === '8-K');
    check('query: already-quoted input is not double-quoted',
        new URL(buildSearchUrl({ q: '"exact phrase"' })).searchParams.get('q') === '"exact phrase"');
    check('query: phrase can be turned off',
        new URL(buildSearchUrl({ q: 'bitcoin custody', phrase: false })).searchParams.get('q') === 'bitcoin custody');
    check('query: multiple forms are comma joined',
        new URL(buildSearchUrl({ q: 'x', forms: ['10-K', '10-Q'] })).searchParams.get('forms') === '10-K,10-Q');
    check('query: an empty term builds nothing', buildSearchUrl({ q: '   ' }) === null);

    const dated = new URL(buildSearchUrl({ q: 'x', startdt: '2026-06-01', enddt: '2026-07-22' }));
    check('query: a date range sets dateRange=custom', dated.searchParams.get('dateRange') === 'custom');
    /* A lone startdt is silently IGNORED by the API, which reads as "the filter
       worked and everything matched". Both bounds or neither. */
    check('query: a half-open range is dropped rather than half-applied',
        !new URL(buildSearchUrl({ q: 'x', startdt: '2026-06-01' })).searchParams.has('startdt'));
    check('query: term is url-encoded, not concatenated raw',
        buildSearchUrl({ q: 'AT&T merger' }).includes('AT%26T'), buildSearchUrl({ q: 'AT&T merger' }));
}

/* --- display_names parsing -------------------------------------------------- */
{
    const listed = parseDisplayName('Streamex Corp.  (STEX)  (CIK 0001530766)');
    check('names: company extracted without the parenthesised groups', listed.company === 'Streamex Corp.', listed.company);
    check('names: ticker extracted', listed.ticker === 'STEX', String(listed.ticker));
    check('names: cik extracted with padding intact', listed.cik === '0001530766', String(listed.cik));

    const unlisted = parseDisplayName('SAN JUAN BASIN ROYALTY TRUST  (CIK 0000319655)');
    check('names: a filer with no ticker reports none', unlisted.ticker === null, String(unlisted.ticker));
    check('names: the CIK group is never mistaken for a ticker', unlisted.cik === '0000319655' && unlisted.ticker === null);
    check('names: company survives when there is no ticker', unlisted.company === 'SAN JUAN BASIN ROYALTY TRUST', unlisted.company);
    check('names: junk yields nulls, not guesses', parseDisplayName('').company === null);
}

/* --- URL derivation --------------------------------------------------------- */
{
    check('cik: leading zeros stripped for the archive path', cikPath('0001530766') === '1530766');
    check('cik: an already-stripped cik is unchanged', cikPath('1530766') === '1530766');
    check('cik: non-digits are ignored', cikPath('CIK 0000319655') === '319655');

    /* This exact URL was fetched during development and returned 200 with the
       document body. The derivation is the only thing standing between a
       citation and a 404. */
    const u = documentUrl('0001530766', '0001493152-26-025606', 'ex99-1.htm');
    check('url: derived document url matches the verified form',
        u === 'https://www.sec.gov/Archives/edgar/data/1530766/000149315226025606/ex99-1.htm', u);
    /* Only the ACCESSION segment must be dash-free. An earlier version of this
       check tested the whole path and failed on "ex99-1.htm" — the filename is
       allowed to contain dashes and the code was right. */
    check('url: accession dashes removed', u.split('/')[7] === '000149315226025606', u.split('/')[7]);
    check('url: without a filename it still points at a real index page',
        documentUrl('0001530766', '0001493152-26-025606') === 'https://www.sec.gov/Archives/edgar/data/1530766/000149315226025606/');
    check('url: missing inputs yield null rather than a broken link', documentUrl(null, null) === null);
}

/* --- response parsing -------------------------------------------------------- */
{
    const p = parseSearchResults(RESPONSE);
    check('parse: total carried through', p.total === 28, `${p.total}`);
    check('parse: an exact count is not flagged as a lower bound', !p.atLeast);
    check('parse: both hits kept', p.results.length === 2, `${p.results.length}`);

    const [a, b] = p.results;
    check('parse: company and ticker', a.company === 'Streamex Corp.' && a.ticker === 'STEX');
    check('parse: form and filing date', a.form === '8-K' && a.filedAt === '2026-05-28');
    check('parse: 8-K item numbers retained', a.items.join(',') === '8.01,9.01', a.items.join(','));
    check('parse: filename recovered from _id, which is its only source',
        a.filename === 'ex99-1.htm', String(a.filename));
    check('parse: url derived per hit', a.url.endsWith('/1530766/000149315226025606/ex99-1.htm'), a.url);
    check('parse: the tickerless filer parses too', b.company === 'SAN JUAN BASIN ROYALTY TRUST' && b.ticker === null);
    check('parse: an empty items array is not an error', Array.isArray(b.items) && b.items.length === 0);

    check('parse: a JSON string is accepted as well as an object',
        parseSearchResults(JSON.stringify(RESPONSE)).results.length === 2);
    check('parse: garbage yields an empty result, never a throw',
        parseSearchResults('not json').total === 0 && parseSearchResults(null).results.length === 0);
    check('parse: limit respected', parseSearchResults(RESPONSE, { limit: 1 }).results.length === 1);

    /* EDGAR caps total at 10000 and says relation "gte". Speaking that as an
       exact count is a fabricated number. */
    const capped = parseSearchResults({ hits: { total: { value: 10000, relation: 'gte' }, hits: RESPONSE.hits.hits } });
    check('parse: a capped total is marked as a lower bound', capped.atLeast === true);
    check('parse: and is described as "at least"', /at least 10,000/.test(describeResults('x', capped)), describeResults('x', capped));

    /* A hit with no accession cannot be linked or cited, so it is dropped
       rather than reported without provenance. */
    const noAdsh = parseSearchResults({ hits: { total: { value: 1 }, hits: [{ _id: '', _source: { display_names: ['X  (CIK 0000000001)'] } }] } });
    check('parse: an unlinkable hit is dropped', noAdsh.results.length === 0);
}

/* --- spoken output ------------------------------------------------------------ */
{
    const p = parseSearchResults(RESPONSE);
    const said = describeResults('tokenized securities', p);
    check('spoken: states the count', /28 EDGAR filings mention/.test(said), said);
    check('spoken: names the filers', /Streamex Corp\./.test(said), said);
    check('spoken: dates each filing', /2026-05-28/.test(said), said);
    check('spoken: makes no claim about what the filings MEAN',
        !/because|means|suggests|implies|indicates that|bullish|bearish/i.test(said), said);
    check('spoken: an empty result says so plainly',
        /No EDGAR filings mention/.test(describeResults('zzzz', { results: [], total: 0 })));
    check('spoken: singular is not "1 filings"',
        /1 EDGAR filing mentions/.test(describeResults('x', { total: 1, results: [{ company: 'A', form: '8-K', filedAt: '2026-01-01' }] })));

    const mem = toMemoryText(p.results[0]);
    check('memory: dated, attributed, linkable', /^\[2026-05-28\] SEC EDGAR: Streamex Corp\. \(STEX\) filed 8-K/.test(mem), mem);
    check('memory: carries the document url', mem.includes('https://www.sec.gov/Archives/edgar/data/1530766/'), mem);
    check('memory: a nameless result contributes nothing', toMemoryText({ form: '8-K' }) === null);
}

/* --- spoken query parsing ------------------------------------------------------
   Input arrives from speech recognition, so the phrasings below are the ones a
   person actually says, not the ones an API doc would use. */
{
    const t = (s) => parseEdgarQuery(s);

    check('parse: "search edgar for tokenized securities"', t('search edgar for tokenized securities')?.term === 'tokenized securities', JSON.stringify(t('search edgar for tokenized securities')));
    check('parse: "search sec filings for lithium supply"', t('search sec filings for lithium supply')?.term === 'lithium supply', JSON.stringify(t('search sec filings for lithium supply')));
    check('parse: "edgar search quantum computing"', t('edgar search quantum computing')?.term === 'quantum computing', JSON.stringify(t('edgar search quantum computing')));
    check('parse: "which companies mention stablecoin in their filings"',
        t('which companies mention stablecoin in their filings')?.term === 'stablecoin', JSON.stringify(t('which companies mention stablecoin in their filings')));
    check('parse: "who filed about bitcoin custody"', t('who filed about bitcoin custody')?.term === 'bitcoin custody', JSON.stringify(t('who filed about bitcoin custody')));
    check('parse: "any filings mentioning carbon credits"',
        t('any filings mentioning carbon credits')?.term === 'carbon credits', JSON.stringify(t('any filings mentioning carbon credits')));

    // Form type lifted out of the subject rather than searched as part of it.
    const eightK = t('search edgar for 8-Ks mentioning tokenized securities');
    check('parse: form type extracted', eightK?.forms.join() === '8-K', JSON.stringify(eightK));
    check('parse: and removed from the search term', eightK?.term === 'tokenized securities', eightK?.term);
    check('parse: "annual report" maps to 10-K',
        t('search edgar for annual reports mentioning layoffs')?.forms.join() === '10-K', JSON.stringify(t('search edgar for annual reports mentioning layoffs')));
    check('parse: proxy maps to DEF 14A',
        t('search sec filings for proxy statements mentioning say on pay')?.forms.includes('DEF 14A'));

    // Recency is a flag; only the caller has a clock.
    const recent = t('search edgar for AI risk in the last month');
    check('parse: recency detected', recent?.recent === true, JSON.stringify(recent));
    check('parse: the time phrase is not searched as text', recent?.term === 'AI risk', recent?.term);

    /* THE NEGATIVE CASES. These belong to intents that already ship, and a
       parser that steals them turns a working answer into a wasted SEC request.
       "any new sec filings" is the feed brief; "sec filings" alone has no
       subject to search for. */
    check('parse: bare "search edgar" has no subject', t('search edgar') === null);
    check('parse: "any new sec filings" stays with the feed brief', t('any new sec filings') === null, JSON.stringify(t('any new sec filings')));
    check('parse: "what are the latest sec filings" is not a search', t('what are the latest sec filings') === null, JSON.stringify(t('what are the latest sec filings')));
    check('parse: an unrelated question is ignored', t('what is the weather') === null);
    check('parse: a price question is ignored', t('how much is bitcoin') === null);
    check('parse: empty input is ignored', t('') === null && t(null) === null);

    /* A filler word that is also part of a real search phrase. "say on pay" is
       a governance term people search proxy statements for; stripping "say" as
       filler left "pay" and asked EDGAR a different question. */
    check('parse: "say on pay" survives filler stripping',
        t('search edgar for proxy statements mentioning say on pay')?.term === 'say on pay',
        JSON.stringify(t('search edgar for proxy statements mentioning say on pay')));
    check('parse: and still picks up the proxy form',
        t('search edgar for proxy statements mentioning say on pay')?.forms.includes('DEF 14A'));
    /* The inflected form is still filler. Phrased with a real lead-in: an
       earlier version of this check used "any filings that says lithium",
       which has no lead-in at all and correctly returned null — the assertion
       was wrong, not the parser. */
    check('parse: inflected "says" is still stripped as filler',
        t('search edgar for filings that says lithium')?.term === 'lithium',
        JSON.stringify(t('search edgar for filings that says lithium')));

    // STT damage: the term survives even when the lead-in is mangled slightly.
    check('parse: trailing politeness stripped', t('search edgar for merger arbitrage please')?.term === 'merger arbitrage', JSON.stringify(t('search edgar for merger arbitrage please')));
    check('parse: trailing "in their filings" stripped',
        t('which companies mentioned tariffs in their filings')?.term === 'tariffs', JSON.stringify(t('which companies mentioned tariffs in their filings')));

    /* End to end through the URL builder: the parsed term must survive quoting
       and encoding into a URL the pinned handler will accept. */
    const p = t('search edgar for 10-Ks mentioning artificial intelligence in the last year');
    const url = buildSearchUrl({ q: p.term, forms: p.forms });
    check('parse: parsed query builds a valid search url',
        new URL(url).searchParams.get('q') === '"artificial intelligence"'
        && new URL(url).searchParams.get('forms') === '10-K', url);
    check('parse: and that url targets the host the ipc handler pins',
        new URL(url).hostname === 'efts.sec.gov', new URL(url).hostname);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
