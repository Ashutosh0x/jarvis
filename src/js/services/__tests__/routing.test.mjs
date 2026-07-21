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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
