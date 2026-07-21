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
const testDir = path.join(root, 'src', 'js', 'services', '__tests__');

const suites = [
    ...readdirSync(testDir).filter(f => f.endsWith('.mjs')).map(f => path.join(testDir, f)),
    path.join(root, 'metricStore.test.mjs'),
];

let totalChecks = 0, totalFailed = 0, failedSuites = [];
const started = Date.now();

for (const suite of suites) {
    const name = path.basename(suite);
    let out = '';
    let ok = true;
    try {
        out = execFileSync(process.execPath, [suite], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
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

console.log(`\n${suites.length} suites, ${totalChecks} checks, ${totalFailed} failed, ${((Date.now() - started) / 1000).toFixed(1)}s`);
if (failedSuites.length) {
    console.log(`failing: ${failedSuites.join(', ')}`);
    process.exit(1);
}
