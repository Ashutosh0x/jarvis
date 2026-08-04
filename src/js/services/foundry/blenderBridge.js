// Runs a validated spec through Blender and brings the result back.
//
// IMPURE: spawns a process, writes files.
//
// ---------------------------------------------------------------------------
// ONE PROCESS PER JOB, NOT A LONG-LIVED SOCKET SERVER
//
// The plan this implements specified a persistent Blender instance with a
// background socket thread pushing commands onto a queue that bpy.app.timers
// drains on the main thread. That architecture is correct — Blender's C core
// is not thread-safe and that is the standard way around it — and it is the
// wrong trade here, for reasons specific to this machine:
//
//   MEMORY. A resident Blender holds 300-600 MB, and rises with every scene it
//   has ever built unless orphan data is purged perfectly every time. This
//   laptop is simultaneously hosting Ollama with a 3.3 GB model, Electron, and
//   the KV cache budget computed in kvBudget.js. The idle cost is the whole
//   problem being optimised elsewhere in this feature.
//
//   FAILURE ISOLATION. A malformed mesh can hard-crash Blender. With one
//   process per job that is a failed job; with a resident server it is a dead
//   server plus every queued job, and a reconnect path that has to be written
//   and tested and will still be the least-exercised code in the feature.
//
//   STATE. "Render it again but blue" against a resident instance depends on
//   what the previous command left behind. Against a fresh process the spec is
//   the whole truth, which is what makes a run reproducible from its spec file
//   alone — the property that lets a user file a bug that anyone can replay.
//
// What it costs: ~2 seconds of process startup per job. That is real, and it
// is small next to a render, and it buys all three of the above.
//
// The socket server remains the right answer for a live viewport session where
// a human is nudging a value and watching it update. If that gets built, it
// belongs beside this file rather than instead of it.
// ---------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { validateSpec, isConfined } from './sceneSpec.js';
import { locateBlender } from './blenderRuntime.js';
import { emitScript } from './bpyEmitter.js';

/**
 * Where meshes made elsewhere are picked up from.
 *
 * A single directory that specs reference by BARE FILENAME. The directory is
 * Jarvis's to choose and never the model's, which is what keeps an `import`
 * from being able to name an arbitrary path on the disk. This is where a
 * generator — Hunyuan3D, TRELLIS, Tripo, or a file dropped in by hand — leaves
 * its output for Foundry to pick up.
 */
export function importRoot() {
    return process.env.JARVIS_FOUNDRY_IMPORTS || path.join(os.homedir(), '.jarvis', 'foundry', 'imports');
}

/** Where renders and exports land. Everything Foundry writes stays under here. */
export function workspaceRoot() {
    return process.env.JARVIS_FOUNDRY_WORKSPACE || path.join(os.homedir(), '.jarvis', 'foundry', 'work');
}

/**
 * Timeout, chosen from what the work costs rather than a round number.
 *
 * A 64-sample EEVEE render at 960x540 on this hardware is seconds. A Cycles
 * render at 1024 samples on a CPU fallback is tens of minutes, and a voxel
 * remesh on dense geometry can be minutes on its own. 20 minutes is above any
 * legitimate job here and below "the user has gone to bed".
 *
 * It is a kill, not a warning: a Blender that has stopped making progress
 * holds VRAM that Ollama needs to answer the next question.
 */
export const JOB_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * Execute a spec.
 *
 * @param {object} rawSpec        a candidate spec, revalidated here
 * @param {object} [opts]
 * @param {string} [opts.jobId]   directory name under the workspace
 * @param {(line:string)=>void} [opts.onProgress]
 * @returns {Promise<object>} the runner's result, plus paths
 */
export async function runSpec(rawSpec, opts = {}) {
    /* Revalidated even when the caller has already validated. This is the last
       point before a process starts, the spec may have crossed an IPC boundary
       to get here, and validation is microseconds. */
    const validation = validateSpec(rawSpec);
    if (!validation.ok) {
        return { ok: false, stage: 'validate', error: 'the specification is not valid', errors: validation.errors };
    }
    const spec = validation.spec;

    /* EVERY JOB EXPORTS A GLB, asked for or not.

       It is what the viewer orbits. Blender is the only thing in this pipeline
       that can produce a mesh file, and it is already running with the scene
       built — adding the export costs a fraction of a second here, where
       reconstructing it later would mean a second full job.

       glTF is the right container for this and not a preference: it carries the
       PBR material model the Principled BSDF maps onto, so metallic, roughness
       and emission survive into the viewer, and three.js loads it natively. An
       STL would arrive as untextured grey. */
    if (!spec.exports.some((e) => e.format === 'glb')) {
        spec.exports.push({ format: 'glb', filename: `${spec.name}.glb` });
    }

    const blender = await locateBlender();
    if (!blender.found) {
        return {
            ok: false,
            stage: 'locate',
            error: 'no Blender runtime was found',
            /* The tried list is the actionable part — it says exactly which
               paths were checked, so "install it" is a specific instruction
               rather than a shrug. */
            tried: blender.tried,
            hint: 'run `npm run foundry:install` to fetch a portable build, or set JARVIS_BLENDER to an existing blender executable'
        };
    }

    const jobId = opts.jobId || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const root = path.resolve(workspaceRoot());
    const outdir = path.resolve(root, jobId);

    /* Confinement, checked on resolved paths. jobId reaches here from callers
       that may have taken it from a model or a user, and `../../..` is a
       perfectly ordinary string until it is a path. */
    if (!isConfined(outdir, root)) {
        return { ok: false, stage: 'validate', error: 'the job directory would fall outside the Foundry workspace' };
    }

    await fs.mkdir(outdir, { recursive: true });
    const specPath = path.join(outdir, 'spec.json');
    const resultPath = path.join(outdir, 'result.json');
    const scriptPath = path.join(outdir, 'job.py');

    /* The script is GENERATED for this job, from this spec, by bpyEmitter.js.
       Nothing Python-shaped is maintained in the repository — see the note at
       the top of that file about Python being a compilation target here.

       Written beside the spec rather than into a temp directory on purpose:
       the pair is the complete, replayable record of the run. Reproducing a
       bug is `blender -b -P job.py`, with no part of Jarvis involved. */
    const importDir = path.resolve(importRoot());
    await fs.mkdir(importDir, { recursive: true });

    /* Fail here, not inside Blender, when an import names a file that is not
       there. A missing mesh is the commonest thing to go wrong in a
       generator handoff, and the error is far more useful before a process
       starts than as a traceback forty seconds into a job. */
    for (const o of spec.objects) {
        if (!o.import) continue;
        const file = path.resolve(importDir, o.import.file);
        if (!isConfined(file, importDir)) {
            return { ok: false, stage: 'validate', error: `the mesh "${o.import.file}" resolves outside the imports directory` };
        }
        try {
            await fs.access(file);
        } catch {
            return {
                ok: false,
                stage: 'import',
                error: `the mesh "${o.import.file}" is not in the imports directory`,
                hint: `put it in ${importDir}`
            };
        }
    }

    const script = emitScript(spec, { outdir, resultPath, importDir, imageName: `${spec.name}.png` });

    await fs.writeFile(specPath, JSON.stringify(spec, null, 2), 'utf8');
    await fs.writeFile(scriptPath, script, 'utf8');

    const args = [
        '-b',
        '--factory-startup',
        '-noaudio',                 // background audio init fails on headless Windows and prints scary nonsense
        '-P', scriptPath
        /* No `--` arguments: the script carries its own paths as literals, so
           there is no argv parsing to get wrong on either side. */
    ];

    const started = Date.now();
    const proc = spawn(blender.path, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => { timedOut = true; proc.kill('SIGKILL'); }, opts.timeoutMs ?? JOB_TIMEOUT_MS);

    proc.stdout.on('data', (chunk) => {
        const text = chunk.toString();
        stdout += text;
        /* Cycles emits a progress line per tile and EEVEE per sample; forwarding
           every one of them floods the UI. Only the phase changes are useful. */
        if (opts.onProgress) {
            for (const line of text.split('\n')) {
                if (/^(Fra:|Saved:|Blender quit)/.test(line.trim())) opts.onProgress(line.trim());
            }
        }
    });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    const exit = await new Promise((resolve) => {
        proc.on('error', (err) => resolve({ code: null, error: err }));
        proc.on('close', (code) => resolve({ code }));
    });
    clearTimeout(timer);

    if (exit.error) {
        return { ok: false, stage: 'spawn', error: `could not start Blender: ${exit.error.message}`, blender: blender.path };
    }
    if (timedOut) {
        return { ok: false, stage: 'timeout', error: `Blender was killed after ${Math.round((opts.timeoutMs ?? JOB_TIMEOUT_MS) / 1000)}s without finishing`, outdir, stdout: stdout.slice(-2000) };
    }

    /* The result FILE is the contract — see the note at the top of
       jarvis_runner.py about why the exit code is not trustworthy. Stdout is
       the fallback for the case where the file could not be written at all. */
    let result = null;
    try {
        result = JSON.parse(await fs.readFile(resultPath, 'utf8'));
    } catch {
        const framed = stdout.match(/JARVIS_FOUNDRY_RESULT_BEGIN\r?\n([\s\S]*?)\r?\nJARVIS_FOUNDRY_RESULT_END/);
        if (framed) { try { result = JSON.parse(framed[1]); } catch { /* fall through */ } }
    }

    if (!result) {
        return {
            ok: false,
            stage: 'result',
            error: 'Blender exited without producing a result',
            exitCode: exit.code,
            outdir,
            /* The tail, not the head: Blender's startup banner is never the
               reason it failed, and the traceback is always last. */
            stdout: stdout.slice(-3000),
            stderr: stderr.slice(-2000)
        };
    }

    return {
        ...result,
        outdir,
        jobId,
        specPath,
        scriptPath,
        blender: { path: blender.path, version: blender.version },
        wallSeconds: Math.round((Date.now() - started) / 100) / 10
    };
}

export default { runSpec, workspaceRoot, JOB_TIMEOUT_MS };
