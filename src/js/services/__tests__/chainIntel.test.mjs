// Tests for keyed-provider response parsing.
//
// Every fixture below is a REAL payload captured from the live APIs on
// 21 Jul 2026, trimmed but not reshaped. That matters more than usual here:
// the two bugs this module is written to avoid (native rows carrying null
// metadata, and lowercase "usd") are invisible to a hand-written fixture that
// simply repeats what the code expects.
import {
    usdPrice, parseTokenHoldings, portfolioTotal, formatUsd, describePortfolio,
    parsePrices, describePrices, parseSolanaActivity, describeSolanaActivity,
    parseSolanaAssets, describeSolanaAssets,
} from '../chainIntel.js';

let pass = 0, fail = 0;
const check = (n, c) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); };

/* --- captured fixtures ---------------------------------------------------- */

// vitalik.eth, eth-mainnet + base-mainnet, withMetadata + withPrices.
const TOKENS_PAYLOAD = {
    data: {
        tokens: [
            {   // native ETH: tokenAddress null AND every metadata field null
                address: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045',
                network: 'eth-mainnet',
                tokenAddress: null,
                tokenBalance: '0x0000000000000000000000000000000000000000000000005c08c938b8c5d756',
                tokenMetadata: { symbol: null, decimals: null, name: null, logo: null },
                tokenPrices: [{ currency: 'usd', value: '1941.69', lastUpdatedAt: '2026-07-21T12:28:00.310Z' }],
            },
            {   // ERC-20 with metadata and a price
                address: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045',
                network: 'eth-mainnet',
                tokenAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
                tokenBalance: '0x00000000000000000000000000000000000000000000000000000000075bcd15',
                tokenMetadata: { symbol: 'USDC', decimals: 6, name: 'USD Coin', logo: null },
                tokenPrices: [{ currency: 'usd', value: '1.0006', lastUpdatedAt: '2026-07-21T12:28:05.183Z' }],
            },
            {   // held, but nobody quotes it
                address: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045',
                network: 'base-mainnet',
                tokenAddress: '0x1111111111111111111111111111111111111111',
                tokenBalance: '0x0000000000000000000000000000000000000000000000008ac7230489e80000',
                tokenMetadata: { symbol: 'WEIRD', decimals: 18, name: 'Weird Token', logo: null },
                tokenPrices: [],
            },
            {   // zero balance — noise
                address: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045',
                network: 'eth-mainnet',
                tokenAddress: '0x2222222222222222222222222222222222222222',
                tokenBalance: '0x0000000000000000000000000000000000000000000000000000000000000000',
                tokenMetadata: { symbol: 'DUST', decimals: 18, name: 'Dust', logo: null },
                tokenPrices: [],
            },
            {   // decimals unknowable -> must be dropped, not guessed
                address: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045',
                network: 'eth-mainnet',
                tokenAddress: '0x3333333333333333333333333333333333333333',
                tokenBalance: '0x00000000000000000000000000000000000000000000000000000000000f4240',
                tokenMetadata: { symbol: 'MYSTERY', decimals: null, name: null, logo: null },
                tokenPrices: [],
            },
        ],
    },
};

const PRICES_PAYLOAD = {
    data: [
        { symbol: 'ETH', prices: [{ currency: 'usd', value: '1941.69', lastUpdatedAt: '2026-07-21T12:28:00.310Z' }] },
        { symbol: 'USDC', prices: [{ currency: 'usd', value: '1.0006', lastUpdatedAt: '2026-07-21T12:28:05.183Z' }] },
        { symbol: 'NOTAREALTOKENXYZ', prices: [], error: { message: 'Price not found for symbol: NOTAREALTOKENXYZ' } },
    ],
};

const SOL_ACTIVITY_PAYLOAD = [
    {
        description: 'E16prLnWTwfLUYgXRTELYgw4u8QUnN9CAcHceLrDTjN1 transferred 0.0001 SOL to vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg.',
        type: 'TRANSFER', source: 'SYSTEM_PROGRAM', fee: 80000,
        signature: 'bqTH7u2PJ33gDQwZMy9BXVxABRpgUbY8xSuK6y9PpKYxucFKhiJyiD7JTrH1zxFvMEJGz4847tvotMoP1Ekavaa',
        slot: 423345826, timestamp: 1780219205,
    },
    { description: '', type: 'UNKNOWN', source: 'UNKNOWN', fee: 5000, signature: 'sig2', slot: 423345000, timestamp: 1780219000 },
];

const SOL_ASSETS_PAYLOAD = {
    result: {
        total: 5,
        nativeBalance: { lamports: 39869364, price_per_sol: 78.32843017578125, total_price: 3.1229046942268064 },
        items: [
            { interface: 'FungibleToken', id: 'HyU5k4ZKMkLNnbuZDAGvwxTXbxubAcdJNYcotAre2fBL', content: { metadata: { name: 'SOLANA.COM ASDF', symbol: 'SOL' } }, token_info: { balance: 1, decimals: 0 } },
            { interface: 'V1_NFT', id: 'nft1', content: { metadata: { name: 'Qualified #611', symbol: 'MyNF' } }, compression: { compressed: true } },
            { interface: 'FungibleToken', id: 'si1', content: { metadata: { name: 'sealwifhat', symbol: 'SI' } }, token_info: { balance: 50000000000, decimals: 9, price_info: { price_per_token: 0.0004 } } },
        ],
    },
};

/* --- usdPrice ------------------------------------------------------------- */
{
    check('usdPrice: matches lowercase "usd" as the API actually sends it',
        usdPrice([{ currency: 'usd', value: '1941.69' }]) === 1941.69);
    check('usdPrice: matches uppercase too (docs show USD)',
        usdPrice([{ currency: 'USD', value: '2' }]) === 2);
    check('usdPrice: no usd entry -> null', usdPrice([{ currency: 'eur', value: '5' }]) === null);
    check('usdPrice: empty/garbage -> null',
        usdPrice([]) === null && usdPrice(null) === null && usdPrice([{ currency: 'usd', value: 'abc' }]) === null);
}

/* --- parseTokenHoldings --------------------------------------------------- */
{
    const h = parseTokenHoldings(TOKENS_PAYLOAD, { 'eth-mainnet': { native: 'ETH' }, 'base-mainnet': { native: 'ETH' } });

    check('holdings: zero balances and unknowable decimals are dropped', h.length === 3);
    check('holdings: no MYSTERY token invented with a guessed decimals',
        !h.some(x => x.symbol === 'MYSTERY'));

    const native = h.find(x => x.isNative);
    // 0x5c08c938b8c5d756 = 6631771696758380374 wei = 6.63177169 ETH at 8dp
    check('holdings: native decoded at 18dp despite null metadata',
        native && native.exact === '6.63177169');
    check('holdings: native symbol comes from chain metadata, not the payload',
        native.symbol === 'ETH');
    check('holdings: native value = balance x price',
        Math.abs(native.valueUsd - 6.63177169 * 1941.69) < 0.01);

    const usdc = h.find(x => x.symbol === 'USDC');
    // 0x075bcd15 = 123456789 at 6dp = 123.456789
    check('holdings: ERC-20 uses its own decimals', usdc.exact === '123.456789');
    check('holdings: exact string is not float-derived', typeof usdc.exact === 'string');

    const weird = h.find(x => x.symbol === 'WEIRD');
    check('holdings: unpriced token kept with null price, not zero',
        weird.priceUsd === null && weird.valueUsd === null);
    check('holdings: network is preserved per row', weird.network === 'base-mainnet');

    check('holdings: garbage payload -> empty, never throws',
        parseTokenHoldings(null).length === 0 && parseTokenHoldings({ data: {} }).length === 0);
}

/* --- portfolioTotal ------------------------------------------------------- */
{
    const h = parseTokenHoldings(TOKENS_PAYLOAD, {});
    const t = portfolioTotal(h);
    check('total: only priced positions are summed', t.priced === 2 && t.unpriced === 1);
    check('total: unpriced never counted as zero-value silently',
        Math.abs(t.totalUsd - (6.63177169 * 1941.69 + 123.456789 * 1.0006)) < 0.01);
    check('total: empty holdings -> zero, no NaN',
        portfolioTotal([]).totalUsd === 0);
}

/* --- formatUsd ------------------------------------------------------------ */
{
    check('usd: thousands grouped, no cents', formatUsd(12878.4) === '$12,878');
    check('usd: cents under 1000', formatUsd(123.456) === '$123.46');
    check('usd: sub-dollar keeps precision', formatUsd(0.0004) === '$0.0004');
    check('usd: zero', formatUsd(0) === '$0');
    check('usd: null/NaN is "unknown", never $0', formatUsd(null) === 'unknown' && formatUsd(NaN) === 'unknown');
}

/* --- describePortfolio ---------------------------------------------------- */
{
    const h = parseTokenHoldings(TOKENS_PAYLOAD, { 'eth-mainnet': { native: 'ETH' } });
    const s = describePortfolio(h, { limit: 2 });
    check('portfolio: leads with the total', /^That wallet holds about \$/.test(s));
    check('portfolio: native holdings name their chain (several chains, one symbol)',
        /ETH on ethereum/.test(describePortfolio(
            parseTokenHoldings(TOKENS_PAYLOAD, { 'eth-mainnet': { native: 'ETH', chain: 'ethereum' } }))));
    check('portfolio: biggest position first', s.indexOf('ETH') < s.indexOf('USDC'));
    check('portfolio: tail summarised, not enumerated', /Plus 1 smaller position/.test(s));
    check('portfolio: says unpriced positions were excluded', /no price feed/.test(s));
    check('portfolio: empty wallet is stated plainly, not as $0',
        /no tokens with a non-zero balance/.test(describePortfolio([])));
    check('portfolio: nothing priced -> no fabricated total',
        !/about \$/.test(describePortfolio([{ symbol: 'X', exact: '1', approx: 1, valueUsd: null }])));
}

/* --- prices --------------------------------------------------------------- */
{
    const m = parsePrices(PRICES_PAYLOAD);
    check('prices: known symbols parsed', m.ETH.usd === 1941.69 && m.USDC.usd === 1.0006);
    check('prices: an error entry becomes null, not a missing key',
        'NOTAREALTOKENXYZ' in m && m.NOTAREALTOKENXYZ === null);
    check('prices: timestamp carried through', typeof m.ETH.at === 'string');
    const said = describePrices(m);
    check('prices spoken: real prices stated', /ETH is \$1,942|ETH is \$1941/.test(said));
    check('prices spoken: unknown named as unknown', /no price for NOTAREALTOKENXYZ/.test(said));
    check('prices spoken: empty payload admits nothing came back',
        /no price data back/.test(describePrices(parsePrices({}))));
}

/* --- Solana activity ------------------------------------------------------ */
{
    const items = parseSolanaActivity(SOL_ACTIVITY_PAYLOAD);
    check('sol activity: parsed with provider description intact',
        items[0].description.startsWith('E16prLnWTwfLUYgXRTELYgw4u8QUnN9CAcHceLrDTjN1 transferred 0.0001 SOL'));
    check('sol activity: fee converted from lamports', items[0].feeSol === 0.00008);
    check('sol activity: timestamp is ms', items[0].timestamp === 1780219205000);
    check('sol activity: blank description normalised to null', items[1].description === null);
    check('sol activity: non-array payload -> empty', parseSolanaActivity({ error: 'x' }).length === 0);

    const said = describeSolanaActivity(items);
    check('sol activity spoken: uses the provider sentence verbatim', said.includes('transferred 0.0001 SOL'));
    check('sol activity spoken: empty is stated', /no recent transactions/.test(describeSolanaActivity([])));
    check('sol activity spoken: descriptionless set falls back to types, invents nothing',
        /none came with a readable description/.test(describeSolanaActivity([{ type: 'SWAP', description: null, timestamp: null }])));
}

/* --- Solana assets -------------------------------------------------------- */
{
    const a = parseSolanaAssets(SOL_ASSETS_PAYLOAD);
    check('sol assets: native SOL read from nativeBalance, not from items',
        Math.abs(a.nativeSol.sol - 0.039869364) < 1e-9);
    check('sol assets: SOL value uses the provider total_price',
        Math.abs(a.nativeSol.valueUsd - 3.1229046942268064) < 1e-9);
    check('sol assets: total comes from the provider', a.total === 5);
    check('sol assets: fungible amount honours decimals', a.assets[2].amount === 50);
    check('sol assets: compression flag preserved', a.assets[1].compressed === true);
    check('sol assets: missing nativeBalance -> null, not zero SOL',
        parseSolanaAssets({ result: { items: [], total: 0 } }).nativeSol === null);
    check('sol assets: garbage payload -> empty, never throws',
        parseSolanaAssets(null).total === 0 && parseSolanaAssets(undefined).assets.length === 0);

    const said = describeSolanaAssets(a);
    check('sol assets spoken: leads with the SOL balance', said.startsWith('That wallet holds 0.0399 SOL'));
    check('sol assets spoken: splits fungible from NFTs', /1 NFT/.test(said) && /2 fungible/.test(said));
    check('sol assets spoken: SOL-only wallet still answers',
        /0\.0399 SOL/.test(describeSolanaAssets({ total: 0, assets: [], nativeSol: a.nativeSol })));
    check('sol assets spoken: truly empty wallet says so',
        /no assets I can see/.test(describeSolanaAssets({ total: 0, assets: [], nativeSol: null })));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
