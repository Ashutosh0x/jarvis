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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
