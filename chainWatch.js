// ---------------------------------------------------------------------------
// Chain-stream decisions — the pure logic behind whale alerts and address
// watching. Runs in the main process (CJS, like rpcHedge.js) but holds no I/O,
// no sockets and no clock, so every decision is unit-testable.
//
// Scope, stated plainly:
//   * A "whale" here means a NATIVE-value transfer at or above a per-chain
//     threshold, read directly from block transactions. That is on-chain fact.
//   * ERC-20 whale detection would need receipt/log scanning for every block
//     and per-token USD pricing — deliberately out of scope for a keyless
//     streamer.
//   * No entity attribution happens here. Who an address belongs to is not
//     on-chain data; callers may decorate results with the user's own labels
//     or an attributed external source, but this module never guesses.
// ---------------------------------------------------------------------------

/** Per-chain native-value alert thresholds, in wei. */
const WHALE_THRESHOLDS = {
    // 100 ETH — large enough that mainnet fires a handful of times a day,
    // not once a minute. POL is orders of magnitude cheaper, hence the gap.
    ethereum: 100n * 10n ** 18n,
    arbitrum: 100n * 10n ** 18n,
    base: 100n * 10n ** 18n,
    optimism: 100n * 10n ** 18n,
    polygon: 500000n * 10n ** 18n,
};

/** Wei (hex or bigint) → decimal native-unit string, exact, max 4 dp shown. */
function formatWeiNative(wei) {
    let v;
    try { v = typeof wei === 'bigint' ? wei : BigInt(wei || '0x0'); }
    catch { return '0'; }
    if (v < 0n) return '0';
    const base = 10n ** 18n;
    const whole = v / base;
    let frac = (v % base).toString().padStart(18, '0').slice(0, 4).replace(/0+$/, '');
    const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return frac ? `${wholeStr}.${frac}` : wholeStr;
}

const shortAddr = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : 'contract creation');

/**
 * Scans one block's transactions for whale transfers and watchlist activity.
 *
 * Pure: input is the block's tx array plus configuration, output is what to
 * announce. A transaction can be BOTH a whale and a watch hit — it appears in
 * both lists, because the user asked two different questions of it.
 *
 * @param {Array<{hash:string, from?:string, to?:string|null, value?:string}>} txs
 * @param {{chain?: string, thresholdWei?: bigint, watch?: Iterable<string>}} [opts]
 * @returns {{whales: Array<object>, watchHits: Array<object>}}
 */
function scanBlockTxs(txs, opts = {}) {
    const chain = opts.chain || 'ethereum';
    const threshold = opts.thresholdWei ?? WHALE_THRESHOLDS[chain] ?? WHALE_THRESHOLDS.ethereum;
    const watch = new Set([...(opts.watch || [])].map((a) => String(a).toLowerCase()));

    const whales = [];
    const watchHits = [];
    if (!Array.isArray(txs)) return { whales, watchHits };

    for (const tx of txs) {
        if (!tx || typeof tx !== 'object') continue;
        let value;
        try { value = BigInt(tx.value || '0x0'); } catch { continue; }
        const from = tx.from ? String(tx.from).toLowerCase() : null;
        const to = tx.to ? String(tx.to).toLowerCase() : null;

        if (value >= threshold) {
            whales.push({
                chain,
                hash: tx.hash,
                from,
                to,
                valueWei: value.toString(),
                amount: formatWeiNative(value),
            });
        }

        if (watch.size) {
            const hitFrom = from && watch.has(from);
            const hitTo = to && watch.has(to);
            if (hitFrom || hitTo) {
                watchHits.push({
                    chain,
                    hash: tx.hash,
                    from,
                    to,
                    watched: hitFrom ? from : to,
                    direction: hitFrom ? 'out' : 'in',
                    valueWei: value.toString(),
                    amount: formatWeiNative(value),
                });
            }
        }
    }
    return { whales, watchHits };
}

module.exports = { WHALE_THRESHOLDS, formatWeiNative, shortAddr, scanBlockTxs };
