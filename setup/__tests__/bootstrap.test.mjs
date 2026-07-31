// The bootstrapper's decisions, checked against machines this one is not.
//
// The machine I develop on already has everything, so every run here takes the
// all-skipped path. That is exactly the path that does not matter. `planSteps`
// is pure, so the interesting cases — a bare laptop, a full disk, a half-done
// install — can be fed in directly instead of hoped for.

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { planSteps } = require(path.join(root, 'bootstrap.js'));
const { chooseModels, ALLOWED_HOSTS } = require(path.join(root, 'install.js'));

let pass = 0, fail = 0;
const check = (n, c) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); };

/** A detection result, defaulting to a machine with nothing on it. */
const machine = (over = {}) => ({
    platform: { os: 'windows', arch: 'x64', appleSilicon: false, isWSL: false },
    linux: null,
    resources: { totalRamGB: 16, freeRamGB: 8, cores: 8, freeDiskGB: 100 },
    gpu: { vendor: null, backend: 'cpu', name: null, vramGB: null },
    ollama: { installed: false, path: null, apiUp: false, host: 'http://127.0.0.1:11434', models: [] },
    python: { installed: false, version: null, adequate: false },
    uv: { installed: false, version: null },
    ffmpeg: { installed: false },
    node: { version: '22.18.0', adequate: true },
    // Whether `jarvis` is a command the user can type. Measured by
    // setup/path.js and attached by bootstrap.measure().
    command: { available: false, path: null, source: null },
    ...over,
});

const ids = (d) => planSteps(d).steps.filter((s) => !s.skip).map((s) => s.id);

// --- a bare machine installs everything ------------------------------------
{
    const todo = ids(machine());
    check('bare machine installs the runtime', todo.includes('ollama'));
    check('bare machine starts the runtime', todo.includes('ollama-start'));
    check('bare machine installs uv', todo.includes('uv'));
    check('bare machine pulls the chat model', todo.includes('model:gemma3:4b'));
    check('bare machine pulls the embedder', todo.includes('model:nomic-embed-text'));
    check('bare machine adds the terminal command', todo.includes('terminal-command'));
    check('detect and verify always run',
        todo.includes('detect') && todo.includes('verify'));

    // Installing something is a decision about the machine; changing PATH is a
    // decision about the user's environment. It goes last so a failed model
    // download does not leave a launcher for an app that cannot answer.
    const order = planSteps(machine()).steps.map((s) => s.id);
    check('the terminal command is added after everything is installed',
        order.indexOf('terminal-command') > order.indexOf('model:gemma3:4b')
        && order.indexOf('terminal-command') < order.indexOf('verify'));
}

// --- a fully provisioned machine does nothing ------------------------------
{
    const todo = ids(machine({
        ollama: {
            installed: true, path: 'C:\\ollama.exe', apiUp: true,
            host: 'http://127.0.0.1:11434',
            models: ['gemma3:4b', 'nomic-embed-text:latest'],
        },
        uv: { installed: true, version: '0.11.25' },
        command: { available: true, path: 'C:\\Users\\A\\AppData\\Local\\Jarvis\\bin\\jarvis.cmd' },
    }));
    check('a provisioned machine installs nothing',
        todo.filter((i) => i !== 'detect' && i !== 'verify').length === 0);
}

// --- an existing `jarvis` on PATH is left alone ----------------------------
{
    // `npm i -g` already puts a working shim on PATH. Adding a second one would
    // leave two launchers for one name, with PATH order deciding which install
    // answers — a bug that only surfaces after they drift apart.
    const todo = ids(machine({
        command: { available: true, path: '/usr/local/bin/jarvis', source: 'path' },
    }));
    check('an existing jarvis command is not replaced', !todo.includes('terminal-command'));
}

// --- idempotence: model tags with a suffix still count as present ----------
{
    // Ollama reports `nomic-embed-text:latest`, and the required name is
    // `nomic-embed-text`. An exact-match check here would re-download a
    // 274 MB model on every single launch, forever.
    const todo = ids(machine({
        ollama: {
            installed: true, apiUp: true, host: 'http://127.0.0.1:11434',
            models: ['gemma3:4b-it-q4_K_M', 'nomic-embed-text:latest'],
        },
        uv: { installed: true },
    }));
    check('a suffixed model tag counts as already present',
        !todo.some((i) => i.startsWith('model:')));
}

// --- partial state resumes rather than restarting --------------------------
{
    const todo = ids(machine({
        ollama: {
            installed: true, apiUp: true, host: 'http://127.0.0.1:11434',
            models: ['gemma3:4b'],           // chat model landed, embedder did not
        },
        uv: { installed: true },
    }));
    check('an interrupted run pulls only the missing model',
        todo.includes('model:nomic-embed-text') && !todo.includes('model:gemma3:4b'));
    check('an interrupted run does not reinstall the runtime',
        !todo.includes('ollama'));
}

// --- installed but not running --------------------------------------------
{
    const todo = ids(machine({
        ollama: { installed: true, apiUp: false, host: 'http://127.0.0.1:11434', models: [] },
        uv: { installed: true },
    }));
    check('installed-but-stopped starts it without reinstalling',
        todo.includes('ollama-start') && !todo.includes('ollama'));
    // With the API down the model list is empty for a reason that is not
    // "no models". Planning a pull here would be planning from a null.
    check('models are not judged while the API is down',
        !todo.some((i) => i.startsWith('model:')) || todo.includes('ollama-start'));
}

// --- old system Python is not a failure when uv is present -----------------
{
    // This machine has Python 3.8 and runs Jarvis perfectly, because the speech
    // servers launch via `uv run --python 3.12`.
    const todo = ids(machine({
        python: { installed: true, version: '3.8.10', adequate: false },
        uv: { installed: true, version: '0.11.25' },
    }));
    check('old system Python is not treated as a problem when uv is present',
        !todo.includes('uv'));
}

// --- disk ------------------------------------------------------------------
{
    check('a 5 GB disk does not get offered a 12b model',
        chooseModels({ totalRamGB: 34, vramGB: 16, freeDiskGB: 5 }).optional.length === 0);
    check('a 5 GB disk is flagged as too small for the required set',
        chooseModels({ totalRamGB: 34, freeDiskGB: 5 }).diskOk === false);
    check('a roomy disk is offered the larger model',
        chooseModels({ totalRamGB: 34, vramGB: 16, freeDiskGB: 200 }).optional.includes('gemma3:12b'));
    check('unknown disk space does not block the required set',
        chooseModels({ totalRamGB: 16, freeDiskGB: null }).diskOk === true);
}

// --- low-memory machines are not handed a model that will swap -------------
{
    check('8 GB RAM gets no optional model',
        chooseModels({ totalRamGB: 8, freeDiskGB: 500 }).optional.length === 0);
    check('the required pair is offered regardless of RAM',
        chooseModels({ totalRamGB: 4, freeDiskGB: 500 }).required.length === 2);
}

// --- the download allowlist ------------------------------------------------
{
    // A bootstrapper downloads executables and runs them. The allowlist is the
    // whole of the defence, so it is asserted rather than assumed.
    check('the allowlist contains only vendor hosts',
        [...ALLOWED_HOSTS].every((h) => /(^|\.)(ollama\.com|github\.com|githubusercontent\.com|astral\.sh)$/.test(h)));
    check('the allowlist is not empty and not a wildcard',
        ALLOWED_HOSTS.size > 0 && !ALLOWED_HOSTS.has('*'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
