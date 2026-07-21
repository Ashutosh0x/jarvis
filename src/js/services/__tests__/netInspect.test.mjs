// Tests for the network inspection engine. Load-bearing: every spoken network
// fact is derived here, so a parsing slip becomes a confidently wrong statement
// about who the machine is talking to.
import {
    splitEndpoint, classifyAddress, parseProcessTable, parseNetstat,
    establishedRows, listeningRows, groupByProcess, groupByRemote,
    summarize, connectionsForProcess, formatBytes, PORT_SERVICES,
    parseServicesFile, setPortServices, serviceForPort,
} from '../netInspect.js';

let pass = 0, fail = 0;
const check = (n, c) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); };

/* Port names come from WINDOWS' services file, not a hardcoded map. These
   lines are copied verbatim from %SystemRoot%\System32\drivers\etc\services
   on this machine (287 lines total). */
const SERVICES_FILE = `# Copyright (c) 1993-2006 Microsoft Corp.
#
# This file contains port numbers for well-known services

echo                7/tcp
ssh                22/tcp                           #SSH Remote Login Protocol
domain             53/tcp                           #Domain Name Server
domain             53/udp                           #Domain Name Server
http               80/tcp    www www-http           #World Wide Web
https             443/tcp    MCom                   #HTTP over TLS/SSL
https             443/udp    MCom                   #HTTP over TLS/SSL
microsoft-ds      445/tcp
epmap             135/tcp    loc-srv                #DCE endpoint resolution
`;
setPortServices(parseServicesFile(SERVICES_FILE));

// --- the system table replaces the old hardcoded map -------------------------
check('services: parsed from the real file format', serviceForPort(22) === 'SSH Remote Login Protocol');
check('services: comment preferred as the human label', serviceForPort(443) === 'HTTP over TLS/SSL');
check('services: falls back to the service name when no comment',
    serviceForPort(445) === 'microsoft-ds');
check('services: aliases column does not break parsing', serviceForPort(80) === 'World Wide Web');
check('services: comment-only lines ignored', serviceForPort(0) === null);
check('services: unknown port is null, never guessed', serviceForPort(51234) === null);
check('services: non-numeric input is null', serviceForPort('abc') === null);
check('services: duplicate tcp/udp entry keeps the first', serviceForPort(53) === 'Domain Name Server');
// This app's own listeners are not in any registry, so they stay defined here.
check('services: own ports win over the system table', serviceForPort(8770) === 'Jarvis speech-to-text');
check('services: own ollama port named', serviceForPort(11434) === 'Ollama');
check('services: empty file yields no names', Object.keys(parseServicesFile('')).length === 0);

// Real `netstat -ano` output shape, including the IPv6 and UDP forms.
const NETSTAT = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1748
  TCP    0.0.0.0:445            0.0.0.0:0              LISTENING       4
  TCP    127.0.0.1:8770         0.0.0.0:0              LISTENING       9001
  TCP    127.0.0.1:53365        127.0.0.1:53366        ESTABLISHED     5000
  TCP    192.168.0.101:52001    52.98.59.18:443        ESTABLISHED     10528
  TCP    192.168.0.101:52002    160.79.104.10:443      ESTABLISHED     9400
  TCP    192.168.0.101:52003    160.79.104.10:443      ESTABLISHED     9400
  TCP    192.168.0.101:52004    192.168.0.105:8766     ESTABLISHED     9400
  TCP    192.168.0.101:52005    172.20.10.4:443        ESTABLISHED     7777
  TCP    192.168.0.101:52006    172.33.5.9:443         ESTABLISHED     7777
  TCP    [::]:445               [::]:0                 LISTENING       4
  TCP    [fe80::1%12]:52010     [2606:4700::1111]:443  ESTABLISHED     9400
  UDP    0.0.0.0:5353           *:*                                    3200
  UDP    192.168.0.101:137      *:*                                    4
`;
const PROCS = parseProcessTable([
    '1748\tsvchost', '4\tSystem', '9001\tpython', '5000\tnvcontainer',
    '10528\texplorer', '9400\tchrome', '7777\tclaude', '3200\tmdnsresponder',
]);
const rows = parseNetstat(NETSTAT, PROCS);

// --- endpoint splitting -----------------------------------------------------
check('split: ipv4 host:port', splitEndpoint('192.168.0.101:52001').port === 52001);
check('split: ipv4 address kept', splitEndpoint('192.168.0.101:52001').address === '192.168.0.101');
check('split: ipv6 brackets stripped, colons survive',
    splitEndpoint('[2606:4700::1111]:443').address === '2606:4700::1111');
check('split: ipv6 port parsed', splitEndpoint('[2606:4700::1111]:443').port === 443);
check('split: wildcard udp', splitEndpoint('*:*').port === 0);

// --- address classification -------------------------------------------------
check('classify: loopback v4', classifyAddress('127.0.0.1') === 'loopback');
check('classify: loopback v6', classifyAddress('::1') === 'loopback');
check('classify: private 192.168', classifyAddress('192.168.0.105') === 'private');
check('classify: private 10.x', classifyAddress('10.1.2.3') === 'private');
check('classify: private 172.20 (inside /12)', classifyAddress('172.20.10.4') === 'private');
check('classify: PUBLIC 172.33 (outside /12)', classifyAddress('172.33.5.9') === 'public');
check('classify: public v4', classifyAddress('52.98.59.18') === 'public');
check('classify: public v6', classifyAddress('2606:4700::1111') === 'public');
check('classify: link-local', classifyAddress('169.254.1.1') === 'link-local');
check('classify: multicast', classifyAddress('224.0.0.251') === 'multicast');
check('classify: unspecified', classifyAddress('0.0.0.0') === 'unspecified');

// --- netstat parsing --------------------------------------------------------
check('parse: header lines ignored', rows.every(r => r.proto === 'TCP' || r.proto === 'UDP'));
check('parse: row count', rows.length === 14);
check('parse: udp rows parsed (no state column)',
    rows.filter(r => r.proto === 'UDP').length === 2);
check('parse: udp has empty state', rows.find(r => r.proto === 'UDP').state === '');
check('parse: pid mapped to process name',
    rows.find(r => r.remotePort === 443 && r.remoteAddress === '52.98.59.18').process === 'explorer');
check('parse: unknown pid degrades to "unknown"',
    parseNetstat('  TCP    0.0.0.0:1  0.0.0.0:0  LISTENING  99999', {})[0].process === 'unknown');
// The label is WINDOWS' wording, not a name this codebase chose.
check('parse: service name attached from the system table',
    rows.find(r => r.remoteAddress === '52.98.59.18').service === 'HTTP over TLS/SSL');
check('parse: own services recognised', PORT_SERVICES[8770] === 'Jarvis speech-to-text');
check('parse: ipv6 established row survives',
    rows.some(r => r.remoteAddress === '2606:4700::1111' && r.state === 'ESTABLISHED'));

// --- state filters ----------------------------------------------------------
check('established: count', establishedRows(rows).length === 8);
check('listening: count', listeningRows(rows).length === 4);

// --- grouping ---------------------------------------------------------------
{
    const byProc = groupByProcess(establishedRows(rows));
    check('group by process: busiest first', byProc[0].name === 'chrome');
    check('group by process: chrome has 4 connections', byProc[0].count === 4);
    check('group by process: distinct remotes counted', byProc[0].remoteCount === 3);
    check('group by process: pids listed', byProc[0].pids.includes(9400));

    const byRemote = groupByRemote(establishedRows(rows));
    check('group by remote: repeated host aggregated',
        byRemote[0].address === '160.79.104.10' && byRemote[0].count === 2);
    check('group by remote: scope carried', byRemote[0].scope === 'public');
    check('group by remote: owning processes listed', byRemote[0].processes.includes('chrome'));
}

// --- summary ----------------------------------------------------------------
{
    const s = summarize(rows);
    check('summary: established total', s.established === 8);
    // 52.98.59.18, 160.79.104.10 twice, 172.33.5.9 (outside the /12), and the
    // IPv6 host — the scope buckets must account for every established row.
    check('summary: public count', s.scopes.public === 5);
    check('summary: scopes sum to established',
        s.scopes.public + s.scopes.private + s.scopes.loopback + s.scopes.other === s.established);
    check('summary: private count (LAN peer + 172.20)', s.scopes.private === 2);
    check('summary: loopback excluded from public', s.scopes.loopback === 1);
    check('summary: exposed ports exclude loopback-only listener',
        !s.exposedPorts.some(p => p.port === 8770));
    check('summary: exposed ports include 0.0.0.0 listener',
        s.exposedPorts.some(p => p.port === 445));
    check('summary: exposed ports deduped across v4/v6',
        s.exposedPorts.filter(p => p.port === 445).length === 1);
    check('summary: exposed ports sorted ascending',
        s.exposedPorts.every((p, i, a) => i === 0 || a[i - 1].port <= p.port));
}

// --- per-process lookup ------------------------------------------------------
check('per-process: substring match', connectionsForProcess(rows, 'chrom').length === 4);
check('per-process: case-insensitive', connectionsForProcess(rows, 'CHROME').length === 4);
check('per-process: no match is empty', connectionsForProcess(rows, 'firefox').length === 0);
check('per-process: empty name is empty', connectionsForProcess(rows, '').length === 0);

// --- determinism -------------------------------------------------------------
check('determinism: repeated parse is identical',
    JSON.stringify(parseNetstat(NETSTAT, PROCS)) === JSON.stringify(rows));
check('determinism: repeated summary is identical',
    JSON.stringify(summarize(rows)) === JSON.stringify(summarize(parseNetstat(NETSTAT, PROCS))));

// --- byte formatting ----------------------------------------------------------
check('bytes: gigabytes', formatBytes(2416035505) === '2.42 gigabytes');
check('bytes: megabytes', formatBytes(35247281) === '35.2 megabytes');
check('bytes: raw bytes', formatBytes(512) === '512 bytes');
check('bytes: invalid is null', formatBytes('abc') === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
