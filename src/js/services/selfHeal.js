/**
 * Self-healing supervision for the local stack.
 *
 * Every outage in the interaction log for 21–30 Jul 2026 came from one of three
 * shapes, and none of them were bugs in the thing that failed:
 *
 *   1. A FIXED TIMEOUT that stopped matching the machine. rag.rerank was given
 *      6000ms because the call measured ~3s the day it was written. By 22 Jul
 *      the same call needed longer, and from then on it timed out 32 times out
 *      of 37 — a flat 6s tax on every ambiguous query, for a result that was
 *      always discarded. Nothing alerted, because failing back to the unreranked
 *      order is silent by design.
 *
 *   2. A LIVENESS CHECK THAT WATCHED THE WRONG SIGNAL. Ollama is auto-respawned
 *      on 'exit'. On 30 Jul it stopped answering while the process stayed up, so
 *      'exit' never fired, and two turns were answered with "the Ollama server
 *      is not responding" while the server sat there running. Process liveness
 *      is not service liveness.
 *
 *   3. A DIAGNOSIS THAT GUESSED. The user was told "it is usually memory
 *      pressure — closing a few Chrome tabs normally fixes it" while 9GB was
 *      free and the model was resident. The stage timings needed to say the
 *      true cause were already being recorded, and were not read.
 *
 * So: budgets are LEARNED from what this machine actually does, dependencies
 * that keep failing are STOPPED being called until they recover, health is
 * decided by PROBE rather than by process state, and the diagnosis is READ off
 * the measurements instead of guessed.
 *
 * Everything here is pure — no fetch, no timers owned, no DOM. Callers inject
 * the clock and the I/O so all of it is testable, which is why this file is
 * where the logic lives rather than inline at each call site.
 */

/* ---------------------------------------------------------------- budgets -- */

/**
 * A timeout that learns.
 *
 * Keeps the last `window` observed durations and sets the budget from a high
 * percentile times a safety factor. A machine that gets slower widens its own
 * deadline instead of failing forever at a number chosen on a faster day.
 *
 * Timeouts are recorded too, at the budget that was in force — otherwise a
 * budget that is too small can never learn that it is too small, because it
 * only ever observes durations it managed to fit inside. That feedback hole is
 * exactly how rerank stayed pinned at 6000ms for eight days.
 */
export class AdaptiveBudget {
    constructor({ name = 'budget', min = 1000, max = 60000, initial = null,
                  factor = 2, window = 20, percentile = 0.95 } = {}) {
        this.name = name;
        this.min = min;
        this.max = max;
        this.factor = factor;
        this.window = window;
        this.percentile = percentile;
        this.initial = clamp(initial ?? min * factor, min, max);
        this.samples = [];
    }

    /** Record a completed call. */
    record(ms) {
        if (!Number.isFinite(ms) || ms < 0) return;
        this.samples.push(ms);
        if (this.samples.length > this.window) this.samples.shift();
    }

    /**
     * Record a call that hit its deadline. The true duration is unknown — only
     * that it was AT LEAST the budget — so it counts as a sample at the budget
     * itself. Repeated timeouts therefore drag the percentile up and widen the
     * next budget, which is the whole point.
     */
    recordTimeout(budgetMs = this.value) {
        this.record(budgetMs);
    }

    /** Current deadline in ms. */
    get value() {
        // Too few samples to trust a percentile — a single slow cold start
        // would otherwise pin the budget at its ceiling for the whole window.
        if (this.samples.length < 3) return this.initial;
        const sorted = [...this.samples].sort((a, b) => a - b);
        const idx = Math.min(sorted.length - 1,
            Math.floor(this.percentile * (sorted.length - 1)));
        return clamp(Math.round(sorted[idx] * this.factor), this.min, this.max);
    }

    /** True when the budget has walked all the way to its ceiling. */
    get saturated() {
        return this.value >= this.max;
    }

    toJSON() {
        return { name: this.name, samples: this.samples };
    }

    /** Restore learned samples; unknown or corrupt input is ignored, not thrown. */
    load(state) {
        if (!state || !Array.isArray(state.samples)) return this;
        this.samples = state.samples
            .filter((n) => Number.isFinite(n) && n >= 0)
            .slice(-this.window);
        return this;
    }
}

/* --------------------------------------------------------------- breakers -- */

export const CLOSED = 'closed';
export const OPEN = 'open';
export const HALF_OPEN = 'half-open';

/**
 * Stops calling something that keeps failing.
 *
 * The reranker is the motivating case: an enhancement that is allowed to fail
 * silently must not be allowed to fail EXPENSIVELY. After `threshold`
 * consecutive failures the circuit opens and calls are skipped outright, which
 * turns a 6s tax into 0ms. A single probe is let through after a cooldown, so
 * recovery is automatic and needs no restart.
 *
 * The cooldown doubles on each failed probe up to `maxCooldownMs`, so a
 * dependency that is down for hours is retried on a sane cadence rather than
 * every minute forever.
 */
export class CircuitBreaker {
    constructor({ name = 'circuit', threshold = 3, cooldownMs = 60000,
                  maxCooldownMs = 900000, now = Date.now } = {}) {
        this.name = name;
        this.threshold = threshold;
        this.baseCooldownMs = cooldownMs;
        this.maxCooldownMs = maxCooldownMs;
        this._now = now;

        this.state = CLOSED;
        this.failures = 0;
        this.openedAt = 0;
        this.cooldownMs = cooldownMs;
        this.trips = 0;
    }

    /**
     * Whether a call may proceed. Transitions OPEN -> HALF_OPEN once the
     * cooldown has elapsed, so asking is what drives recovery — there is no
     * background timer to leak.
     */
    allow() {
        if (this.state === CLOSED) return true;
        if (this.state === HALF_OPEN) return true;
        if (this._now() - this.openedAt >= this.cooldownMs) {
            this.state = HALF_OPEN;
            return true;
        }
        return false;
    }

    onSuccess() {
        this.state = CLOSED;
        this.failures = 0;
        this.cooldownMs = this.baseCooldownMs;
    }

    onFailure() {
        // A failed probe re-opens immediately and backs off further: the
        // dependency has now failed twice with a wait in between.
        if (this.state === HALF_OPEN) {
            this.cooldownMs = Math.min(this.cooldownMs * 2, this.maxCooldownMs);
            this._open();
            return;
        }
        this.failures++;
        if (this.failures >= this.threshold) this._open();
    }

    _open() {
        if (this.state !== OPEN) this.trips++;
        this.state = OPEN;
        this.openedAt = this._now();
    }

    /** Human-readable state for the telemetry HUD. */
    describe() {
        if (this.state === CLOSED) return `${this.name}: healthy`;
        if (this.state === HALF_OPEN) return `${this.name}: probing`;
        const left = Math.max(0, this.cooldownMs - (this._now() - this.openedAt));
        return `${this.name}: disabled, retrying in ${Math.ceil(left / 1000)}s`;
    }
}

/* ----------------------------------------------------------------- health -- */

/**
 * Liveness by probe.
 *
 * `probe` must resolve truthy when the service is genuinely answering. Process
 * state is deliberately not consulted: the 30 Jul outage had a live process and
 * a dead service, and watching the process is what hid it.
 *
 * `heal` is invoked once when the service transitions to unhealthy, and is
 * expected to be idempotent — it may be called again on the next failed check
 * if the service is still down after `healCooldownMs`.
 */
export class ServiceHealth {
    constructor({ name, probe, heal = null, failureThreshold = 2,
                  healCooldownMs = 30000, now = Date.now } = {}) {
        this.name = name;
        this.probe = probe;
        this.heal = heal;
        this.failureThreshold = failureThreshold;
        this.healCooldownMs = healCooldownMs;
        this._now = now;

        this.healthy = true;
        this.consecutiveFailures = 0;
        /* null, not 0: with 0 the cooldown check below measures against the
           epoch, which suppresses the very FIRST heal whenever the injected
           clock starts near zero. Date.now() hides that, tests do not. */
        this.lastHealAt = null;
        this.healAttempts = 0;
        this.lastError = null;
    }

    /**
     * Run one health check, healing if the service has been failing. Returns
     * the current health. Never throws: a supervisor that can crash is not a
     * supervisor.
     */
    async check() {
        let ok = false;
        try {
            ok = !!(await this.probe());
        } catch (e) {
            this.lastError = e?.message || String(e);
            ok = false;
        }

        if (ok) {
            this.consecutiveFailures = 0;
            this.healthy = true;
            return true;
        }

        this.consecutiveFailures++;
        if (this.consecutiveFailures >= this.failureThreshold) {
            this.healthy = false;
            await this._maybeHeal();
        }
        return false;
    }

    async _maybeHeal() {
        if (!this.heal) return;
        // Rate-limited: without this a service that takes 20s to come back gets
        // a restart every check, and the restarts are why it never comes back.
        // The first heal is always allowed; only repeats are throttled.
        if (this.lastHealAt !== null &&
            this._now() - this.lastHealAt < this.healCooldownMs) return;
        this.lastHealAt = this._now();
        this.healAttempts++;
        try {
            await this.heal();
        } catch (e) {
            this.lastError = `heal failed: ${e?.message || e}`;
        }
    }
}

/* ---------------------------------------------------------------- retries -- */

/**
 * Run `fn`, and if it fails in a way that healing could plausibly fix, heal and
 * try again.
 *
 * Deliberately not a general retry loop: retrying a request that failed because
 * the model produced garbage just burns another 20s. `isTransient` decides, and
 * defaults to false so the caller has to opt in per error class.
 */
export async function withHealing(fn, { heal = null, isTransient = () => false,
                                        retries = 1, onRetry = null } = {}) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await fn(attempt);
        } catch (e) {
            lastError = e;
            if (attempt === retries || !isTransient(e)) throw e;
            if (onRetry) onRetry(e, attempt);
            if (heal) {
                try { await heal(e); } catch { /* healing is best-effort */ }
            }
        }
    }
    throw lastError;
}

/* ------------------------------------------------------------ diagnostics -- */

/**
 * Explain a local-inference failure from what was actually measured.
 *
 * Replaces a hardcoded guess. The rule is simple: name the stage that consumed
 * the time, and only mention memory when memory is genuinely implicated. Saying
 * "close some Chrome tabs" to a user with 9GB free trains them to ignore us.
 */
export function diagnoseLocalFailure({ stages = {}, error = null, health = null,
                                       freeMemoryGb = null } = {}) {
    const name = error?.name;
    const msg = String(error?.message || error || '');

    // A dead dependency outranks any timing detail.
    if (health && health.healthy === false) {
        const healing = health.healAttempts > 0
            ? ' I am restarting it now and will retry automatically.'
            : '';
        return `The ${health.name} service has stopped responding, Sir.${healing}`;
    }

    const slowest = slowestStage(stages);

    if (name === 'LocalTimeoutError' || /stalled|produced nothing/i.test(msg)) {
        if (slowest && slowest.key.startsWith('rag.')) {
            return `Retrieval took too long, Sir — ${describeStage(slowest)}. `
                + 'I have widened that budget and disabled the slow step for now, so the next answer should be quicker.';
        }
        if (Number.isFinite(freeMemoryGb) && freeMemoryGb < 2) {
            return `The local model ran out of time, Sir, and memory is genuinely tight `
                + `(${freeMemoryGb.toFixed(1)}GB free). Closing a few applications would help.`;
        }
        const detail = slowest ? ` — ${describeStage(slowest)}` : '';
        return `The local model did not produce an answer in time, Sir${detail}. `
            + 'I have widened its deadline, so it should have room on the next attempt.';
    }

    if (/50\d/.test(msg)) {
        return 'The local model failed to load, Sir. I am restarting it and will retry automatically.';
    }
    if (/fetch|network|ECONNREFUSED|Failed to fetch/i.test(msg)) {
        return 'I cannot reach the local model server, Sir. I am starting it now.';
    }
    return 'Local inference failed, Sir, so I have no answer for that rather than an invented one.';
}

/**
 * The stage that consumed the most time, ignoring the trivially fast ones.
 *
 * perf.snapshot() writes a stage as a bare number, or as { ms, calls } when it
 * fired more than once in a turn, so both shapes have to be understood here —
 * and the repeated case is exactly the interesting one, since a stage called
 * three times is a likely retry loop.
 */
export function slowestStage(stages = {}) {
    let best = null;
    for (const [key, raw] of Object.entries(stages || {})) {
        const ms = typeof raw === 'object' && raw !== null ? raw.ms : raw;
        if (!Number.isFinite(ms) || ms < 250) continue;
        if (!best || ms > best.ms) best = { key, ms };
    }
    return best;
}

function describeStage({ key, ms }) {
    const label = {
        'rag.rerank': 'reordering the retrieved passages',
        'rag.embed': 'embedding the question',
        'rag.lexical': 'the keyword search',
        'llm.firstToken': 'the model\'s first word',
        'llm.total': 'the model\'s answer',
        'intent': 'working out what you meant',
    }[key] || key;
    return `${label} took ${(ms / 1000).toFixed(1)}s`;
}

/* ------------------------------------------------------------------ utils -- */

function clamp(n, lo, hi) {
    return Math.min(hi, Math.max(lo, n));
}

/**
 * One registry so the HUD and the tests have a single place to read supervision
 * state from, rather than each subsystem exposing its own shape.
 */
export class HealthRegistry {
    constructor() {
        this.budgets = new Map();
        this.breakers = new Map();
        this.services = new Map();
    }

    budget(name, opts) {
        if (!this.budgets.has(name)) {
            this.budgets.set(name, new AdaptiveBudget({ name, ...opts }));
        }
        return this.budgets.get(name);
    }

    breaker(name, opts) {
        if (!this.breakers.has(name)) {
            this.breakers.set(name, new CircuitBreaker({ name, ...opts }));
        }
        return this.breakers.get(name);
    }

    service(name, opts) {
        if (!this.services.has(name)) {
            this.services.set(name, new ServiceHealth({ name, ...opts }));
        }
        return this.services.get(name);
    }

    /** Compact snapshot for the telemetry HUD and for `jarvis status`. */
    snapshot() {
        return {
            budgets: Object.fromEntries([...this.budgets].map(([k, b]) =>
                [k, { ms: b.value, samples: b.samples.length, saturated: b.saturated }])),
            breakers: Object.fromEntries([...this.breakers].map(([k, c]) =>
                [k, { state: c.state, trips: c.trips }])),
            services: Object.fromEntries([...this.services].map(([k, s]) =>
                [k, { healthy: s.healthy, healAttempts: s.healAttempts }])),
        };
    }

    /** Learned state worth surviving a restart — budgets only. */
    toJSON() {
        return {
            budgets: Object.fromEntries([...this.budgets].map(([k, b]) => [k, b.toJSON()])),
        };
    }

    load(state) {
        for (const [k, v] of Object.entries(state?.budgets || {})) {
            if (this.budgets.has(k)) this.budgets.get(k).load(v);
        }
        return this;
    }
}

/** Process-wide registry. */
export const health = new HealthRegistry();
