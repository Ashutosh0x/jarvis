/**
 * Jarvis Configuration File
 * 
 * SETUP INSTRUCTIONS:
 * 1. Copy this file and rename to: config.js
 * 2. Replace placeholder values with your actual API keys
 * 3. DO NOT commit config.js to version control (it's in .gitignore)
 */
export const config = {
    // Gemini API Key - Get yours from https://ai.google.dev/
    geminiApiKey: 'YOUR_GEMINI_API_KEY',

    // OpenWeatherMap API Key - Get yours from https://openweathermap.org/api
    // This enables weather functionality
    openWeatherApiKey: 'YOUR_OPENWEATHER_API_KEY',

    // Wake words that activate Jarvis
    wakeWords: ['hey jarvis', 'jarvis'],

    // Speech settings for text-to-speech
    speechRate: 0.9,
    speechPitch: 1.0,
    speechVolume: 1.0
};

export default config;
