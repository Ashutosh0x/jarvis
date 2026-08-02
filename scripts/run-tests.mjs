#!/usr/bin/env node
/**
 * Test runner. `npm test`.
 *
 * This exists because the landing page cited a check count that nothing in the
 * repository produced — the suites were only ever run by hand. A number on a
 * page headed "verified, not estimated" has to come from somewhere you can run.
 * This prints the total, and the page is expected to match it.
 *
 * Each suite is a plain node script that prints "N passed, M failed" and exits
 * non-zero on failure. No framework, no config, no watch mode.
 */
import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* Every `__tests__` directory, not just the services one. A suite that exists
   but is never discovered is worse than no suite: it passes locally when you
   run it by hand and never runs in CI, so it protects nothing. */
const testDirs = [
    path.join(root, 'src', 'js', 'services', '__tests__'),
    path.join(root, 'setup', '__tests__'),
];

const discovered = testDirs.flatMap((dir) => {
    try {
        return readdirSync(dir).filter((f) => f.endsWith('.mjs')).map((f) => path.join(dir, f));
    } catch {
        return [];   // a directory that has not been created yet is not a failure
    }
});

const suites = [
    ...discovered,
    path.join(root, 'metricStore.test.mjs'),
    path.join(root, 'edgarGuard.test.mjs'),
    path.join(root, 'mirrorService.test.mjs'),
    path.join(root, 'visionRouter.test.mjs'),
    path.join(root, 'sectorMove.test.mjs'),
    path.join(root, 'webSearch.test.mjs'),
    path.join(root, 'packaging.test.mjs'),
    /* The marketing site advertises download URLs that embed the version, so
       they 404 the moment the app is released again. Nothing else notices:
       the site builds, the links are well-formed, and only a click reveals it. */
    path.join(root, 'webapp-links.test.mjs'),
];

/* The answer benchmark's grader is the part of it that can silently lie, so its
   self-test runs with the unit suites rather than only alongside a model run.
   It needs no model: it replays canned answers through the identical scoring
   path. Passed as a suite with its flag. */
const flagged = [
    [path.join(root, 'eval', 'answer-eval.mjs'), ['--selftest']],
    /* Same reasoning for the significance harness: a p-value nobody can check is
       worse than no p-value, because it will be quoted. Its self-test asserts
       textbook exact-binomial values (a clean sweep of 6 is p=0.03125; of 5 is
       0.0625) and that identical configs bootstrap to a zero-width interval. */
    [path.join(root, 'eval', 'paired-stats.mjs'), ['--selftest']],
    /* The section-routing benchmark grades itself with a topic-set comparison
       and a rank function, both of which can silently pass everything. Its
       self-test runs here; the benchmark proper needs the live filing and so
       stays out of the unit suite. */
    [path.join(root, 'eval', 'section-routing-eval.mjs'), ['--selftest']],
];

let totalChecks = 0, totalFailed = 0, failedSuites = [];
const started = Date.now();

for (const entry of [...suites.map(s => [s, []]), ...flagged]) {
    const [suite, args] = entry;
    const name = path.basename(suite);
    let out = '';
    let ok = true;
    try {
        out = execFileSync(process.execPath, [suite, ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
        ok = false;
        out = `${e.stdout || ''}${e.stderr || ''}`;
    }
    // Suites report their own tally; fuzz suites report invariants instead.
    const m = out.match(/(\d+)\s+passed,\s+(\d+)\s+failed/);
    const passed = m ? Number(m[1]) : 0;
    const failed = m ? Number(m[2]) : (ok ? 0 : 1);
    totalChecks += passed;
    totalFailed += failed;
    if (!ok || failed) failedSuites.push(name);
    const label = m ? `${passed} checks` : (ok ? 'ok' : 'FAILED');
    console.log(`${ok && !failed ? 'PASS' : 'FAIL'}  ${name.padEnd(30)} ${label}`);
    if (!ok) console.log(out.split('\n').filter(l => /FAIL|Error/.test(l)).slice(0, 5).map(l => `        ${l}`).join('\n'));
}

console.log(`\n${suites.length + flagged.length} suites, ${totalChecks} checks, ${totalFailed} failed, ${((Date.now() - started) / 1000).toFixed(1)}s`);
if (failedSuites.length) {
    console.log(`failing: ${failedSuites.join(', ')}`);
    process.exit(1);
}
