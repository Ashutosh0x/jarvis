/**
 * Harness run -> memory record.
 *
 * The clean wiring of the three the design note proposed, because a test run is
 * the one origin that is genuinely `verified`: it is a measurement this machine
 * made, reproducible by re-running the command. No model is involved anywhere on
 * this path.
 *
 * Benchmarks are non-revisable by design (see memory.js), so each run APPENDS.
 * That is the point — the series is what makes any single number mean anything.
 *
 *   node eval/record-benchmark.mjs --accuracy 99.4 --n 1000 --domain routing
 */
import fs from 'node:fs';
import path from 'node:path';
import { write, prune, retrieve } from '../src/js/services/memory.js';
import { gate } from '../src/js/services/extraction.js';

const STORE = path.join(process.env.APPDATA || '.', 'jarvis', 'memory.json');

const arg = (k, d) => {
    const i = process.argv.indexOf(`--${k}`);
    return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

const accuracy = arg('accuracy');
const n = arg('n', '?');
const domain = arg('domain', 'routing');
if (!accuracy) {
    console.error('usage: node eval/record-benchmark.mjs --accuracy <pct> [--n <count>] [--domain <d>]');
    process.exit(2);
}

// A run id, so two runs of the same command are two origins rather than one.
const runId = `harness-${Date.now()}`;
const text = `routing accuracy ${accuracy}% across ${n} prompts`;

const verdict = gate(
    { text, type: 'benchmark', domain },
    [{ origin: 'verified', originId: runId }],
    { now: Date.now() }
);

if (verdict.verdict !== 'promote') {
    console.log(`not recorded: ${verdict.reason}`);
    process.exit(1);
}

let store = [];
try { store = JSON.parse(fs.readFileSync(STORE, 'utf-8')); } catch { /* first run */ }

const before = store.length;
({ store } = write(store, verdict.record, Date.now()));
({ store } = prune(store, Date.now()));

fs.mkdirSync(path.dirname(STORE), { recursive: true });
fs.writeFileSync(STORE, JSON.stringify(store, null, 2));

console.log(`recorded (${verdict.confidence}): ${text}`);
console.log(`store ${before} -> ${store.length}`);

const series = retrieve(store, 'routing accuracy prompts', { domain, limit: 8, now: Date.now() });
if (series.length > 1) {
    console.log(`\nseries (${series.length} runs, newest first):`);
    for (const s of series.sort((a, b) => b.record.at - a.record.at)) {
        console.log(`  ${new Date(s.record.at).toISOString().slice(0, 10)}  ${s.record.text}`);
    }
}
