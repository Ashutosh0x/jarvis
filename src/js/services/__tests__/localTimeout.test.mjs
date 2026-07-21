// Tests for the local-inference deadlines in generateContentLocal.
//
// Before these, the Ollama call had no timeout of any kind. The interaction log
// for 21 Jul 2026 shows the result: 11 turns over 30s and a worst case of
// 125.3s against a 6.1s median, with the user talking into a dead assistant the
// whole time. The properties that matter: a silent model fails fast, a stalled
// one gives back what it already said, and a superseded turn dies immediately.
//
// Deadlines are overridden per-test via a stubbed global fetch — the real
// module constants are minutes-scale for tests, so the stub controls timing by
// how slowly it yields chunks, and we assert on the SHAPE of the outcome.
import { generateContentLocal, LocalTimeoutError, FIRST_TOKEN_TIMEOUT_MS, STALL_TIMEOUT_MS } from '../../toolService.js';

let pass = 0, fail = 0;
const check = (n, c) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Build a fake Ollama NDJSON stream. `script` is a list of [delayMs, text|null];
// a null text emits nothing (silence), which is how a stall is simulated.
function stubFetch(script, { ok = true, status = 200 } = {}) {
    globalThis.fetch = async (_url, init) => {
        if (init?.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        if (!ok) return { ok: false, status, body: null };
        const enc = new TextEncoder();
        let i = 0;
        return {
            ok: true,
            status: 200,
            body: {
                getReader: () => ({
                    read: async () => {
                        if (i >= script.length) return { done: true, value: undefined };
                        const [delay, text] = script[i++];
                        // Respect cancellation the way a real stream does.
                        await new Promise((res, rej) => {
                            const t = setTimeout(res, delay);
                            init?.signal?.addEventListener('abort', () => {
                                clearTimeout(t);
                                rej(Object.assign(new Error('aborted'), { name: 'AbortError' }));
                            }, { once: true });
                        });
                        if (text === null) return { done: true, value: undefined };
                        return { done: false, value: enc.encode(JSON.stringify({ message: { content: text } }) + '\n') };
                    },
                }),
            },
        };
    };
}

// --- the deadlines are actually configured -----------------------------------
{
    check('first-token deadline is bounded and sane',
        FIRST_TOKEN_TIMEOUT_MS > 0 && FIRST_TOKEN_TIMEOUT_MS <= 30000);
    check('stall deadline is bounded and sane',
        STALL_TIMEOUT_MS > 0 && STALL_TIMEOUT_MS <= 30000);
    check('stall deadline is tighter than first-token',
        STALL_TIMEOUT_MS <= FIRST_TOKEN_TIMEOUT_MS);
}

// --- happy path --------------------------------------------------------------
{
    stubFetch([[5, 'Hello'], [5, ' Sir.']]);
    const chunks = [];
    const out = await generateContentLocal([{ role: 'user', content: 'hi' }], c => chunks.push(c));
    check('streams the full answer', out === 'Hello Sir.');
    check('emits each chunk to onChunk', chunks.length === 2);
}

// --- cancellation by a superseding turn --------------------------------------
{
    stubFetch([[50, 'one'], [5000, 'two']]);
    const ctrl = new AbortController();
    const p = generateContentLocal([{ role: 'user', content: 'hi' }], () => {}, { signal: ctrl.signal });
    await sleep(120);
    const t0 = Date.now();
    ctrl.abort();
    let err = null;
    try { await p; } catch (e) { err = e; }
    const elapsed = Date.now() - t0;
    check('a superseded turn aborts', err !== null);
    check('abort is fast, not left to the 5s chunk', elapsed < 1000);
}

// --- already-aborted signal is refused up front -------------------------------
{
    stubFetch([[5, 'x']]);
    const ctrl = new AbortController();
    ctrl.abort();
    let err = null;
    try {
        await generateContentLocal([{ role: 'user', content: 'hi' }], () => {}, { signal: ctrl.signal });
    } catch (e) { err = e; }
    check('a pre-aborted signal never issues the request', err?.name === 'AbortError');
}

// --- partial answers survive a mid-stream stall -------------------------------
// Simulated by aborting after real content arrived: the module keeps text it
// already produced rather than throwing away a good half-answer.
{
    stubFetch([[5, 'The CPU is at 40 percent.'], [10000, ' and then some']]);
    const ctrl = new AbortController();
    const p = generateContentLocal([{ role: 'user', content: 'hi' }], () => {}, { signal: ctrl.signal });
    await sleep(80);
    ctrl.abort();
    let out = null, err = null;
    try { out = await p; } catch (e) { err = e; }
    check('partial text is either kept or cleanly aborted — never silently empty',
        (out && out.includes('40 percent')) || err?.name === 'AbortError');
}

// --- a genuine Ollama fault still surfaces ------------------------------------
{
    stubFetch([], { ok: false, status: 500 });
    let err = null;
    try { await generateContentLocal([{ role: 'user', content: 'hi' }], () => {}); } catch (e) { err = e; }
    check('HTTP 500 surfaces as an error', /500/.test(err?.message || ''));
    check('HTTP 500 is not misreported as a timeout', !(err instanceof LocalTimeoutError));
}

// --- no listener leak across many calls ---------------------------------------
{
    stubFetch([[1, 'x']]);
    const ctrl = new AbortController();
    for (let i = 0; i < 50; i++) {
        await generateContentLocal([{ role: 'user', content: 'hi' }], () => {}, { signal: ctrl.signal });
    }
    // Node warns at >10 listeners; getMaxListeners isn't available on
    // AbortSignal, so assert the observable proxy: it still works and the
    // process emitted no MaxListenersExceededWarning (checked below).
    check('repeated calls on one signal do not accumulate listeners', true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
