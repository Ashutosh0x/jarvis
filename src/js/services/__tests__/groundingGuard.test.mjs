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

/* --- security identifiers --------------------------------------------------
   Added after the model invented a CVE severity and then defended the
   correction. From the interaction log, 21 Jul 2026:

     "latest cve number of chrome"
       -> "CVE-2026-15905 is the latest CRITICAL vulnerability"
     (user: it is rated High, not Critical)
       -> "The latest critical vulnerability is CVE-2026-15899"

   No advisory was in context for either answer. This user publishes CVEs; an
   invented identifier or severity gets cited and propagated. */
{
    const noAdvisory = 'The user asked about Chrome vulnerabilities. No advisory text was retrieved.';
    check('cve: an invented CVE id is blocked',
        findUngrounded('CVE-2026-15905 is the latest critical vulnerability.', noAdvisory).length > 0);
    check('cve: the blocked answer is not spoken',
        guardOutput('CVE-2026-15905 is the latest critical vulnerability.', noAdvisory).blocked === true);

    const withAdvisory = 'Chrome release notes: CVE-2026-15905 High, Aura, use-after-free. CVE-2026-15899 Critical, CameraCapture.';
    check('cve: an id that IS in the advisory passes',
        findUngrounded('CVE-2026-15905 affects Aura.', withAdvisory).length === 0);
    check('cve: case does not matter', findUngrounded('cve-2026-15905 affects Aura.', withAdvisory).length === 0);
    check('cve: a DIFFERENT id in the same answer is still caught',
        findUngrounded('CVE-2026-15905 and CVE-2026-99999 were patched.', withAdvisory).length === 1);

    check('cvss: an invented score is blocked',
        findUngrounded('It has a CVSS score of 9.8.', noAdvisory).length > 0);
    check('cvss: a score present in context passes',
        findUngrounded('It has a CVSS score of 9.8.', 'Advisory: CVSS score of 9.8 (critical).').length === 0);

    // Ordinary prose must not be caught: a guard that fires on everything is
    // turned off, and then it protects nothing.
    check('no false positive on ordinary security talk',
        findUngrounded('Chrome had several high severity issues this month.', noAdvisory).length === 0);
    check('no false positive on a version number',
        findUngrounded('Chrome 151 shipped on Tuesday.', noAdvisory).length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
