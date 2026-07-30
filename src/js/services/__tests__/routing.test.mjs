// Intent-routing tests that drive the REAL parser out of jarvis.js.
//
// Why this file exists: every routing bug found so far (whale "alerts" plural,
// "usdc burns" plural, "watch for whales" stolen by the price watchlist,
// "ON" matching the word "on") was invisible to unit tests of the pure service
// modules, because the bug is in the ORDER and the WORDING of the parsers that
// live in jarvis.js. Those turn into a fabricated answer from the model, which
// is the worst failure this project has.
//
// jarvis.js is a browser module, so the DOM/audio globals it touches at import
// time are stubbed. Nothing here is a copy of a regex: a failing case here is a
// failing case in the shipped code.

globalThis.window = { addEventListener() {}, electronAPI: {}, localStorage: { getItem: () => null, setItem() {} } };
globalThis.document = {
    addEventListener() {}, getElementById: () => null, querySelector: () => null,
    querySelectorAll: () => [], createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {} }),
    body: { classList: { add() {}, remove() {}, contains: () => false } },
};
globalThis.localStorage = globalThis.window.localStorage;
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node', mediaDevices: {} }, configurable: true });
globalThis.speechSynthesis = { getVoices: () => [], cancel() {}, speak() {} };
globalThis.SpeechSynthesisUtterance = class {};
globalThis.AudioContext = class {};
globalThis.AudioWorkletProcessor = class {};
globalThis.registerProcessor = () => {};
globalThis.sampleRate = 48000;
globalThis.fetch = async () => ({ ok: false, json: async () => ({}) });

const mod = await import('../../jarvis.js');
const Cls = mod.default || Object.values(mod).find(v => typeof v === 'function' && v.prototype?.parseOnchainQuery);

let pass = 0, fail = 0;
const check = (n, c) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); };

if (!Cls) {
    check('jarvis.js exports a class with parseOnchainQuery', false);
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(1);
}
const parse = Cls.prototype.parseOnchainQuery.bind({});
const routes = (text, expected) => {
    let got;
    try { got = parse(text)?.kind ?? null; } catch (e) { got = `THREW ${e.message}`; }
    check(`"${text}" -> ${expected === null ? 'falls through' : expected}${got === expected ? '' : ` (GOT ${got})`}`, got === expected);
};

/* --- the verbatim failure from the interaction log ---------------------------
   "give me whale alerts of solana" reached the model, which then reported
   starting a search, reported it complete, and reported no results. */
routes('give me whale alerts of solana', 'whale-unsupported');
routes('bitcoin whale alerts', 'whale-unsupported');
routes('any whales on polygon', 'whale-unsupported');

/* --- whale stream control --------------------------------------------------- */
routes('whale alerts', 'whale-stream');
routes('show me whale alerts', 'whale-stream');
routes('watch for whales', 'whale-stream');
routes('stop whale alerts', 'whale-stream');
routes('whale status', 'whale-stream');
routes('whale activity today', 'whale-summary');
routes('whale transfers in dollars', 'whale-usd');
routes('whales in the last hour', 'whale-window');
routes('whale summary for the last 5 minutes', 'whale-window');

/* --- stablecoin issuance ------------------------------------------------------ */
routes('did circle mint any usdc', 'issuance');
routes('any big usdc burns', 'issuance');
routes('usdt minting activity', 'issuance');
routes('stablecoin supply on solana', 'solana-supply');
routes('usdc supply on solana', 'solana-supply');

/* --- must NOT be stolen -------------------------------------------------------
   Each of these has its own handler elsewhere; a greedy chain parser breaks
   features that already work. */
routes('price of apple', null);
routes('analyze tesla', null);
routes('supply of tokenized apple', 'ondo-supply');
routes('how many aaplon exist', 'ondo-supply');
routes('what is the mint condition of my car', null);
routes('gas on arbitrum', 'gas');
routes('who is vitalik.eth', 'whois');
routes('balance of 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', 'balance');
routes('portfolio of vitalik.eth', 'portfolio');

/* --- prediction markets --------------------------------------------------------
   "What are the odds bitcoin hits 200k" must NOT become a spot-price query:
   the market's probability and the coin's price are different answers to
   different questions. */
routes('what are the odds of a fed rate cut', 'prediction-search');
routes('polymarket odds on the election', 'prediction-search');
routes('kalshi markets for inflation', 'prediction-search');
routes('show me trending prediction markets', 'prediction-trending');
routes('what are the most active prediction markets', 'prediction-trending');
routes('compare polymarket and kalshi on the fed decision', 'prediction-compare');
routes('what are the chances of a recession', 'prediction-search');
routes('prediction market for the world cup', 'prediction-search');
// Must not be stolen by the prediction parser:
routes('price of bitcoin', null);
routes('gas on ethereum', 'gas');
routes('balance of vitalik.eth', 'balance');

/* --- provider capability + solana reads --------------------------------------- */
routes('which chains can you read', 'chain-capabilities');
routes('solana wallet vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg', 'solana-assets');
routes('recent solana activity for vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg', 'solana-activity');
// Base58 is not self-identifying — without the chain named, this is not a
// Solana address, it is a word.
routes('remind me about vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg', null);

/* --- a pasted document is not a command --------------------------------------
   From the log: a Chrome release announcement was pasted three times and each
   time answered "Your phone is not linked, Sir", because the text contained the
   word Android. Every action matcher scans for keywords, so a long document
   will always contain some — the length and shape are what distinguish a
   command from material to read. detectIntent owns this, so it is driven here
   rather than through parseOnchainQuery. */
{
    const detect = Cls.prototype.detectIntent;
    // Minimal `this`: detectIntent reaches for a few helpers on the way past.
    /* Built FROM the prototype, not a hand-listed stub: detectIntent calls a
       dozen helpers on the way past, and a partial stub fails with "is not a
       function" on whichever one is added next. */
    const ctx = Object.create(Cls.prototype);
    ctx.settings = { get: () => null };
    ctx._lastNewsSubject = null;
    const intentOf = (text) => { try { return detect.call(ctx, text)?.intent ?? null; } catch (e) { return `THREW ${e.message}`; } };

    const pastedRelease = `Chrome Releases Release updates from the Chrome team Chrome Beta for iOS Update Tuesday, July 21, 2026 Hi everyone! We've just released Chrome Beta 151 (151.0.7922.43) for iOS; it'll become available on App Store in the next few days. You can see a partial list of the changes in the Git log. If you find a new issue, please let us know by filing a bug. Chrome Release Team`;
    check('pasted document does not become a phone command',
        intentOf(pastedRelease) === 'AI_COMMAND', String(intentOf(pastedRelease)));

    const multiline = 'CVE-2026-15899 Critical CameraCapture\nCVE-2026-15900 Critical GPU\nCVE-2026-15901 Critical Network';
    check('a multi-line paste is treated as material, not a command',
        intentOf(multiline) === 'AI_COMMAND', String(intentOf(multiline)));

    // Real commands must still work — the guard must not swallow short input.
    check('a short command is unaffected', intentOf('open chrome') === 'OPEN_APP', String(intentOf('open chrome')));
    check('a phone command still routes to the phone',
        intentOf('turn on the flashlight on my phone') === 'PHONE_TOOL', String(intentOf('turn on the flashlight on my phone')));
}

/* --- feed brief vs news -------------------------------------------------------
   "brief me" reads the ingested event log with provenance; "news about X" is a
   fresh headline scrape. Different answers, so the router must not conflate
   them. */
{
    const detect = Cls.prototype.detectIntent;
    /* Built FROM the prototype, not a hand-listed stub: detectIntent calls a
       dozen helpers on the way past, and a partial stub fails with "is not a
       function" on whichever one is added next. */
    const ctx = Object.create(Cls.prototype);
    ctx.settings = { get: () => null };
    ctx._lastNewsSubject = null;
    const intentOf = (t) => { try { return detect.call(ctx, t)?.intent ?? null; } catch (e) { return `THREW ${e.message}`; } };

    check('"brief me" reads the feed log', intentOf('brief me') === 'FEED_BRIEF', String(intentOf('brief me')));
    check('"what changed today" is a brief', intentOf('what changed today') === 'FEED_BRIEF');
    check('"anything new" is a brief', intentOf('anything new') === 'FEED_BRIEF');
    check('"what did i miss" is a brief', intentOf('what did i miss') === 'FEED_BRIEF');
    check('a week-long brief is recognised', (() => {
        const i = detect.call(ctx, 'brief me on the week');
        return i?.intent === 'FEED_BRIEF' && i.hours === 168;
    })());
    // Must not steal the existing news path.
    check('"news about tesla" still routes to news', intentOf('news about tesla') === 'NEWS_QUERY', String(intentOf('news about tesla')));
    check('"latest news" still routes to news', intentOf('latest news') === 'NEWS_QUERY');
}

/* --- regressions found by the 1000-prompt harness -----------------------------
   Five misroutes surfaced in 88ms that months of hand-written cases had not.
   Each is pinned here so it cannot come back. */
{
    const ctx = Object.create(Cls.prototype);
    ctx.settings = { get: () => null };
    ctx._lastNewsSubject = null;
    const intentOf = (t) => { try { return ctx.detectIntent(t)?.intent ?? null; } catch (e) { return `THREW ${e.message}`; } };

    // 46 finance questions were answered with CPU and RAM statistics.
    check('"what\'s happening with nvidia" is news, not a system report',
        intentOf("what's happening with nvidia") === 'NEWS_QUERY', String(intentOf("what's happening with nvidia")));
    check('a bare "what\'s happening" is still the system report',
        intentOf("what's happening") === 'SYS_OVERVIEW', String(intentOf("what's happening")));
    check('"what\'s happening on my machine" is still the system report',
        intentOf("what's happening on my machine") === 'SYS_OVERVIEW');

    // 50 fell through to the model, which answered from training data.
    check('"latest on ethereum" is a news query',
        intentOf('latest on ethereum') === 'NEWS_QUERY', String(intentOf('latest on ethereum')));
    check('"any update on tesla" is a news query',
        intentOf('any update on tesla') === 'NEWS_QUERY', String(intentOf('any update on tesla')));

    // BSC is one of the four chains the key verifies, yet gas fell through.
    check('"gas on bsc" reaches the chain reader',
        intentOf('gas on bsc') === 'CHAIN_QUERY', String(intentOf('gas on bsc')));
    check('"gas on bnb chain" too', intentOf('gas on bnb chain') === 'CHAIN_QUERY');

    // "google" is a verb AND a company; the remainder decides which.
    check('"google stock price" quotes the company, does not type a search',
        intentOf('google stock price') === 'PRICE_QUERY', String(intentOf('google stock price')));
    /* Now Jarvis's OWN search, not a keystroke macro. This previously expected
       TYPE_TEXT — "type it into whatever window is focused and press Enter" —
       which is why every "search ..." in the interaction log was dictated
       somewhere instead of answered. */
    check('"google quantum computing" is Jarvis\'s own web search',
        intentOf('google quantum computing') === 'WEB_SEARCH', String(intentOf('google quantum computing')));
    check('a bare question is a web search too',
        intentOf('what is rayleigh scattering') === 'WEB_SEARCH', String(intentOf('what is rayleigh scattering')));
    check('"google stock price" still quotes the company',
        intentOf('google stock price') === 'PRICE_QUERY', String(intentOf('google stock price')));

    /* Routing ambiguities worth pinning, because each one is a phrase that
       previously went somewhere useless. Asking is a search whether or not the
       user says the word "search". */
    for (const phrase of [
        'search quantum computing',
        'look up quantum computing',
        'find information about quantum computing',
        'find Rust ownership',
        'search Nvidia Blackwell',
        'who is Jensen Huang',
        'who founded Google',
        'what is Rust',
    ]) {
        check(`"${phrase}" is a web search`,
            intentOf(phrase) === 'WEB_SEARCH', String(intentOf(phrase)));
    }

    // Only "type"/"dictate" produce keystrokes now.
    check('"type search Nvidia" still dictates',
        intentOf('type search Nvidia') === 'TYPE_TEXT', String(intentOf('type search Nvidia')));
    check('"dictate hello world" still dictates',
        intentOf('dictate hello world') === 'TYPE_TEXT', String(intentOf('dictate hello world')));
    check('"open Chrome" is still an app launch',
        intentOf('open Chrome') === 'OPEN_APP', String(intentOf('open Chrome')));
    check('"latest AI news" stays on the RSS path',
        intentOf('latest AI news') === 'NEWS_QUERY', String(intentOf('latest AI news')));

    /* The user's own data is not on the web. This router runs BEFORE
       SEARCH_FILE, so without the local-scope guard "search my files" was
       answered by Wikipedia. The guard lived in inputControl.js and was lost
       when that branch was removed. */
    for (const phrase of ['search my files', 'search my notes', 'look up my bookmarks',
                          'find my downloads', 'search my history']) {
        check(`"${phrase}" is NOT sent to the web`,
            intentOf(phrase) !== 'WEB_SEARCH', String(intentOf(phrase)));
    }
}

/* --- pronouns in news queries ------------------------------------------------
   "yesterdays news about him" searched for the literal word "him" and returned
   three unrelated stories that happened to contain it. */
{
    const ctx = Object.assign(Object.create(Cls.prototype), { _lastNewsSubject: null });
    const parse = Cls.prototype.parseNewsQuery.bind(ctx);

    check('a real subject is captured', parse('news about elon musk')?.topic === 'elon musk');
    check('a following pronoun resolves to that subject', parse('news about him')?.topic === 'elon musk');
    check('the subject persists across a rephrase', parse("what's the latest on him")?.topic === 'elon musk');

    const fresh = Object.assign(Object.create(Cls.prototype), { _lastNewsSubject: null });
    const parseFresh = Cls.prototype.parseNewsQuery.bind(fresh);
    check('a pronoun with no antecedent falls back to headlines, not the word itself',
        parseFresh('news about him')?.topic === '', JSON.stringify(parseFresh('news about him')));
    check('a new subject replaces the old one', (() => {
        parse('news about tesla');
        return parse('news about it')?.topic === 'tesla';
    })());
}

/* --- EDGAR full-text search vs everything else it sits in front of ------------
   EDGAR_SEARCH is checked FIRST among the finance parsers, which is exactly the
   position that has caused every ordering bug in this file's history ("watch
   for whales" stolen by the watchlist, "ON" matching the word "on"). These
   assert both directions: it wins the queries it should, and steals none of
   the ones that already work. */
{
    /* Drives detectIntent, not one parser — ordering between parsers is the
       whole point here and is invisible to any single one of them. The context
       is built from the prototype so every helper detectIntent reaches for
       exists, the way eval/agent-harness.mjs does it. */
    const router = Object.create(Cls.prototype);
    router.settings = { get: () => null };
    router._lastNewsSubject = null;
    const parse = (s) => router.detectIntent(s);
    const intentOf = (s) => parse(s)?.intent ?? null;

    check('edgar: "search edgar for tokenized securities"', intentOf('search edgar for tokenized securities') === 'EDGAR_SEARCH');
    check('edgar: "which companies mention stablecoin in their filings"',
        intentOf('which companies mention stablecoin in their filings') === 'EDGAR_SEARCH');
    check('edgar: the search term reaches the handler', parse('search edgar for lithium supply')?.term === 'lithium supply',
        JSON.stringify(parse('search edgar for lithium supply')));
    check('edgar: form type reaches the handler',
        parse('search edgar for 10-Ks mentioning artificial intelligence')?.forms.join() === '10-K');

    /* THE THEFTS THAT WOULD MATTER. Each of these already routes somewhere that
       answers correctly; a greedy EDGAR parser turns a working answer into a
       wasted SEC round-trip. */
    check('edgar: does NOT steal a price query', intentOf('how much is bitcoin') !== 'EDGAR_SEARCH', String(intentOf('how much is bitcoin')));
    check('edgar: does NOT steal a quant query', intentOf('sharpe ratio of apple') !== 'EDGAR_SEARCH', String(intentOf('sharpe ratio of apple')));
    check('edgar: does NOT steal an on-chain query', intentOf('gas on arbitrum') !== 'EDGAR_SEARCH', String(intentOf('gas on arbitrum')));
    check('edgar: does NOT steal a news query', intentOf('latest news on ethereum') !== 'EDGAR_SEARCH', String(intentOf('latest news on ethereum')));
    check('edgar: does NOT steal the feed brief', intentOf('any new sec filings') !== 'EDGAR_SEARCH', String(intentOf('any new sec filings')));
    check('edgar: does NOT steal a web search', intentOf('search the web for rust tutorials') !== 'EDGAR_SEARCH', String(intentOf('search the web for rust tutorials')));
    check('edgar: does NOT fire on ordinary conversation', intentOf('what is the weather like') !== 'EDGAR_SEARCH');

    /* --- PER-COMPANY FILINGS -------------------------------------------------
       Routed from a live prompt that had no home: "sec filings of google" has
       no search lead-in, so EDGAR_SEARCH declines it, and none of the feed
       brief's recency words, so that declined it too. It reached the model,
       which has no filing data. This sits between the two, and the assertions
       below are the two neighbours it must not disturb. */
    check('company: "sec filings of google" routes to the company feed',
        intentOf('sec filings of google') === 'COMPANY_FILINGS', String(intentOf('sec filings of google')));
    check('company: the name reaches the handler',
        parse('sec filings of google')?.name === 'google', JSON.stringify(parse('sec filings of google')));
    check('company: a possessive works too',
        intentOf("apple's sec filings") === 'COMPANY_FILINGS', String(intentOf("apple's sec filings")));
    check('company: "what did tesla file"',
        intentOf('what did tesla file') === 'COMPANY_FILINGS', String(intentOf('what did tesla file')));
    check('company: the form type reaches the handler',
        parse('10-Ks of apple')?.forms.join() === '10-K', JSON.stringify(parse('10-Ks of apple')));

    /* Both neighbours, in both directions. "latest sec filings of google" is
       the one that would silently break: it carries "latest" AND "sec filings",
       so the domain-scoped feed brief below would answer a question about
       Google with everyone else's filings. */
    check('company: does NOT steal the full-text search',
        intentOf('search edgar for tokenized securities') === 'EDGAR_SEARCH');
    check('company: does NOT steal "which companies mention stablecoin in their filings"',
        intentOf('which companies mention stablecoin in their filings') === 'EDGAR_SEARCH');
    check('company: does NOT steal the feed brief',
        intentOf('any new sec filings') === 'FEED_BRIEF', String(intentOf('any new sec filings')));
    check('company: WINS over the feed brief when a company is named',
        intentOf('latest sec filings of google') === 'COMPANY_FILINGS',
        String(intentOf('latest sec filings of google')));
    check('company: does NOT steal a price query',
        intentOf('how much is bitcoin') !== 'COMPANY_FILINGS', String(intentOf('how much is bitcoin')));
    check('company: does NOT steal a quant query',
        intentOf('sharpe ratio of apple') !== 'COMPANY_FILINGS', String(intentOf('sharpe ratio of apple')));
    check('company: does NOT fire on ordinary conversation',
        intentOf('what is the weather like') !== 'COMPANY_FILINGS');

    /* PREDICTION MARKETS — found by routing a live prompt, not by reading the
       regex. "what are the odds the fed cuts rates" reached the MODEL, which
       has no market data and answers with an invented probability. The old
       pattern required of|on|that|for after the odds-word, and the commonest
       phrasing has no preposition at all. */
    check('odds: "the odds THE fed cuts rates" reaches the market handler',
        intentOf('what are the odds the fed cuts rates') === 'CHAIN_QUERY', String(intentOf('what are the odds the fed cuts rates')));
    check('odds: "chances bitcoin hits 200k" reaches it too',
        intentOf('chances bitcoin hits 200k') === 'CHAIN_QUERY', String(intentOf('chances bitcoin hits 200k')));
    check('odds: the previously-working phrasings still work',
        intentOf('what are the odds of a rate cut') === 'CHAIN_QUERY'
        && intentOf('odds that bitcoin hits 200k') === 'CHAIN_QUERY'
        && intentOf('polymarket trending') === 'CHAIN_QUERY');
    check('odds: the prediction kind is carried, not just the intent',
        /^prediction/.test(parse('what are the odds the fed cuts rates')?.kind || ''),
        String(parse('what are the odds the fed cuts rates')?.kind));

    /* And it must not swallow ordinary speech that merely contains a
       determiner or an outcome verb. */
    check('odds: does not fire without the odds word',
        intentOf('the fed cuts rates next month') !== 'CHAIN_QUERY', String(intentOf('the fed cuts rates next month')));
    check('odds: does not fire on a price question',
        intentOf('how much is bitcoin') === 'PRICE_QUERY', String(intentOf('how much is bitcoin')));
    check('odds: does not fire on ordinary conversation containing "the"',
        intentOf('what is the weather like') !== 'CHAIN_QUERY');

    /* DOMAIN-SCOPED FEED QUERIES. Nine SEC feeds are ingested; before these
       lines the obvious questions about them reached the MODEL, which has no
       feed history. The SEC's vocabulary is not "filings" — litigation
       releases, administrative proceedings and trading suspensions are
       separate feeds and separate words. */
    const domainOf = (s) => { const i = parse(s); return i?.intent === 'FEED_BRIEF' ? (i.domain || 'all') : String(i?.intent); };
    check('feeds: "any new sec filings" reaches the feed brief', domainOf('any new sec filings') === 'finance', domainOf('any new sec filings'));
    check('feeds: "what did the sec announce recently"', domainOf('what did the sec announce recently') === 'finance', domainOf('what did the sec announce recently'));
    check('feeds: "any new litigation releases"', domainOf('any new litigation releases') === 'finance', domainOf('any new litigation releases'));
    check('feeds: "any new trading suspensions"', domainOf('any new trading suspensions') === 'finance', domainOf('any new trading suspensions'));
    check('feeds: security advisories scope to security', domainOf('any new security advisories') === 'security', domainOf('any new security advisories'));
    check('feeds: a week window is carried', parse('what new sec filings came in this week')?.hours === 168);
    check('feeds: the general brief keeps its unscoped meaning', domainOf('brief me on the feeds') === 'all', domainOf('brief me on the feeds'));
    /* Must not swallow a full-text search: that one has a SUBJECT. */
    check('feeds: does not steal an edgar search', intentOf('search edgar for tokenized securities') === 'EDGAR_SEARCH');

    /* QUANT — replayed verbatim from the live log of 22 Jul 2026, where the
       word "analyze" appearing mid-sentence made the whole rest of the line a
       ticker and produced "I could not find enough price history for and tell
       me." */
    const LOGGED = 'investigate what might me his future plans next move analyze and tell me';
    check('quant: a mid-sentence "analyze" is not a quant request',
        intentOf(LOGGED) !== 'QUANT_QUERY', JSON.stringify(parse(LOGGED)));
    check('quant: the real forms still work',
        intentOf('analyze apple') === 'QUANT_QUERY'
        && intentOf('analyze the risk of tesla') === 'QUANT_QUERY'
        && intentOf('sharpe ratio of apple') === 'QUANT_QUERY');
    check('quant: a polite prefix still routes', intentOf('please analyze apple') === 'QUANT_QUERY', String(intentOf('please analyze apple')));
    check('quant: entity is still extracted correctly', parse('analyze apple')?.entity === 'apple', String(parse('analyze apple')?.entity));
}

/* --- peer-relative (SECTOR_QUERY) --------------------------------------------
   This intent sits BEFORE the quant parser, which means an over-broad pattern
   here silently steals every "analyze X" request. Both directions are checked:
   that sector wording routes here, and that ordinary quant wording still does
   not. */
{
    const router = Object.create(Cls.prototype);
    router.settings = { get: () => null };
    router._lastNewsSubject = null;
    const parse = (s) => router.detectIntent(s);
    const intentOf = (s) => parse(s)?.intent ?? null;
    const sec = Cls.prototype.parseSectorQuery.bind(router);

    check('sector: "decompose micron\'s move"', intentOf("decompose micron's move") === 'SECTOR_QUERY',
        String(intentOf("decompose micron's move")));
    check('sector: "break down the memory sector"', intentOf('break down the memory sector') === 'SECTOR_QUERY',
        String(intentOf('break down the memory sector')));
    check('sector: "how much of micron\'s drop is the sector"',
        intentOf("how much of micron's drop is the sector") === 'SECTOR_QUERY');
    check('sector: "who is outperforming in memory"',
        intentOf('who is outperforming in memory') === 'SECTOR_QUERY');
    check('sector: entity survives the possessive',
        sec("decompose micron's move")?.entity === 'micron',
        JSON.stringify(sec("decompose micron's move")));
    check('sector: the group name reaches the handler',
        /memory/i.test(sec('break down the memory sector')?.entity || ''),
        JSON.stringify(sec('break down the memory sector')));

    /* The regression this ordering could cause: plain quant requests must NOT
       be captured by the sector parser now that it runs first. */
    check('sector: "analyze apple" still routes to QUANT_QUERY',
        intentOf('analyze apple') === 'QUANT_QUERY', String(intentOf('analyze apple')));
    check('sector: "sharpe ratio of apple" still routes to QUANT_QUERY',
        intentOf('sharpe ratio of apple') === 'QUANT_QUERY', String(intentOf('sharpe ratio of apple')));
    check('sector: "how risky is tesla" still routes to QUANT_QUERY',
        intentOf('how risky is tesla') === 'QUANT_QUERY', String(intentOf('how risky is tesla')));

    /* The failure class parseQuantQuery documents: a verb buried mid-sentence
       must not take the rest of the line as a ticker. */
    check('sector: a mid-sentence "break down" does not become a ticker',
        sec('i need you to think about it and then break down everything you know about him') === null,
        JSON.stringify(sec('i need you to think about it and then break down everything you know about him')));
    check('sector: a filler entity is refused', sec('decompose and tell me') === null,
        JSON.stringify(sec('decompose and tell me')));

    /* VaR joined the quant metric list. */
    check('quant: "value at risk of micron" routes to QUANT_QUERY',
        intentOf('value at risk of micron') === 'QUANT_QUERY', String(intentOf('value at risk of micron')));
    check('quant: VaR maps to the var metric',
        Cls.prototype.parseQuantQuery.bind(router)('value at risk of micron')?.metric === 'var',
        JSON.stringify(Cls.prototype.parseQuantQuery.bind(router)('value at risk of micron')));
    check('quant: "expected shortfall for micron" maps to var',
        Cls.prototype.parseQuantQuery.bind(router)('expected shortfall for micron')?.metric === 'var');
}

/* --- portfolio-level (PORTFOLIO_QUERY) ---------------------------------------
   Runs BEFORE both the sector and quant parsers, so it is the one most able to
   break existing behaviour. The watchlist add/show intents also say
   "watchlist", and parseQuantQuery reads "risky" as a single-security request. */
{
    const router = Object.create(Cls.prototype);
    router.settings = { get: () => null };
    router._lastNewsSubject = null;
    const intentOf = (s) => { try { return router.detectIntent(s)?.intent ?? null; } catch (e) { return `THREW ${e.message}`; } };

    check('portfolio: "how risky is my watchlist"',
        intentOf('how risky is my watchlist') === 'PORTFOLIO_QUERY', String(intentOf('how risky is my watchlist')));
    check('portfolio: "what is my portfolio risk"',
        intentOf('what is my portfolio risk') === 'PORTFOLIO_QUERY', String(intentOf('what is my portfolio risk')));
    check('portfolio: "how diversified is my portfolio"',
        intentOf('how diversified is my portfolio') === 'PORTFOLIO_QUERY');
    check('portfolio: "risk parity weights for memory stocks"',
        intentOf('risk parity weights for memory stocks') === 'PORTFOLIO_QUERY',
        String(intentOf('risk parity weights for memory stocks')));
    check('portfolio: the group reaches the handler',
        router.detectIntent('risk parity for memory stocks')?.group === 'memory',
        JSON.stringify(router.detectIntent('risk parity for memory stocks')));

    /* Regressions this ordering could cause. */
    check('portfolio: "add micron to my watchlist" is still WATCHLIST_ADD',
        intentOf('add micron to my watchlist') === 'WATCHLIST_ADD', String(intentOf('add micron to my watchlist')));
    check('portfolio: "remove amd from my watchlist" is still WATCHLIST_REMOVE',
        intentOf('remove amd from my watchlist') === 'WATCHLIST_REMOVE', String(intentOf('remove amd from my watchlist')));
    check('portfolio: "how risky is micron" is still a single-security question',
        intentOf('how risky is micron') === 'QUANT_QUERY', String(intentOf('how risky is micron')));
    check('portfolio: "break down the memory sector" is still SECTOR_QUERY',
        intentOf('break down the memory sector') === 'SECTOR_QUERY', String(intentOf('break down the memory sector')));
    check('portfolio: a watchlist question with no risk word is not stolen',
        intentOf("what's on my watchlist") !== 'PORTFOLIO_QUERY', String(intentOf("what's on my watchlist")));

    /* Every portfolio line from the published cheatsheet. Three of these were
       documented as working and were not — "risk parity" named a method but no
       book, an explicit ticker list was not parsed at all, and "just one
       position" is the diversification question asked without a risk noun. */
    for (const t of [
        'where is the risk in my memory book',
        'risk contribution of my watchlist',
        'how diversified are memory stocks',
        'what would risk parity do here',
        'minimum variance weights for mu, sndk, wdc',
        'is my portfolio really just one position',
        'portfolio var on memory stocks',
    ]) check(`portfolio cheatsheet: "${t}"`, intentOf(t) === 'PORTFOLIO_QUERY', String(intentOf(t)));

    check('portfolio: an explicit ticker list reaches the handler',
        JSON.stringify(router.detectIntent('minimum variance weights for mu, sndk, wdc')?.symbols) === '["MU","SNDK","WDC"]',
        JSON.stringify(router.detectIntent('minimum variance weights for mu, sndk, wdc')?.symbols));
    check('portfolio: "and" separates a list as well as a comma',
        (router.detectIntent('risk parity for mu and wdc')?.symbols || []).length === 2,
        JSON.stringify(router.detectIntent('risk parity for mu and wdc')?.symbols));

    /* The list pattern is the greedy one — a single name after "of" must stay
       a single-security question, not become a one-stock portfolio. */
    check('portfolio: "sharpe ratio of apple" is still QUANT_QUERY',
        intentOf('sharpe ratio of apple') === 'QUANT_QUERY', String(intentOf('sharpe ratio of apple')));
    check('portfolio: "volatility of micron" is still QUANT_QUERY',
        intentOf('volatility of micron') === 'QUANT_QUERY', String(intentOf('volatility of micron')));
    check('portfolio: "price of apple" is untouched',
        intentOf('price of apple') !== 'PORTFOLIO_QUERY', String(intentOf('price of apple')));
    check('portfolio: "news on micron" is untouched',
        intentOf('news on micron') !== 'PORTFOLIO_QUERY', String(intentOf('news on micron')));
}

/* --- verbatim failures from the interaction log, 30 Jul 2026 ----------------
   These are not invented cases. Each was typed at the running assistant and
   got a wrong answer, recovered from userData/interactions.jsonl. */
{
    const router = Object.create(Cls.prototype);
    router.settings = { get: () => null };
    router._lastNewsSubject = null;
    const intentOf = (s) => { try { return router.detectIntent(s)?.intent ?? null; } catch (e) { return `THREW ${e.message}`; } };
    const quant = Cls.prototype.parseQuantQuery.bind(router);
    const price = Cls.prototype.parsePriceQuery.bind(router);

    /* Answered with "66 new items in the last 24 hours" — a digest of
       everyone's filings instead of the company that was asked for. */
    check('log: "show me google 10-K" reaches the filing, not the feed brief',
        intentOf('show me google 10-k') === 'COMPANY_FILINGS', String(intentOf('show me google 10-k')));
    check('log: "show me micron 10-K" likewise',
        intentOf('show me micron 10-k') === 'COMPANY_FILINGS', String(intentOf('show me micron 10-k')));
    check('log: the company survives extraction',
        router.detectIntent('show me google 10-k')?.name === 'google',
        JSON.stringify(router.detectIntent('show me google 10-k')?.name));
    check('log: a form-only request still belongs to the feed brief',
        intentOf('show me the latest sec filings') === 'FEED_BRIEF',
        String(intentOf('show me the latest sec filings')));

    /* Answered "I could not find enough price history for what's micron's." */
    check('log: "what\'s micron\'s volatility" extracts the company, not the question',
        quant("what's micron's volatility")?.entity === 'micron',
        JSON.stringify(quant("what's micron's volatility")));
    check('log: and keeps the metric', quant("what's micron's volatility")?.metric === 'volatility');
    check('log: the possessive alone also resolves', quant("micron's sharpe")?.entity === 'micron');

    /* Answered "The context does not contain information regarding NVIDIA's
       performance" while the deterministic quote engine sat unused. */
    check('log: "how is nvidia doing" is a price question',
        intentOf('how is nvidia doing') === 'PRICE_QUERY', String(intentOf('how is nvidia doing')));
    check('log: "what\'s MU at" is a price question',
        intentOf("what's mu at") === 'PRICE_QUERY', String(intentOf("what's mu at")));
    check('log: and the ticker survives', price('how is nvidia doing') === 'nvidia');

    /* The guard that keeps the bare form narrow. Without the known-asset
       check, any "how is X doing" becomes a ticker lookup. */
    check('bare form: "how is my day going" is not a price query',
        price('how is my day going') === null);
    check('bare form: "how is the weather doing" is not a price query',
        price('how is the weather doing') === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
