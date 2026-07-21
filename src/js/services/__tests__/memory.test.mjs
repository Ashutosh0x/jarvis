// Typed, revisable project memory.
//
// The behaviour that matters is supersession: a rolling summary keeps both "we
// use Etherscan" and "we replaced Etherscan" with no way to tell which holds.

import { TYPES, makeRecord, write, prune, retrieve, planCompaction, render } from '../memory.js';

let pass = 0, fail = 0;
const check = (n, c, d = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };
const DAY = 86400000;
const T0 = 1_750_000_000_000;

/* --- record construction ------------------------------------------------------ */
{
    check('a record needs a known type',
        makeRecord({ type: 'nonsense', text: 'x' }, T0).ok === false);
    check('a record needs text', makeRecord({ type: 'decision', text: '  ' }, T0).ok === false);
    check('an unknown domain falls back to general',
        makeRecord({ type: 'decision', domain: 'astrology', text: 'x' }, T0).record.domain === 'general');
    check('sources default to empty, so unsourced is visible not assumed',
        makeRecord({ type: 'decision', text: 'x' }, T0).record.sources.length === 0);
}

/* --- supersession: the whole point -------------------------------------------- */
{
    let s = [];
    ({ store: s } = write(s, { type: 'decision', domain: 'chain', text: 'use Etherscan for fund tracing', id: 'd1' }, T0));
    const r = write(s, { type: 'decision', domain: 'chain', text: 'replaced Etherscan with our own indexer', supersedes: 'd1' }, T0 + DAY);

    check('a revision replaces rather than appends', r.store.length === 1, `${r.store.length}`);
    check('the action is reported as a revision', r.action === 'revise');
    check('the surviving text is the new one', /own indexer/.test(r.store[0].text));
    check('the superseded text is kept one hop back', /Etherscan for fund/.test(r.store[0].previous));
    check('the revision is counted', r.store[0].revisions === 1);
    check('the id is stable across revision', r.store[0].id === 'd1');

    const missing = write([], { type: 'decision', text: 'x', supersedes: 'ghost' }, T0);
    check('superseding a missing record still stores it', missing.action === 'insert');
    check('and says why', /missing/.test(missing.reason));
}

/* --- benchmarks are measurements, not opinions -------------------------------- */
{
    let s = [];
    ({ store: s } = write(s, { type: 'benchmark', domain: 'routing', text: 'routing accuracy 88.0%', id: 'b1' }, T0));
    const r = write(s, { type: 'benchmark', domain: 'routing', text: 'routing accuracy 99.4%', supersedes: 'b1' }, T0 + DAY);
    check('a benchmark is never overwritten — the series survives', r.store.length === 2, `${r.store.length}`);
    check('the old measurement is still readable', r.store.some(x => /88\.0/.test(x.text)));
    check('and the reason is stated', /not revisable/.test(r.reason));
    check('non-revisable types are marked as such', TYPES.benchmark.revisable === false && TYPES.decision.revisable === true);
}

/* --- retention is per type, not per age --------------------------------------- */
{
    const store = [
        { id: 'a', type: 'decision', domain: 'chain', text: 'old but binding', at: T0 - 900 * DAY },
        { id: 'b', type: 'constraint', domain: 'general', text: 'never hardcode lookup tables', at: T0 - 900 * DAY },
        { id: 'c', type: 'benchmark', domain: 'routing', text: 'stale number', at: T0 - 200 * DAY },
        { id: 'd', type: 'todo', domain: 'general', text: 'old todo', at: T0 - 100 * DAY },
        { id: 'e', type: 'benchmark', domain: 'routing', text: 'recent number', at: T0 - 10 * DAY },
    ];
    const { store: kept, dropped } = prune(store, T0);
    check('a two-year-old decision survives', kept.some(r => r.id === 'a'));
    check('a two-year-old constraint survives', kept.some(r => r.id === 'b'));
    check('a stale benchmark expires', dropped.some(r => r.id === 'c'));
    check('a stale todo expires', dropped.some(r => r.id === 'd'));
    check('a recent benchmark survives', kept.some(r => r.id === 'e'));
}

/* --- retrieval ------------------------------------------------------------------ */
{
    const store = [
        { id: '1', type: 'decision', domain: 'chain', text: 'chose Alchemy over Infura for chain reads', at: T0 - 30 * DAY },
        { id: '2', type: 'benchmark', domain: 'routing', text: 'chain routing measured at 99 percent', at: T0 - 30 * DAY },
        { id: '3', type: 'bug', domain: 'chain', text: 'whale double count fixed by per transaction aggregation', at: T0 - 5 * DAY },
        { id: '4', type: 'decision', domain: 'news', text: 'feeds parsed as Atom not RSS', at: T0 - 5 * DAY },
    ];
    const hits = retrieve(store, 'why did we choose Alchemy for chain reads', { now: T0 });
    check('the matching decision ranks first', hits[0].record.id === '1', hits[0]?.record?.id);
    check('an unrelated record is not returned', !hits.some(h => h.record.id === '4'));
    check('an empty query returns nothing', retrieve(store, '   ', { now: T0 }).length === 0);
    check('scores are ordered', hits.every((h, i) => i === 0 || hits[i - 1].score >= h.score));

    const decisionFirst = retrieve(store, 'chain', { now: T0 });
    check('a decision outranks a benchmark at equal overlap and age',
        decisionFirst[0].record.type === 'decision', decisionFirst[0]?.record?.type);
    check('the domain boost applies',
        retrieve(store, 'chain', { domain: 'chain', now: T0 })[0].record.domain === 'chain');
    check('limit is honoured', retrieve(store, 'chain routing whale feeds', { limit: 2, now: T0 }).length <= 2);
}

/* --- domain-partitioned compaction ---------------------------------------------
   The transferable half of arXiv 2605.23296: control volume per partition rather
   than asking a model for "shorter", which that paper measures as ignored. */
{
    const store = [];
    for (let i = 0; i < 20; i++) store.push({ id: `n${i}`, type: 'benchmark', domain: 'news', text: `run ${i}`, at: T0 - (20 - i) * DAY });
    for (let i = 0; i < 3; i++) store.push({ id: `d${i}`, type: 'decision', domain: 'news', text: `decision ${i}`, at: T0 - i * DAY });
    for (let i = 0; i < 2; i++) store.push({ id: `c${i}`, type: 'decision', domain: 'chain', text: `chain decision ${i}`, at: T0 });

    const plan = planCompaction(store, { maxPerDomain: 12, now: T0 });
    check('only the over-full domain is planned', plan.length === 1 && plan[0].domain === 'news', `${plan.length}`);
    check('decisions are never scheduled for compaction',
        !plan[0].ids.some(id => id.startsWith('d')));
    check('only low-weight types are compacted', plan[0].types.every(t => TYPES[t].weight < 0.8));
    check('the oldest are compacted first', plan[0].ids.includes('n0'));
    check('a small domain is left alone', !plan.some(p => p.domain === 'chain'));
    check('nothing is planned when every domain is small',
        planCompaction(store.slice(-2), { maxPerDomain: 12, now: T0 }).length === 0);
}

/* --- render ---------------------------------------------------------------------- */
{
    const out = render([
        { type: 'decision', domain: 'chain', text: 'chose Alchemy', sources: ['probe'], revisions: 2 },
        { type: 'bug', domain: 'news', text: 'atom link in attribute', sources: [] },
    ]);
    check('sourced records say so', /1 source/.test(out));
    check('unsourced records are marked, not hidden', /unsourced/.test(out));
    check('revisions are visible', /revised 2x/.test(out));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
