// ---------------------------------------------------------------------------
// Per-stage turn profiler.
//
// The interaction log already answers "which command is slow" — that is how the
// 12.8s chain query and the 12.1s wifi lookup were found. It cannot answer
// "slow WHERE", so every diagnosis so far has needed a human to go read the
// handler and guess. This closes that gap: one turn produces one breakdown.
//
// Deliberately a module-level singleton rather than a context object threaded
// through every call site. Stages are recorded from ragService, toolService and
// jarvis alike, and rewriting those signatures to pass a profiler would be a
// far larger change than the telemetry is worth.
//
// Rules it must obey, because it runs on every turn including the voice path:
//   * never throw — a telemetry bug must not break a command;
//   * never await anything of its own;
//   * cost nothing measurable (a Map write per stage).
// ---------------------------------------------------------------------------

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

class TurnProfiler {
    constructor() {
        this._t0 = 0;
        this._stages = new Map(); // name -> { ms, calls }
        this._firstWordAt = null;
        this.active = false;
    }

    /** Begins a turn, discarding anything left over from the previous one. */
    startTurn() {
        this._t0 = now();
        this._stages = new Map();
        this._firstWordAt = null;
        this.active = true;
    }

    /**
     * Records a completed stage. Repeat calls with the same name accumulate and
     * bump a counter, so three RPC round-trips show up as one line with calls:3
     * rather than silently overwriting each other.
     */
    stage(name, ms) {
        if (!this.active || !(ms >= 0)) return;
        const prev = this._stages.get(name);
        if (prev) { prev.ms += ms; prev.calls++; }
        else this._stages.set(name, { ms, calls: 1 });
    }

    /** Times a promise-returning function, recording it even when it rejects. */
    async time(name, fn) {
        if (!this.active) return fn();
        const t = now();
        try {
            return await fn();
        } finally {
            this.stage(name, now() - t);
        }
    }

    /**
     * Marks the moment the first word was spoken. This is the number the user
     * actually perceives as responsiveness — everything after it happens while
     * they are already listening.
     */
    markFirstWord() {
        if (!this.active || this._firstWordAt !== null) return;
        this._firstWordAt = now() - this._t0;
    }

    /** Rounded breakdown for the interaction log; null when nothing was timed. */
    snapshot() {
        if (!this.active) return null;
        const stages = {};
        for (const [name, { ms, calls }] of this._stages) {
            stages[name] = calls > 1 ? { ms: Math.round(ms), calls } : Math.round(ms);
        }
        const out = { totalMs: Math.round(now() - this._t0), stages };
        if (this._firstWordAt !== null) out.firstWordMs = Math.round(this._firstWordAt);
        return out;
    }

    endTurn() {
        const snap = this.snapshot();
        this.active = false;
        return snap;
    }
}

const perf = new TurnProfiler();
export default perf;
export { TurnProfiler };
