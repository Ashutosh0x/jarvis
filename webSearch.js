/**
 * Web search for Jarvis.
 *
 * WHY THIS EXISTS AT ALL. Until now there was no web search. "search about elon
 * musk" was classified TYPE_TEXT (voice dictation), "web search about elon musk
 * recent project" went to AI_COMMAND, and both ended at the local Gemma model,
 * which has no network access. The model did not decline — it invented. From
 * the interaction log:
 *
 *   "search about elon musk"        -> "...recognized as a trillionaire in US dollars ."
 *   "list latest vulnerabilities"   -> "According to OpenCVE, Google released Chrome
 *                                       version 151 with patches for 382 vulnerabilities"
 *   "latest cve number of chrome"   -> "According to Google's Chrome Releases,
 *                                       CVE-2026-15905 is the latest critical vulnerability"
 *
 * Those citations are fabricated, and a fabricated CVE number is worse than a
 * refusal. Real results, with real URLs, are the fix.
 *
 * WHY IT IS FAST. The old search path cost 30-50s because it ran retrieval over
 * local documents and then a local LLM. News queries in the same log return in
 * 542-1188ms because they fetch a feed and read it out directly. This follows
 * the news path, not the LLM path: fetch, parse, speak. No embedding, no
 * rerank, no generation on the critical path.
 *
 * Providers are RACED rather than tried in sequence (see hedgedRace), because a
 * sequential chain pays the full timeout of every provider that is having a bad
 * day before it reaches one that works.
 *
 * This module is deliberately pure — parsing, ranking and phrasing only, with
 * no fetch of its own — so every branch is testable without a network.
 */

'use strict';

/* ---------------------------------------------------------------- intent -- */

/**
 * Which kinds of source can answer this question.
 *
 * This is the lever that makes many providers cheap: a question about a Rust
 * crate should not pay for a CVE database round trip. Regex rather than a
 * model, because it runs on every query and a classifier that costs 50ms would
 * eat the entire budget it exists to protect.
 *
 * Multi-label on purpose — "log4j vulnerability in my java package" is both a
 * security and a package question, and both indexes have part of the answer.
 */
const INTENT_PATTERNS = {
    code: /\b(github|repo|repository|library|framework|sdk|package|module|crate|npm|pypi|pip|cargo|gem|api|function|class|compile|stack ?trace|segfault)\b/i,
    academic: /\b(paper|papers|arxiv|doi|preprint|research|study|studies|journal|citation|thesis|peer.?review|benchmark)\b/i,
    security: /\b(cve|vulnerabilit(y|ies)|exploit|advisory|advisories|patch|malware|ransomware|0.?day|zero.?day|rce|xss|sqli)\b/i,
    discuss: /\b(hacker ?news|hn|forum|thread|discussion|opinion|review|experience|why do people|worth it|vs\b)\b/i,
    book: /\b(book|books|isbn|author|novel|textbook)\b/i,
};

function detectIntents(query) {
    const q = String(query || '');
    const intents = Object.keys(INTENT_PATTERNS).filter((k) => INTENT_PATTERNS[k].test(q));
    if (isTimeSensitive(q)) intents.push('news');
    return intents.length ? intents : ['general'];
}

/**
 * How much each source's ranking should count for THIS question.
 *
 * A source is only asked when its intent matched, but matching an intent does
 * not make it equally apt: "rust crate" trips the generic code intent, which
 * asks npm as well as crates.io, and npm has nothing useful to say about Rust.
 * Ecosystem words are therefore read directly off the query.
 */
function providerWeights(query) {
    const q = String(query || '').toLowerCase();
    const w = {
        'duckduckgo-instant': 1.3,   // a sourced abstract is usually the answer
        wikipedia: 1.1,
        'google-news': 1.0,
        brave: 1.3,
        github: 1.0, npm: 1.0, crates: 1.0, stackoverflow: 1.0,
        arxiv: 1.2, nvd: 1.3, hackernews: 0.9, openlibrary: 1.0,
    };

    if (/\b(rust|crate|cargo)\b/.test(q)) { w.crates = 1.6; w.npm = 0.3; }
    if (/\b(npm|node|javascript|typescript|js|ts)\b/.test(q)) { w.npm = 1.6; w.crates = 0.3; }
    if (/\b(python|pip|pypi)\b/.test(q)) { w.npm = 0.3; w.crates = 0.3; }
    // A question naming a paper wants the paper, not coverage of the paper.
    if (/\b(arxiv|paper|preprint)\b/.test(q)) { w.arxiv = 1.8; w['google-news'] = 0.6; }
    // A question naming a CVE wants the advisory, not a news write-up.
    if (/\bcve\b/.test(q)) { w.nvd = 1.8; w['google-news'] = 0.7; }
    return w;
}

/* ------------------------------------------------------------- providers -- */

/**
 * Search endpoints, best-first.
 *
 * ONLY OFFICIAL APIS. The obvious approach — scrape a search engine's HTML —
 * was tried first and measured, and it does not work:
 *
 *   html.duckduckgo.com   HTTP 202 + challenge page, 0 results (blocks after ~1 request)
 *   lite.duckduckgo.com   HTTP 202 + challenge page, 0 results
 *   mojeek.com            HTTP 200 but the body is an altcha CAPTCHA
 *   searx.be              HTTP 200, JSON output disabled
 *
 * The first DuckDuckGo query of a session usually succeeds, which makes this
 * failure especially deceptive: it looks like it works until it is used twice.
 *
 * The landscape behind that: Google's Custom Search JSON API closed to new
 * signups in 2025 and shuts down on 1 Jan 2027, and Brave withdrew its free
 * tier for new users in early 2026. Keyless general open-web search is simply
 * not available in 2026 — so this uses the keyless endpoints that ARE official
 * and reliable, each strong on a different kind of question, and adds real
 * general search only when a key exists.
 */
function buildProviders(query, { braveKey = null } = {}) {
    const raw = String(query || '').trim();
    const q = encodeURIComponent(raw);
    const providers = [];
    const timely = isTimeSensitive(raw);

    // Real general web search — only available with a key.
    if (braveKey) {
        providers.push({
            id: 'brave',
            url: `https://api.search.brave.com/res/v1/web/search?q=${q}&count=8`,
            headers: { Accept: 'application/json', 'X-Subscription-Token': braveKey },
            parse: parseBrave,
        });
    }

    /* DuckDuckGo's OFFICIAL Instant Answer API — not the HTML page. Keyless,
       measured at 361ms, and never challenged. It answers "who/what is X" with
       a sourced abstract, which is the most common shape of spoken query. */
    providers.push({
        id: 'duckduckgo-instant',
        url: `https://api.duckduckgo.com/?q=${q}&format=json&no_html=1&skip_disambig=1`,
        headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' },
        parse: parseDuckDuckGoInstant,
    });

    // Encyclopedic fallback, measured at 541ms.
    providers.push({
        id: 'wikipedia',
        url: `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${q}&format=json&srlimit=8&origin=*`,
        headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' },
        parse: parseWikipedia,
    });

    /* Anything current — prices, "recent project", people in the news — is not
       in an encyclopedia. Google News RSS is keyless, already relied on
       elsewhere in this app, and measured at 642ms. */
    providers.push({
        id: 'google-news',
        url: `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`,
        headers: { 'User-Agent': BROWSER_UA, Accept: 'application/rss+xml, text/xml' },
        parse: parseGoogleNewsRss,
    });

    /* SPECIALISED INDEXES, gated on intent.
       Every one below was probed before being added; the three that did not
       work are deliberately absent — GitHub code search needs auth (401),
       Semantic Scholar rate-limited us (429) and Reddit returns 403 to
       datacentre traffic. Latencies noted are measured, not advertised. */
    const intents = new Set(detectIntents(raw));

    if (intents.has('code')) {
        providers.push({
            id: 'github',            // 1523ms; 60 req/hr unauthenticated
            url: `https://api.github.com/search/repositories?q=${q}&per_page=5&sort=stars`,
            headers: { 'User-Agent': BROWSER_UA, Accept: 'application/vnd.github+json' },
            parse: parseGitHub,
        });
        providers.push({
            id: 'npm',               // 2078ms
            url: `https://registry.npmjs.org/-/v1/search?text=${q}&size=5`,
            headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' },
            parse: parseNpm,
        });
        providers.push({
            id: 'crates',            // 1147ms
            url: `https://crates.io/api/v1/crates?q=${q}&per_page=5`,
            headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' },
            parse: parseCrates,
        });
    }

    if (intents.has('academic')) {
        providers.push({
            id: 'arxiv',             // 1973ms, Atom not JSON
            url: `http://export.arxiv.org/api/query?search_query=all:${q}&max_results=5`,
            headers: { 'User-Agent': BROWSER_UA, Accept: 'application/atom+xml' },
            parse: parseArxiv,
        });
    }

    if (intents.has('security')) {
        providers.push({
            id: 'nvd',               // 1462ms
            url: `https://services.nvd.nist.gov/rest/json/cves/2.0?keywordSearch=${q}&resultsPerPage=5`,
            headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' },
            parse: parseNvd,
        });
    }

    if (intents.has('code') || intents.has('discuss')) {
        providers.push({
            id: 'stackoverflow',     // 1555ms
            url: `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${q}&site=stackoverflow&pagesize=5`,
            headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' },
            parse: parseStackExchange,
        });
    }

    if (intents.has('discuss')) {
        providers.push({
            id: 'hackernews',        // 831ms
            url: `https://hn.algolia.com/api/v1/search?query=${q}&hitsPerPage=5`,
            headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' },
            parse: parseHackerNews,
        });
    }

    if (intents.has('book')) {
        providers.push({
            id: 'openlibrary',       // 1259ms
            url: `https://openlibrary.org/search.json?q=${q}&limit=5`,
            headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' },
            parse: parseOpenLibrary,
        });
    }

    /* Order by APTNESS, because a first-wins race would otherwise decide
       relevance by latency. Measured: "bitcoin price today" came back as
       Wikipedia's "Economics of bitcoin" purely because Wikipedia was 200ms
       quicker than the news feed. A question about today is a question for a
       news index, so it goes first. */
    if (timely) {
        providers.sort((a, b) =>
            (a.id === 'google-news' ? -1 : 0) - (b.id === 'google-news' ? -1 : 0));
    }

    return providers;
}

/**
 * Does this question want something current rather than encyclopedic?
 *
 * Wikipedia and DuckDuckGo's abstracts are the right sources for "what is X"
 * and the wrong ones for "X price today" — an encyclopedia entry on the
 * economics of bitcoin is not a price.
 */
function isTimeSensitive(query) {
    return /\b(today|todays|now|current|currently|latest|recent|recently|this (week|month|year)|202\d|price|stock|news|update|announced?|launch(ed|ing)?)\b/i
        .test(String(query || ''));
}

const BROWSER_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

/* --------------------------------------------------------------- parsing -- */

function decodeEntities(s) {
    return String(s || '')
        .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
        .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&');   // last, so &amp;lt; does not become <
}

function stripTags(s) {
    return decodeEntities(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * DuckDuckGo wraps outbound links as /l/?uddg=<percent-encoded target>. Left
 * alone, every result URL is a duckduckgo.com redirect: they work in a browser
 * but are useless as a citation, and they all share one host so domain-based
 * deduplication collapses unrelated results into one.
 */
function unwrapDuckDuckGoUrl(href) {
    const raw = String(href || '');
    const m = raw.match(/[?&]uddg=([^&]+)/);
    let url = m ? safeDecode(m[1]) : raw;
    if (url.startsWith('//')) url = `https:${url}`;
    return url;
}

function safeDecode(s) {
    try { return decodeURIComponent(s); } catch { return s; }
}

function parseDuckDuckGoHtml(body, limit = 8) {
    const results = [];
    const blockRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = blockRe.exec(body)) && results.length < limit) {
        const url = unwrapDuckDuckGoUrl(m[1]);
        const title = stripTags(m[2]);
        if (!title || !/^https?:\/\//i.test(url)) continue;
        results.push({ title, url, snippet: '' });
    }

    // Snippets live in sibling nodes, so they are collected separately and
    // zipped by position rather than parsed as one nested block — the markup
    // nests inconsistently and a single combined regex misses roughly half.
    const snippets = [];
    const snipRe = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
    while ((m = snipRe.exec(body))) snippets.push(stripTags(m[1]));
    results.forEach((r, i) => { if (snippets[i]) r.snippet = snippets[i]; });

    return results;
}

/** The lite endpoint is a plain table — different markup, same shape out. */
function parseDuckDuckGoLite(body, limit = 8) {
    const results = [];
    const re = /<a[^>]+href="([^"]+)"[^>]*class="[^"]*result-link[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(body)) && results.length < limit) {
        const url = unwrapDuckDuckGoUrl(m[1]);
        const title = stripTags(m[2]);
        if (!title || !/^https?:\/\//i.test(url)) continue;
        results.push({ title, url, snippet: '' });
    }
    return results;
}

/**
 * DuckDuckGo Instant Answer API.
 *
 * The Abstract is the good answer when there is one — a sourced summary with
 * the origin named (usually Wikipedia). RelatedTopics fill the rest. Entries
 * that are topic GROUPS carry a nested Topics array instead of a FirstURL, and
 * flattening those is what stops a disambiguation query returning nothing.
 */
function parseDuckDuckGoInstant(body, limit = 8) {
    let data;
    try { data = typeof body === 'string' ? JSON.parse(body) : body; }
    catch { return []; }
    if (!data) return [];

    const out = [];
    const abstract = String(data.AbstractText || data.Abstract || '').trim();
    if (abstract && data.AbstractURL) {
        out.push({
            title: stripTags(data.Heading || abstract.slice(0, 80)),
            url: String(data.AbstractURL),
            snippet: stripTags(abstract),
            source: data.AbstractSource || null,
        });
    }

    const flatten = (topics) => {
        for (const t of topics || []) {
            if (out.length >= limit) return;
            if (Array.isArray(t?.Topics)) { flatten(t.Topics); continue; }
            const text = stripTags(t?.Text || '');
            const url = String(t?.FirstURL || '');
            if (!text || !/^https?:\/\//i.test(url)) continue;
            // "Title - description" is DDG's convention for these.
            const split = text.indexOf(' - ');
            out.push({
                title: split > 0 ? text.slice(0, split) : text.slice(0, 90),
                url,
                snippet: split > 0 ? text.slice(split + 3) : '',
            });
        }
    };
    flatten(data.RelatedTopics);
    flatten(data.Results);

    return out.slice(0, limit);
}

/** Wikipedia search. Snippets arrive as HTML with <span class="searchmatch">. */
function parseWikipedia(body, limit = 8) {
    let data;
    try { data = typeof body === 'string' ? JSON.parse(body) : body; }
    catch { return []; }
    const hits = data?.query?.search;
    if (!Array.isArray(hits)) return [];
    return hits.slice(0, limit).map((h) => ({
        title: stripTags(h.title),
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(String(h.title).replace(/ /g, '_'))}`,
        snippet: stripTags(h.snippet),
        source: 'Wikipedia',
    })).filter((r) => r.title);
}

/**
 * Google News RSS. The <source> element carries the real publisher, which is
 * what gets spoken — "from reuters.com" is checkable, "from news.google.com"
 * is not.
 */
function parseGoogleNewsRss(body, limit = 8) {
    const items = String(body || '').match(/<item>([\s\S]*?)<\/item>/gi) || [];
    const out = [];
    for (const raw of items) {
        if (out.length >= limit) break;
        const pick = (tag) => {
            const m = raw.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
            return m ? stripTags(m[1].replace(/<!\[CDATA\[|\]\]>/g, '')) : '';
        };
        const title = pick('title');
        const url = pick('link');
        if (!title || !/^https?:\/\//i.test(url)) continue;
        out.push({ title, url, snippet: '', source: pick('source') || null, age: pick('pubDate') || null });
    }
    return out;
}

/* Specialised-index parsers. Each normalises to the same {title,url,snippet}
   shape so fusion downstream never needs to know where a result came from. */

const asJson = (body) => {
    try { return typeof body === 'string' ? JSON.parse(body) : body; }
    catch { return null; }
};

function parseGitHub(body, limit = 8) {
    const d = asJson(body);
    return (d?.items || []).slice(0, limit).map((r) => ({
        title: `${r.full_name}${r.stargazers_count ? ` (${r.stargazers_count} stars)` : ''}`,
        url: r.html_url || '',
        snippet: stripTags(r.description || ''),
        source: 'GitHub',
    })).filter((r) => r.url);
}

function parseNpm(body, limit = 8) {
    const d = asJson(body);
    return (d?.objects || []).slice(0, limit).map((o) => ({
        title: `${o.package?.name} ${o.package?.version || ''}`.trim(),
        url: o.package?.links?.npm || `https://www.npmjs.com/package/${o.package?.name}`,
        snippet: stripTags(o.package?.description || ''),
        source: 'npm',
    })).filter((r) => r.title.trim());
}

function parseCrates(body, limit = 8) {
    const d = asJson(body);
    return (d?.crates || []).slice(0, limit).map((c) => ({
        title: `${c.name} ${c.max_version || ''}`.trim(),
        url: `https://crates.io/crates/${c.name}`,
        snippet: stripTags(c.description || ''),
        source: 'crates.io',
    })).filter((r) => String(r.title).trim());
}

/** arXiv answers Atom XML, not JSON — the only provider here that does. */
function parseArxiv(body, limit = 8) {
    const entries = String(body || '').match(/<entry>([\s\S]*?)<\/entry>/g) || [];
    return entries.slice(0, limit).map((e) => {
        const pick = (tag) => {
            const m = e.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
            return m ? stripTags(m[1]) : '';
        };
        const idm = e.match(/<id>([\s\S]*?)<\/id>/i);
        return {
            title: pick('title'),
            url: idm ? stripTags(idm[1]) : '',
            snippet: pick('summary').slice(0, 300),
            source: 'arXiv',
        };
    }).filter((r) => r.title && /^https?:\/\//i.test(r.url));
}

function parseNvd(body, limit = 8) {
    const d = asJson(body);
    return (d?.vulnerabilities || []).slice(0, limit).map((v) => {
        const cve = v.cve || {};
        const desc = (cve.descriptions || []).find((x) => x.lang === 'en');
        return {
            title: cve.id || '',
            url: cve.id ? `https://nvd.nist.gov/vuln/detail/${cve.id}` : '',
            snippet: stripTags(desc?.value || '').slice(0, 300),
            source: 'NVD',
        };
    }).filter((r) => r.title);
}

function parseStackExchange(body, limit = 8) {
    const d = asJson(body);
    return (d?.items || []).slice(0, limit).map((i) => ({
        title: decodeEntities(i.title || ''),
        url: i.link || '',
        snippet: `${i.is_answered ? 'Answered' : 'Unanswered'}, score ${i.score ?? 0}`,
        source: 'Stack Overflow',
    })).filter((r) => r.url);
}

function parseHackerNews(body, limit = 8) {
    const d = asJson(body);
    return (d?.hits || []).slice(0, limit).map((h) => ({
        title: h.title || h.story_title || '',
        url: h.url || (h.objectID ? `https://news.ycombinator.com/item?id=${h.objectID}` : ''),
        snippet: `${h.points ?? 0} points, ${h.num_comments ?? 0} comments`,
        source: 'Hacker News',
    })).filter((r) => r.title && r.url);
}

function parseOpenLibrary(body, limit = 8) {
    const d = asJson(body);
    return (d?.docs || []).slice(0, limit).map((b) => ({
        title: `${b.title}${b.first_publish_year ? ` (${b.first_publish_year})` : ''}`,
        url: b.key ? `https://openlibrary.org${b.key}` : '',
        snippet: (b.author_name || []).join(', '),
        source: 'Open Library',
    })).filter((r) => r.url);
}

function parseBrave(body, limit = 8) {
    let data;
    try { data = typeof body === 'string' ? JSON.parse(body) : body; }
    catch { return []; }
    const items = data?.web?.results;
    if (!Array.isArray(items)) return [];
    return items.slice(0, limit).map((r) => ({
        title: stripTags(r.title),
        url: String(r.url || ''),
        snippet: stripTags(r.description),
        age: r.age || null,
    })).filter((r) => r.title && /^https?:\/\//i.test(r.url));
}

/* --------------------------------------------------------------- ranking -- */

function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); }
    catch { return ''; }
}

/**
 * Drop duplicates, keeping the first (best-ranked) of each URL.
 *
 * Deduplicated by URL rather than by host: a search for a company can
 * legitimately return three different pages on the same domain, and collapsing
 * those to one throws away real results.
 */
function dedupeResults(results) {
    const seen = new Set();
    const out = [];
    for (const r of results || []) {
        if (!r || !r.url) continue;
        const key = String(r.url).replace(/[#?].*$/, '').replace(/\/+$/, '').toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(r);
    }
    return out;
}

/**
 * Light relevance ordering over what the provider already ranked.
 *
 * Intentionally not a reranker: the whole point of this path is that it does no
 * model work. This only promotes results whose title actually contains the
 * query terms, which is enough to stop an unrelated top hit from being the one
 * sentence the user hears.
 */
function rankResults(results, query) {
    const terms = String(query || '').toLowerCase().split(/\s+/).filter((t) => t.length > 2);
    if (!terms.length) return results;
    return [...results]
        .map((r, i) => {
            const title = String(r.title || '').toLowerCase();
            const snippet = String(r.snippet || '').toLowerCase();
            let score = 0;
            for (const t of terms) {
                if (title.includes(t)) score += 2;
                else if (snippet.includes(t)) score += 1;
            }
            return { r, score, i };
        })
        // Stable: provider order breaks ties, so an equally-relevant set keeps
        // the ranking the search engine already did.
        .sort((a, b) => (b.score - a.score) || (a.i - b.i))
        .map(({ r }) => r);
}

/* --------------------------------------------------- query understanding -- */

/**
 * Damerau-Levenshtein distance (with transposition).
 *
 * Kept in-tree rather than taken from a package, after checking what the
 * alternatives actually are: `symspell-js`, `symspell-wasm` and
 * `@3leaps/string-metrics` do not exist on npm at all, and `node-symspell` is
 * v0.1.0 last published in 2019. `fastest-levenshtein` is real and good but
 * computes PLAIN Levenshtein, which charges a transposition 2 edits instead of
 * 1 — strictly less capable than this for the same job.
 *
 * How much does transposition actually buy? Measured on the real typos, less
 * than it sounds: "recieve"/"receive" and "micorn"/"micron" score 2 under plain
 * Levenshtein but still clear the 0.34 ratio gate (0.29 and 0.33), so the
 * verdict is unchanged. It only decides short words near the boundary —
 * "form"/"from" is 1 edit here and 2 there, which flips accept to reject. That
 * is a narrow win, and it is the honest size of it.
 */
function editDistance(a, b) {
    const s = String(a || '').toLowerCase();
    const t = String(b || '').toLowerCase();
    if (s === t) return 0;
    if (!s.length) return t.length;
    if (!t.length) return s.length;

    const d = Array.from({ length: s.length + 1 }, (_, i) =>
        Array.from({ length: t.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));

    for (let i = 1; i <= s.length; i++) {
        for (let j = 1; j <= t.length; j++) {
            const cost = s[i - 1] === t[j - 1] ? 0 : 1;
            d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
            if (i > 1 && j > 1 && s[i - 1] === t[j - 2] && s[i - 2] === t[j - 1]) {
                d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);   // transposition
            }
        }
    }
    return d[s.length][t.length];
}

/**
 * Should a suggested spelling replace what the user actually said?
 *
 * Never blindly. The suggestion comes from a live index, and a live index will
 * happily map a rare-but-real word onto a popular one — measured: "micorn"
 * suggested "micron" (right) but its top article was "2010 Champs Sports Bowl"
 * (very wrong). So the decision is made here, on edit distance relative to
 * length, rather than trusting whatever came back.
 *
 * The bar rises for short words. One edit inside three letters is most of the
 * word, and "cat" -> "cut" is not a typo correction, it is a different query.
 */
function shouldApplyCorrection(original, suggestion, { maxRatio = 0.34 } = {}) {
    const from = String(original || '').trim().toLowerCase();
    const to = String(suggestion || '').trim().toLowerCase();

    if (!from || !to || from === to) return { apply: false, confidence: 0, reason: 'no change' };
    // A suggestion that restructures the query is not a spelling fix.
    if (Math.abs(from.length - to.length) > Math.max(4, from.length * 0.4)) {
        return { apply: false, confidence: 0, reason: 'too dissimilar' };
    }
    if (from.length < 4) return { apply: false, confidence: 0, reason: 'too short to correct' };

    const distance = editDistance(from, to);
    const ratio = distance / Math.max(from.length, to.length);
    const confidence = Number((1 - ratio).toFixed(3));

    return ratio <= maxRatio
        ? { apply: true, confidence, distance, reason: 'likely typo' }
        : { apply: false, confidence, distance, reason: 'different query' };
}

/* -------------------------------------------------------- local index -- */

/**
 * BM25 over what Jarvis has already crawled.
 *
 * This is the "build your own index" layer, and the point is that it already
 * exists: feeds.js has been polling SEC filings, arXiv cs.AI/cs.CR, CISA
 * advisories and Chrome releases for days, and userData/feed-events.jsonl holds
 * the result. 695 items were sitting there unsearchable while web queries went
 * to the open internet for things already on disk.
 *
 * A general web crawler is deliberately NOT built. Google indexes hundreds of
 * billions of pages; a personal crawler cannot approach that and would spend
 * its time re-fetching pages the live providers already return. What a personal
 * index CAN beat Google at is the narrow, high-value set the user actually
 * tracks — which is exactly what these feeds are.
 *
 * Real BM25, not term-overlap: k1=1.2 and b=0.75 are the standard parameters.
 * IDF is what stops a common word matching everything, and length
 * normalisation is what stops a long SEC filing summary out-scoring a precise
 * one-line advisory title.
 */
function bm25Search(docs, query, { limit = 8, k1 = 1.2, b = 0.75, now = Date.now } = {}) {
    const terms = tokenizeQuery(query);
    if (!terms.length || !Array.isArray(docs) || !docs.length) return [];

    const fields = docs.map((d) => `${d.title || ''} ${d.summary || ''}`.toLowerCase());
    const tokenized = fields.map((f) => f.split(/[^a-z0-9]+/).filter(Boolean));
    const avgLen = tokenized.reduce((n, t) => n + t.length, 0) / tokenized.length || 1;

    // Document frequency per query term, computed over this corpus only.
    const df = new Map();
    for (const term of terms) {
        let n = 0;
        for (const toks of tokenized) if (toks.includes(term)) n++;
        df.set(term, n);
    }

    const N = docs.length;
    const scored = [];
    tokenized.forEach((toks, i) => {
        let score = 0;
        for (const term of terms) {
            const n = df.get(term) || 0;
            if (!n) continue;
            let tf = 0;
            for (const t of toks) if (t === term) tf++;
            if (!tf) continue;
            const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
            score += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (toks.length / avgLen)));
        }
        if (!score) return;

        /* Recency. A personal index is valuable BECAUSE it is fresh — a CVE
           advisory from this morning beats an equally-matching one from three
           weeks ago. Gentle multiplier, so it re-orders near-ties rather than
           overriding relevance. */
        const ts = Number(docs[i].publishedTs || Date.parse(docs[i].published || '')) || 0;
        const ageDays = ts ? (now() - ts) / 86400000 : 30;
        score *= 1 + Math.max(0, 1 - ageDays / 30) * 0.5;

        scored.push({ doc: docs[i], score });
    });

    return scored
        .sort((a, b2) => b2.score - a.score)
        .slice(0, limit)
        .map(({ doc }) => ({
            title: doc.title || '',
            url: doc.url || '',
            snippet: String(doc.summary || '').slice(0, 300),
            source: doc.source || 'local index',
            local: true,
        }))
        .filter((r) => r.title && r.url);
}

function tokenizeQuery(query) {
    const STOP = new Set(['the', 'and', 'for', 'with', 'what', 'when', 'who', 'how', 'was',
        'are', 'from', 'about', 'that', 'this', 'best', 'latest', 'any', 'get']);
    return String(query || '').toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 2 && !STOP.has(t));
}

/* ------------------------------------------------- citation verification -- */

/**
 * Does the source actually say this?
 *
 * The failure this whole feature exists to prevent was confident prose with
 * invented citations — "According to Google's Chrome Releases, CVE-2026-15905
 * ..." about a CVE that was never checked. Extractive answers make that much
 * harder, but not impossible: a truncated or re-assembled sentence can still
 * misrepresent a page.
 *
 * So the claim is checked against the text it came from before it is spoken.
 * Verification is by content word overlap rather than exact substring, because
 * whitespace normalisation and entity decoding legitimately alter the string
 * while preserving the claim.
 */
function verifyAnswer(answer, sourceText, { threshold = 0.8 } = {}) {
    const claim = tokenizeQuery(answer);
    if (!claim.length) return { verified: false, overlap: 0, reason: 'empty claim' };

    const haystack = new Set(String(sourceText || '').toLowerCase().split(/[^a-z0-9]+/));
    const found = claim.filter((t) => haystack.has(t)).length;
    const overlap = found / claim.length;

    return {
        verified: overlap >= threshold,
        overlap: Number(overlap.toFixed(3)),
        reason: overlap >= threshold ? 'supported by source' : 'not found in source',
    };
}

/* ----------------------------------------------------------- gathering -- */

/**
 * Run every provider at once and keep everything that arrives in time.
 *
 * This replaces a first-wins race for the multi-source case. Racing is right
 * when providers are interchangeable — any one of three news feeds will do —
 * but wrong when they are complementary: a question about a Rust crate wants
 * the crates.io entry AND the GitHub repo AND the Stack Overflow thread, and
 * first-wins throws two of those away.
 *
 * The deadline is what keeps it fast. Slow providers do not extend the wait;
 * they are simply not in the answer.
 *
 * The early exit counts PROVIDERS, not results, and that distinction is the
 * whole thing. Counting results was tried first and silently destroyed the
 * feature: Google News alone returns six, which satisfied a result quota
 * instantly and finished the query before any other source had replied —
 * measured as "answered 1: google-news" on every single query, a first-wins
 * race wearing a gather's clothes. Fusion needs several lists to fuse.
 */
async function gatherAll(providers, run, { budgetMs = 1500, minProviders = 3, now = Date.now } = {}) {
    const started = now();
    const collected = [];
    const errors = [];
    let settled = 0;

    return new Promise((resolve) => {
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve({ lists: collected, errors, elapsedMs: now() - started });
        };

        const timer = setTimeout(finish, budgetMs);

        for (const provider of providers) {
            Promise.resolve()
                .then(() => run(provider))
                .then((results) => {
                    if (Array.isArray(results) && results.length) {
                        collected.push({ provider: provider.id, results });
                    }
                })
                .catch((e) => errors.push(`${provider.id}: ${e?.message || e}`))
                .finally(() => {
                    settled++;
                    // Everyone replied, or enough distinct sources have, so
                    // there is genuinely something to fuse.
                    if (settled === providers.length ||
                        collected.length >= Math.min(minProviders, providers.length)) finish();
                });
        }

        if (!providers.length) finish();
    });
}

/**
 * Reciprocal Rank Fusion.
 *
 * Merges ranked lists from sources whose scores are not comparable — GitHub
 * stars, Stack Overflow votes and news recency cannot be normalised against
 * each other, and trying to is where hand-tuned weighting goes wrong. RRF only
 * reads POSITION, so it needs no normalisation at all.
 *
 * k=60 is the value from the original Cormack et al. paper and the usual
 * default; it damps the top of each list so one confident source cannot sweep
 * the result set.
 */
function rrfFuse(lists, { k = 60, limit = 10, weights = null } = {}) {
    const scores = new Map();

    for (const list of lists || []) {
        const results = Array.isArray(list) ? list : list?.results;
        if (!Array.isArray(results)) continue;
        /* Provider weight. Plain RRF reads rank only, so an off-target index's
           top hit outranks a relevant index's second hit — measured: npm's
           "uniffi-bindgen-react-native" took first place on "best rust crate
           for async runtime", because npm was asked at all and answered fast.
           Weighting by how well the source fits the question fixes that without
           reintroducing incomparable raw scores. */
        const weight = (weights && weights[list?.provider]) ?? 1;
        results.forEach((doc, rank) => {
            if (!doc || !doc.url) return;
            const id = String(doc.url).replace(/[#?].*$/, '').replace(/\/+$/, '').toLowerCase();
            const prev = scores.get(id);
            const contribution = weight / (k + rank + 1);
            if (prev) {
                prev.score += contribution;
                prev.sources++;
                // Keep the richest copy: a result found by two providers should
                // show whichever snippet is actually informative.
                if ((doc.snippet || '').length > (prev.doc.snippet || '').length) prev.doc = doc;
            } else {
                scores.set(id, { doc, score: contribution, sources: 1 });
            }
        });
    }

    return [...scores.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((e) => ({ ...e.doc, _rrf: e.score, _sources: e.sources }));
}

/* ------------------------------------------------------------ page text -- */

/**
 * HTML to readable text — the `w3m -dump` idea, written natively.
 *
 * Shelling out to a text browser was considered and rejected: w3m is not
 * installed here, and spawning a process per query costs more than the entire
 * search budget. This is the part of w3m worth having, which is turning a page
 * into the sentences a person would actually read.
 *
 * Order matters. Script and style bodies are removed FIRST — their contents are
 * not markup and stripping tags before removing them leaves raw JavaScript in
 * the output, which is the classic way this goes wrong. Block-level elements
 * become newlines before the remaining tags are dropped, so paragraph
 * boundaries survive and sentences do not run together.
 */
/** Beyond this, a page is not an article — and every regex below is linear in
    input size, so an unbounded body turns a 200ms parse into a stall. Measured:
    a 642KB Wikipedia article parses in 183ms, so 1MB is generous headroom. */
const MAX_PAGE_BYTES = 1024 * 1024;

function htmlToText(html) {
    let s = String(html || '');
    if (s.length > MAX_PAGE_BYTES) s = s.slice(0, MAX_PAGE_BYTES);

    // Non-text bodies first, while their delimiters still exist.
    s = s.replace(/<!--[\s\S]*?-->/g, ' ');
    s = s.replace(/<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
    // Boilerplate that is present on every page and answers nothing.
    s = s.replace(/<(nav|header|footer|aside|form)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');

    // Block boundaries become real breaks before tags are discarded.
    s = s.replace(/<(br|hr)\b[^>]*\/?>/gi, '\n');
    s = s.replace(/<\/(p|div|li|tr|h[1-6]|section|article|blockquote|pre|td)\s*>/gi, '\n');
    s = s.replace(/<li\b[^>]*>/gi, '\n- ');

    s = s.replace(/<[^>]+>/g, ' ');
    s = decodeEntities(s);

    /* Whitespace is collapsed in two flat passes. The obvious single pattern
       for blank-line runs nests a quantifier inside a quantified group, which
       is the shape that backtracks catastrophically on long whitespace runs --
       and machine-generated markup is full of those. */
    return s
        .replace(/[^\S\n]+/g, ' ')       // horizontal whitespace (incl. nbsp)
        .replace(/\s*\n[\s\n]*/g, '\n')  // newline run -> one newline
        .trim();
}

/**
 * The passage of a page that actually answers the question.
 *
 * Scored rather than "first paragraph": the opening text of a modern page is
 * usually a cookie notice or a subscribe prompt. A sentence is worth speaking
 * when it contains the query terms AND enough substance to stand alone, so
 * short fragments and navigation crumbs are filtered out by length before
 * scoring begins.
 */
function extractAnswer(text, query, { maxChars = 400 } = {}) {
    const terms = String(query || '').toLowerCase().split(/\s+/).filter((t) => t.length > 2);
    if (!terms.length) return '';

    const sentences = String(text || '')
        .split(/(?<=[.!?])\s+|\n+/)
        .map((s) => s.trim())
        .filter((s) => s.length >= 40 && s.length <= 600 && /[a-z]/i.test(s));

    if (!sentences.length) return '';

    let best = null;
    sentences.forEach((sentence, i) => {
        const low = sentence.toLowerCase();
        let score = 0;
        for (const t of terms) if (low.includes(t)) score += 1;
        if (!score) return;
        // Earlier sentences break ties: a page states its subject up front,
        // and a later repetition is usually a related-links teaser.
        const ranked = score - i * 0.001;
        if (!best || ranked > best.ranked) best = { sentence, ranked };
    });

    if (!best) return '';
    return best.sentence.length > maxChars
        ? `${best.sentence.slice(0, maxChars).replace(/\s+\S*$/, '')}...`
        : best.sentence;
}

/* ---------------------------------------------------------------- cache -- */

/**
 * Search cache.
 *
 * The interaction log shows the same query typed four times in five minutes
 * ("search bitcoin price today" x2, "search bitocin price today"), because the
 * first attempts failed. Repeats are normal, and a repeat should be instant
 * rather than another network round trip.
 *
 * TTL is short by default: a search is a question about the world right now,
 * and serving a ten-minute-old answer to "bitcoin price today" would be a
 * different kind of wrong from being slow.
 */
class SearchCache {
    constructor({ ttlMs = 180000, max = 50, now = Date.now } = {}) {
        this.ttlMs = ttlMs;
        this.max = max;
        this._now = now;
        this.map = new Map();
        this.hits = 0;
        this.misses = 0;
    }

    static key(query) {
        return String(query || '').toLowerCase().replace(/\s+/g, ' ').trim();
    }

    get(query) {
        const k = SearchCache.key(query);
        const hit = this.map.get(k);
        if (!hit) { this.misses++; return null; }
        if (this._now() - hit.at > this.ttlMs) {
            this.map.delete(k);
            this.misses++;
            return null;
        }
        // Refresh recency so a repeatedly-asked question is the last evicted.
        this.map.delete(k);
        this.map.set(k, hit);
        this.hits++;
        return hit.value;
    }

    set(query, value) {
        const k = SearchCache.key(query);
        this.map.delete(k);
        this.map.set(k, { at: this._now(), value });
        while (this.map.size > this.max) {
            this.map.delete(this.map.keys().next().value);   // oldest first
        }
    }

    clear() { this.map.clear(); }
}

/* Intent routing and spoken phrasing live in
   src/js/services/webSearchIntent.js — they run in the renderer, which cannot
   import named bindings from a CommonJS module. The split is by process, not by
   topic: this file fetches, parses and ranks; that one routes and speaks. */

module.exports = {
    buildProviders,
    isTimeSensitive,
    detectIntents,
    bm25Search,
    editDistance,
    shouldApplyCorrection,
    verifyAnswer,
    providerWeights,
    gatherAll,
    rrfFuse,
    parseGitHub,
    parseNpm,
    parseCrates,
    parseArxiv,
    parseNvd,
    parseStackExchange,
    parseHackerNews,
    parseOpenLibrary,
    htmlToText,
    extractAnswer,
    SearchCache,
    parseDuckDuckGoInstant,
    parseWikipedia,
    parseGoogleNewsRss,
    parseDuckDuckGoHtml,
    parseDuckDuckGoLite,
    parseBrave,
    unwrapDuckDuckGoUrl,
    dedupeResults,
    rankResults,
    hostOf,
    stripTags,
    decodeEntities,
    BROWSER_UA,
};
