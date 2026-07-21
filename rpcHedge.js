// ---------------------------------------------------------------------------
// Hedged endpoint racing — tail-latency mitigation for keyless public RPC.
//
// MEASURED PROBLEM: rpcCall tried its endpoint list strictly sequentially with
// a 10s timeout each, so one dead endpoint cost 10s and three cost 30s. The
// interaction log contains exactly that: CHAIN_QUERY averaging 12.8s with a
// 30.0s worst case, on queries whose useful work is a single JSON-RPC read.
//
// Sequential failover optimises for the wrong thing. It minimises requests
// sent, but free public RPCs are neither scarce nor reliable, and the cost of
// a slow answer is paid by a user waiting to hear a number spoken aloud.
//
// So: start the first endpoint, and if it has not answered within a short
// hedge delay, start the next ALONGSIDE it rather than after it. First success
// wins and the rest are aborted. A failure launches the next immediately
// instead of waiting for the hedge timer. Worst case falls from
// n * timeout (30s) to hedge*(n-1) + timeout (~6.4s), and the common case is
// unchanged because a healthy first endpoint answers before the hedge fires.
//
// Kept free of Electron and fetch so the racing logic is unit-testable on its
// own; the caller supplies the work function.
// ---------------------------------------------------------------------------

/**
 * Races endpoints with staggered (hedged) starts, resolving on the first
 * success.
 *
 * @param {Array<T>} items endpoints to try, best-first
 * @param {(item: T, signal: AbortSignal) => Promise<R>} run work for one endpoint
 * @param {{hedgeAfterMs?: number, timeoutMs?: number}} [opts]
 * @returns {Promise<{value: R, item: T, index: number}>}
 * @template T, R
 */
function hedgedRace(items, run, opts = {}) {
    const hedgeAfterMs = opts.hedgeAfterMs ?? 1200;
    const timeoutMs = opts.timeoutMs ?? 4000;

    return new Promise((resolve, reject) => {
        if (!Array.isArray(items) || !items.length) {
            reject(new Error('no endpoints configured'));
            return;
        }

        let settled = false;
        let launched = 0;
        let failed = 0;
        let lastErr = 'none';
        const controllers = [];
        const timers = [];

        const cleanup = () => {
            timers.forEach(clearTimeout);
            // Abort the losers so their sockets are not left hanging.
            controllers.forEach((c) => { try { c.abort(); } catch { /* already gone */ } });
        };

        const launch = () => {
            if (settled || launched >= items.length) return;
            const index = launched++;
            const item = items[index];

            const ac = new AbortController();
            controllers.push(ac);
            const killer = setTimeout(() => { try { ac.abort(); } catch { /* noop */ } }, timeoutMs);
            timers.push(killer);

            Promise.resolve()
                .then(() => run(item, ac.signal))
                .then(
                    (value) => {
                        clearTimeout(killer);
                        if (settled) return;
                        settled = true;
                        cleanup();
                        resolve({ value, item, index });
                    },
                    (err) => {
                        clearTimeout(killer);
                        if (settled) return;
                        failed++;
                        lastErr = `${item}: ${err && err.message ? err.message : String(err)}`;
                        if (failed >= items.length) {
                            settled = true;
                            cleanup();
                            reject(new Error(`all endpoints failed (${lastErr})`));
                            return;
                        }
                        // A failure is information: stop waiting on the hedge
                        // timer and bring the next endpoint up now.
                        launch();
                    },
                );

            // Stagger the next endpoint rather than queueing it behind this one.
            if (launched < items.length) {
                timers.push(setTimeout(launch, hedgeAfterMs));
            }
        };

        launch();
    });
}

/**
 * Remembers which endpoint last worked, per key, and promotes it to the front
 * of the list.
 *
 * Without this, an endpoint that is down stays first in the static list and
 * every single query pays the hedge delay again. With it, a chain that failed
 * over once keeps using the endpoint that actually answered.
 */
function createStickyOrder() {
    const lastGood = new Map();
    return {
        order(key, urls) {
            const preferred = lastGood.get(key);
            if (!preferred || !urls.includes(preferred)) return urls.slice();
            return [preferred, ...urls.filter((u) => u !== preferred)];
        },
        remember(key, url) { lastGood.set(key, url); },
        get(key) { return lastGood.get(key); },
        clear() { lastGood.clear(); },
    };
}

module.exports = { hedgedRace, createStickyOrder };
