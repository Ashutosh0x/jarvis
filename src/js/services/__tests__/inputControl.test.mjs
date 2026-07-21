// Tests for keyboard/window control. Load-bearing: SendKeys metacharacter
// escaping. Unescaped, "+50%" fires SHIFT and a ctrl-chord instead of typing.
// The ESCAPE_CASE string below is the exact one verified live through Notepad
// (typed, selected, copied back, compared) before this module was written.
import {
    escapeSendKeys, encodeChord, normalizeDictation, parseInputCommand,
    matchWindow, KEY_TOKENS, parseDictationInput, parseDictationStart,
} from '../inputControl.js';

let pass = 0, fail = 0;
const check = (n, c) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); };

// --- escaping (verified byte-exact against real Notepad) --------------------
const ESCAPE_CASE = 'Profit +50% (C++) ~approx~ {braces} [brackets] ^caret & 100% done';
check('escape: every metacharacter is braced',
    escapeSendKeys(ESCAPE_CASE) ===
    'Profit {+}50{%} {(}C{+}{+}{)} {~}approx{~} {{}braces{}} {[}brackets{]} {^}caret & 100{%} done');
check('escape: plus', escapeSendKeys('a+b') === 'a{+}b');
check('escape: percent', escapeSendKeys('50%') === '50{%}');
check('escape: caret', escapeSendKeys('2^8') === '2{^}8');
check('escape: tilde', escapeSendKeys('~x') === '{~}x');
check('escape: parens', escapeSendKeys('(hi)') === '{(}hi{)}');
check('escape: braces', escapeSendKeys('{a}') === '{{}a{}}');
check('escape: brackets', escapeSendKeys('[a]') === '{[}a{]}');
check('escape: plain text untouched', escapeSendKeys('hello world 123') === 'hello world 123');
check('escape: ampersand is NOT a metacharacter', escapeSendKeys('a & b') === 'a & b');
check('escape: empty is empty', escapeSendKeys('') === '');
check('escape: null-safe', escapeSendKeys(null) === '');
check('escape: unicode passes through', escapeSendKeys('café ₹100') === 'café ₹100');

// --- key chords ---------------------------------------------------------------
check('chord: bare enter', encodeChord('enter') === '{ENTER}');
check('chord: return is enter', encodeChord('return') === '{ENTER}');
check('chord: escape', encodeChord('escape') === '{ESC}');
check('chord: ctrl+s', encodeChord('ctrl s') === '^s');
check('chord: control spelled out', encodeChord('control s') === '^s');
check('chord: plus separator', encodeChord('ctrl+s') === '^s');
check('chord: alt+f4', encodeChord('alt f4') === '%{F4}');
check('chord: two modifiers', encodeChord('ctrl shift n') === '^+n');
check('chord: duplicate modifier not repeated', encodeChord('ctrl ctrl s') === '^s');
check('chord: arrow key', encodeChord('down') === '{DOWN}');
check('chord: two non-modifier keys rejected', encodeChord('a b') === null);
check('chord: unknown key rejected', encodeChord('banana') === null);
check('chord: empty rejected', encodeChord('') === null);
check('chord: modifier alone rejected', encodeChord('ctrl') === null);
check('keys: function keys present', KEY_TOKENS.f5 === '{F5}');

// --- dictation normalisation ------------------------------------------------------
// Exact expected output — spacing included, since it is what gets typed.
check('dictation: at the rate -> @ with no stray spaces',
    normalizeDictation('me at the rate example.com') === 'me@example.com');
check('dictation: dot com', normalizeDictation('google dot com') === 'google.com');
check('dictation: leaves ordinary words alone',
    normalizeDictation('meet me at the cafe') === 'meet me at the cafe');
check('dictation: collapses whitespace', normalizeDictation('a    b') === 'a b');
check('dictation: trims', normalizeDictation('  hi  ') === 'hi');

// --- command parsing ----------------------------------------------------------------
check('parse: type', parseInputCommand('type hello world')?.intent === 'TYPE_TEXT');
check('parse: type keeps the text', parseInputCommand('type hello world')?.text === 'hello world');
check('parse: type PRESERVES original casing',
    parseInputCommand('type Hello World')?.text === 'Hello World');
check('parse: write is a synonym', parseInputCommand('write an email')?.intent === 'TYPE_TEXT');
check('parse: press enter', parseInputCommand('press enter')?.chord === '{ENTER}');
check('parse: hit ctrl s', parseInputCommand('hit ctrl s')?.chord === '^s');
check('parse: press unknown key is not an intent', parseInputCommand('press banana') === null);
check('parse: search sets thenEnter',
    parseInputCommand('search for weather in delhi')?.thenEnter === true);
check('parse: search text captured',
    parseInputCommand('search for weather in delhi')?.text === 'weather in delhi');
check('parse: google as a verb', parseInputCommand('google typescript generics')?.isSearch === true);
check('parse: close app', parseInputCommand('close notepad')?.name === 'notepad');
check('parse: quit is a synonym', parseInputCommand('quit chrome')?.name === 'chrome');
check('parse: switch to app', parseInputCommand('switch to chrome')?.intent === 'FOCUS_WINDOW');
check('parse: focused window question', parseInputCommand('what window am i in')?.intent === 'FOCUSED_WINDOW');

// --- the refusals that keep this safe -------------------------------------------------
check('parse: will not close Jarvis itself', parseInputCommand('close jarvis') === null);
check('parse: "close everything" refused', parseInputCommand('close everything') === null);
check('parse: "close all" refused', parseInputCommand('close all') === null);
check('parse: "shut down" is not an app close', parseInputCommand('shut down') === null);
check('parse: "close tab" not treated as an app', parseInputCommand('close tab') === null);
check('parse: unrelated speech ignored', parseInputCommand('what time is it') === null);
check('parse: price query not stolen', parseInputCommand('price of tesla') === null);
check('parse: empty', parseInputCommand('') === null);
check('parse: "search my files" is not a keystroke search',
    parseInputCommand('search my files') === null);

// --- dictation mode ----------------------------------------------------------------------
// Bias: when in doubt TYPE the words. A false command steals what the user
// said; a false word is one backspace away.
check('dictate: bare "type" starts dictation, does not type nothing',
    parseInputCommand('type')?.intent === 'DICTATE_START');
check('dictate: "start typing"', parseInputCommand('start typing')?.intent === 'DICTATE_START');
check('dictate: "voice typing"', parseInputCommand('voice typing')?.intent === 'DICTATE_START');
check('dictate: "dictate"', parseInputCommand('dictate')?.intent === 'DICTATE_START');
check('dictate: "type hello" still types the words, not a mode change',
    parseInputCommand('type hello')?.intent === 'TYPE_TEXT');

check('dictation: stop phrase ends it', parseDictationInput('stop typing').kind === 'stop');
check('dictation: stop with punctuation', parseDictationInput('Stop typing.').kind === 'stop');
check('dictation: "done typing"', parseDictationInput('done typing').kind === 'stop');
check('dictation: new line is a key', parseDictationInput('new line').kind === 'key');
check('dictation: new line chord', parseDictationInput('new line').chord === '{ENTER}');
check('dictation: new paragraph is two enters', parseDictationInput('new paragraph').chord === '{ENTER}{ENTER}');
check('dictation: undo', parseDictationInput('undo that').chord === '^z');
check('dictation: select all', parseDictationInput('select all').chord === '^a');
check('dictation: save', parseDictationInput('save it').chord === '^s');
check('dictation: backspace', parseDictationInput('delete that').chord === '{BACKSPACE}');
check('dictation: ordinary sentence is typed',
    parseDictationInput('the meeting is at three pm').kind === 'text');
check('dictation: sentence text preserved',
    parseDictationInput('the meeting is at three pm').text === 'the meeting is at three pm');
check('dictation: a sentence CONTAINING "stop typing" is still typed',
    parseDictationInput('tell him to stop typing so loudly').kind === 'text');
check('dictation: a sentence containing "new line" is typed',
    parseDictationInput('draw a new line on the chart').kind === 'text');
check('dictation: commands are exact-match only, never substrings',
    parseDictationInput('undo the damage').kind === 'text');
check('dictation: empty transcript is harmless',
    parseDictationInput('').kind === 'text' && parseDictationInput('').text === '');
check('dictation: dictated punctuation still normalised',
    parseDictationInput('email me at the rate example.com').text === 'email me@example.com');

// --- window matching --------------------------------------------------------------------
const WINDOWS = [
    { process: 'chrome', desc: 'Google Chrome', title: 'New chat - Claude - Google Chrome' },
    { process: 'notepad', desc: 'Notepad', title: 'Untitled - Notepad' },
    { process: 'electron', desc: 'Electron', title: 'JARVIS - Neural Link' },
    { process: 'WindowsTerminal', desc: 'Windows Terminal', title: 'Switch to Jarvis project' },
];
check('match: exact process name', matchWindow(WINDOWS, 'notepad')?.process === 'notepad');
check('match: case-insensitive', matchWindow(WINDOWS, 'NOTEPAD')?.process === 'notepad');
check('match: by Windows description', matchWindow(WINDOWS, 'google chrome')?.process === 'chrome');
check('match: by window title fragment', matchWindow(WINDOWS, 'neural link')?.process === 'electron');
check('match: process beats title', matchWindow(WINDOWS, 'chrome')?.process === 'chrome');
check('match: unknown returns null', matchWindow(WINDOWS, 'photoshop') === null);
check('match: empty returns null', matchWindow(WINDOWS, '') === null);
check('match: no windows returns null', matchWindow([], 'chrome') === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
