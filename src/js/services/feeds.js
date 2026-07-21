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
    { id: 'sec-xbrl', domain: 'finance', title: 'SEC XBRL financial filings', url: 'https://www.sec.gov/Archives/edgar/xbrlrss.all.xml', verified: true, items: 200, needsUserAgent: true },
    { id: 'fed-press', domain: 'finance', title: 'Federal Reserve press', url: 'https://www.federalreserve.gov/feeds/press_all.xml', verified: true, items: 20 },
    { id: 'fed-monetary', domain: 'finance', title: 'FOMC and monetary policy', url: 'https://www.federalreserve.gov/feeds/press_monetary.xml', verified: true, items: 15 },

    // --- research ------------------------------------------------------------
    { id: 'arxiv-cscr', domain: 'research', title: 'arXiv cs.CR (security)', url: 'http://export.arxiv.org/rss/cs.CR', verified: true, items: 89 },
    { id: 'arxiv-csai', domain: 'research', title: 'arXiv cs.AI', url: 'http://export.arxiv.org/rss/cs.AI', verified: true, items: 519 },

    /* Probed and NOT working from here. Kept visible on purpose: a feed that
       silently vanishes from a registry looks like it was never considered,
       and the next person re-probes it from scratch. */
    { id: 'treasury-press', domain: 'finance', title: 'US Treasury press', url: 'https://home.treasury.gov/system/files/126/rss.xml', verified: false, error: 'timed out at 15s on this network' },
    { id: 'cisa-kev', domain: 'security', title: 'CISA Known Exploited Vulnerabilities', url: 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json', verified: false, error: 'JSON, not RSS — needs its own parser' },
];

export const DOMAINS = ['security', 'finance', 'research'];

/** Only feeds a live probe accepted. */
export function activeFeeds(domain = null) {
    return FEEDS.filter(f => f.verified && (!domain || f.domain === domain));
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
