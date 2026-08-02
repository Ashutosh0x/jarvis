// Tests for computer-use containment.
//
// This is the first feature in Jarvis where the MODEL drives physical input,
// so these are not "does the parser work" tests — they are the containment
// itself. Each block below is written against a specific way this feature
// could hurt the user, and the assertions are that it cannot.
//
// The one that matters most is PROVENANCE. Jarvis fetches web pages and OCRs
// whatever lands in Downloads. If text from either path can propose an action,
// a page that says "click here, then type this" is a remote-control payload.
// The test asserts a well-formed, in-bounds, harmless-looking action from that
// origin is still refused — because the dangerous case will look harmless.

import {
    createSession, arm, disarm, abort, isArmed,
    validateAction, windowAllowed, recordStep, humanTookOver, parseControlCommand,
    ACTION_TYPES, CU_LIMITS
} from '../computerUseIntent.js';

let pass = 0, fail = 0;
const check = (n, c) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); };

const SCREEN = { screen: { width: 1920, height: 1080 } };
const armed = () => arm(createSession());

/* --- disarmed by default -------------------------------------------------- */
{
    const s = createSession();
    check('a new session is NOT armed', isArmed(s) === false);
    const r = validateAction({ type: 'click', x: 10, y: 10, provenance: 'user' }, s, SCREEN);
    check('a disarmed session refuses a valid click', r.ok === false);
    check('and says why', r.reason === 'not-armed');
    check('refusal returns no action to execute', r.action === null);
}

/* --- provenance: the trust boundary --------------------------------------- */
{
    const s = armed();

    /* THE CASE THIS EXISTS FOR. Everything about this action is fine except
       where it came from. A filter that judged actions on their contents would
       pass it. */
    const injected = validateAction(
        { type: 'click', x: 100, y: 100, provenance: 'untrusted' }, s, SCREEN);
    check('a PERFECTLY VALID click from untrusted content is refused',
        injected.ok === false);
    check('and named as an origin problem, not a shape problem',
        injected.reason === 'untrusted-origin');

    // Same for the quieter action types — a scroll is still remote control.
    for (const a of [
        { type: 'type', text: 'hello', provenance: 'untrusted' },
        { type: 'scroll', amount: 3, provenance: 'untrusted' },
        { type: 'screenshot', provenance: 'untrusted' },
        { type: 'key', chord: 'tab', provenance: 'untrusted' }
    ]) {
        check(`untrusted '${a.type}' is refused`,
            validateAction(a, s, SCREEN).reason === 'untrusted-origin');
    }

    check('an action with no provenance at all is refused',
        validateAction({ type: 'click', x: 1, y: 1 }, s, SCREEN).reason === 'missing-provenance');
    check('an invented provenance value is refused',
        validateAction({ type: 'click', x: 1, y: 1, provenance: 'trusted' }, s, SCREEN)
            .reason === 'missing-provenance');

    check('the same click from the user is allowed',
        validateAction({ type: 'click', x: 100, y: 100, provenance: 'user' }, s, SCREEN).ok === true);
}

/* --- step budget: runaways become reports --------------------------------- */
{
    let s = arm(createSession({ maxSteps: 3 }));
    for (let i = 0; i < 3; i++) {
        const r = validateAction({ type: 'click', x: 5, y: 5, provenance: 'model' }, s, SCREEN);
        check(`step ${i + 1} of 3 allowed`, r.ok === true);
        s = recordStep(s, { type: 'click' });
    }
    const over = validateAction({ type: 'click', x: 5, y: 5, provenance: 'model' }, s, SCREEN);
    check('the fourth step is refused', over.ok === false);
    check('and names the budget', over.reason === 'step-budget-exhausted');

    check('the budget cannot be raised above the hard ceiling',
        createSession({ maxSteps: 10000 }).maxSteps === CU_LIMITS.MAX_STEPS);
    check('a nonsense budget falls back to the default',
        createSession({ maxSteps: 'lots' }).maxSteps === CU_LIMITS.MAX_STEPS);

    // Observation still costs a step: a screenshot loop is a runaway too.
    let t = arm(createSession({ maxSteps: 1 }));
    check('screenshot is permitted while budget remains',
        validateAction({ type: 'screenshot', provenance: 'model' }, t, SCREEN).ok === true);
    t = recordStep(t, { type: 'screenshot' });
    check('screenshot consumes budget like any other step',
        validateAction({ type: 'screenshot', provenance: 'model' }, t, SCREEN)
            .reason === 'step-budget-exhausted');
}

/* --- the arm expires ------------------------------------------------------ */
{
    const now = 1_000_000;
    const s = arm(createSession(), now);
    check('armed at t=0', isArmed(s, now) === true);
    check('still armed just inside the window',
        isArmed(s, now + CU_LIMITS.ARM_MS - 1) === true);
    check('NOT armed once the window passes',
        isArmed(s, now + CU_LIMITS.ARM_MS + 1) === false);

    const late = validateAction(
        { type: 'click', x: 1, y: 1, provenance: 'user' }, s,
        { ...SCREEN, now: now + CU_LIMITS.ARM_MS + 1 });
    check('an expired arm refuses, and says so', late.reason === 'arm-expired');
}

/* --- abort is sticky ------------------------------------------------------ */
{
    const s = abort(armed(), 'mouse-moved');
    check('an aborted session is not armed', isArmed(s) === false);
    check('and refuses with the abort reason',
        validateAction({ type: 'click', x: 1, y: 1, provenance: 'user' }, s, SCREEN)
            .reason === 'aborted');
    // Re-arming is the only way back — abort must not be silently recoverable.
    check('re-arming clears the abort', isArmed(arm(s)) === true);
}

/* --- bounds are refused, never clamped ------------------------------------ */
{
    const s = armed();
    const out = validateAction({ type: 'click', x: 5000, y: 40, provenance: 'model' }, s, SCREEN);
    check('an off-screen click is refused', out.ok === false);
    check('and is NOT silently clamped to the edge', out.action === null);

    for (const [x, y, label] of [
        [-1, 10, 'negative x'], [10, -1, 'negative y'],
        [1920, 10, 'x at width (exclusive)'], [10, 1080, 'y at height (exclusive)'],
        [NaN, 10, 'NaN'], ['12', 'abc', 'non-numeric']
    ]) {
        check(`${label} is out of bounds`,
            validateAction({ type: 'click', x, y, provenance: 'model' }, s, SCREEN).ok === false);
    }

    check('the last valid pixel is allowed',
        validateAction({ type: 'click', x: 1919, y: 1079, provenance: 'model' }, s, SCREEN).ok === true);
    check('(0,0) is allowed',
        validateAction({ type: 'click', x: 0, y: 0, provenance: 'model' }, s, SCREEN).ok === true);

    check('an unknown screen size refuses positional actions',
        validateAction({ type: 'click', x: 1, y: 1, provenance: 'model' }, s, {}).reason
            === 'unknown-screen-size');
    check('but a non-positional action still works without one',
        validateAction({ type: 'type', text: 'hi', provenance: 'user' }, s, {}).ok === true);

    const drag = validateAction(
        { type: 'drag', x: 10, y: 10, toX: 9999, toY: 10, provenance: 'model' }, s, SCREEN);
    check('a drag with an out-of-bounds target is refused',
        drag.reason === 'drag-target-out-of-bounds');
}

/* --- forbidden and destructive -------------------------------------------- */
{
    const s = armed();
    for (const chord of ['ctrl+alt+delete', 'win+r', 'win+x', 'ctrl+shift+esc']) {
        const r = validateAction({ type: 'key', chord, provenance: 'user' }, s, SCREEN);
        check(`'${chord}' is never sent`, r.ok === false && /forbidden-chord/.test(r.reason));
    }
    // Spacing and case must not be a bypass.
    check('forbidden chords are matched after normalisation',
        validateAction({ type: 'key', chord: ' Ctrl + Alt + Delete ', provenance: 'user' }, s, SCREEN)
            .ok === false);

    for (const chord of ['enter', 'ctrl+s', 'alt+f4', 'delete']) {
        const r = validateAction({ type: 'key', chord, provenance: 'model' }, s, SCREEN);
        check(`'${chord}' is allowed but needs confirmation`,
            r.ok === true && r.needsConfirmation === true);
    }
    check('an ordinary key needs no confirmation',
        validateAction({ type: 'key', chord: 'tab', provenance: 'model' }, s, SCREEN)
            .needsConfirmation === false);
    check('a drag needs confirmation (it can move or delete a file)',
        validateAction({ type: 'drag', x: 1, y: 1, toX: 2, toY: 2, provenance: 'model' }, s, SCREEN)
            .needsConfirmation === true);
    check('typing does NOT need confirmation (Enter is what commits)',
        validateAction({ type: 'type', text: 'hello', provenance: 'model' }, s, SCREEN)
            .needsConfirmation === false);
}

/* --- input shape ---------------------------------------------------------- */
{
    const s = armed();
    check('an unknown action type is refused',
        validateAction({ type: 'exec', provenance: 'user' }, s, SCREEN).ok === false);
    check('a non-object is refused',
        validateAction('click 10 10', s, SCREEN).reason === 'not-an-action');
    check('null is refused', validateAction(null, s, SCREEN).reason === 'not-an-action');
    check('empty text is refused',
        validateAction({ type: 'type', text: '', provenance: 'user' }, s, SCREEN).ok === false);
    check('over-long text is refused',
        validateAction({ type: 'type', text: 'x'.repeat(CU_LIMITS.MAX_TEXT + 1), provenance: 'user' }, s, SCREEN)
            .reason === 'text-too-long');
    check('scroll is clamped rather than refused',
        validateAction({ type: 'scroll', amount: 9999, provenance: 'model' }, s, SCREEN)
            .action.amount === CU_LIMITS.MAX_SCROLL);
    check('a zero scroll is refused as meaningless',
        validateAction({ type: 'scroll', amount: 0, provenance: 'model' }, s, SCREEN).ok === false);
    check('every declared action type is reachable', ACTION_TYPES.length >= 10);
}

/* --- the human kill switch ------------------------------------------------ */
{
    check('an untouched mouse does not trigger',
        humanTookOver({ x: 100, y: 100 }, { x: 100, y: 100 }) === false);
    check('a 2px settle does not trigger (measured drift)',
        humanTookOver({ x: 100, y: 100 }, { x: 102, y: 101 }) === false);
    check('a hand grabbing the mouse triggers',
        humanTookOver({ x: 100, y: 100 }, { x: 400, y: 300 }) === true);
    check('vertical-only movement triggers',
        humanTookOver({ x: 100, y: 100 }, { x: 100, y: 260 }) === true);
    check('missing readings do not fire a false abort',
        humanTookOver(null, { x: 1, y: 1 }) === false);
}

/* --- window allowlist ----------------------------------------------------- */
{
    check('no allowlist means any window', windowAllowed(createSession(), 'Anything'));
    const s = createSession({ allowWindows: ['notepad'] });
    check('an allowed window matches case-insensitively',
        windowAllowed(s, 'Untitled - Notepad') === true);
    check('a different window is refused', windowAllowed(s, 'Google Chrome') === false);
    check('a missing title is refused when an allowlist is set',
        windowAllowed(s, null) === false);
}

/* --- arm/disarm phrasing is rule-parsed ----------------------------------- */
{
    for (const p of [
        'you can control my computer',
        'enable computer control',
        'allow desktop control',
        'take over my screen'
    ]) check(`"${p}" arms`, parseControlCommand(p)?.action === 'arm');

    for (const p of [
        'stop controlling my computer',
        'disable computer control',
        'cancel, stop clicking',
        'release the mouse'
    ]) check(`"${p}" disarms`, parseControlCommand(p)?.action === 'disarm');

    /* Talking ABOUT it is not asking FOR it — the same precedence trap every
       routing bug in this repo has been. */
    for (const p of [
        'what is computer control',
        'can you control my computer',
        'how does desktop control work',
        'open chrome'
    ]) check(`"${p}" does not arm`, parseControlCommand(p)?.action !== 'arm');

    check('empty input is not a command', parseControlCommand('') === null);
}

/* --- the audit trail ------------------------------------------------------ */
{
    let s = armed();
    s = recordStep(s, { type: 'click', x: 5, y: 5, at: 111 });
    s = recordStep(s, { type: 'type', text: 'hi', at: 222 });
    check('every step is logged', s.log.length === 2);
    check('the log preserves order and detail',
        s.log[0].type === 'click' && s.log[1].text === 'hi');
    check('the step count matches the log', s.steps === s.log.length);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
