// Settings and Preferences System
class SettingsManager {
    constructor() {
        this.storageKey = 'jarvis_settings';
        this.defaultSettings = {
            wakeWords: ['hey jarvis', 'jarvis'],
            speechRate: 0.9,
            speechPitch: 1.0,
            speechVolume: 1.0,
            /* Silence between spoken lines. The browser plays queued utterances
               back to back, which turns a three-fact answer into one unbroken
               run of speech — the listener never gets a boundary to process one
               fact before the next arrives. The gap sits INSIDE the microphone
               gate, so Jarvis cannot hear its own next line during it. */
            speechGapMs: 450,
            voiceName: null, // system fallback voice; only ever set to a female one

            /* OFF by default. The neural server speaks as Emma; a Windows
               system voice is a different voice entirely, and on a stock
               install the default one is male. Falling back to it silently
               meant a dead TTS server changed who Jarvis sounded like without
               saying so. Turn this on to keep a voice at all when the neural
               server is down, and even then only a female system voice is
               ever selected. */
            systemVoiceFallback: false,
            /* edge-tts neural voice used by the local TTS server — the voice
               you actually hear. Emma is cheerful and conversational;
               en-US-AriaNeural is a more clipped assistant register,
               en-US-AvaNeural warmer, en-GB-SoniaNeural British. Ask the server
               for the full list with a {"type":"voices"} frame rather than
               guessing at names. */
            neuralVoice: 'en-US-EmmaNeural',
            visualizerMode: 'sphere',
            visualizerSensitivity: 1.0,
            pttMode: false, // Push-to-Talk: false = always listening (default), true = hold space to talk
            apiKeys: {
                // NOTE: Set your API keys in src/config.js, not here
                openWeather: ''
            },
            theme: 'cyan',
            commandAliases: {},

            // --- LLM provider (Cloud vs Local) ---
            llmProvider: 'gemma-local',                   // 'gemma-local' (private, via Ollama, default) | 'gemini' (cloud, Live voice)
            localOllamaUrl: 'http://localhost:11434',     // Ollama OpenAI-compatible server
            localModel: 'gemma3:4b',                      // e.g. 'gemma3:4b', 'gemma4:12b' if you have 16GB+ RAM

            // --- Audio conditioning (applied on next mic start) ---
            echoCancellation: true,   // stops Jarvis's own voice feeding back into the mic
            noiseSuppression: true,   // filters fans, keystrokes, room hum
            autoGainControl: false,   // off preserves natural dynamics

            // --- OCR ---
            ocrProvider: 'auto',      // 'auto' = local Unlimited-OCR if server is up, else cloud vision

            /* --- Feedback (haptics) ---
               On a desktop these are a short animation plus a synthesized
               click, because navigator.vibrate is callable in Electron and
               moves nothing — there is no motor. Intensity scales LOUDNESS
               only; a quieter click is the same click, not a longer one.
               `prefers-reduced-motion` is honoured separately and gates the
               animation without silencing the confirmation. */
            hapticsEnabled: true,
            hapticIntensity: 0.7,     // full gain is louder than a UI click wants

            /* Bumped whenever a default below must beat the copy already in
               localStorage. See MIGRATED_KEYS. */
            settingsVersion: 3
        };
        this.settings = this.loadSettings();
    }

    /* Keys reset to their default when the stored settingsVersion is behind.
       Stored values normally win the merge, which is right for anything the
       user chose — but it also means a changed default can never reach an
       existing install. That bites harder than it looks: set() writes the whole
       merged object back, so a key the user never touched still ends up
       persisted at whatever the default was on the day it was first saved, and
       is pinned there forever. */
    static get MIGRATED_KEYS() {
        return ['neuralVoice', 'voiceName', 'systemVoiceFallback'];
    }

    // Load settings from localStorage
    loadSettings() {
        try {
            const stored = localStorage.getItem(this.storageKey);
            if (stored) {
                const loaded = JSON.parse(stored);
                // Merge with defaults to ensure all keys exist
                const merged = { ...this.defaultSettings, ...loaded };

                if ((loaded.settingsVersion || 0) < this.defaultSettings.settingsVersion) {
                    for (const key of SettingsManager.MIGRATED_KEYS) {
                        if (merged[key] !== this.defaultSettings[key]) {
                            console.log(`Settings migration: ${key} ${merged[key]} -> ${this.defaultSettings[key]}`);
                            merged[key] = this.defaultSettings[key];
                        }
                    }
                    merged.settingsVersion = this.defaultSettings.settingsVersion;
                    try {
                        localStorage.setItem(this.storageKey, JSON.stringify(merged));
                    } catch { /* migration is re-run next launch if this fails */ }
                }

                return merged;
            }
        } catch (error) {
            console.warn('Failed to load settings:', error);
        }
        return { ...this.defaultSettings };
    }

    // Save settings to localStorage
    saveSettings() {
        try {
            localStorage.setItem(this.storageKey, JSON.stringify(this.settings));
        } catch (error) {
            console.warn('Failed to save settings:', error);
        }
    }

    // Get a setting value
    get(key) {
        const keys = key.split('.');
        let value = this.settings;
        for (const k of keys) {
            value = value?.[k];
        }
        return value !== undefined ? value : null;
    }

    // Set a setting value
    set(key, value) {
        const keys = key.split('.');
        const lastKey = keys.pop();
        let target = this.settings;

        for (const k of keys) {
            if (!target[k]) {
                target[k] = {};
            }
            target = target[k];
        }

        target[lastKey] = value;
        this.saveSettings();
    }

    // Reset to default settings
    reset() {
        this.settings = { ...this.defaultSettings };
        this.saveSettings();
    }

    // Get all settings
    getAll() {
        return { ...this.settings };
    }

    // Update multiple settings at once
    update(updates) {
        Object.assign(this.settings, updates);
        this.saveSettings();
    }
}

export default SettingsManager;

