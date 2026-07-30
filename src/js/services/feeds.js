/**
 * @fileoverview Continuous ingestion — feed registry and event normalisation.
 *
 * PURE: parsing and shaping only. No network, no clock except where passed.
 *
 * WHY THIS EXISTS, measured rather than assumed: Jarvis has seen 227 turns of
 * real conversation but its retrieval corpus holds 2 chunks and 134 characters,
 * and zero durable beliefs. The retrieval engine is benchmarked and works; it
 * has almost nothing to retrieve. Memory that only fills when the user happens
 * to say something quotable will always be empty. Continuous ingestion is what
 * gives it a corpus.
 *
 * EVERY FEED BELOW WAS PROBED BEFORE BEING WRITTEN DOWN (21 Jul 2026), because
 * pasted endpoints have been wrong four times in this project: Polymarket's
 * ?title= does not filter, Kalshi's category= is silently ignored, Bing's RSS
 * returns HTML for non-topic queries, and Chrome's "latest post" is not its
 * latest security post. Results are recorded per entry, including the failure.
 *
 * PROVENANCE IS THE POINT. Every event carries its source, its URL, and the
 * publisher's own timestamp — not the time Jarvis noticed it. An event whose
 * origin cannot be named is not stored.
 */

/* --- registry ---------------------------------------------------------------
   `verified` records the live probe. Anything unverified is present as a
   candidate and is NOT fetched, so a broken feed cannot quietly become the
   basis of an answer. */
export const FEEDS = [
    // --- security: extends the Chrome/NVD path already shipping --------------
    { id: 'cisa-advisories', domain: 'security', title: 'CISA advisories', url: 'https://www.cisa.gov/cybersecurity-advisories/all.xml', verified: true, items: 30 },
    { id: 'google-security', domain: 'security', title: 'Google Security Blog', url: 'https://security.googleblog.com/feeds/posts/default?alt=rss', verified: true, items: 25 },
    { id: 'chrome-desktop', domain: 'security', title: 'Chrome desktop releases', url: 'https://chromereleases.googleblog.com/feeds/posts/default/-/Desktop%20Update?alt=rss', verified: true, items: 25 },

    // --- finance: SEC requires a declared User-Agent -------------------------
    { id: 'sec-8k', domain: 'finance', title: 'SEC latest 8-K filings', url: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&company=&dateb=&owner=include&count=40&output=atom', verified: true, items: 40, needsUserAgent: true },
    { id: 'sec-xbrl', domain: 'finance', title: 'SEC XBRL financial filings', url: 'https://www.sec.gov/Archives/edgar/xbrlrss.all.xml', verified: true, items: 200, needsUserAgent: true, heavy: true },

    /* --- SEC newsroom and enforcement (probed 22 Jul 2026) -------------------
       THE OLD PATHS ALL MOVED. sec.gov/news/speeches.rss and the three
       sec.gov/rss/litigation/*.xml URLs still 301 — but two of those redirects
       land on a 404, so following the redirect is not enough and a naive
       "it redirects, fine" check would register two dead feeds. The
       post-redirect paths below were each fetched and counted. */
    { id: 'sec-press', domain: 'finance', title: 'SEC press releases', url: 'https://www.sec.gov/news/pressreleases.rss', verified: true, items: 25, needsUserAgent: true },
    { id: 'sec-speeches', domain: 'finance', title: 'SEC speeches and statements', url: 'https://www.sec.gov/news/speeches-statements.rss', verified: true, items: 25, needsUserAgent: true },
    /* Kept ALONGSIDE speeches-statements rather than folded into it: the two
       feeds share ZERO of their 25 titles, measured, so treating either as a
       superset of the other would silently drop 25 items. */
    { id: 'sec-statements', domain: 'finance', title: 'SEC statements', url: 'https://www.sec.gov/news/statements.rss', verified: true, items: 25, needsUserAgent: true },
    { id: 'sec-litigation', domain: 'finance', title: 'SEC litigation releases', url: 'https://www.sec.gov/enforcement-litigation/litigation-releases/rss', verified: true, items: 25, needsUserAgent: true },
    { id: 'sec-admin', domain: 'finance', title: 'SEC administrative proceedings', url: 'https://www.sec.gov/enforcement-litigation/administrative-proceedings/rss', verified: true, items: 25, needsUserAgent: true },
    { id: 'sec-suspensions', domain: 'finance', title: 'SEC trading suspensions', url: 'https://www.sec.gov/enforcement-litigation/trading-suspensions/rss', verified: true, items: 25, needsUserAgent: true },
    /* Live and current, but LOW VOLUME by nature: newest item at probe was 12
       Feb 2026. Congressional testimony is rare, so an empty week is the feed
       working. Recorded so a future probe does not mistake quiet for broken —
       the opposite of the Morningstar presentations feed, which is frozen. */
    { id: 'sec-testimony', domain: 'finance', title: 'SEC testimony', url: 'https://www.sec.gov/news/testimony.rss', verified: true, items: 25, needsUserAgent: true },

    /* --- XBRL structured-disclosure firehoses --------------------------------
       Updated every ten minutes, 200 items each, and BIG: 957KB and 822KB per
       fetch, measured. `heavy` keeps them out of the routine cycle — a personal
       assistant's corpus does not benefit from 400 "Company X filed a 10-Q"
       notices every cycle, and 1.8MB per cycle is real bandwidth.
       NOT redundant with sec-xbrl, which was the assumption until it was
       checked: usgaap shares only 57 of 201 accession numbers with
       xbrlrss.all, because each is a different 200-item slice of the same
       firehose rather than a subset of the other. */
    { id: 'sec-usgaap-xbrl', domain: 'finance', title: 'SEC US-GAAP XBRL filings', url: 'https://www.sec.gov/Archives/edgar/usgaap.rss.xml', verified: true, items: 200, needsUserAgent: true, heavy: true },
    { id: 'sec-inline-xbrl', domain: 'finance', title: 'SEC Inline XBRL filings', url: 'https://www.sec.gov/Archives/edgar/xbrl-inline.rss.xml', verified: true, items: 200, needsUserAgent: true, heavy: true },
    { id: 'fed-press', domain: 'finance', title: 'Federal Reserve press', url: 'https://www.federalreserve.gov/feeds/press_all.xml', verified: true, items: 20 },
    { id: 'fed-monetary', domain: 'finance', title: 'FOMC and monetary policy', url: 'https://www.federalreserve.gov/feeds/press_monetary.xml', verified: true, items: 15 },

    /* --- Morningstar investor relations (probed 22 Jul 2026) -----------------
       WHAT THESE ARE, because the name invites the opposite assumption: these
       are Morningstar, INC.'s OWN investor-relations feeds, served by Q4 Inc's
       IR platform. CIK 0001289419 is Morningstar the listed company (MORN).
       They carry Morningstar's dividend announcements, its product press, and
       its own 8-K/4/144 filings. They are NOT Morningstar research, NOT star
       ratings, NOT fair-value estimates, and NOT analyst coverage of any other
       security. Nothing here helps answer "what does Morningstar think of
       Apple" — that is a paid data licence, not an RSS feed.

       THE Symbol PARAMETER IS IGNORED. `SECFiling.aspx?Exchange=CIK&Symbol=`
       looks like a per-company filings endpoint and is not: requesting Apple's
       CIK 0000320193 returns Morningstar, Inc. filings, and omitting Symbol
       entirely still returns Morningstar. Probed both. The URL is kept in its
       original form because that is what the site publishes, but no caller
       should ever template a CIK into it expecting another company. For real
       per-company filings the SEC's own EDGAR endpoints above are the source. */
    { id: 'morningstar-sec', domain: 'finance', title: 'Morningstar Inc SEC filings', url: 'https://suppliers.morningstar.com/rss/SECFiling.aspx?Exchange=CIK&Symbol=0001289419', verified: true, items: 20, note: 'Morningstar Inc only; the Symbol parameter is ignored. Newest item at probe: 25 Jun 2026.' },

    /* Live and parseable, but the CONTENT lags badly: at probe time the channel
       advertised lastBuildDate 21 Jul 2026 while its newest item was 18 Dec
       2025 — seven months of staleness behind a fresh-looking build date.
       Harmless here only because parseFeed reads each item's own pubDate and
       never the channel's lastBuildDate; anything that judged freshness from
       the channel would call this feed current every single day. */
    { id: 'morningstar-press', domain: 'finance', title: 'Morningstar Inc press releases', url: 'https://suppliers.morningstar.com/rss/pressrelease.aspx', verified: true, items: 10, note: 'lastBuildDate refreshes daily but items do not; newest item at probe was 18 Dec 2025.' },

    // --- research ------------------------------------------------------------
    { id: 'arxiv-cscr', domain: 'research', title: 'arXiv cs.CR (security)', url: 'http://export.arxiv.org/rss/cs.CR', verified: true, items: 89 },
    { id: 'arxiv-csai', domain: 'research', title: 'arXiv cs.AI', url: 'http://export.arxiv.org/rss/cs.AI', verified: true, items: 519 },

    /* Probed and NOT working from here. Kept visible on purpose: a feed that
       silently vanishes from a registry looks like it was never considered,
       and the next person re-probes it from scratch. */
    { id: 'treasury-press', domain: 'finance', title: 'US Treasury press', url: 'https://home.treasury.gov/system/files/126/rss.xml', verified: false, error: 'timed out at 15s on this network' },
    /* Serves 200 OK and eight well-formed items, so a liveness check passes it.
       It is dead anyway: lastBuildDate EQUALS its newest pubDate, both 18 May
       2018 — frozen for eight years, not merely quiet. Polling it forever would
       cost a request per cycle to re-learn the 2018 shareholder meeting. Left
       visible rather than deleted so it is not re-probed from scratch; the
       descriptions also carry escaped SlideShare iframes, which is why the
       stripTags path matters if it is ever revived. */
    { id: 'morningstar-presentations', domain: 'finance', title: 'Morningstar Inc presentations', url: 'https://suppliers.morningstar.com/rss/presentation.aspx', verified: false, error: 'live but frozen since 18 May 2018 (newest item == lastBuildDate)' },
    { id: 'cisa-kev', domain: 'security', title: 'CISA Known Exploited Vulnerabilities', url: 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json', verified: false, error: 'JSON, not RSS — needs its own parser' },
    /* Both are listed on the SEC's own Structured Disclosure RSS page and both
       404. Documented endpoints that do not exist is the same class of error as
       Kalshi's non-existent "Culture" category: the page is not the territory. */
    { id: 'sec-ifrs-xbrl', domain: 'finance', title: 'SEC IFRS XBRL filings', url: 'https://www.sec.gov/Archives/edgar/ifrs.rss.xml', verified: false, error: '404 — listed on the SEC RSS page but the endpoint does not exist' },
    { id: 'sec-rrsummary', domain: 'finance', title: 'SEC mutual fund risk/return', url: 'https://www.sec.gov/Archives/edgar/rrsummary.rss.xml', verified: false, error: '404 — listed on the SEC RSS page but the endpoint does not exist' },
];

export const DOMAINS = ['security', 'finance', 'research'];

/**
 * Only feeds a live probe accepted.
 *
 * `heavy` feeds are excluded by default: they are the 200-item XBRL firehoses,
 * ~900KB each, refreshed every ten minutes. Including them in the routine cycle
 * costs megabytes to learn that routine filings happened. They stay one
 * argument away for when a question actually needs them.
 */
export function activeFeeds(domain = null, { includeHeavy = false } = {}) {
    return FEEDS.filter(f => f.verified
        && (!domain || f.domain === domain)
        && (includeHeavy || !f.heavy));
}

/* --- parsing ----------------------------------------------------------------
   RSS uses <item> and Atom uses <entry>; SEC's EDGAR endpoints are Atom while
   the Fed and arXiv are RSS. One parser handles both rather than two that can
   drift apart. */

const decode = (s) => String(s || '')
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .trim();

const stripTags = (s) => decode(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

function tag(block, name) {
    const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
    return m ? m[1] : '';
}

/** Atom links live in an attribute, not the element body. */
function linkOf(block) {
    const rss = tag(block, 'link');
    if (rss && !/^\s*<?\s*$/.test(rss)) return decode(rss);
    const m = block.match(/<link[^>]*href=["']([^"']+)["']/i);
    return m ? decode(m[1]) : '';
}

/**
 * Feed XML -> normalised events.
 * @param {string} xml
 * @param {{id, title, domain}} feed
 * @param {{limit?: number, now?: number}} [opts]
 */
export function parseFeed(xml, feed, { limit = 25, now = Date.now() } = {}) {
    const text = String(xml || '');
    const blocks = [
        ...text.matchAll(/<item[\s>][\s\S]*?<\/item>/gi),
        ...text.matchAll(/<entry[\s>][\s\S]*?<\/entry>/gi),
    ].map(m => m[0]);

    const out = [];
    for (const block of blocks.slice(0, limit)) {
        const title = stripTags(tag(block, 'title'));
        if (!title) continue;                       // an untitled entry says nothing

        // Publishers disagree on the date element; try each in turn.
        const rawDate = tag(block, 'pubDate') || tag(block, 'updated') || tag(block, 'published') || tag(block, 'dc:date');
        const ts = Date.parse(decode(rawDate));
        const summary = stripTags(tag(block, 'description') || tag(block, 'summary') || tag(block, 'content'));

        out.push({
            id: `${feed.id}:${hashish(title + rawDate)}`,
            feedId: feed.id,
            domain: feed.domain,
            source: feed.title,
            title,
            summary: summary.slice(0, 600),
            url: linkOf(block),
            // The PUBLISHER's timestamp, never the fetch time. A feed replayed
            // tomorrow must not look like tomorrow's news.
            published: Number.isFinite(ts) ? new Date(ts).toISOString() : null,
            publishedTs: Number.isFinite(ts) ? ts : null,
            ingestedAt: now,
        });
    }
    return out;
}

/** Small stable hash for dedup keys. Not cryptographic; collisions are cheap. */
function hashish(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(36);
}

/** Drop events already seen, by id. Order preserved, newest-first by date. */
export function dedupe(events, seenIds) {
    const seen = seenIds instanceof Set ? seenIds : new Set(seenIds || []);
    const fresh = (events || []).filter(e => e && !seen.has(e.id));
    return fresh.sort((a, b) => (b.publishedTs || 0) - (a.publishedTs || 0));
}

/** Events newer than a cutoff. Undated events are EXCLUDED, never assumed new. */
export function since(events, cutoffTs) {
    return (events || []).filter(e => Number.isFinite(e.publishedTs) && e.publishedTs >= cutoffTs);
}

/**
 * What a feed event contributes to long-term memory. Deliberately short: the
 * retrieval corpus is small and best-first, and a 600-character news blob
 * crowds out the user's own notes.
 */
export function toMemoryText(event) {
    if (!event?.title) return null;
    const when = event.published ? new Date(event.published).toISOString().slice(0, 10) : 'undated';
    const body = event.summary ? ` ${event.summary.slice(0, 220)}` : '';
    return `[${when}] ${event.source}: ${event.title}.${body}`.trim();
}

/* --- reporting --------------------------------------------------------------
   A daily brief is a count plus the headline items, never a claim about what
   the events MEAN. Interpretation is the model's job, downstream, with these
   as its only material. */

export function groupByDomain(events) {
    const out = {};
    for (const e of events || []) (out[e.domain] = out[e.domain] || []).push(e);
    return out;
}

export function describeBrief(events, { hours = 24, limit = 3 } = {}) {
    if (!events?.length) return `Nothing new in the feeds I watch over the last ${hours} hours, Sir.`;
    const byDomain = groupByDomain(events);
    const parts = Object.entries(byDomain).map(([domain, list]) =>
        `${list.length} ${domain}`);
    const lead = Object.values(byDomain).flat()
        .sort((a, b) => (b.publishedTs || 0) - (a.publishedTs || 0))
        .slice(0, limit)
        .map(e => `${e.source}: ${e.title}`)
        .join('. ');
    return `${events.length} new item${events.length === 1 ? '' : 's'} in the last ${hours} hours, Sir — ${parts.join(', ')}. ${lead}.`;
}

export default {
    FEEDS, DOMAINS, activeFeeds, parseFeed, dedupe, since,
    toMemoryText, groupByDomain, describeBrief,
};
