// Tests for the keyed provider layer.
//
// The load-bearing claim of this module is that a provider endpoint must PROVE
// which chain it is before Jarvis reads a balance from it. These tests drive
// that with a stub fetch, because the failure that matters — a slug quietly
// answering for the WRONG chain — cannot be reproduced against the live API.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const cp = require('../../../../chainProviders.js');

let pass = 0, fail = 0;
const check = (n, c) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); };

const CHAINS = { ethereum: { id: 1 }, arbitrum: { id: 42161 }, polygon: { id: 137 } };
const hex = (n) => '0x' + n.toString(16);
const okRes = (body) => ({ ok: true, status: 200, json: async () => body });
const errRes = (status) => ({ ok: false, status, json: async () => ({}) });

/**
 * A fake Alchemy: `map` says what each slug answers with. A number is the chain
 * id it claims; `{ http: 403 }` is a status. Chain ids and HTTP codes are NOT
 * distinguished by magnitude — 42161 would look like a status code, and that
 * ambiguity is exactly what a real chain id (8453, 42161) would hit.
 */
function stubFetch(map, { calls = [] } = {}) {
    return async (url) => {
        const slug = new URL(url).hostname.split('.')[0];
        calls.push(slug);
        const r = map[slug];
        if (r === undefined) throw new Error('getaddrinfo ENOTFOUND');
        if (r && typeof r === 'object' && r.http) return errRes(r.http);
        if (r === 'rpcerror') return okRes({ error: { message: 'must be authenticated' } });
        return okRes({ jsonrpc: '2.0', id: 1, result: hex(r) });
    };
}

/* --- URL construction ----------------------------------------------------- */
{
    check('rpc url: key goes in the path, slug in the host',
        cp.alchemyRpcUrl('eth-mainnet', 'KEY123') === 'https://eth-mainnet.g.alchemy.com/v2/KEY123');
    check('prices url: symbols repeat as separate params',
        cp.alchemyPricesBySymbolUrl('K', ['ETH', 'BTC']).endsWith('by-symbol?symbols=ETH&symbols=BTC'));
    check('prices url: symbols are encoded, not concatenated raw',
        cp.alchemyPricesBySymbolUrl('K', ['A B&C']).includes('symbols=A%20B%26C'));
    check('helius url: key is a query param on the mainnet host',
        cp.heliusRpcUrl('K') === 'https://mainnet.helius-rpc.com/?api-key=K');
    check('helius tx url: address, key and limit all present',
        cp.heliusTxByAddressUrl('ADDR', 'K', 5) === 'https://api.helius.xyz/v0/addresses/ADDR/transactions?api-key=K&limit=5');
}

/* --- slug candidates ------------------------------------------------------ */
{
    check('slugs: known chains offer their historical aliases too',
        cp.slugCandidates('polygon').includes('polygon-mainnet') && cp.slugCandidates('polygon').includes('matic-mainnet'));
    check('slugs: unknown chain still produces a testable guess',
        cp.slugCandidates('zzz')[0] === 'zzz-mainnet');
    check('slugs: guesses are ordered, most likely first',
        cp.slugCandidates('arbitrum')[0] === 'arb-mainnet');
}

/* --- probeSlug ------------------------------------------------------------ */
{
    const t = async (name, map, slug, expectedId, assert) => {
        const r = await cp.probeSlug(slug, 'K', expectedId, stubFetch(map));
        check(name, assert(r));
    };

    await t('probe: correct chain id is accepted', { 'eth-mainnet': 1 }, 'eth-mainnet', 1,
        (r) => r.ok === true && r.chainId === 1);

    // The whole point of the module: a live endpoint answering for another
    // chain is REJECTED, not silently used.
    await t('probe: wrong chain id is rejected even though the call succeeded',
        { 'eth-mainnet': 137 }, 'eth-mainnet', 1,
        (r) => r.ok === false && /mismatch/.test(r.reason) && /137/.test(r.reason));

    await t('probe: 403 (plan does not cover it) is reported as such',
        { 'polygon-mainnet': { http: 403 } }, 'polygon-mainnet', 137,
        (r) => r.ok === false && r.reason === 'http 403');

    await t('probe: json-rpc error surfaces the provider message',
        { 'eth-mainnet': 'rpcerror' }, 'eth-mainnet', 1,
        (r) => r.ok === false && /authenticated/.test(r.reason));

    await t('probe: nonexistent host fails without throwing',
        {}, 'nope-mainnet', 1, (r) => r.ok === false && r.reason.length > 0);

    // A hung endpoint must not hang startup.
    const hung = await cp.probeSlug('slow-mainnet', 'K', 1,
        (url, opts) => new Promise((_, rej) => opts.signal.addEventListener('abort', () => {
            const e = new Error('aborted'); e.name = 'AbortError'; rej(e);
        })), 30);
    check('probe: a hung endpoint times out and is reported as timeout',
        hung.ok === false && hung.reason === 'timeout');

    const noExpect = await cp.probeSlug('x-mainnet', 'K', null, stubFetch({ 'x-mainnet': 999 }));
    check('probe: with no expected id, whatever answers is accepted and reported',
        noExpect.ok === true && noExpect.chainId === 999);
}

/* --- discoverAlchemyNetworks ---------------------------------------------- */
{
    const calls = [];
    const { verified, rejected } = await cp.discoverAlchemyNetworks('K', CHAINS,
        stubFetch({ 'eth-mainnet': 1, 'arb-mainnet': 42161, 'polygon-mainnet': { http: 403 }, 'matic-mainnet': { http: 403 } }, { calls }));

    check('discover: chains that prove themselves are verified',
        verified.ethereum?.chainId === 1 && verified.arbitrum?.slug === 'arb-mainnet');
    check('discover: verified entry carries a usable url',
        verified.ethereum.url === 'https://eth-mainnet.g.alchemy.com/v2/K');
    check('discover: a chain the key cannot serve is absent, not faked',
        !('polygon' in verified) && 'polygon' in rejected);
    check('discover: the rejection records WHY, for every candidate tried',
        /polygon-mainnet: http 403/.test(rejected.polygon) && /matic-mainnet: http 403/.test(rejected.polygon));
    check('discover: a working first guess costs only one probe',
        calls.filter((c) => c === 'eth-mainnet').length === 1);

    // A slug answering for the wrong chain must not become that chain's endpoint.
    const liar = await cp.discoverAlchemyNetworks('K', { ethereum: { id: 1 } }, stubFetch({ 'eth-mainnet': 8453 }));
    check('discover: an endpoint claiming the wrong chain is never adopted',
        !('ethereum' in liar.verified) && /mismatch/.test(liar.rejected.ethereum));

    /* Transient vs verdict. Observed live: one startup dropped Ethereum because
       a single probe exceeded six seconds, so the session ran keyless on the
       chain that matters most. A timeout is retried; a 403 is not. */
    {
        let attempts = 0;
        const flaky = async (url) => {
            attempts++;
            if (attempts === 1) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
            return okRes({ jsonrpc: '2.0', id: 1, result: hex(1) });
        };
        const r = await cp.discoverAlchemyNetworks('K', { ethereum: { id: 1 } }, flaky);
        check('discover: a timed-out probe is retried, not written off',
            r.verified.ethereum?.chainId === 1 && attempts === 2, `attempts: ${attempts}`);
    }
    {
        let attempts = 0;
        const denied = async () => { attempts++; return errRes(403); };
        const r = await cp.discoverAlchemyNetworks('K', { base: { id: 8453 } }, denied);
        check('discover: a 403 verdict is NOT retried', !r.verified.base && attempts === 1, `attempts: ${attempts}`);
    }
    {
        let attempts = 0;
        const liar = async () => { attempts++; return okRes({ jsonrpc: '2.0', id: 1, result: hex(999) }); };
        const r = await cp.discoverAlchemyNetworks('K', { ethereum: { id: 1 } }, liar);
        check('discover: a chain-id mismatch is NOT retried', !r.verified.ethereum && attempts === 1, `attempts: ${attempts}`);
    }

    const keyless = await cp.discoverAlchemyNetworks(null, CHAINS, () => { throw new Error('should not be called'); });
    check('discover: no key -> no probes, no throw, empty result',
        Object.keys(keyless.verified).length === 0 && Object.keys(keyless.rejected).length === 0);

    const allDown = await cp.discoverAlchemyNetworks('K', CHAINS, stubFetch({}));
    check('discover: total outage degrades to empty rather than throwing',
        Object.keys(allDown.verified).length === 0 && Object.keys(allDown.rejected).length === 3);
}

/* --- resolveKey ----------------------------------------------------------- */
{
    const saved = process.env.ALCHEMY_API_KEY;
    process.env.ALCHEMY_API_KEY = 'from-env';
    check('key: environment wins over the vault',
        (await cp.resolveKey('alchemy', async () => 'from-vault')) === 'from-env');

    process.env.ALCHEMY_API_KEY = '   ';
    check('key: a whitespace-only env value does not count as configured',
        (await cp.resolveKey('alchemy', async () => 'from-vault')) === 'from-vault');

    delete process.env.ALCHEMY_API_KEY;
    check('key: falls back to the vault under the expected name',
        (await cp.resolveKey('alchemy', async (n) => (n === 'alchemy_api_key' ? 'v' : null))) === 'v');
    check('key: nothing anywhere -> null, never an empty string',
        (await cp.resolveKey('alchemy', async () => null)) === null);
    check('key: a throwing vault does not break startup',
        (await cp.resolveKey('alchemy', async () => { throw new Error('locked'); })) === null);
    check('key: no vault accessor at all is fine',
        (await cp.resolveKey('alchemy')) === null);

    if (saved === undefined) delete process.env.ALCHEMY_API_KEY; else process.env.ALCHEMY_API_KEY = saved;
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

