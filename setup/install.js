// ---------------------------------------------------------------------------
// Installing what is missing.
//
// RULES THIS FILE FOLLOWS, because installers run with the user's authority
// and a mistake here is not a wrong answer, it is a wrong program on the disk:
//
//   * HTTPS only, official vendor hosts only, no redirects to other origins.
//   * Nothing is executed that was not downloaded from that allowlist.
//   * Nothing is installed that detection said was already present.
//   * No elevation is requested. Where a platform genuinely requires admin,
//     the step is REPORTED as manual with the exact command, rather than
//     silently prompting for a password the user did not expect.
//   * Every step is resumable: a failure leaves the machine in the state it
//     was in, and re-running continues rather than starting over.
//
// Windows is the platform this was developed and verified on. The macOS and
// Linux paths are written from each vendor's documented install method but
// have NOT been run — see the note on each.
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');

const detect = require('./detect.js');

/** Hosts an installer may be fetched from. Anything else is refused. */
const ALLOWED_HOSTS = new Set([
    'ollama.com',
    'github.com',
    'objects.githubusercontent.com',   // GitHub release asset redirects land here
    'release-assets.githubusercontent.com',
    'astral.sh',
]);

/**
 * Download to disk, following redirects only within the allowlist.
 *
 * @param {(pct:number|null, received:number, total:number|null) => void} [onProgress]
 */
async function download(url, destPath, onProgress) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
        throw new Error(`Refusing a non-HTTPS download: ${url}`);
    }
    if (!ALLOWED_HOSTS.has(parsed.hostname)) {
        // An installer from an unexpected host is the one thing that must
        // never be silently executed.
        throw new Error(`Refusing a download from an unapproved host: ${parsed.hostname}`);
    }

    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`);

    // Re-check after redirects — the final URL is what actually served bytes.
    const finalHost = new URL(res.url).hostname;
    if (!ALLOWED_HOSTS.has(finalHost)) {
        throw new Error(`Download redirected to an unapproved host: ${finalHost}`);
    }

    const total = Number(res.headers.get('content-length')) || null;
    let received = 0;

    await fsp.mkdir(path.dirname(destPath), { recursive: true });
    const tmp = `${destPath}.partial`;

    const body = Readable.fromWeb(res.body);
    body.on('data', (chunk) => {
        received += chunk.length;
        if (onProgress) {
            onProgress(total ? Math.round((received / total) * 100) : null, received, total);
        }
    });

    await pipeline(body, fs.createWriteStream(tmp));
    // Rename only on success, so an interrupted download never looks complete.
    await fsp.rename(tmp, destPath);
    return { path: destPath, bytes: received };
}

/** SHA-256 of a file, for checking a published digest. */
async function sha256(filePath) {
    const hash = crypto.createHash('sha256');
    await pipeline(fs.createReadStream(filePath), hash);
    return hash.digest('hex');
}

/** Run a command, streaming output to a callback. Resolves with the exit code. */
function runStreaming(cmd, args, { onLine, cwd, timeout = 900000 } = {}) {
    return new Promise((resolve) => {
        const child = spawn(cmd, args, { cwd, windowsHide: true, shell: false });
        let settled = false;
        const finish = (code) => { if (!settled) { settled = true; resolve(code); } };

        const feed = (buf) => {
            for (const line of String(buf).split(/\r?\n/)) {
                if (line.trim() && onLine) onLine(line.trim());
            }
        };
        child.stdout?.on('data', feed);
        child.stderr?.on('data', feed);
        child.on('error', () => finish(-1));
        child.on('close', finish);

        const timer = setTimeout(() => { try { child.kill(); } catch {} finish(-2); }, timeout);
        child.on('close', () => clearTimeout(timer));
    });
}

// ── Ollama ──────────────────────────────────────────────────────────────────

/**
 * Where to get Ollama, per platform.
 *
 * These are the vendor's own documented download URLs. Windows is verified.
 * macOS and Linux are documented-but-unrun here — flagged in `verified`, and
 * the bootstrapper surfaces that rather than implying equal confidence.
 */
function ollamaSource() {
    const p = detect.platform();
    if (p.os === 'windows') {
        return {
            url: 'https://ollama.com/download/OllamaSetup.exe',
            file: 'OllamaSetup.exe',
            // /VERYSILENT is the Inno Setup flag Ollama's installer honours,
            // and it installs per-user so no elevation prompt appears.
            install: (file) => ({ cmd: file, args: ['/VERYSILENT', '/NORESTART'] }),
            verified: true,
        };
    }
    if (p.os === 'macos') {
        return {
            url: 'https://ollama.com/download/Ollama-darwin.zip',
            file: 'Ollama-darwin.zip',
            install: (file) => ({ cmd: 'unzip', args: ['-o', file, '-d', '/Applications'] }),
            verified: false,
        };
    }
    // Linux: the vendor ships a shell installer. It is NOT piped to sh here —
    // it is downloaded, then run, so what executes is a file on disk that
    // could be inspected, not a stream from the network.
    return {
        url: 'https://ollama.com/install.sh',
        file: 'ollama-install.sh',
        install: (file) => ({ cmd: 'sh', args: [file] }),
        verified: false,
    };
}

/**
 * Install Ollama if it is missing.
 * @returns {{ status: 'present'|'installed'|'manual'|'failed', detail?: string }}
 */
async function installOllama({ onProgress, onLine, cacheDir } = {}) {
    const current = await detect.ollama();
    if (current.installed) return { status: 'present', detail: current.path };

    const src = ollamaSource();
    const dir = cacheDir || path.join(os.tmpdir(), 'jarvis-setup');
    const dest = path.join(dir, src.file);

    try {
        onLine?.(`Downloading Ollama from ${new URL(src.url).hostname}`);
        await download(src.url, dest, onProgress);
    } catch (e) {
        return {
            status: 'manual',
            detail: `Could not download Ollama (${e.message}). Install it from https://ollama.com/download`,
        };
    }

    const { cmd, args } = src.install(dest);
    onLine?.('Running the Ollama installer');
    const code = await runStreaming(cmd, args, { onLine });

    if (code !== 0) {
        return {
            status: 'manual',
            detail: `The Ollama installer exited with ${code}. Install it from https://ollama.com/download`,
        };
    }

    // Trust the check, not the exit code — an installer can succeed and still
    // leave nothing on PATH until the shell is restarted.
    const after = await detect.ollama();
    return after.installed
        ? { status: 'installed', detail: after.path }
        : {
            status: 'manual',
            detail: 'Ollama installed but is not on PATH yet. Open a new terminal, or restart Jarvis.',
        };
}

/** Start `ollama serve` if the API is not answering, and wait for it. */
async function startOllama({ onLine, timeoutMs = 30000 } = {}) {
    const before = await detect.ollama();
    if (before.apiUp) return { status: 'running', models: before.models };
    if (!before.installed) return { status: 'missing' };

    onLine?.('Starting Ollama');
    // Detached: Ollama outlives this process, which is what we want — it is a
    // background service, not a child of the installer.
    try {
        const child = spawn(before.path || 'ollama', ['serve'], {
            detached: true, stdio: 'ignore', windowsHide: true,
        });
        child.unref();
    } catch (e) {
        return { status: 'failed', detail: e.message };
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 700));
        const now = await detect.ollama();
        if (now.apiUp) return { status: 'started', models: now.models };
    }
    return { status: 'failed', detail: 'Ollama did not answer within 30 seconds.' };
}

/**
 * Pull a model, reporting progress.
 *
 * Uses the HTTP API rather than the CLI so progress is structured rather than
 * scraped from a terminal spinner. Ollama streams NDJSON status objects.
 */
async function pullModel(model, { host, onProgress, onLine } = {}) {
    const base = host || process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';

    const existing = await detect.ollama(base);
    if (!existing.apiUp) return { status: 'failed', detail: 'Ollama is not running.' };

    // Never re-download. Tags are matched loosely because `gemma3:4b` is listed
    // as `gemma3:4b` but sometimes carries a digest suffix.
    const has = existing.models.some((m) => m === model || m.startsWith(`${model}@`)
        || m.split(':')[0] === model.split(':')[0] && m.split(':')[1] === model.split(':')[1]);
    if (has) return { status: 'present', model };

    onLine?.(`Downloading ${model}`);
    const res = await fetch(`${base}/api/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, stream: true }),
    });
    if (!res.ok || !res.body) {
        return { status: 'failed', detail: `Pull request failed (${res.status})` };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let lastPct = -1;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
            if (!line.trim()) continue;
            let msg;
            try { msg = JSON.parse(line); } catch { continue; }
            if (msg.error) return { status: 'failed', detail: msg.error };

            if (msg.total && msg.completed) {
                const pct = Math.round((msg.completed / msg.total) * 100);
                // Only report movement — Ollama emits many updates per second
                // and every one of them would repaint the progress line.
                if (pct !== lastPct) {
                    lastPct = pct;
                    onProgress?.(pct, msg.completed, msg.total);
                }
            }
        }
    }

    const after = await detect.ollama(base);
    return after.models.some((m) => m.startsWith(model.split(':')[0]))
        ? { status: 'pulled', model }
        : { status: 'failed', detail: `${model} did not appear after pulling.` };
}

// ── uv ──────────────────────────────────────────────────────────────────────

/**
 * Install uv, which is what actually runs the speech servers.
 *
 * uv brings its own Python — the servers launch with `uv run --python 3.12` —
 * so installing uv removes the need to install Python at all. That is why this
 * is attempted before any Python step.
 */
async function installUv({ onLine, cacheDir } = {}) {
    const current = await detect.uv();
    if (current.installed) return { status: 'present', detail: current.version };

    const p = detect.platform();
    const dir = cacheDir || path.join(os.tmpdir(), 'jarvis-setup');

    try {
        if (p.os === 'windows') {
            const dest = path.join(dir, 'uv-install.ps1');
            await download('https://astral.sh/uv/install.ps1', dest);
            onLine?.('Installing uv');
            const code = await runStreaming('powershell', [
                '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', dest,
            ], { onLine });
            if (code !== 0) throw new Error(`installer exited ${code}`);
        } else {
            const dest = path.join(dir, 'uv-install.sh');
            await download('https://astral.sh/uv/install.sh', dest);
            onLine?.('Installing uv');
            const code = await runStreaming('sh', [dest], { onLine });
            if (code !== 0) throw new Error(`installer exited ${code}`);
        }
    } catch (e) {
        return {
            status: 'manual',
            detail: `Could not install uv (${e.message}). See https://docs.astral.sh/uv/getting-started/installation/`,
        };
    }

    const after = await detect.uv();
    return after.installed
        ? { status: 'installed', detail: after.version }
        : { status: 'manual', detail: 'uv installed but is not on PATH yet. Open a new terminal.' };
}

// ── model choice ────────────────────────────────────────────────────────────

/**
 * Which models this machine should run.
 *
 * Chosen from measured RAM and VRAM rather than asked. The defaults are the
 * two Jarvis actually requires; anything larger is offered only when there is
 * genuinely room, because a model that swaps is slower than the smaller one it
 * replaced and feels broken rather than clever.
 */
function chooseModels({ totalRamGB, vramGB, freeDiskGB } = {}) {
    const required = ['gemma3:4b', 'nomic-embed-text'];
    const ram = Number(totalRamGB) || 0;
    const vram = Number(vramGB) || 0;
    /* `Number(null)` is 0, not NaN — and detect.js returns null for free disk
       whenever statfsSync cannot answer. Coercing that to a number turned
       "I could not measure this disk" into "this disk has zero bytes free",
       which refuses to install anything on a machine that is probably fine.
       Unknown must stay unknown. */
    const disk = freeDiskGB === null || freeDiskGB === undefined || freeDiskGB === ''
        ? NaN
        : Number(freeDiskGB);

    // Roughly 3.3 GB for gemma3:4b plus 0.3 GB for the embedder.
    const requiredGB = 3.6;
    const optionalGB = 8.5;

    const optional = [];
    // RAM decides whether a bigger model would RUN; disk decides whether it
    // can be stored at all. Recommending a 12b on a machine with 5 GB free
    // produces a download that fills the disk and then fails — measured on
    // exactly such a machine while writing this.
    const roomForOptional = !Number.isFinite(disk) || disk >= requiredGB + optionalGB + 5;
    if (roomForOptional) {
        if (ram >= 32 || vram >= 16) optional.push('gemma3:12b');
        else if (ram >= 16 || vram >= 10) optional.push('qwen2.5:7b');
    }

    // Enough space for what is actually required?
    const diskOk = !Number.isFinite(disk) || disk >= requiredGB + 2;

    return {
        required,
        optional,
        estimatedGB: requiredGB,
        diskOk,
        freeDiskGB: Number.isFinite(disk) ? disk : null,
        reason: ram
            ? `${ram} GB RAM${vram ? `, ${vram} GB VRAM` : ''}`
              + (Number.isFinite(disk) ? `, ${disk} GB free` : '')
              + (!roomForOptional && Number.isFinite(disk) ? ' — too little disk for a larger model' : '')
            : 'unknown resources — defaulting to the required pair only',
    };
}

module.exports = {
    download, sha256, runStreaming,
    ollamaSource, installOllama, startOllama, pullModel,
    installUv, chooseModels, ALLOWED_HOSTS,
};
