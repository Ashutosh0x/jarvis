// Settings and Preferences System
class SettingsManager {
    constructor() {
        this.storageKey = 'jarvis_settings';
        this.defaultSettings = {
            wakeWords: ['hey jarvis', 'jarvis'],
            speechRate: 0.9,
            speechPitch: 1.0,
            speechVolume: 1.0,
            voiceName: null, // Will be set automatically to a male voice
            visualizerMode: 'sphere',
            visualizerSensitivity: 1.0,
            pttMode: false, // Push-to-Talk: false = always listening (default), true = hold space to talk
            apiKeys: {
                // NOTE: Set your API keys in src/config.js, not here
                openWeather: ''
            },
            theme: 'cyan',
            commandAliases: {}
        };
        this.settings = this.loadSettings();
    }

    // Load settings from localStorage
    loadSettings() {
        try {
            const stored = localStorage.getItem(this.storageKey);
            if (stored) {
                const loaded = JSON.parse(stored);
                // Merge with defaults to ensure all keys exist
                return { ...this.defaultSettings, ...loaded };
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

