// Phone tool layer: desktop Jarvis is the brain, the companion is the hands.
//
// Natural language is resolved to a STRUCTURED intent here and sent as
// {tool, parameters}, rather than shipping raw text for the phone to parse.
// The phone reports success or a specific error, and Jarvis speaks the real
// outcome — it never claims an action it did not get confirmation for.

/**
 * Declared tools. `capability` names the flag the phone reports in its
 * capabilities map; when it is false Jarvis explains what to enable instead of
 * firing a command that will fail.
 */
export const PHONE_TOOLS = {
    'phone.open_app': { capability: 'open_app', summary: 'Open an app by name' },
    'phone.flashlight': { capability: 'flashlight', summary: 'Torch on or off' },
    'phone.volume': { capability: 'volume', summary: 'Set media volume' },
    'phone.battery': { capability: 'battery', summary: 'Battery level' },
    'phone.clipboard_get': { capability: 'clipboard', summary: 'Read phone clipboard' },
    'phone.clipboard_set': { capability: 'clipboard', summary: 'Write phone clipboard' },
    'phone.screenshot': { capability: 'screenshot', summary: 'Capture the screen' },
    'phone.read_screen': { capability: 'read_screen', summary: 'Read the UI tree' },
    'phone.navigate': { capability: 'ui_automation', summary: 'Home, back, recents, lock' },
    'phone.tts': { capability: 'tts', summary: 'Speak on the phone' }
};

// Wire names understood by DeviceCommandExecutor on the phone.
const WIRE = {
    'phone.open_app': 'open_app_by_name',
    'phone.flashlight': 'flashlight',
    'phone.volume': 'volume',
    'phone.battery': 'battery',
    'phone.clipboard_get': 'clipboard_get',
    'phone.clipboard_set': 'clipboard_set',
    'phone.screenshot': 'screenshot',
    'phone.read_screen': 'get_layout',
    'phone.navigate': 'global',
    'phone.tts': 'tts'
};

/**
 * Maps an utterance to a structured phone intent.
 *
 * Rule-based on purpose. These are destructive-ish, user-visible actions, and
 * a mis-parse means the wrong app opens — a small deterministic matcher beats
 * a 4B model guessing at STT output.
 *
 * @returns {{tool: string, parameters: object}|null}
 */
export function routePhoneCommand(text) {
    // Strip the targeting phrase so it does not pollute argument extraction.
    const q = String(text)
        .toLowerCase()
        .replace(/\b(on|to|from|of)\s+(my\s+)?(phone|mobile|android|redmi|device)\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    // Torch
    if (/\b(flashlight|torch|flash light)\b/.test(q)) {
        const off = /\b(off|disable|turn off|stop)\b/.test(q);
        return { tool: 'phone.flashlight', parameters: { on: !off } };
    }

    // Volume — absolute percent or relative step
    if (/\bvolume\b/.test(q)) {
        const pct = q.match(/(\d{1,3})\s*(percent|%)?/);
        if (pct && /\b(set|make|to)\b/.test(q)) {
            return { tool: 'phone.volume', parameters: { percent: Number(pct[1]) } };
        }
        if (/\b(up|increase|louder|raise)\b/.test(q)) {
            return { tool: 'phone.volume', parameters: { delta: 2 } };
        }
        if (/\b(down|decrease|quieter|lower)\b/.test(q)) {
            return { tool: 'phone.volume', parameters: { delta: -2 } };
        }
    }

    if (/\bbattery|charge\b/.test(q)) return { tool: 'phone.battery', parameters: {} };

    if (/\bscreenshot|screen shot|capture the screen\b/.test(q)) {
        return { tool: 'phone.screenshot', parameters: { quality: 70 } };
    }

    if (/\b(what'?s on|read|look at)\b.*\bscreen\b/.test(q)) {
        return { tool: 'phone.read_screen', parameters: {} };
    }

    // Navigation
    const nav = q.match(/\b(go\s+)?(home|back|recents|notifications|lock)\b/);
    if (nav && /\b(go|press|tap|open|show|navigate|lock)\b/.test(q)) {
        return { tool: 'phone.navigate', parameters: { action: nav[2] } };
    }

    if (/\bclipboard\b/.test(q)) {
        return { tool: 'phone.clipboard_get', parameters: {} };
    }

    // Open an app — last, so more specific rules win first.
    const open = q.match(/\b(?:open|launch|start|run|play)\s+(.+)$/);
    if (open) {
        const name = open[1]
            .replace(/\b(app|application|please|for me)\b/g, '')
            .replace(/[^\w\s.+-]/g, '')
            .trim();
        if (name) return { tool: 'phone.open_app', parameters: { name } };
    }

    return null;
}

/** True when the utterance explicitly targets the phone. */
export function targetsPhone(text) {
    return /\b(on|to)\s+(my\s+)?(phone|mobile|android|redmi)\b/i.test(String(text));
}

/**
 * Executes a structured intent against the connected companion.
 * @returns {{ok: boolean, spoken: string, result?: object}}
 */
export async function executePhoneTool(intent, capabilities) {
    const spec = PHONE_TOOLS[intent.tool];
    if (!spec) return { ok: false, spoken: `I have no tool called ${intent.tool}, Sir.` };

    // Capability gate: fail with the fix, not a generic error.
    if (capabilities && capabilities[spec.capability] === false) {
        const hint = spec.capability === 'ui_automation' || spec.capability === 'screenshot' || spec.capability === 'read_screen'
            ? ' Enable Jarvis Device Control under Settings, Accessibility on the phone.'
            : '';
        return { ok: false, spoken: `Your phone does not support ${spec.summary.toLowerCase()} right now, Sir.${hint}` };
    }

    const wire = WIRE[intent.tool];
    const res = await window.electronAPI.companionCommand(wire, intent.parameters);

    if (!res.ok) {
        return { ok: false, spoken: `That failed on the phone, Sir. ${res.error || ''}`.trim() };
    }
    return { ok: true, result: res.result, spoken: describeResult(intent, res.result) };
}

// Speaks the actual outcome, using values the phone returned.
function describeResult(intent, result) {
    switch (intent.tool) {
        case 'phone.open_app':
            return `${result?.label || 'It'} is now open on your phone, Sir.`;
        case 'phone.flashlight':
            return `Flashlight ${result?.on ? 'on' : 'off'}, Sir.`;
        case 'phone.volume':
            return `Phone volume is now ${result?.percent ?? '?'} percent, Sir.`;
        case 'phone.battery':
            return `Your phone is at ${result?.level ?? '?'} percent${result?.charging ? ' and charging' : ''}, Sir.`;
        case 'phone.clipboard_get':
            return result?.text ? `Your phone clipboard says: ${result.text}` : 'The phone clipboard is empty, Sir.';
        case 'phone.screenshot':
            return 'I have captured your phone screen, Sir.';
        case 'phone.read_screen':
            return `I can see ${result?.count ?? 0} elements on your phone screen, Sir.`;
        case 'phone.navigate':
            return 'Done, Sir.';
        default:
            return 'Done, Sir.';
    }
}
