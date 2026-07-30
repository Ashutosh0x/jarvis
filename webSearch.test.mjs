// Tests for web search.
//
// The cases below are taken from the interaction log for 21-30 Jul 2026, where
// every "search ..." utterance was misrouted to dictation or to the local model
// and answered with invented citations. Each block pins one property that would
// have prevented that.
import {
    parseDuckDuckGoHtml, parseDuckDuckGoLite, parseBrave, unwrapDuckDuckGoUrl,
    dedupeResults, rankResults, buildProviders, hostOf, stripTags, decodeEntities,
    parseDuckDuckGoInstant, parseWikipedia, parseGoogleNewsRss, isTimeSensitive,
    htmlToText, extractAnswer, SearchCache,
    detectIntents, gatherAll, rrfFuse, bm25Search, verifyAnswer,
    editDistance, shouldApplyCorrection,
    parseGitHub, parseNpm, parseArxiv, parseNvd, parseHackerNews, parseStackExchange,
} from './webSearch.js';

let pass = 0, fail = 0;
const check = (n, c) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); };

/* --------------------------------------------------------- ddg parsing --- */
{
    const html = `
      <div class="result results_links">
        <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=x">First &amp; Best</a>
        <a class="result__snippet" href="#">A snippet about the <b>first</b> thing.</a>
      </div>
      <div class="result results_links">
        <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fother.org%2Fb">Second Result</a>
        <a class="result__snippet" href="#">Second snippet.</a>
      </div>`;

    const r = parseDuckDuckGoHtml(html);
    check('ddg: finds both results', r.length === 2);
    check('ddg: unwraps the redirect to the real URL', r[0].url === 'https://example.com/a');
    check('ddg: decodes entities in the title', r[0].title === 'First & Best');
    check('ddg: strips tags from the snippet', r[0].snippet === 'A snippet about the first thing.');
    check('ddg: second result URL', r[1].url === 'https://other.org/b');
    check('ddg: honours the limit', parseDuckDuckGoHtml(html, 1).length === 1);
    check('ddg: empty body yields nothing', parseDuckDuckGoHtml('').length === 0);
    check('ddg: garbage body does not throw', parseDuckDuckGoHtml('<html>nope</html>').length === 0);

    check('ddg: protocol-relative URL is made absolute',
        unwrapDuckDuckGoUrl('//duckduckgo.com/l/?uddg=example.com') === 'https:example.com' ||
        unwrapDuckDuckGoUrl('//example.com/x') === 'https://example.com/x');
    check('ddg: a plain URL passes through',
        unwrapDuckDuckGoUrl('https://plain.example/x') === 'https://plain.example/x');
    check('ddg: malformed percent-encoding does not throw',
        typeof unwrapDuckDuckGoUrl('//duckduckgo.com/l/?uddg=%E0%A4%A') === 'string');

    const lite = `<a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Flite.example%2Fz" class="result-link">Lite One</a>`;
    const lr = parseDuckDuckGoLite(lite);
    check('ddg lite: parses the table markup', lr.length === 1 && lr[0].url === 'https://lite.example/z');
}

/* ------------------------------------------------------- brave parsing --- */
{
    const payload = JSON.stringify({
        web: { results: [
            { title: 'Brave <b>Hit</b>', url: 'https://b.example/1', description: 'Desc &amp; more', age: '2 hours ago' },
            { title: 'No URL', url: '', description: 'x' },
        ] },
    });
    const r = parseBrave(payload);
    check('brave: parses results', r.length === 1);
    check('brave: strips markup from the title', r[0].title === 'Brave Hit');
    check('brave: decodes the description', r[0].snippet === 'Desc & more');
    check('brave: keeps the age', r[0].age === '2 hours ago');
    check('brave: drops entries without a usable URL', !r.some((x) => !x.url));
    check('brave: accepts a pre-parsed object', parseBrave(JSON.parse(payload)).length === 1);
    check('brave: malformed JSON yields nothing', parseBrave('{not json').length === 0);
    check('brave: unexpected shape yields nothing', parseBrave('{"web":{}}').length === 0);
}

/* ------------------------------------------------------------ ranking ---- */
{
    const dupes = [
        { title: 'A', url: 'https://x.com/page' },
        { title: 'B', url: 'https://x.com/page/' },
        { title: 'C', url: 'https://x.com/page?utm=1' },
        { title: 'D', url: 'https://y.com/other' },
    ];
    check('dedupe: collapses trailing slash and query variants', dedupeResults(dupes).length === 2);
    check('dedupe: keeps the first of each', dedupeResults(dupes)[0].title === 'A');
    check('dedupe: keeps different pages on one domain', dedupeResults([
        { title: 'A', url: 'https://x.com/1' }, { title: 'B', url: 'https://x.com/2' },
    ]).length === 2);
    check('dedupe: survives junk', dedupeResults([null, { title: 'n' }, undefined]).length === 0);

    const ranked = rankResults([
        { title: 'Unrelated page', snippet: 'nothing' },
        { title: 'Bitcoin price today', snippet: 'btc' },
    ], 'bitcoin price');
    check('rank: promotes a title that matches the query', ranked[0].title === 'Bitcoin price today');

    const stable = rankResults([{ title: 'one' }, { title: 'two' }], 'zzz');
    check('rank: ties keep provider order', stable[0].title === 'one');
    check('rank: short terms are ignored', rankResults([{ title: 'a' }], 'a b').length === 1);
}

/* ------------------------------------------------- official-API parsing -- */
{
    // DuckDuckGo Instant Answer — the official JSON endpoint, not the HTML page.
    const ddg = JSON.stringify({
        Heading: 'Jamie Dimon',
        AbstractText: 'James Dimon is an American businessman.',
        AbstractURL: 'https://en.wikipedia.org/wiki/Jamie_Dimon',
        AbstractSource: 'Wikipedia',
        RelatedTopics: [
            { Text: 'JPMorgan Chase - A US bank', FirstURL: 'https://duckduckgo.com/JPMorgan' },
            // Topic GROUPS nest their entries; not flattening these was what
            // made disambiguation queries return nothing.
            { Name: 'group', Topics: [{ Text: 'Nested hit', FirstURL: 'https://example.com/n' }] },
        ],
    });
    const d = parseDuckDuckGoInstant(ddg);
    check('ddg-instant: abstract leads', d[0].url === 'https://en.wikipedia.org/wiki/Jamie_Dimon');
    check('ddg-instant: names the source', d[0].source === 'Wikipedia');
    check('ddg-instant: splits "Title - description"',
        d[1].title === 'JPMorgan Chase' && d[1].snippet === 'A US bank');
    check('ddg-instant: flattens nested topic groups',
        d.some((r) => r.url === 'https://example.com/n'));
    check('ddg-instant: malformed JSON yields nothing', parseDuckDuckGoInstant('{bad').length === 0);
    check('ddg-instant: empty payload yields nothing', parseDuckDuckGoInstant('{}').length === 0);

    const wiki = JSON.stringify({ query: { search: [
        { title: 'Tokio (software)', snippet: 'An <span class="searchmatch">async</span> runtime' },
    ] } });
    const w = parseWikipedia(wiki);
    check('wikipedia: builds the article URL from the title',
        w[0].url === 'https://en.wikipedia.org/wiki/Tokio_(software)');
    check('wikipedia: strips the searchmatch markup', w[0].snippet === 'An async runtime');
    check('wikipedia: unexpected shape yields nothing', parseWikipedia('{"query":{}}').length === 0);

    const rss = `<rss><channel>
        <item><title>Bitcoin rises</title><link>https://ex.com/1</link><source url="x">Reuters</source><pubDate>Wed, 30 Jul 2026</pubDate></item>
        <item><title><![CDATA[CDATA headline]]></title><link>https://ex.com/2</link></item>
        <item><title>No link</title></item>
    </channel></rss>`;
    const n = parseGoogleNewsRss(rss);
    check('news: parses items', n.length === 2);
    check('news: keeps the real publisher, not news.google.com', n[0].source === 'Reuters');
    check('news: unwraps CDATA titles', n[1].title === 'CDATA headline');
    check('news: drops items with no usable link', !n.some((r) => r.title === 'No link'));
}

/* ---------------------------------------------------------- providers ---- */
{
    const noKey = buildProviders('rust async');
    check('providers: works with no API key at all', noKey.length >= 2);
    check('providers: uses official APIs, not the blocked HTML endpoints',
        !noKey.some((p) => /html\.duckduckgo|lite\.duckduckgo|mojeek/i.test(p.url)));
    check('providers: keyless DuckDuckGo Instant Answer is present',
        noKey.some((p) => p.id === 'duckduckgo-instant'));
    check('providers: no Google Custom Search (closes 1 Jan 2027)',
        !noKey.some((p) => /customsearch|cse/i.test(p.url)));
    check('providers: query is percent-encoded',
        noKey.every((p) => p.url.includes('rust%20async') || p.url.includes('rust+async')));

    const withKey = buildProviders('x', { braveKey: 'secret' });
    check('providers: Brave leads when a key is configured', withKey[0].id === 'brave');
    check('providers: Brave key travels as a header, not in the URL',
        withKey[0].headers['X-Subscription-Token'] === 'secret' && !withKey[0].url.includes('secret'));

    // The measured relevance bug: a "today" question answered from Wikipedia
    // purely because Wikipedia replied 200ms sooner.
    check('providers: a time-sensitive query puts news first',
        buildProviders('bitcoin price today')[0].id === 'google-news');
    check('providers: an encyclopedic query does not',
        buildProviders('what is a monad')[0].id !== 'google-news');
    check('timely: "today"', isTimeSensitive('bitcoin price today') === true);
    check('timely: "recent"', isTimeSensitive('elon musk recent project') === true);
    check('timely: a year', isTimeSensitive('chrome vulnerabilities 2026') === true);
    check('timely: definitions are not', isTimeSensitive('what is rayleigh scattering') === false);
}

/* ---------------------------------------------------------- intents ------ */
{
    check('intent: a package question is code', detectIntents('best rust crate for async').includes('code'));
    check('intent: a paper question is academic', detectIntents('arxiv paper on retrieval augmented generation').includes('academic'));
    check('intent: a CVE question is security', detectIntents('chrome vulnerability advisory').includes('security'));
    check('intent: a forum question is discuss', detectIntents('hacker news opinion on rust').includes('discuss'));
    check('intent: multi-label', (() => {
        const i = detectIntents('log4j vulnerability in my java package');
        return i.includes('security') && i.includes('code');
    })());
    check('intent: falls back to general', detectIntents('who was ada lovelace')[0] === 'general');
    check('intent: timely queries are news', detectIntents('bitcoin price today').includes('news'));

    // The point of gating: irrelevant indexes must cost nothing.
    const general = buildProviders('who was ada lovelace').map((p) => p.id);
    check('gating: a general question does not query GitHub', !general.includes('github'));
    check('gating: a general question does not query NVD', !general.includes('nvd'));

    const codeQ = buildProviders('rust crate for async runtime').map((p) => p.id);
    check('gating: a code question adds GitHub', codeQ.includes('github'));
    check('gating: a code question adds crates.io', codeQ.includes('crates'));
    check('gating: a code question adds Stack Overflow', codeQ.includes('stackoverflow'));
    check('gating: keyless general sources stay on', codeQ.includes('duckduckgo-instant'));

    const secQ = buildProviders('chrome cve advisory').map((p) => p.id);
    check('gating: a security question adds NVD', secQ.includes('nvd'));
    check('gating: providers that failed probing are absent',
        !secQ.some((id) => /reddit|semantic|github-code/.test(id)));
}

/* ------------------------------------------------ specialised parsing ---- */
{
    check('github: name, stars and description', (() => {
        const r = parseGitHub(JSON.stringify({ items: [
            { full_name: 'tokio-rs/tokio', html_url: 'https://github.com/tokio-rs/tokio', stargazers_count: 25000, description: 'An async runtime' },
        ] }));
        return r[0].title.includes('tokio-rs/tokio') && r[0].title.includes('25000') && r[0].snippet === 'An async runtime';
    })());
    check('npm: builds a package URL when links are missing',
        parseNpm(JSON.stringify({ objects: [{ package: { name: 'express', version: '5.0.0' } }] }))[0]
            .url.includes('npmjs.com/package/express'));
    check('arxiv: parses Atom, not JSON', (() => {
        const r = parseArxiv('<entry><id>http://arxiv.org/abs/1234</id><title>A Paper</title><summary>Body</summary></entry>');
        return r.length === 1 && r[0].title === 'A Paper';
    })());
    check('nvd: builds the advisory URL from the CVE id', (() => {
        const r = parseNvd(JSON.stringify({ vulnerabilities: [
            { cve: { id: 'CVE-2026-1', descriptions: [{ lang: 'en', value: 'A flaw' }] } },
        ] }));
        return r[0].url === 'https://nvd.nist.gov/vuln/detail/CVE-2026-1' && r[0].snippet === 'A flaw';
    })());
    check('hackernews: falls back to the discussion link',
        parseHackerNews(JSON.stringify({ hits: [{ title: 'T', objectID: '42' }] }))[0]
            .url.includes('item?id=42'));
    check('stackexchange: decodes entities in titles',
        parseStackExchange(JSON.stringify({ items: [{ title: 'A &amp; B', link: 'https://so/1' }] }))[0]
            .title === 'A & B');
    check('specialised parsers survive junk',
        [parseGitHub, parseNpm, parseNvd, parseHackerNews, parseStackExchange]
            .every((f) => f('{bad json').length === 0));
}

/* -------------------------------------------------------- local index ---- */
{
    const now = () => Date.parse('2026-07-30T12:00:00Z');
    const docs = [
        { title: 'Chrome security update fixes CVE-2026-1', summary: 'Google patched a high severity flaw', url: 'https://a/1', source: 'Chrome', publishedTs: now() - 3600000 },
        { title: 'SEC 8-K filing for Acme Corp', summary: 'Item 7.01 Regulation FD Disclosure', url: 'https://a/2', source: 'SEC', publishedTs: now() - 86400000 },
        { title: 'Old chrome note', summary: 'chrome chrome chrome chrome chrome', url: 'https://a/3', source: 'Blog', publishedTs: now() - 90 * 86400000 },
        { title: 'Unrelated', summary: 'nothing to see', url: 'https://a/4', publishedTs: now() },
    ];

    const hits = bm25Search(docs, 'chrome security update', { now });
    check('bm25: finds the matching document', hits.length > 0);
    check('bm25: ranks the on-topic recent item first', hits[0].url === 'https://a/1');
    check('bm25: excludes documents with no matching term',
        !hits.some((h) => h.url === 'https://a/4'));
    check('bm25: marks results as local', hits[0].local === true);
    check('bm25: carries the feed name as the source', hits[0].source === 'Chrome');

    // IDF is what stops a term that appears everywhere from deciding the order.
    const common = bm25Search(
        Array.from({ length: 20 }, (_, i) => ({ title: 'filing update', summary: 'update', url: `https://c/${i}`, publishedTs: now() })),
        'update', { now },
    );
    check('bm25: a term in every document does not dominate', common.length <= 8);

    check('bm25: stopwords alone match nothing', bm25Search(docs, 'the and for', { now }).length === 0);
    check('bm25: empty corpus is safe', bm25Search([], 'chrome', { now }).length === 0);
    check('bm25: junk corpus is safe', bm25Search(null, 'chrome', { now }).length === 0);
    check('bm25: empty query is safe', bm25Search(docs, '', { now }).length === 0);
    check('bm25: drops entries with no URL',
        bm25Search([{ title: 'chrome thing', summary: 'x' }], 'chrome', { now }).length === 0);
    check('bm25: honours the limit', bm25Search(docs, 'chrome', { now, limit: 1 }).length === 1);

    // Recency should re-order near-ties, not override relevance outright.
    const fresh = bm25Search(docs, 'chrome', { now });
    check('bm25: recency favours the newer of two similar matches',
        fresh[0].url === 'https://a/1' || fresh[0].url === 'https://a/3');
}

/* ------------------------------------------------- citation verification -- */
{
    const source = 'The sky appears blue because shorter wavelengths of sunlight scatter more strongly in the atmosphere.';

    const ok = verifyAnswer('shorter wavelengths of sunlight scatter more strongly', source);
    check('verify: an extracted claim is supported', ok.verified === true);
    check('verify: reports the overlap', ok.overlap > 0.9);

    const bad = verifyAnswer('CVE-2026-15905 is the latest critical vulnerability in Chrome', source);
    check('verify: a fabricated claim is rejected', bad.verified === false);
    check('verify: explains why', /not found in source/.test(bad.reason));

    check('verify: empty claim is not verified', verifyAnswer('', source).verified === false);
    check('verify: empty source rejects everything', verifyAnswer('anything at all here', '').verified === false);
    check('verify: whitespace and case differences still verify',
        verifyAnswer('SHORTER   WAVELENGTHS of Sunlight', source).verified === true);
    check('verify: threshold is honourable',
        verifyAnswer('shorter wavelengths and completely invented nonsense words', source,
            { threshold: 0.99 }).verified === false);
}

/* ------------------------------------------------------------ gather ----- */
{
    const P = (id) => ({ id });

    const fast = await gatherAll(
        [P('a'), P('b')],
        async (p) => [{ title: p.id, url: `https://${p.id}.com` }],
        { budgetMs: 1000, minProviders: 99 },
    );
    check('gather: keeps every provider that answered', fast.lists.length === 2);

    // The property that matters: a slow provider must not extend the wait.
    const t0 = Date.now();
    const slow = await gatherAll(
        [P('quick'), P('hang')],
        async (p) => {
            if (p.id === 'hang') await new Promise((r) => setTimeout(r, 5000));
            return [{ title: p.id, url: `https://${p.id}.com` }];
        },
        { budgetMs: 300, minProviders: 99 },
    );
    const waited = Date.now() - t0;
    check('gather: a hung provider does not extend the deadline', waited < 1200);
    check('gather: returns what did arrive', slow.lists.length === 1 && slow.lists[0].provider === 'quick');

    const failed = await gatherAll(
        [P('broken')],
        async () => { throw new Error('nope'); },
        { budgetMs: 300 },
    );
    check('gather: a throwing provider is recorded, not fatal',
        failed.lists.length === 0 && /broken: nope/.test(failed.errors[0]));
    check('gather: empty provider list resolves',
        (await gatherAll([], async () => [], { budgetMs: 100 })).lists.length === 0);

    /* The early exit counts PROVIDERS, not results. Counting results let one
       source that returns six finish the query alone, which quietly turned
       this back into a first-wins race. Two fast providers plus one slow one:
       the fast pair must satisfy it without waiting for the straggler. */
    const early = await gatherAll(
        [P('fast1'), P('fast2'), P('slow')],
        async (p) => {
            if (p.id === 'slow') await new Promise((r) => setTimeout(r, 2500));
            return [{ url: `https://${p.id}/1` }, { url: `https://${p.id}/2` }];
        },
        { budgetMs: 3000, minProviders: 2 },
    );
    check('gather: enough distinct providers finishes before the deadline', early.elapsedMs < 1500);
    check('gather: and it really did collect several sources', early.lists.length >= 2);

    // The regression that hid for a whole run: one prolific provider must not
    // be able to end the gather by itself.
    const prolific = await gatherAll(
        [P('bulk'), P('other')],
        async (p) => {
            if (p.id === 'other') await new Promise((r) => setTimeout(r, 120));
            return p.id === 'bulk' ? Array.from({ length: 20 }, (_, i) => ({ url: `https://b/${i}` }))
                                   : [{ url: 'https://o/1' }];
        },
        { budgetMs: 2000, minProviders: 2 },
    );
    check('gather: one prolific provider cannot end the gather alone',
        prolific.lists.length === 2);
}

/* -------------------------------------------------------------- fusion --- */
{
    const a = [{ url: 'https://x/1', title: 'one' }, { url: 'https://x/2', title: 'two' }];
    const b = [{ url: 'https://x/2', title: 'two' }, { url: 'https://x/3', title: 'three' }];

    const fused = rrfFuse([{ results: a }, { results: b }]);
    check('rrf: a result found by two sources outranks single-source ones',
        fused[0].url === 'https://x/2');
    check('rrf: records how many sources agreed', fused[0]._sources === 2);
    check('rrf: keeps every distinct result', fused.length === 3);
    check('rrf: accepts bare arrays as well as {results}',
        rrfFuse([a, b])[0].url === 'https://x/2');
    check('rrf: honours the limit', rrfFuse([a, b], { limit: 1 }).length === 1);
    check('rrf: normalises URLs when deduping',
        rrfFuse([[{ url: 'https://x/1/' }], [{ url: 'https://x/1?utm=1' }]]).length === 1);
    check('rrf: prefers the richer snippet of a duplicate',
        rrfFuse([[{ url: 'https://x/1', snippet: 'short' }],
                 [{ url: 'https://x/1', snippet: 'a much longer and more useful snippet' }]])[0]
            .snippet.startsWith('a much longer'));
    check('rrf: junk in, empty out', rrfFuse(null).length === 0 && rrfFuse([null, {}]).length === 0);
    check('rrf: drops entries with no URL', rrfFuse([[{ title: 'no url' }]]).length === 0);
}

/* ------------------------------------------------------------ page text -- */
{
    const page = `<html><head><title>T</title>
        <style>body{color:red}</style>
        <script>var x = "<p>not text</p>"; if (a < b) {}</script>
      </head><body>
        <nav><a href="/">Home</a><a href="/x">About</a></nav>
        <h1>Rayleigh scattering</h1>
        <p>The sky appears blue because shorter wavelengths scatter more strongly.</p>
        <ul><li>First point</li><li>Second point</li></ul>
        <footer>Copyright 2026 Example Inc</footer>
      </body></html>`;

    const text = htmlToText(page);
    check('htmlToText: drops script bodies, not just tags', !/var x|not text/.test(text));
    check('htmlToText: drops style bodies', !/color:red/.test(text));
    check('htmlToText: drops nav boilerplate', !/About/.test(text));
    check('htmlToText: drops footer boilerplate', !/Copyright/.test(text));
    check('htmlToText: keeps the real prose', /shorter wavelengths scatter more strongly/.test(text));
    check('htmlToText: keeps list items', /First point/.test(text));
    check('htmlToText: separates blocks so sentences do not merge',
        !/scattering\s*The sky/.test(text) || /\n/.test(text));
    check('htmlToText: no leftover tags', !/</.test(text.replace(/</g, '')) && !/<[a-z]/i.test(text));
    check('htmlToText: junk input does not throw', typeof htmlToText(null) === 'string');
    check('htmlToText: decodes entities', /&/.test(htmlToText('<p>a &amp; b</p>')));

    const answer = extractAnswer(text, 'why is the sky blue');
    check('extractAnswer: picks the sentence containing the query terms',
        /shorter wavelengths/.test(answer));
    check('extractAnswer: no query terms yields nothing',
        extractAnswer(text, 'zzzz qqqq') === '');
    check('extractAnswer: empty query yields nothing', extractAnswer(text, '') === '');
    check('extractAnswer: skips fragments too short to stand alone',
        extractAnswer('sky. blue. hi.', 'sky blue') === '');
    check('extractAnswer: truncates long passages on a word boundary', (() => {
        // ~500 chars: inside the 600-char sentence cap, past the 400-char
        // spoken budget, so truncation is the behaviour under test.
        const long = `The sky is blue ${'because of scattering '.repeat(22)}end.`;
        const a = extractAnswer(long, 'sky blue');
        return a.endsWith('...') && a.length <= 404 && !/\s$/.test(a.slice(0, -3));
    })());
    check('extractAnswer: leaves a passage inside the budget intact',
        !extractAnswer('The sky is blue because shorter wavelengths scatter more in air.', 'sky blue')
            .endsWith('...'));
}

/* ---------------------------------------------------------------- cache -- */
{
    let clock = 0;
    const c = new SearchCache({ ttlMs: 1000, max: 3, now: () => clock });

    check('cache: miss on an unseen query', c.get('bitcoin') === null);
    c.set('bitcoin', { results: [1] });
    check('cache: hit returns the stored payload', c.get('bitcoin').results[0] === 1);
    check('cache: normalises case and spacing',
        c.get('  BITCOIN  ') !== null && c.get('bitcoin') !== null);

    clock = 1001;
    check('cache: expires past its TTL, because a search asks about now',
        c.get('bitcoin') === null);

    clock = 0;
    const l = new SearchCache({ ttlMs: 99999, max: 2, now: () => clock });
    l.set('a', 1); l.set('b', 2); l.set('c', 3);
    check('cache: evicts the oldest past max', l.get('a') === null);
    check('cache: keeps the newest', l.get('c') === 3);

    const r = new SearchCache({ ttlMs: 99999, max: 2, now: () => clock });
    r.set('a', 1); r.set('b', 2);
    r.get('a');            // refresh recency
    r.set('c', 3);
    check('cache: a re-asked query survives eviction', r.get('a') === 1);
    r.get('never-asked');
    check('cache: counts hits and misses', r.hits > 0 && r.misses > 0);
}

/* -------------------------------------------------- query understanding -- */
{
    check('edit: identical strings', editDistance('abc', 'abc') === 0);
    check('edit: one substitution', editDistance('cat', 'cut') === 1);
    check('edit: transposition costs 1, not 2',
        editDistance('recieve', 'receive') === 1);
    check('edit: empty against non-empty', editDistance('', 'abc') === 3);
    check('edit: case-insensitive', editDistance('Nvidia', 'nvidia') === 0);

    // The user's REAL typos, verbatim from the interaction log.
    const real = [
        ['situtational awareness', 'situational awareness'],
        ['reccently', 'recently'],
        ['nvdia', 'nvidia'],
        ['micorn', 'micron'],
        ['jamie diamond', 'Jamie Dimon'],
    ];
    for (const [typo, fixed] of real) {
        const v = shouldApplyCorrection(typo, fixed);
        check(`correct: "${typo}" -> "${fixed}"`, v.apply === true, JSON.stringify(v));
    }

    // A suggestion must never quietly become a different question.
    check('correct: refuses a different query',
        shouldApplyCorrection('bitcoin price', 'Ethereum roadmap').apply === false);
    check('correct: refuses a restructured query',
        shouldApplyCorrection('rust', 'Rust programming language history').apply === false);
    check('correct: refuses short words where one edit is most of the word',
        shouldApplyCorrection('cat', 'cut').apply === false);
    check('correct: no change is not a correction',
        shouldApplyCorrection('nvidia', 'nvidia').apply === false);
    check('correct: empty input is safe',
        shouldApplyCorrection('', 'anything').apply === false);
    check('correct: null is safe', shouldApplyCorrection(null, null).apply === false);
    check('correct: reports a confidence', shouldApplyCorrection('nvdia', 'nvidia').confidence > 0.7);
    check('correct: a rejected correction still explains itself',
        /different query|too dissimilar|too short/.test(
            shouldApplyCorrection('cat', 'elephant').reason));
}

/* ----------------------------------------------------- handler arg shape - */
{
    /* The IPC handler accepts a bare string as well as { query }. Two renderer
       call sites use different shapes — the EDGAR corroboration step passes a
       string, handleWebSearch passes an object — and reading only opts.query
       turned every string call into "empty query": a silently broken feature
       that still reported success. Replicated here because the handler itself
       lives in electron.js and cannot be imported outside Electron. */
    const normalise = (opts) => {
        const isString = typeof opts === 'string';
        return {
            query: String((isString ? opts : opts?.query) || '').trim().slice(0, 200),
            limit: Math.min(Math.max(Number(isString ? 6 : opts?.limit) || 6, 1), 10),
        };
    };

    check('args: a bare string is a query', normalise('rust async').query === 'rust async');
    check('args: an object is a query', normalise({ query: 'rust async' }).query === 'rust async');
    check('args: string form gets the default limit', normalise('x').limit === 6);
    check('args: object limit is honoured', normalise({ query: 'x', limit: 3 }).limit === 3);
    check('args: limit is clamped', normalise({ query: 'x', limit: 999 }).limit === 10);
    check('args: empty string yields an empty query', normalise('').query === '');
    check('args: null is survivable', normalise(null).query === '');
    check('args: over-long queries are truncated', normalise('a'.repeat(500)).query.length === 200);
}

/* -------------------------------------------------------------- escaping - */
{
    check('entities: decodes &amp; last so &amp;lt; is not double-decoded',
        decodeEntities('a &amp;lt; b') === 'a &lt; b');
    check('entities: numeric', decodeEntities('&#65;&#66;') === 'AB');
    check('entities: hex', decodeEntities('&#x41;') === 'A');
    check('stripTags: removes markup', stripTags('<b>bold</b> text') === 'bold text');
    check('stripTags: collapses whitespace', stripTags('a\n\n   b') === 'a b');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
