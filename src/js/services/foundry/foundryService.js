// Foundry orchestration: a sentence in, a rendered image out.
//
// IMPURE: talks to Ollama, spawns Blender. The parsing (foundryIntent),
// validation (sceneSpec), budget (kvBudget) and prompt assembly
// (promptBuilder) are all pure and tested separately; this is the part that
// makes things happen and so it is deliberately thin.

import { buildPrompt, extractSpec, systemPrefix } from './promptBuilder.js';
import { validateSpec } from './sceneSpec.js';
import { attentionShape, planRun, REQUIRED_ENV } from './kvBudget.js';
import { runSpec } from './blenderBridge.js';
import { diffSpecs, describeDiff } from './specDiff.js';
import { estimatePrint, fitsOnBed, reviewPart } from './manufacturing.js';

const OLLAMA = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';

/**
 * Which model plans scenes.
 *
 * gemma3:4b is what is installed on this machine and it fits. The plan called
 * for Gemma 4 31B, which needs roughly 24 GB of VRAM against the 4 GB present
 * — that is not a tuning problem, it is a different class of machine. A 4B
 * model is a weak free-form coder and an adequate form-filler, which is the
 * job this pipeline actually gives it: the vocabulary in sceneSpec.js is
 * closed and the validator rejects anything outside it.
 */
export const PLANNER_MODEL = process.env.JARVIS_FOUNDRY_MODEL || 'gemma3:4b';

/**
 * Keep the model resident between commands.
 *
 * The largest single latency in this pipeline is not prefill and not the
 * render — it is Ollama evicting a 3.3 GB model and reading it back off disk,
 * which on this machine is tens of seconds. Everything kvBudget.js computes is
 * irrelevant if the weights are not there when the user speaks.
 *
 * 30 minutes is a working session. It is also 3.3 GB held while idle, which is
 * a real cost on a 4 GB card, so it is an environment variable rather than a
 * constant: a user who wants their VRAM back sets it to '0'.
 */
const KEEP_ALIVE = process.env.JARVIS_FOUNDRY_KEEP_ALIVE || '30m';

async function ollama(pathname, body, { timeoutMs = 120_000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(`${OLLAMA}${pathname}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal
        });
        if (!response.ok) throw new Error(`Ollama returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
        return await response.json();
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Read the runtime's real state: what the model is, what it costs, what is loaded.
 *
 * Everything here is measured. Nothing is a table of expected values — the
 * whole point of kvBudget.js is that the attention shape comes from the model
 * file rather than from an assumption about its parameter count.
 */
export async function probeRuntime(model = PLANNER_MODEL) {
    const out = { model, ollama: OLLAMA, reachable: false };

    let show;
    try {
        show = await ollama('/api/show', { model }, { timeoutMs: 30_000 });
        out.reachable = true;
    } catch (e) {
        out.error = `Ollama is not answering at ${OLLAMA}: ${e.message}`;
        return out;
    }

    out.quantization = show?.details?.quantization_level ?? null;
    out.parameterSize = show?.details?.parameter_size ?? null;

    const shape = attentionShape(show?.model_info);
    out.shape = shape;

    /* Resident size from /api/ps — the real number, including the vision tower
       and any layers already offloaded. Derived numbers would be a guess about
       a file whose size can simply be asked for. */
    let weightBytes = null;
    try {
        const psResponse = await fetch(`${OLLAMA}/api/ps`);
        if (psResponse.ok) {
            const ps = await psResponse.json();
            const entry = (ps.models || []).find((m) => m.name === model || m.model === model);
            if (entry) {
                weightBytes = entry.size_vram || entry.size || null;
                out.loaded = true;
                out.sizeVram = entry.size_vram ?? null;
                out.size = entry.size ?? null;
            } else {
                out.loaded = false;
            }
        }
    } catch { /* /api/ps is optional; absence is not an error */ }

    /* Not loaded means no measurement exists yet. Say so rather than
       substituting an estimate that would read like one. */
    out.weightBytes = weightBytes;

    out.env = {
        OLLAMA_FLASH_ATTENTION: process.env.OLLAMA_FLASH_ATTENTION ?? null,
        OLLAMA_KV_CACHE_TYPE: process.env.OLLAMA_KV_CACHE_TYPE ?? null
    };
    /* Flash attention is a PREREQUISITE, not a companion setting: Ollama
       applies the quantised cache only on the flash-attention path, so
       OLLAMA_KV_CACHE_TYPE alone is silently ignored. This is the single most
       common way to believe the cache has been halved when it has not. */
    out.kvQuantisationActive = out.env.OLLAMA_FLASH_ATTENTION === '1'
        && !!out.env.OLLAMA_KV_CACHE_TYPE
        && out.env.OLLAMA_KV_CACHE_TYPE !== 'f16';
    out.required = REQUIRED_ENV;

    if (shape && weightBytes) {
        out.budget = planRun({
            shape,
            totalVramBytes: Number(process.env.JARVIS_VRAM_BYTES || 4 * 1024 ** 3),
            weightBytes,
            wantContext: Number(process.env.JARVIS_FOUNDRY_CTX || 8192),
            preferredOrder: out.kvQuantisationActive ? [out.env.OLLAMA_KV_CACHE_TYPE, 'q4_0'] : ['f16']
        });
    }

    return out;
}

/**
 * Ask the planner for a spec.
 *
 * One retry on invalid output, and exactly one. The retry is nearly free
 * because the prompt prefix is already in the KV cache from the attempt that
 * failed (see promptBuilder.js), so it costs the suffix and the generation.
 * A second retry is not free in the way that matters: it is another 20-40
 * seconds of the user waiting, and a 4B model that has failed the schema twice
 * with the errors in front of it is not usually one round trip from success.
 */
export async function planScene(utterance, { model = PLANNER_MODEL, numCtx = null, onStatus = () => { } } = {}) {
    const attempts = [];
    let retry = null;

    for (let attempt = 0; attempt < 2; attempt++) {
        const { prefix, suffix } = buildPrompt(utterance, retry);
        onStatus(attempt === 0 ? 'planning the scene' : 'correcting the plan');

        const response = await ollama('/api/generate', {
            model,
            system: prefix,          // stable across every call — the cached prefix
            prompt: suffix,          // the only part that varies
            stream: false,
            keep_alive: KEEP_ALIVE,
            format: 'json',          // Ollama constrains sampling to valid JSON
            options: {
                temperature: 0.2,    // this is form-filling, not writing
                top_p: 0.9,
                num_predict: 1536,   // a spec is ~400 tokens; this is headroom, not a target
                ...(numCtx ? { num_ctx: numCtx } : {})
            }
        }, { timeoutMs: 180_000 });

        const text = response?.response ?? '';
        const extracted = extractSpec(text);
        if (!extracted.ok) {
            attempts.push({ attempt, stage: 'parse', error: extracted.error, raw: text.slice(0, 500) });
            retry = { errors: [extracted.error] };
            continue;
        }

        /* The model is allowed to refuse, and a refusal is a valid answer that
           must not be dressed up as a broken spec. */
        if (typeof extracted.value.error === 'string') {
            return { ok: false, stage: 'refused', error: extracted.value.error, attempts };
        }

        const validation = validateSpec(extracted.value);
        if (validation.ok) {
            return {
                ok: true,
                spec: validation.spec,
                attempts: attempts.length,
                evalCount: response.eval_count ?? null,
                promptEvalCount: response.prompt_eval_count ?? null,
                /* prompt_eval_count near zero on the second call is the
                   observable proof that the prefix cache was reused. Surfaced
                   because it is the only way to tell from outside. */
                promptEvalDurationMs: response.prompt_eval_duration ? Math.round(response.prompt_eval_duration / 1e6) : null
            };
        }

        attempts.push({ attempt, stage: 'validate', errors: validation.errors });
        retry = { errors: validation.errors };
    }

    return { ok: false, stage: 'plan', error: 'the planner did not produce a valid specification in two attempts', attempts };
}

/**
 * The whole path: sentence -> spec -> Blender -> image.
 *
 * Returns a structured result. It never says "done" for a job that produced no
 * file — the render path is checked on the filesystem inside the runner, and
 * anything short of that comes back ok:false with the stage that failed.
 */
export async function createFromUtterance(utterance, { onStatus = () => { }, model = PLANNER_MODEL, exportFormat = null, engine = null } = {}) {
    const runtime = await probeRuntime(model);
    if (!runtime.reachable) {
        return { ok: false, stage: 'runtime', error: runtime.error };
    }

    const numCtx = runtime.budget?.maxContext && runtime.budget.maxContext >= 4096
        ? Math.min(runtime.budget.maxContext, Number(process.env.JARVIS_FOUNDRY_CTX || 8192))
        : null;

    const planned = await planScene(utterance, { model, numCtx, onStatus });
    if (!planned.ok) return { ...planned, runtime };

    const spec = planned.spec;

    /* Intent-level overrides applied after planning, not injected into the
       prompt: they are deterministic facts from the user's own words and
       there is no reason to spend model tokens re-deciding them. */
    if (engine) spec.render.engine = engine;
    if (exportFormat && !spec.exports.some((e) => e.format === exportFormat)) {
        spec.exports.push({ format: exportFormat, filename: `${spec.name}.${exportFormat}` });
    }

    onStatus(`building ${spec.objects.length} object${spec.objects.length === 1 ? '' : 's'} in Blender`);
    const result = await runSpec(spec, { onProgress: (line) => onStatus(line) });

    /* Costed whenever the geometry was measured, which is whenever something
       was exported for print. Free — the volume is already in the result. */
    const manufacturing = result.ok ? costBuild(result) : null;

    return { ...result, spec, manufacturing, planning: { attempts: planned.attempts, promptEvalCount: planned.promptEvalCount, promptEvalDurationMs: planned.promptEvalDurationMs }, runtime };
}

/**
 * Attach a manufacturing estimate to a finished build.
 *
 * Only for meshes that are actually closed solids: an open surface has no
 * meaningful volume, and reporting a filament cost for one would be a number
 * with nothing behind it. Those are listed as unpriceable with the reason.
 */
export function costBuild(result, opts = {}) {
    const meshes = result?.printability?.meshes ?? [];
    if (!meshes.length) return null;

    const parts = [];
    let totalGrams = 0, totalCost = 0, totalSeconds = 0;

    for (const m of meshes) {
        if (!m.printable || !(m.volume_mm3 > 0)) {
            /* Unpriceable, but still reviewable — and the review is the part
               that says WHY it cannot be priced and what to do about it. */
            parts.push({
                name: m.name, ok: false,
                reason: m.printable ? 'no enclosed volume — this is an open surface' : 'not watertight, so its volume is undefined',
                review: reviewPart(m, null, opts)
            });
            continue;
        }
        const estimate = estimatePrint({
            volumeMm3: m.volume_mm3,
            surfaceAreaMm2: m.area_mm2,
            dimensionsMm: m.dimensions_mm,
            ...opts
        });
        /* The PRINTED dimensions, not the modelled ones. Passing the raw
           measurement here asked whether a 2-metre object fits a 256mm bed and
           answered no for every part, however small it was going to be
           printed. estimate.dimensionsMm is post-scale. */
        const fit = fitsOnBed(estimate.dimensionsMm, opts.bed);
        const review = reviewPart(m, estimate, opts);
        parts.push({ name: m.name, ok: true, ...estimate, fit, review });
        totalGrams += estimate.grams;
        totalCost += estimate.cost;
        totalSeconds += estimate.hours * 3600;
    }

    const priced = parts.filter((p) => p.ok);
    return {
        parts,
        total: priced.length
            ? {
                grams: Math.round(totalGrams * 10) / 10,
                cost: Math.round(totalCost * 100) / 100,
                hours: Math.round((totalSeconds / 3600) * 100) / 100,
                partsPriced: priced.length,
                partsSkipped: parts.length - priced.length
            }
            : null
    };
}

/**
 * Change something about the build that already exists.
 *
 * THIS IS WHAT THE SPEC BEING THE SOURCE OF TRUTH BUYS. "Make it taller" has no
 * meaning against a mesh — there is no height, only vertices — but it has an
 * exact meaning against a spec, because the spec still says which object is
 * which and what its scale is. The model edits the RECIPE and the geometry is
 * rebuilt from it, so an edit is as reliable as the original build rather than
 * a second attempt at guessing.
 *
 * The diff is returned with the result and is not decoration: a 4B model asked
 * to change one field will sometimes rewrite others, and the diff is how that
 * is caught. A caller can refuse an edit that touched more than it should.
 */
export async function refineBuild(previousSpec, instruction, { model = PLANNER_MODEL, onStatus = () => { }, maxChangedObjects = null } = {}) {
    if (!previousSpec) return { ok: false, stage: 'refine', error: 'there is no previous build to change' };

    const validPrev = validateSpec(previousSpec);
    if (!validPrev.ok) return { ok: false, stage: 'refine', error: 'the previous build is no longer valid', errors: validPrev.errors };

    onStatus('working out what to change');

    /* The stable prefix is reused verbatim — the schema the model needs in
       order to edit is the same schema it needed in order to create, so the
       KV cache from the original build is still warm. Only the tail differs. */
    const prefix = systemPrefix();
    const suffix = `\nHere is an existing scene specification:\n${JSON.stringify(validPrev.spec)}\n\n`
        + `Change it as follows: ${String(instruction).trim()}\n\n`
        + `Output the COMPLETE modified specification as JSON. Keep everything the instruction does not mention exactly as it is — same object names, same values. JSON only.\n`;

    let response;
    try {
        response = await ollama('/api/generate', {
            model, system: prefix, prompt: suffix, stream: false,
            keep_alive: KEEP_ALIVE, format: 'json',
            options: { temperature: 0.15, top_p: 0.9, num_predict: 2048 }
        }, { timeoutMs: 180_000 });
    } catch (e) {
        return { ok: false, stage: 'refine', error: `the planner did not answer: ${e.message}` };
    }

    const extracted = extractSpec(response?.response ?? '');
    if (!extracted.ok) return { ok: false, stage: 'refine', error: extracted.error };

    const validation = validateSpec(extracted.value);
    if (!validation.ok) return { ok: false, stage: 'refine', error: 'the edited specification is not valid', errors: validation.errors };

    const diff = diffSpecs(validPrev.spec, validation.spec);
    if (!diff.changed) {
        /* Rebuilding an identical spec would burn a minute to produce the same
           picture and report success. Saying "that changed nothing" is the
           honest and faster answer. */
        return { ok: false, stage: 'refine', error: 'the planner returned the scene unchanged', diff };
    }
    if (maxChangedObjects !== null && diff.counts.modified + diff.counts.added + diff.counts.removed > maxChangedObjects) {
        return {
            ok: false, stage: 'refine', diff,
            error: `the edit touched ${diff.counts.modified + diff.counts.added + diff.counts.removed} objects, more than the ${maxChangedObjects} allowed`
        };
    }

    onStatus(`rebuilding: ${describeDiff(diff)}`);
    const result = await runSpec(validation.spec, { onProgress: onStatus });
    return { ...result, spec: validation.spec, previousSpec: validPrev.spec, diff };
}

export default { createFromUtterance, planScene, probeRuntime, refineBuild, costBuild, PLANNER_MODEL };
