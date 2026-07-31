// ---------------------------------------------------------------------------
// First run: get a bare machine to a working Jarvis without asking anything.
//
// This sequences detect.js -> install.js and reports progress while it does it.
// The design constraints, all of which come from real failures:
//
//   * IDEMPOTENT. Running it twice must be safe and near-instant the second
//     time. Every step asks "is this already done?" before doing anything.
//   * RESUMABLE. A step that fails does not roll back the ones before it, and
//     re-running continues from where it stopped.
//   * HONEST. A step that could not complete is reported as incomplete, with
//     the reason and the manual command. It is never marked done because the
//     installer exited 0 — completion is confirmed by re-detecting.
//   * NON-BLOCKING. Nothing here is allowed to be a hard gate. Jarvis runs
//     without Ollama; it just answers from fewer places. A bootstrapper that
//     refuses to launch the app is worse than the missing dependency.
//
// Windows is the platform this was developed and verified on end to end. The
// macOS and Linux steps are written from each vendor's documented method and
// are marked `verified: false` — the summary says so rather than implying they
// were tested here.
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const detect = require('./detect.js');
const install = require('./install.js');
const pathSetup = require('./path.js');

/** Where the app itself lives — the directory above this one. */
const INSTALL_ROOT = path.join(__dirname, '..');

/**
 * Detection, plus the one thing detect.js cannot answer without knowing where
 * Jarvis is installed: whether `jarvis` is a command the user can type.
 *
 * Kept here rather than inside detect.js so that module stays a pure "what is
 * on this machine" probe with no dependency on the setup it feeds.
 */
async function measure() {
    const d = await detect.detectAll();
    try {
        d.command = await pathSetup.commandAvailable();
    } catch {
        // A probe that cannot answer says so. Treated as "not available", which
        // means the step runs — and the step is idempotent.
        d.command = { available: false, path: null, source: null };
    }
    return d;
}

/** Where the "we already did this" record lives. */
function stateDir() {
    const home = os.homedir();
    if (process.platform === 'win32') {
        return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'jarvis');
    }
    if (process.platform === 'darwin') {
        return path.join(home, 'Library', 'Application Support', 'jarvis');
    }
    return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'jarvis');
}

const STATE_FILE = () => path.join(stateDir(), 'setup-state.json');

async function readState() {
    try {
        return JSON.parse(await fsp.readFile(STATE_FILE(), 'utf-8'));
    } catch {
        return null;
    }
}

async function writeState(state) {
    await fsp.mkdir(stateDir(), { recursive: true });
    await fsp.writeFile(STATE_FILE(), JSON.stringify(state, null, 2), 'utf-8');
}

/**
 * Has setup completed for this version, on a machine that still has what it
 * installed?
 *
 * The state file alone is not enough — someone can uninstall Ollama after a
 * successful run. So the record is treated as a hint and the machine is
 * re-measured. The alternative, trusting the file, produces the worst failure
 * mode there is: an app that says it is ready and then cannot speak.
 */
async function needsBootstrap({ version } = {}) {
    const state = await readState();
    const current = await measure();

    const missing = [];
    if (!current.ollama.installed) missing.push('ollama');
    if (!current.uv.installed && !current.python.adequate) missing.push('python-runtime');
    // Someone who installed Jarvis and typed `jarvis` should get Jarvis. This
    // is a missing piece of the install, not a preference.
    if (!current.command?.available) missing.push('terminal-command');

    // Only claim a model is missing when Ollama could actually be asked. With
    // the API down the list is empty for a reason that is not "no models".
    //
    // Same predicate as the planner and the puller — this was a third,
    // independently written copy (an anchored regex), and three checks that can
    // disagree about "is this installed" is three chances to loop forever or to
    // skip something absent.
    if (current.ollama.apiUp) {
        for (const model of install.REQUIRED_MODELS) {
            if (!install.hasModel(current.ollama.models, model)) missing.push(`model:${model}`);
        }
    }

    return {
        needed: missing.length > 0 || !state || (version && state.version !== version),
        missing,
        firstRun: !state,
        state,
        detected: current,
    };
}

// ── the steps ───────────────────────────────────────────────────────────────

/**
 * Build the plan for THIS machine.
 *
 * Steps are decided from measurements, not from a fixed script — a machine
 * that already has Ollama should not see "Installing Ollama" scroll past and
 * be left wondering what was just done to it.
 */
function planSteps(d) {
    const models = install.chooseModels({
        totalRamGB: d.resources.totalRamGB,
        vramGB: d.gpu.vramGB,
        freeDiskGB: d.resources.freeDiskGB,
    });

    const steps = [];

    steps.push({ id: 'detect', label: 'Detecting your system', skip: false });

    steps.push({
        id: 'ollama',
        label: 'Installing the local model runtime',
        skip: d.ollama.installed,
        skipLabel: 'Local model runtime already installed',
    });

    steps.push({
        id: 'ollama-start',
        label: 'Starting the local model runtime',
        skip: d.ollama.apiUp,
        skipLabel: 'Local model runtime already running',
    });

    // uv manages the Python the speech servers run on, so system Python being
    // old is not a problem as long as uv is there. Only when BOTH are missing
    // does speech actually need something installed.
    steps.push({
        id: 'uv',
        label: 'Installing the speech engine runtime',
        skip: d.uv.installed,
        skipLabel: 'Speech engine runtime already installed',
    });

    /* With the API down the model list is empty for a reason that is not "no
       models", so the step has to be planned — but it is a CHECK that may turn
       into a download, not a download. Saying "Downloading the AI model" while
       the machine already has it, on the most common path there is (Ollama
       installed, simply not running yet), describes work that is not happening. */
    const canSeeModels = Boolean(d.ollama.apiUp);
    for (const model of models.required) {
        steps.push({
            id: `model:${model}`,
            label: canSeeModels
                ? `Downloading the AI model (${model})`
                : `Checking the AI model (${model})`,
            // install.hasModel, not a local startsWith: a prefix of a name is a
            // different model, and skipping on one hides a genuinely absent
            // dependency. See modelMatches for the two bugs this replaced.
            skip: canSeeModels && install.hasModel(d.ollama.models, model),
            skipLabel: `AI model already present (${model})`,
            model,
        });
    }

    /* The `jarvis` command. Last of the install steps because it is the only
       one that changes the user's environment rather than adding a file, and
       because a launcher is worth having only once there is something to
       launch. Skipped outright when a `jarvis` already answers on PATH. */
    steps.push({
        id: 'terminal-command',
        label: 'Adding the `jarvis` command to your terminal',
        skip: Boolean(d.command && d.command.available),
        skipLabel: '`jarvis` already works in your terminal',
    });

    steps.push({ id: 'verify', label: 'Verifying everything works', skip: false });

    return { steps, models };
}

/**
 * Run the bootstrap.
 *
 * @param {object} opts
 * @param {(e:object) => void} [opts.onEvent] receives {type, ...}. Types:
 *   'begin'   {steps, totalWork, message}
 *   'step'    {id, label, index, total, status:'running'|'done'|'skipped'|'failed'|'manual', detail}
 *   'progress'{id, pct, detail}
 *   'note'    {text}
 *   'done'    {ok, summary}
 * @param {boolean} [opts.dryRun] plan and report, install nothing.
 */
async function bootstrap({ onEvent = () => {}, dryRun = false, version, packagedExe = null } = {}) {
    const emit = (type, payload = {}) => { try { onEvent({ type, ...payload }); } catch {} };

    const detected = await measure();
    const { steps, models } = planSteps(detected);

    /* Work that will actually take time. `detect` and `verify` always run, so
       counting every unskipped step told a fully-provisioned machine it was
       about to install things and offered it a coffee for a 900ms check. Only
       downloads and installers count. */
    const work = steps.filter((s) => !s.skip && s.id !== 'detect' && s.id !== 'verify');
    const willDownloadModel = work.some((s) => s.id.startsWith('model:'));

    emit('begin', {
        steps,
        totalWork: work.length,
        // The line the user asked for, and it earns its place: pulling a 3.3 GB
        // model over a domestic connection is genuinely minutes long, and a
        // silent progress bar during that reads as a hang.
        message: work.length > 0
            ? 'I am installing packages and system requirements — have a cup of coffee.'
            : 'Checking your system.',
        estimatedGB: models.estimatedGB,
        platform: detected.platform,
    });

    // A disk that cannot hold the model is worth saying BEFORE a ten-minute
    // download fills it and fails — but only when a download is actually
    // pending. Warning about disk space for a model already on that disk is
    // noise that teaches people to ignore the warning that matters.
    if (models.diskOk === false && willDownloadModel) {
        emit('note', {
            level: 'warn',
            text: `Only ${models.freeDiskGB} GB free, and the AI model needs about `
                + `${models.estimatedGB} GB. Free some space, then run \`jarvis repair\`.`,
        });
    }

    const results = {};
    let index = 0;

    for (const step of steps) {
        index += 1;
        const base = { id: step.id, label: step.label, index, total: steps.length };

        if (step.skip) {
            emit('step', { ...base, label: step.skipLabel || step.label, status: 'skipped' });
            results[step.id] = { status: 'present' };
            continue;
        }

        emit('step', { ...base, status: 'running' });

        if (dryRun) {
            emit('step', { ...base, status: 'done', detail: 'dry run' });
            results[step.id] = { status: 'dry-run' };
            continue;
        }

        try {
            const outcome = await runStep(step, {
                detected,
                packagedExe,
                onProgress: (pct, detail) => emit('progress', { id: step.id, pct, detail }),
                onLine: (text) => emit('note', { level: 'debug', text }),
            });
            results[step.id] = outcome;
            emit('step', { ...base, ...describeOutcome(step, outcome) });
            // Something the user has to do themselves for the step to take
            // effect — said at the moment it becomes true, not buried in a
            // summary line at the end.
            if (outcome.note) emit('note', { level: 'warn', text: outcome.note });
        } catch (e) {
            // A failed step is recorded and the run CONTINUES. Model downloads
            // are independent of each other, and one failure should not cost
            // the user everything that would have succeeded after it.
            results[step.id] = { status: 'failed', detail: e.message };
            emit('step', { ...base, status: 'failed', detail: e.message });
        }
    }

    const failed = Object.entries(results).filter(([, r]) => r.status === 'failed');
    const manual = Object.entries(results).filter(([, r]) => r.status === 'manual');

    const summary = {
        ok: failed.length === 0 && manual.length === 0,
        results,
        failed: failed.map(([id, r]) => ({ id, detail: r.detail })),
        manual: manual.map(([id, r]) => ({ id, detail: r.detail })),
        platform: detected.platform,
        // Said plainly rather than implied: these paths were not run here.
        platformVerified: detected.platform.os === 'windows',
    };

    if (!dryRun) {
        await writeState({
            version: version || null,
            completedAt: new Date().toISOString(),
            platform: detected.platform,
            results,
        });
    }

    emit('done', { ok: summary.ok, summary });
    return summary;
}

/**
 * How a finished step should be shown.
 *
 * PURE, and separate from the loop because it encodes a rule worth testing: a
 * step can only be PLANNED from what was measurable before it ran. With
 * Ollama's API down at detection time the model list is empty for a reason
 * that is not "no models", so both model steps get planned — and then find the
 * model already on disk.
 *
 * Reporting that as "Downloading the AI model ✓" claims a download that never
 * happened, which is the same class of untruth as trusting an installer's exit
 * code. A step that found its work already done says so, borrowing the label
 * the planner would have used had it been able to see.
 *
 * @param {{label:string, skipLabel?:string}} step
 * @param {{status:string, detail?:string}} outcome
 */
function describeOutcome(step, outcome) {
    // 'present' — nothing to do. 'running' — startOllama found it already up.
    const alreadyDone = outcome.status === 'present' || outcome.status === 'running';
    return {
        label: alreadyDone ? (step.skipLabel || step.label) : step.label,
        status: outcome.status === 'manual' ? 'manual'
            : alreadyDone ? 'skipped'
            : 'done',
        detail: outcome.detail,
    };
}

async function runStep(step, { detected, onProgress, onLine, packagedExe = null }) {
    if (step.id === 'detect') {
        return { status: 'done', detail: `${detected.platform.os} ${detected.platform.arch}` };
    }

    if (step.id === 'ollama') {
        return install.installOllama({ onLine, onProgress: (pct) => onProgress(pct, 'downloading') });
    }

    if (step.id === 'ollama-start') {
        return install.startOllama({ onLine });
    }

    if (step.id === 'uv') {
        return install.installUv({ onLine });
    }

    if (step.id.startsWith('model:')) {
        return install.pullModel(step.model, {
            host: detected.ollama.host,
            onProgress: (pct, detail) => onProgress(pct, detail),
            onLine,
        });
    }

    if (step.id === 'terminal-command') {
        const res = await pathSetup.ensureCommand({
            root: INSTALL_ROOT,
            packagedExe,
            onLine,
        });
        return {
            ...res,
            // The current shell inherited its environment before the entry
            // existed and cannot be updated from outside. Saying so is the
            // difference between "it did not work" and "open a new terminal".
            note: res.needsNewShell && (res.status === 'installed')
                ? 'Type `jarvis` in a NEW terminal — this one inherited its PATH before the change.'
                : undefined,
        };
    }

    if (step.id === 'verify') {
        // Re-measure. This is the only step whose answer is not taken from
        // whatever the installers reported about themselves.
        const after = await measure();
        const problems = [];
        if (!after.ollama.installed) problems.push('the local model runtime is still missing');
        else if (!after.ollama.apiUp) problems.push('the local model runtime is installed but not answering');
        else {
            const models = after.ollama.models || [];
            if (!models.some((m) => m.startsWith('gemma3:4b'))) problems.push('the chat model did not download');
            if (!models.some((m) => m.startsWith('nomic-embed-text'))) problems.push('the embedding model did not download');
        }
        if (!after.uv.installed && !after.python.adequate) {
            problems.push('no Python 3.10+ and no uv — speech will be unavailable');
        }
        /* Checked against the PERSISTED PATH, not this process's environment.
           A shell cannot be handed a new PATH after it starts, so asking
           `where jarvis` here would report failure for a change that worked. */
        if (!after.command?.available) {
            problems.push('the `jarvis` command is not on PATH — run `jarvis link`');
        }

        return problems.length
            ? { status: 'manual', detail: problems.join('; ') }
            : { status: 'done', detail: 'all components responding' };
    }

    return { status: 'done' };
}

module.exports = {
    needsBootstrap, bootstrap, planSteps, measure, describeOutcome,
    stateDir, readState, writeState, STATE_FILE, INSTALL_ROOT,
};
