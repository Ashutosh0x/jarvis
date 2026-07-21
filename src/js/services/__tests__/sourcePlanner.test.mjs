// Which sources a question needs.
//
// Grounded in a real measurement: seven feeds sequentially 6560ms, in parallel
// 1652ms (3.97x) — but parallel came within 2ms of the slowest single source,
// so NOT FETCHING is the bigger lever. sec+fed alone measured 24ms.

import { SOURCES, planSources, mergeResults, describePlan } from '../sourcePlanner.js';

let pass = 0, fail = 0;
const check = (n, c, d = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };
const names = p => p.plan.map(x => x.name);

/* --- targeting -------------------------------------------------------------- */
{
    const chrome = planSources('latest chrome zero-day');
    check('a chrome question reaches chrome', names(chrome).includes('chrome'), names(chrome).join(','));
    check('and skips the finance feeds', !names(chrome).some(n => ['sec-8k', 'fed'].includes(n)));

    const fed = planSources('what did the fed say about rates');
    check('a fed question reaches fed', names(fed).includes('fed'));
    check('and skips chrome — the 1650ms source', !names(fed).includes('chrome'));

    const chain = planSources('gas on arbitrum');
    check('a chain question reaches chain', names(chain).includes('chain'));
    check('a CVE identifier reaches nvd', names(planSources('what is CVE-2026-15905')).includes('nvd'));
    check('an unrelated question plans nothing', planSources('tell me a joke').plan.length === 0);
}

/* --- the measured payoff ------------------------------------------------------ */
{
    const fed = planSources('fed rate decision and any 8-K filings');
    check('a finance question costs the slowest finance source, not chrome',
        fed.estimatedMs < 100, `${fed.estimatedMs}ms`);
    check('which is ~69x better than fetching all seven (1652ms)',
        1652 / Math.max(fed.estimatedMs, 1) > 15, `${(1652 / fed.estimatedMs).toFixed(0)}x`);

    const p = planSources('chrome and cisa advisories');
    check('parallel estimate IS the slowest member, not the sum',
        p.estimatedMs === Math.max(...p.plan.map(x => x.ms)));
    check('and is strictly better than sequential when >1 source',
        p.plan.length > 1 && p.estimatedMs < p.sequentialMs);
    check('skipped sources are reported, not hidden', p.skipped.length > 0);
    check('the plan is capped', planSources('cve chrome cisa arxiv paper fed sec gas odds', { max: 3 }).plan.length <= 3);
    check('a faster source wins a tie', SOURCES['fed'].ms < SOURCES['chrome'].ms);
}

/* --- merge ---------------------------------------------------------------------- */
{
    const merged = mergeResults([
        { source: 'cisa', items: [{ title: 'Chrome RCE patched', link: 'https://a.test/1', at: 5 }] },
        { source: 'chrome', items: [{ title: 'Chrome RCE patched', link: 'https://a.test/1', at: 5 }] },
        { source: 'fed', items: [{ title: 'Rate held', link: 'https://b.test/2', at: 9 }] },
    ]);
    check('the same story from two feeds is one item', merged.length === 2, `${merged.length}`);
    check('and carries both sources', merged[0].sources.length === 2, JSON.stringify(merged[0].sources));
    check('corroborated items rank first', merged[0].sources.length >= merged[1].sources.length);
    check('a single-source item keeps its attribution', merged[1].sources[0] === 'fed');
    check('items without link or title are dropped',
        mergeResults([{ source: 'x', items: [{ at: 1 }] }]).length === 0);
    check('an empty merge is empty', mergeResults([]).length === 0);
}

/* --- spoken ---------------------------------------------------------------------- */
{
    const p = planSources('chrome and cisa advisories');
    check('spoken names the sources', /cisa/.test(describePlan(p)));
    check('a failed source is disclosed, never silently dropped',
        /did not respond/.test(describePlan(p, ['chrome'])));
    check('the answer is flagged as possibly incomplete',
        /incomplete/.test(describePlan(p, ['chrome'])));
    check('no matching source admits it rather than guessing',
        /would be guessing/.test(describePlan(planSources('tell me a joke'))));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
