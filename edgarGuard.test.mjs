// Tests for the EDGAR fetch guard.
//
// This guard sits in front of the only main-process fetcher reachable from
// spoken input, so the cases that matter are the REJECTIONS. Each one below was
// verified to defeat the naive check (`protocol === 'https:' && hostname ===
// 'efts.sec.gov'`) before the guard was written — they are demonstrated holes,
// not hypothetical ones.

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { checkEdgarUrl, EDGAR_MAX_BYTES, checkSecDocumentUrl, SEC_DOC_MAX_BYTES,
    buildCompanyFeedUrl, SEC_TICKERS_URL } = require('./edgarGuard');

let pass = 0, fail = 0;
const check = (n, c, d = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

const ok = (u) => checkEdgarUrl(u).ok;
const err = (u) => checkEdgarUrl(u).error;

/* --- what must be allowed ---------------------------------------------------
   A guard that rejects the real endpoint is a guard nobody keeps. */
{
    const real = 'https://efts.sec.gov/LATEST/search-index?q=%22tokenized+securities%22&forms=8-K';
    check('allows the real search endpoint', ok(real));
    check('allows a date-filtered query',
        ok('https://efts.sec.gov/LATEST/search-index?q=%22x%22&dateRange=custom&startdt=2026-01-01&enddt=2026-07-22'));
    check('allows an explicit :443', ok('https://efts.sec.gov:443/LATEST/search-index?q=x'));
    check('returns the PARSED href, not the caller string',
        checkEdgarUrl(real).url === new URL(real).href);
}

/* --- the demonstrated bypasses ---------------------------------------------- */
{
    /* A port is not part of the hostname. This exact URL passes a check written
       as `u.hostname === 'efts.sec.gov'`, which is how the handler shipped
       before this file existed. */
    check('rejects an explicit non-443 port', !ok('https://efts.sec.gov:8443/LATEST/search-index?q=x'),
        err('https://efts.sec.gov:8443/LATEST/search-index?q=x'));
    check('rejects credentials in the authority', !ok('https://evil.tld@efts.sec.gov/LATEST/search-index?q=x'),
        err('https://evil.tld@efts.sec.gov/LATEST/search-index?q=x'));
    check('rejects a lookalike host', !ok('https://efts.sec.gov.evil.tld/LATEST/search-index?q=x'));
    check('rejects a subdomain of the pinned host', !ok('https://a.efts.sec.gov/LATEST/search-index?q=x'));
    check('rejects sec.gov itself', !ok('https://www.sec.gov/LATEST/search-index?q=x'));
    check('rejects plain http', !ok('http://efts.sec.gov/LATEST/search-index?q=x'), err('http://efts.sec.gov/LATEST/search-index?q=x'));
    check('rejects file://', !ok('file:///C:/Users/ashut/.ssh/id_rsa'));
    check('rejects a loopback target', !ok('https://127.0.0.1/LATEST/search-index?q=x'));
    check('rejects link-local metadata', !ok('https://169.254.169.254/LATEST/search-index?q=x'));
    check('rejects another path on the pinned host', !ok('https://efts.sec.gov/admin?q=x'), err('https://efts.sec.gov/admin?q=x'));
    check('rejects a path that merely contains the allowed prefix later',
        !ok('https://efts.sec.gov/evil/LATEST/search-index?q=x'));
    check('rejects an over-long url', !ok('https://efts.sec.gov/LATEST/search-index?q=' + 'a'.repeat(2100)),
        err('https://efts.sec.gov/LATEST/search-index?q=' + 'a'.repeat(2100)));
}

/* --- junk input ------------------------------------------------------------- */
{
    check('rejects a non-url', !ok('not a url'));
    check('rejects empty', !ok('') && !ok(null) && !ok(undefined));
    check('rejects an object', !ok({ href: 'https://efts.sec.gov/LATEST/search-index' }));
    check('never throws on hostile input', (() => {
        for (const v of [null, undefined, 0, {}, [], 'https://', '://x', '\\\\server\\share']) {
            try { checkEdgarUrl(v); } catch { return false; }
        }
        return true;
    })());
    check('every rejection states a reason',
        ['http://efts.sec.gov/LATEST/search-index', 'https://x.tld/', 'nope', 'https://efts.sec.gov/admin']
            .every(u => typeof err(u) === 'string' && err(u).length > 3));
}

/* --- the response ceiling ---------------------------------------------------- */
{
    /* The largest response observed in development was ~90KB; the ceiling is
       well above that and well below anything that would strain the main
       process. It exists because Content-Length is a claim, and an unbounded
       read in the main process is a memory-exhaustion path. */
    check('response ceiling is defined and sane',
        EDGAR_MAX_BYTES >= 1024 * 1024 && EDGAR_MAX_BYTES <= 16 * 1024 * 1024, `${EDGAR_MAX_BYTES}`);
}

/* --- the document fetcher ------------------------------------------------------
   Different host, same three bypasses. The archive is where filing BODIES live
   and is the stage whose absence caused the 22 Jul fabrication. */
{
  const okd = (u) => checkSecDocumentUrl(u).ok;
  const errd = (u) => checkSecDocumentUrl(u).error;
  const REAL = 'https://www.sec.gov/Archives/edgar/data/886982/000119312526310059/gs-20260721.htm';
  check('doc: allows the real filing body', okd(REAL));
  check('doc: allows the filing index json', okd('https://www.sec.gov/Archives/edgar/data/886982/000119312526310059/index.json'));
  check('doc: rejects a non-443 port', !okd('https://www.sec.gov:8443/Archives/edgar/data/1/2/x.htm'), errd('https://www.sec.gov:8443/Archives/edgar/data/1/2/x.htm'));
  check('doc: rejects credentials', !okd('https://evil.tld@www.sec.gov/Archives/edgar/data/1/2/x.htm'));
  check('doc: rejects http', !okd('http://www.sec.gov/Archives/edgar/data/1/2/x.htm'));
  check('doc: rejects another sec.gov path', !okd('https://www.sec.gov/cgi-bin/browse-edgar?action=x'), errd('https://www.sec.gov/cgi-bin/browse-edgar?action=x'));
  check('doc: rejects a lookalike host', !okd('https://www.sec.gov.evil.tld/Archives/edgar/data/1/2/x.htm'));
  /* The complete-submission .txt is every exhibit concatenated, megabytes of
     duplicate text with no added prose. */
  check('doc: rejects the complete-submission text file', !okd('https://www.sec.gov/Archives/edgar/data/886982/000119312526310059/0001193125-26-310059.txt'), errd('https://www.sec.gov/Archives/edgar/data/886982/000119312526310059/0001193125-26-310059.txt'));
  check('doc: rejects junk without throwing', !okd('nope') && !okd(null));
  check('doc: ceiling allows a real 354KB filing', SEC_DOC_MAX_BYTES > 354829);
}

/* --- the per-company feed URL ---------------------------------------------------
   This one BUILDS rather than checks, which is the stronger position: no
   caller-supplied string survives into the result, so the tests are about what
   gets past the primitive validation rather than about URL-parser edge cases.
   A spoken company name reaches the network here as at most ten digits. */
{
  const built = (o) => buildCompanyFeedUrl(o);
  const url = (o) => built(o).url || '';

  check('feed: builds the real endpoint for Alphabet', (() => {
    const u = url({ cik: '0001652044' });
    return u.startsWith('https://www.sec.gov/cgi-bin/browse-edgar?')
      && u.includes('CIK=0001652044') && u.includes('output=atom');
  })(), url({ cik: '0001652044' }));

  check('feed: pads a short CIK to ten digits', url({ cik: 320193 }).includes('CIK=0000320193'));
  check('feed: accepts an allowed form', url({ cik: 1652044, type: '10-K' }).includes('type=10-K'));
  check('feed: lower-case form is normalised', url({ cik: 1652044, type: '10-k' }).includes('type=10-K'));

  /* Everything below reaches this function from a spoken sentence. */
  check('feed: rejects an unknown form rather than passing it through',
    !built({ cik: 1652044, type: 'DROP TABLE' }).ok, built({ cik: 1652044, type: 'DROP TABLE' }).error);
  check('feed: strips non-digits from the CIK instead of trusting it', (() => {
    const u = url({ cik: '1652044&foo=bar' });
    return !u.includes('foo=bar') && u.includes('CIK=0001652044');
  })(), url({ cik: '1652044&foo=bar' }));
  check('feed: rejects an over-long CIK', !built({ cik: '12345678901' }).ok);
  check('feed: rejects a missing CIK', !built({}).ok && !built({ cik: 'abc' }).ok);
  check('feed: rejects junk without throwing', !built(null).ok && !built(undefined).ok);

  /* `count` is clamped, not trusted — and it does not work anyway: EDGAR
     returned ten entries for a count=3 request, measured 24 Jul 2026. */
  check('feed: count is clamped low', url({ cik: 1, count: -5 }).includes('count=10'));
  check('feed: count is clamped high', url({ cik: 1, count: 100000 }).includes('count=100'));
  check('feed: a non-numeric count falls back', url({ cik: 1, count: 'lots' }).includes('count=40'));

  /* The ticker map has no parameters at all, so it is a constant rather than
     anything a call site could vary. */
  check('feed: the ticker map URL is fixed and on sec.gov',
    SEC_TICKERS_URL === 'https://www.sec.gov/files/company_tickers.json');
}




/* --- path prefix boundary ---------------------------------------------------
   startsWith('/LATEST/search-index') also accepts '/LATEST/search-indexes-…',
   a different route on the pinned host. The prefix has to end the segment. */
check('path: the pinned path itself is allowed',
    ok('https://efts.sec.gov/LATEST/search-index?q=test'));
check('path: a deeper path under it is allowed',
    ok('https://efts.sec.gov/LATEST/search-index/sub?q=test'));
check('path: a sibling route sharing the prefix is refused',
    !ok('https://efts.sec.gov/LATEST/search-indexes-elsewhere?q=test'),
    err('https://efts.sec.gov/LATEST/search-indexes-elsewhere?q=test'));

/* --- holdings forms ---------------------------------------------------------
   A passive stake over 5% is filed on SC 13G, not 13D, which is how the largest
   index managers hold nearly everything they hold. Its absence made the biggest
   holders in the market unreachable. */
{
    const formOk = (t) => buildCompanyFeedUrl({ cik: '1652044', type: t }).ok;
    check('forms: SC 13G (passive >5% stake) is reachable', formOk('SC 13G'));
    check('forms: SC 13D (activist stake) still reachable', formOk('SC 13D'));
    check('forms: Form 3 (initial insider statement) is reachable', formOk('3'));
    check('forms: Form 5 (annual insider catch-up) is reachable', formOk('5'));
    check('forms: 13F-HR still reachable', formOk('13F-HR'));
    check('forms: lower case is normalised', formOk('sc 13g'));
    check('forms: an unknown form is still refused', !formOk('NOT-A-FORM'));
    check('forms: the form lands in the query string',
        buildCompanyFeedUrl({ cik: '1652044', type: 'SC 13G' }).url.includes('type=SC+13G'));
}

/* --- disclosure venues -------------------------------------------------------
   EDGAR is one venue among several. These entries exist so "show me CXMT's
   filings" gets the real answer instead of "no SEC filings", which is true and
   useless.

   The CXMT case is the reason each entry carries a checked-on date: the first
   version of this registry asserted CXMT was privately held, and it listed on
   the Shanghai STAR Market three days later. */
{
    const { disclosureVenue, DISCLOSURE_VENUES } = require('./edgarGuard');

    const cxmt = disclosureVenue('CXMT');
    check('venues: CXMT resolves', !!cxmt);
    check('venues: CXMT is no longer described as private',
        !/private/i.test(cxmt.venue) && !/private/i.test(cxmt.how || ''), cxmt.venue);
    check('venues: CXMT points at the Shanghai STAR Market', /STAR/i.test(cxmt.venue), cxmt.venue);
    check('venues: CXMT carries the ticker its prices come from', cxmt.ticker === '688825.SS', cxmt.ticker);
    check('venues: CXMT is still not an SEC registrant', cxmt.secRegistrant === false);
    check('venues: CXMT records when it listed', cxmt.listedSince === '2026-07-27', cxmt.listedSince);

    const ymtc = disclosureVenue('YMTC');
    check('venues: YMTC is the genuinely unlisted case', /none/i.test(ymtc.venue) && ymtc.ticker === null);

    const sam = disclosureVenue('SAMSUNG');
    check('venues: Samsung points at DART, not at the SEC',
        /DART/i.test(sam.venue) && sam.secRegistrant === false);
    check('venues: Samsung carries its Seoul ticker', sam.ticker === '005930.KS');
    check('venues: the DART key requirement is stated up front', /key/i.test(sam.how));

    const skhy = disclosureVenue('SKHY');
    check('venues: SK hynix is recorded as filing in BOTH places',
        skhy.secRegistrant === true && /DART/i.test(skhy.venue), skhy.venue);
    check('venues: SK hynix carries its CIK', skhy.cik === '2120882');
    check('venues: the wrong ADR ticker is redirected, not silently accepted',
        /SKHY/.test(disclosureVenue('SKHYY').venue));

    check('venues: an ordinary registrant has no entry, which is not the same as no filings',
        disclosureVenue('MU') === null && disclosureVenue('AAPL') === null);
    check('venues: empty input is safe', disclosureVenue('') === null && disclosureVenue(null) === null);
    check('venues: every entry records when it was checked',
        Object.values(DISCLOSURE_VENUES).every((v) => /^\d{4}-\d{2}-\d{2}$/.test(v.checked)));
    check('venues: every entry names a venue and how to reach it',
        Object.values(DISCLOSURE_VENUES).every((v) => v.venue && v.how));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
