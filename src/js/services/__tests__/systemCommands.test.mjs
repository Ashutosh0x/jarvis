// Tests for the new system-command routes.
//
// The destructive entries are the reason this file is careful. "sign out"
// throws away unsaved work in every open application, and it is one syllable
// away from things people say in passing. So the question guard is tested
// harder than the happy path.

import { parseSystemCommand, SYSTEM_INTENTS } from '../systemCommands.js';

let pass = 0, fail = 0;
const check = (n, c) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); };
const intentOf = (s) => parseSystemCommand(s)?.intent ?? null;

/* --- the happy paths ------------------------------------------------------ */
{
    const cases = [
        ['lock the screen', 'LOCK_SCREEN'],
        ['lock my computer', 'LOCK_SCREEN'],
        ['go to sleep', 'SLEEP'],
        ['put the computer to sleep', 'SLEEP'],
        ['hibernate', 'HIBERNATE'],
        ['sign out', 'SIGN_OUT'],
        ['log off', 'SIGN_OUT'],
        ['empty the recycle bin', 'EMPTY_TRASH'],
        ['empty the trash', 'EMPTY_TRASH'],
        ['dark mode', 'DARK_MODE'],
        ['lights off', 'DARK_MODE'],
        ['light mode', 'LIGHT_MODE'],
        ['do not disturb', 'DND_ON'],
        ['focus mode', 'DND_ON'],
        ['turn off do not disturb', 'DND_OFF'],
        ['turn notifications on', 'DND_OFF'],
        ['uptime', 'UPTIME'],
        ['disk space', 'DISK_SPACE']
    ];
    for (const [say, want] of cases) {
        check(`"${say}" -> ${want}`, intentOf(say) === want);
    }
}

/* --- questions must not act ----------------------------------------------- */
{
    /* THE ONE THAT MATTERS. Each of these contains every token the imperative
       does. Acting on them signs the user out or wipes their recycle bin in
       the middle of a conversation about signing out or wiping it. */
    const mustNotFire = [
        'should i sign out',
        'what happens if i sign out',
        'how do i empty the recycle bin',
        'can you hibernate this machine',
        'does dark mode save battery',
        'why is my computer going to sleep',
        'is do not disturb on'
    ];
    for (const say of mustNotFire) {
        const got = intentOf(say);
        check(`"${say}" does NOT act (got ${got ?? 'null'})`, got === null);
    }

    // But two questions ARE information requests and must still answer.
    check('"how much space is left" answers', intentOf('how much space is left') === 'DISK_SPACE');
    check('"how long has this been on" answers',
        intentOf('how long has this been on') === 'UPTIME');
}

/* --- destructive marking -------------------------------------------------- */
{
    for (const i of ['SLEEP', 'HIBERNATE', 'SIGN_OUT', 'EMPTY_TRASH']) {
        check(`${i} is marked destructive`, SYSTEM_INTENTS[i].destructive === true);
    }
    for (const i of ['LOCK_SCREEN', 'DARK_MODE', 'DISK_SPACE', 'UPTIME', 'RADIO_TOGGLE']) {
        check(`${i} is NOT destructive`, SYSTEM_INTENTS[i].destructive === false);
    }
    check('the flag rides on the parse result',
        parseSystemCommand('sign out').destructive === true);
    check('and is false where it should be',
        parseSystemCommand('lock the screen').destructive === false);
}

/* --- radio toggles -------------------------------------------------------- */
{
    const bt = parseSystemCommand('turn off bluetooth');
    check('"turn off bluetooth" toggles the radio', bt?.intent === 'RADIO_TOGGLE');
    check('and knows which radio', bt?.kind === 'bluetooth');
    check('and which direction', bt?.on === false);

    const wifi = parseSystemCommand('turn on wifi');
    check('"turn on wifi" toggles', wifi?.intent === 'RADIO_TOGGLE' && wifi.kind === 'wifi');
    check('and is on', wifi?.on === true);
    check('"turn on wi-fi" hyphenated works',
        parseSystemCommand('turn on wi-fi')?.kind === 'wifi');

    /* Must not swallow the existing WIFI_CONNECT route, which is a different
       and much more specific command. */
    check('"connect to my hotspot" is NOT a radio toggle',
        parseSystemCommand('connect to my hotspot') === null);
    check('"connect to redmi wifi" is NOT a radio toggle',
        parseSystemCommand('connect to redmi wifi') === null);
}

/* --- no false positives on ordinary speech -------------------------------- */
{
    const inert = [
        'set an alarm for 7am',            // contains no sleep word but adjacent
        'remind me to sleep early',        // "sleep" as a topic, not a command
        'what time is it',
        'open chrome',
        'mirror my phone',
        'play some music',
        ''
    ];
    for (const say of inert) {
        check(`"${say || '(empty)'}" is not a system command`, parseSystemCommand(say) === null);
    }
    check('null input is safe', parseSystemCommand(null) === null);
    check('undefined input is safe', parseSystemCommand(undefined) === null);
}

/* --- pronoun-separated sign-out, found by the routing measurement ---------
   "sign me out of windows" missed a contiguous "sign out" match, fell through
   to the semantic router, and was picked up as screen_vision — because
   "windows" the operating system embeds close to "window" the UI element. A
   destructive command has to be settled deterministically, before the router
   ever sees it. */
{
    for (const say of ['sign me out of windows', 'log me off', 'sign us out', 'log out']) {
        check(`"${say}" -> SIGN_OUT`, intentOf(say) === 'SIGN_OUT');
    }
    // The words must still mean nothing on their own.
    for (const say of ['sign the document', 'signal strength']) {
        check(`"${say}" is not a sign-out`, intentOf(say) !== 'SIGN_OUT');
    }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
