// Reading back what Foundry has already built.
//
// IMPURE: filesystem only. No spawn, no network, no Blender.
//
// ---------------------------------------------------------------------------
// THE WORKSPACE IS THE DATABASE
//
// Every job writes spec.json, job.py, result.json and its outputs into one
// directory. That is already a complete, self-describing record, so there is no
// separate index to keep in step with it — and nothing to repair when the two
// disagree, because there is only one.
//
// The cost is a directory scan per listing. On this workspace that is a few
// dozen entries and single-digit milliseconds, and it stays correct when jobs
// are deleted by hand, which an index would not.
//
// A job with no result.json is one that crashed or is still running. Those are
// reported with `ok: false` rather than hidden: "the last thing you asked for
// failed" is the answer to "show me the model" in that case, and silently
// showing the one before it would be a lie by omission.
// ---------------------------------------------------------------------------

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { workspaceRoot } from './blenderBridge.js';
import { isConfined } from './sceneSpec.js';

/** Image types the viewer can display. */
const VIEWABLE = new Set(['.png', '.jpg', '.jpeg', '.webp']);

async function readJson(file) {
    try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; }
}

/**
 * List jobs, newest first.
 *
 * @param {{limit?:number}} [opts]
 * @returns {Promise<Array>} job summaries; never throws for a bad directory,
 *   because one unreadable job must not hide the rest.
 */
export async function listJobs({ limit = 50 } = {}) {
    const root = path.resolve(workspaceRoot());

    let entries;
    try {
        entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
        return [];      // nothing built yet is not an error
    }

    const jobs = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(root, entry.name);
        if (!isConfined(dir, root)) continue;

        const [result, spec, stat] = await Promise.all([
            readJson(path.join(dir, 'result.json')),
            readJson(path.join(dir, 'spec.json')),
            fs.stat(dir).catch(() => null)
        ]);

        /* A directory with neither file is not a job — a stray folder, or one
           being written right now. Skip rather than surface an empty card. */
        if (!result && !spec) continue;

        const image = result?.image && VIEWABLE.has(path.extname(result.image).toLowerCase())
            ? result.image
            : null;

        /* The mesh the 3D viewer orbits. Jobs built before GLB export became
           automatic have none, which the viewer reports and offers to fix by
           rebuilding from the spec that is sitting right there. */
        const mesh = (result?.exports ?? []).find((e) => e.format === 'glb' && e.written);

        jobs.push({
            jobId: entry.name,
            dir,
            mesh: mesh?.path ?? null,
            hasMesh: !!mesh,
            hasSpec: !!spec,
            name: spec?.name ?? result?.build?.objects?.[0] ?? entry.name,
            ok: result?.ok === true,
            /* An unfinished job has no result. Say which it is rather than
               folding it into "failed". */
            state: !result ? 'incomplete' : (result.ok ? 'done' : 'failed'),
            stage: result?.stage ?? null,
            error: result?.error ?? null,
            image,
            hasImage: !!image,
            objects: result?.build?.objects ?? [],
            polygons: result?.build?.polygons ?? null,
            engine: result?.build?.engine ?? spec?.render?.engine ?? null,
            device: result?.build?.device ?? null,
            warnings: result?.build?.warnings ?? [],
            seconds: result?.seconds ?? null,
            exports: result?.exports ?? [],
            printability: result?.printability ?? null,
            resolution: spec?.render?.resolution ?? null,
            mtime: stat?.mtimeMs ?? 0
        });
    }

    jobs.sort((a, b) => b.mtime - a.mtime);
    return jobs.slice(0, limit);
}

/**
 * Resolve "which one did they mean".
 *
 * @param {{position?:string, name?:string}} which
 */
export async function resolveJob(which = { position: 'newest' }) {
    const jobs = await listJobs();
    if (!jobs.length) return { jobs: [], job: null, reason: 'nothing has been built yet' };

    if (which.position === 'oldest') return { jobs, job: jobs[jobs.length - 1], reason: null };

    if (which.position === 'named' && which.name) {
        const needle = String(which.name).toLowerCase().replace(/[\s_-]+/g, '');
        const hit = jobs.find((j) => String(j.name).toLowerCase().replace(/[\s_-]+/g, '').includes(needle))
            || jobs.find((j) => j.objects.some((o) => String(o).toLowerCase().replace(/[\s_-]+/g, '').includes(needle)));
        /* Falling back to the newest is right, and saying so is the part that
           matters: showing a different model than the one asked for without a
           word is the failure this project keeps removing. */
        if (hit) return { jobs, job: hit, reason: null };
        return { jobs, job: jobs[0], reason: `nothing named "${which.name}" — showing the most recent instead` };
    }

    return { jobs, job: jobs[0], reason: null };
}

/**
 * Read one job's image as a data URL.
 *
 * Sent over IPC on demand rather than bundled into the listing: a render is
 * ~300 KB, so base64-ing every job into a gallery response would be tens of
 * megabytes across the bridge to draw one picture.
 *
 * Confinement is re-checked here even though listJobs already filtered, because
 * this takes a jobId from the renderer and the renderer takes it from a voice
 * command. A path is only inert until someone constructs one.
 */
export async function jobImage(jobId) {
    const root = path.resolve(workspaceRoot());
    const dir = path.resolve(root, String(jobId ?? ''));
    if (!isConfined(dir, root)) return { ok: false, error: 'that job is outside the Foundry workspace' };

    const result = await readJson(path.join(dir, 'result.json'));
    if (!result?.image) return { ok: false, error: 'that job produced no image' };

    const file = path.resolve(result.image);
    if (!isConfined(file, root)) return { ok: false, error: 'the image is outside the Foundry workspace' };

    const ext = path.extname(file).toLowerCase();
    if (!VIEWABLE.has(ext)) return { ok: false, error: `${ext} is not a viewable image` };

    try {
        const bytes = await fs.readFile(file);
        const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
        return { ok: true, dataUrl: `data:${mime};base64,${bytes.toString('base64')}`, bytes: bytes.length, path: file };
    } catch (e) {
        return { ok: false, error: `could not read the image: ${e.message}` };
    }
}

/**
 * Read one job's GLB for the 3D viewer.
 *
 * Sent as base64 over IPC. A GLB from this pipeline is tens to hundreds of
 * kilobytes — the 552-polygon bracket is about 40 KB — so the encoding overhead
 * is not worth a custom protocol handler, which would also have to be
 * registered before the first window and torn down with it.
 *
 * Confinement is re-checked here for the same reason jobImage re-checks it:
 * the jobId arrives from the renderer, which took it from a voice command.
 */
export async function jobMesh(jobId) {
    const root = path.resolve(workspaceRoot());
    const dir = path.resolve(root, String(jobId ?? ''));
    if (!isConfined(dir, root)) return { ok: false, error: 'that job is outside the Foundry workspace' };

    const result = await readJson(path.join(dir, 'result.json'));
    const entry = (result?.exports ?? []).find((e) => e.format === 'glb' && e.written);
    if (!entry) {
        /* Distinguish "never exported" from "export failed": the first is
           fixable by rebuilding, the second is a bug worth seeing. */
        const spec = await readJson(path.join(dir, 'spec.json'));
        return {
            ok: false,
            error: 'this job has no mesh — it was built before GLB export became automatic',
            canRebuild: !!spec
        };
    }

    const file = path.resolve(entry.path);
    if (!isConfined(file, root)) return { ok: false, error: 'the mesh is outside the Foundry workspace' };

    try {
        const bytes = await fs.readFile(file);
        return { ok: true, base64: bytes.toString('base64'), bytes: bytes.length, path: file };
    } catch (e) {
        return { ok: false, error: `could not read the mesh: ${e.message}`, canRebuild: true };
    }
}

/**
 * Rebuild a job from the spec it saved.
 *
 * This is what makes an old job viewable in 3D: the spec is the complete
 * description, so re-running it reproduces the scene and picks up the GLB
 * export on the way through. It writes a NEW job rather than mutating the old
 * one — the original render stays exactly as it was, which matters because the
 * point of keeping specs is that a run can be replayed and compared.
 */
export async function rebuildJob(jobId) {
    const root = path.resolve(workspaceRoot());
    const dir = path.resolve(root, String(jobId ?? ''));
    if (!isConfined(dir, root)) return { ok: false, error: 'that job is outside the Foundry workspace' };

    const spec = await readJson(path.join(dir, 'spec.json'));
    if (!spec) return { ok: false, error: 'that job kept no spec, so there is nothing to rebuild from' };

    const { runSpec } = await import('./blenderBridge.js');
    return await runSpec(spec);
}

export default { listJobs, resolveJob, jobImage, jobMesh, rebuildJob };
