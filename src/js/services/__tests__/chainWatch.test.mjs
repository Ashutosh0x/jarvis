// Tests for chain-stream decisions. Load-bearing properties: BigInt exactness
// at whale scale (float math silently corrupts 18-decimal wei), and that a
// watch hit reports the right direction — "your wallet SENT" versus "RECEIVED"
// is the difference between calm and panic when spoken aloud.
import pkg from '../../../../chainWatch.js';
const { WHALE_THRESHOLDS, formatWeiNative, shortAddr, scanBlockTxs } = pkg;

let pass = 0, fail = 0;
const check = (n, c) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); };

const ETH = 10n ** 18n;
const hex = (v) => '0x' + v.toString(16);
const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const C = '0xcccccccccccccccccccccccccccccccccccccccc';

// --- formatWeiNative ---------------------------------------------------------
check('fmt: exact whole', formatWeiNative(1500n * ETH) === '1,500');
check('fmt: fraction trimmed', formatWeiNative(1n * ETH + ETH / 2n) === '1.5');
check('fmt: sub-4dp truncated not rounded', formatWeiNative(123456789n * 10n ** 10n) === '1.2345');
check('fmt: zero', formatWeiNative(0n) === '0');
check('fmt: hex input', formatWeiNative(hex(100n * ETH)) === '100');
check('fmt: whale-scale grouping', formatWeiNative(1234567n * ETH) === '1,234,567');
check('fmt: garbage input -> 0', formatWeiNative('not hex') === '0');
check('fmt: undefined -> 0', formatWeiNative(undefined) === '0');

// --- shortAddr ----------------------------------------------------------------
check('short: shortens', shortAddr(A) === '0xaaaa…aaaa');
check('short: null means contract creation', shortAddr(null) === 'contract creation');

// --- whale detection ----------------------------------------------------------
{
    const txs = [
        { hash: '0x1', from: A, to: B, value: hex(150n * ETH) },   // whale
        { hash: '0x2', from: B, to: C, value: hex(99n * ETH) },    // under threshold
        { hash: '0x3', from: C, to: A, value: hex(100n * ETH) },   // exactly at threshold
        { hash: '0x4', from: A, to: B, value: '0x0' },             // zero-value
    ];
    const { whales } = scanBlockTxs(txs, { chain: 'ethereum' });
    check('whale: over threshold detected', whales.some(w => w.hash === '0x1'));
    check('whale: under threshold ignored', !whales.some(w => w.hash === '0x2'));
    check('whale: exactly at threshold counts (>=)', whales.some(w => w.hash === '0x3'));
    check('whale: amount formatted exactly', whales.find(w => w.hash === '0x1').amount === '150');
    check('whale: valueWei survives as exact string',
        whales.find(w => w.hash === '0x1').valueWei === (150n * ETH).toString());
}

// --- per-chain thresholds -----------------------------------------------------
{
    const tx = [{ hash: '0x1', from: A, to: B, value: hex(200n * ETH) }];
    check('threshold: 200 POL is not a polygon whale',
        scanBlockTxs(tx, { chain: 'polygon' }).whales.length === 0);
    check('threshold: 200 ETH is an ethereum whale',
        scanBlockTxs(tx, { chain: 'ethereum' }).whales.length === 1);
    check('threshold: unknown chain falls back to ethereum',
        scanBlockTxs(tx, { chain: 'nonsense' }).whales.length === 1);
    check('threshold: caller override respected',
        scanBlockTxs(tx, { chain: 'ethereum', thresholdWei: 500n * ETH }).whales.length === 0);
    check('threshold: polygon default exists and is larger',
        WHALE_THRESHOLDS.polygon > WHALE_THRESHOLDS.ethereum);
}

// --- watchlist hits -----------------------------------------------------------
{
    const txs = [
        { hash: '0x1', from: A, to: B, value: hex(1n * ETH) },  // A sends
        { hash: '0x2', from: C, to: A, value: hex(2n * ETH) },  // A receives
        { hash: '0x3', from: B, to: C, value: hex(3n * ETH) },  // unrelated
    ];
    const { watchHits } = scanBlockTxs(txs, { watch: [A.toUpperCase()] }); // case-insensitive
    check('watch: sender hit found', watchHits.some(h => h.hash === '0x1'));
    check('watch: receiver hit found', watchHits.some(h => h.hash === '0x2'));
    check('watch: unrelated tx ignored', !watchHits.some(h => h.hash === '0x3'));
    check('watch: direction out on send', watchHits.find(h => h.hash === '0x1').direction === 'out');
    check('watch: direction in on receive', watchHits.find(h => h.hash === '0x2').direction === 'in');
    check('watch: watched field is the user\'s address', watchHits.every(h => h.watched === A));
    check('watch: case-insensitive matching worked', watchHits.length === 2);
}

// --- a tx can be both whale and watch hit --------------------------------------
{
    const txs = [{ hash: '0x1', from: A, to: B, value: hex(500n * ETH) }];
    const r = scanBlockTxs(txs, { chain: 'ethereum', watch: [A] });
    check('both: whale recorded', r.whales.length === 1);
    check('both: watch hit recorded too', r.watchHits.length === 1);
}

// --- hostile / degraded input never throws -------------------------------------
{
    check('degraded: null txs', scanBlockTxs(null).whales.length === 0);
    check('degraded: non-array', scanBlockTxs('block').whales.length === 0);
    const junk = [
        null, 42, { hash: '0xj', value: 'zzz' },
        { hash: '0xk', from: A, to: null, value: hex(200n * ETH) }, // contract creation
    ];
    const r = scanBlockTxs(junk, { chain: 'ethereum', watch: [A] });
    check('degraded: junk entries skipped, valid one kept', r.whales.length === 1);
    check('degraded: null to handled', r.whales[0].to === null);
    check('degraded: contract creation still a watch hit', r.watchHits.length === 1);
}

// --- determinism ----------------------------------------------------------------
{
    const txs = [{ hash: '0x1', from: A, to: B, value: hex(150n * ETH) }];
    const a = JSON.stringify(scanBlockTxs(txs, { chain: 'ethereum', watch: [B] }));
    const b = JSON.stringify(scanBlockTxs(txs, { chain: 'ethereum', watch: [B] }));
    check('deterministic across calls', a === b);
}

/* --- ERC-20 whale scanning -------------------------------------------------
   Most large value on Ethereum moves as stablecoins, so these transfers are
   the bulk of "where the money went". The traps encoded here: a 6-decimal
   token read as 18 understates a $4M move by a factor of a trillion, and an
   ERC-721 log has the same topic0 as an ERC-20 one. */
{
    const { TRANSFER_TOPIC, topicToAddress, formatTokenAmount, scanTokenLogs } = pkg;
    const pad = (addr) => '0x' + '0'.repeat(24) + addr.slice(2);
    const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
    const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
    const TOKENS = {
        [USDC]: { symbol: 'USDC', decimals: 6 },
        [WETH]: { symbol: 'WETH', decimals: 18 },
    };
    const PRICES = { USDC: 1.0, WETH: 1941.69 };
    const log = (over = {}) => ({
        address: USDC,
        topics: [TRANSFER_TOPIC, pad(A), pad(B)],
        data: hex(4_000_000n * 10n ** 6n), // 4,000,000 USDC
        transactionHash: '0xdead',
        ...over,
    });

    check('topic->address: 32-byte left-padded topic decodes', topicToAddress(pad(A)) === A);
    check('topic->address: junk returns null, never a truncated address',
        topicToAddress('0x1234') === null && topicToAddress(null) === null);

    check('token fmt: 6-decimal token is not read as 18',
        formatTokenAmount(4_000_000n * 10n ** 6n, 6) === '4,000,000');
    check('token fmt: 18-decimal token', formatTokenAmount(25n * 10n ** 17n, 18) === '2.5');
    check('token fmt: sub-unit dust keeps a value, never rounds to 0 silently',
        formatTokenAmount(1n, 6, 6) === '0.000001');
    check('token fmt: garbage -> 0, no throw', formatTokenAmount('nope', 6) === '0');

    {
        const { whales } = scanTokenLogs([log()], { tokens: TOKENS, prices: PRICES, minUsd: 1000000 });
        check('token whale: $4M USDC transfer is caught', whales.length === 1);
        check('token whale: amount exact at the right decimals', whales[0].amount === '4,000,000');
        check('token whale: raw units preserved as a string', whales[0].raw === '4000000000000');
        check('token whale: usd derived from the measured price', whales[0].usd === 4000000);
        check('token whale: both parties reported', whales[0].from === A && whales[0].to === B);
        check('token whale: symbol and contract both reported',
            whales[0].symbol === 'USDC' && whales[0].contract === USDC);
    }

    check('token whale: below threshold stays silent',
        scanTokenLogs([log({ data: hex(1000n * 10n ** 6n) })], { tokens: TOKENS, prices: PRICES }).whales.length === 0);

    check('token whale: an unknown contract is ignored, not priced by guess',
        scanTokenLogs([log({ address: '0x9999999999999999999999999999999999999999' })],
            { tokens: TOKENS, prices: PRICES }).whales.length === 0);

    check('token whale: ERC-721 (4 topics) is not a value transfer',
        scanTokenLogs([log({ topics: [TRANSFER_TOPIC, pad(A), pad(B), pad(C)], data: '0x' })],
            { tokens: TOKENS, prices: PRICES }).whales.length === 0);

    check('token whale: a non-Transfer log is skipped',
        scanTokenLogs([log({ topics: ['0x' + '1'.repeat(64), pad(A), pad(B)] })],
            { tokens: TOKENS, prices: PRICES }).whales.length === 0);

    check('token whale: zero-value transfer ignored',
        scanTokenLogs([log({ data: '0x0' })], { tokens: TOKENS, prices: PRICES }).whales.length === 0);

    {
        // No price -> significance cannot be judged in dollars. Silence unless
        // the caller supplied a raw floor.
        const noPrice = scanTokenLogs([log()], { tokens: TOKENS, prices: {} });
        check('token whale: unpriced token is not announced on a guess', noPrice.whales.length === 0);
        const floored = scanTokenLogs([log()], { tokens: TOKENS, prices: {}, minAmount: { USDC: 1_000_000n * 10n ** 6n } });
        check('token whale: unpriced token uses the raw floor when given',
            floored.whales.length === 1 && floored.whales[0].usd === null);
    }

    {
        const hits = scanTokenLogs([log(), log({ topics: [TRANSFER_TOPIC, pad(C), pad(A)], data: hex(5n * 10n ** 6n) })],
            { tokens: TOKENS, prices: PRICES, watch: [A] }).watchHits;
        check('token watch: both directions caught regardless of size', hits.length === 2);
        check('token watch: direction out when the watched address sends',
            hits[0].direction === 'out' && hits[0].watched === A);
        check('token watch: direction in when it receives',
            hits[1].direction === 'in' && hits[1].watched === A);
        check('token watch: small transfers still reported for a watched address',
            hits[1].amount === '5');
    }

    check('token whale: garbage input -> empty, never throws',
        scanTokenLogs(null).whales.length === 0 && scanTokenLogs([null, {}, { topics: [] }]).whales.length === 0);

    {
        const a = JSON.stringify(scanTokenLogs([log()], { tokens: TOKENS, prices: PRICES, watch: [B] }));
        const b = JSON.stringify(scanTokenLogs([log()], { tokens: TOKENS, prices: PRICES, watch: [B] }));
        check('token scan: deterministic across calls', a === b);
    }

    /* --- per-transaction aggregation --------------------------------------
       Regression tests for a bug caught by a live drill, not by unit fixtures:
       one arbitrage tx moved 14,050 WETH through three hops and the stream
       announced "$27 million" three times. */
    {
        const { aggregateTokenWhales } = pkg;
        const D = '0xdddddddddddddddddddddddddddddddddddddddd';
        const hop = (from, to, units, over = {}) => ({
            chain: 'ethereum', kind: 'token', hash: '0xsame', contract: USDC, symbol: 'USDC',
            decimals: 6, from, to, raw: String(units * 1000000n),
            amount: formatTokenAmount(units * 1000000n, 6), usd: Number(units), ...over,
        });

        const route = aggregateTokenWhales([hop(A, B, 4000000n), hop(B, C, 4000000n), hop(C, D, 4000000n)]);
        check('aggregate: a three-hop route is ONE movement', route.length === 1);
        check('aggregate: reports the true source and final destination',
            route[0].from === A && route[0].to === D);
        check('aggregate: amount is what left the source, not the sum of hops',
            route[0].amount === '4,000,000' && route[0].usd === 4000000);
        check('aggregate: hop count is kept as context', route[0].hops === 3);
        check('aggregate: a straight route is not a round trip', route[0].roundTrip === false);

        const cycle = aggregateTokenWhales([hop(A, B, 1000000n), hop(B, A, 1000000n)]);
        check('aggregate: money returning to its origin is flagged as a round trip',
            cycle.length === 1 && cycle[0].roundTrip === true);

        const twoTx = aggregateTokenWhales([hop(A, B, 2000000n), hop(A, B, 3000000n, { hash: '0xother' })]);
        check('aggregate: separate transactions stay separate', twoTx.length === 2);
        check('aggregate: output ordered biggest first', twoTx[0].usd === 3000000);

        const twoTokens = aggregateTokenWhales([
            hop(A, B, 2000000n),
            { ...hop(A, B, 5n), contract: WETH, symbol: 'WETH', decimals: 18, raw: String(5n * 10n ** 18n), amount: '5', usd: 9708 },
        ]);
        check('aggregate: two tokens in one tx are two movements', twoTokens.length === 2);

        check('aggregate: single transfer passes through unchanged in value',
            aggregateTokenWhales([hop(A, B, 7000000n)])[0].amount === '7,000,000');
        check('aggregate: empty/garbage input is safe',
            aggregateTokenWhales([]).length === 0 && aggregateTokenWhales(null).length === 0);
        check('aggregate: deterministic across calls', (() => {
            const rows = [hop(A, B, 4000000n), hop(B, C, 4000000n)];
            return JSON.stringify(aggregateTokenWhales(rows)) === JSON.stringify(aggregateTokenWhales([...rows].reverse()));
        })());
    }

    /* --- issuance (mint/burn) --------------------------------------------- */
    {
        const { scanIssuanceLogs, summarizeIssuance, ZERO_ADDRESS } = pkg;
        const iss = (from, to, units, over = {}) => ({
            address: USDC,
            topics: [TRANSFER_TOPIC, pad(from), pad(to)],
            data: hex(units * 1000000n),
            transactionHash: '0xiss',
            blockNumber: '0x1863a94',
            ...over,
        });

        const mints = scanIssuanceLogs([iss(ZERO_ADDRESS, A, 5000000n)], { tokens: TOKENS });
        check('issuance: transfer from 0x0 is a mint', mints.length === 1 && mints[0].kind === 'mint');
        check('issuance: mint amount exact at token decimals', mints[0].amount === '5,000,000');
        check('issuance: counterparty is where the new supply landed', mints[0].counterparty === A);
        check('issuance: block number decoded', mints[0].blockNumber === 0x1863a94);

        const burns = scanIssuanceLogs([iss(A, ZERO_ADDRESS, 7500000n)], { tokens: TOKENS });
        check('issuance: transfer to 0x0 is a burn', burns.length === 1 && burns[0].kind === 'burn');
        check('issuance: burn counterparty is who burned it', burns[0].counterparty === A);

        check('issuance: an ordinary transfer is not an issuance event',
            scanIssuanceLogs([iss(A, B, 9000000n)], { tokens: TOKENS }).length === 0);
        check('issuance: below the treasury threshold is ignored',
            scanIssuanceLogs([iss(ZERO_ADDRESS, A, 500n)], { tokens: TOKENS }).length === 0);
        check('issuance: threshold is configurable',
            scanIssuanceLogs([iss(ZERO_ADDRESS, A, 500n)], { tokens: TOKENS, minAmount: 100 }).length === 1);
        check('issuance: unknown contract ignored',
            scanIssuanceLogs([iss(ZERO_ADDRESS, A, 5000000n, { address: '0x9999999999999999999999999999999999999999' })], { tokens: TOKENS }).length === 0);
        check('issuance: garbage is safe',
            scanIssuanceLogs(null).length === 0 && scanIssuanceLogs([{}, null]).length === 0);
        check('issuance: largest first', (() => {
            const rows = scanIssuanceLogs([iss(ZERO_ADDRESS, A, 2000000n), iss(ZERO_ADDRESS, B, 9000000n, { transactionHash: '0xb' })], { tokens: TOKENS });
            return rows[0].units === 9000000;
        })());

        const sum = summarizeIssuance([
            { symbol: 'USDC', kind: 'mint', units: 5000000 },
            { symbol: 'USDC', kind: 'mint', units: 1000000 },
            { symbol: 'USDC', kind: 'burn', units: 7500000 },
            { symbol: 'USDT', kind: 'mint', units: 3000000 },
        ]);
        check('issuance summary: nets mints against burns per token',
            sum.USDC.minted === 6000000 && sum.USDC.burned === 7500000 && sum.USDC.net === -1500000);
        check('issuance summary: counts events', sum.USDC.mints === 2 && sum.USDC.burns === 1);
        check('issuance summary: tracks the largest single event', sum.USDC.largest.units === 7500000);
        check('issuance summary: tokens kept separate', sum.USDT.net === 3000000);
        check('issuance summary: empty input is safe', Object.keys(summarizeIssuance([])).length === 0);
    }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
