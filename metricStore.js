// ---------------------------------------------------------------------------
// TIME-SERIES METRICS + EVENT DERIVATION — pure, no I/O.
//
// The tier this codebase was missing. Telemetry already never reaches the RAG
// (verified: ragService.ingest is only called for notes, OCR text, documents
// and distilled facts), but it was also never persisted at all — the 2s HUD
// poller displayed a number and dropped it, so "what was my CPU an hour ago"
// had no answer.
//
// DESIGN, in one line: keep samples cheap and bounded, and turn changes into
// EVENTS rather than storing every reading as a memory.
//   - one persisted sample per minute, not per 2s (1440/day, ~100KB/day)
//   - raw samples pruned after 7 days, but daily ROLLUPS kept indefinitely
//     (a rollup is ~150 bytes and preserves avg/peak/p95, which is what
//     questions about the past actually need)
//   - threshold events use hysteresis + debounce so a value hovering on a
//     boundary produces ONE event, not a stream of them
// ---------------------------------------------------------------------------

const SAMPLE_INTERVAL_MS = 60000;   // persist at most one sample/minute
const RAW_RETENTION_MS = 7 * 24 * 3600 * 1000;

/** Should this reading be persisted, given the last persisted one? */
function shouldPersist(lastTs, nowTs, intervalMs = SAMPLE_INTERVAL_MS) {
    if (!Number.isFinite(lastTs)) return true;
    return (nowTs - lastTs) >= intervalMs;
}

/** Compact on-disk row. Short keys because this is written 1440x/day. */
function makeSample(ts, { cpu, memPct, memUsedMB, topProc, topCpu }) {
    const num = (v, d = 1) => (typeof v === 'number' && Number.isFinite(v)
        ? Math.round(v * 10 ** d) / 10 ** d : null);
    return {
        t: ts,
        c: num(cpu),
        m: num(memPct),
        mu: typeof memUsedMB === 'number' ? Math.round(memUsedMB) : null,
        p: topProc || null,
        pc: num(topCpu),
    };
}

function pct(sorted, q) {
    if (!sorted.length) return null;
    const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
    return sorted[i];
}

/** avg / peak / p95 / min over a field. Nulls are skipped, never read as 0. */
function stats(samples, field) {
    const v = (samples || []).map(s => s[field]).filter(x => typeof x === 'number');
    if (!v.length) return null;
    const sorted = [...v].sort((a, b) => a - b);
    const sum = v.reduce((a, b) => a + b, 0);
    return {
        avg: Math.round((sum / v.length) * 10) / 10,
        peak: sorted[sorted.length - 1],
        min: sorted[0],
        p95: pct(sorted, 0.95),
        n: v.length,
    };
}

/** Samples inside [fromTs, toTs]. */
function windowed(samples, fromTs, toTs = Infinity) {
    return (samples || []).filter(s => s.t >= fromTs && s.t <= toTs);
}

/** UTC-independent local day key, so "today" matches the user's day. */
function dayKey(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Compress a day of samples into one durable row. This is the "compress
 * history" step: ~1440 samples become ~150 bytes while keeping the answers
 * ("how busy was it, what was the worst moment, what dominated") intact.
 */
function rollup(samples, key) {
    const list = samples || [];
    if (!list.length) return null;
    const cpu = stats(list, 'c');
    const mem = stats(list, 'm');
    // Which process held the top-CPU slot most often that day.
    const tally = new Map();
    for (const s of list) if (s.p) tally.set(s.p, (tally.get(s.p) || 0) + 1);
    const top = [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    return {
        day: key || dayKey(list[0].t),
        from: list[0].t,
        to: list[list.length - 1].t,
        samples: list.length,
        cpu, mem,
        topProcess: top ? { name: top[0], shareOfSamples: Math.round((top[1] / list.length) * 100) } : null,
    };
}

/** Group samples by local day and roll each up. */
function rollupByDay(samples) {
    const byDay = new Map();
    for (const s of samples || []) {
        const k = dayKey(s.t);
        if (!byDay.has(k)) byDay.set(k, []);
        byDay.get(k).push(s);
    }
    return [...byDay.entries()]
        .map(([k, list]) => rollup(list, k))
        .filter(Boolean)
        .sort((a, b) => a.day.localeCompare(b.day));
}

/** Drop raw samples older than the retention window (rollups outlive them). */
function pruneRaw(samples, nowTs, retentionMs = RAW_RETENTION_MS) {
    const cutoff = nowTs - retentionMs;
    return (samples || []).filter(s => s.t >= cutoff);
}

/* --------------------------------------------------------------------------
   EVENT DERIVATION — "store events, not samples".
   Thresholds carry a HIGH and a LOW value: a metric must fall back below the
   low mark before the same event can fire again. Without that hysteresis a
   CPU hovering at the boundary emits an event every minute, which is the very
   noise this layer exists to prevent.
-------------------------------------------------------------------------- */
const THRESHOLDS = {
    cpu: { high: 85, low: 70, label: 'CPU' },
    mem: { high: 90, low: 80, label: 'memory' },
};

/** Minimum gap between two events of the same kind. */
const EVENT_DEBOUNCE_MS = 10 * 60 * 1000;

/**
 * Compare a new sample against carried state and emit only meaningful changes.
 * Returns { events, state } — state must be fed back on the next call.
 */
function deriveEvents(sample, prevState = {}, nowTs = sample?.t) {
    const state = {
        cpuHigh: !!prevState.cpuHigh,
        memHigh: !!prevState.memHigh,
        lastAt: { ...(prevState.lastAt || {}) },
        procs: prevState.procs instanceof Set ? prevState.procs : new Set(prevState.procs || []),
    };
    const events = [];
    if (!sample) return { events, state };

    const emit = (kind, text, data) => {
        const last = state.lastAt[kind];
        if (Number.isFinite(last) && nowTs - last < EVENT_DEBOUNCE_MS) return;
        state.lastAt[kind] = nowTs;
        events.push({ t: nowTs, kind, text, ...(data ? { data } : {}) });
    };

    // Threshold crossings with hysteresis.
    for (const [field, key] of [['c', 'cpu'], ['m', 'mem']]) {
        const th = THRESHOLDS[key];
        const v = sample[field];
        if (typeof v !== 'number') continue;
        const flag = key === 'cpu' ? 'cpuHigh' : 'memHigh';
        if (!state[flag] && v >= th.high) {
            state[flag] = true;
            emit(`${key}-high`, `${th.label} reached ${v}%${sample.p ? `, with ${sample.p} the busiest process` : ''}.`, { value: v, process: sample.p || null });
        } else if (state[flag] && v <= th.low) {
            state[flag] = false;   // recovery is state, not an event worth speaking
        }
    }
    return { events, state };
}

/**
 * Process start/stop events from two consecutive name sets. Only NAMED
 * programs of interest are tracked — tracking all 261 processes would
 * reproduce the telemetry-flood problem one layer up.
 */
function deriveProcessEvents(prevNames, currNames, nowTs, watch) {
    const prev = new Set(prevNames || []);
    const curr = new Set(currNames || []);
    const wanted = watch instanceof Set ? watch : new Set(watch || []);
    const events = [];
    const interesting = (n) => !wanted.size || wanted.has(String(n).toLowerCase());
    for (const n of curr) if (!prev.has(n) && interesting(n)) events.push({ t: nowTs, kind: 'process-start', text: `${n} started.`, data: { name: n } });
    for (const n of prev) if (!curr.has(n) && interesting(n)) events.push({ t: nowTs, kind: 'process-stop', text: `${n} exited.`, data: { name: n } });
    return events.sort((a, b) => a.kind.localeCompare(b.kind) || String(a.data.name).localeCompare(String(b.data.name)));
}

/** Collapse repeats of the same kind+text inside a window into one row. */
function dedupeEvents(events, windowMs = EVENT_DEBOUNCE_MS) {
    const out = [];
    const lastSeen = new Map();
    for (const e of [...(events || [])].sort((a, b) => a.t - b.t)) {
        const k = `${e.kind}|${e.text}`;
        const prev = lastSeen.get(k);
        if (Number.isFinite(prev) && e.t - prev < windowMs) continue;
        lastSeen.set(k, e.t);
        out.push(e);
    }
    return out;
}

/** Plain-language digest of a period — the spoken form of a rollup. */
function describeRollup(r) {
    if (!r || !r.cpu) return null;
    const parts = [`CPU averaged ${r.cpu.avg}% and peaked at ${r.cpu.peak}%`];
    if (r.mem) parts.push(`memory averaged ${r.mem.avg}%`);
    if (r.topProcess) parts.push(`${r.topProcess.name} was the busiest process for ${r.topProcess.shareOfSamples}% of the readings`);
    return parts.join(', ') + '.';
}

module.exports = {
    SAMPLE_INTERVAL_MS, RAW_RETENTION_MS, shouldPersist, makeSample, stats, windowed, dayKey, rollup, rollupByDay, pruneRaw, THRESHOLDS, EVENT_DEBOUNCE_MS, deriveEvents, deriveProcessEvents, dedupeEvents, describeRollup,
};
