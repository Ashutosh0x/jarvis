// The promotion gate.
//
// The behaviour under test is the one from arXiv 2607.02579: repeated mentions
// sharing a dependency are ONE piece of evidence. Counting them as many is how a
// fabricated CVE severity becomes a permanent record.

import {
    classify, effectiveSupport, confidence, gate, findContradiction, describeGate,
    PROMOTE_THRESHOLD, REVIEW_THRESHOLD,
} from '../extraction.js';

let pass = 0, fail = 0;
const check = (n, c, d = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };
const O = (origin, originId) => ({ origin, originId });

/* --- classification -------------------------------------------------------------- */
{
    check('a decision is recognized', classify('we replaced Etherscan with our own indexer') === 'decision');
    check('a constraint is recognized', classify('never hardcode lookup tables') === 'constraint');
    check('a benchmark is recognized by its number', classify('routing accuracy 99.4%') === 'benchmark');
    check('a reference is recognized', classify('see arxiv 2607.02579') === 'reference');
    check('ordinary chatter is not a candidate', classify('good morning') === null);
    check('empty text is not a candidate', classify('   ') === null);
}

/* --- re-derivable answers are not memory -------------------------------------------
   Found by running the gate over the real 229-turn log: 23 of 43 promotions were
   stock quotes. They carry numbers, so they look like benchmarks, but they are
   live-data answers that are stale within a day. */
{
    check('a stock quote is not a benchmark',
        classify('Over the past year, Apple Inc. returned 55.2 percent annualized') === null);
    check('a sharpe ratio answer is not a benchmark',
        classify('NVIDIA has a one-year Sharpe ratio of 0.41') === null);
    check('a beta answer is not a benchmark',
        classify('Apple Inc. has a beta of 0.87 to the S&P 500') === null);
    check('a gas reading is not a benchmark',
        classify('gas on arbitrum is 0.ed 12 gwei'.replace('ed ', '')) === null);
    check('a market probability is not a benchmark',
        classify('the odds are 62 percent on Polymarket') === null);

    check('a measurement OF THE SYSTEM is still a benchmark',
        classify('routing accuracy 99.4% across 1000 prompts') === 'benchmark');
    check('a latency measurement of the system survives',
        classify('1287 checks in 7000 ms') === 'benchmark');
    check('a transient answer is rejected outright by the gate',
        gate({ text: 'Tesla returned 12.6 percent annualized' },
            [O('handler', 'quant-1')]).verdict === 'reject');
}

/* --- effective support: THE rule --------------------------------------------------
   Five mentions from one model turn is one dependency, not five. */
{
    const repeated = effectiveSupport([
        O('model', 'turn-42'), O('model', 'turn-42'), O('model', 'turn-42'),
        O('model', 'turn-42'), O('model', 'turn-42'),
    ]);
    check('five mentions of one origin count as one', repeated.effective === 1, `${repeated.effective}`);
    check('the raw mention count is still reported', repeated.mentions === 5);

    const independent = effectiveSupport([O('model', 'turn-42'), O('verified', 'probe-1'), O('user', 'turn-50')]);
    check('three distinct origins count as three', independent.effective === 3);
    check('the strongest origin is identified', independent.strongest === 'verified');

    check('unknown origins are discarded', effectiveSupport([O('astrology', 'x')]).effective === 0);
    check('no observations means no support', effectiveSupport([]).effective === 0);
}

/* --- confidence -------------------------------------------------------------------- */
{
    const modelOnly = confidence(effectiveSupport([O('model', 'a')]));
    const verified = confidence(effectiveSupport([O('verified', 'probe')]));
    check('a verified origin outscores a model claim', verified > modelOnly, `${verified} vs ${modelOnly}`);
    check('a lone model claim scores below the promote bar', modelOnly < PROMOTE_THRESHOLD);

    const repeatedModel = confidence(effectiveSupport([O('model', 'a'), O('model', 'a'), O('model', 'a')]));
    check('repeating a model claim does not raise its confidence', repeatedModel === modelOnly,
        `${repeatedModel} vs ${modelOnly}`);

    const corroborated = confidence(effectiveSupport([O('model', 'a'), O('verified', 'probe')]));
    check('a second independent origin raises confidence', corroborated > verified);
    check('confidence never reaches certainty', confidence(effectiveSupport(
        [O('verified', '1'), O('verified', '2'), O('user', '3'), O('handler', '4')])) < 1.0);
    check('no support scores zero', confidence(effectiveSupport([])) === 0);
    check('a contradiction caps confidence',
        confidence(effectiveSupport([O('verified', 'p')]), { contradicted: true }) <= REVIEW_THRESHOLD);
}

/* --- the gate ------------------------------------------------------------------------
   Three outcomes, never two. */
{
    const promoted = gate({ text: 'we replaced Etherscan with our own indexer', domain: 'chain' },
        [O('user', 't1'), O('verified', 'commit-580c73c')], { now: 1 });
    check('a user-stated, verified decision is promoted', promoted.verdict === 'promote', promoted.verdict);
    check('the promoted record carries its sources', promoted.record.sources.length === 2);
    check('the promoted record carries its confidence', promoted.record.confidence > PROMOTE_THRESHOLD);
    check('the reason names the evidence', /independent origin/.test(promoted.reason));

    /* The path that produced a fabricated CVE severity. */
    const modelClaim = gate({ text: 'CVE-2026-15905 is rated Critical', domain: 'security' },
        [O('model', 'turn-9'), O('model', 'turn-9'), O('model', 'turn-11')], { now: 1 });
    check('a model-only claim is NEVER promoted outright', modelClaim.verdict === 'review', modelClaim.verdict);
    check('and the reason says why', /model-only/.test(modelClaim.reason));
    check('repetition did not rescue it', modelClaim.support.effective === 2 && modelClaim.verdict !== 'promote');

    check('untyped text is rejected', gate({ text: 'good morning' }, [O('user', 't')]).verdict === 'reject');
    check('empty text is rejected', gate({ text: '  ' }, [O('user', 't')]).verdict === 'reject');
    check('no origin is rejected', gate({ text: 'we chose Alchemy' }, []).verdict === 'reject');
    check('a rejected candidate yields no record', gate({ text: 'good morning' }, [O('user', 't')]).record === null);
    check('a review verdict yields no record either', modelClaim.record === null);
    check('every verdict carries a reason',
        [promoted, modelClaim].every(r => typeof r.reason === 'string' && r.reason.length));
}

/* --- contradiction detection ---------------------------------------------------------- */
{
    const store = [
        { id: 'd1', type: 'decision', domain: 'chain', text: 'we use Etherscan for fund tracing' },
        { id: 'd2', type: 'decision', domain: 'news', text: 'feeds parsed as Atom' },
    ];
    const hit = findContradiction(store, { type: 'decision', text: 'we no longer use Etherscan for fund tracing' });
    check('an opposite-polarity claim on the same subject is flagged', hit?.id === 'd1', hit?.id);
    check('an unrelated claim is not flagged',
        findContradiction(store, { type: 'decision', text: 'we chose Postgres for storage' }) === null);
    check('agreement is not a contradiction',
        findContradiction(store, { type: 'decision', text: 'we use Etherscan for fund tracing daily' }) === null);

    const contradicted = gate({ text: 'we no longer use Etherscan for fund tracing', domain: 'chain' },
        [O('user', 't1'), O('verified', 'commit-x')], { contradicted: true });
    check('a contradicted candidate goes to review, not straight in', contradicted.verdict === 'review');
    check('even with strong support', contradicted.support.effective === 2);
}

/* --- spoken ------------------------------------------------------------------------------ */
{
    const results = [{ verdict: 'promote' }, { verdict: 'review' }, { verdict: 'review' }, { verdict: 'reject' }];
    const said = describeGate(results);
    check('spoken reports all three outcomes', /1 promoted/.test(said) && /2 held for review/.test(said) && /1 rejected/.test(said), said);
    check('an empty batch is stated plainly', /Nothing was extracted/.test(describeGate([])));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
