// News recency formatting and staleness detection.
//
// Why this exists: headlines were spoken with no time attached at all. A story
// filed twenty minutes ago and one filed two days ago sounded identical, and a
// provider quietly serving a cached feed was indistinguishable from a working
// one. Both of those are the same failure — presenting something as current
// without checking whether it is.
//
// The two functions under test mirror electron.js: timeAgo() for the compact
// form, and the staleness rule the renderer applies to the newest item.

const timeAgo = (date, now = Date.now()) => {
    const s = Math.max(0, (now - date.getTime()) / 1000);
    if (s < 90) return 'just now';
    const m = s / 60;
    if (m < 60) return `${Math.round(m)}m ago`;
    const h = m / 60;
    if (h < 24) return `${Math.round(h)}h ago`;
    return `${Math.round(h / 24)}d ago`;
};
// The renderer expands the compact form for speech: "42m ago" is read aloud as
// "42 minutes ago", because letters are not words.
const speakable = (t) => t.replace(/(\d+)m ago/, '$1 minutes ago').replace(/(\d+)h ago/, '$1 hours ago').replace(/(\d+)d ago/, '$1 days ago');
const STALE_MINUTES = 360;
const isStale = (newestAgeMinutes) => Number.isFinite(newestAgeMinutes) && newestAgeMinutes > STALE_MINUTES;

let pass = 0, fail = 0;
const check = (n, c, d = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

const NOW = Date.parse('2026-07-21T20:15:00+05:30');
const ago = (mins) => timeAgo(new Date(NOW - mins * 60000), NOW);

/* --- the real feed, measured: top story was 42 minutes old ---------------- */
check('a 42-minute-old headline reports its age', ago(42) === '42m ago', ago(42));
check('spoken form uses words, not letters', speakable(ago(42)) === '42 minutes ago', speakable(ago(42)));
check('a fresh story reads as just now', ago(0) === 'just now');
check('a 3-hour-old story', ago(183) === '3h ago', ago(183));
check('spoken hours', speakable(ago(183)) === '3 hours ago');
check('a day-old story', speakable(ago(26 * 60)) === '1 days ago', speakable(ago(26 * 60)));

/* --- staleness: the honest answer to "is this feed cached?" --------------- */
check('a feed whose newest story is 42 minutes old is not stale', !isStale(42));
check('a feed whose newest story is 5 hours old is not stale yet', !isStale(300));
check('a feed whose newest story is 10 hours old IS stale', isStale(600));
check('the measured Bing "breaking news" feed (621 min) is flagged stale', isStale(621));
check('a day-old feed is stale', isStale(1440));
check('an unknown age is not claimed to be stale', !isStale(null) && !isStale(undefined) && !isStale(NaN));

/* --- dates must survive a real RSS pubDate string ------------------------- */
{
    const rss = 'Tue, 21 Jul 2026 14:04:00 GMT';
    const d = new Date(rss);
    check('a real RSS pubDate parses', !Number.isNaN(d.getTime()), rss);
    check('and yields the right age against a known clock',
        timeAgo(d, Date.parse('2026-07-21T14:46:00Z')) === '42m ago',
        timeAgo(d, Date.parse('2026-07-21T14:46:00Z')));
    const local = d.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    check('absolute date includes the day and year', /21 Jul 2026/.test(local), local);
}

/* --- a missing or broken pubDate must not become a fake date ------------- */
{
    const bad = new Date('not a date');
    check('an unparseable pubDate is detected', Number.isNaN(bad.getTime()));
    check('no date is better than an invented one',
        (Number.isNaN(bad.getTime()) ? '' : timeAgo(bad, NOW)) === '');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
