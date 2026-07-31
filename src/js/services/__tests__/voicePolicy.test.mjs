// Jarvis has one voice, and it is Emma.
//
// The failure this guards against is specific and has happened: the neural TTS
// server goes down, the code falls back to the Windows system voice, and Jarvis
// starts speaking as David — a different person — without saying anything about
// it. A dead server should cost you the voice, not change who it is.
//
// These read the shipped source rather than importing it, because the speech
// path needs `window`, `speechSynthesis` and an AudioContext. What matters is
// checkable statically: that no path reaches the system synthesiser without
// passing the gate, and that the gate is off by default.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const jarvis = readFileSync(path.join(root, 'src', 'js', 'jarvis.js'), 'utf-8');
const settings = readFileSync(path.join(root, 'src', 'js', 'settings.js'), 'utf-8');
const ttsServer = readFileSync(path.join(root, 'server', 'tts-server.py'), 'utf-8');
const ttsService = readFileSync(path.join(root, 'src', 'js', 'services', 'ttsService.js'), 'utf-8');

let pass = 0, fail = 0;
const check = (n, c) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); };

// --- Emma is the voice ------------------------------------------------------
check('settings default to en-US-EmmaNeural',
    /neuralVoice:\s*'en-US-EmmaNeural'/.test(settings));
check('the TTS server defaults to en-US-EmmaNeural',
    /DEFAULT_VOICE\s*=\s*os\.environ\.get\(\s*"JARVIS_TTS_VOICE",\s*"en-US-EmmaNeural"\s*\)/.test(ttsServer));
check('the TTS client defaults to en-US-EmmaNeural',
    /voice:\s*opts\.voice\s*\|\|\s*'en-US-EmmaNeural'/.test(ttsService));
check('no other neural voice is hardcoded as a default',
    !/(?:voice|Voice)\s*[:=]\s*['"]en-US-(?!Emma)[A-Za-z]+Neural['"]/.test(jarvis));

// --- the system fallback is OFF by default ---------------------------------
check('systemVoiceFallback exists', /systemVoiceFallback/.test(settings));
check('systemVoiceFallback defaults to false',
    /systemVoiceFallback:\s*false/.test(settings));
check('settingsVersion was bumped so existing installs adopt it',
    /settingsVersion:\s*3/.test(settings));
check('the migration resets a stored system voice',
    /MIGRATED_KEYS[\s\S]{0,200}'voiceName'/.test(settings));

// --- nothing reaches the system synthesiser ungated ------------------------
{
    // Every call site, and the method each one sits in.
    const lines = jarvis.split('\n');
    const speakCalls = [];
    let currentMethod = null;

    for (const [i, line] of lines.entries()) {
        const method = line.match(/^\s{4}(?:async\s+)?(_?[A-Za-z][A-Za-z0-9_]*)\s*\(/);
        if (method) currentMethod = method[1];
        if (/\b(?:this\.)?(?:synthesis|speechSynthesis)\.speak\(/.test(line)) {
            speakCalls.push({ line: i + 1, method: currentMethod });
        }
    }

    check('found the system-synthesiser call sites', speakCalls.length > 0);

    // Both must live in a method that begins by consulting the gate.
    const gated = speakCalls.every(({ method }) => {
        if (!method) return false;
        const body = jarvis.split(new RegExp(`\\n\\s{4}(?:async\\s+)?${method}\\s*\\(`))[1];
        if (!body) return false;
        // The gate has to be near the top, not somewhere after speaking.
        return /_systemVoiceAllowed\(\)/.test(body.slice(0, 400));
    });
    check(`every system-voice call is behind _systemVoiceAllowed (${speakCalls.length} site(s): ${speakCalls.map(s => s.method).join(', ')})`,
        gated);
}

check('the gate returns false when the setting is off',
    /_systemVoiceAllowed\(\)\s*\{\s*if\s*\(!this\.settings\.get\('systemVoiceFallback'\)\)[\s\S]{0,600}?return false;/.test(jarvis));

// --- David can never be selected -------------------------------------------
{
    /* Exercise the real matcher rather than grepping for names.

       The first version scanned every string literal in the file, which
       matched "markets", "markers" and "polymarket" on the name Mark, and
       flagged two comments explaining why David must never be used. A
       substring search over prose cannot answer this question; running the
       function can. */
    const src = jarvis.match(/isFemaleVoice\(name\)\s*\{\s*return\s*(\/[\s\S]*?\/i)/);
    check('isFemaleVoice is a single regex that can be tested', Boolean(src));

    if (src) {
        const isFemale = new Function('re', 'n', 'return re.test(n)').bind(null,
            new RegExp(src[1].slice(1, -2), 'i'));

        const male = ['Microsoft David Desktop', 'Microsoft David', 'David',
            'Microsoft Mark', 'Microsoft George', 'Microsoft Ryan', 'Microsoft Guy',
            'Google UK English Male', 'Alex', 'Daniel', 'Fred'];
        const rejected = male.filter((n) => !isFemale(n));
        check(`every male voice is rejected (${rejected.length}/${male.length})`,
            rejected.length === male.length);

        // And it must still accept the ones the fallback list relies on,
        // or the gate would refuse every voice and go permanently silent.
        const female = ['Microsoft Zira Desktop', 'Microsoft Aria', 'Microsoft Emma',
            'Google UK English Female', 'Samantha'];
        const accepted = female.filter((n) => isFemale(n));
        check(`known female voices are still accepted (${accepted.length}/${female.length})`,
            accepted.length === female.length);
    }
}

check('the last-resort branch leaves the voice null rather than taking the system default',
    /this\.selectedVoice\s*=\s*null;/.test(jarvis)
    && !/selectedVoice\s*=\s*voices\.find\(v\s*=>\s*v\.default\)/.test(jarvis));

check('the gate refuses to speak when no acceptable voice was selected',
    /return Boolean\(this\.selectedVoice\)/.test(jarvis));

// The preferred list is only reachable behind the gate, but it must still
// never contain a male name.
{
    const block = jarvis.match(/const preferredVoices = \[([\s\S]*?)\]/);
    check('a preferred-voice list exists', Boolean(block));
    if (block) {
        check('the preferred list is female-only',
            !/\b(David|Mark|George|Ryan|Guy|Eric|Christopher|Roger|Steffan|Male)\b/i.test(block[1]));
    }
}

// --- the server does not offer male voices ---------------------------------
check('the TTS server lists female voices only',
    /v\["Gender"\]\s*==\s*"Female"/.test(ttsServer));

// --- going silent is reported, not hidden ----------------------------------
// Silence with no explanation would be its own bug — the user would think
// Jarvis had crashed.
check('an unavailable voice is surfaced to the user',
    /_warnedNoVoice/.test(jarvis) && /text-only/i.test(jarvis));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
