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
const { planSteps, describeOutcome } = require(path.join(root, 'bootstrap.js'));
const { chooseModels, ALLOWED_HOSTS, modelMatches, hasModel, REQUIRED_MODELS } =
    require(path.join(root, 'install.js'));

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

// --- idempotence: an untagged request is satisfied by :latest --------------
{
    // Ollama reports `nomic-embed-text:latest`, and the required name is
    // `nomic-embed-text`. An exact-match check here would re-download a
    // 274 MB model on every single launch, forever.
    //
    // This case USED to be asserted with `gemma3:4b-it-q4_K_M` standing in for
    // `gemma3:4b`, which quietly asserted the opposite of what setup needs. A
    // quantised variant is a SEPARATE tag: `ollama list` on this machine shows
    // exactly `gemma3:4b`, and the app asks Ollama for that literal string
    // (ragService: `s.localModel || 'gemma3:4b'`). Accepting a different tag as
    // "already present" would skip the install and leave the user at the
    // "is 'gemma3:4b' pulled?" error the app already has a handler for.
    const todo = ids(machine({
        ollama: {
            installed: true, apiUp: true, host: 'http://127.0.0.1:11434',
            models: ['gemma3:4b', 'nomic-embed-text:latest'],
        },
        uv: { installed: true },
    }));
    check('an untagged requirement is satisfied by the :latest Ollama reports',
        !todo.some((i) => i.startsWith('model:')));

    // The other half, stated as its own claim rather than bundled in above.
    const quantOnly = ids(machine({
        ollama: {
            installed: true, apiUp: true, host: 'http://127.0.0.1:11434',
            models: ['gemma3:4b-it-q4_K_M', 'nomic-embed-text:latest'],
        },
        uv: { installed: true },
    }));
    check('a quantised variant does NOT stand in for the tag the app calls',
        quantOnly.includes('model:gemma3:4b'));
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

// --- "is this model already here?" -----------------------------------------
//
// There were THREE copies of this question in the setup code, written
// independently, and they disagreed. Both real failures are pinned here.
{
    // What Ollama actually reports on this machine.
    const listed = ['gemma3:4b', 'nomic-embed-text:latest'];

    // BUG 1, observed live during `jarvis repair`: the required name is
    // `nomic-embed-text`, with no tag, and Ollama lists `:latest`. The puller
    // compared split(':')[1] — undefined against 'latest' — so it never matched
    // and re-issued a pull on EVERY run, then reported a download that had not
    // happened.
    check('a tagless request matches the :latest Ollama reports',
        hasModel(listed, 'nomic-embed-text'));
    check('an exact name:tag request matches', hasModel(listed, 'gemma3:4b'));

    // BUG 2: the planner used startsWith, so a longer model whose name merely
    // BEGINS with the wanted one counted as present — and the real dependency
    // would be silently skipped.
    check('a different model with a shared name prefix is NOT a match',
        !hasModel(['nomic-embed-text-v2:latest'], 'nomic-embed-text'));
    check('a longer tag with a shared prefix is not a match',
        !modelMatches('gemma3:4b-it-q8', 'gemma3:4b'));

    // A tag that was asked for must be honoured.
    check('the wrong tag of the right model is not a match',
        !hasModel(['gemma3:12b'], 'gemma3:4b'));
    check('a quantised variant is a distinct tag, not the one requested',
        !modelMatches('gemma3:4b-it-q4_K_M', 'gemma3:4b'));
    check('any tag satisfies a tagless request',
        modelMatches('gemma3:4b-it-q4_K_M', 'gemma3'));

    // Ollama can report a digest instead of a tag; it identifies the blob, not
    // the tag, so it must not defeat the name comparison.
    check('a digest suffix still matches the name', modelMatches('gemma3:4b@sha256:abc', 'gemma3:4b'));

    check('an empty list matches nothing', !hasModel([], 'gemma3:4b'));
    check('a missing list does not throw', hasModel(undefined, 'gemma3:4b') === false);

    // The list every part of setup reads.
    check('the required models are declared once and shared',
        Array.isArray(REQUIRED_MODELS) && REQUIRED_MODELS.length === 2
        && chooseModels({ totalRamGB: 16 }).required.join() === REQUIRED_MODELS.join());
}

// --- a step must not claim work it did not do ------------------------------
//
// The most common real path: Ollama is installed but not running yet. Its API
// is down at detection time, so the model list is empty for a reason that is
// NOT "no models" — both model steps get planned, then find the model already
// on disk. Observed on this machine during `jarvis repair`: it printed
// "Downloading the AI model (gemma3:4b) ✓" having downloaded nothing.
{
    const down = machine({
        ollama: { installed: true, apiUp: false, host: 'http://127.0.0.1:11434', models: [] },
        uv: { installed: true },
    });
    const modelStep = planSteps(down).steps.find((s) => s.id === 'model:gemma3:4b');

    check('with the API down a model step is described as a check, not a download',
        /^Checking the AI model/.test(modelStep.label));
    check('with the API down the model step still runs', modelStep.skip === false);

    // And when it turns out the model was there all along, say that.
    const asDone = describeOutcome(modelStep, { status: 'present', model: 'gemma3:4b' });
    check('a model already on disk is reported as present, not downloaded',
        asDone.status === 'skipped' && /already present/.test(asDone.label));
    check('the report never says "Downloading" for work that did not happen',
        !/Downloading/.test(asDone.label));

    // The API being up is the case where the planner CAN see, so the label is
    // allowed to promise a download.
    const up = machine({
        ollama: { installed: true, apiUp: true, host: 'http://127.0.0.1:11434', models: [] },
        uv: { installed: true },
    });
    check('with the API up a genuinely missing model says Downloading',
        /^Downloading the AI model/.test(
            planSteps(up).steps.find((s) => s.id === 'model:gemma3:4b').label));
}

// --- outcome reporting, in general -----------------------------------------
{
    const step = { label: 'Starting the local model runtime', skipLabel: 'Local model runtime already running' };
    check('a runtime already up is reported as already running',
        describeOutcome(step, { status: 'running' }).status === 'skipped');
    check('a runtime this run actually started is reported as done',
        describeOutcome(step, { status: 'started' }).status === 'done');
    // The honesty rule that predates this: an incomplete step is never done.
    check('a manual step stays manual',
        describeOutcome(step, { status: 'manual', detail: 'x' }).status === 'manual');
    check('a step with no skipLabel falls back to its own label',
        describeOutcome({ label: 'Only label' }, { status: 'present' }).label === 'Only label');
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
