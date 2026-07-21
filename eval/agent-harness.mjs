/**
 * Drive N prompts through Jarvis's REAL intent router and record what happened.
 *
 *   node eval/agent-harness.mjs                 # 1000 prompts, routing only
 *   node eval/agent-harness.mjs 1000 --llm 25   # plus 25 real model turns
 *
 * WHY NOT 1000 CHATS. Measured from this machine's own interaction log:
 * AI_COMMAND averages 13,473ms and has peaked at 125,314ms. A thousand model
 * turns is 3.7 hours at the average and considerably worse in practice, with
 * gemma3:4b pinned the whole time. The deterministic finance handlers are the
 * opposite: QUANT_QUERY averaged 618ms, NEWS_QUERY 789ms, and both bypass the
 * model entirely.
 *
 * So the harness treats routing as the thing worth running at scale — it is
 * where the failures actually live (every routing bug this project has had
 * ended as a confident wrong answer) — and samples the model path rather than
 * grinding through it. The `--llm N` flag makes that cost explicit.
 *
 * Results append to eval/results/ as JSONL so runs can be diffed over time.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatePrompts, describeCorpus } from './finance-prompts.mjs';

/* --- browser stubs: jarvis.js is a renderer module ------------------------- */
globalThis.window = { addEventListener() {}, electronAPI: {}, localStorage: { getItem: () => null, setItem() {} } };
globalThis.document = {
    addEventListener() {}, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {} }),
    body: { classList: { add() {}, remove() {}, contains: () => false } },
};
globalThis.localStorage = window.localStorage;
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node' }, configurable: true });
globalThis.speechSynthesis = { getVoices: () => [], cancel() {}, speak() {} };
globalThis.SpeechSynthesisUtterance = class {};
globalThis.AudioContext = class {};
globalThis.AudioWorkletProcessor = class {};
globalThis.registerProcessor = () => {};
globalThis.sampleRate = 48000;

const { default: Jarvis } = await import('../src/js/jarvis.js');

const argv = process.argv.slice(2);
const COUNT = Number(argv.find(a => /^\d+$/.test(a))) || 1000;
const LLM_SAMPLE = argv.includes('--llm') ? Number(argv[argv.indexOf('--llm') + 1]) || 0 : 0;
const CONCURRENCY = 8;

/* Router context derived FROM the prototype, so every helper detectIntent
   reaches for exists. A hand-listed stub breaks the moment a parser is added. */
const router = Object.create(Jarvis.prototype);
router.settings = { get: () => null };
router._lastNewsSubject = null;

const prompts = generatePrompts(COUNT);
const corpus = describeCorpus(prompts);

console.log(`corpus: ${corpus.total} prompts, ${corpus.unique} unique, ${corpus.repeats} repeats`);
console.log(`drawn from: ${corpus.catalogues.ondoTokens} Ondo tokens, ${corpus.catalogues.chains} chains, ${corpus.catalogues.feedDomains} feed domains`);
console.log(`model-path share: ${(corpus.llmShare * 100).toFixed(1)}%\n`);

/* --- stage 1: route everything -------------------------------------------- */
const t0 = Date.now();
const results = [];
for (const p of prompts) {
    const t = process.hrtime.bigint();
    let intent = null, error = null;
    try { intent = router.detectIntent(p.prompt)?.intent ?? null; }
    catch (e) { error = e.message; }
    results.push({
        ...p,
        gotIntent: intent,
        ok: intent === p.expectIntent,
        micros: Number(process.hrtime.bigint() - t) / 1000,
        error,
    });
}
const routeMs = Date.now() - t0;

const ok = results.filter(r => r.ok).length;
const errored = results.filter(r => r.error);
const avgMicros = results.reduce((s, r) => s + r.micros, 0) / results.length;

console.log(`ROUTING — ${results.length} prompts in ${routeMs}ms (${avgMicros.toFixed(1)}µs each)`);
console.log(`correct: ${ok}/${results.length} (${((ok / results.length) * 100).toFixed(1)}%)`);
if (errored.length) console.log(`threw: ${errored.length}`);

/* Where it disagreed. A misroute is the failure that matters: it sends a
   deterministic question to the model, which then answers it from nothing. */
const misses = results.filter(r => !r.ok && !r.error);
const missGroups = {};
for (const m of misses) {
    const k = `${m.expectIntent} -> ${m.gotIntent}`;
    (missGroups[k] = missGroups[k] || []).push(m.prompt);
}
if (misses.length) {
    console.log(`\nmisroutes by kind:`);
    for (const [k, list] of Object.entries(missGroups).sort((a, b) => b[1].length - a[1].length)) {
        console.log(`  ${String(list.length).padStart(4)}  ${k}`);
        for (const ex of [...new Set(list)].slice(0, 3)) console.log(`        "${ex}"`);
    }
}

/* How much of the set never touches the model — the number that decides
   whether a run of this size is affordable at all. */
const deterministic = results.filter(r => r.ok && !r.llm).length;
console.log(`\nanswerable without the model: ${deterministic}/${results.length} (${((deterministic / results.length) * 100).toFixed(1)}%)`);

/* --- stage 2: sample the model path ---------------------------------------- */
let llmStats = null;
if (LLM_SAMPLE > 0) {
    const OLLAMA = process.env.JARVIS_OLLAMA_URL || 'http://localhost:11434';
    const MODEL = process.env.JARVIS_LOCAL_MODEL || 'gemma3:4b';
    const sample = results.filter(r => r.llm).slice(0, LLM_SAMPLE);
    console.log(`\nMODEL PATH — ${sample.length} real turns against ${MODEL} (concurrency ${CONCURRENCY})`);

    const latencies = [];
    let failed = 0;
    const started = Date.now();
    for (let i = 0; i < sample.length; i += CONCURRENCY) {
        await Promise.all(sample.slice(i, i + CONCURRENCY).map(async (r) => {
            const t = Date.now();
            try {
                const res = await fetch(`${OLLAMA}/api/chat`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model: MODEL, stream: false, keep_alive: '60m',
                        options: { temperature: 0.2, num_predict: 160 },
                        messages: [
                            { role: 'system', content: 'You are a financial analyst. Answer in under three sentences. If you do not have data, say so rather than estimating a number.' },
                            { role: 'user', content: r.prompt },
                        ],
                    }),
                    signal: AbortSignal.timeout(180000),
                });
                const j = await res.json();
                r.response = (j?.message?.content || '').trim();
                r.llmMs = Date.now() - t;
                latencies.push(r.llmMs);
            } catch (e) { r.error = e.message; failed++; }
        }));
        process.stdout.write(`\r  ${Math.min(i + CONCURRENCY, sample.length)}/${sample.length}`);
    }
    const wall = Date.now() - started;
    latencies.sort((a, b) => a - b);
    llmStats = {
        turns: sample.length, failed, wallMs: wall,
        avgMs: Math.round(latencies.reduce((s, x) => s + x, 0) / (latencies.length || 1)),
        p50: latencies[Math.floor(latencies.length * 0.5)] || 0,
        p95: latencies[Math.floor(latencies.length * 0.95)] || 0,
    };
    console.log(`\n  avg ${llmStats.avgMs}ms, p50 ${llmStats.p50}ms, p95 ${llmStats.p95}ms, ${failed} failed, ${(wall / 1000).toFixed(1)}s wall`);
    // The honest extrapolation, stated rather than implied.
    const projected = (llmStats.avgMs * COUNT) / CONCURRENCY / 1000 / 60;
    console.log(`  projected for all ${COUNT} through the model: ~${projected.toFixed(0)} min at concurrency ${CONCURRENCY}`);
}

/* --- persist ---------------------------------------------------------------- */
const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'results');
fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const file = path.join(outDir, `run-${stamp}.jsonl`);
fs.writeFileSync(file, results.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');

const summary = {
    ts: Date.now(), count: results.length, corpus,
    routing: { correct: ok, accuracy: ok / results.length, avgMicros, totalMs: routeMs, threw: errored.length },
    deterministicShare: deterministic / results.length,
    misroutes: Object.fromEntries(Object.entries(missGroups).map(([k, v]) => [k, v.length])),
    llm: llmStats,
};
fs.writeFileSync(path.join(outDir, `summary-${stamp}.json`), JSON.stringify(summary, null, 2), 'utf-8');
console.log(`\nwrote ${path.relative(process.cwd(), file)} and its summary`);
process.exit(misses.length ? 1 : 0);
