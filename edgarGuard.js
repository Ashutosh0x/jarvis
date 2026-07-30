/**
 * EDGAR fetch guard — the allow-check for the one main-process fetcher that
 * voice input can reach.
 *
 * CJS and at the repo root, like metricStore.js, for one reason: electron.js is
 * CommonJS and cannot import an ES module from src/js/services. Duplicating the
 * check inside electron.js would work and would drift; a single implementation
 * that both the main process and a test can load is worth the odd placement.
 *
 * WHY THIS IS NOT JUST A HOSTNAME COMPARISON. The URL is built by the renderer
 * from a spoken phrase, so this is a fetcher reachable by anyone who can speak
 * near the machine, or by any injection into the renderer. Every rejection
 * below was demonstrated against the naive `protocol === 'https:' &&
 * hostname === 'efts.sec.gov'` check before it was written:
 *
 *   * A PORT IS NOT PART OF THE HOSTNAME. `https://efts.sec.gov:8443/x` passes
 *     an origin check by hostname and reaches an arbitrary listener.
 *   * CREDENTIALS IN THE AUTHORITY. `https://evil.tld@efts.sec.gov/` is
 *     harmless to a correct URL parser and has historically not been to
 *     everything that touches the string afterwards; there is no legitimate
 *     reason for this endpoint to carry credentials, so it is refused.
 *   * PATH. Pinning the host but not the path leaves every other route on it
 *     reachable.
 *
 * Redirect handling is NOT here because it cannot be: a redirect is discovered
 * at fetch time. The caller passes `redirect: 'error'`, which is the only way
 * to stop the server itself from moving the request off the pinned host.
 */

const EDGAR_HOST = 'efts.sec.gov';
const EDGAR_PATH = '/LATEST/search-index';
const MAX_URL_LENGTH = 2048;

/** @returns {{ok: true, url: string} | {ok: false, error: string}} */
function checkEdgarUrl(raw) {
    let u;
    try { u = new URL(String(raw || '')); } catch { return { ok: false, error: 'not a url' }; }

    if (u.protocol !== 'https:') return { ok: false, error: 'https only' };
    if (u.hostname !== EDGAR_HOST) return { ok: false, error: 'host not allowed' };
    // '' is the scheme default (443). Anything explicit is refused.
    if (u.port && u.port !== '443') return { ok: false, error: 'port not allowed' };
    if (u.username || u.password) return { ok: false, error: 'credentials not allowed' };
    /* startsWith alone has no boundary: '/LATEST/search-indexes-elsewhere' is a
       different route that passes a bare prefix test. The pinned path must end
       the segment or be followed by one. */
    if (u.pathname !== EDGAR_PATH && !u.pathname.startsWith(`${EDGAR_PATH}/`)) {
        return { ok: false, error: 'path not allowed' };
    }
    if (u.href.length > MAX_URL_LENGTH) return { ok: false, error: 'url too long' };

    /* Return the PARSED href, never the caller's string. Anything the parser
       normalised away cannot then be re-interpreted differently downstream. */
    return { ok: true, url: u.href };
}

/**
 * Guard for fetching a filing BODY out of the EDGAR archive.
 *
 * Separate from checkEdgarUrl because it is a different host with a different
 * shape: documents live on www.sec.gov under /Archives/edgar/data/. The same
 * three bypasses apply (port, credentials, path), and the size ceiling is much
 * higher because a real filing is large — the Goldman 424B2 measured on
 * 22 Jul 2026 is 354KB of HTML.
 */
const SEC_DOC_HOST = 'www.sec.gov';
const SEC_DOC_PATH = '/Archives/edgar/data/';

function checkSecDocumentUrl(raw) {
    let u;
    try { u = new URL(String(raw || '')); } catch { return { ok: false, error: 'not a url' }; }
    if (u.protocol !== 'https:') return { ok: false, error: 'https only' };
    if (u.hostname !== SEC_DOC_HOST) return { ok: false, error: 'host not allowed' };
    if (u.port && u.port !== '443') return { ok: false, error: 'port not allowed' };
    if (u.username || u.password) return { ok: false, error: 'credentials not allowed' };
    if (!u.pathname.startsWith(SEC_DOC_PATH)) return { ok: false, error: 'path not allowed' };
    /* Only documents and the filing index. The complete-submission .txt is
       every exhibit concatenated and runs to megabytes for no added prose. */
    if (!/\.(html?|json)$/i.test(u.pathname)) return { ok: false, error: 'only html or json documents' };
    if (u.href.length > MAX_URL_LENGTH) return { ok: false, error: 'url too long' };
    return { ok: true, url: u.href };
}

/**
 * Per-company filings feed — BUILT here, not checked here.
 *
 * The other two guards take a URL the renderer composed and decide whether to
 * allow it. This one takes primitives and composes the URL itself, which is
 * strictly stronger: there is no attacker-controlled string in the result at
 * all, so there is nothing to normalise, smuggle or re-interpret. A spoken
 * company name reaches this function as at most ten digits.
 *
 * `count` is passed because the endpoint accepts it, NOT because it works:
 * requesting 3 returns ten entries, measured 24 Jul 2026. The caller slices.
 *
 * `type` is prefix-matched by EDGAR, so '10-K' also returns 10-K/A. Restricted
 * to an allow-list anyway: it lands in a query string, and a form type is a
 * closed vocabulary, so there is no reason to accept free text.
 */
const SEC_BROWSE_HOST = 'www.sec.gov';
/* EDGAR prefix-matches the type, so 'SC 13D' already reaches 'SC 13D/A' and
   '13F-HR' reaches '13F-HR/A'; the amendments do not need their own entries.
   'SC 13G' does, and its absence was a real hole for holdings questions: an
   activist stake is filed on 13D, but a PASSIVE stake over 5% — which is how
   Vanguard, BlackRock and State Street hold most of what they hold — is filed
   on 13G, so the largest holders in the market were unreachable. Forms 3 and 5
   join 4 for the same reason: 4 is the ongoing insider trade, 3 the initial
   statement and 5 the annual catch-up. */
const ALLOWED_FORMS = new Set([
    '8-K', '10-K', '10-Q', 'S-1', 'DEF 14A', '6-K', '20-F', '13F-HR',
    '3', '4', '5', 'SC 13D', 'SC 13G', '424B2', '424B5',
    /* LISTING AND OFFERING EVENTS. Added after a live run against the memory
       sector on 30 Jul 2026 found the biggest structural event of the month
       unreachable: SK hynix registered on a US exchange on 2026-07-09 and the
       whole trail — 8-A12B (Section 12(b) registration), CERT (exchange
       certification), EFFECT (registration effective), then 424B4 (the final
       prospectus, which is where the financials are) — was filtered out,
       because the list only held periodic and ownership forms. A foreign issuer
       arriving on a US exchange files none of those first.
       424B1/B3/B4 join B2/B5 for the same reason: the suffix is the pricing
       flavour, not a different kind of document. */
    '424B1', '424B3', '424B4', '8-A12B', '8-A12G', 'CERT', 'EFFECT',
    'F-1', 'F-4', 'S-4', '25-NSE',
    /* Observed repeatedly on both Micron and Sandisk feeds and previously
       unreachable: notice of a proposed insider sale. Form 4 reports the trade
       after it happens; 144 is the intent before it does. */
    '144',
]);

/* ---------------------------------------------------------------------------
   ISSUERS THAT DO NOT FILE WITH THE SEC.

   Verified against company_tickers.json (10,432 registrants) on 30 Jul 2026:
   ChangXin Memory (CXMT) and Samsung Electronics have NO SEC registrant at all,
   and 'SKHYY' — the ADR ticker most sources print for SK hynix — is absent even
   though SK hynix itself now files under CIK 2120882 as SKHY/HXSCL.

   Returning "no filings" for these is true but useless, and inviting a model to
   fill the silence is how a plausible fabrication gets spoken aloud. Naming the
   real disclosure venue is the honest answer to "show me CXMT's filings".
--------------------------------------------------------------------------- */
const NON_SEC_ISSUERS = {
    CXMT: {
        name: 'ChangXin Memory Technologies',
        why: 'a private Chinese DRAM maker with no US listing',
        disclosure: 'Chinese regulatory filings and its STAR Market listing process; no EDGAR presence',
    },
    SAMSUNG: {
        name: 'Samsung Electronics',
        why: 'listed in Seoul (005930.KS), not registered with the SEC',
        disclosure: 'KRX/DART filings in Korea',
    },
    SKHYY: {
        name: 'SK hynix',
        why: 'this ADR ticker is not the SEC registrant',
        disclosure: 'SK hynix files under CIK 2120882 — use SKHY or HXSCL',
    },
};

/** @returns {{name, why, disclosure}|null} */
function nonSecIssuer(symbolOrName) {
    const k = String(symbolOrName || '').trim().toUpperCase();
    if (!k) return null;
    if (NON_SEC_ISSUERS[k]) return NON_SEC_ISSUERS[k];
    for (const [key, v] of Object.entries(NON_SEC_ISSUERS)) {
        if (k.includes(key) || v.name.toUpperCase().includes(k)) return v;
    }
    return null;
}

/** @returns {{ok: true, url: string} | {ok: false, error: string}} */
function buildCompanyFeedUrl(opts) {
    /* Destructuring with a `= {}` default covers undefined and NOT null, and
       this is called with whatever the IPC message carried — so `null` threw a
       TypeError in the main process rather than returning a rejection. Caught
       by the test below, which is the only reason it is not a crash path. */
    const { cik, type = '', count = 40 } = (opts && typeof opts === 'object') ? opts : {};
    const digits = String(cik ?? '').replace(/\D/g, '');
    if (!digits) return { ok: false, error: 'cik required' };
    if (digits.length > 10) return { ok: false, error: 'cik too long' };
    const padded = digits.padStart(10, '0');

    const form = String(type || '').trim().toUpperCase();
    if (form && !ALLOWED_FORMS.has(form)) return { ok: false, error: `form ${form} not allowed` };

    const n = Number(count);
    const safeCount = Number.isFinite(n) ? Math.min(100, Math.max(10, Math.trunc(n))) : 40;

    const params = new URLSearchParams({
        action: 'getcompany',
        CIK: padded,
        type: form,
        dateb: '',
        owner: 'include',
        count: String(safeCount),
        output: 'atom',
    });
    return { ok: true, url: `https://${SEC_BROWSE_HOST}/cgi-bin/browse-edgar?${params.toString()}` };
}

/* The ticker/CIK map. A fixed URL with no parameters: exported as a constant
   rather than built, so there is no call site that could vary it. */
const SEC_TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';

module.exports = {
    checkEdgarUrl, EDGAR_HOST, EDGAR_PATH, MAX_URL_LENGTH,
    EDGAR_MAX_BYTES: 4 * 1024 * 1024,
    checkSecDocumentUrl, SEC_DOC_HOST, SEC_DOC_PATH,
    SEC_DOC_MAX_BYTES: 12 * 1024 * 1024,
    buildCompanyFeedUrl, SEC_BROWSE_HOST, ALLOWED_FORMS,
    NON_SEC_ISSUERS, nonSecIssuer,
    SEC_TICKERS_URL, SEC_TICKERS_MAX_BYTES: 4 * 1024 * 1024,
};
