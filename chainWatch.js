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
                    /* A transfer BETWEEN two watched addresses is one event that
                       concerns both, not an outgoing one. Reporting it as 'out'
                       hid that the receiver was also on the watchlist. */
                    direction: hitFrom && hitTo ? 'both' : (hitFrom ? 'out' : 'in'),
                    ...(hitFrom && hitTo ? { watchedCounterparty: to } : {}),
                    valueWei: value.toString(),
                    amount: formatWeiNative(value),
                });
            }
        }
    }
    return { whales, watchHits };
}

/* ---------------------------------------------------------------------------
   ERC-20 whale transfers.

   The scope note above said token detection was out of reach for a KEYLESS
   streamer, and that was accurate: it needs a log query per block plus a price
   per token. With a keyed endpoint both are affordable, so the restriction is
   lifted — and it matters, because most large value on Ethereum moves as
   stablecoins, not as native ETH. A native-only whale watch reports a small
   and unrepresentative slice of "where the money went".

   Still pure: callers hand in logs, the token table they VERIFIED on-chain,
   and prices they measured. Nothing here fetches, guesses a decimal count, or
   attributes an address to a company.
--------------------------------------------------------------------------- */

/** keccak256("Transfer(address,address,uint256)") — verified in onchain.js. */
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/** A 32-byte topic holding a left-padded address -> the address. */
function topicToAddress(topic) {
    const t = String(topic || '');
    if (!/^0x[0-9a-fA-F]{64}$/.test(t)) return null;
    return ('0x' + t.slice(26)).toLowerCase();
}

/** Exact token amount -> decimal string, trailing zeros trimmed, no floats. */
function formatTokenAmount(raw, decimals, maxFrac = 2) {
    let v;
    try { v = typeof raw === 'bigint' ? raw : BigInt(raw || '0'); } catch { return '0'; }
    if (v < 0n) return '0';
    const d = Number.isInteger(decimals) && decimals >= 0 ? decimals : 0;
    const base = 10n ** BigInt(d);
    const whole = (v / base).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    if (!d || maxFrac === 0) return whole;
    const frac = (v % base).toString().padStart(d, '0').slice(0, maxFrac).replace(/0+$/, '');
    return frac ? `${whole}.${frac}` : whole;
}

/**
 * Scan one block's Transfer logs for large token movements.
 *
 * @param {Array<{address?:string, topics?:string[], data?:string, transactionHash?:string}>} logs
 * @param {{
 *   chain?: string,
 *   tokens?: Record<string, {symbol: string, decimals: number}>,  // keyed by contract, VERIFIED on-chain
 *   prices?: Record<string, number>,                              // symbol -> USD, measured
 *   minUsd?: number,
 *   minAmount?: Record<string, bigint>,                           // symbol -> raw units, used when unpriced
 *   watch?: Iterable<string>,
 * }} [opts]
 * @returns {{whales: Array<object>, watchHits: Array<object>}}
 */
function scanTokenLogs(logs, opts = {}) {
    const chain = opts.chain || 'ethereum';
    const tokens = opts.tokens || {};
    const prices = opts.prices || {};
    const minUsd = Number.isFinite(opts.minUsd) ? opts.minUsd : 1000000;
    const minAmount = opts.minAmount || {};
    const watch = new Set([...(opts.watch || [])].map((a) => String(a).toLowerCase()));

    const whales = [];
    const watchHits = [];
    /* Every valid transfer, threshold or not. aggregateTokenWhales needs the
       WHOLE hop graph to find a movement's real source and destination — fed
       only the hops that individually cleared the floor, it reported a route
       as ending at whichever hop happened to be the last big one. */
    const transfers = [];
    if (!Array.isArray(logs)) return { whales, watchHits, transfers };

    for (const log of logs) {
        if (!log || !Array.isArray(log.topics)) continue;
        if (String(log.topics[0] || '').toLowerCase() !== TRANSFER_TOPIC) continue;
        // A 3-topic Transfer is ERC-20; a 4-topic one is ERC-721 (tokenId in the
        // last topic, no amount in data) and is not a value transfer.
        if (log.topics.length !== 3) continue;

        const contract = String(log.address || '').toLowerCase();
        const meta = tokens[contract];
        if (!meta) continue; // only tokens the caller verified

        const from = topicToAddress(log.topics[1]);
        const to = topicToAddress(log.topics[2]);
        let raw;
        try { raw = BigInt(log.data || '0x0'); } catch { continue; }
        if (raw <= 0n) continue;

        const price = Number.isFinite(prices[meta.symbol]) ? prices[meta.symbol] : null;
        // USD is computed from the exact amount, but only for the THRESHOLD and
        // for display — the token amount itself is never derived from a float.
        const approx = Number(raw) / Math.pow(10, meta.decimals);
        const usd = price != null ? approx * price : null;

        const big = usd != null
            ? usd >= minUsd
            // Unpriced token: fall back to a raw-unit floor if the caller gave
            // one, otherwise stay silent rather than invent significance.
            : (minAmount[meta.symbol] != null && raw >= minAmount[meta.symbol]);

        const row = {
            chain, kind: 'token',
            hash: log.transactionHash || null,
            contract,
            symbol: meta.symbol,
            decimals: meta.decimals,
            from, to,
            raw: raw.toString(),
            amount: formatTokenAmount(raw, meta.decimals),
            usd: usd != null ? Math.round(usd) : null,
        };

        transfers.push(row);
        if (big) whales.push(row);

        if (watch.size) {
            const hitFrom = from && watch.has(from);
            const hitTo = to && watch.has(to);
            if (hitFrom || hitTo) {
                watchHits.push({
                    ...row,
                    watched: hitFrom ? from : to,
                    /* Both parties watched: one hit that says so, rather than
                       silently reporting only the sending side. */
                    direction: hitFrom && hitTo ? 'both' : (hitFrom ? 'out' : 'in'),
                    ...(hitFrom && hitTo ? { watchedCounterparty: to } : {}),
                });
            }
        }
    }
    return { whales, watchHits, transfers };
}

/**
 * Collapse the transfers of one transaction into the movements they represent.
 *
 * Found by running the scanner against live mainnet blocks: a single arbitrage
 * transaction emitted the same 14,050 WETH three times (pool -> router -> pool
 * -> recipient), and the stream announced "$27 million moved" three times. That
 * is one movement taking three hops, and reporting it as three is misinformation
 * about how much money moved.
 *
 * WHY THIS IS NOT "one row per (tx, token)", which is what it used to be.
 * Collapsing every transaction to a single source and sink assumes each one
 * carries exactly one logical movement. Batch transactions break that, and they
 * are common — payouts, airdrops, disperse contracts, exchange sweeps:
 *
 *   * FAN-OUT. A pays B 5M, C 4M and D 3M in one transaction. Picking one
 *     source and one sink reported "A -> B, 12M": B is credited with money it
 *     never received and C and D vanish from the output entirely.
 *   * TWO UNRELATED MOVEMENTS batched together. A -> B 2M and C -> D 9M share
 *     only a transaction hash. The old code emitted the larger pair and DROPPED
 *     the smaller movement — silent data loss, not merely a mislabel.
 *
 * So the transfers are first split into CONNECTED COMPONENTS by address: two
 * transfers belong to the same movement only if they actually share a party.
 * A component is then collapsed only when collapsing is truthful:
 *
 *   * one pure sender and one pure receiver -> a chain; the intermediates are
 *     the route, so it collapses to source -> sink for what left the source.
 *   * nobody pure -> the money returned to where it started; reported as a
 *     round trip rather than dressed up as a transfer between two parties.
 *   * anything else (fan-out, fan-in, mixed) -> NOT collapsed. Each transfer is
 *     reported as itself, tagged with how many transfers shared the
 *     transaction, because inventing a single pair would misstate who was paid.
 *
 * @param {Array<object>} rows  per-transfer rows from scanTokenLogs
 * @param {{minUsd?: number, minAmount?: Record<string, bigint>}} [opts]
 *   Applied AFTER aggregation. Thresholding before this point hid hops from the
 *   graph and produced the wrong destination: for A -> B -> C -> D where the
 *   last hop was under the floor, the movement was reported as ending at C.
 * @returns {Array<object>} one row per movement
 */
function aggregateTokenWhales(rows, opts = {}) {
    if (!Array.isArray(rows) || !rows.length) return [];
    const groups = new Map();
    for (const r of rows) {
        const key = `${r.hash}:${r.contract}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r);
    }

    const out = [];
    for (const [, hops] of groups) {
        for (const comp of splitTransferComponents(hops)) out.push(...collapseComponent(comp));
    }

    /* The floor belongs here, on the movement, not on the individual hops. */
    const minUsd = Number.isFinite(opts.minUsd) ? opts.minUsd : null;
    const minAmount = opts.minAmount || {};
    const kept = minUsd == null && !Object.keys(minAmount).length ? out : out.filter((r) => {
        if (r.usd != null) return minUsd == null || r.usd >= minUsd;
        const floor = minAmount[r.symbol];
        if (floor == null) return false;
        try { return BigInt(r.raw) >= floor; } catch { return false; }
    });

    // Stable output order: biggest first, hash as the tie-break.
    return kept.sort((a, b) => {
        const av = BigInt(a.raw || '0'), bv = BigInt(b.raw || '0');
        if (av !== bv) return av > bv ? -1 : 1;
        const h = String(a.hash || '').localeCompare(String(b.hash || ''));
        return h || String(a.to || '').localeCompare(String(b.to || ''));
    });
}

/**
 * Split one (tx, token)'s transfers into groups that share at least one party.
 * Union-find over addresses: transfers that never touch a common address are
 * separate movements that happen to share a transaction.
 */
function splitTransferComponents(hops) {
    if (hops.length === 1) return [hops];
    const parent = new Map();
    const find = (x) => {
        if (!parent.has(x)) parent.set(x, x);
        while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); }
        return x;
    };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };

    // A null party (unparseable topic) is unique to its own transfer, so it can
    // never merge two movements that share nothing else.
    const partyOf = (h, side, i) => h[side] || ` ${side}${i}`;
    hops.forEach((h, i) => union(partyOf(h, 'from', i), partyOf(h, 'to', i)));

    const byRoot = new Map();
    hops.forEach((h, i) => {
        const root = find(partyOf(h, 'from', i));
        if (!byRoot.has(root)) byRoot.set(root, []);
        byRoot.get(root).push(h);
    });
    /* Deterministic component order: largest transfer first, then hash. */
    return [...byRoot.values()].sort((a, b) => {
        const av = BigInt(a[0]?.raw || '0'), bv = BigInt(b[0]?.raw || '0');
        return av === bv ? 0 : (av > bv ? -1 : 1);
    });
}

/** One component -> the movement(s) it truthfully represents. */
function collapseComponent(hops) {
    if (hops.length === 1) return [{ ...hops[0], hops: 1, roundTrip: false }];

    const sent = new Map(), received = new Map();
    for (const h of hops) {
        let raw; try { raw = BigInt(h.raw); } catch { raw = 0n; }
        if (h.from) sent.set(h.from, (sent.get(h.from) || 0n) + raw);
        if (h.to) received.set(h.to, (received.get(h.to) || 0n) + raw);
    }
    // Deterministic pick: largest mover first, address as the tie-break.
    const pick = (candidates) => [...candidates]
        .sort((a, b) => (a[1] === b[1] ? a[0].localeCompare(b[0]) : (a[1] > b[1] ? -1 : 1)))[0] || null;

    const pureSenders = [...sent].filter(([a]) => !received.has(a));
    const pureReceivers = [...received].filter(([a]) => !sent.has(a));

    const isChain = pureSenders.length === 1 && pureReceivers.length === 1;
    const isRoundTrip = pureSenders.length === 0 && pureReceivers.length === 0;

    /* Fan-out, fan-in or a mix: there is more than one counterparty on an
       unmatched side, so no single pair describes it. Report the transfers. */
    if (!isChain && !isRoundTrip) {
        return hops.map((h) => ({ ...h, hops: 1, roundTrip: false, batchOf: hops.length }));
    }

    const source = isChain ? pureSenders[0] : pick(sent);
    const sink = isChain ? pureReceivers[0] : pick(received);
    const moved = source ? (sent.get(source[0]) || 0n) : 0n;
    const template = hops[0];
    /* Price per raw unit, taken from a hop that HAS a price, so a template hop
       whose usd rounded away cannot zero out the movement's value. */
    const priced = hops.find((h) => {
        if (h.usd == null) return false;
        try { return BigInt(h.raw) > 0n; } catch { return false; }
    });
    const ratio = priced ? priced.usd / Number(BigInt(priced.raw)) : null;

    return [{
        ...template,
        from: source ? source[0] : template.from,
        to: sink ? sink[0] : template.to,
        raw: moved.toString(),
        amount: formatTokenAmount(moved, template.decimals),
        usd: ratio != null ? Math.round(ratio * Number(moved)) : template.usd,
        hops: hops.length,
        roundTrip: isRoundTrip,
    }];
}

/* ---------------------------------------------------------------------------
   Stablecoin issuance — mints and burns.

   An ERC-20 mint is a Transfer FROM the zero address and a burn is a Transfer
   TO it. That is not a heuristic or an attribution: it is how supply changes on
   chain, and it is the one "Circle/Tether did something" signal that needs no
   label database and no trust in anyone's naming. What it does NOT tell you is
   who requested the mint, so nothing here claims a reason.

   Verified live before this was written: 105 USDC mints and 78 burns in one
   hour of mainnet, largest single burn 7,500,000 USDC.
--------------------------------------------------------------------------- */
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * @param {Array<object>} logs raw Transfer logs
 * @param {{tokens?: object, minAmount?: number, chain?: string}} [opts]
 *   minAmount is in whole tokens (1,000,000 USDC), because issuance is watched
 *   at treasury scale and a stablecoin's unit IS its dollar.
 * @returns {Array<{kind:'mint'|'burn', symbol, amount, raw, units, counterparty, hash}>}
 */
function scanIssuanceLogs(logs, opts = {}) {
    const tokens = opts.tokens || {};
    const minAmount = Number.isFinite(opts.minAmount) ? opts.minAmount : 1000000;
    const chain = opts.chain || 'ethereum';
    const out = [];
    if (!Array.isArray(logs)) return out;

    for (const log of logs) {
        if (!log || !Array.isArray(log.topics) || log.topics.length !== 3) continue;
        if (String(log.topics[0] || '').toLowerCase() !== TRANSFER_TOPIC) continue;
        const meta = tokens[String(log.address || '').toLowerCase()];
        if (!meta) continue;

        const from = topicToAddress(log.topics[1]);
        const to = topicToAddress(log.topics[2]);
        const isMint = from === ZERO_ADDRESS;
        const isBurn = to === ZERO_ADDRESS;
        // A transfer between two real addresses is not an issuance event, and a
        // 0x0 -> 0x0 transfer is neither (and does not occur).
        if (isMint === isBurn) continue;

        let raw;
        try { raw = BigInt(log.data || '0x0'); } catch { continue; }
        if (raw <= 0n) continue;
        const units = Number(raw) / Math.pow(10, meta.decimals);
        if (units < minAmount) continue;

        out.push({
            chain, kind: isMint ? 'mint' : 'burn',
            symbol: meta.symbol,
            contract: String(log.address).toLowerCase(),
            raw: raw.toString(),
            units,
            amount: formatTokenAmount(raw, meta.decimals, 0),
            // Where new supply landed, or which address burned it. On-chain
            // fact; whether that address is the issuer's treasury is not.
            counterparty: isMint ? to : from,
            hash: log.transactionHash || null,
            blockNumber: log.blockNumber ? parseInt(log.blockNumber, 16) : null,
        });
    }
    return out.sort((a, b) => (b.units - a.units) || String(a.hash || '').localeCompare(String(b.hash || '')));
}

/**
 * Net issuance per token over a set of events, for a spoken summary.
 *
 * `largest` is the biggest event of EITHER kind and was the only one reported,
 * so a summary that said "largest mint" could be quoting a burn — a 2M mint
 * alongside a 9M burn returned the burn. The two are now separate, and the
 * combined one is kept because it answers "what was the biggest thing that
 * happened", which is a different question.
 */
function summarizeIssuance(events) {
    const bySymbol = {};
    for (const e of events || []) {
        const s = (bySymbol[e.symbol] = bySymbol[e.symbol]
            || { minted: 0, burned: 0, mints: 0, burns: 0, largest: null, largestMint: null, largestBurn: null });
        const isMint = e.kind === 'mint';
        if (isMint) { s.minted += e.units; s.mints++; } else { s.burned += e.units; s.burns++; }
        const key = isMint ? 'largestMint' : 'largestBurn';
        if (!s[key] || e.units > s[key].units) s[key] = e;
        if (!s.largest || e.units > s.largest.units) s.largest = e;
    }
    for (const s of Object.values(bySymbol)) s.net = s.minted - s.burned;
    return bySymbol;
}

module.exports = {
    WHALE_THRESHOLDS, formatWeiNative, shortAddr, scanBlockTxs,
    TRANSFER_TOPIC, ZERO_ADDRESS, topicToAddress, formatTokenAmount, scanTokenLogs, aggregateTokenWhales,
    scanIssuanceLogs, summarizeIssuance,
};
