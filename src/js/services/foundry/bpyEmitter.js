// Emits the Blender script for a validated scene spec.
//
// PURE. Takes a spec, returns a string. No filesystem, no spawn, no bpy.
//
// ---------------------------------------------------------------------------
// WHY THERE IS A PYTHON STRING IN A JAVASCRIPT PROJECT
//
// Blender embeds CPython and exposes `bpy` only inside it. There is no
// JavaScript binding, no RPC surface, and `-P` takes a .py path. Driving
// Blender means producing Python, the same way talking to Postgres means
// producing SQL and talking to a GPU means producing shader source.
//
// So Python here is a COMPILATION TARGET, not a source language. Nothing in
// this repository is written in Python; this file writes it, from a spec that
// JavaScript validated, using a vocabulary JavaScript owns. The generated
// script lands in the job directory beside spec.json, which also makes every
// run reproducible by hand: the exact script that ran is on disk next to the
// exact spec that produced it.
//
// WHAT LIVES WHERE, AND WHY THE LINE IS DRAWN THERE
//
//   JavaScript decides POLICY — which primitive, which modifier, which
//   lighting preset and its reference positions, which engine, how many
//   samples, the framing margin. All of it testable without Blender.
//
//   The emitted script does MEASUREMENT-DEPENDENT arithmetic — the scene
//   bounding box, and the camera distance and light scaling derived from it.
//   Those depend on geometry after bevel, subdivision and boolean have run,
//   which only Blender can know. Computing them here would mean predicting
//   Blender's output rather than reading it, and this project does not guess
//   at things the machine can be asked.
//
// INJECTION. Every value crossing into the script goes through pyNum/pyStr/
// pyBool below. Nothing is interpolated raw. The spec is validated before it
// gets here — names match /^[\w \-.]+$/ and carry no quotes or backslashes —
// but paths come from Node and do contain backslashes on Windows, so escaping
// is done properly rather than relied on being unnecessary. There is a test
// that tries to break out of a string literal.
// ---------------------------------------------------------------------------

import { IMPORT_FORMATS } from './sceneSpec.js';

/**
 * Join a directory and a bare filename.
 *
 * Uses whichever separator the directory already carries rather than always
 * path.sep, because this module is pure and is exercised in tests with
 * Windows-shaped and POSIX-shaped paths in the same run.
 */
function joinPath(dir, name) {
    const sep = String(dir).includes('\\') ? '\\' : '/';
    return `${dir}${String(dir).endsWith(sep) ? '' : sep}${name}`;
}

/** A Python float literal. Rejects anything that would emit `NaN`/`Infinity`, which are not Python. */
export function pyNum(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new TypeError(`cannot emit non-finite number: ${value}`);
    /* Integers are emitted with a decimal point so Blender never receives an
       int where a float property is expected — harmless for most, but
       `bevel.width = 1` and `= 1.0` differ in type and some properties care. */
    return Number.isInteger(n) ? `${n}.0` : String(n);
}

/** A Python int literal, for properties that genuinely are integers (segments, samples). */
export function pyInt(value) {
    const n = Number(value);
    if (!Number.isInteger(n)) throw new TypeError(`cannot emit non-integer: ${value}`);
    return String(n);
}

/**
 * A Python string literal.
 *
 * JSON.stringify produces a double-quoted string with backslashes, quotes and
 * control characters escaped, and every one of those escapes means the same
 * thing in Python as in JSON. Non-ASCII stays literal, which is fine: the
 * emitted file is written and read as UTF-8.
 */
export function pyStr(value) {
    return JSON.stringify(String(value));
}

export function pyBool(value) {
    return value ? 'True' : 'False';
}

/** A Python tuple of floats. */
function pyVec(values) {
    return `(${values.map(pyNum).join(', ')})`;
}

/* Spec parameter name -> the bpy.ops keyword, where they differ.

   ring_count is the one that matters: uv_sphere's keyword is `ring_count`,
   not `rings`, verified in editors/mesh/editmesh_add.cc:766 of the 5.x source.
   Passing `rings=` raises TypeError inside the job. */
const PRIMITIVE_OPS = {
    cube: { op: 'primitive_cube_add', params: { size: 'size' } },
    uv_sphere: { op: 'primitive_uv_sphere_add', params: { radius: 'radius', segments: 'segments', rings: 'ring_count' }, ints: ['segments', 'rings'] },
    ico_sphere: { op: 'primitive_ico_sphere_add', params: { radius: 'radius', subdivisions: 'subdivisions' }, ints: ['subdivisions'] },
    cylinder: { op: 'primitive_cylinder_add', params: { radius: 'radius', depth: 'depth', vertices: 'vertices' }, ints: ['vertices'] },
    cone: { op: 'primitive_cone_add', params: { radius1: 'radius1', radius2: 'radius2', depth: 'depth', vertices: 'vertices' }, ints: ['vertices'] },
    torus: { op: 'primitive_torus_add', params: { major_radius: 'major_radius', minor_radius: 'minor_radius', major_segments: 'major_segments', minor_segments: 'minor_segments' }, ints: ['major_segments', 'minor_segments'] },
    plane: { op: 'primitive_plane_add', params: { size: 'size' } },
    grid: { op: 'primitive_grid_add', params: { size: 'size', x_subdivisions: 'x_subdivisions', y_subdivisions: 'y_subdivisions' }, ints: ['x_subdivisions', 'y_subdivisions'] },
    monkey: { op: 'primitive_monkey_add', params: { size: 'size' } }
};

const MODIFIER_TYPES = {
    subsurf: 'SUBSURF', bevel: 'BEVEL', array: 'ARRAY', mirror: 'MIRROR',
    solidify: 'SOLIDIFY', decimate: 'DECIMATE', remesh: 'REMESH',
    boolean: 'BOOLEAN', screw: 'SCREW', wireframe: 'WIREFRAME'
};

/**
 * Principled BSDF sockets, newest name first.
 *
 * The 4.0 rework renamed these. `Transmission` became `Transmission Weight`
 * and `Emission` became `Emission Color` — checked in
 * nodes/shader/nodes/node_shader_bsdf_principled.cc:215 and :295. The old name
 * does not error, it simply is not found, which would mean a material that
 * silently stays default. The fallback name is emitted too so the script also
 * works against a pre-4.0 Blender.
 */
const MATERIAL_SOCKETS = {
    base_color: ['Base Color'],
    metallic: ['Metallic'],
    roughness: ['Roughness'],
    transmission: ['Transmission Weight', 'Transmission'],
    emission_color: ['Emission Color', 'Emission'],
    emission_strength: ['Emission Strength'],
    alpha: ['Alpha'],
    ior: ['IOR']
};

/**
 * Lighting presets: reference positions for a subject of radius 1 at the origin.
 *
 * The emitted script multiplies positions by the measured subject radius and
 * energies by its square. Point and area lights fall off with the square of
 * distance, so a rig pinned to absolute coordinates flatters exactly one scene
 * size and underlights or blows out every other. The model picks the scene's
 * scale freely and has no reason to think about photometry, so the rig follows
 * the geometry.
 *
 * A sun is directional — distance does not affect its irradiance — so its
 * energy is not scaled. That exception is why `scaleEnergy` is per-light.
 */
export const LIGHT_PRESETS = Object.freeze({
    three_point: [
        { name: 'key', type: 'AREA', at: [4, -4, 5], energy: 800, color: [1.0, 0.98, 0.95], size: 4, scaleEnergy: true },
        { name: 'fill', type: 'AREA', at: [-5, -3, 2], energy: 250, color: [0.9, 0.95, 1.0], size: 6, scaleEnergy: true },
        { name: 'rim', type: 'AREA', at: [0, 5, 4], energy: 500, color: [1.0, 1.0, 1.0], size: 3, scaleEnergy: true }
    ],
    studio_softbox: [
        { name: 'softbox_front', type: 'AREA', at: [0, -6, 5], energy: 1200, color: [1, 1, 1], size: 8, scaleEnergy: true },
        { name: 'softbox_side', type: 'AREA', at: [6, 2, 4], energy: 600, color: [1.0, 0.99, 0.97], size: 8, scaleEnergy: true },
        { name: 'ambient_sun', type: 'SUN', at: [0, 0, 10], energy: 1.5, color: [1, 1, 1], size: 1, scaleEnergy: false }
    ],
    rim: [
        { name: 'rim', type: 'AREA', at: [0, 6, 3], energy: 900, color: [1, 1, 1], size: 4, scaleEnergy: true },
        { name: 'ambient', type: 'AREA', at: [3, -4, 2], energy: 120, color: [0.9, 0.93, 1.0], size: 5, scaleEnergy: true }
    ],
    sun: [
        { name: 'sun', type: 'SUN', at: [5, -5, 10], energy: 4.0, color: [1.0, 0.97, 0.92], size: 1, scaleEnergy: false }
    ],
    none: []
});

/** How much empty space to leave around the subject when framing. 1.0 is edge-to-edge. */
export const FRAMING_MARGIN = 1.35;

/* ------------------------------------------------------------------ helpers */

function emitMaterial(objVar, material, matName) {
    const lines = [];
    lines.push(`mat = bpy.data.materials.new(name=${pyStr(matName)})`);
    lines.push('mat.use_nodes = True');
    lines.push('bsdf = mat.node_tree.nodes.get("Principled BSDF") or next((n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)');
    lines.push('if bsdf is None:');
    lines.push('    raise RuntimeError("the material node tree has no Principled BSDF")');

    for (const [key, names] of Object.entries(MATERIAL_SOCKETS)) {
        if (material[key] === undefined) continue;
        const value = Array.isArray(material[key]) ? pyVec(material[key]) : pyNum(material[key]);
        /* THE TRAILING COMMA IS LOad-BEARING. In Python `("Base Color")` is a
           string in parentheses, not a one-element tuple, so `for name in
           names` iterates over its CHARACTERS and matches no socket. Observed
           on 3 Aug 2026: every material rendered default grey, and the only
           reason it was not mistaken for a lighting problem is that
           set_socket reports a miss instead of passing silently. */
        const nameList = `(${names.map(pyStr).join(', ')}${names.length === 1 ? ',' : ''})`;
        /* set_socket returns whether it landed; a miss is collected as a
           warning rather than thrown, because a material that did not fully
           apply is worth saying and is not worth discarding a render for. */
        lines.push(`set_socket(bsdf, ${nameList}, ${value}, ${pyStr(matName)}, ${pyStr(key)})`);
    }

    if ((material.transmission ?? 0) > 0 || (material.alpha ?? 1) < 1) {
        lines.push('try:');
        lines.push('    mat.blend_method = "BLEND"');
        lines.push('except (AttributeError, TypeError):');
        lines.push(`    result["build"]["warnings"].append(${pyStr(`${matName}: blend_method is unavailable in this build`)})`);
    }
    /* CLEAR FIRST, then append.

       `materials.append` adds a slot; it does not change the material index
       stored per face. An imported GLB arrives with its own slots already
       assigned, so appending left every face pointing at the generator's
       material and the requested one unused — asking for gold and getting the
       source colours, with no error anywhere. Harmless for primitives, which
       have no slots to clear. */
    lines.push(`${objVar}.data.materials.clear()`);
    lines.push(`${objVar}.data.materials.append(mat)`);
    return lines;
}

function emitModifier(objVar, mod, objName) {
    const t = mod.type;
    const lines = [`mod = ${objVar}.modifiers.new(name=${pyStr(t)}, type=${pyStr(MODIFIER_TYPES[t])})`];

    if (t === 'subsurf') {
        lines.push(`mod.levels = ${pyInt(mod.levels ?? 2)}`);
        lines.push(`mod.render_levels = ${pyInt(mod.levels ?? 2)}`);
    } else if (t === 'bevel') {
        lines.push(`mod.width = ${pyNum(mod.width ?? 0.02)}`);
        lines.push(`mod.segments = ${pyInt(mod.segments ?? 2)}`);
        /* Without an angle limit a bevel runs along every edge including the
           ones that are already smooth, which reads as a melted object. */
        lines.push('mod.limit_method = "ANGLE"');
    } else if (t === 'array') {
        lines.push(`mod.count = ${pyInt(mod.count ?? 3)}`);
        lines.push('mod.use_relative_offset = True');
        lines.push(`mod.relative_offset_displace = ${pyVec(mod.offset ?? [1.5, 0, 0])}`);
    } else if (t === 'mirror') {
        lines.push(`mod.use_axis = (${(mod.axis ?? [true, false, false]).map(pyBool).join(', ')})`);
    } else if (t === 'solidify') {
        lines.push(`mod.thickness = ${pyNum(mod.thickness ?? 0.05)}`);
    } else if (t === 'decimate') {
        lines.push(`mod.ratio = ${pyNum(mod.ratio ?? 0.5)}`);
    } else if (t === 'remesh') {
        lines.push('mod.mode = "VOXEL"');
        lines.push(`mod.voxel_size = ${pyNum(mod.voxel_size ?? 0.05)}`);
    } else if (t === 'boolean') {
        lines.push(`mod.object = objects[${pyStr(mod.target)}]`);
        lines.push(`mod.operation = ${pyStr(mod.operation ?? 'DIFFERENCE')}`);
        /* A cutter that still renders is a solid block sitting inside the
           result. Hiding it is what makes "a box with a hole" mean it. */
        lines.push(`objects[${pyStr(mod.target)}].hide_render = True`);
        lines.push(`objects[${pyStr(mod.target)}].hide_viewport = True`);
    } else if (t === 'screw') {
        lines.push(`mod.angle = ${pyNum(mod.angle ?? Math.PI * 2)}`);
        lines.push(`mod.steps = ${pyInt(mod.steps ?? 16)}`);
    } else if (t === 'wireframe') {
        lines.push(`mod.thickness = ${pyNum(mod.thickness ?? 0.02)}`);
    } else {
        throw new TypeError(`no emitter for modifier ${t} — the spec vocabulary and the emitter have drifted`);
    }
    return lines.map((l) => l).concat([`# ${objName}.${t}`]);
}

/* ------------------------------------------------------------------- emitter */

/**
 * Build the complete Blender script for a validated spec.
 *
 * @param {object} spec       output of validateSpec — assumed valid
 * @param {{outdir:string, resultPath:string, imageName?:string}} io
 * @returns {string} Python source
 */
export function emitScript(spec, io) {
    if (!spec || !Array.isArray(spec.objects)) throw new TypeError('emitScript needs a validated spec');
    if (!io || !io.outdir || !io.resultPath) throw new TypeError('emitScript needs outdir and resultPath');

    const L = [];
    const imageName = io.imageName || `${spec.name}.png`;
    const wantsPrintCheck = (spec.exports || []).some((e) => ['stl', 'obj', 'ply'].includes(e.format));

    /* ---------------- preamble ---------------- */
    L.push('# Generated by Jarvis Foundry (src/js/services/foundry/bpyEmitter.js).');
    L.push('# Do not edit: this file is rewritten for every job, and lives beside');
    L.push('# the spec.json it was generated from so any run can be replayed by hand.');
    L.push('import json, os, sys, time, traceback');
    L.push('import bpy, bmesh, mathutils');
    L.push('');
    L.push('started = time.time()');
    L.push('result = {"ok": False, "stage": "startup", "blender": bpy.app.version_string,');
    L.push('          "build": {"objects": [], "warnings": []}}');
    L.push(`RESULT_PATH = ${pyStr(io.resultPath)}`);
    /* Repair is on by default and can be turned off, because a repaired mesh
       is not the mesh that was described — welding and hole-filling change
       geometry, and someone measuring a deliberate gap needs the raw result. */
    L.push(`REPAIR = ${pyBool(io.repair !== false)}`);
    L.push('');
    /* Two small generic helpers. Everything else in this script is literal
       values chosen by JavaScript. */
    L.push('def set_socket(node, names, value, owner, key):');
    L.push('    for name in names:');
    L.push('        socket = node.inputs.get(name)');
    L.push('        if socket is not None:');
    L.push('            socket.default_value = value');
    L.push('            return True');
    L.push('    result["build"]["warnings"].append("%s: no socket for %s; not applied" % (owner, key))');
    L.push('    return False');
    L.push('');
    L.push('def aim(obj, target):');
    L.push('    """Point an object\'s -Z at a target, baked into rotation_euler.');
    L.push('    A TRACK_TO constraint would be evaluated by the depsgraph instead,');
    L.push('    leaving rotation_euler unchanged and misleading anything that reads');
    L.push('    the transform back."""');
    L.push('    direction = mathutils.Vector(target) - obj.location');
    L.push('    if direction.length < 1e-9:');
    L.push('        return');
    L.push('    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()');
    L.push('');
    L.push('def scene_bounds():');
    L.push('    """World-space bounds of what will actually render.');
    L.push('    Boolean cutters are hidden and excluded: they are usually larger');
    L.push('    than the part and would blow the framing out."""');
    L.push('    corners = []');
    L.push('    for obj in bpy.context.scene.objects:');
    L.push('        if obj.type != "MESH" or obj.hide_render:');
    L.push('            continue');
    L.push('        for corner in obj.bound_box:');
    L.push('            corners.append(obj.matrix_world @ mathutils.Vector(corner))');
    L.push('    if not corners:');
    L.push('        return None, None');
    L.push('    lo = mathutils.Vector((min(c.x for c in corners), min(c.y for c in corners), min(c.z for c in corners)))');
    L.push('    hi = mathutils.Vector((max(c.x for c in corners), max(c.y for c in corners), max(c.z for c in corners)))');
    L.push('    return lo, hi');
    L.push('');
    L.push('try:');

    const body = [];

    /* ---------------- clear ---------------- */
    body.push('result["stage"] = "clear"');
    body.push('if bpy.context.object and bpy.context.object.mode != "OBJECT":');
    body.push('    bpy.ops.object.mode_set(mode="OBJECT")');
    body.push('bpy.ops.object.select_all(action="SELECT")');
    body.push('bpy.ops.object.delete(use_global=False)');
    /* --factory-startup still leaves the default cube, camera and light.
       Rendering those alongside the requested geometry is the most confusing
       failure this pipeline has, because the output looks like it worked. */
    body.push('for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.lights, bpy.data.cameras):');
    body.push('    for block in list(coll):');
    body.push('        if block.users == 0:');
    body.push('            coll.remove(block)');
    body.push('objects = {}');
    body.push('');

    /* ---------------- geometry ---------------- */
    body.push('result["stage"] = "geometry"');
    for (const obj of spec.objects) {
        if (obj.import) {
            /* An import is not one object. A GLB routinely carries several
               meshes plus empties, and sometimes a camera and lights from
               whatever produced it. The rest of this pipeline — modifiers,
               materials, boolean targets, naming — is written against ONE
               object per spec entry, so the import is reduced to one: meshes
               are joined, everything else that came with the file is deleted.
               Importing a generator's camera and rendering through it is a
               genuinely confusing failure. */
            const opName = IMPORT_FORMATS[obj.import.format];
            const filepath = joinPath(io.importDir || io.outdir, obj.import.file);

            body.push(`import_path = ${pyStr(filepath)}`);
            body.push('if not os.path.exists(import_path):');
            body.push(`    raise RuntimeError("the mesh to import does not exist: %s" % import_path)`);
            body.push('before = set(bpy.data.objects)');
            body.push(`bpy.ops.${opName}(filepath=import_path)`);
            body.push('arrived = [o for o in bpy.data.objects if o not in before]');
            body.push('if not arrived:');
            body.push(`    raise RuntimeError("${obj.import.format} import produced no objects")`);
            body.push('imported_meshes = [o for o in arrived if o.type == "MESH"]');
            body.push('for stray in [o for o in arrived if o.type != "MESH"]:');
            body.push('    bpy.data.objects.remove(stray, do_unlink=True)');
            body.push('if not imported_meshes:');
            body.push(`    raise RuntimeError("the imported file contained no mesh")`);
            body.push('bpy.ops.object.select_all(action="DESELECT")');
            body.push('for m in imported_meshes:');
            body.push('    m.select_set(True)');
            body.push('bpy.context.view_layer.objects.active = imported_meshes[0]');
            body.push('if len(imported_meshes) > 1:');
            body.push('    bpy.ops.object.join()');
            body.push('obj = bpy.context.view_layer.objects.active');
            /* Bake the import's own transform before ours is applied, or the
               spec's location/rotation/scale compose with whatever the file
               carried and the object lands somewhere nobody chose. */
            body.push('bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)');

            if (obj.import.normalise) {
                /* Generators emit at arbitrary scale — 0.01 units or 100 with
                   equal confidence — and both the framing and the light rig key
                   off real bounds. Normalising to a known size makes an
                   imported mesh behave like a primitive of the same size. */
                body.push('bb = [obj.matrix_world @ mathutils.Vector(c) for c in obj.bound_box]');
                body.push('ext = mathutils.Vector((max(v.x for v in bb) - min(v.x for v in bb),');
                body.push('                        max(v.y for v in bb) - min(v.y for v in bb),');
                body.push('                        max(v.z for v in bb) - min(v.z for v in bb)))');
                body.push('longest = max(ext.x, ext.y, ext.z)');
                body.push('if longest > 1e-9:');
                body.push(`    factor = ${pyNum(obj.import.target_size)} / longest`);
                body.push('    obj.scale = (factor, factor, factor)');
                body.push('    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)');
                /* Sit it on the origin so it rests on z=0 like every primitive,
                   rather than floating wherever the file happened to put it. */
                body.push('bb = [obj.matrix_world @ mathutils.Vector(c) for c in obj.bound_box]');
                body.push('obj.location = (obj.location.x - sum(v.x for v in bb) / 8.0,');
                body.push('                obj.location.y - sum(v.y for v in bb) / 8.0,');
                body.push('                obj.location.z - min(v.z for v in bb))');
                body.push('bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)');
            }
            body.push(`result["build"].setdefault("imported", []).append({"name": ${pyStr(obj.name)}, "file": ${pyStr(obj.import.file)}, "parts": len(imported_meshes)})`);
        } else {
            const def = PRIMITIVE_OPS[obj.primitive];
            if (!def) throw new TypeError(`no emitter for primitive ${obj.primitive}`);
            const ints = new Set(def.ints || []);
            const kwargs = Object.entries(obj.params || {})
                .map(([k, v]) => `${def.params[k]}=${ints.has(k) ? pyInt(v) : pyNum(v)}`);
            body.push(`bpy.ops.mesh.${def.op}(location=(0.0, 0.0, 0.0)${kwargs.length ? ', ' + kwargs.join(', ') : ''})`);
            body.push('obj = bpy.context.active_object');
            body.push('if obj is None:');
            body.push(`    raise RuntimeError(${pyStr(`${def.op} produced no object`)})`);
        }
        body.push(`obj.name = ${pyStr(obj.name)}`);
        body.push(`obj.location = ${pyVec(obj.location)}`);
        body.push(`obj.rotation_euler = ${pyVec(obj.rotation)}`);
        body.push(`obj.scale = ${pyVec(obj.scale)}`);
        body.push(`objects[${pyStr(obj.name)}] = obj`);
        body.push('');
    }

    /* Materials and modifiers in a second pass: a boolean may name an object
       declared after it, and the spec permits that. */
    body.push('result["stage"] = "materials"');
    for (const obj of spec.objects) {
        const objVar = `objects[${pyStr(obj.name)}]`;
        if (obj.material) {
            body.push(...emitMaterial(objVar, obj.material, `${obj.name}_mat`));
            body.push('');
        }
        for (const mod of obj.modifiers || []) {
            body.push(...emitModifier(objVar, mod, obj.name));
        }
        if ((obj.modifiers || []).length) body.push('');
    }

    /* ---------------- measurement ---------------- */
    body.push('result["stage"] = "measure"');
    body.push('lo, hi = scene_bounds()');
    body.push('if lo is None:');
    body.push('    center = mathutils.Vector((0.0, 0.0, 0.0))');
    body.push('    radius = 1.0');
    body.push('else:');
    body.push('    center = (lo + hi) / 2.0');
    body.push('    radius = max((hi - lo).length / 2.0, 1e-4)');
    body.push('result["build"]["subject_radius"] = round(radius, 4)');
    body.push('');

    /* ---------------- lighting ---------------- */
    body.push('result["stage"] = "lighting"');
    const preset = LIGHT_PRESETS[spec.lighting?.preset ?? 'three_point'] || [];
    const allLights = [
        ...preset.map((l) => ({ ...l, scalePosition: true })),
        /* Explicit lights are given in the scene's own coordinates, so they
           are placed as written — the user asked for that position. */
        ...(spec.lighting?.lights || []).map((l, i) => ({
            name: `custom_light_${i}`, type: l.type, at: l.location, energy: l.energy,
            color: l.color, size: l.size ?? 1, scaleEnergy: false, scalePosition: false
        }))
    ];
    for (const light of allLights) {
        body.push(`ldata = bpy.data.lights.new(name=${pyStr(light.name)}, type=${pyStr(light.type)})`);
        body.push(`ldata.energy = ${pyNum(light.energy)}${light.scaleEnergy ? ' * (radius * radius)' : ''}`);
        body.push(`ldata.color = ${pyVec(light.color)}`);
        if (light.type === 'AREA') body.push(`ldata.size = ${pyNum(light.size)}${light.scalePosition ? ' * radius' : ''}`);
        if (light.type === 'SPOT') body.push('ldata.spot_size = 1.0471975512');   // 60 degrees
        body.push(`lobj = bpy.data.objects.new(name=${pyStr(light.name)}, object_data=ldata)`);
        body.push('bpy.context.collection.objects.link(lobj)');
        if (light.scalePosition) {
            body.push(`lobj.location = center + mathutils.Vector(${pyVec(light.at)}) * radius`);
        } else {
            body.push(`lobj.location = ${pyVec(light.at)}`);
        }
        body.push('aim(lobj, center)');
        body.push('');
    }

    /* ---------------- camera ---------------- */
    body.push('result["stage"] = "camera"');
    body.push(`cdata = bpy.data.cameras.new("camera")`);
    body.push(`cdata.lens = ${pyNum(spec.camera.focal_length)}`);
    body.push('cam = bpy.data.objects.new("camera", cdata)');
    body.push('bpy.context.collection.objects.link(cam)');
    body.push(`cam.location = ${pyVec(spec.camera.location)}`);
    body.push(`aim(cam, ${pyVec(spec.camera.look_at)})`);
    body.push('bpy.context.scene.camera = cam');
    body.push('');

    /* ---------------- world and render settings ---------------- */
    body.push('result["stage"] = "render_setup"');
    body.push('world = bpy.data.worlds.get("World") or bpy.data.worlds.new("World")');
    body.push('bpy.context.scene.world = world');
    body.push('world.use_nodes = True');
    body.push('bg = world.node_tree.nodes.get("Background")');
    body.push('if bg is not None:');
    body.push(`    bg.inputs["Color"].default_value = ${pyVec(spec.world.color)}`);
    body.push(`    bg.inputs["Strength"].default_value = ${pyNum(spec.world.strength)}`);
    body.push('');

    const r = spec.render;
    body.push('scene = bpy.context.scene');
    body.push(`scene.render.engine = ${pyStr(r.engine)}`);
    body.push(`scene.render.resolution_x = ${pyInt(r.resolution[0])}`);
    body.push(`scene.render.resolution_y = ${pyInt(r.resolution[1])}`);
    body.push('scene.render.resolution_percentage = 100');
    body.push(`scene.render.film_transparent = ${pyBool(r.transparent_film)}`);
    body.push('scene.render.image_settings.file_format = "PNG"');
    body.push('device_detail = "n/a"');

    if (r.engine === 'CYCLES') {
        body.push(`scene.cycles.samples = ${pyInt(r.samples)}`);
        body.push(`scene.cycles.use_denoising = ${pyBool(r.denoise)}`);
        /* Adaptive sampling stops early on converged tiles; on a CPU fallback
           that is the difference between a preview and a coffee break. */
        body.push('scene.cycles.use_adaptive_sampling = True');
        /* The device is PROBED, never assumed. This machine's GTX 1650 Ti is
           Turing without RT cores, and whether OptiX is offered depends on the
           build and the driver, not on the model name. */
        body.push(`requested_device = ${pyStr(r.device)}`);
        body.push('if requested_device == "CPU":');
        body.push('    scene.cycles.device = "CPU"');
        body.push('    device_detail = "CPU requested"');
        body.push('else:');
        body.push('    prefs = bpy.context.preferences.addons.get("cycles")');
        body.push('    found = []');
        body.push('    if prefs is not None:');
        body.push('        for backend in ("OPTIX", "CUDA", "HIP", "METAL", "ONEAPI"):');
        body.push('            try:');
        body.push('                devices = prefs.preferences.get_devices_for_type(backend)');
        body.push('            except Exception:');
        body.push('                continue');
        body.push('            if devices:');
        body.push('                found.append((backend, [d.name for d in devices]))');
        body.push('    if found:');
        body.push('        backend, names = found[0]');
        body.push('        prefs.preferences.compute_device_type = backend');
        body.push('        for device in prefs.preferences.devices:');
        body.push('            device.use = (device.type == backend)');
        body.push('        scene.cycles.device = "GPU"');
        body.push('        device_detail = "%s: %s" % (backend, ", ".join(names))');
        body.push('    else:');
        body.push('        scene.cycles.device = "CPU"');
        body.push('        device_detail = "no GPU compute device available; rendering on CPU"');
    } else if (r.engine === 'BLENDER_EEVEE') {
        /* The sample property has moved between EEVEE versions. Set whichever
           exists rather than guess, and say so if neither does. */
        body.push('for attr in ("taa_render_samples", "samples"):');
        body.push('    if hasattr(scene.eevee, attr):');
        body.push(`        setattr(scene.eevee, attr, ${pyInt(r.samples)})`);
        body.push('        break');
        body.push('else:');
        body.push('    result["build"]["warnings"].append("this build\'s EEVEE exposes no sample count; using its default")');
        /* WITHOUT THIS, METAL AND GLASS RENDER BLACK.
           EEVEE is a rasteriser: reflection and refraction come from the
           ray-tracing module, and it is OFF by default. A metallic surface has
           no diffuse response, so with it off the gold cube in the coverage
           scene of 3 Aug 2026 came out near-black and the glass sphere came
           out a dark blob — both look like a lighting bug and neither is one.
           Property verified as scene.eevee.use_raytracing in
           makesrna/intern/rna_scene.cc; guarded because it is version-specific
           and its absence must not take the render down with it. */
        body.push('for attr, value in (("use_raytracing", True), ("use_shadows", True)):');
        body.push('    if hasattr(scene.eevee, attr):');
        body.push('        setattr(scene.eevee, attr, value)');
        body.push('    else:');
        body.push('        result["build"]["warnings"].append("EEVEE has no %s in this build; reflections may be missing" % attr)');
        body.push('device_detail = "EEVEE rasterises on the GPU via the viewport backend"');
    }
    body.push('');

    /* ---------------- framing ---------------- */
    if (spec.camera.auto_frame) {
        body.push('result["stage"] = "framing"');
        body.push('# Keep the model\'s chosen DIRECTION; replace its distance.');
        body.push('# A language model has no sense of the metric scale of a scene it');
        body.push('# invented, and distance is arithmetic, so it is computed here from');
        body.push('# the measured bounds instead.');
        body.push('import math as _math');
        body.push('aspect = (scene.render.resolution_x or 1) / (scene.render.resolution_y or 1)');
        body.push('fov_x = cam.data.angle_x');
        body.push('fov_y = 2.0 * _math.atan(_math.tan(fov_x / 2.0) / aspect) if aspect else fov_x');
        body.push('');
        body.push('direction = cam.location - center');
        body.push('if direction.length < 1e-6:');
        body.push('    direction = mathutils.Vector((1.0, -1.0, 0.6))');
        body.push('direction.normalize()');
        body.push('');
        /* A bounding SPHERE is the obvious fit and it is wrong for anything
           that is not roughly cubic. Measured 3 Aug 2026: a 12 x 5 x 1 layout
           has a bounding-sphere radius of 6.5, so sphere-fitting pushed the
           camera back far enough to contain a 13-unit ball and the content —
           a thin horizontal band — came out a speck in the middle of the
           frame. Fitting the eight BOX corners in the camera's own axes uses
           the aspect ratio properly and is tight in both directions. */
        body.push('forward = -direction                      # camera looks toward the subject');
        body.push('world_up = mathutils.Vector((0.0, 0.0, 1.0))');
        body.push('if abs(forward.dot(world_up)) > 0.999:    # looking straight down: any up will do');
        body.push('    world_up = mathutils.Vector((0.0, 1.0, 0.0))');
        body.push('right = forward.cross(world_up).normalized()');
        body.push('up = right.cross(forward).normalized()');
        body.push('');
        body.push('tan_x = _math.tan(fov_x / 2.0)');
        body.push('tan_y = _math.tan(fov_y / 2.0)');
        body.push('distance = 0.0');
        body.push('if lo is not None:');
        body.push('    for cx in (lo.x, hi.x):');
        body.push('        for cy in (lo.y, hi.y):');
        body.push('            for cz in (lo.z, hi.z):');
        body.push('                v = mathutils.Vector((cx, cy, cz)) - center');
        body.push('                # depth of this corner in front of the camera is (distance + d_along)');
        body.push('                d_along = v.dot(forward)');
        body.push('                distance = max(distance, abs(v.dot(right)) / tan_x - d_along)');
        body.push('                distance = max(distance, abs(v.dot(up)) / tan_y - d_along)');
        body.push('else:');
        body.push('    distance = radius / _math.sin(min(fov_x, fov_y) / 2.0)');
        body.push(`distance = max(distance, 1e-4) * ${pyNum(FRAMING_MARGIN)}`);
        body.push('');
        body.push('cam.location = center + direction * distance');
        body.push('aim(cam, center)');
        body.push('result["build"]["framing"] = {"radius": round(radius, 3), "distance": round(distance, 3)}');
        body.push('');
    }

    /* ---------------- printability ---------------- */
    if (wantsPrintCheck) {
        body.push('result["stage"] = "analyze"');
        /* ---- design review helpers, emitted once ----

           These answer the questions a slicer would answer too late: not "did
           it slice" but "will this print badly, and where". Each is measured
           from the evaluated geometry rather than guessed from the spec. */
        body.push('def _overhang_and_support(bm, up):');
        body.push('    """Fraction of surface that needs support.');
        body.push('    A face overhangs when its normal points downward past the');
        body.push('    printable angle. 45 degrees is the FDM convention: at');
        body.push('    shallower angles each layer is more than half supported by');
        body.push('    the one below and bridges itself. Weighted by AREA, not by');
        body.push('    face count, because one large overhang matters more than');
        body.push('    twenty slivers."""');
        body.push('    total = 0.0');
        body.push('    over = 0.0');
        body.push('    steepest = 0.0');
        body.push('    for f in bm.faces:');
        body.push('        a = f.calc_area()');
        body.push('        total += a');
        body.push('        d = f.normal.dot(up)');
        body.push('        if d < -0.7071:            # normal more than 45 deg below horizontal');
        body.push('            over += a');
        body.push('            steepest = max(steepest, -d)');
        body.push('    return (over / total if total else 0.0), _math_degrees_from_dot(steepest)');
        body.push('');
        body.push('def _math_degrees_from_dot(d):');
        body.push('    import math');
        body.push('    d = max(-1.0, min(1.0, d))');
        body.push('    return round(math.degrees(math.asin(d)), 1) if d > 0 else 0.0');
        body.push('');
        body.push('def _centre_of_mass(bm):');
        body.push('    """Volume centroid, by the divergence theorem over the');
        body.push('    triangulated surface. Not the average of the vertices —');
        body.push('    that is the centroid of the POINTS and is wrong for any');
        body.push('    mesh whose detail is unevenly distributed, which is every');
        body.push('    real mesh. Needed to answer "will it tip over"."""');
        body.push('    total_v = 0.0');
        body.push('    cx = cy = cz = 0.0');
        body.push('    for f in bm.faces:');
        body.push('        vs = f.verts');
        body.push('        if len(vs) < 3:');
        body.push('            continue');
        body.push('        a = vs[0].co');
        body.push('        for i in range(1, len(vs) - 1):');
        body.push('            b, c = vs[i].co, vs[i + 1].co');
        body.push('            v = a.dot(b.cross(c)) / 6.0        # signed tetra volume to origin');
        body.push('            total_v += v');
        body.push('            cx += v * (a.x + b.x + c.x) / 4.0');
        body.push('            cy += v * (a.y + b.y + c.y) / 4.0');
        body.push('            cz += v * (a.z + b.z + c.z) / 4.0');
        body.push('    if abs(total_v) < 1e-12:');
        body.push('        return None');
        body.push('    return [cx / total_v, cy / total_v, cz / total_v]');
        body.push('');
        body.push('def _thin_walls(bm, limit):');
        body.push('    """Where is the part thinner than the nozzle can print?');
        body.push('    Measured by shooting a ray INWARD from each face centre and');
        body.push('    seeing how far it travels before leaving the solid. A wall');
        body.push('    below roughly two extrusion widths will not survive the');
        body.push('    slicer — it is dropped or printed as a single fragile');
        body.push('    bead — and this is the failure that is invisible until the');
        body.push('    print is off the bed.');
        body.push('    Sampled, not exhaustive: a full check is O(faces) ray casts');
        body.push('    and this runs on every build."""');
        body.push('    from mathutils.bvhtree import BVHTree');
        body.push('    tree = BVHTree.FromBMesh(bm)');
        body.push('    faces = list(bm.faces)');
        body.push('    if not faces:');
        body.push('        return {"checked": 0, "thin": 0, "min": None}');
        /* THE EPSILON MUST SCALE WITH THE MESH.
           A fixed 1e-5 offset is meaningless on a 2-metre sphere: the ray
           starts effectively ON the surface and immediately grazes an adjacent
           near-coplanar face, returning a distance of ~0. Measured 4 Aug 2026,
           that reported a solid ball as having 0mm walls and advised printing
           it 238 metres across. The offset and the rejection threshold are both
           taken from the model's own size. */
        body.push('    lo = mathutils.Vector((min(v.co.x for v in bm.verts), min(v.co.y for v in bm.verts), min(v.co.z for v in bm.verts)))');
        body.push('    hi = mathutils.Vector((max(v.co.x for v in bm.verts), max(v.co.y for v in bm.verts), max(v.co.z for v in bm.verts)))');
        body.push('    eps = max((hi - lo).length * 1e-4, 1e-7)');
        body.push('    step = max(1, len(faces) // 400)      # cap the cost at ~400 rays');
        body.push('    thin = 0');
        body.push('    checked = 0');
        body.push('    thinnest = None');
        body.push('    for f in faces[::step]:');
        body.push('        origin = f.calc_center_median() - f.normal * eps');
        body.push('        hit = tree.ray_cast(origin, -f.normal)');
        body.push('        if hit[0] is None:');
        body.push('            continue');
        body.push('        d = hit[3] + eps');
        /* A hit at the epsilon distance is the originating face seen again, not
           a wall. Discarding it is the difference between measuring thickness
           and measuring floating-point noise. */
        body.push('        if d <= eps * 3.0:');
        body.push('            continue');
        body.push('        checked += 1');
        body.push('        if thinnest is None or d < thinnest:');
        body.push('            thinnest = d');
        body.push('        if d < limit:');
        body.push('            thin += 1');
        body.push('    return {"checked": checked, "thin": thin,');
        body.push('            "min": (thinnest * 1000.0) if thinnest is not None else None}');
        body.push('');
        /* Reported, never repaired. An automatic fix that changes geometry
           without saying so is how a part comes out the wrong size. Run on the
           EVALUATED mesh, because that is what the exporter writes — checking
           the base mesh would pass a shape whose booleans have not resolved. */
        body.push('depsgraph = bpy.context.evaluated_depsgraph_get()');
        body.push('printability = {"watertight": True, "meshes": []}');
        body.push('for obj in bpy.context.scene.objects:');
        body.push('    if obj.type != "MESH" or obj.hide_render:');
        body.push('        continue');
        body.push('    evaluated = obj.evaluated_get(depsgraph)');
        body.push('    try:');
        body.push('        mesh = evaluated.to_mesh()');
        body.push('    except RuntimeError as exc:');
        body.push('        printability["meshes"].append({"name": obj.name, "error": str(exc)})');
        body.push('        printability["watertight"] = False');
        body.push('        continue');
        body.push('    bm = bmesh.new()');
        body.push('    bm.from_mesh(mesh)');
        /* ---- REPAIR, before measuring ----

           Order matters and this is the order slicers themselves use:

             1. weld duplicates — two coincident vertices leave a crack that
                reads as non-manifold but is really a seam;
             2. delete loose geometry — verts and edges with no face export
                fine and slice to nothing;
             3. fill remaining holes — real gaps, once the seams are gone;
             4. recalculate normals — an inconsistently wound surface makes
                the slicer fill the wrong side.

           Filling first would seal the seams as tiny faces instead of welding
           them, leaving the crack. Recalculating first would be undone by the
           fill. Each step reports what it changed: geometry altered without
           saying so is how a part comes out the wrong size, and this project
           does not do that quietly. */
        body.push('    repairs = {}');
        body.push('    if REPAIR:');
        body.push('        v0, e0, f0 = len(bm.verts), len(bm.edges), len(bm.faces)');
        body.push('        nm0 = sum(1 for e in bm.edges if not e.is_manifold)');
        body.push('        bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=1e-5)');
        body.push('        loose = [v for v in bm.verts if not v.link_edges] + [e for e in bm.edges if not e.link_faces]');
        body.push('        if loose:');
        body.push('            bmesh.ops.delete(bm, geom=loose, context="VERTS")');
        body.push('        open_edges = [e for e in bm.edges if len(e.link_faces) == 1]');
        body.push('        if open_edges:');
        body.push('            try:');
        body.push('                bmesh.ops.holes_fill(bm, edges=open_edges, sides=0)');
        body.push('            except (RuntimeError, TypeError) as exc:');
        body.push('                result["build"]["warnings"].append("%s: hole filling failed (%s)" % (obj.name, exc))');
        body.push('        bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))');
        body.push('        nm1 = sum(1 for e in bm.edges if not e.is_manifold)');
        body.push('        repairs = {"welded_vertices": max(0, v0 - len(bm.verts)),');
        body.push('                   "removed_loose": len(loose),');
        body.push('                   "filled_holes": max(0, len(bm.faces) - f0 + max(0, v0 - len(bm.verts))),');
        body.push('                   "non_manifold_before": nm0, "non_manifold_after": nm1,');
        body.push('                   "repaired": nm0 > 0 and nm1 == 0}');
        body.push('        if repairs["welded_vertices"] or repairs["removed_loose"] or nm0 != nm1:');
        body.push('            bm.to_mesh(mesh)          # keep the repair for the exporters');
        body.push('            mesh.update()');
        body.push('    non_manifold = sum(1 for e in bm.edges if not e.is_manifold)');
        body.push('    loose_edges = sum(1 for e in bm.edges if len(e.link_faces) == 0)');
        body.push('    loose_verts = sum(1 for v in bm.verts if len(v.link_edges) == 0)');
        /* VOLUME AND AREA IN WORLD UNITS.
           bm.calc_volume() works in the mesh's LOCAL space, so an object scaled
           to a third renders at a third the size and reports 27x the volume it
           will actually print at. Transforming the bmesh by matrix_world first
           is what makes the manufacturing estimate describe the real object.

           calc_volume(signed=False) because an inverted normal on one face
           would otherwise subtract that region and quietly under-report. */
        body.push('    bm.transform(obj.matrix_world)');
        body.push('    volume = bm.calc_volume(signed=False) if non_manifold == 0 else 0.0');
        body.push('    area = sum(f.calc_area() for f in bm.faces)');
        body.push('    dims = [obj.dimensions.x, obj.dimensions.y, obj.dimensions.z]');
        body.push('    entry = {"name": obj.name, "vertices": len(bm.verts), "faces": len(bm.faces),');
        body.push('             "non_manifold_edges": non_manifold, "loose_edges": loose_edges,');
        body.push('             "loose_vertices": loose_verts,');
        /* Blender units are metres by default; the manufacturing layer works in
           millimetres, and converting here keeps a unit mix-up out of the JS. */
        body.push('             "volume_mm3": volume * 1.0e9, "area_mm2": area * 1.0e6,');
        body.push('             "dimensions_mm": [d * 1000.0 for d in dims],');
        body.push('             "printable": non_manifold == 0 and loose_edges == 0 and loose_verts == 0}');
        body.push('    if repairs:');
        body.push('        entry["repairs"] = repairs');
        /* The design review. Runs on the same transformed bmesh, so every
           measurement is in world space and consistent with the volume. */
        body.push('    up = mathutils.Vector((0.0, 0.0, 1.0))');
        body.push('    overhang_fraction, steepest = _overhang_and_support(bm, up)');
        body.push('    entry["overhang_fraction"] = round(overhang_fraction, 4)');
        body.push('    entry["steepest_overhang_deg"] = steepest');
        body.push('    com = _centre_of_mass(bm)');
        body.push('    if com is not None:');
        body.push('        entry["centre_of_mass_mm"] = [c * 1000.0 for c in com]');
        /* Support needs a bed to sit on, and the bottom face never does — a
           downward normal resting ON the plate is not an overhang. Subtracting
           the footprint keeps a flat-bottomed part from reading as 50% support. */
        body.push('        lo_z = min((v.co.z for v in bm.verts), default=0.0)');
        body.push('        footprint = sum(f.calc_area() for f in bm.faces');
        body.push('                        if f.normal.dot(up) < -0.9 and abs(f.calc_center_median().z - lo_z) < 1e-4)');
        body.push('        total_area = sum(f.calc_area() for f in bm.faces) or 1.0');
        body.push('        entry["support_fraction"] = round(max(0.0, overhang_fraction - footprint / total_area), 4)');
        body.push(`    entry["thin_walls"] = _thin_walls(bm, ${pyNum(0.0008)})   # 0.8 mm, two 0.4 extrusions`);
        body.push('    bm.free()');
        body.push('    evaluated.to_mesh_clear()');
        body.push('    if not entry["printable"]:');
        body.push('        printability["watertight"] = False');
        body.push('    printability["meshes"].append(entry)');
        body.push('result["printability"] = printability');
        body.push('');
    }

    /* ---------------- render ---------------- */
    const imagePath = `${io.outdir}${io.outdir.endsWith('\\') || io.outdir.endsWith('/') ? '' : (io.outdir.includes('\\') ? '\\' : '/')}${imageName}`;
    body.push('result["stage"] = "render"');
    body.push(`image_path = ${pyStr(imagePath)}`);
    body.push('scene.render.filepath = image_path');
    body.push('bpy.ops.render.render(write_still=True)');
    /* Trust the filesystem, not the operator: bpy.ops returns {'FINISHED'} for
       renders that wrote nothing. */
    body.push('if not os.path.exists(image_path):');
    body.push('    raise RuntimeError("the render reported success but wrote no file")');
    body.push('result["image"] = image_path');
    body.push('result["build"]["objects"] = [n for n, o in objects.items()]');
    body.push('result["build"]["polygons"] = sum(len(o.data.polygons) for o in objects.values() if o.type == "MESH")');
    body.push('result["build"]["engine"] = scene.render.engine');
    body.push('result["build"]["device"] = device_detail');
    body.push('');

    /* ---------------- exports ---------------- */
    if ((spec.exports || []).length) {
        body.push('result["stage"] = "export"');
        body.push('exported = []');
        for (const e of spec.exports) {
            const sep = io.outdir.includes('\\') ? '\\' : '/';
            const target = `${io.outdir}${io.outdir.endsWith(sep) ? '' : sep}${e.filename}`;
            body.push(`path = ${pyStr(target)}`);
            /* Operator names verified against bl_ui/space_topbar.py:412-416.
               The legacy Python exporters (export_mesh.stl) do not exist in 5.x. */
            if (e.format === 'stl') body.push('bpy.ops.wm.stl_export(filepath=path, export_selected_objects=False, apply_modifiers=True, ascii_format=False)');
            else if (e.format === 'obj') body.push('bpy.ops.wm.obj_export(filepath=path, apply_modifiers=True)');
            else if (e.format === 'ply') body.push('bpy.ops.wm.ply_export(filepath=path, apply_modifiers=True)');
            else if (e.format === 'glb') body.push('bpy.ops.export_scene.gltf(filepath=path, export_format="GLB")');
            else if (e.format === 'blend') body.push('bpy.ops.wm.save_as_mainfile(filepath=path)');
            else throw new TypeError(`no emitter for export format ${e.format}`);
            body.push(`exported.append({"format": ${pyStr(e.format)}, "path": path,`);
            body.push('                 "bytes": os.path.getsize(path) if os.path.exists(path) else 0,');
            body.push('                 "written": os.path.exists(path)})');
        }
        body.push('result["exports"] = exported');
        body.push('');
    }

    body.push('result["stage"] = "done"');
    body.push('result["ok"] = True');

    for (const line of body) L.push(line ? `    ${line}` : '');

    /* ---------------- epilogue ---------------- */
    L.push('except Exception as exc:');
    L.push('    result["ok"] = False');
    L.push('    result["error"] = "%s: %s" % (type(exc).__name__, exc)');
    L.push('    result["traceback"] = traceback.format_exc()');
    L.push('');
    L.push('result["seconds"] = round(time.time() - started, 2)');
    L.push('');
    /* THE RESULT FILE IS THE CONTRACT. Blender exits 0 after printing a Python
       traceback in many failure modes, and its stdout is mixed with progress
       output, so a caller that trusts the exit code reports success for a
       render that never happened. The absence of this file is the error. */
    L.push('try:');
    L.push('    with open(RESULT_PATH, "w", encoding="utf-8") as handle:');
    L.push('        json.dump(result, handle, indent=2)');
    L.push('except OSError as exc:');
    L.push('    print("JARVIS_FOUNDRY_RESULT_WRITE_FAILED %s" % exc, file=sys.stderr)');
    L.push('');
    L.push('print("JARVIS_FOUNDRY_RESULT_BEGIN")');
    L.push('print(json.dumps(result))');
    L.push('print("JARVIS_FOUNDRY_RESULT_END")');
    L.push('sys.stdout.flush()');
    L.push('sys.exit(0 if result["ok"] else 1)');

    return L.join('\n') + '\n';
}

export default { emitScript, pyNum, pyInt, pyStr, pyBool, LIGHT_PRESETS, FRAMING_MARGIN };
