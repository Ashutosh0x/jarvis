// Tests for the renderer half of web search: intent routing and phrasing.
//
// Every case here is taken from the interaction log for 21-30 Jul 2026, where
// each "search ..." utterance was misrouted to dictation (TYPE_TEXT) or sent to
// the local model, which answered with invented citations.
import {
    parseWebSearchQuery, summarizeForSpeech, formatForDisplay, hostOf,
} from '../webSearchIntent.js';

let pass = 0, fail = 0;
const check = (n, c) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); };

/* ---------------------------------------------------------- intent ------- */
{
    // The exact utterances that became TYPE_TEXT (dictation) in the log.
    const real = [
        ['search about jamie diamond', 'jamie diamond'],
        ['search bitcoin price today', 'bitcoin price today'],
        ['search latest stocks data', 'latest stocks data'],
        ['search about elon musk', 'elon musk'],
        ['web search about elon musk recent project', 'elon musk recent project'],
        ['google quantum computing', 'quantum computing'],
        ['look up the boiling point of mercury', 'the boiling point of mercury'],
        ['can you do a web search for rust lifetimes', 'rust lifetimes'],
        ['search for tokio runtime', 'tokio runtime'],
    ];
    for (const [input, expected] of real) {
        const got = parseWebSearchQuery(input);
        check(`intent: "${input}" -> "${expected}"`, got && got.query === expected);
    }

    check('intent: "search me google" no longer dictates',
        parseWebSearchQuery('search me google')?.query === 'google');

    // Capability questions are not searches — these were 26-40s of local
    // inference each in the log, for a question about Jarvis itself.
    check('intent: bare capability question is not a search',
        parseWebSearchQuery('can you do web search') === null);
    check('intent: "can you do all web sites?" is not a search',
        parseWebSearchQuery('can you do all web sites?') === null);

    // The faster specialised paths must keep their traffic.
    check('intent: news still goes to the RSS path',
        parseWebSearchQuery('search todays news') === null);
    check('intent: headlines still go to the RSS path',
        parseWebSearchQuery('google latest headlines') === null);
    check('intent: filings still go to EDGAR',
        parseWebSearchQuery('search google sec filings') === null);
    check('intent: 10-K still goes to EDGAR',
        parseWebSearchQuery('look up nvidia 10-K') === null);
    check('intent: a CVE id still goes to the CVE path',
        parseWebSearchQuery('search CVE-2026-15905') === null);

    // Dictation must not be captured — "type" is the dictation verb.
    /* No "search" prefix required. Requiring one was the real gap: a spoken
       question went to the local model, which has no network and answers from
       memory — the path that produced the invented citations. */
    check('question: "what is X" is a live search',
        parseWebSearchQuery('what is quantum computing')?.query === 'what is quantum computing');
    check('question: "who is X" is a live search',
        parseWebSearchQuery('who is the ceo of nvidia') !== null);
    check('question: "how does X work" is a live search',
        parseWebSearchQuery('how does rayleigh scattering work') !== null);
    check('question: a wake word is stripped',
        parseWebSearchQuery('hey jarvis, what is a monad')?.query === 'what is a monad');
    check('question: "tell me about X" is a live search',
        parseWebSearchQuery('tell me about the apollo program') !== null);

    // Conversation and device commands must never reach the network.
    check('question: self-directed questions stay local',
        parseWebSearchQuery('what is your name') === null);
    check('question: machine questions stay local',
        parseWebSearchQuery('what is my cpu usage') === null);
    check('question: screen questions stay local',
        parseWebSearchQuery('what is on my screen') === null);
    check('question: the time stays local', parseWebSearchQuery('what is the time') === null);
    check('question: too short to be a real question',
        parseWebSearchQuery('what now') === null);
    check('question: statements are not searches',
        parseWebSearchQuery('i will take care of that') === null);
    check('question: thanks is not a search', parseWebSearchQuery('thank you') === null);

    check('intent: dictation is untouched', parseWebSearchQuery('type hello world') === null);
    check('intent: unrelated command is untouched', parseWebSearchQuery('open notepad') === null);
    check('intent: empty input', parseWebSearchQuery('') === null);
    check('intent: null input', parseWebSearchQuery(null) === null);
    check('intent: trailing punctuation is stripped',
        parseWebSearchQuery('search for rust async?')?.query === 'rust async');
}

/* ----------------------------------------------------------- phrasing ---- */
{
    const results = [
        { title: 'Reuters story', url: 'https://www.reuters.com/x' },
        { title: 'BBC story', url: 'https://bbc.co.uk/y' },
        { title: 'Third', url: 'https://third.io/z' },
        { title: 'Fourth', url: 'https://fourth.io/w' },
    ];
    const spoken = summarizeForSpeech(results, 'elon musk');
    check('speech: names the source domain, which is checkable by ear',
        /reuters\.com/.test(spoken));
    check('speech: strips the www prefix', !/www\./.test(spoken));
    check('speech: reads three results, not all of them', !/Fourth/.test(spoken));
    check('speech: no results is stated plainly, not invented',
        /could not find/.test(summarizeForSpeech([], 'nothing at all')));

    const shown = formatForDisplay(results, 'elon musk', { provider: 'duckduckgo-html' });
    check('display: keeps URLs that speech cannot carry', /https:\/\/www\.reuters\.com\/x/.test(shown));
    check('display: names the provider', /duckduckgo-html/.test(shown));
    check('display: empty state', /No results/.test(formatForDisplay([], 'q')));

    check('hostOf: strips www', hostOf('https://www.example.com/a') === 'example.com');
    check('hostOf: junk yields empty', hostOf('not a url') === '');
}


console.log(`
${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
