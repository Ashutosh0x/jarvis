// Prompt assembly for the scene planner, built so the KV cache can be reused.
//
// PURE. Returns strings. No model call, no network.
//
// ---------------------------------------------------------------------------
// THE SECOND LEVER, AND THE ONE THAT ACTUALLY DECIDES LATENCY HERE
//
// Quantising the KV cache buys memory. Reusing it buys time, and on this
// machine the time is the thing the user feels.
//
// llama.cpp — which Ollama runs underneath — caches the KV state of a prompt
// and, on the next request, skips prefill for the longest COMMON PREFIX of
// tokens. Not the longest common substring. A prefix. One character different
// at position 0 and the entire cache is thrown away and every token is
// recomputed.
//
// The Foundry prompt is ~1,400 tokens of schema, vocabulary and worked
// examples, and only the last ~30 tokens (the user's sentence) change between
// requests. Prefill on a GTX 1650 Ti runs on the order of hundreds of tokens
// per second, so the difference between reusing that prefix and not is roughly
// three seconds of silence before Jarvis says anything, on every command.
//
// So the rule this file enforces is: EVERYTHING THAT VARIES GOES LAST. Not
// "mostly last" — last. The things that quietly break it are all things a
// reasonable person adds without thinking:
//
//   - a timestamp or session id in the system prompt
//   - the user's name, or the current scene name, interpolated near the top
//   - a "you have these objects already" list placed before the schema
//   - shuffled few-shot examples, or examples chosen per request
//   - retry feedback ("your last spec was invalid") prepended
//
// Every one of those is a full re-prefill of 1,400 tokens to save 20. The test
// suite asserts byte-identical prefixes across different utterances, including
// the retry path, because this is a property that decays silently: nothing
// errors, it just gets slow again.
// ---------------------------------------------------------------------------

import { PRIMITIVES, MODIFIERS, LIGHT_TYPES, ENGINES, EXPORT_FORMATS, LIMITS, LIGHTING_PRESETS } from './sceneSpec.js';

/**
 * The invariant half of the prompt.
 *
 * Deterministic: built from the frozen vocabulary objects with Object.keys, so
 * it is the same bytes on every call in every process. It is a function rather
 * than a constant only so the vocabulary stays the single source of truth —
 * add a primitive to sceneSpec.js and the prompt describes it without an edit
 * here, which is what stops the two from disagreeing.
 */
export function systemPrefix() {
    const primitiveLines = Object.entries(PRIMITIVES)
        .map(([name, params]) => `  ${name}(${params.join(', ')})`)
        .join('\n');

    return `You are the scene planner for Jarvis Foundry. You turn a spoken request into a JSON scene specification that a Blender build script executes.

You output JSON and nothing else. No prose, no markdown fences, no explanation.
You never output Python. The build script is fixed; your JSON selects from the vocabulary below.

TOP LEVEL — {name, objects, lighting, camera, world, render, exports}

OBJECT — every entry in "objects" has exactly these fields:
  name       unique string
  primitive  one of the primitives below
  params     the parameters of that primitive, listed below, and no others
  location   [x,y,z]  where it sits
  rotation   [x,y,z]  radians
  scale      [x,y,z]  a FIELD of the object, never a modifier. To make a cube
             into a flat plate, set scale, do not add a modifier.
  modifiers  a list from the modifier table below, and nothing else
  material   optional, described below

  Anything not in that list does not exist. There is no "scale" modifier, no
  "translate" modifier, no "smooth" modifier — use scale, location, and the
  subsurf modifier respectively.

PRIMITIVES — every object must be one of these, with these parameters only:
${primitiveLines}

MODIFIERS — type must be one of: ${Object.keys(MODIFIERS).join(', ')}
  subsurf   levels (integer 0-${LIMITS.MAX_SUBSURF})       smooths; each level quadruples polygons
  bevel     width (number), segments (1-24)   rounds edges; the single biggest realism win
  array     count (1-${LIMITS.MAX_ARRAY_COUNT}), offset [x,y,z]     repeats the object
  mirror    axis [bool,bool,bool]             mirrors across the object origin
  solidify  thickness (number)                gives a flat surface depth
  decimate  ratio (0-1]                       reduces polygon count
  remesh    voxel_size (>= 0.005)             rebuilds as uniform quads; makes a mesh printable
  boolean   target (object name), operation (DIFFERENCE|UNION|INTERSECT)
  screw     angle (radians), steps (2-256)
  wireframe thickness (> 0)

MATERIAL — optional per object, all fields optional:
  base_color [r,g,b,a] 0-1, metallic 0-1, roughness 0-1, transmission 0-1,
  emission_color [r,g,b,a] 0-1, emission_strength 0-1000, alpha 0-1, ior 1-4
  Metal is metallic 1.0 with roughness 0.1-0.4. Plastic is metallic 0.0,
  roughness 0.4-0.6. Glass is transmission 1.0, roughness 0.0, ior 1.45.

LIGHTING — preset is one of: ${LIGHTING_PRESETS.join(', ')}
  Use three_point unless the request implies otherwise. Add explicit lights only
  when asked for something the presets do not cover.
  A light is {type, location [x,y,z], energy, color [r,g,b], size}
  type is one of: ${LIGHT_TYPES.join(', ')}

CAMERA — {location [x,y,z], look_at [x,y,z], focal_length mm}
  Frame the subject. A 50mm lens at 7-10 units back suits a 2-unit object.

WORLD — {color [r,g,b,a], strength}

RENDER — {engine, samples, resolution [w,h], denoise, transparent_film, device}
  engine is one of: ${ENGINES.join(', ')}
  BLENDER_EEVEE is rasterised and fast; use it unless the request asks for
  realism, refraction, or accurate light bounces, which need CYCLES.
  samples <= ${LIMITS.MAX_SAMPLES}, resolution ${LIMITS.MIN_RESOLUTION}-${LIMITS.MAX_RESOLUTION} per axis.

EXPORTS — a list of {format, filename}
  format is one of: ${Object.keys(EXPORT_FORMATS).join(', ')}
  filename is a bare name with no directory. Use stl for 3D printing, glb for
  sharing, blend to keep the editable scene.

RULES
  1. Rotations are radians.
  2. Z is up. The ground plane is z = 0. Objects should rest on it, not float.
  3. Every boolean modifier's target must be another object in the same scene.
  4. Object names must be unique.
  5. Prefer few well-shaped primitives over many crude ones.
  6. If the request cannot be built from this vocabulary, output
     {"error": "<one sentence saying what is missing>"} and nothing else.

EXAMPLE
Request: a red metal cube on the floor, rendered
{"name":"red_cube","objects":[{"name":"cube","primitive":"cube","params":{"size":2},"location":[0,0,1],"modifiers":[{"type":"bevel","width":0.03,"segments":3}],"material":{"base_color":[0.8,0.05,0.05,1],"metallic":1.0,"roughness":0.25}}],"lighting":{"preset":"three_point"},"camera":{"location":[6,-6,4],"look_at":[0,0,1],"focal_length":50},"render":{"engine":"BLENDER_EEVEE","samples":64,"resolution":[960,540],"denoise":true}}

EXAMPLE
Request: a bracket with two mounting holes I can print
{"name":"bracket","objects":[{"name":"body","primitive":"cube","params":{"size":2},"location":[0,0,0.2],"scale":[1,0.5,0.1],"modifiers":[{"type":"bevel","width":0.02,"segments":2},{"type":"boolean","target":"hole_a","operation":"DIFFERENCE"},{"type":"boolean","target":"hole_b","operation":"DIFFERENCE"}],"material":{"base_color":[0.6,0.6,0.62,1],"metallic":0.9,"roughness":0.35}},{"name":"hole_a","primitive":"cylinder","params":{"radius":0.15,"depth":1,"vertices":32},"location":[-0.6,0,0.2]},{"name":"hole_b","primitive":"cylinder","params":{"radius":0.15,"depth":1,"vertices":32},"location":[0.6,0,0.2]}],"lighting":{"preset":"studio_softbox"},"camera":{"location":[4,-4,3],"look_at":[0,0,0.2],"focal_length":50},"render":{"engine":"BLENDER_EEVEE","samples":64,"resolution":[960,540],"denoise":true},"exports":[{"format":"stl","filename":"bracket.stl"}]}
`;
}

/**
 * Assemble the full prompt.
 *
 * The signature deliberately makes the ordering hard to get wrong: the caller
 * cannot pass anything that lands before the prefix, because there is no
 * parameter that would.
 *
 * @param {string} utterance          what the user said
 * @param {{invalidSpec?:string, errors?:string[]}} [retry]
 *   Feedback from a rejected spec. Appended AFTER the utterance, never before
 *   the schema — a retry is the case where reuse matters most, since the whole
 *   prefix is already resident from the attempt that just failed.
 */
export function buildPrompt(utterance, retry = null) {
    const prefix = systemPrefix();
    let suffix = `\nRequest: ${String(utterance ?? '').trim()}\n`;

    if (retry && Array.isArray(retry.errors) && retry.errors.length) {
        /* The errors alone are not enough for a 4B model: observed on 3 Aug
           2026, gemma3:4b repeated an invented "scale" modifier verbatim on
           retry with the allowed list right in front of it. Naming the rule it
           broke — rather than only what it produced — is what changes the
           second attempt. */
        suffix += `\nYour previous answer was rejected by the validator:\n${retry.errors.map((e) => `  - ${e}`).join('\n')}\n`
            + `Fix exactly these problems. Use only field names and values listed above; if you reached for something that does not exist, express it with the fields that do (scale for size, location for position, subsurf for smoothing).\n`
            + `Output the corrected JSON specification. JSON only.\n`;
    }

    return { prefix, suffix, prompt: prefix + suffix };
}

/**
 * Parse the model's answer into a candidate spec.
 *
 * Small models wrap JSON in fences and prose no matter how firmly told not to,
 * so this recovers the object instead of failing the run. It is a parser, not
 * a validator: validateSpec still decides whether the result is buildable.
 *
 * @returns {{ok:true, value:object}|{ok:false, error:string}}
 */
export function extractSpec(text) {
    const raw = String(text ?? '').trim();
    if (!raw) return { ok: false, error: 'the model returned nothing' };

    /* Strip a fenced block if there is one, then fall back to brace matching. */
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    const body = fenced ? fenced[1].trim() : raw;

    const start = body.indexOf('{');
    if (start === -1) return { ok: false, error: 'no JSON object in the model output' };

    /* Brace counting rather than a regex, because a greedy match to the last
       brace swallows trailing prose and a lazy one stops inside the first
       nested object. String awareness matters: a filename containing a brace
       would otherwise unbalance the count. */
    let depth = 0, inString = false, escaped = false, end = -1;
    for (let i = start; i < body.length; i++) {
        const ch = body[i];
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end === -1) return { ok: false, error: 'the JSON object was never closed — the model was probably cut off by the token limit' };

    try {
        const value = JSON.parse(body.slice(start, end + 1));
        if (!value || typeof value !== 'object') return { ok: false, error: 'parsed value is not an object' };
        return { ok: true, value };
    } catch (e) {
        return { ok: false, error: `JSON parse failed: ${e.message}` };
    }
}

export default { systemPrefix, buildPrompt, extractSpec };
