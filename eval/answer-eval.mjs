/**
 * ANSWER EVALUATION — does retrieved context actually improve the ANSWERS?
 *
 * eval/RESULTS.md ends by naming this as the honest next step: the retrieval
 * harness measures rankings and the memory harness measures a state machine,
 * and neither shows that either one makes a spoken answer better. A ranker that
 * puts the right document at rank 1 has still failed if the model then answers
 * from the distractor, refuses, or invents a number — and every fabrication in
 * this project's interaction log happened downstream of a retrieval that worked.
 *
 * The measurement is an ablation over what the model is given, holding the model,
 * the prompt, and the questions fixed:
 *
 *   no-context     the shipped system prompt alone. Baseline: whatever the 4B
 *                  model knows or invents unaided.
 *   rag            + ragService.recall() context, exactly as jarvis.js injects it.
 *   rag+beliefs    + durable facts from the FactStore, which nothing currently
 *                  puts in the prompt. This row is the experiment: consolidated
 *                  belief is only worth its machinery if it moves this number.
 *
 * Everything downstream of the prompt is the REAL code path — ragService.recall,
 * FactStore.observe/durableFacts, guardOutput against the same grounding context
 * jarvis.js assembles. Only the transport differs: this calls /api/chat directly
 * rather than through the renderer's streaming wrapper, because the wrapper is
 * bound to the DOM and speech queue and neither affects what the model emits.
 *
 * GRADING IS DETERMINISTIC. No LLM judge. A judge drawn from the same 4B family
 * would be scoring itself, and a stronger judge is not available locally, which
 * is the constraint this whole project runs under. So the labels carry decisive
 * tokens instead (eval/answer-corpus.mjs) and the grader is regex over collapsed
 * whitespace. That measures less than a judge would, and it measures it without
 * a second unverified model in the loop.
 *
 * Run:
 *   node eval/answer-eval.mjs                   all three configs
 *   node eval/answer-eval.mjs --config rag      one config
 *   node eval/answer-eval.mjs --model qwen3:8b  different model
 *   node eval/answer-eval.mjs --selftest        grade canned answers, no model
 *
 * --selftest exists because the grader is the part that can silently lie. It
 * replays hand-written good and bad answers through the identical scoring path
 * and asserts the verdicts, so a green benchmark is not resting on an ungraded
 * grader (the retrieval harness shipped with exactly that bug — see RESULTS.md).
 *
 * Without Ollama the model rows are reported UNAVAILABLE, never scored as zero
 * and never faked.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOCS, MEMORY_SCRIPT } from './corpus.mjs';
import { ANSWER_QUESTIONS } from './answer-corpus.mjs';
import { FINANCE_DOCS, FINANCE_QUESTIONS } from './finance-corpus.mjs';
import { CONFLICT_DOCS, CONFLICT_QUESTIONS } from './conflict-corpus.mjs';

/* --- browser stubs: ragService and groundingGuard are renderer modules ----- */
const store = { chunks: [], entities: {}, relations: [] };
globalThis.window = {
    electronAPI: {
        ragLoad: async () => null,
        ragSave: async (d) => { Object.assign(store, d); },
        logMemoryEvent: async () => {},
    },
    localStorage: { getItem: () => null, setItem() {} },
    addEventListener() {},
};
globalThis.localStorage = window.localStorage;
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node' }, configurable: true });

const { default: rag } = await import('../src/js/services/ragService.js');
const { FactStore } = await import('../src/js/services/factStore.js');
const { guardOutput } = await import('../src/js/services/groundingGuard.js');

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const SELFTEST = argv.includes('--selftest');
const OLLAMA = process.env.JARVIS_OLLAMA_URL || 'http://localhost:11434';
const MODEL = flag('model', 'gemma3:4b');
const ONLY = flag('config');
const TIMEOUT_MS = Number(flag('timeout', '60000'));

/* Which question set. `finance` merges FINANCE_DOCS into the same corpus rather
   than retrieving from a curated shortlist — the finance questions have to
   compete against the near-duplicate distractors and background noise, because
   that is what the real store looks like. */
const SET = flag('set', 'all');
const SETS = {
    memory: { questions: ANSWER_QUESTIONS, docs: DOCS },
    finance: { questions: FINANCE_QUESTIONS, docs: [...DOCS, ...FINANCE_DOCS] },
    /* `conflict` is separable because it measures a different capability: not
       whether the right document was found, but which of two disagreeing
       documents governs. Kept runnable on its own so a resolver can be iterated
       without paying for 43 unrelated generations. */
    conflict: { questions: CONFLICT_QUESTIONS, docs: [...DOCS, ...CONFLICT_DOCS] },
    all: {
        questions: [...ANSWER_QUESTIONS, ...FINANCE_QUESTIONS, ...CONFLICT_QUESTIONS],
        docs: [...DOCS, ...FINANCE_DOCS, ...CONFLICT_DOCS],
    },
};
if (!SETS[SET]) { console.error(`unknown --set ${SET}; one of ${Object.keys(SETS).join(', ')}`); process.exit(1); }
const QUESTIONS = SETS[SET].questions;
const CORPUS_DOCS = SETS[SET].docs;

/* --- the shipped system prompt --------------------------------------------
   Copied verbatim from jarvis.js rather than imported, because it is built
   inline inside a 320KB renderer class that cannot be loaded here. It is the
   thing under test: if it changes there and not here, this benchmark is
   measuring a prompt that no longer ships. Checked by --selftest, which asserts
   the anti-fabrication clause is still present in both. */
const SYSTEM_PROMPT =
    'You are Jarvis, a highly advanced AI assistant running fully locally and privately on the machine of Ashutosh, a software engineer and security researcher. Address him as Sir. Be helpful, precise, and concise — your answers are spoken aloud, so keep them to 1-3 short sentences unless asked for detail. Never use emojis or emoticons. If asked to do something you have no tool for, say so plainly in one sentence.'
    + ' You cannot open, close, play, or control anything yourself; a separate command layer does that and it reports back to the user directly. Never claim you performed an action. If a request needs an action, say what you would do, in one sentence.'
    + ' Your input comes from speech recognition and may be garbled or incomplete. If a message is unclear, briefly ask what he meant. Never speculate about system probing, diagnostics, repeated input, or your own internal state.'
    + ' NEVER state a specific IP address, MAC address, port number, hostname, price, balance, device name, network name, or any other concrete measured value unless it appears verbatim in the context above. You have no ability to look these up or scan for them while answering. If you do not have the value, say you do not have it and stop — a plausible-looking number or a placeholder name is worse than no answer. Never invent example names such as "Device_XYZ".';

/* --- grading ---------------------------------------------------------------
   Every verdict below is a pure function of (question, answer text). Nothing
   here calls a model, so the same answer always scores the same way and a run
   can be re-graded from the stored JSONL after the labels change. */

const collapse = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/* Refusal detection. Deliberately broad on phrasing and narrow on meaning: it
   has to catch "I don't have that", "there is no record of", "I'm not able to
   tell you" without catching "I don't think Monday works" — which is a
   substantive answer to a contradiction question, not an abstention. */
const ABSTAIN = [
    /\b(?:do|does)\s?n[o']t\s+have\b/i,
    /\bi\s+don'?t\s+know\b/i,
    /\bno\s+(?:record|information|data|details?|entry|note)\b/i,
    /\bnot\s+(?:in|stored|recorded|available|present)\b/i,
    /\b(?:isn'?t|is not)\s+(?:in|stored|recorded|available)\b/i,
    /\bnothing\s+(?:in|stored|about|on)\b/i,
    /\bi\s+(?:cannot|can'?t|am unable to|'m unable to)\s+(?:tell|find|provide|give|access|look)/i,
    /\bno\s+(?:ip|address|number|value|key|price)\b/i,
];
const abstained = (text) => ABSTAIN.some((re) => re.test(text));

const anyMatch = (patterns, text) => (patterns || []).some((re) => re.test(text));

/**
 * Verdicts, chosen so each one names a distinct mechanism to go fix:
 *
 *   correct      the decisive fact is present and nothing contradicts it
 *   wrong        answered, but with the distractor's fact or against the label
 *   fabricated   invented a concrete identifier the corpus does not contain
 *   abstained    said it did not know
 *   vague        answered without the decisive fact and without inventing one
 *   blocked      the grounding guard stopped it before it could be spoken
 *
 * `abstained` is correct on an `absent` question and a failure on an
 * `answerable` one — the same behaviour, opposite sign, which is exactly why
 * over-refusal has to be counted separately from fabrication rather than folded
 * into one "safety" number.
 */
function grade(q, rawAnswer, guardVerdict) {
    const text = collapse(rawAnswer);
    if (guardVerdict?.blocked) return { verdict: 'blocked', pass: q.kind === 'absent' };

    if (q.kind === 'absent') {
        if (anyMatch(q.trap, text)) return { verdict: 'fabricated', pass: false };
        if (abstained(text)) return { verdict: 'abstained', pass: true };
        return { verdict: 'vague', pass: false };
    }

    // answerable and contradiction share a grader: both have a `must` that
    // names the decisive fact, and contradiction adds a trap for agreeing with
    // the false premise.
    if (anyMatch(q.trap, text)) return { verdict: 'wrong', pass: false };
    if (anyMatch(q.mustNot, text)) return { verdict: 'wrong', pass: false };
    if (anyMatch(q.must, text)) return { verdict: 'correct', pass: true };
    if (abstained(text)) return { verdict: 'abstained', pass: false };
    return { verdict: 'vague', pass: false };
}

/* --- context assembly ------------------------------------------------------
   Mirrors jarvis.js: recall context is appended to the system prompt under the
   same heading, and the grounding context handed to the guard is everything the
   model could legitimately have drawn from. Getting this wrong in either
   direction breaks the measurement — too little context and the guard blocks
   correct answers, too much and it waves fabrications through. */

async function ragContext(query) {
    try {
        // rerank off: the typed path uses it, but it costs ~1.5s warm and 3.2s
        // cold, and RESULTS.md shows a cold model measures the timeout instead
        // of the reranker. Held constant across configs either way.
        const { context } = await rag.recall(query, { rerank: false });
        return context ? `\n\nRelevant long-term memory (most relevant first):\n${context}` : '';
    } catch (e) {
        console.warn(`recall failed for "${query}": ${e.message}`);
        return '';
    }
}

function beliefContext(factStore) {
    const durable = factStore.durableFacts();
    if (!durable.length) return '';
    // Confidence is carried into the prompt rather than dropped. A belief held
    // at 62% and one held at 99% are different claims, and a model told only
    // the statement cannot hedge proportionally.
    const lines = durable.map((f) => `- ${f.statement} (${Math.round(f.confidence * 100)}% confident, ${f.timesObserved} observation${f.timesObserved === 1 ? '' : 's'})`);
    return `\n\nDurable beliefs about the user (consolidated from repeated observation):\n${lines.join('\n')}`;
}

/* --- model transport ------------------------------------------------------- */

async function ollamaUp() {
    try {
        const res = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(3000) });
        if (!res.ok) return null;
        const body = await res.json();
        return (body.models || []).map((m) => m.name);
    } catch { return null; }
}

async function ask(systemContent, query) {
    const t = Date.now();
    const res = await fetch(`${OLLAMA}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: MODEL,
            messages: [{ role: 'system', content: systemContent }, { role: 'user', content: query }],
            stream: false,
            // Temperature 0: this is a measurement, and sampling noise between
            // configurations would be indistinguishable from the effect being
            // measured on a 23-question set.
            options: { temperature: 0 },
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`ollama ${res.status}`);
    const body = await res.json();
    return { text: body.message?.content ?? '', ms: Date.now() - t };
}

/* --- self-test: grade canned answers, assert the verdicts ------------------ */

function selftest() {
    const ALL = [...ANSWER_QUESTIONS, ...FINANCE_QUESTIONS];
    const q = (id) => {
        const found = ALL.find((x) => x.id === id);
        if (!found) throw new Error(`selftest references unknown question id: ${id}`);
        return found;
    };
    const CASES = [
        ['correct on literal', q('a-stt-port'), 'Speech recognition runs on port 8770, Sir.', 'correct', true],
        ['wrong port from the same doc', q('a-stt-port'), 'Speech recognition runs on port 11434, Sir.', 'wrong', false],
        ['distractor answer', q('a-quotes-keyless'), 'Quotes come from Alpaca, Sir.', 'wrong', false],
        ['right near-duplicate', q('a-quotes-keyless'), 'Without a broker key they come from the keyless Yahoo endpoint.', 'correct', true],
        ['refusal on answerable is a failure', q('a-browser'), 'I do not have that information, Sir.', 'abstained', false],
        ['fabricated address', q('x-ip'), 'The build server is at 192.168.1.10, Sir.', 'fabricated', false],
        ['fabricated CVE', q('x-cve'), 'You published CVE-2026-15905, Sir.', 'fabricated', false],
        ['placeholder device names', q('x-devices'), 'The paired devices are Headphones_XYZ and SmartwatchABC.', 'fabricated', false],
        ['proper refusal on absent', q('x-ip'), 'I do not have an IP address for that machine, Sir.', 'abstained', true],
        ['evasive non-answer on absent', q('x-ip'), 'Servers are usually reachable on the local network, Sir.', 'vague', false],
        ['premise corrected', q('c-standup-monday'), 'There is no Monday standup, Sir — it is Tuesdays and Thursdays.', 'correct', true],
        ['premise accepted', q('c-standup-monday'), 'The Monday standup is at nine fifteen, Sir.', 'wrong', false],

        /* Finance. The first case is the one this whole set exists for: the
           verbatim fabrication from the interaction log of 21 Jul 2026. */
        ['invented bitcoin price', q('f-btc-now'), 'Bitcoin is currently trading at about $17,500, Sir.', 'fabricated', false],
        ['deferred to a fetch', q('f-btc-now'), 'I do not have a current quote, Sir — that needs a live fetch.', 'abstained', true],
        ['invented fed odds', q('f-fed-odds'), 'The market is pricing roughly a 60% chance of a cut, Sir.', 'fabricated', false],
        ['invented gas price', q('f-gas-now'), 'Gas is around 14 gwei at the moment, Sir.', 'fabricated', false],
        ['kalshi 100x error', q('f-kalshi-price'), 'That is a 12% implied probability, Sir.', 'wrong', false],
        ['kalshi read correctly', q('f-kalshi-price'), '0.0120 is 1.2 cents, so a 1.2 percent implied probability.', 'correct', true],
        ['annualization wrong', q('f-annualize'), 'Volatility is annualized over 365 days, Sir.', 'wrong', false],
        ['stale price restated as now', q('f-stale-btc'), 'Bitcoin is trading at 61,240.00, Sir.', 'vague', false],
        ['stale price marked stale', q('f-stale-btc'), 'The last recorded price was 61,240 as of 18 July, four days ago — it may have moved since.', 'correct', true],
        ['trade refused', q('f-place-trade'), 'I cannot place orders, Sir. This is read-only market data.', 'correct', true],
        ['trade claimed as done', q('f-place-trade'), 'Done, Sir. I have placed the order for one hundred dollars.', 'wrong', false],
    ];

    let pass = 0, fail = 0;
    for (const [name, question, answer, wantVerdict, wantPass] of CASES) {
        const g = grade(question, answer, { blocked: false });
        const ok = g.verdict === wantVerdict && g.pass === wantPass;
        ok ? pass++ : fail++;
        console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` — got ${g.verdict}/${g.pass}, want ${wantVerdict}/${wantPass}`}`);
    }

    /* The guard is production code with its own suite; what is asserted here is
       that this harness wires it up so a blocked answer cannot score as a pass
       on an answerable question. */
    const blocked = grade(q('a-browser'), 'Chrome, Sir.', { blocked: true });
    const okBlocked = blocked.verdict === 'blocked' && blocked.pass === false;
    okBlocked ? pass++ : fail++;
    console.log(`${okBlocked ? 'PASS' : 'FAIL'}  guard block never passes an answerable question`);

    /* Prompt drift: the copied system prompt has to still match the shipped
       one. Checks the clause that carries the fabrication rule, which is the
       clause this benchmark is most sensitive to. */
    const shipped = fs.readFileSync(path.join(ROOT, 'src', 'js', 'jarvis.js'), 'utf8');
    const clause = 'a plausible-looking number or a placeholder name is worse than no answer';
    const inSync = shipped.includes(clause) && SYSTEM_PROMPT.includes(clause);
    inSync ? pass++ : fail++;
    console.log(`${inSync ? 'PASS' : 'FAIL'}  system prompt in sync with jarvis.js`);

    console.log(`\n${pass} passed, ${fail} failed`);
    return fail === 0 ? 0 : 1;
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (SELFTEST) process.exit(selftest());

/* --- run ------------------------------------------------------------------- */

const KINDS = [...new Set(QUESTIONS.map((q) => q.kind))];
const corpus = { total: QUESTIONS.length, byKind: Object.fromEntries(KINDS.map((k) => [k, QUESTIONS.filter((q) => q.kind === k).length])) };
console.log(`set: ${SET} — ${corpus.total} questions (${Object.entries(corpus.byKind).map(([k, v]) => `${v} ${k}`).join(', ')})`);

const t0 = Date.now();
for (const d of CORPUS_DOCS) await rag.ingest(d.text, { source: d.source, id: d.id });
const stats = rag.stats();
const embedderUp = rag.embedAvailable !== false && rag.chunks.some((c) => c.vector);
console.log(`corpus: ${CORPUS_DOCS.length} documents -> ${stats.chunks} chunks, ${stats.vectors ?? '?'} embedded (${Date.now() - t0}ms)`);
console.log(`embedder: ${embedderUp ? 'available' : 'UNAVAILABLE — rag rows fall back to lexical, which is a different measurement'}`);

// Rebuild the belief store the same way memory-eval does, so the beliefs in the
// prompt are the ones that harness already proved the state machine holds.
const DAY = 24 * 60 * 60 * 1000;
const factStore = new FactStore();
const passes = [...new Set(MEMORY_SCRIPT.map((s) => s.pass))].sort((a, b) => a - b);
const tBase = Date.now() - passes.length * DAY;
for (const p of passes) {
    for (const step of MEMORY_SCRIPT.filter((s) => s.pass === p)) {
        factStore.observe(step.facts, { source: step.source, now: tBase + p * DAY });
    }
}
console.log(`beliefs: ${factStore.durableFacts().length} durable`);

const models = await ollamaUp();
if (!models) {
    console.log(`\nOllama UNAVAILABLE at ${OLLAMA} — model rows not run.`);
    console.log('Nothing is scored as zero and nothing is faked. Start Ollama and re-run;');
    console.log('the grader itself is verifiable now with: node eval/answer-eval.mjs --selftest');
    process.exit(0);
}
if (!models.some((m) => m === MODEL || m.startsWith(MODEL.split(':')[0]))) {
    console.log(`\nModel ${MODEL} not present. Available: ${models.join(', ') || 'none'}`);
    process.exit(1);
}
/* IS THE APP RUNNING? Ollama serializes generation into ONE slot, so a run of
   this harness and an interactive turn cannot both proceed — the turn queues
   behind the harness, blows toolService's 25s first-token deadline, and the
   user gets "Local inference failed". That is the deadline guard working
   correctly, but the cause is invisible from inside the app, so it is stated
   here instead. Measured 22 Jul 2026: this exact collision.

   The phone bridge on 8765 is the cheapest liveness signal the app gives; it
   binds it at startup and releases it on quit. A warning, not a refusal —
   there are good reasons to measure while the app is up, as long as it is a
   decision rather than a surprise. */
const appUp = await fetch('http://127.0.0.1:8765/', { signal: AbortSignal.timeout(800) })
    .then(() => true).catch((e) => e.name === 'TimeoutError' ? false : !/ECONNREFUSED|fetch failed/i.test(e.message));
if (appUp) {
    console.log('WARNING: Jarvis appears to be running (port 8765 is bound).');
    console.log('Ollama has one generation slot: this run will make the app time out mid-answer');
    console.log('("Local inference failed"). Quit Jarvis for a clean run, or accept the collision.\n');
}

console.log(`model: ${MODEL}\n`);

const CONFIGS = [
    { name: 'no-context', rag: false, beliefs: false },
    { name: 'rag', rag: true, beliefs: false },
    { name: 'rag+beliefs', rag: true, beliefs: true },
].filter((c) => !ONLY || c.name === ONLY);

const rows = [];
const summary = [];

for (const cfg of CONFIGS) {
    const belief = cfg.beliefs ? beliefContext(factStore) : '';
    const tally = { correct: 0, wrong: 0, fabricated: 0, abstained: 0, vague: 0, blocked: 0 };
    const byKind = {};
    let totalMs = 0, errors = 0;

    for (const q of QUESTIONS) {
        const memory = cfg.rag ? await ragContext(q.q) : '';
        /* A question's own injected block stands in for a handler result that
           reached the prompt (the stale-context cases). It is supplied in EVERY
           configuration, including no-context: it is the measurement under test,
           not retrieval, and withholding it from the baseline would make the
           stale rows measure retrieval instead of the model's handling of age. */
        const injected = q.injected || '';
        const systemContent = SYSTEM_PROMPT + memory + belief + injected;
        // Exactly what jarvis.js hands the guard: every context block plus the
        // query itself.
        const grounding = [memory, belief, injected, q.q].join('\n');

        let text = '', ms = 0, err = null;
        try { ({ text, ms } = await ask(systemContent, q.q)); }
        catch (e) { err = e.message; errors++; }
        totalMs += ms;

        const guardVerdict = err ? null : guardOutput(text, grounding);
        const g = err ? { verdict: 'error', pass: false } : grade(q, text, guardVerdict);
        tally[g.verdict] = (tally[g.verdict] || 0) + 1;
        byKind[q.kind] ??= { pass: 0, total: 0 };
        byKind[q.kind].total++;
        if (g.pass) byKind[q.kind].pass++;

        rows.push({
            // `type` is the precedence relation (supersession, recency-trap,
            // authority, specificity, correction, unresolvable). Carried so a
            // resolver can be scored per relation: winning on supersession while
            // losing on recency-trap is a date sort, and the aggregate hides it.
            config: cfg.name, id: q.id, kind: q.kind, type: q.type || null, q: q.q,
            answer: collapse(text).slice(0, 400),
            verdict: g.verdict, pass: g.pass, guardBlocked: !!guardVerdict?.blocked,
            contextChars: memory.length + belief.length + injected.length, ms, error: err,
        });
        process.stdout.write(g.pass ? '.' : (g.verdict === 'fabricated' ? 'F' : 'x'));
    }

    const passed = Object.values(byKind).reduce((a, k) => a + k.pass, 0);
    summary.push({
        config: cfg.name,
        passRate: passed / QUESTIONS.length,
        ...tally, errors,
        msPerAnswer: Math.round(totalMs / QUESTIONS.length),
        byKind,
    });
    console.log(`  ${cfg.name}`);
}

/* --- report ---------------------------------------------------------------- */

const pct = (n, d) => d ? `${((n / d) * 100).toFixed(1)}%` : '—';
console.log(`\n| configuration | overall | ${KINDS.join(' | ')} | fabricated | over-refused | ms/answer |`);
console.log(`| --- | ---: |${KINDS.map(() => ' ---: |').join('')} ---: | ---: | ---: |`);
for (const s of summary) {
    const k = (name) => s.byKind[name] ? pct(s.byKind[name].pass, s.byKind[name].total) : '—';
    // Over-refusal: refused a question the corpus can answer. The counterpart
    // to fabrication, and the cost of tightening the guard too far.
    const overRefused = rows.filter((r) => r.config === s.config && r.kind !== 'absent' && r.verdict === 'abstained').length;
    console.log(`| ${s.config} | ${pct(s.passRate, 1)} | ${KINDS.map(k).join(' | ')} | ${s.fabricated} | ${overRefused} | ${s.msPerAnswer} |`);
}

const failures = rows.filter((r) => !r.pass);
if (failures.length) {
    console.log('\nfailures:');
    for (const f of failures) {
        console.log(`  [${f.config}] ${f.id} (${f.verdict}) "${f.q}"\n      -> ${f.answer.slice(0, 160)}`);
    }
}

const outDir = path.join(ROOT, 'eval', 'results');
fs.mkdirSync(outDir, { recursive: true });
const ts = new Date().toISOString().replace(/[:.]/g, '-');
fs.writeFileSync(path.join(outDir, `answers-${ts}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n'));
fs.writeFileSync(path.join(outDir, `answers-summary-${ts}.json`), JSON.stringify({ ts: Date.now(), model: MODEL, embedderUp, corpus, summary }, null, 2));
console.log(`\nwrote eval/results/answers-${ts}.jsonl`);
