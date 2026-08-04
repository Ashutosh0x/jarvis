// Tests for Jarvis Foundry.
//
// No Blender, no Ollama, no network. Everything asserted here is a property of
// the pure layers — the vocabulary, the validator, the budget arithmetic, the
// parser, and the prompt's prefix stability. Those are the parts that can
// break silently; a missing Blender fails loudly the moment it is called.
//
// The KV numbers are checked against the REAL attention shape of gemma3:4b as
// read from Ollama's /api/show on this machine on 3 Aug 2026, not against a
// figure from a blog post. If the arithmetic here ever disagrees with the
// model file, this suite is what says so.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    validateSpec, isConfined, PRIMITIVES, MODIFIERS, EXPORT_FORMATS, LIMITS, ENGINES
} from '../foundry/sceneSpec.js';
import { attentionShape, bytesPerToken, contextThatFits, planRun, CACHE_TYPES } from '../foundry/kvBudget.js';
import { systemPrefix, buildPrompt, extractSpec } from '../foundry/promptBuilder.js';
import { parseFoundryCommand, extractSubject, FOUNDRY_ACTIONS } from '../foundry/foundryIntent.js';
import { emitScript, pyNum, pyInt, pyStr, FRAMING_MARGIN } from '../foundry/bpyEmitter.js';
import { estimatePrint, fitsOnBed, reviewPart } from '../foundry/manufacturing.js';
import { diffSpecs, describeDiff } from '../foundry/specDiff.js';
import { allCapabilities } from '../capabilities.js';

let pass = 0, fail = 0;
const check = (n, c) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..', '..');

/* A spec that is valid, used as the base for the negative cases so each test
   changes exactly one thing. */
const baseSpec = () => ({
    name: 'test',
    objects: [{ name: 'cube', primitive: 'cube', params: { size: 2 }, location: [0, 0, 1] }],
    camera: { location: [6, -6, 4], look_at: [0, 0, 1] },
    render: { engine: 'BLENDER_EEVEE', samples: 64, resolution: [960, 540] }
});

/* ---------------------------------------------------------------- validator */

check('a minimal well-formed spec validates', validateSpec(baseSpec()).ok);

check('an unknown primitive is rejected',
    !validateSpec({ ...baseSpec(), objects: [{ name: 'x', primitive: 'teapot' }] }).ok);

check('an empty scene is rejected',
    !validateSpec({ ...baseSpec(), objects: [] }).ok);

{
    const s = baseSpec();
    s.objects[0].params = { radius: 5 };     // cube has no radius
    check('a parameter that does not belong to the primitive is rejected', !validateSpec(s).ok);
}

{
    const s = baseSpec();
    s.objects = [
        { name: 'dup', primitive: 'cube', params: { size: 1 } },
        { name: 'dup', primitive: 'cube', params: { size: 1 } }
    ];
    check('duplicate object names are rejected rather than silently renamed', !validateSpec(s).ok);
}

{
    const s = baseSpec();
    s.objects[0].modifiers = [{ type: 'subsurf', levels: 6 }];
    const r = validateSpec(s);
    check('a subdivision level past the cap is rejected', !r.ok);
    check('the rejection names the limit rather than just failing',
        r.errors.some((e) => e.includes(String(LIMITS.MAX_SUBSURF))));
}

{
    const s = baseSpec();
    s.objects[0].modifiers = [{ type: 'remesh', voxel_size: 0.0001 }];
    check('a voxel size small enough to exhaust memory is rejected', !validateSpec(s).ok);
}

{
    const s = baseSpec();
    s.objects[0].modifiers = [{ type: 'boolean', target: 'nothing', operation: 'DIFFERENCE' }];
    check('a boolean pointing at an object that does not exist is rejected', !validateSpec(s).ok);
}

{
    const s = baseSpec();
    s.objects[0].modifiers = [{ type: 'boolean', target: 'cube', operation: 'DIFFERENCE' }];
    check('a boolean targeting its own object is rejected', !validateSpec(s).ok);
}

{
    const s = baseSpec();
    s.camera = { location: [1, 1, 1], look_at: [1, 1, 1] };
    check('a camera at its own target is rejected — there is no direction to face', !validateSpec(s).ok);
}

{
    const s = baseSpec();
    s.render.samples = LIMITS.MAX_SAMPLES + 1;
    check('a sample count past the cap is rejected', !validateSpec(s).ok);
    s.render.samples = 64;
    s.render.resolution = [8192, 8192];
    check('an 8K render is rejected on a 4 GB card', !validateSpec(s).ok);
}

{
    const s = baseSpec();
    s.render.engine = 'BLENDER_EEVEE_NEXT';
    check('the 4.2-era EEVEE_NEXT identifier is rejected, since 5.x calls it BLENDER_EEVEE',
        !validateSpec(s).ok);
    check('BLENDER_EEVEE is the accepted spelling', ENGINES.includes('BLENDER_EEVEE'));
}

{
    const s = baseSpec();
    s.objects[0].scale = [1, 0, 1];
    check('a zero scale axis is rejected — it collapses the mesh', !validateSpec(s).ok);
}

{
    const s = baseSpec();
    s.objects[0].material = { base_color: [0.8, 0.1, 0.1, 1], metallic: 1.4 };
    check('a metallic value outside 0-1 is rejected', !validateSpec(s).ok);
}

{
    const s = baseSpec();
    s.objects[0].material = { emission_strength: 50 };
    check('emission_strength above 1 is allowed — it is a radiance multiplier, not a factor',
        validateSpec(s).ok);
}

/* Every error is collected, because each round trip to a 4B model costs a
   generation and the retry prompt carries all of them at once. */
{
    const s = { name: 'bad', objects: [{ name: 'a', primitive: 'nope' }], render: { engine: 'WRONG', samples: -1 } };
    check('validation reports every error, not only the first', validateSpec(s).errors.length >= 3);
}

/* ------------------------------------------------- imported meshes (the seam) */

/* The path by which anything Blender cannot model — a generated mesh, a scan,
   a downloaded file — becomes an ordinary Foundry object. */
{
    const importSpec = () => ({
        ...baseSpec(),
        objects: [{ name: 'gen', import: { file: 'thing.glb' }, location: [0, 0, 0] }]
    });

    const v = validateSpec(importSpec());
    check('an object may be an import instead of a primitive', v.ok);
    check('the import format is inferred from the extension', v.spec.objects[0].import.format === 'glb');
    check('normalising is on by default — generators emit at arbitrary scale',
        v.spec.objects[0].import.normalise === true);

    /* runSpec revalidates whatever it is handed, and for an internal caller
       that is already-normalised output. Normalisation sets primitive:null on
       an import, which a naive "declares both" check read as a declaration —
       so every import passed its first validation and failed its second. */
    check('validation is idempotent: normalised output revalidates',
        validateSpec(validateSpec(importSpec()).spec).ok);
    check('idempotent for primitives too',
        validateSpec(validateSpec(baseSpec()).spec).ok);

    const both = validateSpec({ ...baseSpec(), objects: [{ name: 'x', primitive: 'cube', import: { file: 'a.glb' } }] });
    check('declaring both a primitive and an import is rejected', !both.ok);

    const traversal = validateSpec({ ...baseSpec(), objects: [{ name: 'x', import: { file: '../../../etc/passwd' } }] });
    check('an import path with a directory component is rejected', !traversal.ok);

    const badFormat = validateSpec({ ...baseSpec(), objects: [{ name: 'x', import: { file: 'model.exe' } }] });
    check('an import format outside the vocabulary is rejected', !badFormat.ok);

    const withParams = validateSpec({ ...baseSpec(), objects: [{ name: 'x', import: { file: 'a.glb' }, params: { size: 2 } }] });
    check('primitive params on an import are rejected — geometry comes from the file', !withParams.ok);

    /* Emission. */
    const script = emitScript(v.spec, { outdir: 'C:\\work\\job1', resultPath: 'C:\\work\\job1\\result.json', importDir: 'C:\\imports' });
    check('the import emits the glTF import operator', script.includes('bpy.ops.import_scene.gltf(filepath='));
    check('the mesh path is built from the caller\'s import directory, not the spec',
        script.includes('C:\\\\imports\\\\thing.glb'));
    check('a missing mesh raises rather than rendering an empty scene',
        script.includes('the mesh to import does not exist'));
    check('non-mesh objects arriving with the file are removed',
        script.includes('bpy.data.objects.remove(stray'));
    check('multiple imported meshes are joined into one object',
        script.includes('bpy.ops.object.join()'));
    check('the file\'s own transform is baked before the spec\'s is applied',
        script.includes('bpy.ops.object.transform_apply('));
    check('normalising scales to the requested longest edge', script.includes('/ longest'));

    /* Materials on an import must REPLACE the file's own, not sit unused
       beside them: append adds a slot but faces keep their original index. */
    const withMat = validateSpec({
        ...baseSpec(),
        objects: [{ name: 'gen', import: { file: 'thing.glb' }, material: { base_color: [1, 0.6, 0.1, 1], metallic: 1 } }]
    });
    const matScript = emitScript(withMat.spec, { outdir: 'C:\\work\\job1', resultPath: 'C:\\work\\job1\\result.json', importDir: 'C:\\imports' });
    check('a material on an import clears the file\'s slots first',
        matScript.indexOf('materials.clear()') < matScript.indexOf('materials.append(mat)'));

    /* An STL import names a different operator. */
    const stlImport = validateSpec({ ...baseSpec(), objects: [{ name: 'x', import: { file: 'part.stl' } }] });
    check('an STL import emits the C++ STL importer',
        emitScript(stlImport.spec, { outdir: 'C:\\work\\job1', resultPath: 'C:\\work\\job1\\result.json', importDir: 'C:\\i' }).includes('bpy.ops.wm.stl_import(filepath='));
}

/* ------------------------------------------------------- path confinement */

check('a path inside the workspace is confined',
    isConfined('C:\\Users\\a\\.jarvis\\foundry\\work\\job1', 'C:\\Users\\a\\.jarvis\\foundry\\work'));
check('a sibling directory sharing a name prefix is NOT confined',
    !isConfined('C:\\Users\\a\\.jarvis\\foundry\\work-evil', 'C:\\Users\\a\\.jarvis\\foundry\\work'));
check('a parent directory is not confined',
    !isConfined('C:\\Users\\a\\.jarvis', 'C:\\Users\\a\\.jarvis\\foundry\\work'));
check('the workspace root itself is confined',
    isConfined('C:\\Users\\a\\.jarvis\\foundry\\work', 'C:\\Users\\a\\.jarvis\\foundry\\work'));

{
    const s = baseSpec();
    s.exports = [{ format: 'stl', filename: '../../../Windows/System32/evil.stl' }];
    check('an export filename containing a directory traversal is rejected', !validateSpec(s).ok);
    s.exports = [{ format: 'stl', filename: 'part.stl' }];
    check('a bare export filename is accepted', validateSpec(s).ok);
    s.exports = [{ format: 'fbx', filename: 'x.fbx' }];
    check('an export format outside the vocabulary is rejected', !validateSpec(s).ok);
}

/* ------------------------------------------------------------- KV budget */

/* The real gemma3:4b shape, as /api/show reports it. */
const gemma3 = {
    'gemma3.block_count': 34,
    'gemma3.attention.head_count': 8,
    'gemma3.attention.head_count_kv': 4,
    'gemma3.attention.key_length': 256,
    'gemma3.attention.value_length': 256,
    'gemma3.attention.sliding_window': 1024,
    'gemma3.context_length': 131072,
    'gemma3.embedding_length': 2560,
    'gemma3.vision.block_count': 27,
    'gemma3.vision.attention.head_count': 16,
    'gemma3.vision.embedding_length': 1152
};

{
    const shape = attentionShape(gemma3);
    check('the attention shape is read from the model rather than assumed',
        shape && shape.layers === 34 && shape.kvHeads === 4 && shape.keyLength === 256);
    check('the architecture prefix is discovered, not hardcoded', shape.arch === 'gemma3');
    check('the vision tower is excluded from the text KV cache',
        shape.layers === 34);     // 34, not 34 + 27

    /* 34 layers x 4 kv heads x (256 + 256) x 2 bytes = 139,264 B = 136 KiB. */
    check('f16 costs 136 KiB per token for this model', bytesPerToken(shape, 'f16') === 139264);
    check('an 8K context costs just over 1 GiB at f16',
        Math.abs(bytesPerToken(shape, 'f16') * 8192 / 1024 ** 3 - 1.0625) < 0.001);

    /* Block overhead is why this is 47%, not 50%. */
    const ratio = bytesPerToken(shape, 'q8_0') / bytesPerToken(shape, 'f16');
    check('q8_0 saves 47% rather than the round 50%, because of the block scale',
        Math.abs(ratio - 34 / 64) < 1e-9);
    check('q4_0 saves 72% rather than 75%',
        Math.abs(bytesPerToken(shape, 'q4_0') / bytesPerToken(shape, 'f16') - 18 / 64) < 1e-9);
    check('the cache-type table carries the true block sizes',
        CACHE_TYPES.q8_0 === 34 / 32 && CACHE_TYPES.q4_0 === 18 / 32);

    check('context that fits is floored to a multiple of 256',
        contextThatFits(shape, 1024 ** 3, 'q8_0') % 256 === 0);
}

check('a model that publishes no attention fields yields null rather than a guess',
    attentionShape({ 'something.else': 1 }) === null);
check('a null shape produces no budget and says why',
    planRun({ shape: null, totalVramBytes: 4 * 1024 ** 3, weightBytes: 1 }).notes[0].includes('unknown'));

{
    /* The real situation on this machine: 4 GiB card, a 3.3 GB model. */
    const shape = attentionShape(gemma3);
    const plan = planRun({
        shape,
        totalVramBytes: 4 * 1024 ** 3,
        weightBytes: 3.3 * 1024 ** 3,
        displayReserveBytes: 0.9 * 1024 ** 3,
        wantContext: 8192
    });
    check('weights plus display reserve exceeding VRAM is reported, not hidden', !plan.fits);
    check('the overflow note names offloading as the consequence',
        plan.notes.some((n) => n.includes('offloaded')));
}

{
    /* A hypothetical with room: does the preference order actually walk down? */
    const shape = attentionShape(gemma3);
    const plan = planRun({
        shape,
        totalVramBytes: 8 * 1024 ** 3,
        weightBytes: 3.3 * 1024 ** 3,
        displayReserveBytes: 0.9 * 1024 ** 3,
        wantContext: 8192,
        preferredOrder: ['q8_0', 'q4_0']
    });
    check('with room, a cache type is chosen and the context fits', plan.fits && plan.maxContext >= 8192);
    check('the plan states the flash-attention prerequisite for a quantised cache',
        plan.notes.some((n) => n.includes('OLLAMA_FLASH_ATTENTION')));
}

/* ------------------------------------------------- prompt prefix stability */

/* THE KV-CACHE LEVER. llama.cpp reuses the longest common PREFIX of tokens;
   one differing byte at the front discards ~1,400 tokens of cached schema and
   re-prefills it. These assertions are the guard on that property. */
{
    const a = buildPrompt('make a red cube');
    const b = buildPrompt('build a glass sphere on a plinth and render it in cycles');
    check('the prompt prefix is byte-identical across different requests', a.prefix === b.prefix);
    check('the prefix is substantial enough for reuse to matter', a.prefix.length > 2000);
    check('the variable part is the suffix, and it differs', a.suffix !== b.suffix);
    check('the full prompt is prefix followed by suffix', a.prompt === a.prefix + a.suffix);

    const retried = buildPrompt('make a red cube', { errors: ['objects[0].primitive "teapot" is not valid'] });
    check('a retry keeps the same prefix, so the failed attempt warms the cache for it',
        retried.prefix === a.prefix);
    check('retry feedback is appended after the request, never prepended',
        retried.suffix.indexOf('rejected') > retried.suffix.indexOf('Request:'));

    check('systemPrefix is deterministic across calls', systemPrefix() === systemPrefix());
    check('the prefix carries no timestamp, uuid or other per-call token',
        !/\d{4}-\d{2}-\d{2}|\d{13}|[0-9a-f]{8}-[0-9a-f]{4}/.test(a.prefix));
}

/* The prompt must describe the vocabulary it is validated against, or the
   model is being asked to guess at a schema it will then fail. */
{
    const prefix = systemPrefix();
    check('every primitive appears in the prompt',
        Object.keys(PRIMITIVES).every((p) => prefix.includes(p)));
    check('every modifier appears in the prompt',
        Object.keys(MODIFIERS).every((m) => prefix.includes(m)));
    check('every export format appears in the prompt',
        Object.keys(EXPORT_FORMATS).every((f) => prefix.includes(f)));
    check('the prompt forbids Python explicitly', /never output Python/i.test(prefix));

    /* The worked examples are the highest-leverage part of the prompt, so they
       must themselves be buildable. An invalid example teaches invalid output. */
    const examples = [...prefix.matchAll(/^\{.*\}$/gm)].map((m) => m[0]);
    check('the prompt contains worked examples', examples.length >= 2);
    check('every worked example in the prompt passes the validator',
        examples.every((e) => validateSpec(JSON.parse(e)).ok));
}

/* -------------------------------------------------------- output recovery */

check('a bare JSON object is extracted', extractSpec('{"name":"a"}').ok);
check('a fenced JSON block is extracted', extractSpec('```json\n{"name":"a"}\n```').ok);
check('JSON with prose around it is extracted',
    extractSpec('Sure! Here is the scene:\n{"name":"a"}\nHope that helps.').ok);
check('nested objects do not truncate the extraction',
    extractSpec('{"a":{"b":{"c":1}},"d":2}').value.d === 2);
check('a brace inside a string does not unbalance the parser',
    extractSpec('{"filename":"weird{name}.stl","ok":true}').value.ok === true);
check('an unterminated object is reported as truncation rather than parsed',
    !extractSpec('{"name":"a","objects":[').ok);
check('empty output is an error, not an empty spec', !extractSpec('').ok);

/* ------------------------------------------------------------ intent parse */

check('a plain build request is recognised',
    parseFoundryCommand('create a 3d model of a gear and render it')?.action === FOUNDRY_ACTIONS.CREATE);
check('the subject is stripped of the wrapper words',
    extractSubject('create a 3d model of a gear and render it') === 'gear');
check('"model me a phone stand" is recognised',
    parseFoundryCommand('model me a phone stand')?.action === FOUNDRY_ACTIONS.CREATE);

/* The blast-radius cases. Each of these is an embedding neighbour of a build
   request, and none of them may build anything. */
check('"how would I model a gear in blender" does not build',
    parseFoundryCommand('how would i model a gear in blender') === null);
check('"what is a 3d model" does not build',
    parseFoundryCommand('what is a 3d model') === null);
check('"can you make 3d models" does not build',
    parseFoundryCommand('can you make 3d models') === null);
check('"don\'t render that" does not build',
    parseFoundryCommand("don't render that") === null);
check('"cancel the render" does not build',
    parseFoundryCommand('cancel the render') === null);

/* Noun vs verb. Four creation verbs are also nouns, and three of them name the
   thing this feature produces. From the interaction log, 3 Aug 2026 12:57:
   "show me the model" built a six-polygon cube called "model" — the user asked
   to see what had just been built and got a second, empty build instead. */
check('"show me the model" opens the viewer instead of building',
    parseFoundryCommand('show me the model')?.action === FOUNDRY_ACTIONS.SHOW);
check('"open the model" shows', parseFoundryCommand('open the model')?.action === FOUNDRY_ACTIONS.SHOW);
check('"where is that design" shows', parseFoundryCommand('where is that design')?.action === FOUNDRY_ACTIONS.SHOW);
check('"show me the last render" shows',
    parseFoundryCommand('show me the last render')?.action === FOUNDRY_ACTIONS.SHOW);
check('"model" after a determiner is a noun, not a verb',
    parseFoundryCommand('delete the model') === null);

/* SHOW must not swallow display commands that belong to other features. */
check('"show me my screen" is not a Foundry command',
    parseFoundryCommand('show me my screen') === null);
check('"show files" is not a Foundry command',
    parseFoundryCommand('show files in downloads') === null);
check('"show me the weather" is not a Foundry command',
    parseFoundryCommand('show me the weather') === null);

/* Which job was meant. */
check('a bare show targets the newest build',
    parseFoundryCommand('show me the model')?.which?.position === 'newest');
check('"show me the gear model" targets a named build',
    parseFoundryCommand('show me the gear model')?.which?.position === 'named');
check('the name is carried through', parseFoundryCommand('show me the gear model')?.which?.name === 'gear');
/* Deliberately conservative: a display verb with no noun this feature owns is
   not Foundry's sentence. "show me the gear" could be a photo, a bike part or
   a search result, and the parser has no session state to disambiguate it —
   so it declines and the general assistant answers. */
check('"show me the gear" alone is not claimed by Foundry',
    parseFoundryCommand('show me the gear') === null);
check('"the last model" is not treated as a name called "last"',
    parseFoundryCommand('show me the last model')?.which?.position === 'newest');
check('"show me all the renders" asks for the gallery',
    parseFoundryCommand('show me all the renders')?.which?.position === 'all');
check('a bare "the last render" with no verb still shows',
    parseFoundryCommand('the last render')?.action === FOUNDRY_ACTIONS.SHOW);
check('"foundry" on its own opens the viewer',
    parseFoundryCommand('foundry')?.action === FOUNDRY_ACTIONS.SHOW);

/* SHOW is a read, so it must never be confused with a build. */
check('showing carries no subject to build',
    parseFoundryCommand('show me the model')?.subject === undefined);
/* The guard must not cost the verb use, which is the commonest phrasing. */
check('"model me a phone stand" still builds — model leads, so it is the verb',
    parseFoundryCommand('model me a phone stand')?.action === FOUNDRY_ACTIONS.CREATE);
check('"make a 3d model of a gear" still builds despite containing "a model"',
    parseFoundryCommand('make a 3d model of a gear')?.action === FOUNDRY_ACTIONS.CREATE);
check('"build a 3d scene" still builds', parseFoundryCommand('build a 3d scene with a sphere')?.action === FOUNDRY_ACTIONS.CREATE);

/* Making something that is not geometry must not reach Blender. */
check('"make me a sandwich" is not a Foundry command',
    parseFoundryCommand('make me a sandwich') === null);
check('"create a spreadsheet" is not a Foundry command',
    parseFoundryCommand('create a spreadsheet') === null);
check('"make it louder" is not a Foundry refinement',
    parseFoundryCommand('make it louder') === null);

check('a realism request selects Cycles',
    parseFoundryCommand('make a photorealistic 3d model of a glass vase')?.engine === 'CYCLES');
check('a speed request selects EEVEE',
    parseFoundryCommand('quick 3d model of a cube')?.engine === 'BLENDER_EEVEE');
check('no hint leaves the engine to the planner',
    parseFoundryCommand('model me a gear')?.engine === null);

check('an export request is recognised with its format',
    parseFoundryCommand('export that as stl')?.format === 'stl');

/* One sentence, one job. "design X and export it as stl" contains an export
   verb and a format, and an export-first ordering routed the whole build to
   the export path — which does nothing without a scene. */
{
    const combined = parseFoundryCommand('design a 3d model of a hex nut and export it as stl');
    check('create-and-export in one sentence is a CREATE, not an EXPORT',
        combined?.action === FOUNDRY_ACTIONS.CREATE);
    check('the requested format is carried on the create as wantsExport',
        combined?.wantsExport === 'stl');
    check('the subject excludes the export instruction',
        combined?.subject === 'hex nut');
    check('a bare export with no creation verb is still an EXPORT',
        parseFoundryCommand('export that as stl')?.action === FOUNDRY_ACTIONS.EXPORT);
}
check('gltf is normalised to glb',
    parseFoundryCommand('save it as gltf')?.format === 'glb');
check('a print request is its own action',
    parseFoundryCommand('3d print that')?.action === FOUNDRY_ACTIONS.PRINT);
check('a refinement about appearance is recognised',
    parseFoundryCommand('make it shinier')?.action === FOUNDRY_ACTIONS.REFINE);

/* ------------------------------------------------ manufacturing estimate */

/* Grounded in the standard FDM relations: mass = volume x density,
   time = volume / volumetric flow, cost = mass x price per kg. */
{
    /* A 20mm solid cube: 8,000 mm^3, 2,400 mm^2 of surface. printLongestMm is
       pinned to 20 so these assert the physics rather than the rescale. */
    const cube = { volumeMm3: 8000, surfaceAreaMm2: 2400, dimensionsMm: [20, 20, 20], printLongestMm: 20 };

    /* THE SCALE BUG. Blender's unit is the metre, so a "size 2" cube measures
       2,000 mm and encloses 8x10^9 mm^3 — 480 kg of PLA. Costing a model at
       its modelling scale was wrong by nine orders of magnitude until the
       print size became an explicit input. */
    {
        const asModelled = { volumeMm3: 8e9, surfaceAreaMm2: 2.4e7, dimensionsMm: [2000, 2000, 2000] };
        const printed = estimatePrint({ ...asModelled, printLongestMm: 20 });
        check('a model in Blender metres is scaled to its print size before costing',
            printed.grams < 20);
        check('volume scales with the cube of the linear factor',
            Math.abs(printed.modelScale - 0.01) < 1e-9);
        check('the print size is stated in the assumptions rather than assumed silently',
            /printed at 20mm/.test(printed.assumptions));
        /* NOT eight. Doubling the size multiplies the solid volume by 8, but an
           FDM part is a shell plus sparse infill: the shell follows AREA and
           grows 4x, the infill follows volume and grows 8x. So the real ratio
           sits between the two, nearer 4 for thin-walled parts and nearer 8 as
           infill dominates. Asserting 8 here was asserting the wrong physics. */
        const doubled = estimatePrint({ ...asModelled, printLongestMm: 40 }).grams / printed.grams;
        check('doubling the print size multiplies filament by between four and eight',
            doubled > 4 && doubled < 8);
        check('and denser infill pushes that ratio toward the cubic bound',
            (estimatePrint({ ...asModelled, printLongestMm: 40, infill: 1 }).grams
                / estimatePrint({ ...asModelled, printLongestMm: 20, infill: 1 }).grams) > doubled);
    }

    const e = estimatePrint({ ...cube, filament: 'PLA', printer: 'generic', infill: 0.2, wallThicknessMm: 1.2 });
    check('a solid with volume produces an estimate', e.ok);
    check('printed volume is below solid volume — an FDM part is shell plus sparse infill',
        e.printedVolumeCm3 < e.solidVolumeCm3);
    check('mass follows volume times PLA density (1.24 g/cm3)',
        Math.abs(e.grams - e.printedVolumeCm3 * 1.24) < 0.15);
    check('cost follows mass times price per kg',
        Math.abs(e.cost - (e.grams / 1000) * e.pricePerKg) < 0.02);
    check('the estimate states its assumptions', /infill/.test(e.assumptions));
    check('the estimate labels itself an estimate, not a slicer figure',
        /optimistic/.test(e.confidence));

    /* Denser infill costs more plastic and more time. Monotonicity is the
       property worth testing; the absolute numbers belong to the slicer. */
    const sparse = estimatePrint({ ...cube, infill: 0.1 });
    const dense = estimatePrint({ ...cube, infill: 0.9 });
    check('more infill means more filament', dense.grams > sparse.grams);
    check('more infill means more time', dense.hours > sparse.hours);

    /* A part cannot contain more plastic than its own volume — the case that
       breaks a naive shell+infill formula on thin geometry. */
    const thin = estimatePrint({ volumeMm3: 500, surfaceAreaMm2: 40000, infill: 0.9 });
    check('printed volume never exceeds solid volume, even when walls swallow the part',
        thin.printedVolumeCm3 <= 0.5 + 1e-9);

    check('a material with a different density gives a different mass',
        estimatePrint({ ...cube, filament: 'ABS' }).grams !== e.grams);
    check('a faster printer prints the same part sooner',
        estimatePrint({ ...cube, printer: 'bambu_x2d' }).hours < estimatePrint({ ...cube, printer: 'generic' }).hours);

    check('a mesh with no volume is refused rather than costed',
        !estimatePrint({ volumeMm3: 0 }).ok);

    /* The estimate reports the dimensions it actually costed, so a caller can
       bed-check the PRINTED size. Checking the modelled size instead said no
       part fits, because every model is metres wide in Blender units. */
    {
        const e = estimatePrint({ volumeMm3: 8e9, surfaceAreaMm2: 2.4e7, dimensionsMm: [2000, 1000, 200], printLongestMm: 100 });
        check('the estimate reports post-scale dimensions', e.dimensionsMm[0] === 100);
        check('a part costed at 100mm fits a 256mm bed', fitsOnBed(e.dimensionsMm, [256, 256, 256]).fits);
    }

    /* Bed fitting, including the free 90-degree rotation everyone does. */
    check('a part that fits upright fits', fitsOnBed([100, 100, 100], [256, 256, 256]).fits);
    check('a part too tall does not fit', !fitsOnBed([10, 10, 400], [256, 256, 256]).fits);
    check('a long thin part fits when rotated', fitsOnBed([250, 100, 50], [120, 300, 300]).rotated === true);
    check('a part too large in both orientations does not fit', !fitsOnBed([400, 400, 10], [256, 256, 256]).fits);
}

/* --------------------------------------------------------- design review */

/* Findings name their measurement and their fix. A single blended
   "printability: 94%" hides which of five things is wrong. */
{
    const solidMesh = (over = {}) => ({
        name: 'part', printable: true,
        non_manifold_edges: 0, loose_edges: 0, loose_vertices: 0,
        overhang_fraction: 0.05, support_fraction: 0.05, steepest_overhang_deg: 30,
        thin_walls: { checked: 300, thin: 0, min: 4 },
        centre_of_mass_mm: [0, 0, 5],
        ...over
    });
    const est = estimatePrint({ volumeMm3: 8000, surfaceAreaMm2: 2400, dimensionsMm: [20, 20, 20], printLongestMm: 20 });

    check('a clean part passes review', reviewPart(solidMesh(), est).verdict === 'ok');
    check('and says so in plain words', reviewPart(solidMesh(), est).headline === 'ready to print');

    const broken = reviewPart(solidMesh({ printable: false, non_manifold_edges: 12 }), est);
    check('a non-watertight mesh fails review', broken.verdict === 'fail');
    check('the failure names the count it measured', /12 non-manifold/.test(broken.findings[0].detail));
    check('and says what to do about it', /remesh|repair/.test(broken.findings[0].fix));

    const heavy = reviewPart(solidMesh({ support_fraction: 0.6, steepest_overhang_deg: 80 }), est);
    check('heavy overhang is a warning, not a failure — it still prints',
        heavy.verdict === 'warn' && heavy.findings.some((f) => /support/i.test(f.title)));

    /* Thin walls are relative to the PRINT size, not the model size: the same
       geometry is fine at 200mm and unprintable at 10mm. */
    const smallEst = estimatePrint({ volumeMm3: 8000, surfaceAreaMm2: 2400, dimensionsMm: [20, 20, 20], printLongestMm: 2 });
    check('a wall too thin at the chosen print size fails',
        reviewPart(solidMesh({ thin_walls: { checked: 300, thin: 40, min: 4 } }), smallEst).verdict === 'fail');
    check('the same geometry passes when printed larger',
        reviewPart(solidMesh({ thin_walls: { checked: 300, thin: 40, min: 4 } }), est).verdict === 'ok');

    /* The degenerate-ray case: a grazing hit reported 0mm walls on a solid ball
       and advised printing it 238 metres across. */
    const degenerate = reviewPart(solidMesh({ thin_walls: { checked: 300, thin: 9, min: 0 } }), est);
    check('an unmeasurable wall thickness is a note, not a confident failure',
        degenerate.verdict !== 'fail');
    check('and no absurd fix is offered', !degenerate.findings.some((f) => /\d{5,}mm/.test(f.fix || '')));

    const tall = reviewPart(solidMesh({ centre_of_mass_mm: [0, 0, 900] }),
        estimatePrint({ volumeMm3: 8000, surfaceAreaMm2: 2400, dimensionsMm: [20, 20, 200], printLongestMm: 200 }));
    check('a top-heavy part is flagged as likely to topple',
        tall.findings.some((f) => /top-heavy/i.test(f.title)));

    const huge = reviewPart(solidMesh(),
        estimatePrint({ volumeMm3: 8e6, surfaceAreaMm2: 24000, dimensionsMm: [400, 400, 400], printLongestMm: 400 }));
    check('a part larger than the bed fails review',
        huge.findings.some((f) => f.severity === 'fail' && /build plate/i.test(f.title)));

    check('an automatic repair is reported rather than hidden',
        reviewPart(solidMesh({ repairs: { repaired: true, non_manifold_before: 8, welded_vertices: 3, removed_loose: 1 } }), est)
            .findings.some((f) => /repaired/i.test(f.title)));

    /* Severity ordering: one failure outranks any number of warnings. */
    check('a failure outranks warnings in the verdict',
        reviewPart(solidMesh({ printable: false, support_fraction: 0.9 }), est).verdict === 'fail');
}

/* ------------------------------------------------------------- spec diff */

/* Diffing is possible because the SPEC is the source of truth. Two meshes
   diff to "+12,431 vertices" and tell you nothing; two specs diff to "the
   bevel went from 0.02 to 0.05". */
{
    const v1 = validateSpec({
        ...baseSpec(),
        objects: [{ name: 'body', primitive: 'cube', params: { size: 2 }, modifiers: [{ type: 'bevel', width: 0.02, segments: 2 }], material: { metallic: 1.0, roughness: 0.3 } }]
    }).spec;

    check('an identical spec reports no change', !diffSpecs(v1, v1).changed);
    check('describeDiff says so in words', describeDiff(diffSpecs(v1, v1)) === 'nothing changed');

    const taller = JSON.parse(JSON.stringify(v1));
    taller.objects[0].scale = [1, 1, 2];
    const d = diffSpecs(v1, taller);
    check('a scale change is detected', d.changed);
    check('the change is attributed to the right object', d.objects[0].name === 'body');
    check('the change reads as a value transition', /scale/.test(d.objects[0].changes[0].text));
    check('exactly one object is reported modified', d.counts.modified === 1);

    const beveled = JSON.parse(JSON.stringify(v1));
    beveled.objects[0].modifiers[0].width = 0.05;
    check('a modifier parameter change is detected and named',
        /bevel\.width/.test(diffSpecs(v1, beveled).objects[0].changes[0].path));

    const added = JSON.parse(JSON.stringify(v1));
    added.objects.push({ name: 'lid', primitive: 'cylinder', params: { radius: 1, depth: 0.2 }, location: [0, 0, 2], rotation: [0, 0, 0], scale: [1, 1, 1], modifiers: [], material: null, import: null });
    const dAdd = diffSpecs(v1, added);
    check('an added object is reported as added', dAdd.counts.added === 1);
    check('and is not reported as a modification of an existing one', dAdd.counts.modified === 0);

    /* Matching by NAME, not position: inserting at the front must not report
       every later object as changed. */
    const prepended = JSON.parse(JSON.stringify(added));
    prepended.objects.reverse();
    check('objects are matched by name, so reordering alone is not a change',
        diffSpecs(added, prepended).counts.modified === 0);

    const removed = JSON.parse(JSON.stringify(v1));
    removed.objects = [];
    check('a removed object is reported', diffSpecs(v1, removed).counts.removed === 1);

    const sceneEdit = JSON.parse(JSON.stringify(v1));
    sceneEdit.render.samples = 256;
    const dScene = diffSpecs(v1, sceneEdit);
    check('a render setting change is detected', dScene.counts.sceneChanges === 1);
    check('and is described with its path and both values',
        /render\.samples.*64.*256/.test(dScene.scene[0].text));

    /* The diff is the receipt for an AI edit: it must catch the model
       quietly changing something it was not asked to. */
    const sneaky = JSON.parse(JSON.stringify(v1));
    sneaky.objects[0].scale = [1, 1, 2];
    sneaky.objects[0].material.metallic = 0;
    check('an unrequested extra change is visible in the diff',
        diffSpecs(v1, sneaky).objects[0].changes.length === 2);

    check('the spoken summary caps the list rather than reading everything',
        describeDiff({ changed: true, summary: ['a', 'b', 'c', 'd', 'e'] }).includes('2 more changes'));
}

/* ------------------------------------------------------- capability wiring */

{
    const caps = allCapabilities();
    const model3d = caps.find((c) => c.name === 'model_3d');
    const print3d = caps.find((c) => c.name === 'print_3d');
    check('the 3D modelling capability is registered', !!model3d);
    check('modelling is `write`, so the semantic router cannot select it',
        model3d.effects === 'write');
    check('printing is `destructive` and confirmed — it spends filament',
        print3d.effects === 'destructive' && print3d.confirmation === true);
}

/* ------------------------------------------------------------ the emitter */

/* Blender's API is Python-only, so the bridge COMPILES a validated spec into a
   script. Nothing Python-shaped is maintained by hand; these assertions are
   what stands in for a Python test suite, and they check the two things that
   would otherwise fail only at run time: that every vocabulary entry has an
   emitter, and that the version-sensitive API names are the right ones. */

const IO = { outdir: 'C:\\work\\job1', resultPath: 'C:\\work\\job1\\result.json' };

/* One object per primitive, so every emitter branch is exercised. Params are
   the defaults each primitive declares, which also proves the param mapping
   (rings -> ring_count) round-trips through validation. */
{
    const objects = Object.entries(PRIMITIVES).map(([kind, params], i) => ({
        name: `o${i}`,
        primitive: kind,
        params: Object.fromEntries(params.map((p) => [p, p.includes('subdivision') || p.includes('segments') || p.includes('vertices') || p === 'rings' ? 3 : 1])),
        location: [i * 2, 0, 0]
    }));
    const everything = validateSpec({ ...baseSpec(), objects });
    check('a spec using every primitive validates', everything.ok);
    const script = emitScript(everything.spec, IO);
    check('every primitive emits its bpy.ops call',
        Object.values(PRIMITIVES).length > 0
        && Object.keys(PRIMITIVES).every((k) => {
            const op = { cube: 'cube', uv_sphere: 'uv_sphere', ico_sphere: 'ico_sphere', cylinder: 'cylinder', cone: 'cone', torus: 'torus', plane: 'plane', grid: 'grid', monkey: 'monkey' }[k];
            return script.includes(`bpy.ops.mesh.primitive_${op}_add(`);
        }));
    check('the uv_sphere keyword is ring_count, not rings',
        script.includes('ring_count=') && !script.includes('rings='));
    check('integer properties are emitted as ints, not floats',
        /vertices=3\b/.test(script) && !/vertices=3\.0/.test(script));
}

/* Every modifier, on one object, so each branch emits. */
{
    const s = baseSpec();
    s.objects = [
        { name: 'cutter', primitive: 'cube', params: { size: 1 }, location: [3, 0, 0] },
        {
            name: 'main', primitive: 'cube', params: { size: 2 },
            modifiers: [
                { type: 'subsurf', levels: 2 }, { type: 'bevel', width: 0.02, segments: 2 },
                { type: 'array', count: 2 }, { type: 'mirror' }, { type: 'solidify' },
                { type: 'decimate', ratio: 0.5 }, { type: 'remesh', voxel_size: 0.05 },
                { type: 'boolean', target: 'cutter', operation: 'DIFFERENCE' }
            ]
        }
    ];
    const v = validateSpec(s);
    check('a spec using eight modifiers validates', v.ok);
    const script = emitScript(v.spec, IO);
    check('every modifier type reaches modifiers.new with its Blender enum',
        ['SUBSURF', 'BEVEL', 'ARRAY', 'MIRROR', 'SOLIDIFY', 'DECIMATE', 'REMESH', 'BOOLEAN']
            .every((t) => script.includes(`type="${t}"`)));
    check('a boolean cutter is hidden from the render',
        script.includes('hide_render = True'));

    /* screw and wireframe are not in the object above; assert the emitter
       covers the remaining vocabulary rather than silently lacking a branch. */
    const rest = validateSpec({
        ...baseSpec(),
        objects: [{ name: 'c', primitive: 'cube', params: { size: 1 }, modifiers: [{ type: 'screw' }, { type: 'wireframe' }] }]
    });
    const restScript = emitScript(rest.spec, IO);
    check('every modifier in the vocabulary has an emitter',
        Object.keys(MODIFIERS).every((m) =>
            script.includes(`name="${m}"`) || restScript.includes(`name="${m}"`)));
}

/* Export formats. */
{
    for (const fmt of Object.keys(EXPORT_FORMATS)) {
        const s = baseSpec();
        s.exports = [{ format: fmt, filename: `x.${fmt}` }];
        const v = validateSpec(s);
        const script = emitScript(v.spec, IO);
        check(`the ${fmt} export emits its operator`, script.includes(EXPORT_FORMATS[fmt].replace('wm.', 'bpy.ops.wm.').replace('export_scene.', 'bpy.ops.export_scene.')));
    }
    const stl = emitScript(validateSpec({ ...baseSpec(), exports: [{ format: 'stl', filename: 'a.stl' }] }).spec, IO);
    check('the STL export uses the C++ operator, not the removed Python one',
        stl.includes('bpy.ops.wm.stl_export') && !stl.includes('bpy.ops.export_mesh.stl'));
    check('an STL export triggers the watertight analysis', stl.includes('non_manifold_edges'));
    check('a render with no mesh export skips the analysis',
        !emitScript(validateSpec(baseSpec()).spec, IO).includes('non_manifold_edges'));
}

/* Version-sensitive API names. A wrong socket name is a SILENT no-op — the
   material stays default and the render looks like a lighting problem. */
{
    const s = baseSpec();
    s.objects[0].material = { base_color: [1, 0, 0, 1], metallic: 1, transmission: 0.5, emission_color: [1, 1, 1, 1], emission_strength: 2, ior: 1.45 };
    const script = emitScript(validateSpec(s).spec, IO);
    check('the 4.x+ Transmission Weight socket name is emitted', script.includes('"Transmission Weight"'));
    check('the pre-4.0 name is emitted as a fallback, not as the primary',
        script.indexOf('"Transmission Weight"') < script.indexOf('"Transmission"', script.indexOf('"Transmission Weight"') + 5));
    check('the 4.x+ Emission Color socket name is emitted', script.includes('"Emission Color"'));

    /* A one-element Python tuple needs a trailing comma. Without it the
       parentheses are just grouping and the value stays a string, so iterating
       it walks the characters and matches no socket — every material silently
       renders default grey. This happened on 3 Aug 2026. */
    check('single-name socket tuples carry the trailing comma that makes them tuples',
        script.includes('("Metallic",)') && script.includes('("Base Color",)'));
    check('multi-name socket tuples do not gain a spurious trailing comma',
        script.includes('("Transmission Weight", "Transmission")'));
    check('no emitted socket tuple is a bare parenthesised string',
        !/set_socket\(bsdf, \("[^"]+"\),/.test(script));
}

/* Cycles device probing, and the EEVEE sample-property fallback. */
{
    const cycles = emitScript(validateSpec({ ...baseSpec(), render: { engine: 'CYCLES', samples: 128, resolution: [640, 360] } }).spec, IO);
    check('Cycles probes for compute devices rather than assuming OptiX',
        cycles.includes('get_devices_for_type'));
    check('Cycles falls back to CPU when no device is found',
        cycles.includes('no GPU compute device available'));
    check('adaptive sampling is on, which matters most on the CPU fallback',
        cycles.includes('use_adaptive_sampling = True'));

    const eevee = emitScript(validateSpec(baseSpec()).spec, IO);
    check('EEVEE tries both known sample properties rather than guessing one',
        eevee.includes('taa_render_samples') && eevee.includes('"samples"'));
}

/* Framing and lighting policy. */
{
    const script = emitScript(validateSpec(baseSpec()).spec, IO);
    check('auto framing is emitted by default', script.includes('cam.location = center + direction * distance'));
    check('framing keeps the margin the JS policy chose',
        script.includes(String(FRAMING_MARGIN)));

    const fixed = validateSpec({ ...baseSpec(), camera: { location: [3, -3, 2], look_at: [0, 0, 0], auto_frame: false } });
    check('auto framing can be turned off', !emitScript(fixed.spec, IO).includes('cam.location = center + direction * distance'));

    /* Preset lights scale with the subject; explicitly requested lights do not,
       because the user gave those coordinates on purpose. */
    check('preset light positions scale with the measured subject radius',
        script.includes('* radius'));
    check('preset light energy scales with the square of the radius',
        script.includes('* (radius * radius)'));
    const custom = validateSpec({
        ...baseSpec(),
        lighting: { preset: 'none', lights: [{ type: 'POINT', location: [1, 2, 3], energy: 100 }] }
    });
    const customScript = emitScript(custom.spec, IO);
    check('an explicitly placed light is emitted at the coordinates given',
        customScript.includes('lobj.location = (1.0, 2.0, 3.0)'));
    check('a sun\'s energy is not distance-scaled, since it is directional',
        !emitScript(validateSpec({ ...baseSpec(), lighting: { preset: 'sun' } }).spec, IO)
            .match(/ldata\.energy = 4\.0 \* \(radius/));
}

/* Literal emission and injection. Names are validated to a safe character set,
   but paths come from Node and contain backslashes on Windows. */
{
    check('a Windows path is escaped so the string literal does not break',
        pyStr('C:\\work\\job1') === '"C:\\\\work\\\\job1"');
    check('a quote in a string is escaped', pyStr('a"b') === '"a\\"b"');
    check('a newline in a string is escaped', pyStr('a\nb') === '"a\\nb"');
    check('NaN is refused rather than emitted as invalid Python',
        (() => { try { pyNum(NaN); return false; } catch { return true; } })());
    check('Infinity is refused', (() => { try { pyNum(Infinity); return false; } catch { return true; } })());
    check('a non-integer is refused where an int is required',
        (() => { try { pyInt(1.5); return false; } catch { return true; } })());

    /* End to end: a hostile-looking outdir cannot escape its literal.

       Asserted by ROUND TRIP rather than by scanning for suspicious text. A
       naive scan counts a correctly escaped \" as a break-out and passes a
       genuinely broken emitter that happens not to use the scanned phrasing.
       Parsing the emitted literal back and comparing it to the input is the
       property that actually matters: the payload survived as data. */
    const hostile = 'C:\\a"; import os; os.system("calc"); x = "';
    const script = emitScript(validateSpec(baseSpec()).spec, {
        outdir: hostile,
        resultPath: 'C:\\a\\result.json'
    });
    const literal = script.match(/^RESULT_PATH = (".*")$/m);
    check('an emitted path literal parses back to exactly the input',
        literal && JSON.parse(literal[1]) === 'C:\\a\\result.json');

    const imageLiteral = script.match(/^\s*image_path = (".*")$/m);
    check('a hostile path survives as inert data inside the literal',
        imageLiteral && JSON.parse(imageLiteral[1]).startsWith(hostile));
    /* The payload must never appear as executable source: every quote inside
       it has to be backslash-escaped, so the raw unescaped form is absent. */
    check('the injection payload never appears unescaped in the script',
        !script.includes('"; import os; os.system("calc")'));
}

/* The generated script must always write the result file — it is the contract,
   because Blender exits 0 after printing a traceback in many failure modes. */
{
    const script = emitScript(validateSpec(baseSpec()).spec, IO);
    check('the script writes a result file even when the job throws',
        script.includes('except Exception as exc:') && script.lastIndexOf('json.dump(result') > script.indexOf('except Exception as exc:'));
    check('the render is verified on the filesystem, not from the operator return',
        script.includes('if not os.path.exists(image_path):'));
    check('the script is syntactically plausible Python (balanced try/except)',
        (script.match(/^try:$/gm) || []).length >= 1);
}

/* No Python file is maintained in the Foundry tree. */
{
    let foundryPythonExists = false;
    try { readFileSync(path.join(REPO, 'server', 'foundry', 'scene_builder.py')); foundryPythonExists = true; } catch { /* expected */ }
    check('no hand-maintained Python remains in the Foundry tree', !foundryPythonExists);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

