// ---------------------------------------------------------------------------
// Turning bootstrap events into something a person can read in a terminal.
//
// Kept separate from bootstrap.js because the same event stream also drives the
// in-app first-run window. The orchestrator should not know whether it is
// talking to a TTY, a log file or a renderer process.
// ---------------------------------------------------------------------------

const TICK = '✓';   // ✓
const DOT = '·';    // ·
const CROSS = '✗';  // ✗
const WARN = '!';

/** Only animate when someone is actually watching. */
function isInteractive(stream = process.stdout) {
    return Boolean(stream.isTTY) && !process.env.CI && !process.env.JARVIS_PLAIN;
}

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * @param {object} [opts]
 * @param {NodeJS.WriteStream} [opts.stream]
 * @param {boolean} [opts.verbose] show the underlying installer output
 */
function createReporter({ stream = process.stdout, verbose = false } = {}) {
    const tty = isInteractive(stream);
    let spinner = null;
    let frame = 0;
    let current = null;      // { label, pct, detail }
    let startedAt = 0;

    const write = (s) => stream.write(s);
    const clearLine = () => { if (tty) write('\r\x1b[2K'); };

    const dim = (s) => (tty ? `\x1b[2m${s}\x1b[0m` : s);
    const bold = (s) => (tty ? `\x1b[1m${s}\x1b[0m` : s);
    const green = (s) => (tty ? `\x1b[32m${s}\x1b[0m` : s);
    const red = (s) => (tty ? `\x1b[31m${s}\x1b[0m` : s);
    const yellow = (s) => (tty ? `\x1b[33m${s}\x1b[0m` : s);

    function paint() {
        if (!tty || !current) return;
        clearLine();
        const spin = FRAMES[frame % FRAMES.length];
        frame += 1;
        const pct = Number.isFinite(current.pct) && current.pct !== null
            ? dim(` ${String(current.pct).padStart(3)}%`)
            : '';
        const detail = current.detail ? dim(`  ${current.detail}`) : '';
        write(`  ${spin} ${current.label}${pct}${detail}`);
    }

    function startSpinner() {
        if (!tty || spinner) return;
        spinner = setInterval(paint, 90);
        // Do not hold the process open just to animate.
        if (spinner.unref) spinner.unref();
    }

    function stopSpinner() {
        if (spinner) { clearInterval(spinner); spinner = null; }
        clearLine();
    }

    function elapsed() {
        if (!startedAt) return '';
        const s = Math.round((Date.now() - startedAt) / 1000);
        if (s < 1) return '';
        return dim(s >= 60 ? ` ${Math.floor(s / 60)}m ${s % 60}s` : ` ${s}s`);
    }

    return {
        onEvent(e) {
            switch (e.type) {
                case 'begin': {
                    write(`\n  ${bold('Preparing JARVIS...')}\n\n`);
                    if (e.totalWork > 1) {
                        // The message the whole exercise is for. It is only
                        // shown when there is genuinely something to wait for.
                        write(`  ${e.message}\n\n`);
                    }
                    break;
                }

                case 'step': {
                    if (e.status === 'running') {
                        current = { label: e.label, pct: null, detail: null };
                        startedAt = Date.now();
                        if (tty) { startSpinner(); paint(); }
                        else write(`  ${DOT} ${e.label}...\n`);
                        return;
                    }

                    stopSpinner();
                    const took = elapsed();
                    current = null;
                    startedAt = 0;

                    if (e.status === 'done') {
                        write(`  ${green(TICK)} ${e.label}${took}\n`);
                    } else if (e.status === 'skipped') {
                        write(`  ${green(TICK)} ${dim(e.label)}\n`);
                    } else if (e.status === 'manual') {
                        write(`  ${yellow(WARN)} ${e.label}\n`);
                        if (e.detail) write(`      ${dim(e.detail)}\n`);
                    } else {
                        write(`  ${red(CROSS)} ${e.label}\n`);
                        if (e.detail) write(`      ${dim(e.detail)}\n`);
                    }
                    break;
                }

                case 'progress': {
                    if (current) {
                        current.pct = e.pct;
                        current.detail = e.detail || null;
                        if (!tty && Number.isFinite(e.pct) && e.pct % 25 === 0 && e.pct !== current.lastLogged) {
                            current.lastLogged = e.pct;
                            write(`      ${e.pct}%\n`);
                        }
                    }
                    break;
                }

                case 'note': {
                    if (e.level === 'debug' && !verbose) return;
                    stopSpinner();
                    const mark = e.level === 'warn' ? yellow(WARN) : dim(DOT);
                    write(`  ${mark} ${e.level === 'warn' ? e.text : dim(e.text)}\n`);
                    if (current && tty) { startSpinner(); paint(); }
                    break;
                }

                case 'done': {
                    stopSpinner();
                    if (e.ok) {
                        write(`\n  ${green(bold('JARVIS is ready.'))}\n\n`);
                    } else {
                        const s = e.summary || {};
                        write(`\n  ${yellow(bold('JARVIS is ready, with some things unfinished.'))}\n\n`);
                        for (const item of [...(s.failed || []), ...(s.manual || [])]) {
                            write(`    ${DOT} ${item.id}: ${item.detail || 'incomplete'}\n`);
                        }
                        write(`\n  ${dim('Run `jarvis doctor` for the fix for each, or `jarvis repair` to retry.')}\n\n`);
                    }
                    // Only claimed where it was actually exercised.
                    if (e.summary && e.summary.platformVerified === false) {
                        write(`  ${dim(`Note: the ${e.summary.platform.os} install path is implemented from vendor`)}\n`);
                        write(`  ${dim('documentation but has not been verified on this platform by the author.')}\n\n`);
                    }
                    break;
                }
            }
        },

        stop: stopSpinner,
    };
}

module.exports = { createReporter, isInteractive };
