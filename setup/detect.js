// ---------------------------------------------------------------------------
// What is this machine, and what is already on it?
//
// Everything the bootstrapper does depends on answers from here, so this file
// MEASURES rather than assumes. No hardcoded install paths, no "Windows always
// has X" — it asks the OS and reports what came back, including the failures.
//
// A probe that cannot answer returns `null`, never a guess. Downstream code
// treats null as "unknown, do not act", which is the only safe reading: a
// wrong answer here becomes a wrong installer downloaded, or a working
// dependency reinstalled over the top of itself.
// ---------------------------------------------------------------------------

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

/** Run a command, resolving to trimmed stdout or null. Never throws. */
function run(cmd, args = [], timeout = 8000) {
    return new Promise((resolve) => {
        execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout) => {
            resolve(err ? null : String(stdout).trim());
        });
    });
}

/** Is a binary on PATH? Returns its path, or null. */
async function which(bin) {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    const out = await run(finder, [bin], 5000);
    if (!out) return null;
    const first = out.split(/\r?\n/)[0].trim();
    return first && fs.existsSync(first) ? first : null;
}

// ── platform ────────────────────────────────────────────────────────────────

function platform() {
    const p = process.platform;
    const arch = process.arch;

    return {
        os: p === 'win32' ? 'windows' : p === 'darwin' ? 'macos' : p === 'linux' ? 'linux' : p,
        arch,
        // Apple Silicon needs a different Ollama build from Intel Macs, and
        // getting it wrong installs something that will not run.
        appleSilicon: p === 'darwin' && arch === 'arm64',
        release: os.release(),
        isWSL: p === 'linux' && /microsoft/i.test(os.release()),
    };
}

/**
 * Linux distribution family, for choosing a package manager.
 * Read from /etc/os-release rather than guessed from the kernel.
 */
function linuxFamily() {
    if (process.platform !== 'linux') return null;
    try {
        const text = fs.readFileSync('/etc/os-release', 'utf-8');
        const id = (text.match(/^ID=(.*)$/m)?.[1] || '').replace(/"/g, '').toLowerCase();
        const like = (text.match(/^ID_LIKE=(.*)$/m)?.[1] || '').replace(/"/g, '').toLowerCase();
        const all = `${id} ${like}`;
        if (/debian|ubuntu/.test(all)) return { id, family: 'debian', pm: 'apt' };
        if (/fedora|rhel|centos/.test(all)) return { id, family: 'fedora', pm: 'dnf' };
        if (/arch/.test(all)) return { id, family: 'arch', pm: 'pacman' };
        if (/suse/.test(all)) return { id, family: 'suse', pm: 'zypper' };
        return { id, family: 'unknown', pm: null };
    } catch {
        return null;
    }
}

// ── resources ───────────────────────────────────────────────────────────────

/**
 * RAM, cores and free disk.
 *
 * Used to choose a model, so being wrong here means recommending a 7B model to
 * a machine with 8 GB and watching it swap itself to death.
 */
function resources(installDir = os.homedir()) {
    let freeDiskGB = null;
    try {
        // statfsSync landed in Node 18 and is the only cross-platform answer
        // that does not shell out.
        const st = fs.statfsSync(installDir);
        freeDiskGB = Math.round((st.bavail * st.bsize) / 1e9);
    } catch { /* reported as unknown rather than guessed */ }

    return {
        totalRamGB: Math.round(os.totalmem() / 1e9),
        freeRamGB: Math.round(os.freemem() / 1e9),
        cores: os.cpus()?.length ?? null,
        freeDiskGB,
    };
}

/**
 * GPU, for picking an inference backend.
 *
 * Apple Silicon always has Metal. Elsewhere this asks the OS and returns null
 * when it cannot tell — Ollama does its own detection anyway, so a null here
 * costs a recommendation, not correctness.
 */
async function gpu() {
    const p = platform();

    if (p.appleSilicon) {
        return { vendor: 'apple', backend: 'metal', name: 'Apple Silicon', vramGB: null };
    }

    if (p.os === 'windows') {
        const out = await run('powershell', [
            '-NoProfile', '-NonInteractive', '-Command',
            "(Get-CimInstance Win32_VideoController | Select-Object -First 1 Name,AdapterRAM | ConvertTo-Json -Compress)",
        ], 12000);
        if (!out) return { vendor: null, backend: 'cpu', name: null, vramGB: null };
        try {
            const info = JSON.parse(out);
            const name = info.Name || null;
            // AdapterRAM is a signed 32-bit field and reports garbage above
            // 4 GB, so it is only trusted when it looks sane.
            const raw = Number(info.AdapterRAM);
            const vramGB = Number.isFinite(raw) && raw > 0 ? Math.round(raw / 1e9) : null;
            const vendor = /nvidia/i.test(name) ? 'nvidia'
                : /amd|radeon/i.test(name) ? 'amd'
                : /intel/i.test(name) ? 'intel' : null;
            return {
                vendor, name, vramGB,
                backend: vendor === 'nvidia' ? 'cuda' : vendor ? 'directml' : 'cpu',
            };
        } catch {
            return { vendor: null, backend: 'cpu', name: null, vramGB: null };
        }
    }

    // Linux: nvidia-smi is definitive when present.
    const smi = await run('nvidia-smi',
        ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], 8000);
    if (smi) {
        const [name, vram] = smi.split(/\r?\n/)[0].split(',').map((s) => s.trim());
        return {
            vendor: 'nvidia', backend: 'cuda', name,
            vramGB: Number.isFinite(Number(vram)) ? Math.round(Number(vram) / 1024) : null,
        };
    }
    return { vendor: null, backend: 'cpu', name: null, vramGB: null };
}

// ── dependencies ────────────────────────────────────────────────────────────

/** Ollama: on PATH, and is its API actually answering? */
async function ollama(host = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434') {
    const bin = await which('ollama');
    let apiUp = false;
    let models = [];

    try {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 3000);
        const res = await fetch(`${host}/api/tags`, { signal: controller.signal });
        clearTimeout(t);
        if (res.ok) {
            apiUp = true;
            const data = await res.json();
            models = (data.models || []).map((m) => m.name);
        }
    } catch { /* not running; installed-ness is a separate question */ }

    return { installed: Boolean(bin), path: bin, apiUp, host, models };
}

/**
 * System Python.
 *
 * MOSTLY IRRELEVANT, and saying so matters. The STT and TTS servers launch via
 * `uv run --python 3.12`, and uv downloads and manages that interpreter itself.
 * A machine with only Python 3.8 on PATH runs Jarvis perfectly.
 *
 * So this is reported for completeness and only becomes a real problem when uv
 * is ALSO missing — see `pythonRequired` in the bootstrapper. Flagging 3.8 as a
 * failure on a machine where uv makes it moot would send someone off to install
 * something they do not need.
 */
async function python() {
    for (const bin of ['python3', 'python', 'py']) {
        const found = await which(bin);
        if (!found) continue;
        const out = await run(found, ['--version'], 6000);
        const m = out && out.match(/Python (\d+)\.(\d+)\.(\d+)/);
        if (!m) continue;
        const [major, minor] = [Number(m[1]), Number(m[2])];
        // The Windows Store stub answers `where python` but fails to run,
        // which is why the version is parsed rather than assumed from PATH.
        return {
            installed: true, path: found, version: `${m[1]}.${m[2]}.${m[3]}`,
            adequate: major === 3 && minor >= 10,
        };
    }
    return { installed: false, path: null, version: null, adequate: false };
}

/** uv, the environment manager the STT/TTS servers are launched with. */
async function uv() {
    const bin = await which('uv');
    if (!bin) return { installed: false, path: null, version: null };
    const out = await run(bin, ['--version'], 6000);
    return { installed: true, path: bin, version: out ? out.replace(/^uv\s*/, '') : null };
}

/** ffmpeg — optional, used for audio conversion. */
async function ffmpeg() {
    const bin = await which('ffmpeg');
    return { installed: Boolean(bin), path: bin };
}

/** Is a TCP port already taken? Used to detect a stale or rival service. */
function portInUse(port, host = '127.0.0.1') {
    return new Promise((resolve) => {
        const net = require('node:net');
        const socket = net.createConnection({ port, host });
        const done = (inUse) => { socket.destroy(); resolve(inUse); };
        socket.setTimeout(1200);
        socket.on('connect', () => done(true));
        socket.on('timeout', () => done(false));
        socket.on('error', () => done(false));
    });
}

/**
 * Everything at once.
 *
 * Probes run in PARALLEL — they are independent, and running them in sequence
 * made `jarvis doctor` take eight seconds for no reason.
 */
async function detectAll({ installDir } = {}) {
    const p = platform();
    const [gpuInfo, ollamaInfo, pyInfo, uvInfo, ffInfo] = await Promise.all([
        gpu(), ollama(), python(), uv(), ffmpeg(),
    ]);

    return {
        platform: p,
        linux: linuxFamily(),
        resources: resources(installDir),
        gpu: gpuInfo,
        ollama: ollamaInfo,
        python: pyInfo,
        uv: uvInfo,
        ffmpeg: ffInfo,
        node: { version: process.versions.node, adequate: Number(process.versions.node.split('.')[0]) >= 22 },
    };
}

module.exports = {
    run, which, platform, linuxFamily, resources, gpu,
    ollama, python, uv, ffmpeg, portInUse, detectAll,
};
