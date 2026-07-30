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

/* --- Morningstar / Q4 IR shape (probed 22 Jul 2026) ---------------------------
   A third publisher shape: Q4 Inc's IR platform. Trimmed from the real bodies.
   Two hazards are asserted here rather than described in a comment, because
   both would produce a confidently wrong answer about how current the data is. */
{
    // Real body, two items dropped. Note the channel claims to have been built
    // seven months AFTER its newest item.
    const Q4_PRESS = `<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel><title>Morningstar, Inc. Press Releases </title><link>http://suppliers.morningstar.com/</link><description>generated by Q4</description><category /><lastBuildDate>Tue, 21 Jul 2026 23:15:00 -0400</lastBuildDate><copyright>Copyright Q4 Inc. All rights reserved.</copyright><item><title>New Quarterly Report from Morningstar and PitchBook Brings Transparency to Rapidly Expanding Evergreen Fund Universe</title><guid>07c0f56f-8ee0-4f0a-8247-ffebc1010d6f</guid><description /><link>http://suppliers.morningstar.com/newsroom/news-archive/press-release-details/2025/New-Quarterly-Report/default.aspx</link><pubDate>Thu, 18 Dec 2025 09:00:00 -0500</pubDate></item><item><title>Morningstar, Inc. Increases Quarterly Dividend to 50 Cents Per Share</title><guid>07360e94-5e60-45e3-9ce1-cdc99bd110d3</guid><description /><link>http://suppliers.morningstar.com/newsroom/news-archive/press-release-details/2025/Dividend/default.aspx</link><pubDate>Wed, 10 Dec 2025 16:05:00 -0500</pubDate></item></channel></rss>`;

    // SEC filings feed: <guid> is a bare numeric FilingId, and <description/> is
    // self-closing and empty on every item.
    const Q4_SEC = `<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel><title>Morningstar, Inc. SEC Filings </title><lastBuildDate>Thu, 25 Jun 2026 16:40:56 -0400</lastBuildDate><item><title>Morningstar, Inc. - 8-K - Current report filing</title><guid>19563538</guid><description /><link>http://suppliers.morningstar.com/investor-relations/financials/sec-filings/sec-filings-details/default.aspx?FilingId=19563538</link><pubDate>Thu, 25 Jun 2026 00:00:00 -0400</pubDate></item><item><title>Morningstar, Inc. - 4 - Statement of Changes in Beneficial Ownership</title><guid>19484330</guid><description /><link>http://suppliers.morningstar.com/investor-relations/financials/sec-filings/sec-filings-details/default.aspx?FilingId=19484330</link><pubDate>Wed, 27 May 2026 00:00:00 -0400</pubDate></item></channel></rss>`;

    // The dead presentations feed, whose descriptions carry escaped iframes.
    const Q4_PRESENTATION = `<rss version="2.0"><channel><title>Morningstar, Inc. Presentations</title><lastBuildDate>Fri, 18 May 2018 09:00:00 -0400</lastBuildDate><item><title>2018 Shareholder Meeting </title><description>&lt;iframe src="//www.slideshare.net/slideshow/embed_code/key/qGcHRIkq1kMS2v" width="595"&gt;&lt;/iframe&gt;&lt;br /&gt;&lt;a href="http://s21.q4cdn.com/198919461/files/doc_presentations/2018/05/2018MORNASM.pdf"&gt;View this Presentation (PDF)&lt;/a&gt;</description><link>http://suppliers.morningstar.com/PresentationDetails/2018/2018-Shareholder-Meeting-/default.aspx</link><pubDate>Fri, 18 May 2018 09:00:00 -0400</pubDate></item></channel></rss>`;

    const MS_PRESS = { id: 'morningstar-press', title: 'Morningstar Inc press releases', domain: 'finance' };
    const MS_SEC = { id: 'morningstar-sec', title: 'Morningstar Inc SEC filings', domain: 'finance' };
    const MS_PRES = { id: 'morningstar-presentations', title: 'Morningstar Inc presentations', domain: 'finance' };

    const press = parseFeed(Q4_PRESS, MS_PRESS);
    check('q4: press items parse', press.length === 2, `${press.length}`);
    check('q4: empty self-closing description is not an error', press[0].summary === '', JSON.stringify(press[0].summary));

    /* THE HAZARD. The channel says 21 Jul 2026; the item says 18 Dec 2025.
       Freshness must come from the item or Jarvis will call eight-month-old
       news "the latest", every day, forever. */
    check('q4: freshness comes from the item, never lastBuildDate',
        press[0].published.startsWith('2025-12-18'), press[0].published);
    check('q4: lastBuildDate does not leak into any event',
        !press.some(e => String(e.published).startsWith('2026-07-21')));

    const sec = parseFeed(Q4_SEC, MS_SEC);
    check('q4: filing type survives in the title', /8-K/.test(sec[0].title), sec[0].title);
    check('q4: filing link kept whole, query string included',
        sec[0].url.includes('FilingId=19563538'), sec[0].url);
    check('q4: distinct filings get distinct ids', sec[0].id !== sec[1].id);

    const pres = parseFeed(Q4_PRESENTATION, MS_PRES);
    check('q4: escaped iframe markup is stripped from the summary',
        !/[<>]|iframe|slideshare\.net\/slideshow/i.test(pres[0].summary), pres[0].summary.slice(0, 80));
    check('q4: the PDF link text survives stripping', /View this Presentation/.test(pres[0].summary), pres[0].summary.slice(0, 80));

    /* Registry claims. The presentations feed serves 200 OK with valid items,
       so only the `verified` flag stops it being polled forever to re-learn a
       2018 shareholder meeting. */
    const ids = FEEDS.map(f => f.id);
    check('registry: morningstar sec + press registered', ids.includes('morningstar-sec') && ids.includes('morningstar-press'));
    check('registry: frozen presentations feed is recorded, not deleted', ids.includes('morningstar-presentations'));
    check('registry: frozen feed is never fetched',
        !activeFeeds().some(f => f.id === 'morningstar-presentations'));
    check('registry: the two live morningstar feeds ARE fetched',
        activeFeeds('finance').filter(f => f.id.startsWith('morningstar-')).length === 2);
    check('registry: every unverified feed states why',
        FEEDS.filter(f => !f.verified).every(f => typeof f.error === 'string' && f.error.length > 10));

    /* The Symbol parameter is ignored by the endpoint (Apple's CIK returns
       Morningstar's filings). Assert nothing in the codebase templates a CIK
       into it, which is the mistake the URL shape invites. */
    const msSec = FEEDS.find(f => f.id === 'morningstar-sec');
    check('registry: morningstar filings URL is pinned to its own CIK',
        msSec.url.includes('Symbol=0001289419') && !/\$\{|%s/.test(msSec.url), msSec.url);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
