/**
 * Renderer half of web search: deciding that an utterance IS a search, and
 * saying the results out loud.
 *
 * Split from webSearch.js along the process boundary rather than by topic.
 * webSearch.js runs in the Electron main process and is CommonJS, because that
 * is where the fetching has to happen — the renderer cannot call DuckDuckGo or
 * Brave directly, CORS blocks it. Rollup cannot take named imports from a
 * CommonJS file, so the renderer gets its own ES module instead of reaching
 * across. Nothing is duplicated: main parses and ranks, this routes and speaks.
 */

function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); }
    catch { return ''; }
}

/**
 * Does this utterance ask for a web search?
 *
 * Written against the real misroutes in the interaction log for 21-30 Jul 2026.
 * "search about jamie diamond", "search bitcoin price today" and "search latest
 * stocks data" were all classified TYPE_TEXT — the dictation intent — so asking
 * Jarvis to search made it start typing. Everything that instead reached
 * AI_COMMAND was answered by the local model from memory, with invented sources
 * ("According to Google's Chrome Releases, CVE-2026-15905 ...").
 *
 * Two rules follow. The dictation verb is "type", so "search" must never reach
 * it. And the specialised handlers that already work must keep their traffic:
 * news has an RSS path measured at 542-1188ms and filings have an EDGAR path,
 * both faster and better sourced than a general web search.
 */
export function parseWebSearchQuery(cmd) {
    const text = String(cmd || '').trim();
    if (!text) return null;

    // Let the specialised handlers win — they are faster and better sourced.
    if (/\b(news|headlines?)\b/i.test(text)) return null;
    if (/\b(10-?k|10-?q|8-?k|filing|filings|edgar|sec)\b/i.test(text)) return null;
    if (/\bcve-\d{4}-\d+/i.test(text)) return null;

    /* THE USER'S OWN STUFF IS NOT ON THE WEB. "search my files" must reach
       SEARCH_FILE, and this router runs before it, so without this guard the
       question is answered by Wikipedia instead of the filesystem. The guard
       existed in inputControl.js and was lost when that branch was removed;
       it is restored here, where the interception now happens. */
    if (/\b(my|our)\s+(files?|notes?|documents?|downloads?|bookmarks?|history|memory|memories|system|screen|processes|network|disk|drive|folder|emails?|messages?)\b/i.test(text)) {
        return null;
    }

    const m = text.match(
        /^(?:can you |could you |please )?(?:do a |do |run a |run )?(?:web ?search|search the web|search online|google|look up|search up|search for|search|find (?:information |info |stuff )?(?:about |on |for )?|find)\b[:\s]*(.*)$/i
    );
    if (m) {
        const query = cleanQuery(m[1]);
        // "can you do web search" is a capability question, not a search request.
        if (!query || /^(please|now|it|that|this)$/i.test(query)) return null;
        return { query };
    }

    /* An explicit "search" prefix is NOT required, and requiring it was the
       real gap: asking "what is quantum computing" out loud went to the local
       model, which has no network access and answers from memory — the exact
       path that produced invented citations. A question about the world is a
       search whether or not the user says the word "search".

       Scoped to questions, so ordinary conversation and device commands are
       untouched: "open notepad" and "thank you" must never hit the network. */
    const question = text.match(
        /^(?:hey |ok |so |and )?(?:jarvis[,\s]+)?((?:who|what|what's|whats|when|where|why|how|which|is|are|was|were|does|do|did|can|should|tell me about|explain)\b.*)$/i
    );
    if (!question) return null;

    const query = cleanQuery(question[1]);
    if (!query) return null;

    /* Self-directed and device questions stay local — Jarvis knows its own
       state and the machine's better than the web does. */
    if (/\b(you|your|yourself|jarvis|my (screen|system|cpu|ram|memory|file|note|battery)|this (screen|window|page)|time|date|weather here)\b/i.test(query)) {
        return null;
    }
    // Too short to be a real question ("what", "how so").
    if (query.split(/\s+/).length < 3) return null;

    return { query };
}

function cleanQuery(raw) {
    return String(raw || '')
        .replace(/^(?:for|about|on|regarding|me)\s+/i, '')
        .replace(/[?.!]+$/, '')
        .trim();
}

/**
 * What Jarvis says out loud.
 *
 * Sources are named because the user is listening, not reading: "from
 * reuters.com" is checkable by ear, a URL is not. Nothing here paraphrases or
 * synthesises. The failure this replaces was a model turning search results
 * into confident prose with fabricated citations, so the spoken answer stays
 * limited to titles and the sites they came from.
 */
export function summarizeForSpeech(results, query, { limit = 3, answer = null } = {}) {
    const top = (results || []).slice(0, limit);
    if (!top.length) return `I could not find any results for ${query}, Sir.`;

    /* An actual answer beats a list of headlines. Reading three titles aloud
       makes the listener do the work; a sentence from the page answers the
       question they asked. The source is still named, because the point is that
       this came from a real page rather than from the model. */
    if (answer && answer.answer) {
        const host = hostOf(answer.url);
        return `${answer.answer}${host ? ` That is from ${host}.` : ''}`;
    }

    const parts = top.map((r, i) => {
        const host = hostOf(r.url);
        return `${i + 1}. ${r.title}${host ? `, from ${host}` : ''}`;
    });
    return `Here is what I found for ${query}. ${parts.join('. ')}.`;
}

/** The on-screen version keeps the URLs, which speech cannot carry. */
export function formatForDisplay(results, query, { provider = null, limit = 6, answer = null, correction = null } = {}) {
    const top = (results || []).slice(0, limit);
    const header = `Web search: ${query}${provider ? ` — via ${provider}` : ''}`
        + (correction ? `\n(corrected from "${correction}")` : '');
    if (!top.length) return `${header}\nNo results.`;
    const lead = answer && answer.answer ? `\n${answer.answer}\n     — ${answer.url}\n` : '';
    const body = top.map((r, i) => {
        const snip = r.snippet ? `\n     ${r.snippet.slice(0, 160)}` : '';
        return `${i + 1}. ${r.title}\n     ${r.url}${snip}`;
    }).join('\n');
    return `${header}\n${lead}${body}`;
}

export { hostOf };
