// Tests for Spotify command parsing.
//
// The sharp edge here is the spoken confirmation. Three outcomes are possible —
// playback actually started, the desktop app was handed a URI, or a browser tab
// was opened — and only the first is playing music. Saying "playing" for the
// other two is the claimed-success failure this project has fixed in the phone
// tools, the local model and the mirror. It is tested explicitly.

import {
    parseSpotifyCommand, buildSearchQuery, firstTrack, webPlayerUrl,
    describeHandoff, HANDOFF
} from '../spotifyIntent.js';

let pass = 0, fail = 0;
const check = (n, c) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); };
const parse = (s) => parseSpotifyCommand(s);

/* --- play, with a subject -------------------------------------------------- */
{
    const cases = [
        ['play starboy by the weeknd', 'starboy by the weeknd'],
        ['jarvis, play bohemian rhapsody', 'bohemian rhapsody'],
        ['put on some lofi beats', 'lofi beats'],
        ['listen to daft punk', 'daft punk'],
        ['play me hello by adele', 'hello by adele'],
        ['queue up interstellar soundtrack', 'interstellar soundtrack']
    ];
    for (const [say, want] of cases) {
        const r = parse(say);
        check(`"${say}" -> play "${want}"`, r?.action === 'play' && r.query === want);
    }

    /* The service name is not part of the song title. Left in, the search runs
       for a phrase containing "spotify" and returns something else. */
    for (const say of [
        'play starboy on spotify',
        'play starboy via spotify',
        'play starboy using spotify'
    ]) {
        check(`"${say}" strips the service`, parse(say)?.query === 'starboy');
    }
}

/* --- play, WITHOUT a subject, is resume ----------------------------------- */
{
    /* "play music" has nothing to search for. Treated as a query it searches
       for the word "music" and plays a song called Music. */
    for (const say of ['play', 'play music', 'play something', 'play some music', 'resume', 'continue']) {
        check(`"${say}" -> resume`, parse(say)?.action === 'resume');
    }
}

/* --- transport ------------------------------------------------------------- */
{
    for (const [say, want] of [
        ['pause', 'pause'], ['pause the music', 'pause'], ['stop the music', 'pause'],
        ['next', 'next'], ['skip this song', 'next'],
        ['previous', 'previous'], ['go back', 'previous'],
        ["what's this song", 'now_playing'], ['who sings this', 'now_playing']
    ]) {
        check(`"${say}" -> ${want}`, parse(say)?.action === want);
    }
}

/* --- what must NOT be a music command ------------------------------------- */
{
    /* "play X on my phone" belongs to the phone router. Claiming it here plays
       on the wrong device — the same precedence class as "open chrome on my
       phone" opening it on the PC. */
    for (const say of [
        'play starboy on my phone',
        'play some music on my phone',
        'play this on my tv'
    ]) {
        check(`"${say}" is left to the phone router`, parse(say) === null);
    }

    for (const say of [
        'what time is it', 'mirror my phone', 'empty the recycle bin',
        'search for rust tutorials', 'thank you', ''
    ]) {
        check(`"${say || '(empty)'}" is not a music command`, parse(say) === null);
    }
    check('null is safe', parse(null) === null);
}

/* --- search query construction -------------------------------------------- */
{
    /* Field filters matter: without them a popular ARTIST name outranks the
       requested TRACK, so "hello by adele" can return an Adele song that is
       not Hello. */
    check('"X by Y" becomes a fielded query',
        buildSearchQuery('starboy by the weeknd') === 'track:starboy artist:the weeknd');
    check('another one', buildSearchQuery('hello by adele') === 'track:hello artist:adele');
    check('no "by" passes through unchanged',
        buildSearchQuery('lofi hip hop radio') === 'lofi hip hop radio');
    check('empty is empty', buildSearchQuery('') === '');
    // "by" inside a title must not be mistaken for the separator when there is
    // nothing after it.
    check('a trailing "by" is not a separator', buildSearchQuery('stand by') === 'stand by');
}

/* --- response shaping ------------------------------------------------------ */
{
    /* Shape taken from the REAL response measured against the live API. */
    const real = {
        tracks: {
            items: [{
                id: '7MXVkk9YMctZqd1Srtv4MB',
                uri: 'spotify:track:7MXVkk9YMctZqd1Srtv4MB',
                name: 'Starboy',
                artists: [{ name: 'The Weeknd' }, { name: 'Daft Punk' }],
                album: { name: 'Starboy' },
                external_urls: { spotify: 'https://open.spotify.com/track/7MXVkk9YMctZqd1Srtv4MB' }
            }]
        }
    };
    const t = firstTrack(real);
    check('the track is extracted', t?.name === 'Starboy');
    check('every artist is kept, not just the first',
        t.artists.length === 2 && t.artists[1] === 'Daft Punk');
    check('the uri is kept', t.uri === 'spotify:track:7MXVkk9YMctZqd1Srtv4MB');
    check('the web url is kept', /open\.spotify\.com/.test(webPlayerUrl(t)));

    check('an empty result is null', firstTrack({ tracks: { items: [] } }) === null);
    check('a malformed response is null', firstTrack({}) === null);
    check('null is null', firstTrack(null) === null);

    // The URL is derivable when the API omits external_urls.
    const bare = firstTrack({ tracks: { items: [{ id: 'abc', uri: 'spotify:track:abc', name: 'X', artists: [] }] } });
    check('a web url is derived from the id',
        webPlayerUrl(bare) === 'https://open.spotify.com/track/abc');
}

/* --- THE CONFIRMATION MUST MATCH WHAT HAPPENED ---------------------------- */
{
    const t = { name: 'Starboy', artists: ['The Weeknd'], id: 'x', uri: 'spotify:track:x', url: null };

    const api = describeHandoff(t, HANDOFF.WEB_API);
    const desktop = describeHandoff(t, HANDOFF.DESKTOP);
    const browser = describeHandoff(t, HANDOFF.BROWSER);

    check('web-api playback says "playing"', /^Playing /.test(api));
    check('desktop handoff says "opening", not "playing"',
        /Opening/.test(desktop) && !/^Playing/.test(desktop));
    /* The important one. A browser tab plays nothing until the user presses
       play, so a confirmation implying audio has started is false. */
    check('browser handoff does NOT claim playback',
        !/^Playing/.test(browser) && /web player/i.test(browser));
    check('all three name the track', [api, desktop, browser].every((s) => /Starboy/.test(s)));
    check('all three name the artist', [api, desktop, browser].every((s) => /The Weeknd/.test(s)));

    check('a missing track says so plainly',
        /could not find/i.test(describeHandoff(null, HANDOFF.WEB_API)));
    check('an unknown handoff does not claim success',
        !/^Playing/.test(describeHandoff(t, 'something-else')));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
