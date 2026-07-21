// Feed ingestion: parsing, provenance, dedup.
//
// Fixtures are trimmed from REAL responses captured 21 Jul 2026. The two shapes
// matter: SEC EDGAR serves Atom (<entry>, link in an attribute), the Fed and
// arXiv serve RSS (<item>, link in the body). A parser tested on only one of
// them silently drops every event from the other.

import {
    FEEDS, activeFeeds, parseFeed, dedupe, since,
    toMemoryText, groupByDomain, describeBrief,
} from '../feeds.js';

let pass = 0, fail = 0;
const check = (n, c, d = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

const RSS = `<rss><channel>
<item><title>Fed issues joint statement on capital requirements</title>
<link>https://www.federalreserve.gov/newsevents/pressreleases/bcreg20260721a.htm</link>
<description>&lt;p&gt;The agencies issued a &lt;b&gt;joint statement&lt;/b&gt; today.&lt;/p&gt;</description>
<pubDate>Tue, 21 Jul 2026 14:30:00 GMT</pubDate></item>
<item><title>Minutes of the discount rate meetings</title>
<link>https://www.federalreserve.gov/newsevents/pressreleases/monetary20260716a.htm</link>
<description>Minutes covering June 2026.</description>
<pubDate>Thu, 16 Jul 2026 18:00:00 GMT</pubDate></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
<entry><title>8-K - SAN JUAN BASIN ROYALTY TRUST (0000319655) (Filer)</title>
<link rel="alternate" type="text/html" href="https://www.sec.gov/Archives/edgar/data/319655/000119.htm"/>
<summary type="html">Material corporate event filed 2026-07-21.</summary>
<updated>2026-07-21T13:05:00-04:00</updated></entry>
<entry><title>8-K - APPLE INC (0000320193) (Filer)</title>
<link rel="alternate" href="https://www.sec.gov/Archives/edgar/data/320193/000200.htm"/>
<updated>2026-07-20T09:15:00-04:00</updated></entry>
</feed>`;

const FED = { id: 'fed-press', title: 'Federal Reserve press', domain: 'finance' };
const SEC = { id: 'sec-8k', title: 'SEC latest 8-K filings', domain: 'finance' };

/* --- both shapes must parse ------------------------------------------------ */
{
    const rss = parseFeed(RSS, FED);
    check('rss: both items parsed', rss.length === 2, `${rss.length}`);
    check('rss: title cleaned', rss[0].title === 'Fed issues joint statement on capital requirements');
    check('rss: html stripped from the summary', !/[<>]/.test(rss[0].summary) && /joint statement/.test(rss[0].summary), rss[0].summary);
    check('rss: link taken from the element body', /federalreserve\.gov/.test(rss[0].url));
    check('rss: publisher date parsed', rss[0].published.startsWith('2026-07-21'), rss[0].published);

    const atom = parseFeed(ATOM, SEC);
    check('atom: entries parsed, not just items', atom.length === 2, `${atom.length}`);
    check('atom: link read from the href ATTRIBUTE', /sec\.gov\/Archives/.test(atom[0].url), atom[0].url);
    check('atom: <updated> used when there is no pubDate', atom[0].published.startsWith('2026-07-21'));
    check('atom: an entry with no summary still parses', atom[1].title.includes('APPLE'));
}

/* --- provenance ------------------------------------------------------------- */
{
    const e = parseFeed(RSS, FED, { now: 1_800_000_000_000 })[0];
    check('provenance: source named', e.source === 'Federal Reserve press');
    check('provenance: domain carried', e.domain === 'finance');
    check('provenance: url kept for citation', e.url.length > 10);
    check('provenance: publisher time and ingest time are SEPARATE fields',
        e.publishedTs !== e.ingestedAt && e.ingestedAt === 1_800_000_000_000);
    check('provenance: an undated entry yields null, not "now"',
        parseFeed('<rss><item><title>No date here</title></item></rss>', FED)[0].published === null);
}

/* --- dedup and windows ------------------------------------------------------ */
{
    const first = parseFeed(RSS, FED);
    check('dedup: ids are stable across identical parses',
        parseFeed(RSS, FED)[0].id === first[0].id);
    check('dedup: everything is new against an empty set', dedupe(first, new Set()).length === 2);
    check('dedup: nothing is new when all ids are seen',
        dedupe(first, new Set(first.map(e => e.id))).length === 0);
    check('dedup: newest first', dedupe(first, new Set())[0].publishedTs >= dedupe(first, new Set())[1].publishedTs);
    check('dedup: different titles get different ids', first[0].id !== first[1].id);

    const cutoff = Date.parse('2026-07-18T00:00:00Z');
    check('window: only events after the cutoff', since(first, cutoff).length === 1);
    check('window: an UNDATED event is excluded, never assumed recent',
        since(parseFeed('<rss><item><title>Undated</title></item></rss>', FED), 0).length === 0);
}

/* --- registry honesty -------------------------------------------------------- */
{
    check('registry: only probe-verified feeds are active',
        activeFeeds().every(f => f.verified === true));
    check('registry: failures are RETAINED with their reason, not deleted',
        FEEDS.some(f => !f.verified && f.error), FEEDS.filter(f => !f.verified).map(f => f.id).join(', '));
    check('registry: the timed-out Treasury feed is not fetched',
        !activeFeeds().some(f => f.id === 'treasury-press'));
    check('registry: CISA KEV is excluded because it is JSON, and says so',
        /JSON/.test(FEEDS.find(f => f.id === 'cisa-kev').error));
    check('registry: SEC entries are flagged as needing a User-Agent',
        activeFeeds('finance').filter(f => f.id.startsWith('sec-')).every(f => f.needsUserAgent));
    check('registry: domain filter works', activeFeeds('research').every(f => f.domain === 'research'));
}

/* --- memory contribution ------------------------------------------------------ */
{
    const e = parseFeed(RSS, FED)[0];
    const text = toMemoryText(e);
    check('memory: dated and attributed', /^\[2026-07-21\] Federal Reserve press:/.test(text), text.slice(0, 60));
    check('memory: kept short so it cannot crowd the corpus', text.length < 320, `${text.length}`);
    check('memory: an undated event is still storable', /undated/.test(toMemoryText({ title: 'x', source: 's' })));
    check('memory: a titleless event contributes nothing', toMemoryText({ source: 's' }) === null);
}

/* --- brief ------------------------------------------------------------------- */
{
    const all = [...parseFeed(RSS, FED), ...parseFeed(ATOM, SEC)];
    const grouped = groupByDomain(all);
    check('brief: grouped by domain', grouped.finance.length === 4);
    const said = describeBrief(all);
    check('brief: counts stated', /4 new items/.test(said), said.slice(0, 60));
    check('brief: leads with the most recent', /Fed issues joint statement|SAN JUAN/.test(said));
    check('brief: an empty window says so plainly', /Nothing new/.test(describeBrief([])));
    check('brief: makes no claim about what events MEAN',
        !/because|caused|means|suggests|implies/i.test(said), said);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
