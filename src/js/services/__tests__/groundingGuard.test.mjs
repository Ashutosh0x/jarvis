// Tests for the grounding guard. The cases marked LOG are replayed verbatim
// from the interaction log of 21 Jul 2026 — they are the fabrications that got
// spoken aloud as fact while the system prompt forbade exactly that.
import { findUngrounded, guardOutput } from '../groundingGuard.js';

let pass = 0, fail = 0;
const check = (n, c) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); };

// --- LOG: the invented IP address -------------------------------------------
{
    const answer = 'The IP address associated with "Pro Haven" is 192.168.1.10, Sir.';
    const ctx = 'The user asked for the IP of pro haven. No scan output available.';
    const found = findUngrounded(answer, ctx);
    check('LOG: invented IP is caught', found.length === 1 && found[0].kind === 'ipv4');

    const g = guardOutput(answer, ctx);
    check('LOG: invented IP is not spoken', g.blocked && !g.text.includes('192.168.1.10'));
    check('LOG: refusal is offered instead', /do not have/i.test(g.text));
}

// --- the same address, but actually measured --------------------------------
{
    const answer = 'The router is at 192.168.1.10, Sir.';
    const ctx = 'Live network telemetry: gateway 192.168.1.10, signal 100%.';
    check('grounded IP passes through untouched',
        !guardOutput(answer, ctx).blocked);
}

// --- spoken/spaced form still matches ---------------------------------------
{
    const answer = 'It is 192. 168. 1. 10, Sir.';
    check('spaced IP is matched against tight context',
        !guardOutput(answer, 'gateway 192.168.1.10').blocked);
    check('spaced IP with no context is blocked',
        guardOutput(answer, 'nothing measured').blocked);
}

// --- LOG: the invented Bluetooth device names -------------------------------
{
    const answer = 'The detected devices are: "HeadphonesXYZ" and "SmartwatchABC".';
    const ctx = '1 paired Bluetooth device, none currently connected.';
    const found = findUngrounded(answer, ctx);
    check('LOG: both placeholder names are caught', found.length === 2);
    check('LOG: placeholder names are not spoken',
        !guardOutput(answer, ctx).text.includes('HeadphonesXYZ'));
}

// Placeholder names are a fabrication tell even if echoed back into context —
// this is the 13:56:47 case, where the model defended its own invention after
// the earlier turn had put the names into the conversation history.
{
    const answer = 'The scan detected "HeadphonesXYZ" and "SmartwatchABC", as before, Sir.';
    const ctx = 'assistant: The detected devices are "HeadphonesXYZ" and "SmartwatchABC".';
    check('LOG: self-echoed placeholder is still blocked',
        guardOutput(answer, ctx).blocked);
}

// --- MAC addresses ----------------------------------------------------------
{
    check('ungrounded MAC is caught',
        guardOutput('Its MAC is a4:83:e7:1b:cc:02.', 'no scan run').blocked);
    check('grounded MAC passes',
        !guardOutput('Its MAC is a4:83:e7:1b:cc:02.', 'arp: a4:83:e7:1b:cc:02 present').blocked);
}

// --- FALSE POSITIVES: things that must NOT be blocked ------------------------
// A guard that fires on ordinary speech would be worse than the bug, since it
// replaces real answers with refusals.
{
    const safe = [
        ['plain numbers', 'A Bluetooth scan typically takes between 10 and 30 seconds, Sir.'],
        ['percentages', 'CPU averaged 46 percent and peaked at 56, Sir.'],
        ['a clock time', 'The current time is 14:32, Sir.'],
        ['a decimal', 'Microsoft has a beta of 0.80 to the S&P 500.'],
        ['a short version', 'You are running gemma3:4b locally.'],
        ['a date', 'That was on 21 July 2026, Sir.'],
        ['no identifiers at all', 'Acknowledged, Sir. I am awaiting further instructions.'],
    ];
    for (const [name, text] of safe) {
        check(`no false positive: ${name}`, !guardOutput(text, '').blocked);
    }
}

// --- degenerate input -------------------------------------------------------
{
    check('empty text is safe', !guardOutput('', 'ctx').blocked);
    check('null text is safe', !guardOutput(null, null).blocked);
    check('null context still blocks an invented IP',
        guardOutput('It is 10.0.0.5.', null).blocked);
}

// --- octet validation -------------------------------------------------------
{
    check('non-address dotted number is ignored',
        !guardOutput('Version 999.999.999.999 of nothing.', '').blocked);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
