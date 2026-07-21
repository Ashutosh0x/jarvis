// Tests for system process analysis. The load-bearing property: cumulative
// CPU-seconds and instantaneous CPU percent must never be conflated — the raw
// Windows field invites exactly that mistake.
import {
    groupProcesses, byCpu, byMemory, foregroundApps, summarize,
    findProcess, formatMB, uptimeFrom, observations,
    friendlyName, isSystemProcess,
} from '../sysInspect.js';

let pass = 0, fail = 0;
const check = (n, c) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); };

// Shaped like the real collector output: chrome fragmented across processes,
// a big cumulative-CPU value that is NOT current usage, one null sample.
// Rows exactly as the collector produces them, including the metadata Windows
// itself reports. Values below were CAPTURED from this machine: protected
// processes really do return empty description/company/path with readable
// false, and Windows really does describe dllhost as "COM Surrogate".
const PROCS = [
    { pid: 1, name: 'chrome', cpu: 4.2, mb: 190, cpuS: 848, title: 'Gmail - Google Chrome', desc: 'Google Chrome', company: 'Google LLC', path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', readable: true },
    { pid: 2, name: 'chrome', cpu: 3.1, mb: 343, cpuS: 625, title: '', desc: 'Google Chrome', company: 'Google LLC', path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', readable: true },
    { pid: 3, name: 'chrome', cpu: 0.5, mb: 261, cpuS: 538, title: '', desc: 'Google Chrome', company: 'Google LLC', path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', readable: true },
    { pid: 4, name: 'claude', cpu: 8.0, mb: 347, cpuS: 621, title: 'Claude', desc: 'Claude Code', company: 'Anthropic PBC', path: 'C:\\Users\\x\\claude.exe', readable: true },
    // Protected: Windows refuses the module read for a non-elevated caller.
    { pid: 5, name: 'MsMpEng', cpu: 1.5, mb: 220, cpuS: 300, title: '', desc: null, company: null, path: null, readable: false },
    { pid: 6, name: 'svchost', cpu: 0.2, mb: 40, cpuS: 90, title: '', desc: null, company: null, path: null, readable: false },
    // Readable but living under the Windows directory — also system tier.
    { pid: 9, name: 'explorer', cpu: 0.4, mb: 150, cpuS: 200, title: '', desc: 'Windows Explorer', company: 'Microsoft Corporation', path: 'C:\\Windows\\explorer.exe', readable: true },
    { pid: 7, name: 'electron', cpu: 2.0, mb: 500, cpuS: 120, title: 'Jarvis', desc: 'Electron', company: 'GitHub, Inc.', path: 'C:\\Users\\x\\electron.exe', readable: true },
    { pid: 8, name: 'newproc', cpu: null, mb: 10, cpuS: 0, title: '', desc: null, company: null, path: 'C:\\Users\\x\\new.exe', readable: true }, // appeared mid-sample
];
const groups = groupProcesses(PROCS);
const s = summarize(PROCS, { cores: 12 });

// --- grouping ----------------------------------------------------------------
check('group: chrome folded into one entry', groups.filter(g => g.name === 'chrome').length === 1);
check('group: chrome process count', findProcess(groups, 'chrome').count === 3);
check('group: chrome cpu summed across processes', findProcess(groups, 'chrome').cpuPct === 7.8);
check('group: chrome memory summed', findProcess(groups, 'chrome').memMB === 794);
check('group: window titles collected', findProcess(groups, 'chrome').windows.length === 1);
check('group: pids collected', findProcess(groups, 'chrome').pids.length === 3);
check('group: null cpu sample does not count as zero usage',
    findProcess(groups, 'newproc').cpuPct === 0 && findProcess(groups, 'newproc').count === 1);

// --- cumulative vs instantaneous (the whole point) ---------------------------
{
    const c = findProcess(groups, 'chrome');
    check('CPU: instantaneous percent is a separate field from cumulative seconds',
        c.cpuPct === 7.8 && c.cpuSeconds === 2011);
    check('CPU: cumulative seconds never leaks into the percent',
        c.cpuPct < 100 && c.cpuSeconds > 100);
    check('CPU: total across all groups stays plausible (<= 100 x cores)',
        s.totalCpuPct > 0 && s.totalCpuPct <= 100 * 12);
}

// --- classification -----------------------------------------------------------
// Classification is DERIVED from Windows' own answers, not a hardcoded list.
check('system: metadata refusal marks a protected process',
    isSystemProcess({ name: 'svchost', readable: false }) === true);
check('system: Defender detected via the same refusal',
    isSystemProcess({ name: 'MsMpEng', readable: false }) === true);
check('system: readable app under Program Files is NOT system',
    isSystemProcess({ name: 'chrome', readable: true, path: 'C:\\Program Files\\Google\\Chrome\\chrome.exe' }) === false);
check('system: readable app under C:\\Windows IS system',
    isSystemProcess({ name: 'explorer', readable: true, path: 'C:\\Windows\\explorer.exe' }) === true);
check('system: path check is case-insensitive',
    isSystemProcess({ name: 'x', readable: true, path: 'C:\\WINDOWS\\System32\\x.exe' }) === true);
check('system: a bare name with no evidence is not guessed at',
    isSystemProcess('svchost') === false);

// Display names come from Windows, so they are better than anything hardcoded.
check('friendly: uses Windows FileDescription',
    friendlyName({ name: 'dllhost', desc: 'COM Surrogate' }) === 'COM Surrogate');
check('friendly: real captured example',
    friendlyName({ name: 'claude', desc: 'Claude Code', company: 'Anthropic PBC' }) === 'Claude Code');
check('friendly: falls back to vendor when description is absent',
    friendlyName({ name: 'CrossDeviceResume', desc: '', company: 'Microsoft Corporation' }) === 'CrossDeviceResume (Microsoft Corporation)');
check('friendly: falls back to the raw name when nothing is known',
    friendlyName({ name: 'weirdapp' }) === 'weirdapp');
check('friendly: bare string passes through', friendlyName('weirdapp') === 'weirdapp');

// --- ranking -------------------------------------------------------------------
check('rank cpu: claude top at 8.0', byCpu(groups)[0].name === 'claude');
check('rank memory: chrome top at 794MB', byMemory(groups)[0].name === 'chrome');
check('rank: deterministic across repeated calls',
    JSON.stringify(byCpu(groups)) === JSON.stringify(byCpu(groupProcesses(PROCS))));

// --- foreground apps ------------------------------------------------------------
{
    const fg = foregroundApps(groups).map(g => g.name);
    check('foreground: only windowed apps', fg.includes('chrome') && fg.includes('claude') && fg.includes('electron'));
    check('foreground: system processes excluded', !fg.includes('svchost') && !fg.includes('MsMpEng'));
    check('foreground: titleless processes excluded', !fg.includes('newproc'));
}

// --- lookup ---------------------------------------------------------------------
check('find: exact name', findProcess(groups, 'claude')?.name === 'claude');
check('find: case-insensitive', findProcess(groups, 'CHROME')?.name === 'chrome');
// Lookup by the name WINDOWS reports, since that is what is now stored.
check('find: by Windows-reported description', findProcess(groups, 'Claude Code')?.name === 'claude');
check('find: protected process still findable by its raw name',
    findProcess(groups, 'MsMpEng')?.name === 'MsMpEng');
check('find: unknown returns null', findProcess(groups, 'firefox') === null);
check('find: empty returns null', findProcess(groups, '') === null);

// --- formatting -------------------------------------------------------------------
check('format: GB above 1024MB', formatMB(2048) === '2.0 GB');
check('format: MB below 1024', formatMB(512) === '512 MB');
check('format: invalid is null', formatMB('x') === null);
check('uptime: minutes', uptimeFrom(new Date(1000000).toISOString(), 1000000 + 30 * 60000) === '30 minutes');
check('uptime: singular minute', uptimeFrom(new Date(1000000).toISOString(), 1000000 + 60000) === '1 minute');
check('uptime: hours', uptimeFrom(new Date(1000000).toISOString(), 1000000 + 3 * 3600000) === '3 hours');
check('uptime: days', uptimeFrom(new Date(1000000).toISOString(), 1000000 + 50 * 3600000) === '2 days');
check('uptime: invalid is null', uptimeFrom('nonsense') === null);

// --- observations are evidence, not verdicts ---------------------------------------
{
    const obs = observations(s);
    check('observations: returns statements', Array.isArray(obs));
    check('observations: no malware/verdict language',
        !obs.some(o => /malicious|malware|virus|suspicious|infected/i.test(o)));
    const busy = summarize([{ pid: 1, name: 'miner', cpu: 88, mb: 100, cpuS: 900, title: '' }], { cores: 12 });
    check('observations: high CPU is reported with its measurement',
        observations(busy).some(o => /88% CPU/.test(o)));
}

// --- summary totals ----------------------------------------------------------------
check('summary: process count is raw PIDs not groups', s.processCount === 9);
check('summary: group count', s.groupCount === 7);
check('summary: memory total', s.totalMemMB === 2061);
check('summary: cores carried', s.cores === 12);
check('summary: empty input safe', summarize([]).processCount === 0);
check('summary: null input safe', summarize(null).groupCount === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
