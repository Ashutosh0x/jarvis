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

/* --- provider capability + solana reads --------------------------------------- */
routes('which chains can you read', 'chain-capabilities');
routes('solana wallet vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg', 'solana-assets');
routes('recent solana activity for vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg', 'solana-activity');
// Base58 is not self-identifying — without the chain named, this is not a
// Solana address, it is a word.
routes('remind me about vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg', null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
