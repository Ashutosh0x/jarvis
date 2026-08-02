// Does semantic routing actually beat the regex?
//
// Not a unit test — a MEASUREMENT, against the live nomic-embed-text embedder,
// on phrasings that are NOT in the capability manifest. Held out on purpose:
// scoring a router on the examples it was built from measures memorisation.
//
// It exists because this project has been wrong about exactly this before. The
// causal-graph "simulate intentions" retrieval layer was obviously better in
// principle and measured WORSE than plain retrieval (56.6% vs 68.8%). A
// smarter architecture is a hypothesis until it has a number.
//
// Skips cleanly when Ollama is down, so it never fails a build for a missing
// optional service.

import { buildIndex, routeWithIndex } from '../src/js/services/capabilityRouter.js';
import { parseWebSearchQuery } from '../src/js/services/webSearchIntent.js';
import { parseSystemCommand } from '../src/js/services/systemCommands.js';

const OLLAMA = process.env.JARVIS_OLLAMA_URL || 'http://127.0.0.1:11434';

async function embed(texts) {
    const res = await fetch(`${OLLAMA}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'nomic-embed-text', input: texts })
    });
    if (!res.ok) throw new Error(`embed failed: ${res.status}`);
    const j = await res.json();
    return j.embeddings;
}

/* HELD OUT. None of these appear in capabilities.js. They are phrasings a
   person actually uses, including the shapes the regex is known to miss:
   verb-last, verb-absent, and indirect. */
const LABELLED = [
    // --- should reach web_search ---
    ['whats going on with dogecoin today', 'web_search'],
    ['any news on the fed rate decision', 'web_search'],
    ['check online for tokio vs async-std', 'web_search'],
    ['solana price right now', 'web_search'],
    ['pull up the latest on openai', 'web_search'],
    ['nvidia earnings search', 'web_search'],
    ['whats the weather in tokyo', 'web_search'],
    ['find me some rust web framework comparisons', 'web_search'],
    ['google the best mechanical keyboards', 'web_search'],
    ['whats trending in crypto', 'web_search'],

    // --- should reach local memory ---
    ['what did i say about the migration', 'local_memory'],
    ['remind me what we decided on the schema', 'local_memory'],
    ['do you remember my api key preference', 'local_memory'],

    // --- should reach screen vision ---
    ['whats this error on my display', 'screen_vision'],
    ['look at my monitor and tell me whats wrong', 'screen_vision'],

    // --- should reach system state ---
    ['am i running out of storage', 'system_state'],
    ['whats using all my ram', 'system_state'],

    // --- should reach the phone mirror ---
    ['put my android on screen', 'phone_mirror'],

    // --- should reach NOTHING semantically (destructive or filler) ---
    ['empty the recycle bin', null],
    ["don't empty the recycle bin", null],
    ['sign me out of windows', null],
    ['turn bluetooth off', null],
    ['thanks that helps', null],
    ['ok', null]
];

let index;
try {
    index = await buildIndex(embed);
} catch (e) {
    console.log(`SKIP  routing-eval — no embedder (${e.message})`);
    console.log('\n0 passed, 0 failed');
    process.exit(0);
}
if (!index) {
    console.log('SKIP  routing-eval — index could not be built');
    console.log('\n0 passed, 0 failed');
    process.exit(0);
}

const queries = LABELLED.map(([q]) => q);
const vectors = await embed(queries);

let semanticRight = 0, regexRight = 0, pipelineRight = 0;
const rows = [];

for (let i = 0; i < LABELLED.length; i++) {
    const [q, want] = LABELLED[i];
    const r = routeWithIndex(index, vectors[i], q);
    const got = r?.capability.name ?? null;
    const semOk = got === want;
    if (semOk) semanticRight++;

    /* THE PIPELINE AS SHIPPED, which is not the router alone.
       Deterministic parsers run FIRST — that is the whole blast-radius design —
       so a destructive command never reaches the router. Measuring the router
       in isolation understates the system and, worse, measures something
       nobody runs. Both numbers are reported: the router's own accuracy is
       what tells you whether the embeddings are any good, and the pipeline's
       is what tells you what the user experiences. */
    const deterministic = parseSystemCommand(q);
    const pipelineGot = deterministic ? null : got;   // null = "not semantic"
    if (pipelineGot === want) pipelineRight++;

    /* The regex baseline only knows about web_search, so it is scored on the
       question it can actually answer: is this a web search or not. Scoring it
       on capabilities it has no concept of would be a rigged comparison. */
    const regexSaysSearch = parseWebSearchQuery(q) !== null;
    const shouldBeSearch = want === 'web_search';
    const rgxOk = regexSaysSearch === shouldBeSearch;
    if (rgxOk) regexRight++;

    rows.push({ q, want, got, score: r?.score ?? null, semOk, rgxOk });
}

const n = LABELLED.length;
const semPct = (semanticRight / n * 100).toFixed(1);
const rgxPct = (regexRight / n * 100).toFixed(1);

console.log('query'.padEnd(46) + 'expected'.padEnd(15) + 'semantic'.padEnd(15) + 'ok');
console.log('-'.repeat(90));
for (const r of rows) {
    console.log(
        r.q.slice(0, 44).padEnd(46) +
        String(r.want).padEnd(15) +
        String(r.got).padEnd(15) +
        (r.semOk ? 'yes' : 'NO ') + (r.score !== null ? `  ${r.score}` : '')
    );
}

const pipePct = (pipelineRight / n * 100).toFixed(1);
console.log('\n--- accuracy on held-out phrasings ---');
console.log(`AS SHIPPED (deterministic then semantic) : ${pipelineRight}/${n}  ${pipePct}%`);
console.log(`semantic router alone                    : ${semanticRight}/${n}  ${semPct}%`);
console.log(`regex baseline (search / not-search)     : ${regexRight}/${n}  ${rgxPct}%`);

/* The bar is not "semantic wins". It is "semantic does not LOSE", because the
   architecture buys extensibility even at parity — new capabilities become
   manifests instead of patterns. A regression, though, means the regex is
   still doing real work and should stay in front. */
const failures = rows.filter((r) => !r.semOk);
console.log(`\nmisroutes: ${failures.length}`);
for (const f of failures) console.log(`  "${f.q}" -> ${f.got} (wanted ${f.want})`);

console.log(`\n${semanticRight} passed, ${n - semanticRight} failed`);
process.exit(0);   // a measurement never fails the build
