// Failure signals from real use.
//
// The 1000-prompt harness measures routing against prompts I wrote — it
// measures my imagination. This measures what actually went wrong in front of
// the user. Fixtures below are shapes taken from the real interaction log.

import {
    similarity, analyze, rankFallbacks, describeFailures, REPHRASE_THRESHOLD,
    resolutionChains, health, suggestions, WEIGHTS,
} from '../feedback.js';

let pass = 0, fail = 0;
const check = (n, c, d = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };
const T = (ts, input, intent, latencyMs = 1000) => ({ ts, input, intent, latencyMs });

/* --- similarity ------------------------------------------------------------- */
{
    check('a shorter rephrase still scores high',
        similarity('analyze apple stocks', 'analyze apple') >= REPHRASE_THRESHOLD,
        String(similarity('analyze apple stocks', 'analyze apple')));
    check('identical text scores 1', similarity('analyze microsoft', 'analyze microsoft') === 1);
    check('unrelated questions score low', similarity('price of tesla', 'gas on arbitrum') < 0.3);
    check('stopwords do not create false similarity',
        similarity('what is the price of apple', 'what is the news') < REPHRASE_THRESHOLD,
        String(similarity('what is the price of apple', 'what is the news')));
    check('empty input scores 0', similarity('', 'anything') === 0);
}

/* --- rephrase detection ------------------------------------------------------ */
{
    const a = analyze([
        T(1000, 'analyze apple stocks', 'QUANT_QUERY'),
        T(9000, 'analyze apple', 'QUANT_QUERY'),
    ]);
    check('a near-repeat within the window is a rephrase', a.rephrases.length === 1);
    check('the rephrase records both wordings', a.rephrases[0].first.includes('stocks') && a.rephrases[0].second === 'analyze apple');

    const slow = analyze([T(0, 'analyze apple stocks', 'QUANT_QUERY'), T(600000, 'analyze apple', 'QUANT_QUERY')]);
    check('the same question ten minutes later is NOT a rephrase', slow.rephrases.length === 0);

    const different = analyze([T(0, 'price of tesla', 'PRICE_QUERY'), T(5000, 'gas on arbitrum', 'CHAIN_QUERY')]);
    check('consecutive unrelated questions are not rephrases', different.rephrases.length === 0);
}

/* --- corrections -------------------------------------------------------------- */
{
    const a = analyze([
        T(0, 'what is on my screen', 'AI_COMMAND'),
        T(4000, "no, that's not what I meant", 'AI_COMMAND'),
    ]);
    check('an explicit correction is caught', a.corrections.length === 1);
    check('the correction points at the turn it corrects',
        a.corrections[0].correcting === 'what is on my screen');
    check('a bare "no" counts', analyze([T(0, 'x', 'A'), T(1, 'no', 'A')]).corrections.length === 1);
    check('"november" does not count as "no"',
        analyze([T(0, 'x', 'A'), T(1, 'november earnings', 'A')]).corrections.length === 0);
    check('a first turn cannot be a correction', analyze([T(0, 'no', 'A')]).corrections.length === 0);
}

/* --- missed handlers ----------------------------------------------------------
   The failure this project keeps finding: a factual question reaches the model,
   which answers it from nothing. */
{
    const a = analyze([
        T(0, 'How much is bitcoin', 'AI_COMMAND', 11000),
        T(2, "What's the annualized return on Google?", 'AI_COMMAND', 11000),
        T(3, 'list latest vulnerabilities in chrome', 'AI_COMMAND', 14000),
        T(4, 'gas on bsc', 'AI_COMMAND', 9000),
        T(5, 'tell me a joke', 'AI_COMMAND', 3000),
    ]);
    check('four deterministic questions flagged, the joke is not', a.fallbacks.length === 4, `${a.fallbacks.length}`);
    check('each is attributed to the handler that should have caught it',
        new Set(a.fallbacks.map(f => f.shouldBe)).size === 4);

    const ranked = rankFallbacks(a.fallbacks);
    check('ranked by count with wasted model time summed',
        ranked.every(g => g.count >= 1 && g.wastedMs > 0));
    check('an open-ended question is never counted as a miss',
        !a.fallbacks.some(f => /joke/.test(f.input)));
    check('a correctly-routed turn is not a miss',
        analyze([T(0, 'price of tesla', 'PRICE_QUERY')]).fallbacks.length === 0);
}

/* --- per-path failure rates ---------------------------------------------------- */
{
    const turns = [];
    // One path that works, one that keeps being rephrased.
    for (let i = 0; i < 6; i++) turns.push(T(i * 200000, `gas on chain ${i}`, 'CHAIN_QUERY'));
    for (let i = 0; i < 4; i++) { turns.push(T(1e7 + i * 20000, 'how is my wifi', 'WIFI_INFO')); turns.push(T(1e7 + i * 20000 + 5000, 'how is my wifi', 'WIFI_INFO')); }
    const a = analyze(turns);
    const wifi = a.worstIntents.find(x => x.intent === 'WIFI_INFO');
    check('a repeatedly-rephrased path surfaces as weakest', a.worstIntents[0].intent === 'WIFI_INFO', a.worstIntents[0]?.intent);
    check('its failure rate is reported', wifi.failRate > 0.3, String(wifi?.failRate));
    check('a path with no failures is absent from the ranking',
        !a.worstIntents.some(x => x.intent === 'CHAIN_QUERY'));
    check('paths under 3 turns are excluded — one rephrase of two is not 50% signal',
        !analyze([T(0, 'x y z', 'RARE'), T(1000, 'x y z', 'RARE')]).worstIntents.some(w => w.intent === 'RARE'));
}

/* --- spoken -------------------------------------------------------------------- */
{
    const a = analyze([
        T(0, 'How much is bitcoin', 'AI_COMMAND', 11000),
        T(2000, 'How much is bitcoin', 'AI_COMMAND', 11000),
    ]);
    const said = describeFailures(a);
    check('spoken names the missed handler', /reached the model/.test(said), said.slice(0, 70));
    check('spoken counts rephrases', /rephrased/.test(said));
    check('spoken blames the system, not the user',
        !/you (were|are) (unclear|vague|wrong)/i.test(said));
    check('an empty log is stated plainly', /no interaction history/.test(describeFailures(null)));
    check('a clean log says so', /no rephrases, corrections, or missed handlers/.test(
        describeFailures(analyze([T(0, 'price of tesla', 'PRICE_QUERY')]))));
}

/* --- resolution chains ----------------------------------------------------------
   A run of rephrases on one subject is ONE struggle, not N failures. */
{
    const chains = resolutionChains([
        T(0, 'analyze microsoft for me', 'QUANT_QUERY'),
        T(5000, 'analyze microsoft', 'QUANT_QUERY'),
        T(9000, 'microsoft analyze', 'QUANT_QUERY'),
        T(20000, 'gas on arbitrum', 'CHAIN_QUERY'),
    ], 20000);
    check('three wordings collapse into one chain', chains.length === 1, `${chains.length}`);
    check('the chain counts its turns', chains[0].turns === 3, String(chains[0]?.turns));
    check('moving on to a new subject marks it resolved', chains[0].resolved === true);

    const stopped = resolutionChains([
        T(0, 'how is my wifi', 'WIFI_INFO'),
        T(5000, 'how is my wifi', 'WIFI_INFO'),
    ], 5000 + 700000);
    check('a struggle with nothing after it is abandoned', stopped[0].abandoned === true);
    check('a single clean turn forms no chain', resolutionChains([T(0, 'price of tesla', 'PRICE')], 0).length === 0);
}

/* --- weighted health ------------------------------------------------------------- */
{
    const turns = [];
    for (let i = 0; i < 10; i++) turns.push(T(i * 900000, `gas on chain ${i}`, 'CHAIN_QUERY'));
    turns.push(T(2e7, 'how is my wifi', 'WIFI_INFO'));
    turns.push(T(2e7 + 5000, 'how is my wifi', 'WIFI_INFO'));
    turns.push(T(2e7 + 9000, 'no', 'WIFI_INFO'));
    turns.push(T(2e7 + 12000, 'wifi status', 'WIFI_INFO'));
    const a = analyze(turns);
    const rows = health(a, resolutionChains(turns, 2e7 + 12000));
    const wifi = rows.find(r => r.intent === 'WIFI_INFO');
    const chain = rows.find(r => r.intent === 'CHAIN_QUERY');
    check('a correction outweighs a rephrase', WEIGHTS.corrected > WEIGHTS.rephrased);
    check('the failing path scores worse than the clean one', wifi.per100 > (chain?.per100 ?? 0));
    check('a clean path scores zero', (chain?.per100 ?? 0) === 0, String(chain?.per100));
    check('per100 normalizes so popular paths are not punished for volume',
        rows.every(r => r.per100 <= 100 * (r.score / Math.max(r.turns, 1)) + 0.1));
    check('rare paths are excluded from health', !rows.some(r => r.turns < 3));
}

/* --- promotion gate --------------------------------------------------------------
   arXiv 2507.23158: implicit feedback is a lens on users, NOT a reliable direct
   learning signal. Everything here must stay a suggestion. */
{
    const turns = [];
    for (let i = 0; i < 4; i++) turns.push(T(i * 900000, `how much is stock${i}`, 'AI_COMMAND', 9000));
    const a = analyze(turns);
    const s = suggestions(a, resolutionChains(turns, 4e6));
    check('a repeated missed shape becomes a suggestion', s.length >= 1);
    check('every suggestion is marked for review, never auto-applied',
        s.every(x => x.confidence === 'review'));
    check('the suggestion warns that the resolver may be at fault, not the route',
        /resolver/i.test(s[0].note));
    check('a single occurrence does not reach the gate',
        suggestions(analyze([T(0, 'how much is intel', 'AI_COMMAND', 9000)]), []).length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
