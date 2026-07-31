// Tests for conversational meeting scheduling and the meeting monitor.
//
// What matters here: a meeting must never be created at a time or with people
// the user did not actually say. So the flow REFUSES rather than guesses, and
// the alert schedule is checked for the property that makes warnings useful —
// escalation, not repetition.
import { MeetingScheduler, STEP, extractEmails } from '../meetingScheduler.js';
import { MeetingMonitor, describeAlert } from '../meetingMonitor.js';

let pass = 0, fail = 0;
const check = (n, c) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); };

const NOW = new Date('2026-07-31T09:00:00');

/** localStorage stand-in, so tests do not depend on a browser. */
const memStore = () => {
    const m = new Map();
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) };
};

// --- the full happy path ----------------------------------------------------
{
    const s = new MeetingScheduler();
    check('starts idle', !s.isActive);

    const opening = s.start();
    check('start asks for a title', /call this meeting/i.test(opening.say));
    check('is active once started', s.isActive);

    const r1 = await s.handle('project review', NOW);
    check('title captured and echoed', /Project review/i.test(r1.say));
    check('then asks what it is about', /what is this meeting about/i.test(r1.say));

    const r2 = await s.handle('q3 roadmap and hiring', NOW);
    check('purpose accepted, asks when', /when should i schedule/i.test(r2.say));

    const r3 = await s.handle('tomorrow at 3 pm', NOW);
    check('time accepted, asks duration', /how long/i.test(r3.say));

    const r4 = await s.handle('one hour', NOW);
    check('duration accepted, asks attendees', /invite/i.test(r4.say));

    const r5 = await s.handle('no one', NOW);
    check('summarises for confirmation', /shall i create it/i.test(r5.say));
    check('summary names the meeting', /Project review/i.test(r5.say));
    check('summary states the purpose', /q3 roadmap/i.test(r5.say));

    const r6 = await s.handle('yes', NOW);
    check('confirmation creates', r6.done === true && Boolean(r6.create));
    check('resets after creating', !s.isActive);

    const ev = r6.create;
    check('event has a title', ev.summary === 'Project review');
    check('event has a description', /q3 roadmap/i.test(ev.description));
    check('event asks for a Meet link', ev.withMeet === true);
    check('event has no attendees', ev.attendees.length === 0);

    // 3pm + 1h = 4pm, and the ISO strings must reflect exactly that.
    const durationMs = Date.parse(ev.endISO) - Date.parse(ev.startISO);
    check('duration is one hour', durationMs === 3600000);
    check('starts tomorrow', new Date(ev.startISO) > NOW);
}

// --- refuses rather than guesses -------------------------------------------
{
    const s = new MeetingScheduler();
    s.start();
    await s.handle('standup', NOW);
    await s.handle('daily sync', NOW);

    const bad = await s.handle('sometime later', NOW);
    check('unparseable time is refused', /did not catch a time/i.test(bad.say));
    check('stays on the time step', s.step === STEP.WHEN);

    const good = await s.handle('at 4 pm', NOW);
    check('recovers once a real time is given', /how long/i.test(good.say));

    const badDuration = await s.handle('a while', NOW);
    check('unparseable duration is refused', /how long/i.test(badDuration.say));
    check('stays on the duration step', s.step === STEP.DURATION);
}

// --- cancelling -------------------------------------------------------------
{
    const s = new MeetingScheduler();
    s.start();
    const c = await s.handle('cancel', NOW);
    check('cancel abandons the flow', c.cancelled === true);
    check('and resets', !s.isActive);

    const s2 = new MeetingScheduler();
    s2.start();
    await s2.handle('sync', NOW);
    await s2.handle('stuff', NOW);
    await s2.handle('at 2 pm', NOW);
    await s2.handle('30 minutes', NOW);
    await s2.handle('no one', NOW);
    const declined = await s2.handle('no', NOW);
    check('declining at confirm creates nothing', !declined.create && declined.cancelled);
}

// --- attendees --------------------------------------------------------------
check('email: plain', extractEmails('john@example.com')[0] === 'john@example.com');
check('email: two', extractEmails('a@x.com and b@y.com').length === 2);

// Speech recognition renders symbols as words about as often as not.
check('email: spoken "at" and "dot"',
    extractEmails('john at example dot com')[0] === 'john@example.com');
check('email: spoken with spacing',
    extractEmails('sarah at company dot co dot uk')[0] === 'sarah@company.co.uk');
check('email: deduplicates', extractEmails('a@x.com a@x.com').length === 1);
check('email: none found in prose', extractEmails('nobody at all').length === 0);

{
    const s = new MeetingScheduler();
    s.start();
    await s.handle('review', NOW);
    await s.handle('things', NOW);
    await s.handle('at 3 pm', NOW);
    await s.handle('30 minutes', NOW);

    // A mangled address must not silently invite nobody.
    const garbled = await s.handle('john smith', NOW);
    check('unparseable attendee is refused', /could not make out an email/i.test(garbled.say));
    check('stays on the attendee step', s.step === STEP.ATTENDEES);

    const ok = await s.handle('john at example dot com', NOW);
    check('recovers with a spoken address', /shall i create it/i.test(ok.say));
    check('attendee captured', s.draft.attendees[0] === 'john@example.com');
}

// --- monitor: escalation, not repetition -----------------------------------
{
    const alerts = [];
    const start = NOW.getTime() + 31 * 60000;   // 31 minutes out
    const events = [{ id: 'e1', summary: 'Standup', start: new Date(start).toISOString(), meetLink: 'https://meet.google.com/x' }];

    const m = new MeetingMonitor({
        fetchEvents: async () => events,
        onAlert: (a) => alerts.push(a),
        storage: memStore(),
    });
    await m._refresh();

    // Walk the clock forward and count what would be said.
    const realNow = Date.now;
    for (const minutesOut of [31, 29, 20, 11, 9, 6, 4, 2, 0.5]) {
        Date.now = () => start - minutesOut * 60000;
        m._tick();
    }
    Date.now = realNow;

    check('monitor alerts at all', alerts.length > 0);
    // Four stages: 30, 10, 5, 1. Fixed 5-minute repeats would give eight.
    check('escalates in four stages, not eight repeats', alerts.length === 4);
    check('first alert is a heads-up', alerts[0].tone === 'heads-up');
    check('last alert is the start', alerts[alerts.length - 1].isFinal === true);
    check('tones differ across stages', new Set(alerts.map((a) => a.tone)).size === 4);
}

// --- monitor: acknowledgement ----------------------------------------------
{
    const alerts = [];
    const start = NOW.getTime() + 31 * 60000;
    const m = new MeetingMonitor({
        fetchEvents: async () => [{ id: 'e1', summary: 'Standup', start: new Date(start).toISOString() }],
        onAlert: (a) => alerts.push(a),
        storage: memStore(),
    });
    await m._refresh();

    const realNow = Date.now;
    Date.now = () => start - 29 * 60000;
    m._tick();
    check('alerts before acknowledgement', alerts.length === 1);

    m.acknowledge('e1');
    for (const out of [9, 4, 0.5]) { Date.now = () => start - out * 60000; m._tick(); }
    Date.now = realNow;
    check('silent after acknowledgement', alerts.length === 1);
}

// --- monitor: a meeting added late must not fire every stage at once -------
{
    const alerts = [];
    const start = NOW.getTime() + 6 * 60000;   // only 6 minutes away
    const m = new MeetingMonitor({
        fetchEvents: async () => [{ id: 'late', summary: 'Ambush', start: new Date(start).toISOString() }],
        onAlert: (a) => alerts.push(a),
        storage: memStore(),
    });
    await m._refresh();

    const realNow = Date.now;
    Date.now = () => start - 6 * 60000;
    m._tick();
    m._tick();   // a second tick must not re-fire the same stage
    Date.now = realNow;

    check('a late-added meeting alerts once, not three times', alerts.length === 1);
    check('and at the right urgency', alerts[0].tone === 'soon');
}

// --- monitor: all-day events ------------------------------------------------
{
    const alerts = [];
    const m = new MeetingMonitor({
        fetchEvents: async () => [{ id: 'holiday', summary: 'Bank holiday', start: '2026-08-01', allDay: true }],
        onAlert: (a) => alerts.push(a),
        storage: memStore(),
    });
    await m._refresh();
    check('all-day events are not counted down', m.events.length === 0);
}

// --- monitor: a failed poll keeps the last schedule ------------------------
{
    let shouldFail = false;
    const m = new MeetingMonitor({
        fetchEvents: async () => {
            if (shouldFail) throw new Error('offline');
            return [{ id: 'e1', summary: 'Standup', start: new Date(NOW.getTime() + 3600000).toISOString() }];
        },
        onAlert: () => {},
        storage: memStore(),
    });
    await m._refresh();
    check('has events after a good poll', m.events.length === 1);

    shouldFail = true;
    await m._refresh();
    // Blanking the schedule on one network blip would make Jarvis claim there
    // are no meetings, which is a fabrication.
    check('keeps events after a failed poll', m.events.length === 1);
    check('and reports the error', m.status().lastError === 'offline');
}

// --- alert phrasing ---------------------------------------------------------
{
    const ev = { summary: 'Standup', meetLink: 'https://meet.google.com/abc' };
    check('phrasing names the meeting',
        describeAlert({ event: ev, minutesUntil: 10, tone: 'soon' }).includes('Standup'));
    check('phrasing mentions the link when present',
        /link/i.test(describeAlert({ event: ev, minutesUntil: 10, tone: 'soon' })));
    check('phrasing omits the link when absent',
        !/link/i.test(describeAlert({ event: { summary: 'X' }, minutesUntil: 10, tone: 'soon' })));
    check('final alert says starting now',
        /starting now/i.test(describeAlert({ event: ev, minutesUntil: 0, tone: 'starting' })));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
