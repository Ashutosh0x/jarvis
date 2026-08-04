// The scene spec — what Jarvis is allowed to build in Blender, and its validator.
//
// PURE. No bpy, no filesystem, no spawn. server/foundry/scene_builder.py is the
// other half and must stay in step with this file; the test suite asserts the
// two vocabularies match so they cannot drift silently.
//
// ---------------------------------------------------------------------------
// THE DECISION THAT SHAPES THIS FILE: THE MODEL DOES NOT WRITE PYTHON.
//
// The integration doc this came from has Gemma emit bpy code which Blender
// exec()s. That is remote code execution with extra steps, and the blast radius
// is the whole machine rather than the scene:
//
//     import bpy, os, shutil        # bpy's interpreter is a FULL CPython
//     shutil.rmtree(os.path.expanduser("~"))
//
// Nothing in Blender sandboxes a -P script; it has the same rights as the user
// who launched it. A 4B model that has been fed an untrusted model name, a web
// search result, or a mis-transcribed sentence is not a thing to hand that to.
// And the failure does not need malice — `bpy.ops.wm.read_factory_settings()`
// or a stray `while True:` in generated code is a hang or a data loss with no
// attacker involved at all.
//
// So the model emits DATA, not code: a JSON scene spec drawn from the closed
// vocabulary below. This file validates it, and a deterministic Python builder
// turns valid specs into geometry. Anything not in the vocabulary cannot be
// expressed, which means it cannot be executed.
//
// This is the same blast-radius rule the rest of this project runs on
// (capabilities.js), applied to a subprocess instead of a router: being
// approximately right is fine for choosing a shape, and not fine for deciding
// what code runs.
//
// The cost is real and worth naming: the model can only build what the
// vocabulary covers. Extending Jarvis's modelling range means adding an
// operation here and in the builder — deliberately, with a test — rather than
// the model inventing one at runtime. That is the trade being made.
// ---------------------------------------------------------------------------

/**
 * Primitives, and the parameters each accepts.
 *
 * Names match bmesh/bpy.ops.mesh.primitive_*_add so the builder is a lookup
 * rather than a translation layer. Verified against the 5.3-alpha source in
 * source/blender/bmesh/operators/bmo_primitive.cc.
 */
export const PRIMITIVES = Object.freeze({
    cube: ['size'],
    uv_sphere: ['radius', 'segments', 'rings'],
    ico_sphere: ['radius', 'subdivisions'],
    cylinder: ['radius', 'depth', 'vertices'],
    cone: ['radius1', 'radius2', 'depth', 'vertices'],
    torus: ['major_radius', 'minor_radius', 'major_segments', 'minor_segments'],
    plane: ['size'],
    grid: ['size', 'x_subdivisions', 'y_subdivisions'],
    monkey: ['size']
});

/**
 * Modifiers, mapped to Blender's modifier type enum.
 *
 * BOOLEAN is present because constructive solid geometry is how a language
 * model can express "a box with a hole in it" without describing vertices —
 * it is the single highest-value operation for parts that get printed.
 */
export const MODIFIERS = Object.freeze({
    subsurf: 'SUBSURF',
    bevel: 'BEVEL',
    array: 'ARRAY',
    mirror: 'MIRROR',
    solidify: 'SOLIDIFY',
    decimate: 'DECIMATE',
    remesh: 'REMESH',
    boolean: 'BOOLEAN',
    screw: 'SCREW',
    wireframe: 'WIREFRAME'
});

/** Light types, matching bpy.types.Light.type. */
export const LIGHT_TYPES = Object.freeze(['POINT', 'SUN', 'SPOT', 'AREA']);

/**
 * Render engines.
 *
 * 'BLENDER_EEVEE' — NOT 'BLENDER_EEVEE_NEXT'. The _NEXT identifier existed only
 * in the 4.2/4.3 transition and the tree at
 * C:\Users\ashut\OneDrive\Documents\blender\blender uses the plain name; checked
 * in scripts/startup/bl_ui/properties_render.py:57. Getting this wrong is a
 * silent fallback to the default engine, not an error.
 */
export const ENGINES = Object.freeze(['CYCLES', 'BLENDER_EEVEE', 'BLENDER_WORKBENCH']);

/**
 * Export formats and the operator each maps to.
 *
 * The STL/OBJ/PLY entries are the C++ exporters (wm.*_export), confirmed in
 * scripts/startup/bl_ui/space_topbar.py:412-416. The legacy Python exporters
 * (export_mesh.stl) are gone in this version, so the old operator names that
 * most tutorials still use would raise AttributeError here.
 */
export const EXPORT_FORMATS = Object.freeze({
    stl: 'wm.stl_export',
    obj: 'wm.obj_export',
    ply: 'wm.ply_export',
    glb: 'export_scene.gltf',
    blend: 'wm.save_as_mainfile'
});

/**
 * Hard ceilings.
 *
 * Every one of these is a runaway that a plausible sentence can trigger, and
 * the machine this runs on has 4 GB of VRAM and 31 GB of RAM:
 *
 *   MAX_SUBSURF        level 6 on a monkey is ~200M polygons and an OOM kill.
 *                      Levels above 4 are not visibly better at these
 *                      resolutions, so this costs nothing real.
 *   MAX_SAMPLES        Cycles time is linear in samples. 4096 on CPU is hours.
 *   MAX_RESOLUTION     "render it in 8K" is one sentence and gigabytes of
 *                      framebuffer.
 *   MAX_OBJECTS        bounds both BVH build time and .blend size.
 *   MAX_ARRAY_COUNT    an array modifier multiplies geometry; 500 copies of a
 *                      subdivided sphere is the same OOM by a different route.
 *
 * These are refusals with a stated number, not silent clamps — see validate().
 * A clamp would render something the user did not ask for and say nothing,
 * which is the failure mode this project treats as worse than an error.
 */
export const LIMITS = Object.freeze({
    MAX_OBJECTS: 64,
    MAX_MODIFIERS_PER_OBJECT: 8,
    MAX_SUBSURF: 4,
    MAX_SAMPLES: 4096,
    MAX_RESOLUTION: 4096,
    MIN_RESOLUTION: 64,
    MAX_ARRAY_COUNT: 128,
    MAX_LIGHTS: 16,
    MAX_NAME: 63          // Blender truncates ID names at 63 bytes + null.
});

/**
 * Mesh formats Foundry can INGEST, mapped to their import operator.
 *
 * This is the seam for everything Blender cannot model itself. A generated
 * mesh — from Hunyuan3D, TRELLIS, Tripo, a scan, or a file someone downloaded
 * — enters here and from that point is an ordinary object: it takes modifiers,
 * materials, the lighting rig, the printability check and every export.
 *
 * That division is the useful one. Mesh generators are good at shapes a
 * language model cannot describe (a face, a dragon, a shoe) and have nothing to
 * say about studio lighting, wall thickness or STL orientation. Blender is the
 * reverse. Neither replaces the other, so the integration is a file handoff
 * rather than a rewrite.
 *
 * Operator names verified against the 5.x tree in bl_ui/space_topbar.py and
 * io_scene_gltf2/__init__.py — the glTF importer is `import_scene.gltf`, an
 * add-on, while the rest are the C++ `wm.*_import` operators.
 */
export const IMPORT_FORMATS = Object.freeze({
    glb: 'import_scene.gltf',
    gltf: 'import_scene.gltf',
    obj: 'wm.obj_import',
    stl: 'wm.stl_import',
    ply: 'wm.ply_import',
    fbx: 'wm.fbx_import'
});

/** Studio lighting presets. Named setups, because "light it properly" is a real request. */
export const LIGHTING_PRESETS = Object.freeze(['three_point', 'studio_softbox', 'rim', 'sun', 'none']);

const isFinite_ = (n) => typeof n === 'number' && Number.isFinite(n);
const isVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(isFinite_);
const isRGBA = (v) => Array.isArray(v) && v.length === 4 && v.every((c) => isFinite_(c) && c >= 0 && c <= 1);

/**
 * Is this path safe to write to?
 *
 * Output paths arrive from a language model, so `../../../Windows/System32` and
 * `C:\Users\ashut\OneDrive` are both things it can produce without meaning any
 * harm. Confinement is checked on the RESOLVED path — a check on the raw string
 * is defeated by `a/../../b`, which is exactly the input that would defeat it.
 *
 * Pure, so the resolution is done by the caller (Node's path module) and passed
 * in; this only decides. Kept here so the rule sits with the other rules.
 *
 * @param {string} resolvedPath  already absolute and normalised
 * @param {string} resolvedRoot  the workspace directory, absolute and normalised
 */
export function isConfined(resolvedPath, resolvedRoot) {
    if (typeof resolvedPath !== 'string' || typeof resolvedRoot !== 'string') return false;
    if (!resolvedPath || !resolvedRoot) return false;
    const norm = (s) => s.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const p = norm(resolvedPath);
    const r = norm(resolvedRoot);
    return p === r || p.startsWith(r + '/');
}

/** Defaults for a spec that omits everything optional. */
export function defaultRender() {
    return {
        engine: 'BLENDER_EEVEE',
        samples: 64,
        resolution: [960, 540],
        denoise: true,
        transparent_film: false,
        device: 'AUTO'          // resolved against probed devices at run time
    };
}

/**
 * Validate and normalise a scene spec.
 *
 * Returns every error rather than the first, because the caller is a model
 * being asked to try again: one error per round trip is one round trip per
 * error, and each of those is a full prefill on a 4 GB card.
 *
 * @param {object} spec
 * @param {{maxObjects?:number}} [opts]
 * @returns {{ok:boolean, errors:string[], spec:object|null}}
 */
export function validateSpec(spec, opts = {}) {
    const errors = [];
    const maxObjects = opts.maxObjects ?? LIMITS.MAX_OBJECTS;

    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
        return { ok: false, errors: ['spec must be an object'], spec: null };
    }

    /* ---- name ---- */
    const name = typeof spec.name === 'string' && spec.name.trim() ? spec.name.trim() : 'jarvis_scene';
    if (name.length > LIMITS.MAX_NAME) errors.push(`name exceeds ${LIMITS.MAX_NAME} characters`);
    if (!/^[\w \-.]+$/.test(name)) errors.push('name may contain only letters, digits, space, dash, dot, underscore');

    /* ---- objects ---- */
    const rawObjects = Array.isArray(spec.objects) ? spec.objects : [];
    if (rawObjects.length === 0) errors.push('spec must contain at least one object');
    if (rawObjects.length > maxObjects) {
        errors.push(`too many objects: ${rawObjects.length} exceeds the limit of ${maxObjects}`);
    }

    const objects = [];
    const seenNames = new Set();
    rawObjects.slice(0, maxObjects).forEach((o, i) => {
        const where = `objects[${i}]`;
        if (!o || typeof o !== 'object') { errors.push(`${where} must be an object`); return; }

        /* An object is either a PRIMITIVE Blender builds, or an IMPORT of a
           mesh made elsewhere. Exactly one — declaring both is ambiguous about
           which geometry wins, and silently preferring one is how a scene ends
           up containing something nobody asked for. */
        const isImport = o.import !== undefined && o.import !== null;
        const kind = o.primitive;

        /* `null` counts as absent, not as a declaration.
           VALIDATION MUST BE IDEMPOTENT: runSpec revalidates the spec it was
           handed, which for an internal caller is already normalised output —
           and normalised output sets `primitive: null` on an import. Treating
           that null as "a primitive was declared" made every import fail its
           second pass with "declares both", after passing the first. */
        if (isImport && kind !== undefined && kind !== null) {
            errors.push(`${where} declares both a primitive and an import — it must be one or the other`);
            return;
        }

        let importSpec = null;
        if (isImport) {
            const im = o.import;
            if (typeof im !== 'object' || Array.isArray(im)) { errors.push(`${where}.import must be an object`); return; }

            /* A BARE FILENAME, resolved by the caller against the imports
               directory. Same rule as exports, for the same reason: the
               directory is Jarvis's to choose and never the model's. A spec
               that could name an arbitrary path would let a generated mesh
               reference anything on the disk. */
            const file = typeof im.file === 'string' ? im.file.trim() : '';
            if (!file) { errors.push(`${where}.import.file is required`); return; }
            if (/[\\/]/.test(file) || file.includes('..')) {
                errors.push(`${where}.import.file must be a bare filename with no directory component`);
                return;
            }
            if (!/^[\w\-. ]+$/.test(file)) { errors.push(`${where}.import.file may contain only letters, digits, space, dash, dot, underscore`); return; }

            const ext = (file.split('.').pop() || '').toLowerCase();
            const format = typeof im.format === 'string' ? im.format.trim().toLowerCase() : ext;
            if (!Object.prototype.hasOwnProperty.call(IMPORT_FORMATS, format)) {
                errors.push(`${where}.import format "${format}" is not one of: ${Object.keys(IMPORT_FORMATS).join(', ')}`);
                return;
            }
            /* Imported meshes arrive at wildly different scales — a generator
               may emit a 0.01-unit or a 100-unit model with equal confidence,
               and the framing and lighting both key off the real bounds. A
               normalise flag makes "fit it to about this size" expressible
               without the caller knowing the file's units. */
            const normalise = im.normalise === undefined ? true : !!im.normalise;
            const targetSize = im.target_size === undefined ? 2 : im.target_size;
            if (!isFinite_(targetSize) || targetSize <= 0 || targetSize > 1000) {
                errors.push(`${where}.import.target_size must be a positive number no greater than 1000`);
                return;
            }
            importSpec = { file, format, normalise, target_size: targetSize };
        } else if (!Object.prototype.hasOwnProperty.call(PRIMITIVES, kind)) {
            errors.push(`${where}.primitive "${kind}" is not one of: ${Object.keys(PRIMITIVES).join(', ')}, or provide an "import"`);
            return;
        }

        const objName = typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, LIMITS.MAX_NAME) : `${isImport ? 'imported' : kind}_${i}`;
        /* Duplicate names are not an error in Blender — it silently appends
           .001, and then every later reference by name resolves to the wrong
           object. Rejecting is clearer than renaming behind the user's back. */
        if (seenNames.has(objName)) errors.push(`${where}.name "${objName}" is used more than once`);
        seenNames.add(objName);

        const params = {};
        if (!isImport) {
            const allowed = PRIMITIVES[kind];
            for (const [k, v] of Object.entries(o.params || {})) {
                if (!allowed.includes(k)) { errors.push(`${where}.params.${k} is not valid for ${kind} (allowed: ${allowed.join(', ')})`); continue; }
                if (!isFinite_(v) || v <= 0) { errors.push(`${where}.params.${k} must be a positive finite number`); continue; }
                params[k] = v;
            }
        } else if (o.params && Object.keys(o.params).length) {
            errors.push(`${where}.params does not apply to an import — the geometry comes from the file`);
        }

        const location = o.location === undefined ? [0, 0, 0] : o.location;
        const rotation = o.rotation === undefined ? [0, 0, 0] : o.rotation;
        const scale = o.scale === undefined ? [1, 1, 1] : o.scale;
        if (!isVec3(location)) errors.push(`${where}.location must be three finite numbers`);
        if (!isVec3(rotation)) errors.push(`${where}.rotation must be three finite numbers (radians)`);
        if (!isVec3(scale)) errors.push(`${where}.scale must be three finite numbers`);
        else if (scale.some((s) => s === 0)) errors.push(`${where}.scale must not contain zero — a zero axis collapses the mesh`);

        /* ---- modifiers ---- */
        const rawMods = Array.isArray(o.modifiers) ? o.modifiers : [];
        if (rawMods.length > LIMITS.MAX_MODIFIERS_PER_OBJECT) {
            errors.push(`${where}.modifiers: ${rawMods.length} exceeds the limit of ${LIMITS.MAX_MODIFIERS_PER_OBJECT}`);
        }
        const modifiers = [];
        rawMods.slice(0, LIMITS.MAX_MODIFIERS_PER_OBJECT).forEach((m, j) => {
            const mw = `${where}.modifiers[${j}]`;
            if (!m || typeof m !== 'object') { errors.push(`${mw} must be an object`); return; }
            if (!Object.prototype.hasOwnProperty.call(MODIFIERS, m.type)) {
                errors.push(`${mw}.type "${m.type}" is not one of: ${Object.keys(MODIFIERS).join(', ')}`);
                return;
            }
            const mod = { type: m.type };

            if (m.type === 'subsurf') {
                const levels = m.levels ?? 2;
                if (!Number.isInteger(levels) || levels < 0) errors.push(`${mw}.levels must be a non-negative integer`);
                else if (levels > LIMITS.MAX_SUBSURF) {
                    errors.push(`${mw}.levels ${levels} exceeds the limit of ${LIMITS.MAX_SUBSURF} — each level quadruples the polygon count`);
                } else mod.levels = levels;
            }
            if (m.type === 'bevel') {
                const width = m.width ?? 0.02;
                const segments = m.segments ?? 2;
                if (!isFinite_(width) || width < 0) errors.push(`${mw}.width must be a non-negative number`);
                else mod.width = width;
                if (!Number.isInteger(segments) || segments < 1 || segments > 24) errors.push(`${mw}.segments must be an integer between 1 and 24`);
                else mod.segments = segments;
            }
            if (m.type === 'array') {
                const count = m.count ?? 3;
                if (!Number.isInteger(count) || count < 1) errors.push(`${mw}.count must be a positive integer`);
                else if (count > LIMITS.MAX_ARRAY_COUNT) errors.push(`${mw}.count ${count} exceeds the limit of ${LIMITS.MAX_ARRAY_COUNT}`);
                else mod.count = count;
                const offset = m.offset ?? [1.5, 0, 0];
                if (!isVec3(offset)) errors.push(`${mw}.offset must be three finite numbers`);
                else mod.offset = offset;
            }
            if (m.type === 'mirror') {
                const axis = m.axis ?? [true, false, false];
                if (!Array.isArray(axis) || axis.length !== 3 || !axis.every((a) => typeof a === 'boolean')) {
                    errors.push(`${mw}.axis must be three booleans`);
                } else mod.axis = axis;
            }
            if (m.type === 'solidify') {
                const thickness = m.thickness ?? 0.05;
                if (!isFinite_(thickness)) errors.push(`${mw}.thickness must be a finite number`);
                else mod.thickness = thickness;
            }
            if (m.type === 'decimate') {
                const ratio = m.ratio ?? 0.5;
                if (!isFinite_(ratio) || ratio <= 0 || ratio > 1) errors.push(`${mw}.ratio must be greater than 0 and at most 1`);
                else mod.ratio = ratio;
            }
            if (m.type === 'remesh') {
                const voxel_size = m.voxel_size ?? 0.05;
                /* A voxel size near zero is the classic Blender hang: the grid
                   is 1/size^3, so 0.001 on a 2m object is 8 billion voxels. */
                if (!isFinite_(voxel_size) || voxel_size < 0.005) {
                    errors.push(`${mw}.voxel_size must be at least 0.005 — smaller grids exhaust memory before they finish`);
                } else mod.voxel_size = voxel_size;
            }
            if (m.type === 'boolean') {
                if (typeof m.target !== 'string' || !m.target.trim()) errors.push(`${mw}.target must name another object`);
                else mod.target = m.target.trim();
                const op = m.operation ?? 'DIFFERENCE';
                if (!['DIFFERENCE', 'UNION', 'INTERSECT'].includes(op)) errors.push(`${mw}.operation must be DIFFERENCE, UNION or INTERSECT`);
                else mod.operation = op;
            }
            if (m.type === 'screw') {
                const angle = m.angle ?? Math.PI * 2;
                const steps = m.steps ?? 16;
                if (!isFinite_(angle)) errors.push(`${mw}.angle must be a finite number (radians)`);
                else mod.angle = angle;
                if (!Number.isInteger(steps) || steps < 2 || steps > 256) errors.push(`${mw}.steps must be an integer between 2 and 256`);
                else mod.steps = steps;
            }
            if (m.type === 'wireframe') {
                const thickness = m.thickness ?? 0.02;
                if (!isFinite_(thickness) || thickness <= 0) errors.push(`${mw}.thickness must be a positive number`);
                else mod.thickness = thickness;
            }
            modifiers.push(mod);
        });

        /* ---- material ---- */
        let material = null;
        if (o.material !== undefined && o.material !== null) {
            const m = o.material;
            const mw = `${where}.material`;
            if (typeof m !== 'object') errors.push(`${mw} must be an object`);
            else {
                material = {};
                const base = m.base_color ?? [0.8, 0.8, 0.8, 1.0];
                if (!isRGBA(base)) errors.push(`${mw}.base_color must be four numbers between 0 and 1 (RGBA)`);
                else material.base_color = base;

                for (const key of ['metallic', 'roughness', 'transmission', 'emission_strength', 'alpha']) {
                    if (m[key] === undefined) continue;
                    const v = m[key];
                    /* emission_strength is a radiance multiplier, not a 0-1
                       factor — it is legitimately 5 or 50 for a glowing part. */
                    const hi = key === 'emission_strength' ? 1000 : 1;
                    if (!isFinite_(v) || v < 0 || v > hi) errors.push(`${mw}.${key} must be between 0 and ${hi}`);
                    else material[key] = v;
                }
                if (m.emission_color !== undefined) {
                    if (!isRGBA(m.emission_color)) errors.push(`${mw}.emission_color must be four numbers between 0 and 1 (RGBA)`);
                    else material.emission_color = m.emission_color;
                }
                if (m.ior !== undefined) {
                    if (!isFinite_(m.ior) || m.ior < 1 || m.ior > 4) errors.push(`${mw}.ior must be between 1 and 4`);
                    else material.ior = m.ior;
                }
            }
        }

        objects.push({ name: objName, primitive: isImport ? null : kind, import: importSpec, params, location, rotation, scale, modifiers, material });
    });

    /* Boolean targets must exist, and must not be the object itself — Blender
       accepts a self-referential boolean and produces an empty mesh. */
    for (const o of objects) {
        for (const m of o.modifiers) {
            if (m.type !== 'boolean' || !m.target) continue;
            if (m.target === o.name) errors.push(`objects."${o.name}" has a boolean modifier targeting itself`);
            else if (!seenNames.has(m.target)) errors.push(`objects."${o.name}" boolean targets "${m.target}", which is not in this scene`);
        }
    }

    /* ---- lighting ---- */
    const lightingRaw = spec.lighting ?? { preset: 'three_point' };
    const lighting = { preset: 'three_point', lights: [] };
    if (typeof lightingRaw === 'object' && lightingRaw) {
        const preset = lightingRaw.preset ?? 'three_point';
        if (!LIGHTING_PRESETS.includes(preset)) errors.push(`lighting.preset must be one of: ${LIGHTING_PRESETS.join(', ')}`);
        else lighting.preset = preset;

        const raw = Array.isArray(lightingRaw.lights) ? lightingRaw.lights : [];
        if (raw.length > LIMITS.MAX_LIGHTS) errors.push(`lighting.lights: ${raw.length} exceeds the limit of ${LIMITS.MAX_LIGHTS}`);
        raw.slice(0, LIMITS.MAX_LIGHTS).forEach((l, i) => {
            const lw = `lighting.lights[${i}]`;
            if (!l || typeof l !== 'object') { errors.push(`${lw} must be an object`); return; }
            const type = l.type ?? 'POINT';
            if (!LIGHT_TYPES.includes(type)) { errors.push(`${lw}.type must be one of: ${LIGHT_TYPES.join(', ')}`); return; }
            const location = l.location ?? [4, -4, 5];
            if (!isVec3(location)) { errors.push(`${lw}.location must be three finite numbers`); return; }
            const energy = l.energy ?? 500;
            if (!isFinite_(energy) || energy < 0) { errors.push(`${lw}.energy must be a non-negative number`); return; }
            const color = l.color ?? [1, 1, 1];
            if (!Array.isArray(color) || color.length !== 3 || !color.every((c) => isFinite_(c) && c >= 0 && c <= 1)) {
                errors.push(`${lw}.color must be three numbers between 0 and 1`); return;
            }
            lighting.lights.push({ type, location, energy, color, size: isFinite_(l.size) && l.size > 0 ? l.size : 1 });
        });
    }

    /* ---- camera ---- */
    const camRaw = spec.camera ?? {};
    const camera = {
        location: isVec3(camRaw.location) ? camRaw.location : [7.36, -6.93, 4.96],
        look_at: isVec3(camRaw.look_at) ? camRaw.look_at : [0, 0, 0],
        focal_length: isFinite_(camRaw.focal_length) && camRaw.focal_length > 0 ? camRaw.focal_length : 50,
        /* Defaults ON, and not something the planner is told about.

           The builder keeps the model's camera DIRECTION and recomputes the
           distance from the real bounding box. A language model has no sense
           of the metric scale of a scene it invented — the observed failure
           was a mug rendered as a speck — and distance is arithmetic, so the
           builder does it. Overridable for the case where a specific distance
           is the point. */
        auto_frame: camRaw.auto_frame === undefined ? true : !!camRaw.auto_frame
    };
    if (camRaw.location !== undefined && !isVec3(camRaw.location)) errors.push('camera.location must be three finite numbers');
    if (camRaw.look_at !== undefined && !isVec3(camRaw.look_at)) errors.push('camera.look_at must be three finite numbers');
    if (camRaw.focal_length !== undefined && (!isFinite_(camRaw.focal_length) || camRaw.focal_length <= 0)) {
        errors.push('camera.focal_length must be a positive number (millimetres)');
    }
    if (isVec3(camera.location) && isVec3(camera.look_at)) {
        const d = Math.hypot(camera.location[0] - camera.look_at[0], camera.location[1] - camera.look_at[1], camera.location[2] - camera.look_at[2]);
        /* A camera at its own target has no look direction; the track-to
           constraint produces a NaN matrix and the render is black. */
        if (d < 1e-6) errors.push('camera.location and camera.look_at are the same point — there is no direction to face');
    }

    /* ---- world ---- */
    const worldRaw = spec.world ?? {};
    const world = {
        color: isRGBA(worldRaw.color) ? worldRaw.color : [0.05, 0.05, 0.05, 1.0],
        strength: isFinite_(worldRaw.strength) && worldRaw.strength >= 0 ? worldRaw.strength : 1.0
    };
    if (worldRaw.color !== undefined && !isRGBA(worldRaw.color)) errors.push('world.color must be four numbers between 0 and 1 (RGBA)');
    if (worldRaw.strength !== undefined && (!isFinite_(worldRaw.strength) || worldRaw.strength < 0)) errors.push('world.strength must be a non-negative number');

    /* ---- render ---- */
    const r = { ...defaultRender(), ...(typeof spec.render === 'object' && spec.render ? spec.render : {}) };
    if (!ENGINES.includes(r.engine)) errors.push(`render.engine must be one of: ${ENGINES.join(', ')}`);
    if (!Number.isInteger(r.samples) || r.samples < 1) errors.push('render.samples must be a positive integer');
    else if (r.samples > LIMITS.MAX_SAMPLES) errors.push(`render.samples ${r.samples} exceeds the limit of ${LIMITS.MAX_SAMPLES}`);
    if (!Array.isArray(r.resolution) || r.resolution.length !== 2 || !r.resolution.every(Number.isInteger)) {
        errors.push('render.resolution must be two integers');
    } else if (r.resolution.some((v) => v < LIMITS.MIN_RESOLUTION || v > LIMITS.MAX_RESOLUTION)) {
        errors.push(`render.resolution must be between ${LIMITS.MIN_RESOLUTION} and ${LIMITS.MAX_RESOLUTION} on both axes`);
    }
    if (typeof r.denoise !== 'boolean') errors.push('render.denoise must be true or false');
    if (typeof r.transparent_film !== 'boolean') errors.push('render.transparent_film must be true or false');
    if (!['AUTO', 'CPU', 'GPU'].includes(r.device)) errors.push('render.device must be AUTO, CPU or GPU');

    /* ---- exports ---- */
    const rawExports = Array.isArray(spec.exports) ? spec.exports : [];
    const exports_ = [];
    rawExports.forEach((e, i) => {
        const ew = `exports[${i}]`;
        if (!e || typeof e !== 'object') { errors.push(`${ew} must be an object`); return; }
        if (!Object.prototype.hasOwnProperty.call(EXPORT_FORMATS, e.format)) {
            errors.push(`${ew}.format must be one of: ${Object.keys(EXPORT_FORMATS).join(', ')}`);
            return;
        }
        /* Filenames only. The directory is the caller's workspace and is never
           taken from the model — that is what keeps the path confinement check
           from having anything to defeat. */
        const filename = typeof e.filename === 'string' ? e.filename.trim() : '';
        if (!filename) { errors.push(`${ew}.filename is required`); return; }
        if (/[\\/]/.test(filename) || filename.includes('..')) {
            errors.push(`${ew}.filename must be a bare filename with no directory component`);
            return;
        }
        if (!/^[\w\-. ]+$/.test(filename)) { errors.push(`${ew}.filename may contain only letters, digits, space, dash, dot, underscore`); return; }
        exports_.push({ format: e.format, filename });
    });

    if (errors.length) return { ok: false, errors, spec: null };
    return {
        ok: true,
        errors: [],
        spec: { name, objects, lighting, camera, world, render: r, exports: exports_ }
    };
}

export default {
    PRIMITIVES, MODIFIERS, LIGHT_TYPES, ENGINES, EXPORT_FORMATS, LIMITS, LIGHTING_PRESETS,
    validateSpec, defaultRender, isConfined
};
