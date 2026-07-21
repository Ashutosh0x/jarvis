// Chrome advisory and NVD parsing.
//
// The fixture below is the REAL body of the 16 Jul 2026 Stable Channel Update,
// captured from the live feed. It is the exact advisory Jarvis got wrong: it
// claimed CVE-2026-15905 was Critical, the user corrected it to High, and the
// correction was right. These tests encode the real severities so that claim
// can never be produced again from this source.

import {
    parseAdvisoryCves, parseAdvisoryFeed, parseNvdCve,
    sortBySeverity, countBySeverity, describeAdvisory, describeCve, extractCveId,
    crossVerify, describeVerification,
} from '../security.js';

let pass = 0, fail = 0;
const check = (n, c, d = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

/* --- captured advisory body (entity-encoded, as Blogger serves it) --------- */
const BODY = `&lt;p&gt;The Stable channel has been updated. This update includes 7 security fixes.
Please see the Chrome Security Page for more information.
[N/A][ 516987782 ] Critical CVE-2026-15899: Use after free in CameraCapture. Reported by Google on 2026-05-27
[N/A][ 517100492 ] Critical CVE-2026-15900: Use after free in GPU. Reported by Google on 2026-05-28
[$7000][ 518007484 ] Critical CVE-2026-15901: Use after free in Network. Reported by Anonymous on 2026-06-01
[$3000][ 518117234 ] High CVE-2026-15902: Use after free in Cast. Reported by Anonymous on 2026-06-02
[N/A][ 519001122 ] High CVE-2026-15903: Out of bounds read and write in V8. Reported by Google on 2026-06-03
[N/A][ 519223344 ] High CVE-2026-15904: Use after free in Ozone. Reported by Google on 2026-06-04
[N/A][ 519554433 ] High CVE-2026-15905: Use after free in Aura. Reported by Google on 2026-06-05&lt;/p&gt;`;

const FEED = `<?xml version="1.0"?><rss><channel>
<item><title>Stable Channel Update for Desktop</title>
<link>https://chromereleases.googleblog.com/2026/07/stable-channel-update-for-desktop.html</link>
<pubDate>Thu, 16 Jul 2026 20:56:30 +0000</pubDate>
<description>${BODY}</description></item>
<item><title>Chrome for Android Update</title>
<link>https://chromereleases.googleblog.com/2026/07/chrome-for-android-update.html</link>
<pubDate>Thu, 16 Jul 2026 21:07:01 +0000</pubDate>
<description>&lt;p&gt;Hi, everyone! We've just released Chrome 150 for Android.&lt;/p&gt;</description></item>
</channel></rss>`;

/* --- the exact claim that was wrong ---------------------------------------- */
{
    const cves = parseAdvisoryCves(BODY);
    check('advisory: all 7 CVEs parsed', cves.length === 7, `${cves.length}`);

    const c15905 = cves.find(c => c.id === 'CVE-2026-15905');
    check('CVE-2026-15905 is High, NOT Critical — the claim the log got wrong',
        c15905?.severity === 'High', `${c15905?.severity}`);
    check('CVE-2026-15905 component is Aura', c15905?.component === 'Aura', `${c15905?.component}`);
    check('CVE-2026-15899 IS Critical', cves.find(c => c.id === 'CVE-2026-15899')?.severity === 'Critical');
    check('exactly 3 Critical and 4 High, as published',
        countBySeverity(cves).Critical === 3 && countBySeverity(cves).High === 4,
        JSON.stringify(countBySeverity(cves)));

    check('component extracted from the description', cves.find(c => c.id === 'CVE-2026-15903')?.component === 'V8');
    check('description kept whole', /Out of bounds read and write in V8/.test(cves.find(c => c.id === 'CVE-2026-15903')?.description || ''));
    check('bounty and bug-id prefixes are not mistaken for data',
        cves.every(c => !/\[|\]|\$/.test(c.id)));
    check('duplicate ids are collapsed', new Set(cves.map(c => c.id)).size === cves.length);
}

/* --- feed level ------------------------------------------------------------ */
{
    const posts = parseAdvisoryFeed(FEED);
    check('feed: both posts parsed', posts.length === 2);
    const sec = posts.find(p => p.securityUpdate);
    check('feed: the security post is flagged', sec?.cves.length === 7);
    check('feed: a non-security post is flagged as such',
        posts.find(p => /Android/.test(p.title))?.securityUpdate === false);
    check('feed: newest first', posts[0].publishedTs >= posts[1].publishedTs);
    check('feed: link kept for citation', /chromereleases\.googleblog\.com/.test(sec.url));
    check('feed: date parsed to ISO', /^2026-07-16/.test(sec.published), sec.published);
    check('feed: junk input is safe', parseAdvisoryFeed('').length === 0 && parseAdvisoryFeed(null).length === 0);
}

/* --- ordering and speech --------------------------------------------------- */
{
    const cves = parseAdvisoryCves(BODY);
    const ranked = sortBySeverity(cves);
    check('sort: Critical first', ranked[0].severity === 'Critical');
    check('sort: High after Critical', ranked[3].severity === 'High');
    check('sort: stable for equal severity', sortBySeverity(cves)[0].id === sortBySeverity([...cves].reverse())[0].id);

    /* The newest post is NOT the newest security post — here the Android
       release (21:07) is newer than the desktop advisory (20:56). Asking for
       "the latest vulnerabilities" and getting the newest post of any kind
       would answer a different question. */
    const posts = parseAdvisoryFeed(FEED);
    check('the newest post is not necessarily the security one', posts[0].securityUpdate === false);
    const said = describeAdvisory(posts.find(p => p.securityUpdate));
    check('spoken: states the count', /7 issues/.test(said), said.slice(0, 80));
    check('spoken: states the severity breakdown', /3 critical, 4 high/.test(said), said.slice(0, 120));
    check('spoken: names the most severe identifier', /CVE-2026-1589\d/.test(said));
    check('spoken: a release with no security fixes says so',
        /no security fixes/.test(describeAdvisory({ title: 'Chrome for Android Update', cves: [] })));
}

/* --- NVD ------------------------------------------------------------------- */
{
    const payload = {
        vulnerabilities: [{
            cve: {
                id: 'CVE-2024-0519', published: '2024-01-16T22:15:37.753', sourceIdentifier: 'chrome-cve-admin@google.com',
                descriptions: [{ lang: 'en', description: 'Out of bounds memory access in V8 in Google Chrome.' }],
                metrics: { cvssMetricV31: [{ cvssData: { baseScore: 8.8, baseSeverity: 'HIGH', vectorString: 'CVSS:3.1/AV:N/AC:L' } }] },
            },
        }],
    };
    const c = parseNvdCve(payload);
    check('nvd: score and severity read', c.baseScore === 8.8 && c.severity === 'HIGH');
    check('nvd: vector kept', /CVSS:3.1/.test(c.vector));
    check('nvd: source attributed', c.source === 'chrome-cve-admin@google.com');
    check('nvd: spoken includes the score', /8\.8/.test(describeCve(c)));

    // A very recent CVE often has no score yet; that is a real state.
    const pending = parseNvdCve({ vulnerabilities: [{ cve: { id: 'CVE-2026-15905', descriptions: [{ lang: 'en', description: 'Use after free in Aura.' }], metrics: {} } }] });
    check('nvd: a scoreless CVE is flagged awaiting analysis', pending.awaitingAnalysis === true);
    check('nvd: and is spoken as unscored rather than given a number',
        /no CVSS score assigned yet/.test(describeCve(pending)));
    check('nvd: an empty payload yields null, never a guess', parseNvdCve({}) === null && parseNvdCve(null) === null);
}

/* --- identifier extraction -------------------------------------------------- */
{
    check('extract: plain id', extractCveId('what is CVE-2026-15905') === 'CVE-2026-15905');
    check('extract: spoken with spaces', extractCveId('tell me about cve 2026 15905') === 'CVE-2026-15905');
    check('extract: lowercase', extractCveId('cve-2024-0519 details') === 'CVE-2024-0519');
    check('extract: nothing there yields null', extractCveId('what is the weather') === null);
}

/* --- multi-source verification ----------------------------------------------
   The survey's evidence-verification dimension, and GASP's framing that a
   hallucination is a failure of dependence on evidence. Two authorities are
   asked and DISAGREEMENT IS REPORTED rather than resolved silently. */
{
    const agree = crossVerify({ severity: 'High' }, { severity: 'HIGH', baseScore: 7.8 }, { vendorName: 'Google' });
    check('verify: two agreeing authorities give the strongest state',
        agree.status === 'confirmed' && agree.confidence === 1);
    check('verify: both sources are named', agree.sources.includes('Google') && agree.sources.includes('NVD'));
    check('verify: agreement is spoken with its sources',
        /confirmed by Google and NVD/.test(describeVerification(agree, 'CVE-2026-15905')));

    // The case the log produced: a claim of Critical against a real High.
    const clash = crossVerify({ severity: 'High' }, { severity: 'CRITICAL' }, { vendorName: 'Google' });
    check('verify: a disagreement is flagged, not resolved', clash.status === 'conflict');
    check('verify: no severity is asserted when sources disagree', clash.severity === null);
    const said = describeVerification(clash, 'CVE-2026-15905');
    check('verify: both positions are stated aloud', /Google rates it high/.test(said) && /NVD rates it critical/.test(said), said);
    check('verify: it refuses to choose', /not going to pick one/.test(said));

    // Vendor ahead of NVD — real and common, not an error state.
    const pending = crossVerify({ severity: 'High' }, { severity: null, awaitingAnalysis: true }, { vendorName: 'Google' });
    check('verify: a single source is reported as single-source', pending.status === 'single-source');
    check('verify: lower confidence than agreement', pending.confidence < 1 && pending.confidence > 0);
    check('verify: says the NVD has not scored it yet',
        /NVD has not finished scoring/.test(describeVerification(pending, 'CVE-2026-15905')));

    const nvdOnly = crossVerify(null, { severity: 'HIGH', baseScore: 7.8 });
    check('verify: NVD alone still answers', nvdOnly.status === 'single-source' && nvdOnly.severity === 'HIGH');

    // The state that must never become an invented severity.
    const nothing = crossVerify(null, null);
    check('verify: no source means no severity', nothing.status === 'unverified' && nothing.severity === null);
    check('verify: and is spoken as a refusal',
        /will not state a severity/.test(describeVerification(nothing, 'CVE-2026-99999')));
    check('verify: confidence is zero with no evidence', nothing.confidence === 0);
    check('verify: garbage input does not throw', crossVerify(undefined, undefined).status === 'unverified');
    check('verify: case differences are not treated as disagreement',
        crossVerify({ severity: 'high' }, { severity: 'HIGH' }).status === 'confirmed');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
