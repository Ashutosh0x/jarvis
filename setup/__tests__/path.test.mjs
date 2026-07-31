// The `jarvis` command: everything that can be decided without touching the
// registry or a dotfile.
//
// This is the module that edits a user's PATH, so the parts that can be tested
// are tested hard. PATH arithmetic is where the damage happens — a wrong
// "already there?" answer appends a duplicate on every launch, and a wrong join
// drops entries the user needs. Both are silent until something else breaks.
//
// The platform is passed in rather than read from process.platform, so the
// Windows rules are checked on Linux CI and the POSIX rules on this Windows
// machine. A test that only runs on the author's OS protects one machine.

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const P = require(path.join(root, 'path.js'));

let pass = 0, fail = 0;
const check = (n, c) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); };

// --- comparing entries ------------------------------------------------------
{
    // Windows PATH is case-insensitive and tolerates a trailing separator.
    // Treating those as different entries is how a tool appends its own
    // directory on every single launch until PATH hits the 32k ceiling.
    check('windows entries differing only in case are the same',
        P.samePathEntry('C:\\Users\\A\\AppData\\Local\\Jarvis\\bin',
            'c:\\users\\a\\appdata\\local\\jarvis\\bin', 'windows'));
    check('a trailing backslash does not make a new entry',
        P.samePathEntry('C:\\Jarvis\\bin\\', 'C:\\Jarvis\\bin', 'windows'));
    check('windows accepts either slash',
        P.samePathEntry('C:/Jarvis/bin', 'C:\\Jarvis\\bin', 'windows'));

    // POSIX is case-SENSITIVE, and two directories that differ only in case are
    // two directories. Applying the Windows rule here would silently skip a
    // real entry.
    check('posix entries differing in case are different',
        !P.samePathEntry('/home/a/.local/bin', '/home/a/.Local/bin', 'linux'));
    check('a trailing slash still does not make a new entry on posix',
        P.samePathEntry('/home/a/.local/bin/', '/home/a/.local/bin', 'linux'));
}

// --- membership -------------------------------------------------------------
{
    const win = 'C:\\Windows;C:\\Windows\\system32;C:\\Users\\A\\AppData\\Local\\Jarvis\\bin';
    check('an existing windows entry is found',
        P.pathContains(win, 'C:\\Users\\A\\AppData\\Local\\Jarvis\\BIN\\', 'windows'));
    check('an absent windows entry is not found',
        !P.pathContains(win, 'C:\\Other\\bin', 'windows'));

    // The substring trap: "/opt/jarvis" appears inside "/opt/jarvis-old" but is
    // not on this PATH. A naive includes() would report it as present and the
    // command would never be installed.
    check('a prefix of another entry is not a match',
        !P.pathContains('/usr/bin:/opt/jarvis-old/bin', '/opt/jarvis/bin', 'linux'));

    check('an empty PATH contains nothing', !P.pathContains('', '/x', 'linux'));
    check('an undefined PATH does not throw', P.pathContains(undefined, '/x', 'linux') === false);
}

// --- appending --------------------------------------------------------------
{
    const before = 'C:\\Windows;C:\\Windows\\system32';
    const after = P.pathWith(before, 'C:\\Jarvis\\bin', 'windows');
    check('appending reports the change', after.changed === true);
    check('appending keeps every original entry',
        after.value.startsWith(before) && after.value.endsWith(';C:\\Jarvis\\bin'));

    // APPENDED, never prepended: this directory must not shadow a `jarvis` the
    // user installed deliberately somewhere else.
    check('the new entry goes last',
        P.splitPath(after.value, 'windows').pop() === 'C:\\Jarvis\\bin');

    const again = P.pathWith(after.value, 'C:\\Jarvis\\bin\\', 'windows');
    check('appending twice changes nothing', again.changed === false
        && again.value === after.value);

    // A PATH ending in a separator is common and legal. Naive concatenation
    // produces `...;;C:\Jarvis\bin`, an empty entry that some tools read as the
    // current directory — a real security footgun.
    const trailing = P.pathWith('C:\\Windows;', 'C:\\Jarvis\\bin', 'windows');
    check('a trailing separator does not produce an empty entry',
        !trailing.value.includes(';;'));

    check('appending to an empty PATH yields just the directory',
        P.pathWith('', '/home/a/.local/bin', 'linux').value === '/home/a/.local/bin');
}

// --- removing ---------------------------------------------------------------
{
    const before = 'C:\\Windows;C:\\Jarvis\\bin;C:\\Windows\\system32';
    const after = P.pathWithout(before, 'C:\\jarvis\\bin', 'windows');
    check('removal reports the change', after.changed === true);
    check('removal takes out only the one entry',
        after.value === 'C:\\Windows;C:\\Windows\\system32');
    check('removing something absent changes nothing',
        P.pathWithout(before, 'C:\\Nope', 'windows').changed === false);
}

// --- the launcher script ----------------------------------------------------
{
    const cmd = P.shimContents({
        platform: 'windows',
        cmd: 'C:\\Program Files\\nodejs\\node.exe',
        args: ['C:\\Users\\A\\jarvis\\bin\\jarvis.mjs'],
    });
    check('the windows shim quotes paths containing spaces',
        cmd.includes('"C:\\Program Files\\nodejs\\node.exe"'));
    check('the windows shim forwards arguments', cmd.includes('%*'));
    check('the windows shim uses CRLF', cmd.includes('\r\n'));
    check('the windows shim does not echo itself', cmd.startsWith('@echo off'));
    /* cmd.exe reads a .cmd in the console's OEM codepage, not UTF-8. An em dash
       in a comment came out as mojibake in the file the user is told they can
       open and delete — observed, then fixed by keeping the shim ASCII. */
    check('the windows shim is pure ASCII', !/[^\x00-\x7F]/.test(cmd));

    // `start "path"` consumes a quoted first argument as the WINDOW TITLE and
    // launches nothing. The empty title is load-bearing.
    const detached = P.shimContents({
        platform: 'windows', cmd: 'C:\\Program Files\\Jarvis\\Jarvis.exe', args: [], detach: true,
    });
    check('a detached windows shim passes the empty window title',
        /start "" "C:\\Program Files\\Jarvis\\Jarvis\.exe"/.test(detached));
    check('the non-detached shim does not use start', !cmd.includes('start ""'));

    const sh = P.shimContents({
        platform: 'linux', cmd: '/usr/bin/node', args: ['/opt/jarvis/bin/jarvis.mjs'],
    });
    check('the posix shim has a shebang', sh.startsWith('#!/bin/sh'));
    // exec, so Ctrl-C reaches Jarvis and the exit code is Jarvis's, not a
    // wrapper shell's.
    check('the posix shim execs rather than spawning', sh.includes('exec "'));
    check('the posix shim forwards arguments', sh.includes('"$@"'));
    check('the posix shim uses LF only', !sh.includes('\r'));
}

// --- what the shim points at ------------------------------------------------
{
    const cli = P.resolveLauncher({
        root: '/opt/jarvis', execPath: '/usr/bin/node', platform: 'linux',
    });
    check('an npm/clone install runs the CLI entry point',
        cli.kind === 'cli' && cli.args[0] === path.join('/opt/jarvis', 'bin', 'jarvis.mjs'));
    check('an npm/clone install uses the running node binary', cli.cmd === '/usr/bin/node');

    // Inside Electron, process.execPath is the Electron binary. Writing that
    // into the shim would produce `electron jarvis.mjs`, which does nothing.
    const fromElectron = P.resolveLauncher({
        root: '/opt/jarvis', execPath: '/opt/jarvis/electron', platform: 'linux',
    });
    check('a non-node execPath falls back to node on PATH', fromElectron.cmd === 'node');

    const packaged = P.resolveLauncher({
        root: 'C:\\Program Files\\Jarvis\\resources\\app.asar',
        packagedExe: 'C:\\Program Files\\Jarvis\\Jarvis.exe',
        platform: 'windows',
    });
    check('a packaged install runs the executable',
        packaged.kind === 'app' && packaged.cmd.endsWith('Jarvis.exe') && packaged.args.length === 0);
    // A GUI binary run from cmd.exe holds the terminal until the window closes.
    check('a packaged windows install detaches', packaged.detach === true);
    check('a packaged mac install does not use start',
        P.resolveLauncher({ root: '/x', packagedExe: '/Applications/Jarvis.app/Contents/MacOS/Jarvis', platform: 'macos' }).detach === false);
}

// --- shell rc blocks --------------------------------------------------------
{
    const dir = '/home/a/.local/bin';
    const block = P.rcBlock(dir);
    check('the rc block is marked so it can be found again', P.rcHasBlock(block));
    // Sourced by dash on Debian's /bin/sh, where [[ ]] and arrays are errors.
    check('the rc block is POSIX sh', !/\[\[|\bfunction\b|\barray\b/.test(block));
    // An rc file sourced twice must not double the entry.
    check('the rc block guards against adding the directory twice',
        block.includes('case ":$PATH:" in') && block.includes(`*":${dir}:"*`));
    check('the rc block appends rather than prepends',
        block.includes(`PATH="$PATH:${dir}"`));

    const rc = `export EDITOR=vim\n${block}alias ll='ls -la'\n`;
    const stripped = P.rcWithoutBlock(rc);
    check('removing the block leaves the rest of the file intact',
        stripped.includes('export EDITOR=vim') && stripped.includes("alias ll='ls -la'"));
    check('removing the block removes all of it',
        !P.rcHasBlock(stripped) && !stripped.includes('case ":$PATH:" in'));
    check('removing from a file without a block changes nothing',
        P.rcWithoutBlock('export EDITOR=vim\n') === 'export EDITOR=vim\n');
}

// --- what counts as an existing command -------------------------------------
{
    // node_modules/.bin is on PATH only inside `npm run`. Treating a hit there
    // as "already available" would report success for a command that does not
    // exist in the user's actual terminal — which is the whole feature.
    check('a node_modules/.bin hit is not a real command',
        P.isLocalBinShim('/repo/node_modules/.bin/jarvis'));
    check('a node_modules/.bin hit is recognised on windows too',
        P.isLocalBinShim('C:\\repo\\node_modules\\.bin\\jarvis.cmd'));
    check('a global npm shim IS a real command',
        !P.isLocalBinShim('C:\\Users\\A\\AppData\\Roaming\\npm\\jarvis.cmd'));
    check('our own launcher is not mistaken for a local shim',
        !P.isLocalBinShim('C:\\Users\\A\\AppData\\Local\\Jarvis\\bin\\jarvis.cmd'));
}

// --- where things go --------------------------------------------------------
{
    /* Expectations are built with path.join rather than written as literals:
       this runs on Linux CI too, where join uses '/' and a hardcoded backslash
       string would fail for a reason that has nothing to do with the code. */
    const winDir = P.commandDir('windows', { LOCALAPPDATA: 'C:\\Users\\A\\AppData\\Local' }, 'C:\\Users\\A');
    check('windows uses LOCALAPPDATA',
        winDir === path.join('C:\\Users\\A\\AppData\\Local', 'Jarvis', 'bin'));
    check('windows falls back when LOCALAPPDATA is unset',
        P.commandDir('windows', {}, path.join('C:', 'Users', 'A'))
            .endsWith(path.join('AppData', 'Local', 'Jarvis', 'bin')));
    check('posix uses ~/.local/bin',
        P.commandDir('linux', {}, '/home/a') === path.join('/home/a', '.local', 'bin'));
    check('the launcher is named for the platform',
        P.commandName('windows') === 'jarvis.cmd' && P.commandName('macos') === 'jarvis');
}

// --- the registry script, read as text --------------------------------------
//
// The write itself cannot be exercised here — a test that edits the developer's
// real PATH is not a test. What CAN be asserted is that the script says the
// things that make it safe, because every one of these was a deliberate choice
// with a failure behind it.
{
    const src = require('node:fs').readFileSync(path.join(root, 'path.js'), 'utf-8');
    /* Comments stripped, or the file's own explanation of why it avoids setx
       would fail the check that it avoids setx. */
    const code = src.split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*|#)/.test(l))
        .join('\n');

    // setx truncates PATH at 1024 characters and rewrites REG_EXPAND_SZ as
    // REG_SZ. It is the single most common way a tool destroys a PATH.
    check('setx is never used', !/\bsetx\b/i.test(code));
    // HKCU only: no elevation, no machine-wide change.
    check('only the current user hive is written',
        src.includes('Registry]::CurrentUser') && !/LocalMachine/.test(src));
    check('the original value kind is preserved', src.includes('GetValueKind'));
    check('the value is read unexpanded',
        src.includes('DoNotExpandEnvironmentNames'));
    check('the previous PATH is backed up before writing',
        src.includes('JARVIS_PATH_BACKUP'));
    check('the write is read back rather than trusted',
        src.includes('ERROR:not-persisted'));
    // The directory arrives through the environment. Interpolating it into the
    // script text would make a path containing a quote into script — in a
    // script that writes to the registry.
    check('the directory is passed as an environment variable, not interpolated',
        src.includes('$env:JARVIS_PATH_DIR'));
    check('new shells are told about the change',
        src.includes('SendMessageTimeout') && src.includes("'Environment'"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
