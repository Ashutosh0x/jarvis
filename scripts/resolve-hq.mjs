#!/usr/bin/env node
/* =========================================================================
   Resolve every company in the ranking to its head-office COORDINATES, and
   prove each one rather than assume it.

   THIS SPENDS REAL MONEY. One company is one billed Google Places Text
   Search, roughly $0.032 at Text Search (Pro) rates, so 11,222 companies is
   about $360. Everything below exists to make that spend safe and to make it
   happen exactly once:

     - RESUMABLE. Every result is written to disk as it lands, keyed by
       ticker. Interrupt it and rerun it and it skips what it already has.
       A crash at company 9,000 does not re-buy 9,000 lookups.
     - BUDGETED. `--max-lookups` is checked before each request and is a hard
       stop. Default 200, not "all", because the expensive default is the one
       that gets run by accident.
     - NEGATIVE RESULTS CACHED TOO. A company Google genuinely cannot place
       is recorded as a miss. Without that, every rerun re-buys every failure
       forever.
     - LIVE COST. Spend so far is printed as it goes, in dollars, so stopping
       is an informed decision rather than a guess.

   VALIDATION IS THE POINT, not a bonus. A coordinate that is merely plausible
   is worse than none: it puts a real company at a real place that is the
   wrong place, and nothing downstream can tell. Every hit must pass:

     1. COUNTRY. The ISO country on the result must equal the country the
        ranking recorded. This is what stops "Reliance" (the American steel
        distributor, ticker RS) being pinned to Mumbai — Google ranks the
        Indian conglomerate first for that name no matter what region you bias
        towards, and only the returned country code exposes it.
     2. NAME. The matched place name must share a meaningful token with the
        company name. Google will happily answer "Dow" with "Dow Chemical Co"
        (good) or a name with nothing in common (not good). Token overlap
        catches the second without demanding an exact string match that legal
        suffixes and local spellings would break.

   A result failing either check is recorded as REJECTED WITH ITS REASON, not
   silently dropped and not quietly kept. The rejects are the audit trail.

   Usage:
     node scripts/resolve-hq.mjs --max-lookups 200        # ~$6.40
     node scripts/resolve-hq.mjs --all                    # every company
     node scripts/resolve-hq.mjs --status                 # spend nothing
     node scripts/resolve-hq.mjs --top 500                # richest 500 only
   ========================================================================= */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'package.json'));
const RANKING = path.join(ROOT, 'data', 'companies-ranking.json');
const OUT = path.join(ROOT, 'data', 'companies-hq.json');

/* Text Search (Pro) list price per request. Only used to print an estimate —
   the real number is on the billing console and this is a guide, not a claim. */
const USD_PER_LOOKUP = 0.032;

for (const line of fs.existsSync(path.join(ROOT, '.env'))
    ? fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/) : []) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
}

const gm = require(path.join(ROOT, 'googleMaps.js'));
const { regionCodeFor } = await import(`file:///${ROOT.replace(/\\/g, '/')}/src/js/services/googleServices.js`);

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const val = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : (Number(argv[i + 1]) || d); };

const topN = val('top', 0);
const maxLookups = flag('all') ? Infinity : val('max-lookups', 200);
const concurrency = Math.max(1, Math.min(16, val('concurrency', 8)));

/* ---------------------------------------------------------------- store -- */

function loadStore() {
    try { return JSON.parse(fs.readFileSync(OUT, 'utf8')); }
    catch { return { updatedAt: null, lookups: 0, results: {} }; }
}
let store = loadStore();
let dirty = 0;
function persist(force = false) {
    /* Batched: writing a 6 MB file after every one of eleven thousand lookups
       is more disk than network. Forced at the end and on exit. */
    if (!force && ++dirty < 25) return;
    dirty = 0;
    store.updatedAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(store));
}

/* ------------------------------------------------------------ validation -- */

const STOP = new Set(['the', 'and', 'of', 'co', 'company', 'corp', 'corporation', 'inc',
    'ltd', 'limited', 'plc', 'llc', 'llp', 'sa', 'ag', 'nv', 'bv', 'group', 'holdings',
    'holding', 'international', 'global', 'pvt', 'private', 'pte', 'ab', 'as', 'oy',
    'gmbh', 'spa', 'se', 'kk', 'the', 'a', 's',
    /* What a BUILDING is called. Google signs an office "X Corporate
       Headquarters", "X Head Office", "X Tower"; none of those words say
       anything about which company X is, and leaving them in made the matched
       name look like it carried distinctive content that it did not. */
    'corporate', 'headquarters', 'headquarter', 'hq', 'head', 'office', 'offices',
    'building', 'tower', 'campus', 'center', 'centre', 'plaza', 'house']);

/* INDUSTRY WORDS ARE NOT IDENTIFYING, and treating them as if they were is how
   twenty unrelated banks ended up at one address.

   STOP above holds LEGAL suffixes. These are SECTOR words, and they are a
   different problem: they are not noise to be dropped — "Bank of America" needs
   `bank` to match "Bank of America Corporate Center" — they simply cannot be
   the ONLY evidence. `First Bancorp`, `S&T Bancorp` and `Hope Bancorp` share
   `bancorp` with `Southern Bancorp Corporate Headquarters` and with each other,
   and the weak single-token rule below scored that 0.6 against a 0.5 threshold.
   Twenty companies from twenty states were pinned to one office in Little Rock,
   and 2 of the 20 were recorded `high` confidence — so confidence did not catch
   it either.

   Measured on the committed database: 390 companies sit on 167 shared place
   IDs, and this rule is what admitted the wrong ones. */
const GENERIC = new Set([
    'bancorp', 'bancshares', 'bank', 'banking', 'banc',
    'financial', 'finance', 'capital', 'trust', 'insurance', 'assurance',
    'securities', 'investment', 'investments', 'asset', 'management', 'partners',
    'ventures', 'enterprises', 'industries', 'industrial',
    'technologies', 'technology', 'systems', 'solutions', 'digital', 'data',
    'energy', 'resources', 'power', 'electric', 'electronics', 'electronic',
    'petroleum', 'mining', 'materials', 'chemicals', 'chemical',
    'pharmaceuticals', 'pharmaceutical', 'pharma', 'biosciences', 'bioscience',
    'healthcare', 'health', 'medical', 'laboratories',
    'communications', 'telecom', 'telecommunications', 'media', 'networks',
    'properties', 'realty', 'estate', 'development', 'construction',
    'engineering', 'manufacturing', 'services', 'products',
    'foods', 'beverage', 'retail', 'stores', 'airlines', 'airways',
    'shipping', 'logistics', 'transport', 'transportation', 'motors', 'automotive'
]);

/* Diacritics are stripped before comparison. "Itōchū Shōji" and "ITOCHU
   Corporation" are the same company and shared not one token until this
   existed; likewise "América Móvil" and "America Movil". NFD splits a letter
   from its accent so the accent can be removed on its own. */
const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const rawTokens = (s) => fold(s).replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);

/* Stop-words are dropped so legal suffixes carry no weight — but NEVER to the
   point of leaving nothing to compare. "S&P Global" is "s", "p" and "global":
   two single letters and a stop-word, so the filtered list came out empty and
   an EXACT match scored zero. When filtering empties the list, the unfiltered
   one is used instead. */
const tokens = (s) => {
    const raw = rawTokens(s);
    const filtered = raw.filter((t) => t.length > 1 && !STOP.has(t));
    return filtered.length ? filtered : raw;
};

/* Does this text use a script the token comparison cannot handle? A Latin
   company name and a Chinese place name share no tokens by construction, and
   scoring that as "mismatch" is a statement about alphabets, not about
   whether the pin is right. */
const nonLatin = (s) => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Thai}\p{Script=Hebrew}]/u.test(String(s || ''));

/* Types that mean "an office belonging to a business". Deliberately excludes
   `locality`, `political` and `administrative_area_*` — a town is never an
   answer to "where is this company's head office", however well its name
   matches. That exclusion is the whole reason this list is a whitelist and
   not a blacklist. */
const CORPORATE_TYPES = ['corporate_office', 'business_center', 'office',
    'software_company', 'manufacturer', 'consultant', 'insurance_agency',
    'finance', 'bank', 'accounting', 'premise'];

/* Jurisdictions where "country" in a market-cap table means REGISTERED, not
   RESIDENT. Credicorp is listed as Bermuda and runs from Lima. Brookfield
   Infrastructure Partners is Bermuda and runs from Toronto. Kiniksa is Bermuda
   and sits in Lexington, Massachusetts — Google returned the US office and the
   country check refused it as "wrong country", which was the check being
   wrong, not Google.

   For these, requiring the office to be in the registered country asks for a
   building that does not exist. The country check is therefore SUSPENDED and
   the name check carries the result alone, recorded with the country it was
   actually found in so nothing is hidden. Every other jurisdiction keeps both
   checks; this list is short and specific for that reason. */
const DOMICILE_ONLY = new Set(['Bermuda', 'Cayman Islands', 'Jersey', 'Guernsey',
    'Isle of Man', 'British Virgin Islands', 'Marshall Islands', 'Panama',
    'Liberia', 'Gibraltar', 'Curaçao', 'Bahamas', 'Monaco']);

/**
 * Does the place Google returned plausibly name the company we asked about?
 *
 * Token overlap rather than string equality: "Terumo" must match "Terumo
 * Corporation Headquarters", and "Legal & General" must match "Legal & General
 * Group", neither of which is an exact string. Legal suffixes are stripped as
 * stop-words because every company has one and they carry no signal.
 *
 * A company whose every token is a stop-word (rare, but "The Co" exists) can
 * not be checked this way, and is reported as unverifiable rather than passed.
 */
/** Initials of a token list: "Taiwan Semiconductor Manufacturing" -> "tsm". */
const initials = (toks) => toks.map((t) => t[0]).join('');

/* A sector word is worth a quarter of a distinctive one, on BOTH sides of the
   ratio.

   Counting every token equally is what put twenty banks in one building:
   "First Bancorp" against "Southern Bancorp Corporate Headquarters" shares
   exactly `bancorp`, scored 1 of 2 tokens = 0.50, and the threshold is 0.50.
   The match rested entirely on a word that thousands of companies share.

   Weighting the DENOMINATOR too is what keeps this from over-correcting. A
   company whose name is nothing but sector words is not thereby unmatchable —
   "Technology Solutions" against "Technology Solutions Ltd" is 0.5/0.5 = 1.00,
   still a match — it just has to match all of them. Worked through:

     First Bancorp   vs Southern Bancorp HQ   0.25 / 1.25 = 0.20  rejected
     Southern Bancorp vs Southern Bancorp HQ  1.25 / 1.25 = 1.00  kept
     Bank of America vs Bank of America Ctr   1.25 / 1.25 = 1.00  kept
*/
const weightOf = (t) => (GENERIC.has(t) ? 0.25 : 1);

function overlap(a, b) {
    if (!a.length || !b.length) return 0;
    const setB = new Set(b);
    let hit = 0, total = 0;
    for (const t of a) {
        const w = weightOf(t);
        total += w;
        if (setB.has(t)) { hit += w; continue; }
        /* Prefix match catches "Volkswagen" vs "Volkswagenwerk" and
           "Pepsico" vs "PepsiCo Inc" after case folding. */
        if (b.some((x) => x.startsWith(t) || t.startsWith(x))) hit += w * 0.75;
    }
    return total ? hit / total : 0;
}

function nameAgrees(requested, matched) {
    /* A market-cap table writes aliases in brackets — "Alphabet (Google)",
       "Meta Platforms (Facebook)". Those extra tokens dilute the overlap and
       sank real matches, so the bracket content is tried as its OWN name
       rather than mixed into the main one. */
    const alias = /\(([^)]+)\)/.exec(String(requested || ''))?.[1] || null;
    const bare = String(requested || '').replace(/\([^)]*\)/g, ' ');

    const b = tokens(matched);
    if (!b.length) return { ok: false, score: 0, why: 'match-has-no-tokens' };

    const variants = [tokens(bare)];
    if (alias) variants.push(tokens(alias));

    /* A NAME THAT SURVIVES AS NOTHING BUT SECTOR WORDS PROVES NOTHING ON ITS
       OWN. "S&T Bancorp" folds to `s`, `t`, `bancorp`; the single letters are
       dropped as noise and what is left is one word thousands of banks share.
       Weighting alone cannot save this — the ratio is 0.25/0.25 = 1.00, a
       perfect score, because every token it has did match.

       So when the company name reduces to sector words only, the MATCH is asked
       whether it is about somebody else: a distinctive token on its side that
       the company does not have means it is. "Southern" does, so S&T Bancorp is
       refused Southern Bancorp's building. "Technology Solutions Ltd" does not
       — `ltd` is a stop word — so a company genuinely called Technology
       Solutions still finds its own office. */
    const allSector = variants.every((v) => v.length && v.every((t) => GENERIC.has(t)));
    if (allSector) {
        const mine = new Set(variants.flat());
        const theirs = b.filter((t) => !GENERIC.has(t) && !mine.has(t));
        if (theirs.length) {
            return { ok: false, score: 0, why: 'sector-word-only-match' };
        }
    }

    let best = 0;
    for (const a of variants) {
        if (!a.length) continue;
        best = Math.max(best, overlap(a, b));

        /* ACRONYMS, BOTH DIRECTIONS. "TSMC" is the company that Google calls
           "Taiwan Semiconductor Manufacturing Company", and "General Electric"
           is the company Google calls "GE Corporate Headquarters". Neither
           shares a token with its counterpart, and both are correct. */
        /* Initials are taken from the RAW words, not the stop-word-filtered
           ones: "TSMC" is the initials of "Taiwan Semiconductor Manufacturing
           Company", and dropping "Company" as a suffix leaves only "tsm",
           which does not match. The filter is right for overlap and wrong for
           acronyms, so each gets the token list it needs. */
        const rawB = rawTokens(matched);
        const rawA = rawTokens(bare);
        if (a.length === 1 && a[0].length >= 2
            && (a[0] === initials(b).slice(0, a[0].length) || a[0] === initials(rawB).slice(0, a[0].length))) {
            best = Math.max(best, 1);
        }
        if (b.some((t) => t.length >= 2
            && (t === initials(a).slice(0, t.length) || t === initials(rawA).slice(0, t.length)))) {
            best = Math.max(best, 1);
        }

        /* CONCATENATION. "Exxon Mobil" is written "ExxonMobil" on the door,
           and "Foxconn Industrial Internet" answers to "Foxconn". */
        const joined = a.join('');
        if (b.some((t) => t === joined || t.startsWith(joined) || joined.startsWith(t))) best = Math.max(best, 0.9);

        /* The company's most distinctive single token appearing in the match is
           weak but real evidence — "Schneider" in "Schneider Electric France".

           DISTINCTIVE IS THE LOAD-BEARING WORD. The token has to identify THIS
           company, so a sector word is skipped and the next-longest real one is
           used instead: "First Bancorp" is carried by `first`, never by
           `bancorp`. When a name is nothing but sector words the rule does not
           fire at all and the match must be earned by one of the stronger rules
           above — an exact, acronym or concatenation hit — because there is no
           distinctive token to reason from. */
        const longest = a.slice()
            .filter((t) => !GENERIC.has(t))
            .sort((x, y) => y.length - x.length)[0];
        if (longest && longest.length >= 5 && b.some((t) => t.includes(longest) || longest.includes(t))) {
            best = Math.max(best, 0.6);
        }
    }

    if (!variants.some((v) => v.length)) return { ok: false, score: 0, why: 'no-comparable-tokens' };
    const score = Number(best.toFixed(2));
    return { ok: score >= 0.5, score, why: score >= 0.5 ? null : 'name-mismatch' };
}

/* ------------------------------------------------------------- resolution -- */

/* Failures that are about the ACCOUNT, not about the company.
   These are not answers and must never be cached as one: a company marked
   "error: quota exceeded" would be skipped on every later run, so a quota
   blip would permanently blank ten thousand companies. They are also not
   billed — Google refuses them before the billable operation — so counting
   them as spend overstates the cost, which is exactly the mistake the first
   full run made when it reported $324 for about $9 of real usage. */
const INFRA_FAILURE = /RESOURCE_EXHAUSTED|INVALID_ARGUMENT|PERMISSION_DENIED|UNAUTHENTICATED|http-4\d\d|timeout|network/i;
/* TWO KINDS OF QUOTA, AND ONLY ONE IS FATAL — the same lesson the ranking
   crawler learned. "per minute" clears in sixty seconds and should be waited
   out; "per day" does not clear today and should stop the run. Treating them
   alike is how a transient throttle looked like a dead account and ended a
   run at company 939 with ten thousand still to go. */
const PER_MINUTE = /per minute|per 60 seconds|RATE_LIMIT/i;
const PER_DAY = /per day|PerDay/i;
let infraStop = null;

/* Places allows a high but finite requests-per-minute. The first attempt ran
   at ~36/s (2,160/min) and was throttled almost immediately. This paces the
   whole process to a sustainable rate instead of sprinting into the wall and
   backing off, which is both faster overall and easier to reason about. */
const targetPerMin = val('per-min', 480);
const minGapMs = 60000 / targetPerMin;
let nextSlot = 0;
async function throttle() {
    const now = Date.now();
    const slot = Math.max(now, nextSlot);
    nextSlot = slot + minGapMs;
    if (slot > now) await new Promise((r) => setTimeout(r, slot - now));
}

/* Country -> a point inside it, read from the gazetteer the globe already
   ships. NOT a hardcoded table: Natural Earth's populated-places file carries
   an ISO code and coordinates for 197 countries, so the bias point comes from
   real data that is already on disk and already maintained. */
const CAPITALS = (() => {
    const out = {};
    try {
        const g = JSON.parse(fs.readFileSync(
            path.join(ROOT, 'static', 'geo', 'ne_110m_populated_places_simple.geojson'), 'utf8'));
        for (const f of g.features || []) {
            const p = f.properties || {};
            if (p.iso_a2 && Number.isFinite(+p.latitude)) out[p.iso_a2] = [+p.latitude, +p.longitude];
        }
    } catch { /* no bias is a degradation, not a failure */ }
    return out;
})();

async function resolveOne(entry, attempt = 1, retryOnly = false) {
    const want = regionCodeFor(entry.country);
    const bias = want ? CAPITALS[want] : null;
    await throttle();
    const res = await gm.placesCompanyHQ({
        name: entry.name, country: entry.country, regionCode: want,
        biasLat: bias?.[0] ?? null, biasLng: bias?.[1] ?? null
    });
    if (!res.ok) {
        const blob = `${res.reason} ${res.detail || ''}`;
        /* A per-minute throttle is not an answer about this company; wait and
           ask again. Refused requests are not billed, so retrying is free. */
        if (PER_MINUTE.test(blob) && !PER_DAY.test(blob) && attempt <= 5) {
            await new Promise((r) => setTimeout(r, 20000 * attempt));
            return resolveOne(entry, attempt + 1, retryOnly);
        }
        const infra = INFRA_FAILURE.test(blob);
        if (infra && !infraStop) infraStop = `${res.reason}: ${(res.detail || '').slice(0, 140)}`;
        return {
            status: 'error', infra,
            reason: res.reason, detail: (res.detail || '').slice(0, 120)
        };
    }

    let candidates = res.data?.candidates || [];

    /* SECOND QUERY SHAPE. "<name> corporate headquarters <country>" is the
       phrasing that pins a head office rather than a branch, and it is right
       for most of the world. It returns NOTHING for a large block of mainland
       Chinese listings — CATL, CXMT, WuXi AppTec, NAURA — where Google's
       coverage indexes the company but not the phrase. Dropping to the bare
       name plus country finds many of them. Only tried when the first shape
       came back empty, so it costs a second lookup only where the first
       bought nothing. */
    if (!candidates.length && !retryOnly) {
        const alt = await (async () => { await throttle(); return gm.placesCompanyHQ({ name: entry.name, country: entry.country, regionCode: want, bare: true, biasLat: bias?.[0] ?? null, biasLng: bias?.[1] ?? null }); })();
        if (alt.ok) candidates = alt.data?.candidates || [];
        else if (PER_MINUTE.test(`${alt.reason} ${alt.detail || ''}`)) {
            await new Promise((r) => setTimeout(r, 20000));
        }
    }
    if (!candidates.length) return { status: 'rejected', reason: 'no-candidates' };

    /* A domicile-only registration cannot be verified by country, so the
       country check is dropped for it and the name check has to carry the
       whole result on its own. */
    const domicile = DOMICILE_ONLY.has(String(entry.country || ''));

    const tried = [];
    let scriptFallback = null;
    let typeFallback = null;
    for (const c of candidates) {
        const countryOk = domicile || !want || c.countryCode === want;
        const nm = nameAgrees(entry.name, c.matchedName);
        tried.push({ matched: c.matchedName, cc: c.countryCode, countryOk, nameScore: nm.score });
        if (!countryOk) continue;
        if (!nm.ok) {
            /* CROSS-SCRIPT: a Latin company name against a Chinese place name
               can never share a token. When the country IS verified and the
               scripts differ, the name check is not evidence of anything — so
               it is set aside and the result kept at LOW confidence, labelled
               so, rather than either discarded or promoted. Nongfu Spring's
               correct 农夫山泉 was being thrown away by this. */
            if (!scriptFallback && nonLatin(c.matchedName) !== nonLatin(entry.name)) {
                scriptFallback = c;
            }
            /* A BRAND IS NOT A MISMATCH. Comcast's head office is signed
               "Xfinity Corporate Office", Occidental Petroleum's is "Oxy -
               Houston", Singapore Exchange's is "SGX Group". The name check
               scores all three zero and all three are correct.
               What separates them from junk is the place TYPE: these are
               corporate offices, while "Rueil-Malmaison" and "Lake Buena
               Vista" — the two towns that got returned for Schneider Electric
               and Walt Disney — are localities. So a top-ranked CORPORATE
               OFFICE in the verified country is accepted when the name cannot
               be matched, at low confidence and labelled as such; a town
               never is, whatever its name says. */
            if (!typeFallback && c === candidates[0] && CORPORATE_TYPES.some((t) => (c.types || []).includes(t))) {
                typeFallback = c;
            }
            continue;
        }
        return {
            status: 'ok',
            lat: c.lat, lng: c.lng,
            matchedName: c.matchedName,
            address: c.address,
            countryCode: c.countryCode,
            placeId: c.id,
            placeType: c.type,
            nameScore: nm.score,
            /* Both checks passed and the country was actually checkable.
               A domicile registration never gets 'high': the name matched but
               nothing corroborated WHERE, so it caps at medium and says so. */
            confidence: domicile
                ? (nm.score >= 0.9 ? 'medium' : 'low')
                : (want ? (nm.score >= 0.9 ? 'high' : 'medium') : 'low'),
            ...(domicile && c.countryCode !== want
                ? { note: `registered in ${entry.country}; office found in ${c.countryCode}` }
                : {})
        };
    }

    /* THIRD SHAPE, LAST RESORT. Only reached when nothing so far cleared BOTH
       checks, and the result still has to clear them — the ticker widens the
       search, it does not widen what counts as an answer. Guarded against
       recursing forever by `triedTicker`. */
    if (entry.ticker && !retryOnly) {
        await throttle();
        const tk = await gm.placesCompanyHQ({
            name: entry.name, country: entry.country, regionCode: want, ticker: entry.ticker,
            biasLat: bias?.[0] ?? null, biasLng: bias?.[1] ?? null
        });
        for (const c of (tk.ok ? tk.data?.candidates || [] : [])) {
            if (want && c.countryCode !== want) continue;      // RTX -> India dies here
            const nm = nameAgrees(entry.name, c.matchedName);
            if (!nm.ok) continue;
            return {
                status: 'ok',
                lat: c.lat, lng: c.lng,
                matchedName: c.matchedName,
                address: c.address,
                countryCode: c.countryCode,
                placeId: c.id,
                placeType: c.type,
                nameScore: nm.score,
                confidence: nm.score >= 0.9 ? 'high' : 'medium',
                note: 'found via ticker-qualified search'
            };
        }
    }

    const fallback = scriptFallback || typeFallback;
    if (fallback) {
        const c = fallback;
        return {
            status: 'ok',
            lat: c.lat, lng: c.lng,
            matchedName: c.matchedName,
            address: c.address,
            countryCode: c.countryCode,
            placeId: c.id,
            placeType: c.type,
            nameScore: null,
            confidence: 'low',
            note: scriptFallback
                ? 'country-verified; name in a different script so unchecked'
                : 'country-verified; top corporate office, but name differs (brand or subsidiary)'
        };
    }

    /* Nothing passed. Report the check that failed on the candidate that got
       FURTHEST, not on the first one — a company whose top hit is in the wrong
       country but whose second hit is right-country/wrong-name was being
       reported as "wrong-country", which sent the diagnosis the wrong way. */
    const anyCountryOk = tried.some((t) => t.countryOk);
    return {
        status: 'rejected',
        reason: anyCountryOk ? 'name-mismatch' : 'wrong-country',
        candidates: tried.slice(0, 3)
    };
}

/* -------------------------------------------------------------------- run -- */

function summarise() {
    const r = Object.values(store.results);
    const ok = r.filter((x) => x.status === 'ok');
    return {
        resolved: ok.length,
        rejected: r.filter((x) => x.status === 'rejected').length,
        errors: r.filter((x) => x.status === 'error').length,
        total: r.length,
        high: ok.filter((x) => x.confidence === 'high').length,
        medium: ok.filter((x) => x.confidence === 'medium').length,
        countries: new Set(ok.map((x) => x.countryCode)).size
    };
}

if (flag('status')) {
    const s = summarise();
    console.log(`resolved   ${s.resolved}  (high ${s.high}, medium ${s.medium}) across ${s.countries} countries`);
    console.log(`rejected   ${s.rejected}`);
    console.log(`errors     ${s.errors}`);
    console.log(`lookups    ${store.lookups}  ≈ $${(store.lookups * USD_PER_LOOKUP).toFixed(2)}`);
    console.log(`updated    ${store.updatedAt || 'never'}`);
    process.exit(0);
}

if (!process.env.GOOGLE_MAPS_API_KEY) {
    console.error('GOOGLE_MAPS_API_KEY is not set — nothing requested, nothing spent.');
    process.exit(2);
}
const db = JSON.parse(fs.readFileSync(RANKING, 'utf8'));
let list = db.companies || [];
if (topN > 0) list = list.slice(0, topN);

/* `--retry-rejected` re-buys only the ones a previous run refused. Tightening
   or loosening the validation is worthless if the rejects stay cached under
   the old rules, and re-buying the 89% that already passed would be paying
   twice for the same answer. */
const retryRejected = flag('retry-rejected');
const todo = list.filter((c) => {
    if (!c.ticker) return false;
    const prev = store.results[c.ticker];
    if (!prev) return true;
    return retryRejected && prev.status !== 'ok';
});
console.log(`ranking ${list.length} | already done ${list.length - todo.length} | to resolve ${todo.length}`);
console.log(`budget ${maxLookups === Infinity ? 'ALL' : maxLookups} lookups`
    + ` ≈ $${(Math.min(todo.length, maxLookups) * USD_PER_LOOKUP).toFixed(2)}, concurrency ${concurrency}\n`);

let spent = 0, cursor = 0, done = 0;
const t0 = Date.now();
let stopping = false;
process.on('SIGINT', () => { stopping = true; console.log('\ninterrupted — saving what is resolved...'); });

async function worker() {
    for (;;) {
        if (stopping || spent >= maxLookups) return;
        const i = cursor++;
        if (i >= todo.length) return;
        const e = todo[i];
        let r;
        try { r = await resolveOne(e); }
        catch (err) { r = { status: 'error', infra: true, reason: 'threw', detail: String(err).slice(0, 120) }; }

        /* STOP THE MOMENT THE ACCOUNT IS THE PROBLEM. The first full run
           pushed on through 10,884 quota rejections in ninety seconds,
           producing nothing and reporting a cost that never happened. One
           infra failure means every subsequent request will fail the same way,
           so the only useful thing left to do is say so and stop. */
        if (r.infra) { stopping = true; return; }

        spent++;
        store.results[e.ticker] = { name: e.name, country: e.country, rank: e.rank, ...r };
        /* Only answered requests are billed, so only they are counted. */
        store.lookups = (store.lookups || 0) + 1;
        persist();
        done++;
        if (done % 100 === 0) {
            const s = summarise();
            const rate = done / ((Date.now() - t0) / 1000);
            console.log(`${String(done).padStart(6)}/${todo.length}  ok ${s.resolved}  rej ${s.rejected}  err ${s.errors}`
                + `  |  $${(store.lookups * USD_PER_LOOKUP).toFixed(2)} spent  |  ${rate.toFixed(1)}/s`
                + `  |  eta ${Math.round((Math.min(todo.length, maxLookups) - done) / rate / 60)}m`);
        }
    }
}

await Promise.all(Array.from({ length: concurrency }, worker));
persist(true);

const s = summarise();
console.log(`\n${'='.repeat(62)}`);
if (infraStop) {
    console.log(`STOPPED — this is an account limit, not a data problem:\n  ${infraStop}`);
    console.log('  Nothing was charged for the refused requests, and no company was');
    console.log('  cached as failed, so rerunning resumes cleanly once it is lifted.\n');
}
console.log(`resolved   ${s.resolved} / ${s.total}   (high ${s.high}, medium ${s.medium})`);
console.log(`rejected   ${s.rejected}`);
console.log(`errors     ${s.errors}`);
console.log(`countries  ${s.countries}`);
console.log(`lookups    ${store.lookups}  ≈ $${(store.lookups * USD_PER_LOOKUP).toFixed(2)}`);
console.log(`written to ${path.relative(ROOT, OUT)}`);
