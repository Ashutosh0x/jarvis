// ---------------------------------------------------------------------------
// System process inspection — PURE analysis, no I/O. READ-ONLY by design:
// nothing in this module or its handlers can start, stop or kill a process.
//
// THE CORRECTNESS TRAP THIS MODULE EXISTS TO AVOID: Get-Process exposes .CPU,
// which is CUMULATIVE processor-seconds since the process started, not current
// usage. Speaking it as "Chrome is using 848 percent CPU" would be confidently
// wrong. The collector therefore takes TWO samples and derives a real
// instantaneous percentage; this module keeps the two quantities in separate,
// differently-named fields so they can never be confused downstream.
// ---------------------------------------------------------------------------

/* NO HARDCODED NAME TABLES. Both the display name and the system/user split
   are DERIVED from what Windows itself reports about each executable, because
   a baked-in list is a guess that silently rots as software changes.

   Measured on this machine: of 107 distinct programs, Windows supplied a
   FileDescription for 50 of them — and its names beat anything hand-written
   ("COM Surrogate" for dllhost, "Console Window Host" for conhost, "Claude
   Code / Anthropic PBC" for claude). The other 57 REFUSED to expose their
   module to a non-elevated caller, and that refusal is itself the signal:
   csrss, lsass, smss, services, svchost, System, Registry, MsMpEng, wininit,
   winlogon, dwm and the vendor services are precisely the protected tier.
   So "could not read its metadata" IS the system-process test — an observation,
   not an assumption. */

/**
 * Display name for a process row, best evidence first:
 * Windows' own FileDescription -> vendor name -> the raw executable name.
 */
export function friendlyName(row) {
    if (typeof row === 'string') return row;           // bare name, nothing known
    const desc = String(row?.desc || '').trim();
    if (desc) return desc;
    const co = String(row?.company || '').trim();
    const name = String(row?.name || '').trim();
    return co ? `${name} (${co})` : name;
}

/**
 * True when the process belongs to the OS/service tier. Derived, in order:
 *   1. Windows denied access to its module (protected/service process), or
 *   2. its executable lives under the Windows directory.
 * `readable` is supplied by the collector, which attempts the read and
 * records whether it succeeded.
 */
export function isSystemProcess(row) {
    if (typeof row === 'string') return false;         // no evidence, do not guess
    if (row?.readable === false) return true;
    const p = String(row?.path || '').toLowerCase();
    return p.startsWith('c:\\windows\\');
}

/**
 * Group raw per-PID rows by process name. Modern browsers run dozens of
 * processes; "chrome is using 12% across 39 processes" is the true and useful
 * statement, where any single PID's number would understate it.
 */
export function groupProcesses(procs) {
    const m = new Map();
    for (const p of procs || []) {
        const name = String(p?.name || '').trim();
        if (!name) continue;
        const key = name.toLowerCase();
        const e = m.get(key) || {
            name, friendly: friendlyName(p), count: 0,
            cpuPct: 0, memMB: 0, cpuSeconds: 0,
            system: isSystemProcess(p), company: p.company || null, path: p.path || null,
            windows: [], pids: [],
        };
        // Later rows may carry metadata an earlier one lacked (a protected
        // instance alongside a readable one) — take the best evidence available.
        if (!e.company && p.company) e.company = p.company;
        if (e.friendly === e.name && p.desc) e.friendly = String(p.desc).trim();
        e.count++;
        // A null percentage means the process appeared between the two samples;
        // it contributes to the count but must not be counted as zero usage.
        if (typeof p.cpu === 'number') e.cpuPct += p.cpu;
        if (typeof p.mb === 'number') e.memMB += p.mb;
        if (typeof p.cpuS === 'number') e.cpuSeconds += p.cpuS;
        if (p.title) e.windows.push(String(p.title));
        if (typeof p.pid === 'number') e.pids.push(p.pid);
        m.set(key, e);
    }
    for (const e of m.values()) e.cpuPct = Math.round(e.cpuPct * 10) / 10;
    return [...m.values()];
}

/** Descending by a numeric field, with a stable name tie-break. */
function rank(list, field) {
    return [...list].sort((a, b) => (b[field] - a[field]) || a.name.localeCompare(b.name));
}

export const byCpu = (groups) => rank(groups, 'cpuPct');
export const byMemory = (groups) => rank(groups, 'memMB');

/** Apps with a visible window — "what am I actually working in". */
export function foregroundApps(groups) {
    return groups.filter(g => g.windows.length > 0 && !g.system);
}

/** Overall picture for the spoken answer. */
export function summarize(procs, opts = {}) {
    const groups = groupProcesses(procs);
    const totalCpu = Math.round(groups.reduce((a, g) => a + g.cpuPct, 0) * 10) / 10;
    const totalMemMB = groups.reduce((a, g) => a + g.memMB, 0);
    return {
        processCount: (procs || []).length,
        groupCount: groups.length,
        totalCpuPct: totalCpu,
        totalMemMB,
        cores: opts.cores || null,
        topCpu: byCpu(groups).slice(0, 8),
        topMemory: byMemory(groups).slice(0, 8),
        userApps: byMemory(foregroundApps(groups)).slice(0, 10),
        groups,
    };
}

/** Find a named process group (substring, case-insensitive). */
export function findProcess(groups, name) {
    const n = String(name || '').toLowerCase().trim();
    if (!n) return null;
    const exact = groups.find(g => g.name.toLowerCase() === n);
    if (exact) return exact;
    return groups.find(g => g.name.toLowerCase().includes(n))
        || groups.find(g => String(g.friendly).toLowerCase().includes(n))
        || null;
}

/** "2.4 GB" / "512 MB" from megabytes. */
export function formatMB(mb) {
    const v = Number(mb);
    if (!Number.isFinite(v) || v < 0) return null;
    return v >= 1024 ? `${(v / 1024).toFixed(1)} GB` : `${Math.round(v)} MB`;
}

/** "3 hours" / "12 minutes" since an ISO start time, or null. */
export function uptimeFrom(iso, nowMs) {
    const t = Date.parse(iso || '');
    if (!Number.isFinite(t)) return null;
    const mins = Math.floor(((nowMs ?? Date.now()) - t) / 60000);
    if (mins < 0) return null;
    if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'}`;
    const h = Math.floor(mins / 60);
    if (h < 24) return `${h} hour${h === 1 ? '' : 's'}`;
    const d = Math.floor(h / 24);
    return `${d} day${d === 1 ? '' : 's'}`;
}

/**
 * Notable observations, stated as evidence rather than verdicts. Anything that
 * looks alarming is described with the measurement that triggered it, so the
 * user can judge — the assistant never declares a process malicious.
 */
export function observations(summary) {
    const out = [];
    const cpu = summary.topCpu[0];
    if (cpu && cpu.cpuPct >= 25) {
        out.push(`${cpu.friendly} is using ${cpu.cpuPct}% CPU across ${cpu.count} process${cpu.count === 1 ? '' : 'es'}.`);
    }
    const mem = summary.topMemory[0];
    if (mem && mem.memMB >= 1024) {
        out.push(`${mem.friendly} is holding ${formatMB(mem.memMB)} of memory across ${mem.count} process${mem.count === 1 ? '' : 'es'}.`);
    }
    // A process count this high is worth mentioning but is not itself a fault.
    const heavy = summary.groups.filter(g => g.count >= 30);
    for (const h of heavy) {
        out.push(`${h.friendly} has ${h.count} processes running, which is normal for it but is the largest group on the system.`);
    }
    return out;
}
