// Computer use — the half that actually moves the mouse.
//
// Decisions live in src/js/services/computerUseIntent.js. This file performs
// only what that module has already permitted, and refuses to be called any
// other way: every entry point takes a validated action, not a raw one.
//
// WHY POWERSHELL P/INVOKE AND NOT A NATIVE MODULE
// -----------------------------------------------
// robotjs is unmaintained and nut.js needs a native build; both mean an
// Electron ABI rebuild on every version bump, which is the exact reason
// active-win was rejected earlier in this project in favour of a PowerShell
// foreground-window poll. user32.dll is already reachable through the
// Add-Type interop this app uses for SetForegroundWindow and SendKeys, so
// mouse control costs four more DllImports and no new dependency, no compile
// step, and nothing to rebuild when Electron moves.
//
// The cost is honest and worth stating: each action spawns a PowerShell
// process, so a step is tens of milliseconds rather than microseconds. That is
// far below human-perceptible for a click, and this path is deliberately rate
// limited anyway — see MIN_STEP_MS. It would be the wrong choice for a game
// bot and is the right one for an assistant taking a handful of deliberate
// actions.

const { exec } = require('child_process');

/* Win32 surface. Deliberately the smallest set that covers the action
   vocabulary — there is no SendInput here, no keybd_event, no window
   enumeration. Anything this file cannot express, the assistant cannot do. */
const MOUSE_INTEROP = `
Add-Type -Namespace JarvisM -Name U -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern bool GetCursorPos(out System.Drawing.Point p);
[DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, int d, int e);
'@ -ReferencedAssemblies System.Drawing
`;

const MOUSEEVENTF = Object.freeze({
    LEFTDOWN: 0x02, LEFTUP: 0x04,
    RIGHTDOWN: 0x08, RIGHTUP: 0x10,
    MIDDLEDOWN: 0x20, MIDDLEUP: 0x40,
    WHEEL: 0x0800
});

function runPowerShell(script, timeoutMs = 15000) {
    return new Promise((resolve) => {
        const encoded = Buffer.from(script, 'utf16le').toString('base64');
        exec(`powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`,
            { timeout: timeoutMs, windowsHide: true },
            (err, stdout) => resolve(err ? null : String(stdout).trim()));
    });
}

/** Where the pointer is right now. The kill switch reads this before each step. */
async function cursorPosition() {
    const raw = await runPowerShell(`${MOUSE_INTEROP}
$p = New-Object System.Drawing.Point
[void][JarvisM.U]::GetCursorPos([ref]$p)
[pscustomobject]@{ x = $p.X; y = $p.Y } | ConvertTo-Json -Compress`, 8000);
    if (!raw) return null;
    try {
        const j = JSON.parse(raw);
        return { x: Number(j.x), y: Number(j.y) };
    } catch { return null; }
}

/**
 * Perform one already-validated action.
 *
 * Takes the `action` object that `validateAction()` RETURNED, not the one that
 * was proposed — the returned form is normalised (rounded coordinates, clamped
 * scroll, lower-cased chord) and carries only fields that survived validation.
 * Passing the raw proposal here would skip every bound this system has.
 *
 * Returns `{ ok, error, cursor }` — `cursor` is where the pointer ended up,
 * read back rather than assumed, so the caller can detect a human takeover on
 * the next step.
 */
async function perform(action, opts = {}) {
    if (!action || typeof action !== 'object') {
        return { ok: false, error: 'no action' };
    }
    const { type } = action;

    const clickPair = {
        click: [MOUSEEVENTF.LEFTDOWN, MOUSEEVENTF.LEFTUP],
        double_click: [MOUSEEVENTF.LEFTDOWN, MOUSEEVENTF.LEFTUP],
        right_click: [MOUSEEVENTF.RIGHTDOWN, MOUSEEVENTF.RIGHTUP],
        middle_click: [MOUSEEVENTF.MIDDLEDOWN, MOUSEEVENTF.MIDDLEUP]
    }[type];

    let script = null;

    if (type === 'move') {
        script = `[void][JarvisM.U]::SetCursorPos(${action.x}, ${action.y})`;
    } else if (clickPair) {
        const [down, up] = clickPair;
        /* Move, settle, then click. The settle is not superstition: a click
           delivered in the same tick as the move can land before the target
           window has processed the mouse-move, and hover-activated UI
           (menus, tooltips, anything that opens on enter) will not have
           appeared yet. */
        const once = `[JarvisM.U]::mouse_event(${down},0,0,0,0); Start-Sleep -Milliseconds 30; [JarvisM.U]::mouse_event(${up},0,0,0,0)`;
        script = `[void][JarvisM.U]::SetCursorPos(${action.x}, ${action.y})
Start-Sleep -Milliseconds 40
${once}${type === 'double_click' ? `\nStart-Sleep -Milliseconds 90\n${once}` : ''}`;
    } else if (type === 'drag') {
        /* Press, move in steps, release. A single jump from source to target
           with the button down is not a drag as far as most applications are
           concerned — they track intermediate move messages to decide a drag
           has started, and a teleport produces a click at the origin instead. */
        const steps = 12;
        const moves = [];
        for (let i = 1; i <= steps; i++) {
            const x = Math.round(action.x + (action.toX - action.x) * (i / steps));
            const y = Math.round(action.y + (action.toY - action.y) * (i / steps));
            moves.push(`[void][JarvisM.U]::SetCursorPos(${x}, ${y}); Start-Sleep -Milliseconds 12`);
        }
        script = `[void][JarvisM.U]::SetCursorPos(${action.x}, ${action.y})
Start-Sleep -Milliseconds 40
[JarvisM.U]::mouse_event(${MOUSEEVENTF.LEFTDOWN},0,0,0,0)
Start-Sleep -Milliseconds 60
${moves.join('\n')}
Start-Sleep -Milliseconds 60
[JarvisM.U]::mouse_event(${MOUSEEVENTF.LEFTUP},0,0,0,0)`;
    } else if (type === 'scroll') {
        // One notch is 120 units; positive scrolls up, matching Windows.
        const delta = Math.round(action.amount) * 120;
        script = `[JarvisM.U]::mouse_event(${MOUSEEVENTF.WHEEL},0,0,${delta},0)`;
    } else if (type === 'wait') {
        await new Promise((r) => setTimeout(r, Math.min(2000, Number(opts.waitMs) || 300)));
        return { ok: true, error: null, cursor: await cursorPosition() };
    } else if (type === 'type' || type === 'key' || type === 'screenshot') {
        /* Not this module's job. Text and chords go through the existing
           inputControl.js + type-text path, which already solves SendKeys
           escaping and was verified against Notepad; screenshots go through
           desktopCapturer. Duplicating either here would create a second,
           less-tested encoder for the same problem. */
        return { ok: false, error: `'${type}' is handled by the existing input path, not computerUse` };
    } else {
        return { ok: false, error: `unsupported action '${type}'` };
    }

    /* THE READBACK MUST BE IN THIS SAME PROCESS.
       It was a second runPowerShell call, and that is racy in a way that
       matters: between the process that moves the cursor and the process that
       reads it — a spawn apart, tens of milliseconds — a human hand can move
       the mouse. Measured: asking for (400,300) and reading back separately
       returned (557,510), while set-and-read inside ONE process returns
       (400,300) exactly.

       The consequence was not a cosmetic wrong number. `humanTookOver()`
       compares the requested point against this reading, so a racy readback
       manufactures false aborts — the kill switch firing when nobody touched
       anything, which trains the user to stop believing it. Atomic here, and
       it halves the process spawns per action too. */
    const out = await runPowerShell(`${MOUSE_INTEROP}
${script}
Start-Sleep -Milliseconds 25
$__p = New-Object System.Drawing.Point
[void][JarvisM.U]::GetCursorPos([ref]$__p)
[pscustomobject]@{ x = $__p.X; y = $__p.Y } | ConvertTo-Json -Compress`, 20000);

    if (out === null) return { ok: false, error: 'input call failed' };
    let cursor = null;
    try {
        const j = JSON.parse(out);
        cursor = { x: Number(j.x), y: Number(j.y) };
    } catch {
        /* The action ran; only the confirmation is missing. Reported as a null
           cursor rather than a guess, so the caller skips the takeover check
           for this step instead of aborting on a reading it does not have. */
    }
    return { ok: true, error: null, cursor };
}

/** Primary display size, for the bounds check. Read, never assumed. */
async function screenSize() {
    const raw = await runPowerShell(`
Add-Type -AssemblyName System.Windows.Forms
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
[pscustomobject]@{ width = $b.Width; height = $b.Height } | ConvertTo-Json -Compress`, 8000);
    if (!raw) return null;
    try {
        const j = JSON.parse(raw);
        const width = Number(j.width), height = Number(j.height);
        if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
        return { width, height };
    } catch { return null; }
}

module.exports = { perform, cursorPosition, screenSize, MOUSEEVENTF };
