// What it costs to actually print the thing.
//
// PURE. Takes a measured volume and returns time, mass and money. No Blender,
// no slicer, no network.
//
// ---------------------------------------------------------------------------
// AN ESTIMATE THAT SAYS IT IS AN ESTIMATE
//
// A slicer is the authority here: it knows the toolpath, the acceleration
// limits, the travel moves and the seam placement, and this does not. What this
// does is answer the question a slicer cannot answer in time to be useful —
// "is the thing I just designed a 40-minute print or a 14-hour one?" — while
// the design is still a spec that can be changed.
//
// So every number returned carries its assumptions, and `confidence` is part of
// the result rather than a footnote. Against a real slicer these run roughly
// 10-25% optimistic, because travel moves, retractions and acceleration ramps
// are not modelled. That direction is deliberate: a print that takes longer
// than predicted is an annoyance, and one that silently needs more filament
// than you have is a failed print at hour nine.
//
// The volume comes from Blender, measured on the evaluated mesh with
// bmesh.calc_volume() — the real solid volume after modifiers, not a bounding
// box. That is the one input this cannot approximate, and it is why the
// measurement happens where the geometry lives.
// ---------------------------------------------------------------------------

/**
 * Filament properties.
 *
 * Densities are physical constants and are quoted from material data sheets;
 * they do not vary by vendor in any way that matters at this precision. Prices
 * DO vary — by vendor, region and week — so they are a default that the caller
 * is expected to override, not a fact. `price` is USD per kilogram.
 */
export const FILAMENTS = Object.freeze({
    PLA: { density: 1.24, price: 22, nozzle: 210, bed: 60, note: 'stiff, brittle, no heated chamber needed' },
    PETG: { density: 1.27, price: 26, nozzle: 240, bed: 80, note: 'tougher than PLA, mild flex, food-safe grades exist' },
    ABS: { density: 1.04, price: 24, nozzle: 250, bed: 100, note: 'needs an enclosure; warps in open air' },
    ASA: { density: 1.07, price: 32, nozzle: 255, bed: 100, note: 'ABS that survives UV; outdoor parts' },
    TPU: { density: 1.21, price: 38, nozzle: 225, bed: 50, note: 'flexible; slow to print, no bowden' },
    NYLON: { density: 1.14, price: 45, nozzle: 260, bed: 90, note: 'tough and hygroscopic; must be dried' }
});

/**
 * Printer profile.
 *
 * `flowRate` is the number that decides print time, and it is the one most
 * often quoted wrongly. It is not the printer's headline speed: a machine
 * advertised at 500 mm/s is limited by how fast the hotend can MELT plastic.
 * Volumetric flow = speed x layer height x extrusion width, and real FDM
 * machines land between 5 and 25 mm^3/s. A stock 0.4 mm nozzle on a
 * well-tuned modern printer is ~12 mm^3/s; high-flow hotends reach 25+.
 */
export const PRINTERS = Object.freeze({
    generic: { name: 'Generic FDM 0.4mm', flowRate: 12, setupMinutes: 4, nozzle: 0.4 },
    prusa_core_one: { name: 'Prusa Core One', flowRate: 15, setupMinutes: 5, nozzle: 0.4 },
    bambu_x2d: { name: 'Bambu Lab X2D', flowRate: 22, setupMinutes: 3, nozzle: 0.4 },
    high_flow: { name: 'High-flow hotend 0.6mm', flowRate: 28, setupMinutes: 4, nozzle: 0.6 }
});

/** Filament is sold by diameter; volume per millimetre of strand follows from it. */
const FILAMENT_DIAMETER_MM = 1.75;

/**
 * How big the printed object is, longest edge, in millimetres.
 *
 * A default rather than a convention: scenes are modelled at whatever scale
 * suits the render, and 100 mm is a desk-sized object that fits every printer
 * in the table above. It is reported in `assumptions` on every estimate, so it
 * is a stated choice the caller can override, never a silent one.
 */
export const DEFAULT_PRINT_LONGEST_MM = 100;

/**
 * How much plastic a part actually contains.
 *
 * An FDM part is not solid. It is a shell of solid walls plus a sparse lattice
 * inside, so the printed volume is far below the solid volume for anything
 * chunky — and ABOVE the naive `solid x infill` for anything thin, because the
 * walls alone already fill it.
 *
 * Modelled as: the shell is a skin of `wallThickness` over the surface, and the
 * remaining interior is filled at `infill`. Surface area is required for that,
 * and it is measured in Blender alongside the volume.
 *
 * Clamped at the solid volume, since a part cannot contain more plastic than
 * its own volume — which is exactly what happens on thin geometry when the
 * shell estimate exceeds it.
 */
export function printedVolumeMm3({ volumeMm3, surfaceAreaMm2, wallThicknessMm = 1.2, infill = 0.2 }) {
    if (!(volumeMm3 > 0)) return 0;
    const shell = Math.min(surfaceAreaMm2 > 0 ? surfaceAreaMm2 * wallThicknessMm : volumeMm3 * 0.35, volumeMm3);
    const interior = Math.max(volumeMm3 - shell, 0);
    return Math.min(shell + interior * infill, volumeMm3);
}

/**
 * Estimate a print.
 *
 * @param {object} opts
 * @param {number} opts.volumeMm3        solid volume, measured in Blender
 * @param {number} opts.surfaceAreaMm2   measured in Blender
 * @param {[number,number,number]} opts.dimensionsMm  bounding box, for fit checks
 * @returns {object} estimate with its assumptions attached
 */
export function estimatePrint({
    volumeMm3,
    surfaceAreaMm2 = 0,
    dimensionsMm = null,
    filament = 'PLA',
    printer = 'generic',
    infill = 0.2,
    wallThicknessMm = 1.2,
    supportFraction = 0,
    pricePerKg = null,
    printLongestMm = DEFAULT_PRINT_LONGEST_MM
} = {}) {
    const mat = FILAMENTS[filament] || FILAMENTS.PLA;
    const machine = PRINTERS[printer] || PRINTERS.generic;

    if (!(volumeMm3 > 0)) {
        return { ok: false, reason: 'the mesh has no measurable volume — it is probably not a closed solid' };
    }

    /* SCALE TO PRINT SIZE FIRST, and this is not a detail.

       Blender's default unit is the METRE, so a "size 2" cube is two metres
       across. Measured on the bracket test of 3 Aug 2026: 385,813,801 mm^3 —
       386 litres, about 480 kg of PLA and a fourteen-month print. Every number
       downstream was arithmetically correct and physically absurd.

       The fix is not to guess a unit convention. A scene is modelled at
       whatever scale suits the render, and the print size is a SEPARATE
       decision the user makes in the terms they actually use: "print it 80mm
       tall". Volume scales with the cube of the linear factor and area with
       the square, which is why costing an unscaled model is wrong by ~10^9
       rather than by a bit. */
    let scale = 1;
    if (printLongestMm && Array.isArray(dimensionsMm) && dimensionsMm.length === 3) {
        const longest = Math.max(...dimensionsMm);
        if (longest > 0) scale = printLongestMm / longest;
    }
    if (scale !== 1) {
        volumeMm3 *= scale ** 3;
        surfaceAreaMm2 *= scale ** 2;
        dimensionsMm = dimensionsMm.map((d) => d * scale);
    }

    const partMm3 = printedVolumeMm3({ volumeMm3, surfaceAreaMm2, wallThicknessMm, infill });
    const supportMm3 = partMm3 * Math.max(0, supportFraction);
    const totalMm3 = partMm3 + supportMm3;

    const cm3 = totalMm3 / 1000;
    const grams = cm3 * mat.density;
    const kg = grams / 1000;
    const cost = kg * (pricePerKg ?? mat.price);

    /* Length of 1.75 mm strand consumed — the number you check against what is
       left on the spool, which is what actually stops a print at 3 a.m. */
    const strandAreaMm2 = Math.PI * (FILAMENT_DIAMETER_MM / 2) ** 2;
    const filamentMetres = totalMm3 / strandAreaMm2 / 1000;

    const seconds = totalMm3 / machine.flowRate + machine.setupMinutes * 60;

    return {
        ok: true,
        filament, printer: machine.name,
        solidVolumeCm3: round(volumeMm3 / 1000, 2),
        printedVolumeCm3: round(cm3, 2),
        /* The fraction of the solid the print actually contains. A useful sanity
           check on its own: 100% means the walls swallowed the whole part, so
           infill is doing nothing and the part is effectively solid. */
        density: round(totalMm3 / volumeMm3, 3),
        grams: round(grams, 1),
        filamentMetres: round(filamentMetres, 1),
        cost: round(cost, 2),
        pricePerKg: pricePerKg ?? mat.price,
        hours: round(seconds / 3600, 2),
        duration: formatDuration(seconds),
        infill, wallThicknessMm, supportFraction,
        dimensionsMm: dimensionsMm ? dimensionsMm.map((d) => round(d, 1)) : null,
        nozzleC: mat.nozzle, bedC: mat.bed, note: mat.note,
        /* Named so it cannot be quoted as a slicer figure. */
        printLongestMm,
        modelScale: round(scale, 6),
        confidence: 'estimate: excludes travel moves, retraction and acceleration; typically 10-25% optimistic against a slicer',
        assumptions: `printed at ${printLongestMm}mm on its longest edge, ${Math.round(infill * 100)}% infill, ${wallThicknessMm}mm walls, ${machine.flowRate}mm3/s flow`
    };
}

/**
 * Will it fit on the bed?
 *
 * Checked in both orientations of the footprint, because rotating a part 90
 * degrees about Z is free and is the first thing anyone does.
 */
export function fitsOnBed(dimensionsMm, bed = [256, 256, 256]) {
    if (!Array.isArray(dimensionsMm) || dimensionsMm.length !== 3) return { fits: false, reason: 'no dimensions' };
    const [x, y, z] = dimensionsMm;
    const [bx, by, bz] = bed;
    if (z > bz) return { fits: false, reason: `${round(z, 1)}mm tall exceeds the ${bz}mm build height` };
    const upright = x <= bx && y <= by;
    const rotated = y <= bx && x <= by;
    if (upright || rotated) return { fits: true, rotated: !upright && rotated };
    return { fits: false, reason: `${round(x, 1)} x ${round(y, 1)}mm footprint does not fit a ${bx} x ${by}mm bed in either orientation` };
}

/**
 * Turn measurements into a verdict.
 *
 * ---------------------------------------------------------------------------
 * A REVIEW, NOT A SCORE OUT OF TEN
 *
 * Every finding names the measurement it came from and what to do about it,
 * because "printability: 94%" is a number nobody can act on or check. A single
 * blended score hides which of five things is wrong, and the one that matters
 * is usually not the one moving the average.
 *
 * Severities are chosen by what happens if ignored:
 *   fail  — the print will not come out: it cannot slice, or a wall will be
 *           dropped, or it does not fit the machine.
 *   warn  — it will print, and worse than it should: supports everywhere, a
 *           part that topples, a fourteen-hour job that could be four.
 *   note  — worth knowing, no action required.
 * ---------------------------------------------------------------------------
 */
export function reviewPart(mesh, estimate, { bed = [256, 256, 256], nozzleMm = 0.4 } = {}) {
    const findings = [];
    const add = (severity, title, detail, fix = null) => findings.push({ severity, title, detail, fix });

    if (!mesh.printable) {
        const bits = [];
        if (mesh.non_manifold_edges) bits.push(`${mesh.non_manifold_edges} non-manifold edges`);
        if (mesh.loose_edges) bits.push(`${mesh.loose_edges} loose edges`);
        if (mesh.loose_vertices) bits.push(`${mesh.loose_vertices} loose vertices`);
        add('fail', 'Not watertight', bits.join(', ') || 'the surface is not closed',
            'a slicer cannot tell inside from outside; rebuild with repair enabled or add a voxel remesh');
    } else if (mesh.repairs?.repaired) {
        add('note', 'Repaired automatically',
            `${mesh.repairs.non_manifold_before} non-manifold edges were closed; ${mesh.repairs.welded_vertices} vertices welded, ${mesh.repairs.removed_loose} loose elements removed`,
            'the exported mesh differs from the raw build — this is the repaired geometry');
    } else if (mesh.repairs && (mesh.repairs.welded_vertices || mesh.repairs.removed_loose)) {
        add('note', 'Cleaned up',
            `${mesh.repairs.welded_vertices} duplicate vertices welded, ${mesh.repairs.removed_loose} loose elements removed`);
    }

    /* Thin walls: the failure that is invisible until the print is off the bed.
       Below two extrusion widths the slicer drops the wall or prints a single
       fragile bead. Measured by inward ray casts, then scaled to print size. */
    const tw = mesh.thin_walls;
    if (tw && tw.checked > 0 && tw.min !== null && estimate?.modelScale) {
        const minPrintedMm = tw.min * estimate.modelScale;
        const limit = nozzleMm * 2;
        /* A zero or negative measurement is a degenerate ray, not a zero-width
           wall. Reporting it produced "thinnest section 0mm — print it 238
           metres across", which is worse than saying nothing: it is confident
           and absurd, and it buries the real findings under it. */
        if (!(minPrintedMm > 1e-6)) {
            add('note', 'Wall thickness not measurable',
                'the inward ray casts did not return a usable distance on this geometry');
        } else if (minPrintedMm < limit) {
            const share = Math.round((tw.thin / tw.checked) * 100);
            add('fail', 'Wall thinner than the nozzle can print',
                `thinnest section is ${round(minPrintedMm, 2)}mm at this print size; ${share}% of sampled surface is under ${limit}mm`,
                `print it larger (about ${Math.ceil(estimate.printLongestMm * (limit / minPrintedMm))}mm on the longest edge), thicken the wall, or use a ${round(minPrintedMm / 2, 2)}mm nozzle`);
        } else if (minPrintedMm < limit * 1.5) {
            add('warn', 'Thin walls', `thinnest section ${round(minPrintedMm, 2)}mm — printable but fragile`);
        }
    }

    /* Support: material and time you pay for and then throw away, plus the
       surface finish damage where it was attached. */
    const support = mesh.support_fraction ?? mesh.overhang_fraction ?? 0;
    if (support > 0.35) {
        add('warn', 'Heavy support required',
            `${Math.round(support * 100)}% of the surface overhangs past 45°${mesh.steepest_overhang_deg ? `, steepest ${mesh.steepest_overhang_deg}°` : ''}`,
            're-orient the part, or split it and print the halves flat');
    } else if (support > 0.12) {
        add('note', 'Some support needed', `${Math.round(support * 100)}% overhanging surface`);
    } else if (support > 0) {
        add('note', 'Nearly support-free', `${Math.round(support * 100)}% overhanging surface`);
    }

    /* Tipping. The centre of mass relative to the footprint decides whether a
       tall part survives being knocked, and whether it survives its own print. */
    const com = mesh.centre_of_mass_mm;
    const dims = estimate?.dimensionsMm;
    if (com && dims && estimate?.modelScale) {
        const height = dims[2];
        const base = Math.min(dims[0], dims[1]);
        const comZ = com[2] * estimate.modelScale;
        if (base > 0 && height > 0) {
            const ratio = comZ / base;
            if (ratio > 1.5) {
                add('warn', 'Top-heavy',
                    `centre of mass sits ${round(comZ, 1)}mm up on a ${round(base, 1)}mm footprint`,
                    'add a brim, or print it lying down');
            }
        }
    }

    if (estimate?.ok) {
        const fit = fitsOnBed(estimate.dimensionsMm, bed);
        if (!fit.fits) add('fail', 'Does not fit the build plate', fit.reason, 'scale it down or split it into parts');
        else if (fit.rotated) add('note', 'Fits when rotated', 'rotate 90° on the plate');

        if (estimate.hours > 12) {
            add('warn', 'Long print', `${estimate.duration} — a power cut or a failed layer costs the whole job`,
                `drop the infill, or print it smaller`);
        }
        if (estimate.density > 0.9) {
            add('note', 'Effectively solid',
                `walls fill ${Math.round(estimate.density * 100)}% of the volume, so infill is doing nothing`,
                'thinner walls would cut filament and time');
        }
    }

    const worst = findings.some((f) => f.severity === 'fail') ? 'fail'
        : findings.some((f) => f.severity === 'warn') ? 'warn' : 'ok';

    return {
        verdict: worst,
        printable: worst !== 'fail',
        findings,
        /* Plain-language, for speaking. Counts rather than a score. */
        headline: worst === 'ok' ? 'ready to print'
            : worst === 'warn' ? `printable, with ${findings.filter((f) => f.severity === 'warn').length} thing${findings.filter((f) => f.severity === 'warn').length === 1 ? '' : 's'} worth fixing`
                : `not ready: ${findings.filter((f) => f.severity === 'fail').length} blocking issue${findings.filter((f) => f.severity === 'fail').length === 1 ? '' : 's'}`
    };
}

function round(n, dp) { const f = 10 ** dp; return Math.round(n * f) / f; }

function formatDuration(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.round((seconds % 3600) / 60);
    if (h === 0) return `${m} min`;
    return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

export default { estimatePrint, printedVolumeMm3, fitsOnBed, reviewPart, FILAMENTS, PRINTERS, DEFAULT_PRINT_LONGEST_MM };
