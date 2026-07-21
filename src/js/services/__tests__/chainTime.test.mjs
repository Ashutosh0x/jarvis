// Time formatting for alerts.
//
// This matters more than it looks. A live block head is seconds old; a block
// recovered after an outage can be twenty minutes old, and the stream replays
// it through the identical announce path. Without the block's own timestamp,
// both are announced the same way and stale news sounds current — which is the
// same class of error as an invented number, arrived at by omission.

import { timeAgo, clockTime } from '../chainIntel.js';

let pass = 0, fail = 0;
const check = (n, c, detail = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${detail ? ` — ${detail}` : ''}`); };

const NOW = Date.parse('2026-07-21T20:14:32+05:30');
const ago = (secs) => timeAgo(NOW - secs * 1000, NOW);

/* --- the live case: a head arriving now ----------------------------------- */
check('a block from this second reads as just now', ago(0) === 'just now');
check('12 seconds still reads as just now', ago(12) === 'just now', ago(12));

/* --- clock skew: a block timestamp can lead the local clock --------------- */
check('a block a second in the future is not a time traveller',
    timeAgo(NOW + 1500, NOW) === 'just now');

/* --- the backfill case: this is the one that must not say "just now" ------ */
check('30 seconds is reported in seconds', ago(30) === '30 seconds ago', ago(30));
check('2 minutes is reported in minutes', ago(120) === '2 minutes ago', ago(120));
check('a block recovered after a 20 minute outage says so',
    ago(20 * 60) === '20 minutes ago', ago(20 * 60));
check('an hour old', ago(3600) === '1 hour ago', ago(3600));
check('three hours old', ago(3 * 3600) === '3 hours ago', ago(3 * 3600));
check('yesterday', ago(26 * 3600) === '1 day ago', ago(26 * 3600));

/* --- singular vs plural, because it is spoken aloud ----------------------- */
check('one minute is singular', ago(60) === '1 minute ago', ago(60));
check('one hour is singular', ago(3600) === '1 hour ago');
check('two days is plural', ago(50 * 3600) === '2 days ago', ago(50 * 3600));

/* --- boundaries ------------------------------------------------------------ */
check('the seconds-to-minutes boundary does not produce "90 seconds"',
    ago(95) === '2 minutes ago', ago(95));
check('59 minutes stays in minutes', /minutes ago$/.test(ago(59 * 60)), ago(59 * 60));

/* --- missing or nonsense input -------------------------------------------- */
check('no timestamp yields null, never a guessed time',
    timeAgo(null) === null && timeAgo(undefined) === null && timeAgo(0) === null && timeAgo(NaN) === null);

/* --- wall clock for the screen -------------------------------------------- */
{
    const t = clockTime(NOW);
    check('clock time is zero-padded HH:MM:SS', /^\d{2}:\d{2}:\d{2}$/.test(t), t);
    const midnightish = clockTime(Date.parse('2026-07-21T00:05:09+05:30'));
    check('early hours keep their padding', midnightish === '00:05:09', midnightish);
    check('no timestamp yields no clock', clockTime(null) === null && clockTime(0) === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
