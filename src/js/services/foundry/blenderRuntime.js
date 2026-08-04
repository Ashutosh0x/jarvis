// Finding, verifying and installing the Blender that Foundry drives.
//
// IMPURE: filesystem, network, child processes.
//
// ---------------------------------------------------------------------------
// THE SOURCE TREE IS NOT A RUNTIME
//
// C:\Users\ashut\OneDrive\Documents\blender\blender holds the Blender 5.3-alpha
// SOURCE — 2M+ lines of C++ that this project reads to check API names against,
// and which contains no executable. Building it needs Visual Studio 2022, the
// ~40 GB precompiled library set, and hours; and the output would be an alpha.
//
// So the runtime is a separate concern from the source, and this file keeps
// them separate. `resolveSource()` points at the tree for verification;
// everything else is about a stable binary that can actually render.
// ---------------------------------------------------------------------------

import { spawn, execFile } from 'node:child_process';
import { createWriteStream, promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

/** Where a downloaded portable build lives. Beside the app data, not in Program Files: no admin rights needed. */
export function runtimeRoot() {
    return path.join(os.homedir(), '.jarvis', 'foundry', 'blender');
}

/** The source tree used for API verification. Read-only, never executed. */
export function resolveSource() {
    return path.join(os.homedir(), 'OneDrive', 'Documents', 'blender', 'blender');
}

/**
 * Candidate locations for a blender executable, most specific first.
 *
 * JARVIS_BLENDER wins so a user with an install somewhere unusual is never
 * blocked by this list being incomplete — the list is a convenience, not the
 * mechanism.
 */
function candidates() {
    const exe = process.platform === 'win32' ? 'blender.exe' : 'blender';
    const out = [];
    if (process.env.JARVIS_BLENDER) out.push(process.env.JARVIS_BLENDER);
    out.push(path.join(runtimeRoot(), 'current', exe));
    if (process.platform === 'win32') {
        out.push(path.join('C:', 'Program Files', 'Blender Foundation', 'Blender', exe));
    } else if (process.platform === 'darwin') {
        out.push('/Applications/Blender.app/Contents/MacOS/Blender');
    } else {
        out.push('/usr/bin/blender', '/usr/local/bin/blender', '/snap/bin/blender');
    }
    return out;
}

async function isFile(p) {
    try { return (await fs.stat(p)).isFile(); } catch { return false; }
}

/**
 * Find a usable Blender, and prove it runs.
 *
 * Existence is not usability: a partial extraction, a build missing its shared
 * libraries, or a file that is not Blender at all all pass an fs.stat. So the
 * candidate is executed with `--version` and has to answer. The cost is a few
 * hundred milliseconds once at startup, and what it buys is that every later
 * failure is about the scene rather than about the binary.
 *
 * Version-gated at 4.2: the exporter operator names this project uses
 * (wm.stl_export) and the Principled BSDF socket names ("Transmission Weight")
 * both changed in the 4.x line, and running against 3.x would fail deep inside
 * a render with an AttributeError rather than here with a sentence.
 */
export async function locateBlender() {
    const tried = [];
    for (const candidate of candidates()) {
        if (!candidate || !(await isFile(candidate))) { tried.push({ path: candidate, reason: 'not found' }); continue; }

        const probe = await new Promise((resolve) => {
            execFile(candidate, ['--version'], { timeout: 30_000 }, (err, stdout) => {
                if (err) return resolve({ ok: false, reason: err.message });
                const m = String(stdout).match(/Blender\s+(\d+)\.(\d+)(?:\.(\d+))?/i);
                if (!m) return resolve({ ok: false, reason: 'ran but did not identify itself as Blender' });
                resolve({ ok: true, major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3] || 0), version: `${m[1]}.${m[2]}.${m[3] || 0}` });
            });
        });

        if (!probe.ok) { tried.push({ path: candidate, reason: probe.reason }); continue; }

        if (probe.major < 4 || (probe.major === 4 && probe.minor < 2)) {
            tried.push({ path: candidate, reason: `version ${probe.version} is below the 4.2 minimum this pipeline targets` });
            continue;
        }
        return { found: true, path: candidate, version: probe.version, tried };
    }
    return { found: false, path: null, version: null, tried };
}

/**
 * Discover the newest stable release from blender.org.
 *
 * Deliberately NOT a hardcoded version string. A pinned URL is correct for
 * exactly as long as it takes for the next release, and then it 404s with no
 * explanation of why. The directory index is the authority, so this asks it.
 *
 * Alphas, betas and release candidates are excluded: this is the machine that
 * renders, and an RC that crashes on export is not a trade worth making for a
 * point release.
 */
export async function discoverLatestRelease(fetchImpl = fetch) {
    const base = 'https://download.blender.org/release/';
    const indexResponse = await fetchImpl(base);
    if (!indexResponse.ok) throw new Error(`blender.org release index returned ${indexResponse.status}`);
    const index = await indexResponse.text();

    const series = [...index.matchAll(/href="Blender(\d+)\.(\d+)\/"/g)]
        .map((m) => ({ major: Number(m[1]), minor: Number(m[2]), dir: `Blender${m[1]}.${m[2]}/` }))
        .sort((a, b) => (b.major - a.major) || (b.minor - a.minor));
    if (!series.length) throw new Error('no Blender release directories found in the index');

    const platform = process.platform === 'win32' ? 'windows-x64'
        : process.platform === 'darwin' ? (process.arch === 'arm64' ? 'macos-arm64' : 'macos-x64')
            : 'linux-x64';
    const ext = process.platform === 'win32' ? 'zip' : process.platform === 'darwin' ? 'dmg' : 'tar.xz';

    /* Walk newest-first: the top series can exist as a directory before it has
       a build for this platform, which is a 404 waiting to happen if we assume
       the first hit is downloadable. */
    for (const s of series.slice(0, 6)) {
        const dirResponse = await fetchImpl(base + s.dir);
        if (!dirResponse.ok) continue;
        const listing = await dirResponse.text();

        const pattern = new RegExp(`href="(blender-(\\d+\\.\\d+\\.\\d+)-${platform}\\.${ext.replace('.', '\\.')})"`, 'g');
        const builds = [...listing.matchAll(pattern)]
            .map((m) => ({ file: m[1], version: m[2] }))
            .filter((b) => !/alpha|beta|rc/i.test(b.file))
            .sort((a, b) => {
                const pa = a.version.split('.').map(Number);
                const pb = b.version.split('.').map(Number);
                return (pb[0] - pa[0]) || (pb[1] - pa[1]) || (pb[2] - pa[2]);
            });
        if (!builds.length) continue;

        const build = builds[0];
        return {
            version: build.version,
            url: base + s.dir + build.file,
            sha256Url: `${base}${s.dir}blender-${build.version}.sha256`,
            filename: build.file
        };
    }
    throw new Error(`no stable ${platform} build found in the six most recent release series`);
}

/**
 * Download, verify and extract a portable build.
 *
 * The checksum is not optional decoration. This downloads ~400 MB over the
 * network and then runs it, so an unverified archive is an unverified
 * executable. blender.org publishes a .sha256 per release; when the file is
 * fetchable the hash MUST match, and when it is not fetchable that is reported
 * rather than silently skipped — "could not verify" and "verified" are
 * different states and the caller is told which one it got.
 *
 * @param {(e:{phase:string, percent?:number, detail?:string}) => void} [onProgress]
 */
export async function installPortable({ onProgress = () => { }, fetchImpl = fetch } = {}) {
    const release = await discoverLatestRelease(fetchImpl);
    onProgress({ phase: 'resolved', detail: `Blender ${release.version}` });

    const root = runtimeRoot();
    await fs.mkdir(root, { recursive: true });
    const archivePath = path.join(root, release.filename);

    /* --- expected hash, before the bytes --- */
    let expected = null;
    try {
        const sumResponse = await fetchImpl(release.sha256Url);
        if (sumResponse.ok) {
            const text = await sumResponse.text();
            const line = text.split('\n').find((l) => l.includes(release.filename));
            if (line) expected = line.trim().split(/\s+/)[0].toLowerCase();
        }
    } catch { /* reported below as unverified rather than thrown */ }

    /* --- download --- */
    onProgress({ phase: 'downloading', detail: release.url });
    const response = await fetchImpl(release.url);
    if (!response.ok) throw new Error(`download failed with ${response.status}`);
    const total = Number(response.headers.get('content-length') || 0);

    const hash = createHash('sha256');
    const sink = createWriteStream(archivePath);
    let received = 0;
    let lastPercent = -1;

    const reader = response.body.getReader();
    for (; ;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        hash.update(value);
        if (!sink.write(Buffer.from(value))) {
            await new Promise((resolve) => sink.once('drain', resolve));
        }
        if (total) {
            const percent = Math.floor((received / total) * 100);
            if (percent !== lastPercent && percent % 5 === 0) { lastPercent = percent; onProgress({ phase: 'downloading', percent }); }
        }
    }
    await new Promise((resolve, reject) => { sink.end(resolve); sink.on('error', reject); });

    const actual = hash.digest('hex');
    if (expected && actual !== expected) {
        await fs.rm(archivePath, { force: true });
        throw new Error(`checksum mismatch: expected ${expected}, got ${actual}. The archive was deleted and NOT extracted.`);
    }
    const verification = expected ? 'sha256 verified against blender.org' : 'NOT VERIFIED — blender.org did not serve a checksum for this release';
    onProgress({ phase: 'verified', detail: verification });

    /* --- extract --- */
    onProgress({ phase: 'extracting' });
    const extractDir = path.join(root, `blender-${release.version}`);
    await fs.rm(extractDir, { recursive: true, force: true });
    await fs.mkdir(extractDir, { recursive: true });

    if (process.platform === 'win32') {
        /* Expand-Archive is present on every supported Windows and needs no
           dependency. It is slow on a 400 MB zip (minutes) — the alternative
           is bundling a native unzip, which is a build-chain problem for a
           one-off operation. */
        await new Promise((resolve, reject) => {
            const ps = spawn('powershell.exe', [
                '-NoProfile', '-NonInteractive', '-Command',
                `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${extractDir}' -Force`
            ], { stdio: ['ignore', 'pipe', 'pipe'] });
            let stderr = '';
            ps.stderr.on('data', (d) => { stderr += d; });
            ps.on('close', (code) => code === 0 ? resolve() : reject(new Error(`extraction failed (${code}): ${stderr.slice(0, 400)}`)));
            ps.on('error', reject);
        });
    } else {
        await new Promise((resolve, reject) => {
            const tar = spawn('tar', ['-xf', archivePath, '-C', extractDir], { stdio: 'ignore' });
            tar.on('close', (code) => code === 0 ? resolve() : reject(new Error(`tar exited ${code}`)));
            tar.on('error', reject);
        });
    }

    /* The zip contains a single versioned top-level folder. Find it rather
       than construct its name — the naming has changed between releases. */
    const entries = await fs.readdir(extractDir, { withFileTypes: true });
    const inner = entries.find((e) => e.isDirectory() && e.name.toLowerCase().startsWith('blender'));
    const payload = inner ? path.join(extractDir, inner.name) : extractDir;

    /* `current` is what candidates() looks for, so upgrading is a matter of
       repointing it. Junction rather than symlink on Windows: symlinks need
       either developer mode or elevation, junctions need neither. */
    const currentLink = path.join(root, 'current');
    await fs.rm(currentLink, { recursive: true, force: true });
    try {
        await fs.symlink(payload, currentLink, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
        /* Some Windows configurations refuse even junctions. Copying works
           everywhere and costs disk, which is the cheaper failure. */
        await fs.cp(payload, currentLink, { recursive: true });
    }

    await fs.rm(archivePath, { force: true });

    const located = await locateBlender();
    if (!located.found) throw new Error('extraction finished but no runnable blender was found afterwards');

    return { version: release.version, path: located.path, verification, bytes: received };
}

export default { runtimeRoot, resolveSource, locateBlender, discoverLatestRelease, installPortable };
