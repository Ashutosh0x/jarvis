// Spotify command parsing and result shaping.
//
// PURE. No fetch, no OAuth, no window. spotifyService.js does the network.
//
// ---------------------------------------------------------------------------
// WHAT ACTUALLY WORKS HERE, MEASURED 2 AUG 2026 — because the integration doc
// this came from describes a playback path this machine cannot run:
//
//   Web API search .............. WORKS. Verified 200 with real results.
//   Web API playback ............ BLOCKED. Premium-gated; the dashboard says
//                                 the app is blocked from the Web API without
//                                 it, and the issued token lacked the playback
//                                 scopes anyway (401 "Permissions missing").
//   spotify: desktop URI ........ UNAVAILABLE. Spotify is not installed on
//                                 this machine and the protocol is not
//                                 registered, so Start-Process would fail
//                                 silently — the doc's fallback is not a
//                                 fallback here.
//   open.spotify.com ............ WORKS. Free accounts, no install needed.
//
// So the design is: resolve the track for real through the API, then hand off
// to whichever player actually exists. And say which one happened — "playing"
// is a claim this cannot always make, and claiming it is the failure mode this
// project has fixed repeatedly.
// ---------------------------------------------------------------------------

/** How the track was handed off. The spoken line is built from this. */
export const HANDOFF = Object.freeze({
    WEB_API: 'web-api',       // playback actually started on a device
    DESKTOP: 'desktop-uri',   // handed to the installed Spotify app
    BROWSER: 'web-player'     // opened open.spotify.com
});

/* Trailing service names. "play bohemian rhapsody on spotify" is a request to
   play Bohemian Rhapsody, not to search for the words "on spotify". */
const TRAILING_SERVICE = /\s+(?:on|via|from|using|through)\s+(?:spotify|the spotify app)\s*$/i;

/* Phrases that mean "resume", not "play <something>". Checked before the
   query extraction, since "play" leads both. */
const RESUME = /^(?:jarvis[,\s]+)?(?:play|resume|unpause|continue)(?:\s+(?:the\s+)?(?:music|song|track|it|that|playback))?\s*$/i;

/* The determiner varies — "skip the song", "skip this song", "skip that one".
   A `the`-only group missed "skip this song", which is the commonest of the
   three in speech. */
const DET = '(?:the|this|that|a)\\s+';
const PAUSE = new RegExp(`^(?:jarvis[,\\s]+)?(?:pause|stop|halt)(?:\\s+(?:${DET})?(?:music|song|track|spotify|playback|it))?\\s*$`, 'i');
const NEXT = new RegExp(`^(?:jarvis[,\\s]+)?(?:next|skip)(?:\\s+(?:${DET})?(?:song|track|one))?\\s*$`, 'i');
const PREV = new RegExp(`^(?:jarvis[,\\s]+)?(?:previous|prev|go back|last)(?:\\s+(?:${DET})?(?:song|track|one))?\\s*$`, 'i');
const NOW_PLAYING = /^(?:jarvis[,\s]+)?(?:what(?:'?s| is)\s+(?:this\s+|the\s+)?(?:song|track|playing|music)|who\s+sings\s+this|name\s+this\s+(?:song|track))\b/i;

/**
 * Parse a music command.
 *
 * @returns {{action:string, query?:string}|null}
 *   `play` carries a query; the transport actions do not.
 */
export function parseSpotifyCommand(text) {
    const raw = String(text ?? '').trim();
    if (!raw) return null;

    if (NOW_PLAYING.test(raw)) return { action: 'now_playing' };
    if (PAUSE.test(raw)) return { action: 'pause' };
    if (NEXT.test(raw)) return { action: 'next' };
    if (PREV.test(raw)) return { action: 'previous' };
    if (RESUME.test(raw)) return { action: 'resume' };

    /* "play X" / "put on X" / "listen to X".

       NOT anchored on a trailing "on spotify", because people mostly do not
       say it — the service is implied by the verb. But when they do, it is
       stripped, or the search runs for a phrase containing the word Spotify
       and returns a song called something else entirely. */
    const m = raw.match(/^(?:jarvis[,\s]+)?(?:play|put on|listen to|queue(?:\s+up)?)\s+(.+)$/i);
    if (!m) return null;

    let query = m[1].replace(TRAILING_SERVICE, '').trim();
    query = query.replace(/^(?:me\s+|some\s+)/i, '').trim();
    /* "play something" / "play music" has no subject to search for — it is a
       resume, and treating it as a query searches for the word "something". */
    if (!query || /^(?:music|something|anything|a song|some music)$/i.test(query)) {
        return { action: 'resume' };
    }
    /* A trailing "on my phone" belongs to the phone router, not here. Returning
       null lets it fall through rather than playing on the wrong device. */
    if (/\bon\s+(?:my\s+)?(?:phone|mobile|android|tv|speaker)\b/i.test(query)) return null;

    return { action: 'play', query };
}

/**
 * Build the search query sent to Spotify.
 *
 * "starboy by the weeknd" becomes `track:starboy artist:the weeknd`, which is
 * materially better than the raw string: the field filters stop a popular
 * ARTIST name from outranking the requested TRACK. Without them, "play hello
 * by adele" can return an Adele track that is not Hello.
 */
export function buildSearchQuery(spoken) {
    const s = String(spoken ?? '').trim();
    if (!s) return '';
    const by = s.match(/^(.+?)\s+by\s+(.+)$/i);
    if (by) {
        const track = by[1].trim();
        const artist = by[2].trim();
        if (track && artist) return `track:${track} artist:${artist}`;
    }
    return s;
}

/**
 * Turn a Spotify search response into the one track, or null.
 *
 * Takes the API's own ordering rather than re-ranking: relevance is what the
 * search endpoint is for, and a local re-rank on title similarity demotes
 * legitimate remasters and live versions the user may well have meant.
 */
export function firstTrack(searchJson) {
    const item = searchJson?.tracks?.items?.[0];
    if (!item || !item.uri || !item.name) return null;
    return {
        uri: item.uri,
        id: item.id ?? String(item.uri).split(':').pop(),
        name: item.name,
        artists: Array.isArray(item.artists) ? item.artists.map((a) => a.name).filter(Boolean) : [],
        album: item.album?.name ?? null,
        url: item.external_urls?.spotify ?? null
    };
}

/** `open.spotify.com` link for a track — the path that needs no install. */
export function webPlayerUrl(track) {
    if (!track) return null;
    if (track.url) return track.url;
    return track.id ? `https://open.spotify.com/track/${track.id}` : null;
}

/**
 * What Jarvis says, built from what actually happened.
 *
 * Three different sentences for three different outcomes, because they ARE
 * different: only one of them is playback. Saying "playing" when a browser tab
 * was opened is the claimed-success failure this project keeps fixing.
 */
export function describeHandoff(track, handoff) {
    if (!track) return 'I could not find that on Spotify, Sir.';
    const who = track.artists.length ? ` by ${track.artists.join(', ')}` : '';
    switch (handoff) {
        case HANDOFF.WEB_API:
            return `Playing ${track.name}${who}, Sir.`;
        case HANDOFF.DESKTOP:
            return `Opening ${track.name}${who} in Spotify, Sir.`;
        case HANDOFF.BROWSER:
            /* Explicit about the browser, because the user will hear no music
               until they press play there. A confirmation that implies audio
               is starting would be wrong. */
            return `I found ${track.name}${who}. Opening it in the Spotify web player, Sir.`;
        default:
            /* Found, but nothing here can play it. Says which piece is missing
               rather than "something went wrong", because the missing piece is
               the actionable part — and it does not claim playback. */
            return `I found ${track.name}${who}, but Spotify is not installed, `
                + 'so I have nothing to play it with, Sir.';
    }
}

export default {
    parseSpotifyCommand, buildSearchQuery, firstTrack, webPlayerUrl,
    describeHandoff, HANDOFF
};
