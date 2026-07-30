/**
 * PAIRED SIGNIFICANCE — is a config difference real, or is it five questions?
 *
 * The 22 Jul 2026 run reported rag 81.4% vs rag+beliefs 79.1% and a clean
 * category split: every loss in contradiction/stale, every gain in
 * answerable/absent. A clean pattern is exactly the shape that invites a
 * conclusion, so this file exists to say whether the pattern survives contact
 * with its own sample size.
 *
 * Both configs answer the SAME questions, so the runs are paired and the
 * unpaired comparison of two proportions is the wrong test — it throws away the
 * pairing and is less powerful. McNemar's test uses only the DISCORDANT pairs:
 * questions where exactly one config passed. Questions both configs got right,
 * or both got wrong, carry no information about which is better.
 *
 * EXACT, not chi-squared. The chi-square approximation to McNemar needs roughly
 * b+c >= 25 discordant pairs; this run has 5. At that count the approximation
 * reports a p-value that is simply wrong, so the two-sided exact binomial test
 * is used instead — no continuity correction, no asymptotics.
 *
 * The bootstrap CI resamples QUESTIONS, not answers, because the question is
 * the unit that was sampled. Resampling per-config answers independently would
 * destroy the pairing and produce an interval that is too wide.
 *
 * Run:
 *   node eval/paired-stats.mjs                          newest results file
 *   node eval/paired-stats.mjs --file <path.jsonl>
 *   node eval/paired-stats.mjs --a rag --b rag+beliefs
 *   node eval/paired-stats.mjs --selftest               verify the maths
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* --- exact statistics ---------------------------------------------------- */

/** log n! via lgamma, so C(n,k) does not overflow at large n. */
function lnFactorial(n) {
    // Lanczos-free: exact for the small n here, and log-summed for larger.
    let s = 0;
    for (let i = 2; i <= n; i++) s += Math.log(i);
    return s;
}

export function binomPmf(k, n, p = 0.5) {
    if (k < 0 || k > n) return 0;
    const lnC = lnFactorial(n) - lnFactorial(k) - lnFactorial(n - k);
    return Math.exp(lnC + k * Math.log(p) + (n - k) * Math.log(1 - p));
}

/**
 * Two-sided exact McNemar.
 *
 * @param {number} b  passed under A, failed under B
 * @param {number} c  failed under A, passed under B
 * @returns {{n: number, p: number, test: string}}
 *
 * Under the null the two configs are equally likely to win any discordant pair,
 * so the count follows Bin(b+c, 0.5). The two-sided p-value is the total
 * probability of every outcome AT LEAST as extreme as the one observed.
 */
export function mcnemarExact(b, c) {
    const n = b + c;
    if (n === 0) return { n: 0, p: 1, test: 'exact binomial (no discordant pairs)' };
    const observed = binomPmf(b, n, 0.5);
    // "At least as extreme" in probability, which handles the symmetric case
    // without the off-by-one that doubling the tail introduces at b === c.
    let p = 0;
    for (let k = 0; k <= n; k++) {
        const pk = binomPmf(k, n, 0.5);
        if (pk <= observed * (1 + 1e-9)) p += pk;
    }
    return { n, p: Math.min(1, p), test: 'two-sided exact binomial (McNemar)' };
}

/** Deterministic PRNG so a reported interval is reproducible. */
function mulberry32(seed) {
    return function rand() {
        seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Percentile bootstrap CI for the PAIRED accuracy difference (B − A).
 * Resamples questions with replacement, keeping each question's pair intact.
 */
export function bootstrapDiffCI(pairs, { iterations = 20000, seed = 42, alpha = 0.05 } = {}) {
    const n = pairs.length;
    if (!n) return { lo: 0, hi: 0, point: 0, n: 0 };
    const point = pairs.reduce((s, [a, b]) => s + ((b ? 1 : 0) - (a ? 1 : 0)), 0) / n;
    const rand = mulberry32(seed);
    const diffs = new Float64Array(iterations);
    for (let it = 0; it < iterations; it++) {
        let s = 0;
        for (let i = 0; i < n; i++) {
            const [a, b] = pairs[(rand() * n) | 0];
            s += (b ? 1 : 0) - (a ? 1 : 0);
        }
        diffs[it] = s / n;
    }
    diffs.sort();
    return {
        point,
        lo: diffs[Math.floor((alpha / 2) * iterations)],
        hi: diffs[Math.floor((1 - alpha / 2) * iterations)],
        n,
    };
}

/* --- report -------------------------------------------------------------- */

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const signed = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}pp`;

export function comparePaired(rows, aName, bName) {
    const byConfig = {};
    for (const r of rows) (byConfig[r.config] ||= {})[r.id] = r;
    const A = byConfig[aName], B = byConfig[bName];
    if (!A || !B) throw new Error(`missing config: ${!A ? aName : bName}`);

    const ids = Object.keys(A).filter((id) => id in B);
    const pairs = ids.map((id) => [!!A[id].pass, !!B[id].pass]);
    const kinds = [...new Set(ids.map((id) => A[id].kind))];

    const row = (label, idset) => {
        const p = idset.map((id) => [!!A[id].pass, !!B[id].pass]);
        const b = p.filter(([x, y]) => x && !y).length;
        const c = p.filter(([x, y]) => !x && y).length;
        const m = mcnemarExact(b, c);
        const ci = bootstrapDiffCI(p);
        const aAcc = p.filter(([x]) => x).length / p.length;
        const bAcc = p.filter(([, y]) => y).length / p.length;
        return { label, n: p.length, aAcc, bAcc, b, c, disc: b + c, p: m.p, ci };
    };

    const all = row('ALL', ids);
    const perKind = kinds.map((k) => row(k, ids.filter((id) => A[id].kind === k)));
    return { all, perKind, aName, bName };
}

function print({ all, perKind, aName, bName }) {
    console.log(`\npaired comparison: ${aName} (A) vs ${bName} (B)   n=${all.n} questions\n`);
    console.log('| slice | n | A | B | delta | discordant (b/c) | 95% CI | exact p |');
    console.log('| --- | ---: | ---: | ---: | ---: | :---: | :---: | ---: |');
    for (const r of [all, ...perKind]) {
        console.log(`| ${r.label} | ${r.n} | ${pct(r.aAcc)} | ${pct(r.bAcc)} | ${signed(r.bAcc - r.aAcc)} `
            + `| ${r.b}/${r.c} | ${signed(r.ci.lo)} .. ${signed(r.ci.hi)} | ${r.p.toFixed(3)} |`);
    }
    console.log('\nb = passed A, failed B.  c = failed A, passed B.  Only these carry signal.');
    const sig = [all, ...perKind].filter((r) => r.p < 0.05);
    console.log(sig.length
        ? `\nSIGNIFICANT at p<0.05: ${sig.map((s) => s.label).join(', ')}`
        : `\nNothing reaches p<0.05. Every interval spans zero: this run cannot distinguish the two configs.`);
    const need = [all, ...perKind].filter((r) => r.disc > 0 && r.disc < 25);
    if (need.length) {
        console.log(`Discordant pairs below the ~25 needed for a chi-square approximation in: `
            + need.map((r) => `${r.label}(${r.disc})`).join(', ') + ' — exact test used.');
    }
}

/* --- selftest: the maths is the part that can silently lie ---------------- */

function selftest() {
    let pass = 0, fail = 0;
    const check = (n, c, d = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

    check('binom: Bin(5,0.5) sums to 1',
        Math.abs([0, 1, 2, 3, 4, 5].reduce((s, k) => s + binomPmf(k, 5), 0) - 1) < 1e-12);
    check('binom: C(5,2)/32 = 10/32', Math.abs(binomPmf(2, 5) - 10 / 32) < 1e-12);

    /* Textbook values. b=c is maximally unsurprising; a clean sweep is not. */
    check('mcnemar: no discordant pairs cannot show a difference', mcnemarExact(0, 0).p === 1);
    check('mcnemar: an even split gives p=1', Math.abs(mcnemarExact(3, 3).p - 1) < 1e-9);
    check('mcnemar: 3 vs 2 is nowhere near significant', Math.abs(mcnemarExact(3, 2).p - 1) < 1e-9,
        String(mcnemarExact(3, 2).p));
    /* 6 vs 0: p = 2 * (1/2)^6 = 0.03125 — the smallest sweep that clears 0.05. */
    check('mcnemar: a clean sweep of 6 is significant', Math.abs(mcnemarExact(6, 0).p - 0.03125) < 1e-9,
        String(mcnemarExact(6, 0).p));
    check('mcnemar: a clean sweep of 5 is NOT', mcnemarExact(5, 0).p > 0.05, String(mcnemarExact(5, 0).p));
    check('mcnemar: symmetric in its arguments', mcnemarExact(4, 1).p === mcnemarExact(1, 4).p);

    /* Bootstrap: identical configs must bracket zero; a total sweep must not. */
    const same = Array.from({ length: 40 }, (_, i) => [i % 3 === 0, i % 3 === 0]);
    const ciSame = bootstrapDiffCI(same);
    check('bootstrap: identical configs give a zero-width interval at zero',
        ciSame.point === 0 && ciSame.lo === 0 && ciSame.hi === 0);

    const sweep = Array.from({ length: 40 }, () => [false, true]);
    const ciSweep = bootstrapDiffCI(sweep);
    check('bootstrap: a total sweep excludes zero', ciSweep.lo > 0 && Math.abs(ciSweep.point - 1) < 1e-9);

    check('bootstrap: reproducible across runs',
        JSON.stringify(bootstrapDiffCI(same, { seed: 7 })) === JSON.stringify(bootstrapDiffCI(same, { seed: 7 })));

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
}

/* --- cli ------------------------------------------------------------------
 * GUARDED. This block previously ran at module top level, so `import`ing
 * binomPmf or mcnemarExact from another script silently executed the whole CLI:
 * it read the newest results file, printed a full comparison table, and would
 * have called process.exit(1) had no results file existed — terminating the
 * importer. It happened once, on 22 Jul 2026, when a Clopper-Pearson script
 * imported binomPmf and emitted a spurious rag-vs-beliefs table above its own
 * output. No reported NUMBER was altered by it (the interval maths ran
 * independently), but the failure mode is a silent process.exit inside an
 * import, which is unbounded in what it could break.
 *
 * The guard compares this module's own URL against the process entry point, so
 * the CLI runs when invoked directly and never on import.
 */

function main() {
    const argv = process.argv.slice(2);
    const arg = (k, d = null) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };

    if (argv.includes('--selftest')) selftest();

    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'results');
    let file = arg('file');
    if (!file) {
        const cands = fs.readdirSync(dir).filter((f) => /^answers-\d.*\.jsonl$/.test(f)).sort();
        if (!cands.length) { console.error('no results files in', dir); process.exit(1); }
        file = path.join(dir, cands[cands.length - 1]);
    }
    console.log(`file: ${path.basename(file)}`);
    const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    print(comparePaired(rows, arg('a', 'rag'), arg('b', 'rag+beliefs')));
}

/** True only when this file is the script node was launched with. */
export const isEntryPoint = (() => {
    try { return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url); }
    catch { return false; }
})();

if (isEntryPoint) main();
