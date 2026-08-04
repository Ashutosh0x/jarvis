// What changed between two builds.
//
// PURE. Two specs in, a structured diff out.
//
// ---------------------------------------------------------------------------
// A DIFF IS POSSIBLE HERE ONLY BECAUSE THE SPEC IS THE SOURCE OF TRUTH
//
// Diffing two meshes is a hard and mostly useless problem: the answer comes out
// as "+12,431 vertices, -8,902 vertices", which tells you nothing about what
// was actually done. Every text-to-3D tool that emits a bare mesh is stuck with
// that, because the mesh is all it has.
//
// Foundry keeps the RECIPE — spec.json — and generates the mesh from it. So the
// question "what changed" has an exact answer at the level a person thinks in:
// the bevel went from 0.02 to 0.05, a boolean was added, the material stopped
// being metallic. That is a property of the architecture rather than a clever
// algorithm, and it is worth stating because it is the reason this file is
// forty lines of comparison rather than a mesh-correspondence solver.
//
// WHY IT MATTERS BEYOND CURIOSITY: it is the receipt for an AI edit. When
// "make it taller" goes through a language model that rewrites the whole spec,
// the diff is what proves it changed the height and did not also quietly swap
// the material, drop a modifier, or halve the sample count. Trust in an
// automated edit comes from being able to see exactly what it did.
// ---------------------------------------------------------------------------

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Human-readable value, short enough to sit in a sentence. */
function show(v) {
    if (v === null || v === undefined) return 'none';
    if (Array.isArray(v)) return `[${v.map((x) => (typeof x === 'number' ? round(x) : show(x))).join(', ')}]`;
    if (typeof v === 'number') return String(round(v));
    if (typeof v === 'boolean') return v ? 'yes' : 'no';
    if (isObject(v)) return '{…}';
    return String(v);
}

function round(n) { return Math.round(n * 1e4) / 1e4; }

/** Deep equality, adequate for spec values: numbers, strings, booleans, arrays, plain objects. */
function same(a, b) {
    if (a === b) return true;
    if (typeof a === 'number' && typeof b === 'number') return round(a) === round(b);
    if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => same(v, b[i]));
    if (isObject(a) && isObject(b)) {
        const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
        return [...keys].every((k) => same(a[k], b[k]));
    }
    return false;
}

/** Compare two flat-ish records, returning field-level changes. */
function fieldChanges(before, after, prefix = '') {
    const out = [];
    const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
    for (const key of keys) {
        const a = (before || {})[key];
        const b = (after || {})[key];
        if (same(a, b)) continue;
        if (isObject(a) && isObject(b)) { out.push(...fieldChanges(a, b, `${prefix}${key}.`)); continue; }
        out.push({
            path: `${prefix}${key}`,
            before: a, after: b,
            kind: a === undefined ? 'added' : b === undefined ? 'removed' : 'changed',
            text: a === undefined ? `${prefix}${key} set to ${show(b)}`
                : b === undefined ? `${prefix}${key} removed (was ${show(a)})`
                    : `${prefix}${key}: ${show(a)} → ${show(b)}`
        });
    }
    return out;
}

/**
 * Diff two validated specs.
 *
 * Objects are matched BY NAME rather than by position, because an edit that
 * inserts an object at the front would otherwise report every later object as
 * changed — a diff that is technically correct and completely unreadable.
 *
 * @returns {{changed:boolean, summary:string[], objects:object[], scene:object[], counts:object}}
 */
export function diffSpecs(before, after) {
    if (!before || !after) return { changed: true, summary: ['no previous build to compare against'], objects: [], scene: [], counts: {} };

    const beforeByName = new Map((before.objects || []).map((o) => [o.name, o]));
    const afterByName = new Map((after.objects || []).map((o) => [o.name, o]));

    const objects = [];
    const summary = [];

    for (const [name, obj] of afterByName) {
        if (!beforeByName.has(name)) {
            objects.push({ name, kind: 'added', changes: [], text: `added ${obj.import ? 'imported mesh' : obj.primitive} "${name}"` });
            summary.push(`added ${obj.import ? 'imported mesh' : obj.primitive} "${name}"`);
        }
    }
    for (const [name, obj] of beforeByName) {
        if (!afterByName.has(name)) {
            objects.push({ name, kind: 'removed', changes: [], text: `removed "${name}"` });
            summary.push(`removed "${name}"`);
        }
    }

    for (const [name, a] of beforeByName) {
        const b = afterByName.get(name);
        if (!b) continue;

        const changes = [];

        /* Transform, params and material compare field by field. */
        for (const section of ['params', 'material', 'import']) {
            changes.push(...fieldChanges(a[section] || {}, b[section] || {}, `${section}.`));
        }
        for (const key of ['location', 'rotation', 'scale', 'primitive']) {
            if (!same(a[key], b[key])) {
                changes.push({
                    path: key, before: a[key], after: b[key], kind: 'changed',
                    text: `${key}: ${show(a[key])} → ${show(b[key])}`
                });
            }
        }

        /* Modifiers are a LIST and order matters — a bevel before a boolean
           is not the same shape as a bevel after one. Matched by (type, index
           within that type) so a changed width reads as a change rather than a
           removal plus an addition. */
        const key = (m, i, list) => `${m.type}#${list.slice(0, i).filter((x) => x.type === m.type).length}`;
        const aMods = new Map((a.modifiers || []).map((m, i, l) => [key(m, i, l), m]));
        const bMods = new Map((b.modifiers || []).map((m, i, l) => [key(m, i, l), m]));

        for (const [k, m] of bMods) {
            if (!aMods.has(k)) changes.push({ path: `modifiers.${k}`, kind: 'added', after: m, text: `added ${m.type} modifier` });
        }
        for (const [k, m] of aMods) {
            if (!bMods.has(k)) changes.push({ path: `modifiers.${k}`, kind: 'removed', before: m, text: `removed ${m.type} modifier` });
            else changes.push(...fieldChanges(m, bMods.get(k), `${m.type}.`).filter((c) => c.path !== `${m.type}.type`));
        }

        if (changes.length) {
            objects.push({ name, kind: 'changed', changes, text: `${name}: ${changes.map((c) => c.text).join('; ')}` });
            summary.push(`${name} — ${changes.map((c) => c.text).join(', ')}`);
        }
    }

    /* Scene-level settings: render, camera, lighting, world. */
    const scene = [];
    for (const section of ['render', 'camera', 'world', 'lighting']) {
        scene.push(...fieldChanges(before[section] || {}, after[section] || {}, `${section}.`));
    }
    for (const c of scene) summary.push(c.text);

    return {
        changed: objects.length > 0 || scene.length > 0,
        summary,
        objects,
        scene,
        counts: {
            objectsBefore: beforeByName.size,
            objectsAfter: afterByName.size,
            added: objects.filter((o) => o.kind === 'added').length,
            removed: objects.filter((o) => o.kind === 'removed').length,
            modified: objects.filter((o) => o.kind === 'changed').length,
            sceneChanges: scene.length
        }
    };
}

/**
 * One sentence, for speaking aloud.
 *
 * Caps at three changes and counts the rest: a spoken list of eleven parameter
 * changes is not something anyone follows, and the full diff is on screen.
 */
export function describeDiff(diff) {
    if (!diff?.changed) return 'nothing changed';
    const parts = diff.summary.slice(0, 3);
    const extra = diff.summary.length - parts.length;
    return parts.join('; ') + (extra > 0 ? `, and ${extra} more change${extra === 1 ? '' : 's'}` : '');
}

export default { diffSpecs, describeDiff };
