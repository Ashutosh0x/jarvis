// ---------------------------------------------------------------------------
// Network connection inspection — PURE parsing and analysis. No I/O.
//
// The main process collects raw `netstat -ano` text plus a pid->name table;
// everything derived from it lives here so it is deterministic and unit-
// testable. Same rule the finance and on-chain engines follow: the model never
// computes or guesses a network fact, it only speaks what this module measured.
//
// HONEST SCOPE: this is connection-level visibility (who your machine is
// talking to, which process owns each socket, what is listening) — the same
// data Wireshark shows in its conversations view. It is NOT packet capture:
// payload bytes, headers and per-packet timing require a capture driver
// (Npcap) or Windows' own pktmon, both of which need Administrator. The voice
// layer says so plainly rather than implying deeper sight than it has.
// ---------------------------------------------------------------------------

/* Port names come from WINDOWS' OWN IANA table
   (%SystemRoot%\System32\drivers\etc\services, 287 lines on this machine),
   parsed at runtime — not from a hand-written list that would be both
   incomplete and slowly wrong. The only entries defined here are this app's
   own listeners, which are not in any registry because they are ours. */
export const OWN_SERVICES = {
    8765: 'Jarvis phone bridge', 8766: 'Jarvis companion link',
    8770: 'Jarvis speech-to-text', 10000: 'OCR server', 11434: 'Ollama',
};

/** Loaded from the system services file; empty until setPortServices runs. */
let PORT_TABLE = {};

/**
 * Parse the services file format: "name  port/proto  [aliases]  #comment".
 * The trailing comment is preferred as the label when present because it is
 * the human-readable description ("#HTTP over TLS/SSL" beats "https").
 */
export function parseServicesFile(text) {
    const table = {};
    for (const raw of String(text || '').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const m = line.match(/^(\S+)\s+(\d+)\/(tcp|udp)\b([^#]*)(?:#\s*(.*))?$/i);
        if (!m) continue;
        const port = Number(m[2]);
        if (!Number.isFinite(port) || table[port]) continue;   // first wins
        const comment = (m[5] || '').trim();
        table[port] = comment || m[1];
    }
    return table;
}

/** Install the parsed system table. Our own ports always take precedence. */
export function setPortServices(table) {
    PORT_TABLE = { ...(table || {}) };
}

/** Service label for a port, or null when nothing authoritative names it. */
export function serviceForPort(port) {
    const p = Number(port);
    if (!Number.isFinite(p)) return null;
    return OWN_SERVICES[p] || PORT_TABLE[p] || null;
}

/** Back-compat view used by callers that read a map. */
export const PORT_SERVICES = new Proxy({}, {
    get: (_, k) => serviceForPort(k),
    has: (_, k) => serviceForPort(k) !== null,
});

/** Strip the brackets IPv6 literals carry in netstat output. */
function cleanHost(h) {
    const s = String(h || '');
    return s.startsWith('[') && s.includes(']') ? s.slice(1, s.indexOf(']')) : s;
}

/** Split "addr:port" from the right so IPv6 colons survive. */
export function splitEndpoint(text) {
    const s = String(text || '').trim();
    const i = s.lastIndexOf(':');
    if (i < 0) return { address: s, port: 0 };
    const port = Number(s.slice(i + 1));
    return { address: cleanHost(s.slice(0, i)), port: Number.isFinite(port) ? port : 0 };
}

/**
 * Classify a remote address without a lookup.
 * loopback = this machine, private = your LAN, public = the internet.
 */
export function classifyAddress(addr) {
    const a = String(addr || '').toLowerCase();
    if (!a || a === '*') return 'unspecified';
    if (a === '0.0.0.0' || a === '::' || a === '[::]') return 'unspecified';
    if (a === '::1' || a.startsWith('127.')) return 'loopback';
    if (a.startsWith('169.254.') || a.startsWith('fe80:')) return 'link-local';
    if (a.startsWith('10.') || a.startsWith('192.168.')) return 'private';
    // 172.16.0.0/12 is 172.16 through 172.31 — 172.32+ is public.
    const m = a.match(/^172\.(\d{1,3})\./);
    if (m) { const b = Number(m[1]); if (b >= 16 && b <= 31) return 'private'; }
    if (a.startsWith('fc') || a.startsWith('fd')) return 'private';
    if (a.startsWith('224.') || a.startsWith('239.') || a.startsWith('ff')) return 'multicast';
    return 'public';
}

/** "1234\tchrome" lines -> { pid: name }. */
export function parseProcessTable(lines) {
    const map = {};
    for (const line of lines || []) {
        const i = String(line).indexOf('\t');
        if (i > 0) map[String(line).slice(0, i).trim()] = String(line).slice(i + 1).trim();
    }
    return map;
}

/**
 * Parse `netstat -ano` into structured rows. Locale-independent: rows are
 * matched on shape (proto + endpoints + numeric pid), never on the header
 * text, which is translated on non-English Windows.
 */
export function parseNetstat(text, procMap = {}) {
    const rows = [];
    for (const raw of String(text || '').split(/\r?\n/)) {
        const p = raw.trim().split(/\s+/);
        if (p.length < 4) continue;
        const proto = p[0].toUpperCase();
        if (proto !== 'TCP' && proto !== 'UDP') continue;

        // TCP: proto local remote state pid | UDP: proto local remote pid
        const pid = p[p.length - 1];
        if (!/^\d+$/.test(pid)) continue;
        const state = proto === 'TCP' && p.length >= 5 ? p[3] : '';
        const local = splitEndpoint(p[1]);
        const remote = splitEndpoint(p[2]);
        rows.push({
            proto,
            localAddress: local.address, localPort: local.port,
            remoteAddress: remote.address, remotePort: remote.port,
            state, pid: Number(pid),
            process: procMap[pid] || 'unknown',
            scope: classifyAddress(remote.address),
            service: serviceForPort(remote.port) || serviceForPort(local.port),
        });
    }
    return rows;
}

/** Rows that represent a live conversation with something else. */
export function establishedRows(rows) {
    return (rows || []).filter(r => r.state === 'ESTABLISHED');
}

/** Sockets accepting inbound connections — the machine's exposed surface. */
export function listeningRows(rows) {
    return (rows || []).filter(r => r.state === 'LISTENING');
}

/** Sort helper: descending count, then name, so output is deterministic. */
function byCountThenName(a, b) {
    return b.count - a.count || String(a.name).localeCompare(String(b.name));
}

/** Group established connections by owning process. */
export function groupByProcess(rows) {
    const m = new Map();
    for (const r of rows) {
        const e = m.get(r.process) || { name: r.process, count: 0, remotes: new Set(), pids: new Set() };
        e.count++; e.remotes.add(r.remoteAddress); e.pids.add(r.pid);
        m.set(r.process, e);
    }
    return [...m.values()]
        .map(e => ({ name: e.name, count: e.count, remoteCount: e.remotes.size, pids: [...e.pids].sort((x, y) => x - y) }))
        .sort(byCountThenName);
}

/** Group established connections by remote host. */
export function groupByRemote(rows) {
    const m = new Map();
    for (const r of rows) {
        const e = m.get(r.remoteAddress) || {
            name: r.remoteAddress, count: 0, ports: new Set(), procs: new Set(), scope: r.scope,
        };
        e.count++; e.ports.add(r.remotePort); e.procs.add(r.process);
        m.set(r.remoteAddress, e);
    }
    return [...m.values()]
        .map(e => ({
            address: e.name, name: e.name, count: e.count, scope: e.scope,
            ports: [...e.ports].sort((x, y) => x - y),
            processes: [...e.procs].sort(),
            service: serviceForPort([...e.ports][0]),
        }))
        .sort(byCountThenName);
}

/** One-shot overview used for the spoken answer. */
export function summarize(rows) {
    const est = establishedRows(rows);
    const listen = listeningRows(rows);
    const scopes = { public: 0, private: 0, loopback: 0, other: 0 };
    for (const r of est) {
        if (r.scope === 'public' || r.scope === 'private' || r.scope === 'loopback') scopes[r.scope]++;
        else scopes.other++;
    }
    const externalListeners = listen.filter(
        r => r.localAddress === '0.0.0.0' || r.localAddress === '::' || classifyAddress(r.localAddress) === 'private',
    );
    return {
        total: rows.length,
        established: est.length,
        listening: listen.length,
        scopes,
        processes: groupByProcess(est),
        remotes: groupByRemote(est),
        // Ports reachable from outside this machine, deduped by port.
        exposedPorts: [...new Map(externalListeners.map(r => [r.localPort, {
            port: r.localPort, process: r.process, service: serviceForPort(r.localPort),
        }])).values()].sort((a, b) => a.port - b.port),
    };
}

/** Established connections belonging to a named process (substring, case-insensitive). */
export function connectionsForProcess(rows, name) {
    const n = String(name || '').toLowerCase();
    if (!n) return [];
    return establishedRows(rows).filter(r => r.process.toLowerCase().includes(n));
}

/** Byte counts spoken the way a person would say them. */
export function formatBytes(bytes) {
    const b = Number(bytes);
    if (!Number.isFinite(b) || b < 0) return null;
    if (b >= 1e12) return `${(b / 1e12).toFixed(2)} terabytes`;
    if (b >= 1e9) return `${(b / 1e9).toFixed(2)} gigabytes`;
    if (b >= 1e6) return `${(b / 1e6).toFixed(1)} megabytes`;
    if (b >= 1e3) return `${(b / 1e3).toFixed(1)} kilobytes`;
    return `${b} bytes`;
}
