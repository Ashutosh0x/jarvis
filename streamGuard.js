// ---------------------------------------------------------------------------
// Stream operational guards — the pure decision logic that makes a long-lived
// chain stream trustworthy: reconnect pacing, duplicate suppression, block
// continuity, and alert prioritisation. CJS at root (rpcHedge.js pattern) so
// the Electron main process can require it; no I/O, no sockets, no ambient
// clock — time and randomness are injected, so every behaviour is testable.
//
// Why each exists:
//   * backoffDelay  — a fixed 10s reconnect hammers a struggling endpoint and
//     synchronises with every other client that dropped at the same moment;
//     exponential growth plus jitter fixes both.
//   * createDedup   — providers can replay the latest block after a reconnect,
//     and a backfill can overlap the live head. Announcing the same whale
//     twice teaches the user to distrust every announcement.
//   * createBlockTracker — a reconnect silently skips blocks. Whether the gap
//     is backfilled or declared lost, it must first be DETECTED; a monitor
//     that doesn't know what it missed isn't a monitor.
//   * prioritizeAlerts — a busy block can hold a dozen qualifying transfers.
//     A voice assistant that narrates twelve alerts back to back is worse
//     than silent; it should speak the few that matter and summarise the rest.
// ---------------------------------------------------------------------------

/**
 * Exponential backoff with full jitter (AWS-style: delay in [0, min(cap,
 * base*2^attempt)]), floored so a reconnect never fires instantly.
 *
 * @param {number} attempt 0-based consecutive failure count
 * @param {{baseMs?:number, capMs?:number, floorMs?:number, rand?:()=>number}} [opts]
 * @returns {number} milliseconds to wait
 */
function backoffDelay(attempt, opts = {}) {
    const baseMs = opts.baseMs ?? 2000;
    const capMs = opts.capMs ?? 120000;
    const floorMs = opts.floorMs ?? 1000;
    const rand = opts.rand ?? Math.random;
    const n = Number.isFinite(attempt) && attempt > 0 ? Math.min(attempt, 30) : 0;
    const ceiling = Math.min(capMs, baseMs * 2 ** n);
    return Math.max(floorMs, Math.floor(rand() * ceiling));
}

/**
 * TTL'd LRU set for duplicate suppression, keyed by whatever the caller
 * considers identity (here: `${chain}:${txHash}:${kind}`).
 *
 * `seen(key)` answers "have I processed this recently?" AND marks it — one
 * call, no check-then-set race. Bounded by both entry count and TTL so memory
 * stays flat over weeks of streaming.
 */
function createDedup(opts = {}) {
    const ttlMs = opts.ttlMs ?? 10 * 60 * 1000;
    const max = opts.max ?? 2048;
    const now = opts.now ?? Date.now;
    const map = new Map(); // key -> expiry; Map iteration order gives LRU-ish eviction

    return {
        seen(key) {
            const t = now();
            const exp = map.get(key);
            if (exp !== undefined && exp > t) {
                // Refresh recency so a hot key is not evicted while active.
                map.delete(key); map.set(key, t + ttlMs);
                return true;
            }
            map.delete(key);
            map.set(key, t + ttlMs);
            // Evict expired first, then oldest, so the bound holds.
            if (map.size > max) {
                for (const [k, e] of map) {
                    if (map.size <= max) break;
                    if (e <= t || true) map.delete(k); // oldest-first regardless
                    if (map.size <= max) break;
                }
            }
            return false;
        },
        get size() { return map.size; },
    };
}

/**
 * Block continuity tracker. Feed it every head number as it arrives; it says
 * whether the head is a duplicate/reorg-replay and which block numbers were
 * skipped since the last one seen.
 *
 * The gap list is CAPPED: after a long outage the right move is to declare
 * blocks lost, not replay an hour of history through the announcement path.
 *
 * @param {{maxGap?: number}} [opts]
 */
function createBlockTracker(opts = {}) {
    const maxGap = opts.maxGap ?? 5;
    let last = null;
    let missedTotal = 0;

    return {
        /**
         * @param {number} blockNumber
         * @returns {{duplicate:boolean, gap:number[], lost:number}}
         *   gap  – missed block numbers to backfill (oldest first, ≤ maxGap)
         *   lost – how many further blocks were skipped beyond the cap
         */
        next(blockNumber) {
            const n = Number(blockNumber);
            if (!Number.isFinite(n)) return { duplicate: true, gap: [], lost: 0 };
            if (last === null) { last = n; return { duplicate: false, gap: [], lost: 0 }; }
            if (n <= last) return { duplicate: true, gap: [], lost: 0 };

            const skipped = n - last - 1;
            let gap = [];
            let lost = 0;
            if (skipped > 0) {
                // Backfill the most RECENT missed blocks; older ones are lost.
                const from = Math.max(last + 1, n - maxGap);
                for (let b = from; b < n; b++) gap.push(b);
                lost = skipped - gap.length;
                missedTotal += skipped;
            }
            last = n;
            return { duplicate: false, gap, lost };
        },
        get lastBlock() { return last; },
        get missedTotal() { return missedTotal; },
    };
}

/**
 * Decides which whale alerts deserve a voice and which collapse into one
 * summary. Watch hits are NOT passed through here — the user explicitly asked
 * about those addresses, so they always speak.
 *
 * Rule: up to `maxSpoken` whales speak individually (largest first). Anything
 * beyond that becomes a single summary carrying the count and the largest
 * remaining transfer, so a burst block costs one sentence, not twelve.
 *
 * @param {Array<{valueWei:string}>} whales
 * @param {{maxSpoken?: number}} [opts]
 * @returns {{speak: Array, summary: null | {count:number, largest:object}}}
 */
function prioritizeAlerts(whales, opts = {}) {
    const maxSpoken = opts.maxSpoken ?? 2;
    if (!Array.isArray(whales) || !whales.length) return { speak: [], summary: null };

    const sorted = [...whales].sort((a, b) => {
        const av = BigInt(a.valueWei || '0'), bv = BigInt(b.valueWei || '0');
        return av === bv ? 0 : (av > bv ? -1 : 1);
    });
    if (sorted.length <= maxSpoken) return { speak: sorted, summary: null };
    const speak = sorted.slice(0, maxSpoken);
    const rest = sorted.slice(maxSpoken);
    return { speak, summary: { count: rest.length, largest: rest[0] } };
}

module.exports = { backoffDelay, createDedup, createBlockTracker, prioritizeAlerts };
