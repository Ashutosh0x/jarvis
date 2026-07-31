// Tests for spoken alarm and timer parsing.
//
// An alarm the user cannot rely on is worse than no alarm, so the properties
// that matter here are: the resolved instant is correct, an ambiguous phrase
// is REFUSED rather than guessed, and a time already past rolls forward
// instead of firing immediately or never.
//
// The clock is pinned so these do not depend on when they run.
import {
    parseAlarmCommand, parseDuration, parseClockTime,
    parseAlarmCancel, parseAlarmList, formatDuration, formatClock,
} from '../alarmParser.js';

let pass = 0, fail = 0;
const check = (n, c) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); };

const NOW = new Date('2026-07-31T09:00:00');
const MIN = 60000, HOUR = 3600000;
const at = (cmd) => parseAlarmCommand(cmd, NOW)?.at;
const hhmm = (d) => d && `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

// --- durations --------------------------------------------------------------
check('duration: 40 minutes', parseDuration('for 40 minutes') === 40 * MIN);
check('duration: 30 seconds', parseDuration('for 30 seconds') === 30000);
check('duration: 2 hours', parseDuration('for 2 hours') === 2 * HOUR);
check('duration: word numbers', parseDuration('for twenty minutes') === 20 * MIN);
check('duration: "fourty" misspelling', parseDuration('for fourty minutes') === 40 * MIN);

// Compounds must SUM, not take the first unit and discard the rest.
check('duration: compound sums', parseDuration('1 hour 30 minutes') === 90 * MIN);
check('duration: half an hour', parseDuration('half an hour') === 30 * MIN);
check('duration: quarter of an hour', parseDuration('quarter of an hour') === 15 * MIN);

// Both spoken orderings mean the same thing. Only one was handled, so "an hour
// and a half" silently returned 60 minutes.
check('duration: "two and a half hours"', parseDuration('two and a half hours') === 150 * MIN);
check('duration: "an hour and a half"', parseDuration('an hour and a half') === 90 * MIN);

check('duration: refuses nonsense', parseDuration('for a while') === null);
check('duration: refuses empty', parseDuration('') === null);
check('duration: refuses beyond a week', parseDuration('for 30 days') === null);

// --- clock times ------------------------------------------------------------
check('clock: 2:30 pm', hhmm(parseClockTime('at 2:30 pm', NOW)) === '14:30');
check('clock: 24-hour', hhmm(parseClockTime('at 18:00', NOW)) === '18:00');
check('clock: am', hhmm(parseClockTime('at 7:15 am', NOW)) === '07:15');
check('clock: midnight is 00:00', hhmm(parseClockTime('at 12:00 am', NOW)) === '00:00');
check('clock: noon is 12:00', hhmm(parseClockTime('at 12:00 pm', NOW)) === '12:00');

// A time already past today must roll forward. Scheduling in the past either
// fires instantly or never, and both are wrong.
const past = parseClockTime('at 7:00 am', NOW);   // 09:00 now, so 7am has gone
check('clock: past time rolls to tomorrow', past > NOW);
// Compared as a date, not by adding 1 to the day-of-month: NOW is 31 July, so
// `getDate() + 1` is 32 while the actual next day is the 1st. The arithmetic
// version of this check failed for that reason, which is the same month-end
// bug it would have hidden in the code.
const tomorrow = new Date(NOW); tomorrow.setDate(tomorrow.getDate() + 1);
check('clock: tomorrow honoured',
    parseClockTime('tomorrow at 2:30 pm', NOW).toDateString() === tomorrow.toDateString());

check('clock: refuses an impossible hour', parseClockTime('at 25:00', NOW) === null);
check('clock: refuses impossible minutes', parseClockTime('at 10:75', NOW) === null);
check('clock: no time present', parseClockTime('sometime later', NOW) === null);

// --- the user's phrasings ---------------------------------------------------
check('"set an alarm for 40 minutes"', hhmm(at('jarvis set an alarm for 40 minutes')) === '09:40');
check('"set an alarm tomorrow at 2:30 pm"', hhmm(at('jarvis set an alarm tomorrow at 2:30 pm')) === '14:30');
check('"set an alarm tomorrow" lands tomorrow',
    parseAlarmCommand('jarvis set an alarm tomorrow at 2:30 pm', NOW).at.toDateString() === tomorrow.toDateString());
check('"set a timer for 30 minutes"', hhmm(at('jarvis set a timer for 30 minutes')) === '09:30');

const timer = parseAlarmCommand('set a timer for 30 minutes', NOW);
check('timer is labelled a timer', timer.kind === 'timer');
check('alarm is labelled an alarm', parseAlarmCommand('set an alarm for 30 minutes', NOW).kind === 'alarm');
check('"wake me at 6" resolves', at('wake me at 6') !== undefined);

// --- labels -----------------------------------------------------------------
check('label: from "to ..."',
    parseAlarmCommand('set a timer for twenty minutes to check the oven', NOW).label === 'check the oven');
check('label: from "called ..."',
    parseAlarmCommand('set an alarm for 10 minutes called standup', NOW).label === 'standup');

// Regression: labels were salvaged from leftover words and came out as
// "minutes" / "for half", which reads as "timer for 30 minutes: minutes".
check('label: no unit words leak', parseAlarmCommand('set a timer for 30 minutes', NOW).label === null);
check('label: none for a bare alarm', parseAlarmCommand('set an alarm for 40 minutes', NOW).label === null);
check('label: none from "half an hour"', parseAlarmCommand('set a timer for half an hour', NOW).label === null);

// --- refuses rather than guesses -------------------------------------------
// Recognised as a request but no time given: `at` is null so the caller asks,
// instead of an assistant saying "alarm set" without having set one.
const vague = parseAlarmCommand('set a timer for the pasta', NOW);
check('unresolved time returns a shape, not null', vague !== null);
check('unresolved time has no instant', vague.at === null);

for (const phrase of ['what time is it', 'how long is my timer', 'tell me about alarms', ''])
    check(`not a request: "${phrase}"`, parseAlarmCommand(phrase, NOW) === null);

// --- cancel and list --------------------------------------------------------
check('cancel: recognised', parseAlarmCancel('cancel the timer') !== null);
check('cancel: "stop the alarm"', parseAlarmCancel('stop the alarm') !== null);
check('cancel: all', parseAlarmCancel('cancel all alarms')?.all === true);
check('cancel: single is not all', parseAlarmCancel('cancel the timer')?.all === false);
check('cancel: needs an alarm noun', parseAlarmCancel('cancel that') === null);

check('list: "what timers do i have"', parseAlarmList('what timers do i have') === true);
check('list: "show my alarms"', parseAlarmList('show my alarms') === true);
check('list: "how long left on my timer"', parseAlarmList('how long left on my timer') === true);
check('list: setting one is not listing', parseAlarmList('the weather today') === false);

// --- clock times without "at" or a colon ------------------------------------
// parseClockTime matched only "at <n>" or "<h>:<mm>", so a meridiem on its own
// resolved to nothing and "set an alarm for 8pm" was answered with "I did not
// catch when". The meridiem is what makes these unambiguous.
check('clock: bare "8pm"', hhmm(at('set an alarm for 8pm')) === '20:00');
check('clock: bare "8 pm" spaced', hhmm(at('set an alarm for 8 pm')) === '20:00');
check('clock: bare "7am" rolls to tomorrow', hhmm(at('set alarm 7am')) === '07:00');
check('clock: trailing punctuation', hhmm(at('set an alarm to the 8pm.')) === '20:00');

// --- spoken clock times -----------------------------------------------------
// The failure message tells the user to say "set an alarm for seven thirty",
// which the digit-only parser could never read. Advertising a syntax that does
// not work leaves the user with no way to discover one that does.
check('spoken: "seven thirty"', hhmm(at('set an alarm for seven thirty')) === '19:30');
check('spoken: "six thirty" with at', hhmm(at('set an alarm at six thirty')) === '18:30');
check('spoken: "seven forty five"', hhmm(at('set an alarm for seven forty five')) === '19:45');
check('spoken: bare hour', hhmm(at('wake me at seven')) === '19:00');
check('spoken: "half past six"', hhmm(at('set an alarm for half past six')) === '18:30');
check('spoken: "quarter past six"', hhmm(at('set an alarm for quarter past six')) === '18:15');
check('spoken: "quarter to eight"', hhmm(at('set an alarm for quarter to eight')) === '19:45');
check('spoken: "quarter to one" wraps to 12', hhmm(at('set an alarm for quarter to one')) === '12:45');

// A duration must still read as a duration, not as an hour.
check('spoken: "seven minutes" stays a duration',
    parseAlarmCommand('set a timer for seven minutes', NOW)?.durationMs === 7 * MIN);
check('spoken: refuses a non-time word', parseClockTime('for the meeting', NOW) === null);
check('spoken: unresolvable still refuses',
    parseAlarmCommand('set an alarm for the meeting', NOW)?.at === null);

// --- formatting -------------------------------------------------------------
check('format: 40 minutes', formatDuration(40 * MIN) === '40 minutes');
check('format: singular minute', formatDuration(MIN) === '1 minute');
check('format: compound', formatDuration(90 * MIN) === '1 hour 30 minutes');
check('format: seconds only when under an hour', formatDuration(90000) === '1 minute 30 seconds');
check('format: clock same day has no suffix', !/tomorrow/.test(formatClock(new Date('2026-07-31T14:30:00'), NOW)));
check('format: clock tomorrow is marked', /tomorrow/.test(formatClock(new Date('2026-08-01T14:30:00'), NOW)));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
