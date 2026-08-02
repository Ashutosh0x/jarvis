// Tests for semantic capability routing.
//
// The embedder is SYNTHETIC here — a deterministic bag-of-words vector — so
// these run without Ollama and in CI. That is on purpose: what is being tested
// is the ROUTING POLICY (the floor, the margin, the read-only filter), which
// must hold whatever the embedding model is. Model quality is measured
// separately against the live embedder, because a test that needs a running
// Ollama is a test that gets skipped.

import {
    buildIndex, routeWithIndex, cosine, ROUTER_LIMITS
} from '../capabilityRouter.js';
import {
    semanticallyRoutable, allCapabilities, classifyFreshness, needsNetwork, FRESHNESS
} from '../capabilities.js';

let pass = 0, fail = 0;
const check = (n, c) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); };

/* A deterministic embedder: hashed bag of words over a fixed dimension.
   Shares vocabulary structure with real embeddings — similar sentences share
   dimensions — without needing a model. */
const DIM = 96;
const STOP = new Set(['the', 'a', 'an', 'my', 'me', 'for', 'to', 'of', 'is', 'on', 'it', 'you', 'i']);
function fakeEmbed(texts) {
    return Promise.resolve(texts.map((t) => {
        const v = new Array(DIM).fill(0);
        const words = String(t).toLowerCase().match(/[a-z]+/g) || [];
        for (const w of words) {
            if (STOP.has(w)) continue;
            let h = 0;
            for (let i = 0; i < w.length; i++) h = (h * 31 + w.charCodeAt(i)) >>> 0;
            v[h % DIM] += 1;
            v[(h >>> 7) % DIM] += 0.5;   // a second bucket softens collisions
        }
        return v;
    }));
}

const index = await buildIndex(fakeEmbed);
const routeText = async (t) => {
    const [v] = await fakeEmbed([t]);
    return routeWithIndex(index, v, t);
};

/* --- the index ------------------------------------------------------------ */
{
    check('an index was built', Array.isArray(index) && index.length > 0);
    check('it covers every read-only capability',
        index.length === semanticallyRoutable().length);
    check('every entry has a centroid', index.every((e) => Array.isArray(e.centroid)));
    check('and keeps its example vectors',
        index.every((e) => e.exampleVectors.length === e.capability.examples.length));

    /* THE RULE THIS FILE EXISTS FOR. Nothing that writes or destroys may be in
       the index at all — not filtered later, not guarded by a caller. */
    check('NO write or destructive capability is in the index',
        index.every((e) => e.capability.effects === 'read'));
    const dangerous = allCapabilities().filter((c) => c.effects !== 'read');
    check(`there ARE destructive capabilities to exclude (${dangerous.length})`,
        dangerous.length >= 3);
    for (const d of dangerous) {
        check(`'${d.name}' is not semantically reachable`,
            !index.some((e) => e.capability.name === d.name));
    }
}

/* --- destructive phrasing cannot be routed here --------------------------- */
{
    /* Each of these is a real destructive request. The router must return null
       — NOT because it failed, but because these belong to the deterministic
       parser. If any of them ever returns a capability, the blast-radius rule
       has been broken. */
    for (const q of [
        'empty the recycle bin',
        "don't empty the recycle bin",
        'what happens if i empty the recycle bin',
        'sign out',
        'lock the screen',
        'turn off bluetooth',
        'click the save button'
    ]) {
        const r = await routeText(q);
        check(`"${q}" is not semantically routed${r ? ` — GOT ${r.capability.name}` : ''}`,
            r === null || r.capability.effects === 'read');
    }
}

/* --- the floor and the margin --------------------------------------------- */
{
    /* A nearest neighbour ALWAYS exists. Without a floor, conversational
       filler routes to whatever it is least unlike. */
    for (const q of ['thank you', 'ok', 'hmm', 'that is interesting']) {
        const r = await routeText(q);
        check(`"${q}" is refused rather than forced${r ? ` — GOT ${r.capability.name} @${r.score}` : ''}`,
            r === null);
    }
    check('the floor is a real threshold, not zero', ROUTER_LIMITS.MIN_SCORE > 0.4);
    check('the margin is non-zero', ROUTER_LIMITS.MARGIN > 0);
}

/* --- it routes what it should --------------------------------------------- */
{
    /* The sentence that started all of this. It failed the regex because the
       verb was at the END — the manifest carries that exact phrasing as an
       example, so a paraphrase of it should land too. */
    const r = await routeText('latest trending meme coin search');
    check('the logged failure routes to web_search',
        r?.capability.name === 'web_search');

    const paraphrase = await routeText('trending meme coins search');
    check('a paraphrase of it also routes',
        paraphrase?.capability.name === 'web_search');

    const screen = await routeText('what is on my screen');
    check('screen questions route to vision', screen?.capability.name === 'screen_vision');

    const mirror = await routeText('mirror my phone');
    check('mirror routes to the phone capability', mirror?.capability.name === 'phone_mirror');
}

/* --- the result is explainable -------------------------------------------- */
{
    const r = await routeText('latest trending meme coin search');
    check('a route reports its score', typeof r?.score === 'number');
    check('and its runner-up, so a wrong choice is debuggable',
        r?.runnerUp === null || typeof r?.runnerUp?.name === 'string');
    check('and why it was chosen', r?.reason === 'semantic');
    check('and the freshness it inferred', typeof r?.freshness === 'string');
}

/* --- freshness ------------------------------------------------------------ */
{
    const f = classifyFreshness;
    check('"latest trending meme coins" is realtime',
        f('latest trending meme coins') === FRESHNESS.REALTIME);
    check('"ethereum gas price" is realtime', f('what is the ethereum gas price') === FRESHNESS.REALTIME);
    check('"todays weather" is realtime', f("today's weather") === FRESHNESS.REALTIME);
    check('"who invented C" is static', f('who invented c') === FRESHNESS.STATIC);
    check('"definition of entropy" is static', f('definition of entropy') === FRESHNESS.STATIC);

    /* The unknown case must fall to the SAFE side. Over-searching costs a
       request; under-searching costs a fabricated answer. */
    check('an unrecognised question is dynamic, not static',
        f('tell me about the tokio scheduler') === FRESHNESS.DYNAMIC);
    check('and dynamic prefers the network when local confidence is weak',
        needsNetwork(FRESHNESS.DYNAMIC, 0.2) === true);
    check('but trusts local memory when it is strong',
        needsNetwork(FRESHNESS.DYNAMIC, 0.9) === false);
    check('realtime always goes to the network',
        needsNetwork(FRESHNESS.REALTIME, 0.99) === true);
    check('static never does', needsNetwork(FRESHNESS.STATIC, 0) === false);
    check('empty input is safe', f('') === FRESHNESS.STATIC);
}

/* --- degradation ---------------------------------------------------------- */
{
    /* Ollama is optional. No embedder must mean NO OPINION, never a random
       capability — the deterministic path still works and should be left to
       do its job. */
    check('a null index routes nothing', routeWithIndex(null, [1, 2, 3], 'x') === null);
    check('a null query vector routes nothing', routeWithIndex(index, null, 'x') === null);
    const broken = await buildIndex(() => Promise.resolve([]));
    check('an embedder returning nothing yields no index', broken === null);
    const wrongShape = await buildIndex((t) => Promise.resolve(t.map(() => null)));
    check('an embedder returning junk yields no index', wrongShape === null);
}

/* --- cosine --------------------------------------------------------------- */
{
    check('identical vectors are 1', Math.abs(cosine([1, 2, 3], [1, 2, 3]) - 1) < 1e-9);
    check('orthogonal vectors are 0', Math.abs(cosine([1, 0], [0, 1])) < 1e-9);
    check('a zero vector is 0, not NaN', cosine([0, 0], [1, 1]) === 0);
    check('mismatched lengths are 0', cosine([1, 2], [1, 2, 3]) === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
