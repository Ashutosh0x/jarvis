// Jarvis AI Assistant Core Module
import ConversationMemory from './memory.js';
import ScreenCapture from './screenCapture.js';
import CalendarSystem from './calendar.js';
import SettingsManager from './settings.js';
import { LiveService } from './liveService.js';
import { generateContentLocal, checkOllama, routeLocalAction, describeImageLocal } from './toolService.js';
import { routePhoneCommand, targetsPhone, executePhoneTool } from './services/phoneTools.js';
import ragService from './services/ragService.js';
import reflectionService from './services/reflectionService.js';
import * as quant from './services/quant.js';
import * as onchain from './services/onchain.js';
import * as ens from './services/ens.js';
import { LocalVoiceService } from './services/voiceService.js';
import { config } from '../config.js';
import perf from './services/perf.js';

class Jarvis {
    constructor() {
        this.isListening = false;
        this.isProcessing = false;
        this.wakeWordDetected = false;
        this.recognition = null;
        this.synthesis = window.speechSynthesis;
        this.selectedVoice = null; // Will be set during initialization
        // API key now loaded exclusively from settings system
        this.openWeatherApiKey = null;
        this.location = null;
        this.weather = null;

        // Conversation Memory
        this.memory = new ConversationMemory();

        // Screen Capture
        this.screenCapture = new ScreenCapture();

        // Calendar System
        this.calendar = new CalendarSystem();
        this.calendar.requestNotificationPermission();

        // Settings Manager
        this.settings = new SettingsManager();
        this.applySettings();

        // No Gemini key -> force local Gemma regardless of stored settings
        // (prevents stale localStorage from routing to a dead cloud endpoint)
        this.localVoice = null;
        this.followUpUntil = 0;
        if (!config.geminiApiKey || config.geminiApiKey.startsWith('YOUR_')) {
            this.settings.set('llmProvider', 'gemma-local');
            console.log('Jarvis: running in LOCAL mode (Gemma via Ollama)');

            // Always-on local voice loop: mic -> VAD -> faster-whisper -> commands
            // NOTE: the TTS gate uses this.ttsActive (explicit flag), NOT
            // synthesis.speaking — Chromium's speaking flag can stick true
            // forever after an utterance, which would permanently deafen the mic.
            this.ttsActive = false;
            this.localVoice = new LocalVoiceService({
                onTranscript: (text, meta) => this._handleVoiceTranscript(text, meta),
                onVolume: (v) => { window.visualizerVolume = v; },
                onStatus: (s) => this._onVoiceStatus(s),
                isTtsSpeaking: () => this.ttsActive,
            });
            setTimeout(() => {
                this.localVoice.start().catch(e => {
                    console.warn('LocalVoice: mic start failed (voice input disabled)', e);
                    this._showTranscript(`Microphone unavailable: ${e.name || e.message}`, 'error', 'MIC ERROR', 0);
                });
            }, 1500);
        }

        // Live Service (Gemini Multimodal Live)
        this.liveService = new LiveService();
        this.setupLiveService();

        // Phone Bridge (Wi-Fi notification relay from Android)
        this.recentNotifications = new Map(); // dedupe hash -> ts
        this.setupPhoneBridge();

        // Event-Driven Core (JARVIS v4): OS events -> router -> act/announce
        this.activeWindow = null;
        this.setupEventBus();

        // Local-mode startup greeting (the cloud greeting only fires when the
        // Live session connects; without a Gemini key that never happens).
        // Delayed so the TTS voice list has time to load.
        setTimeout(() => {
            if (!this.liveService || !this.liveService.isConnected) {
                this.speak('Systems online. Local intelligence active. How may I assist, Sir?');
            }
        }, 3000);

        // Sleep-like consolidation: once per day, well after boot, distill the
        // day's experience into long-term memory. Runs at most once daily and
        // only when there is genuinely new experience, so it is usually a silent
        // no-op. Delayed 45s so it never competes with startup or the first
        // command, and gated on not speaking over an active exchange.
        setTimeout(async () => {
            try {
                if (this.isProcessing || this.ttsActive) return;
                const summary = await reflectionService.maybeAutoReflect();
                if (summary && !this.isProcessing && !this.ttsActive) {
                    this.speak(`While you were away, I consolidated my memory. ${summary}`);
                }
            } catch (e) {
                console.warn('Startup auto-reflection skipped:', e.message);
            }
        }, 45000);

        // Camera State
        this.cameraStream = null;
        this.cameraActive = false;
        this.cameraInterval = null;

        // UI Elements
        this.displayElement = null;
        this.textElement = null;
        this.commandInput = null;
        this.cameraVideo = null;
        this.cameraContainer = null;
        this.statusText = null;
        this.statusBar = null;
        this.mediaOutput = null;
        this.mediaImage = null;

        this.init();
    }

    async init() {
        this.initializeUI();
        await this.initializeLocation();
        await this.initializeWeather();
        // Select a good system voice for local (Windows SAPI) TTS. In cloud
        // mode speak() returns before SAPI, so this is a harmless no-op there;
        // in local mode (default, no Gemini key) it's what gives Jarvis a
        // proper voice instead of the browser default.
        this.initializeVoice();
        // this.initializeSpeechRecognition(); // Replaced by LiveService
        this.initializeCommandInput();
        this.initializePushToTalk();
        this.speakStartupGreeting();
        // Start Gemini connection
        this.liveService.connect();
    }

    // Initialize Push-to-Talk (Space key to activate mic)
    initializePushToTalk() {
        // PTT mode: false = always listening (default), true = hold space to talk
        this.pttMode = this.settings.get('pttMode') ?? false;
        this.pttActive = false;
        this.pttIndicator = document.getElementById('ptt-indicator');

        // Update indicator based on mode
        if (this.pttMode) {
            // PTT mode: start muted
            setTimeout(() => {
                if (this.liveService && this.liveService.streamer) {
                    this.liveService.muteMic();
                }
                this.updatePTTIndicator(false);
            }, 2000);
        } else {
            // Always-on mode: hide PTT indicator, mic is always active
            if (this.pttIndicator) {
                this.pttIndicator.textContent = 'ALWAYS LISTENING';
                this.pttIndicator.classList.add('active');
            }
        }

        // Space key handlers
        document.addEventListener('keydown', (e) => {
            // Don't trigger PTT if typing in input
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

            if (e.code === 'Space' && this.pttMode && !this.pttActive) {
                e.preventDefault();
                this.pttActive = true;
                this.liveService.unmuteMic();
                this.updatePTTIndicator(true);
                console.log('PTT: Microphone activated');
            }
        });

        document.addEventListener('keyup', (e) => {
            if (e.code === 'Space' && this.pttMode && this.pttActive) {
                e.preventDefault();
                this.pttActive = false;
                this.liveService.muteMic();
                // 🔥 FIX: Send explicit turn complete when user stops speaking for faster response
                this.liveService.sendTurnComplete();
                this.updatePTTIndicator(false);
                console.log('PTT: Microphone deactivated & Turn completed');
            }
        });

        console.log('Push-to-Talk initialized (Space key)');
    }

    // Update PTT visual indicator
    updatePTTIndicator(active) {
        if (this.pttIndicator) {
            if (active) {
                this.pttIndicator.classList.add('active');
                this.pttIndicator.textContent = 'SPEAKING';
            } else {
                this.pttIndicator.classList.remove('active');
                this.pttIndicator.textContent = 'HOLD SPACE TO TALK';
            }
        }

        // Also update status bar color
        if (this.statusBar) {
            this.statusBar.style.background = active ? '#22c55e' : '#06b6d4';
        }
    }

    // Apply settings to Jarvis
    applySettings() {
        // Apply API keys from settings
        const weatherKey = this.settings.get('apiKeys.openWeather');
        if (weatherKey) this.openWeatherApiKey = weatherKey;
    }

    // Initialize voice selection
    initializeVoice() {
        // Wait for voices to be loaded
        const loadVoices = () => {
            const voices = this.synthesis.getVoices();
            const savedVoiceName = this.settings.get('voiceName');

            if (savedVoiceName) {
                // Try to find the saved voice
                const savedVoice = voices.find(v => v.name === savedVoiceName);
                if (savedVoice) {
                    this.selectedVoice = savedVoice;
                    console.log('Using saved voice:', savedVoice.name);
                    return;
                }
            }

            // Find a male voice (prefer English, male-sounding names)
            const maleVoiceNames = [
                'Microsoft David', 'Microsoft Mark', 'Microsoft Zira',
                'Google US English', 'Alex', 'Daniel', 'Fred', 'Tom',
                'Microsoft David Desktop', 'Microsoft Mark Desktop'
            ];

            // First try to find by preferred names
            for (const name of maleVoiceNames) {
                const voice = voices.find(v => v.name.includes(name) || name.includes(v.name));
                if (voice) {
                    this.selectedVoice = voice;
                    this.settings.set('voiceName', voice.name);
                    console.log('Selected male voice:', voice.name);
                    return;
                }
            }

            // Fallback: find any male voice (check lang and name)
            const maleVoice = voices.find(v => {
                const name = v.name.toLowerCase();
                const lang = v.lang.toLowerCase();
                return lang.startsWith('en') && (
                    name.includes('male') ||
                    name.includes('david') ||
                    name.includes('mark') ||
                    name.includes('daniel') ||
                    name.includes('alex') ||
                    name.includes('fred') ||
                    name.includes('tom') ||
                    name.includes('john') ||
                    name.includes('james')
                );
            });

            if (maleVoice) {
                this.selectedVoice = maleVoice;
                this.settings.set('voiceName', maleVoice.name);
                console.log('Selected male voice (fallback):', maleVoice.name);
            } else {
                // Last resort: use default voice
                this.selectedVoice = voices.find(v => v.default) || voices[0];
                if (this.selectedVoice) {
                    console.log('Using default voice:', this.selectedVoice.name);
                }
            }
        };

        // Voices might not be loaded immediately
        if (this.synthesis.getVoices().length > 0) {
            loadVoices();
        } else {
            // Wait for voices to load
            this.synthesis.onvoiceschanged = loadVoices;
        }
    }

    // Initialize UI Elements
    initializeUI() {
        this.displayElement = document.getElementById('jarvis-display');
        this.textElement = document.getElementById('jarvis-text');
        this.commandInput = document.getElementById('command-input');
        this.cameraVideo = document.getElementById('camera-feed');
        this.cameraContainer = document.getElementById('camera-container');
        this.statusText = document.getElementById('status-text');
        this.statusBar = document.getElementById('status-progress');
        this.mediaOutput = document.getElementById('media-output-container');
        this.mediaImage = document.getElementById('media-image');
        this.sourcesContainer = document.getElementById('sources-container');
        this.sourcesList = document.getElementById('sources-list');
    }

    setupLiveService() {
        this.liveService.onStateChange = (state) => {
            console.log("Gemini Connection State:", state);
            this.updateHUDStatus(state);

            if (state === 'CONNECTED') {
                this.displayText("Systems online. Neural link established.", null);

                // 🔥 AUTO-UNMUTE: If in always-on mode, ensure mic is active
                if (!this.pttMode) {
                    setTimeout(() => {
                        if (this.liveService) {
                            this.liveService.unmuteMic();
                            console.log("🎙️ Always-on mode: Mic unmuted");
                        }
                    }, 500);
                }
            } else if (state === 'RETRYING') {
                this.displayText("Quota exceeded. Recalibrating link...", null);
            } else if (state === 'ERROR') {
                this.displayText("Link failure. Check credentials.", null);
            }
        };

        this.liveService.onMessage = (msg) => {
            // 🔥 DEBUG: Log all incoming messages
            console.log("GEMINI EVENT:", msg);

            // 🔥 REAL-TIME USER SPEECH TRANSCRIPTION (event-based)
            // Check for type field (event-based Gemini Live format)
            if (msg.type === 'input_audio_transcription.result') {
                if (msg.text && msg.text.trim()) {
                    console.log("🎤 [TRANSCRIPT] User said:", msg.text);
                    this.appendLiveTranscript(msg.text);
                    this.logToHUD(msg.text, 'user');
                }
                return;
            }

            // Also check serverContent.inputTranscript (SDK format)
            if (msg.serverContent?.inputTranscript) {
                const transcript = msg.serverContent.inputTranscript;
                console.log("🎤 [TRANSCRIPT] User said:", transcript);
                this.appendLiveTranscript(transcript);
                this.logToHUD(transcript, 'user');
                return;
            }

            // Model audio/text output from serverContent
            if (msg.serverContent?.modelTurn?.parts) {
                for (const part of msg.serverContent.modelTurn.parts) {
                    if (part.text) {
                        this.displayText(part.text, null);
                        this.logToHUD(part.text, 'model');
                    }
                }
            }

            // Model responses (processed format from liveService)
            if (msg.role === 'model') {
                if (msg.text) this.displayText(msg.text, null);
                if (msg.metadata) this.handleRichMedia(msg.metadata);
            }
            // Search grounding
            else if (msg.role === 'system' && msg.metadata?.type === 'search') {
                this.displaySources(msg.metadata.sources);
            }
        };

        this.liveService.onVolume = (vol) => {
            if (window.visualizerVolume !== undefined) {
                window.visualizerVolume = vol;
            }
        };
    }

    // 🔥 NEW: Append live transcript (streaming text, no animation)
    appendLiveTranscript(text) {
        if (!this.textElement || !this.displayElement) return;

        this.displayElement.classList.add('active');

        // Create live transcript element if not exists
        if (!this.liveTranscriptElement) {
            this.liveTranscriptElement = document.createElement('span');
            this.liveTranscriptElement.id = 'live-transcript';
            this.liveTranscriptElement.style.color = '#94a3b8';
            this.liveTranscriptElement.style.fontStyle = 'italic';
        }

        // Append to existing transcript (streaming effect)
        this.liveTranscriptElement.textContent += text + ' ';

        // Show in text element if not already there
        if (!this.textElement.contains(this.liveTranscriptElement)) {
            this.textElement.innerHTML = '';
            this.textElement.appendChild(this.liveTranscriptElement);
        }
    }

    // Clear live transcript when AI starts responding
    clearLiveTranscript() {
        if (this.liveTranscriptElement) {
            this.liveTranscriptElement.textContent = '';
        }
    }

    updateHUDStatus(state) {
        if (!this.statusText || !this.statusBar) return;
        this.statusText.textContent = state;

        if (state === 'CONNECTED') {
            this.statusBar.style.width = "100%";
            this.statusBar.style.background = "#06b6d4";
        } else if (state === 'CONNECTING' || state === 'RETRYING') {
            this.statusBar.style.width = "50%";
            this.statusBar.style.background = "#eab308";
        } else {
            this.statusBar.style.width = "0%";
            this.statusBar.style.background = "#ef4444";
        }
    }

    // SECURITY: Sanitize HTML to prevent XSS attacks
    sanitizeHTML(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    logToHUD(text, role) {
        if (!this.logContainer) return;

        // Clear "awaiting" message if first real log
        if (this.logContainer.innerText.includes("Awaiting")) {
            this.logContainer.innerHTML = '';
        }

        const entry = document.createElement('div');
        entry.className = "text-[11px] group animate-in slide-in-from-left duration-300";

        const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

        // SECURITY FIX: Sanitize text and role to prevent XSS
        const safeText = this.sanitizeHTML(text);
        const safeRole = this.sanitizeHTML(role);

        let icon = '';
        let color = 'text-slate-400';

        if (role === 'model') {
            color = 'text-cyan-400';
        } else if (role === 'user') {
            color = 'text-slate-100';
        } else {
            color = 'text-slate-500';
        }

        entry.innerHTML = `
            <div class="flex items-center gap-2 mb-0.5 opacity-60">
                <span class="font-mono text-[9px]">${time}</span>
                <span class="text-[9px] uppercase font-bold tracking-tighter">${safeRole}</span>
            </div>
            <div class="${color} pl-4 border-l border-slate-800 py-0.5 leading-relaxed truncate hover:whitespace-normal transition-all">
                ${safeText}
            </div>
        `;

        this.logContainer.prepend(entry);

        // Keep logs clean
        if (this.logContainer.children.length > 50) {
            this.logContainer.lastElementChild.remove();
        }
    }

    handleRichMedia(metadata) {
        if (metadata.image) {
            this.mediaImage.src = metadata.image;
            this.mediaOutput.classList.add('active');
            // Remove auto-hide to keep image persistent until next prompt change
        }
    }

    displaySources(sources) {
        if (!this.sourcesList || !this.sourcesContainer) return;

        this.sourcesContainer.classList.add('active');
        this.sourcesList.innerHTML = '';

        sources.forEach((src) => {
            const card = document.createElement('div');
            card.className = "source-card";
            card.onclick = () => window.open(src.uri, '_blank');
            card.innerHTML = `
                <div class="source-title">${src.title}</div>
                <div class="source-url">${src.uri}</div>
            `;
            this.sourcesList.appendChild(card);
        });

        // Hide after 15 seconds of inactivity
        if (this.sourcesTimeout) clearTimeout(this.sourcesTimeout);
        this.sourcesTimeout = setTimeout(() => {
            this.sourcesContainer.classList.remove('active');
        }, 15000);
    }

    async toggleCamera(active) {
        if (active && !this.cameraActive) {
            try {
                this.cameraStream = await navigator.mediaDevices.getUserMedia({
                    video: { width: 640, height: 480 }
                });
                this.cameraVideo.srcObject = this.cameraStream;
                this.cameraVideo.style.opacity = "1";
                const offline = document.getElementById('camera-offline');
                if (offline) offline.style.display = 'none';

                this.cameraActive = true;
                this.startCameraProcessing();
                this.speak("Camera systems activated, sir.");
            } catch (err) {
                console.error("Camera access failed:", err);
                this.speak("I'm sorry, sir. I couldn't access the camera.");
            }
        } else if (!active && this.cameraActive) {
            if (this.cameraStream) {
                this.cameraStream.getTracks().forEach(track => track.stop());
            }
            this.cameraVideo.style.opacity = "0.6";
            const offline = document.getElementById('camera-offline');
            if (offline) offline.style.display = 'flex';

            this.cameraActive = false;
            if (this.cameraInterval) clearInterval(this.cameraInterval);
            this.speak("Camera systems deactivated.");
        }
    }

    startCameraProcessing() {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        canvas.width = 320;
        canvas.height = 240;

        this.cameraInterval = setInterval(() => {
            if (this.cameraActive && this.cameraVideo.readyState === this.cameraVideo.HAVE_ENOUGH_DATA) {
                ctx.drawImage(this.cameraVideo, 0, 0, canvas.width, canvas.height);
                const base64 = canvas.toDataURL('image/jpeg', 0.5);
                this.liveService.updateCameraFrame(base64);
            }
        }, 1000); // Send frame every second
    }

    // Initialize Command Input Handler
    initializeCommandInput() {
        if (this.commandInput) {
            this.commandInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter' && !this.isProcessing) {
                    const command = this.commandInput.value.trim();
                    if (command) {
                        this.commandInput.value = '';
                        this.commandInput.disabled = true;
                        this._lastInputWasVoice = false;
                        this.processCommand(command);
                    }
                }
            });
        }
    }

    // Initialize Speech Recognition
    initializeSpeechRecognition() {
        if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
            console.error('Speech recognition not supported in this browser');
            this.displayText('Speech recognition not supported. Please use Chrome or Edge browser.', null);
            return;
        }

        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        this.recognition = new SpeechRecognition();
        this.recognition.continuous = true;
        this.recognition.interimResults = false;
        this.recognition.lang = 'en-US';

        // Add maxAlternatives for better recognition
        this.recognition.maxAlternatives = 1;

        this.recognition.onresult = (event) => {
            const transcript = Array.from(event.results)
                .map(result => result[0].transcript)
                .join('')
                .toLowerCase();

            console.log('Heard:', transcript);

            // Wake word detection - check if transcript contains wake words
            const wakeWords = this.settings.get('wakeWords') || ['hey jarvis', 'jarvis'];
            const hasWakeWord = wakeWords.some(word => transcript.includes(word));

            if (hasWakeWord && !this.wakeWordDetected) {
                this.wakeWordDetected = true;
                this.onWakeWord();
                // Extract command after wake word
                const command = transcript.replace(/hey jarvis|jarvis/gi, '').trim();
                if (command && !this.isProcessing) {
                    setTimeout(() => this.processCommand(command), 500);
                }
                return;
            }

            // Process command if wake word was detected
            if (this.wakeWordDetected && !this.isProcessing && transcript.trim()) {
                this.processCommand(transcript);
            }
        };

        this.recognition.onerror = (event) => {
            console.error('Speech recognition error:', event.error);

            // Handle different error types
            switch (event.error) {
                case 'network':
                    console.warn('Network error - speech recognition requires internet connection');
                    // Retry after a delay
                    setTimeout(() => {
                        if (!this.isProcessing) {
                            this.startAlwaysOnListening();
                        }
                    }, 3000);
                    break;
                case 'no-speech':
                    // Restart listening
                    this.startAlwaysOnListening();
                    break;
                case 'aborted':
                    // Don't restart if aborted intentionally
                    break;
                case 'audio-capture':
                    console.error('No microphone found or microphone not accessible');
                    break;
                case 'not-allowed':
                    console.error('Microphone permission denied');
                    break;
                default:
                    // For other errors, retry after a short delay
                    setTimeout(() => {
                        if (!this.isProcessing) {
                            this.startAlwaysOnListening();
                        }
                    }, 2000);
            }
        };

        this.recognition.onend = () => {
            // Restart listening if not processing and not manually stopped
            if (!this.isProcessing && this.isListening) {
                // Add a small delay before restarting to avoid rapid restarts
                setTimeout(() => {
                    if (!this.isProcessing && this.isListening) {
                        this.startAlwaysOnListening();
                    }
                }, 500);
            }
        };
    }

    startAlwaysOnListening() {
        if (this.recognition && !this.isProcessing) {
            try {
                // Stop any existing recognition first
                try {
                    this.recognition.stop();
                } catch (e) {
                    // Ignore if already stopped
                }

                // Wait a bit before restarting
                setTimeout(() => {
                    try {
                        this.recognition.start();
                        this.isListening = true;
                    } catch (e) {
                        if (e.message && e.message.includes('already started')) {
                            // Already started, that's fine
                            this.isListening = true;
                        } else {
                            console.warn('Failed to start recognition:', e);
                            // Retry after delay
                            setTimeout(() => this.startAlwaysOnListening(), 2000);
                        }
                    }
                }, 100);
            } catch (e) {
                console.warn('Error in startAlwaysOnListening:', e);
                // Retry after delay
                setTimeout(() => this.startAlwaysOnListening(), 2000);
            }
        }
    }

    onWakeWord() {
        this.speak('Yes sir, how may I assist you?');
        this.wakeWordDetected = true;
        // Keep listening for the command
    }

    // Display text with typing animation
    displayText(text, callback) {
        if (!this.textElement || !this.displayElement) return;

        // Keep media persistent (Right side) while text displays in center

        // Clear previous animation
        if (this.typingAnimation) {
            clearInterval(this.typingAnimation);
        }

        // Show display
        this.displayElement.classList.add('active');
        this.textElement.textContent = '';

        let index = 0;
        const typingSpeed = 30;

        this.typingAnimation = setInterval(() => {
            if (index < text.length) {
                this.textElement.textContent = text.substring(0, index + 1);
                index++;
            } else {
                clearInterval(this.typingAnimation);
                this.typingAnimation = null;
                this.textElement.innerHTML = text + '<span class="typing-cursor"></span>';
                if (callback) callback();
            }
        }, typingSpeed);
    }

    // Hide text display
    hideText() {
        if (this.displayElement) {
            this.displayElement.classList.remove('active');
        }
        if (this.typingAnimation) {
            clearInterval(this.typingAnimation);
            this.typingAnimation = null;
        }
    }

    // Clean text for speech (remove markdown, symbols, etc.)
    cleanTextForSpeech(text) {
        if (!text) return '';

        // Remove markdown formatting
        let cleaned = text
            .replace(/\*\*(.*?)\*\*/g, '$1')  // Bold **text**
            .replace(/\*(.*?)\*/g, '$1')      // Italic *text*
            .replace(/_(.*?)_/g, '$1')        // Italic _text_
            .replace(/`(.*?)`/g, '$1')        // Code `text`
            .replace(/\[(.*?)\]\(.*?\)/g, '$1') // Links [text](url)
            .replace(/#{1,6}\s/g, '')         // Headers # ## ###
            .replace(/\n{3,}/g, '\n\n')       // Multiple newlines
            .replace(/\*\s/g, '')             // Bullet points
            .replace(/\d+\.\s/g, '')          // Numbered lists
            .replace(/[^\w\s.,!?;:'"()-]/g, ' ') // Remove special symbols except basic punctuation
            .replace(/\s+/g, ' ')             // Multiple spaces
            .trim();

        return cleaned;
    }

    // Text-to-Speech with visual display
    speak(text) {
        // Display original text with typing animation (with formatting)
        this.displayText(text, () => {
            // Text display complete
            this.wakeWordDetected = false;
            // Hide text after a delay
            setTimeout(() => {
                this.hideText();
            }, 3000);
            this.startAlwaysOnListening();
        });

        // When the Gemini Live session is active, ITS audio stream is the
        // voice — stay silent locally to avoid two voices talking over each
        // other. In local mode (no cloud), Windows TTS is the voice.
        if (this.liveService && this.liveService.isConnected) {
            console.log("Jarvis (via Live audio):", text);
            return;
        }

        try {
            // Strip markdown noise so TTS reads clean sentences
            const clean = String(text)
                .replace(/```[\s\S]*?```/g, ' code block omitted ')
                // Citation markers are for the screen, not the ear. Left in,
                // "[n] 1 & 2" was spoken as "and one and two" — and then the
                // mic transcribed it back as a new user turn.
                .replace(/\[\s*n\s*\]/gi, '')
                .replace(/\[\s*\d+(\s*(,|&|and)\s*\d+)*\s*\]/g, '')
                .replace(/[*_#`>|]/g, '')
                .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '') // no emojis, ever
                .replace(/\s+/g, ' ')
                .trim();
            if (!clean) return;

            // Record before speaking so the echo guard is armed even if the
            // mic picks up the very first words.
            this._rememberSpoken(clean);

            // Flush the queue: the newest information wins
            this.synthesis.cancel();

            const utterance = new SpeechSynthesisUtterance(clean);
            if (this.selectedVoice) utterance.voice = this.selectedVoice;
            utterance.rate = this.settings.get('speechRate') || 1.0;
            utterance.pitch = this.settings.get('speechPitch') || 1.0;
            utterance.volume = this.settings.get('speechVolume') || 1.0;

            // Explicit TTS-active flag for the mic gate. Never trust
            // synthesis.speaking — Chromium can leave it stuck true forever,
            // which would permanently deafen the voice loop.
            this.ttsActive = true;
            // Safety net: force-clear even if onend never fires (~400ms/word)
            const maxMs = Math.min(clean.split(/\s+/).length * 450 + 3000, 30000);
            clearTimeout(this._ttsSafetyTimer);
            this._ttsSafetyTimer = setTimeout(() => { this.ttsActive = false; }, maxMs);

            // Chromium bug workaround: synthesis silently pauses on long
            // utterances (~15s). Nudge it with resume() while speaking.
            const resumeTimer = setInterval(() => {
                if (this.synthesis.speaking) this.synthesis.resume();
                else clearInterval(resumeTimer);
            }, 10000);
            utterance.onstart = () => { this.ttsActive = true; };
            utterance.onend = () => {
                clearInterval(resumeTimer);
                this.ttsActive = false;
            };
            utterance.onerror = (e) => {
                clearInterval(resumeTimer);
                this.ttsActive = false;
                console.warn('TTS error:', e.error);
            };

            this.synthesis.speak(utterance);
        } catch (e) {
            console.warn('TTS unavailable:', e);
        }
    }

    // Get location from IP - SECURITY FIX: Use HTTPS endpoint
    async initializeLocation() {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout

            // SECURITY: Using HTTPS instead of HTTP to protect location data
            const response = await fetch('https://ipapi.co/json/', {
                signal: controller.signal,
                cache: 'no-cache'
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = await response.json();
            this.location = {
                city: data.city || 'Unknown',
                country: data.country_name || 'Unknown',
                lat: data.latitude,
                lon: data.longitude
            };
        } catch (error) {
            if (error.name === 'AbortError') {
                console.warn('Location request timed out');
            } else {
                console.warn('Location error:', error.message);
            }
            this.location = { city: 'Unknown', country: 'Unknown' };
        }
    }

    // Get weather
    async initializeWeather() {
        if (!this.location || !this.location.lat) {
            this.weather = { description: 'Unknown', temp: 'N/A' };
            return;
        }

        try {
            // Using OpenWeatherMap
            if (this.openWeatherApiKey === 'YOUR_OPENWEATHER_API_KEY') {
                this.weather = { description: 'Unknown', temp: 'N/A' };
                return;
            }

            const url = `https://api.openweathermap.org/data/2.5/weather?lat=${this.location.lat}&lon=${this.location.lon}&appid=${this.openWeatherApiKey}&units=metric`;

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout

            const response = await fetch(url, {
                signal: controller.signal,
                cache: 'no-cache'
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = await response.json();

            this.weather = {
                description: data.weather[0].description,
                temp: Math.round(data.main.temp)
            };
        } catch (error) {
            if (error.name === 'AbortError') {
                console.warn('Weather request timed out');
            } else {
                console.warn('Weather error:', error.message);
            }
            this.weather = { description: 'Unknown', temp: 'N/A' };
        }
    }

    // Startup greeting
    speakStartupGreeting() {
        // Wait for connection to be ready, then let Gemini do the greeting
        const checkConnection = setInterval(() => {
            if (this.liveService && this.liveService.isConnected) {
                const greeting = this.getAutoGreeting();
                const time = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
                const loc = this.location ? `in ${this.location.city}` : '';

                // Prompt Gemini to give a neural greeting with local context
                this.liveService.sendText(`${greeting}. It's ${time} ${loc}. Please introduce yourself briefly and ask how you can help.`);

                clearInterval(checkConnection);
            }
        }, 1000);

        // UI fallback if connection takes too long
        setTimeout(() => clearInterval(checkConnection), 10000);
    }

    getAutoGreeting() {
        const hr = new Date().getHours();
        if (hr < 12) return 'Good morning sir';
        if (hr < 18) return 'Good afternoon sir';
        return 'Good evening sir';
    }

    // NLP Intent Recognition
    detectIntent(command) {
        const cmd = command.toLowerCase().trim();

        // Phone-targeted commands: "open whatsapp on my phone", "flashlight on
        // my phone". Checked before every desktop matcher, otherwise "open
        // chrome on my phone" opens Chrome on the PC.
        if (targetsPhone(cmd)) {
            const phoneIntent = routePhoneCommand(cmd);
            if (phoneIntent) return { intent: 'PHONE_TOOL', phoneIntent };
        }

        // Companion status. Added because the user repeatedly asked Jarvis
        // "why are you offline in my mobile" and got invented answers ("I will
        // relay this to the command layer") — it had no way to actually look.
        if (/\b(phone|mobile|companion)\b/.test(cmd) &&
            /\b(status|connected|online|offline|linked|why)\b/.test(cmd)) {
            return { intent: 'COMPANION_STATUS' };
        }

        // Android companion pairing
        if (cmd.includes('connect to my mobile') || cmd.includes('connect to my phone') ||
            cmd.includes('install jarvis on my phone') || cmd.includes('pair my phone') ||
            cmd.includes('send yourself to my phone')) {
            return { intent: 'COMPANION_PAIR' };
        }

        // System Control Commands
        if (cmd.includes('open chrome')) return { intent: 'OPEN_APP', app: 'chrome' };
        if (cmd.includes('open notepad')) return { intent: 'OPEN_APP', app: 'notepad' };
        if (cmd.includes('open explorer')) return { intent: 'OPEN_APP', app: 'explorer' };
        if (cmd.includes('open downloads')) return { intent: 'OPEN_APP', app: 'downloads' };
        if (cmd.includes('open vs code') || cmd.includes('open code')) return { intent: 'OPEN_APP', app: 'vscode' };

        // Website / web-app launcher — "open youtube", "go to github",
        // "open netflix.com", "open youtube dot com". Deliberately placed AFTER
        // the desktop-app allowlist above so "open chrome/notepad/explorer/code"
        // still open the native app, not a search for the word. Only fires for a
        // KNOWN site name or a domain-shaped token, so "open the pod bay doors"
        // and "go to sleep" fall through to the AI untouched.
        const siteIntent = this.parseWebsiteIntent(cmd);
        if (siteIntent) return siteIntent;

        if (cmd.includes('shut down') || cmd.includes('shutdown')) return { intent: 'SHUTDOWN' };
        if (cmd.includes('restart')) return { intent: 'RESTART' };
        if (cmd.includes('mute audio')) return { intent: 'MUTE' };
        if (cmd.includes('increase volume')) return { intent: 'VOLUME_UP' };
        if (cmd.includes('increase brightness')) return { intent: 'BRIGHTNESS_UP' };

        // Informational Commands - FALLBACK TO AI FOR NEURAL VOICE
        // if (cmd.includes('what\'s the weather') || cmd.includes('weather')) return { intent: 'WEATHER' };
        // if (cmd.includes('what\'s the time') || cmd.includes('time')) return { intent: 'TIME' };
        // if (cmd.includes('what day') || cmd.includes('day today')) return { intent: 'DAY' };
        // if (cmd.includes('tell me a fact')) return { intent: 'FACT' };
        // if (cmd.includes('tell me a joke')) return { intent: 'JOKE' };
        if (cmd.includes('clear conversation') || cmd.includes('clear history')) return { intent: 'CLEAR_MEMORY' };
        if (cmd.includes('export conversation')) return { intent: 'EXPORT_MEMORY' };

        // Calendar Commands
        if (cmd.includes('set reminder') || cmd.includes('remind me')) {
            const reminderText = cmd.replace(/(?:set reminder|remind me)/i, '').trim();
            return { intent: 'SET_REMINDER', text: reminderText };
        }
        if (cmd.includes('what\'s my schedule') || cmd.includes('show schedule') || cmd.includes('my schedule')) return { intent: 'SHOW_SCHEDULE' };
        if (cmd.includes('add event')) {
            const eventText = cmd.replace(/add event/i, '').trim();
            return { intent: 'ADD_EVENT', text: eventText };
        }

        // Visualizer Mode Commands
        if (cmd.includes('switch to sphere') || cmd.includes('sphere mode')) return { intent: 'VISUALIZER_MODE', mode: 'sphere' };
        if (cmd.includes('switch to cube') || cmd.includes('cube mode')) return { intent: 'VISUALIZER_MODE', mode: 'cube' };
        if (cmd.includes('switch to particles') || cmd.includes('particle mode')) return { intent: 'VISUALIZER_MODE', mode: 'particles' };
        if (cmd.includes('switch to torus') || cmd.includes('torus mode')) return { intent: 'VISUALIZER_MODE', mode: 'torus' };

        // Settings Commands
        if (cmd.includes('change wake word') || cmd.includes('set wake word')) {
            const wakeWord = cmd.match(/wake word (.+)/i)?.[1] || '';
            return { intent: 'SET_WAKE_WORD', word: wakeWord };
        }
        if (cmd.includes('change speech rate') || cmd.includes('set speech rate')) {
            const rate = parseFloat(cmd.match(/rate ([\d.]+)/i)?.[1] || '0.9');
            return { intent: 'SET_SPEECH_RATE', rate };
        }
        if (cmd.includes('show settings')) return { intent: 'SHOW_SETTINGS' };
        if (cmd.includes('reset settings')) return { intent: 'RESET_SETTINGS' };
        if (cmd.includes('change voice') || cmd.includes('set voice')) {
            const voiceName = cmd.replace(/(?:change voice|set voice) (?:to )?/i, '').trim();
            return { intent: 'SET_VOICE', voiceName };
        }
        if (cmd.includes('list voices') || cmd.includes('show voices')) return { intent: 'LIST_VOICES' };

        // Screen Capture Commands
        if (cmd.includes('take screenshot') || cmd.includes('screenshot')) return { intent: 'SCREENSHOT' };
        // Screen reading — captures the ACTUAL question so Gemma vision answers
        // specifically ("what error is showing" vs "read the code" vs "what's this").
        if (/\b(can you see|look at|read|what('?s| is)? ?(on|showing on)|what am i (looking at|seeing)|describe|analyz|check)\b[^.]*\b(screen|display|monitor)\b/.test(cmd) ||
            cmd.includes('read my screen') || cmd.includes('see my screen') || cmd.includes('read the screen') ||
            cmd.includes('what is on the screen') || cmd.includes("what's on the screen") ||
            /\b(what does|what's|read)\b.*\b(this|that|it)\b.*\b(say|says|mean)\b/.test(cmd)) {
            return { intent: 'READ_SCREEN', question: command };
        }
        if (cmd.includes('phone setup') || cmd.includes('phone bridge') || cmd.includes('connect my phone') || cmd.includes('pair my phone')) return { intent: 'PHONE_SETUP' };
        if (cmd.includes('scan') && (cmd.includes('wifi') || cmd.includes('wi-fi') || cmd.includes('network'))) return { intent: 'WIFI_SCAN' };
        if (cmd.includes('available networks') || cmd === 'list wifi') return { intent: 'WIFI_SCAN' };
        // Disconnect — checked before the connect matcher so "disconnect" wins
        if (/\b(disconnect|drop)\b.*\b(wifi|wi-fi|network|internet|connection)\b/.test(cmd) ||
            cmd === 'disconnect' || cmd === 'disconnect wifi' || cmd === 'disconnect the wifi') {
            return { intent: 'WIFI_DISCONNECT' };
        }
        // Network / device intelligence — real measured data about the current
        // connection (the "device" you connect to over Wi-Fi is the hotspot/router)
        if (/\b(which (wi-?fi|network)|what (wi-?fi|network))\b.*\b(am i|connected)\b/.test(cmd) ||
            /\b(network|wi-?fi|connection|internet)\s+(info|information|details|status|quality|speed|health)\b/.test(cmd) ||
            /\b(why is|is (my|the))\s+(wi-?fi|internet|connection|network)\s+(slow|unstable|bad|down)\b/.test(cmd) ||
            /\b(how('s| is) my (wi-?fi|internet|connection|network))\b/.test(cmd) ||
            /\b(test|check)\s+(my\s+)?(connection|internet|network|wi-?fi)\b/.test(cmd) ||
            (/(tell me|information|info|details|about)/.test(cmd) && /(device|network|connection|hotspot|router)/.test(cmd) && /(connect|wi-?fi|current)/.test(cmd))) {
            return { intent: 'WIFI_INFO' };
        }
        // "connect to <specific network name>" -> Wi-Fi connect (checked BEFORE
        // the generic settings matcher so named networks take priority)
        const wifiConnectMatch = cmd.match(/connect\s+(?:me\s+)?(?:to|with)\s+(?:my\s+|the\s+)?(.+)/);
        if (wifiConnectMatch) {
            let name = wifiConnectMatch[1]
                .replace(/\b(device|hotspot|wifi|wi-fi|network|phone)\b/g, '')
                .replace(/\s+/g, ' ').trim();
            // Bare "connect to wifi/bluetooth" (no name) falls through to settings
            if (name && !/^(wifi|wi-fi|bluetooth|internet)$/.test(name)) {
                return { intent: 'WIFI_CONNECT', name };
            }
        }
        const settingsMatch = cmd.match(/\b(?:turn (?:on|off)|open|enable|disable|connect(?: to)?)\s+(?:my\s+)?(wifi|wi-fi|bluetooth|sound|display|battery|notifications?)\b/);
        if (settingsMatch) {
            let page = settingsMatch[1].replace('wi-fi', 'wifi');
            if (page === 'notification') page = 'notifications';
            return { intent: 'OPEN_SETTINGS', page };
        }
        if (cmd.includes('use laptop mic') || cmd.includes('use internal mic') || cmd.includes('use built-in mic') || cmd.includes('use laptop microphone') || cmd.includes('use internal microphone')) return { intent: 'MIC_INTERNAL' };
        if (cmd.includes('use earbuds mic') || cmd.includes('use headset mic') || cmd.includes('use earbuds microphone') || cmd.includes('use headset microphone')) return { intent: 'MIC_HEADSET' };
        if (cmd.includes('which mic') || cmd.includes('which microphone') || cmd.includes('what microphone')) return { intent: 'MIC_WHICH' };
        if (cmd.includes('earbuds') || cmd.includes('earbud') || cmd.includes('headphone battery') || cmd.includes('bluetooth battery') || cmd.includes('bluetooth status')) return { intent: 'EARBUDS_STATUS' };
        if (cmd.includes('meeting mode') || cmd.includes('joining a meeting') || cmd.includes('join a meeting')) return { intent: 'MEETING_MODE' };
        if (cmd.includes('volume down') || cmd.includes('lower the volume') || cmd.includes('decrease volume')) return { intent: 'VOLUME_DOWN' };
        const rememberMatch = cmd.match(/^(?:please\s+)?(?:remember|note)(?:\s+that)?\s+(.{3,})/);
        if (rememberMatch) return { intent: 'REMEMBER', text: rememberMatch[1] };
        const recallMatch = cmd.match(/(?:what do you (?:remember|know) about|do you remember|recall)\s+(.{2,})/);
        if (recallMatch) return { intent: 'RECALL', query: recallMatch[1] };
        if (cmd.includes('pause music') || cmd.includes('play music') || cmd.includes('pause the music') || cmd.includes('resume music')) return { intent: 'MEDIA_PLAYPAUSE' };
        if (cmd.includes('next track') || cmd.includes('next song') || cmd.includes('skip song') || cmd.includes('skip track')) return { intent: 'MEDIA_NEXT' };
        if (cmd.includes('previous track') || cmd.includes('previous song') || cmd.includes('last song')) return { intent: 'MEDIA_PREV' };

        // Secure key storage: handled locally, NEVER forwarded to any LLM
        if (cmd.startsWith('store key ') || cmd.startsWith('set key ')) return { intent: 'SET_KEY', raw: command };
        if (cmd === 'list keys' || cmd === 'list my keys') return { intent: 'LIST_KEYS' };

        // Finance watchlist
        if (cmd.includes('watchlist') || cmd.startsWith('watch ')) {
            if (cmd.includes('remove') || cmd.includes('delete')) {
                const rm = cmd.match(/(?:remove|delete)\s+([a-z0-9.\-]{1,15})/);
                if (rm) return { intent: 'WATCHLIST_REMOVE', symbol: rm[1] };
            }
            const add = cmd.match(/(?:add|watch)\s+([a-z0-9.\-]{1,15})/);
            if (add && add[1] !== 'my' && !cmd.match(/^(?:show|open|read)/)) {
                const target = cmd.match(/(?:at|target(?:\s+of)?|above)\s+\$?([\d,]+(?:\.\d+)?)/);
                const stop = cmd.match(/(?:stop(?:\s+loss)?|below)\s+\$?([\d,]+(?:\.\d+)?)/);
                return {
                    intent: 'WATCHLIST_ADD',
                    symbol: add[1],
                    target: target ? parseFloat(target[1].replace(/,/g, '')) : null,
                    stop: stop ? parseFloat(stop[1].replace(/,/g, '')) : null
                };
            }
            return { intent: 'WATCHLIST_SHOW' };
        }

        // On-chain reads — "balance of 0x… on arbitrum", "gas on arbitrum",
        // "USDC balance of 0x…", "how many transactions has 0x… made". Answered
        // from live public RPC and formatted by the DETERMINISTIC onchain engine
        // (BigInt/decimals) — never estimated by the model. Checked early because
        // a 0x address (or a bare "gas on <chain>") is an unambiguous signal.
        const chainQ = this.parseOnchainQuery(cmd);
        if (chainQ) return { intent: 'CHAIN_QUERY', ...chainQ };

        // Quant analytics — "sharpe ratio of Apple", "volatility of Tesla",
        // "how risky is Nvidia", "max drawdown of Bitcoin", "beta of Tesla",
        // "analyze Apple". Computed by the DETERMINISTIC quant engine over real
        // historical prices — never estimated by the model. Checked before the
        // price query so a metric question wins over a bare price.
        const quantQ = this.parseQuantQuery(cmd);
        if (quantQ) return { intent: 'QUANT_QUERY', metric: quantQ.metric, entity: quantQ.entity };

        // Live price query — "price of Tesla", "how much is Bitcoin", "AAPL stock
        // price", "what's Apple trading at". Answered from the reliable Yahoo
        // quote endpoint, NOT the web-search fallback that used to field these and
        // returned stale snippet text. Checked before news so "Tesla stock price"
        // is a quote, not a headline search.
        const priceEntity = this.parsePriceQuery(cmd);
        if (priceEntity) return { intent: 'PRICE_QUERY', entity: priceEntity };

        // News / latest updates — "latest news", "news about Tesla", "what's
        // happening with AI". Empty topic means top headlines. Uses the keyless
        // Google News RSS feed with real timestamps and sources.
        const news = this.parseNewsQuery(cmd);
        if (news) return { intent: 'NEWS_QUERY', topic: news.topic };

        // Usage / self-report — surfaces the interaction log so the improvement
        // loop is visible from inside Jarvis ("how am I using you", "usage stats").
        if (/\b(usage stats|interaction stats|how am i using you|how are you performing|self ?report|show (my )?(usage|stats)|your stats)\b/.test(cmd))
            return { intent: 'USAGE_STATS' };

        // Memory consolidation ("sleep") — distill durable facts from recent
        // experience into long-term memory and surface self-improvement notes.
        if (/\b(reflect|consolidate (your )?memory|learn from (today|our (chat|conversation|interactions))|go to sleep and learn|self.?improve|review your memory)\b/.test(cmd))
            return { intent: 'REFLECT' };
        // Read back what consolidation has produced.
        if (/\bwhat (have|did) you learn(ed|t)?\b|\bwhat do you (know|remember) about me\b/.test(cmd))
            return { intent: 'WHAT_LEARNED' };

        // File Operation Commands
        if (cmd.includes('create folder') || cmd.includes('make folder')) {
            const folderName = cmd.match(/folder (?:named )?([^ ]+)/i)?.[1] || 'NewFolder';
            return { intent: 'CREATE_FOLDER', name: folderName };
        }
        if (cmd.includes('delete file')) {
            const fileName = cmd.match(/file ([^ ]+)/i)?.[1] || '';
            return { intent: 'DELETE_FILE', name: fileName };
        }
        if (cmd.includes('list files') || cmd.includes('show files')) {
            const location = cmd.match(/in (.+)/i)?.[1] || 'Downloads';
            return { intent: 'LIST_FILES', location };
        }
        if (cmd.includes('search for file')) {
            const fileName = cmd.match(/file (.+)/i)?.[1] || '';
            return { intent: 'SEARCH_FILE', name: fileName };
        }

        // Web Commands
        if (cmd.includes('open website') || cmd.includes('open url')) {
            const url = cmd.match(/(?:website|url) (.+)/i)?.[1] || '';
            return { intent: 'OPEN_WEBSITE', url };
        }
        if (cmd.includes('search google')) {
            const query = cmd.replace(/search google for/i, '').trim();
            return { intent: 'SEARCH_GOOGLE', query };
        }

        // Clipboard Commands
        if (cmd.includes('read clipboard') || cmd.includes('what\'s in clipboard')) return { intent: 'READ_CLIPBOARD' };
        if (cmd.includes('copy to clipboard')) {
            const text = cmd.replace(/copy to clipboard/i, '').trim();
            return { intent: 'WRITE_CLIPBOARD', text };
        }

        // Window Control Commands
        if (cmd.includes('minimize window')) return { intent: 'MINIMIZE_WINDOW' };
        if (cmd.includes('maximize window')) return { intent: 'MAXIMIZE_WINDOW' };
        if (cmd.includes('close window')) return { intent: 'CLOSE_WINDOW' };

        // Camera Commands
        if (cmd.includes('turn on camera') || cmd.includes('activate camera') || cmd.includes('show camera')) return { intent: 'CAMERA_ON' };
        if (cmd.includes('turn off camera') || cmd.includes('deactivate camera') || cmd.includes('hide camera')) return { intent: 'CAMERA_OFF' };

        // Neural Link Control
        if (cmd.includes('connect') && (cmd.includes('neural') || cmd.includes('link') || cmd.includes('ai'))) return { intent: 'NEURAL_LINK_ON' };
        if (cmd.includes('disconnect') && (cmd.includes('neural') || cmd.includes('link') || cmd.includes('ai'))) return { intent: 'NEURAL_LINK_OFF' };
        if (cmd.includes('stop') && (cmd.includes('ai') || cmd.includes('talking') || cmd.includes('everything'))) return { intent: 'NEURAL_LINK_OFF' };

        // Smart AI Commands (will use GPT)
        if (cmd.includes('summarize') || cmd.includes('explain') || cmd.includes('translate') ||
            cmd.includes('improve') || cmd.includes('solve') || cmd.includes('generate') ||
            cmd.includes('create') || cmd.includes('search')) {
            return { intent: 'AI_COMMAND', query: command };
        }

        // Default to AI command for unknown intents
        return { intent: 'AI_COMMAND', query: command };
    }

    // Process Command
    async processCommand(command) {
        this.isProcessing = true;

        if (this.recognition) {
            this.recognition.stop();
        }

        // Re-enable command input when done
        if (this.commandInput) {
            this.commandInput.disabled = false;
        }

        // Per-stage profiling starts before intent detection so the routing cost
        // itself is measured, not assumed.
        perf.startTurn();
        const _intentT0 = Date.now();
        const intent = this.detectIntent(command);
        perf.stage('intent', Date.now() - _intentT0);
        console.log('Intent:', intent);

        // Interaction-log bookkeeping: reset this turn's response buffer (filled
        // by _rememberSpoken) and start the latency clock.
        const _turnStartedAt = Date.now();
        this._turnResponse = '';
        let _turnOk = true;

        try {
            switch (intent.intent) {
                case 'PHONE_TOOL':
                    await this.handlePhoneTool(intent.phoneIntent);
                    break;
                case 'COMPANION_STATUS':
                    await this.handleCompanionStatus();
                    break;
                case 'COMPANION_PAIR':
                    this.speak('Opening the pairing window sir. Scan the code with your phone.');
                    window.jarvisCompanion?.open();
                    break;
                case 'OPEN_APP':
                    await this.handleOpenApp(intent.app);
                    break;
                case 'SHUTDOWN':
                    await this.handleShutdown();
                    break;
                case 'RESTART':
                    await this.handleRestart();
                    break;
                case 'MUTE':
                    await this.handleMute();
                    break;
                case 'VOLUME_UP':
                    await this.handleVolumeUp();
                    break;
                case 'BRIGHTNESS_UP':
                    await this.handleBrightnessUp();
                    break;
                case 'WEATHER':
                    await this.handleWeather();
                    break;
                case 'TIME':
                    await this.handleTime();
                    break;
                case 'DAY':
                    await this.handleDay();
                    break;
                case 'CLEAR_MEMORY':
                    await this.handleClearMemory();
                    break;
                case 'EXPORT_MEMORY':
                    await this.handleExportMemory();
                    break;
                case 'SCREENSHOT':
                    await this.handleScreenshot();
                    break;
                case 'READ_SCREEN':
                    await this.handleReadScreen(intent.question);
                    break;
                case 'PHONE_SETUP':
                    await this.handlePhoneBridgeSetup();
                    break;
                case 'EARBUDS_STATUS':
                    await this.handleEarbudsStatus();
                    break;
                case 'MIC_INTERNAL':
                    if (this.localVoice) { this.localVoice.setMicPreference('internal'); this.speak('Switching to the internal microphone.'); }
                    break;
                case 'MIC_HEADSET':
                    if (this.localVoice) { this.localVoice.setMicPreference('headset'); this.speak('Switching to the earbuds microphone.'); }
                    break;
                case 'MIC_WHICH':
                    this.speak(this.localVoice?.currentMicLabel
                        ? `I am listening through: ${this.localVoice.currentMicLabel}.`
                        : 'Voice input is not active.');
                    break;
                case 'OPEN_SETTINGS':
                    if (window.electronAPI?.openSettings) {
                        await window.electronAPI.openSettings(intent.page);
                        this.speak(`I cannot toggle ${intent.page} directly without administrator rights, Sir - opening the ${intent.page} settings for you instead.`);
                    }
                    break;
                case 'VOLUME_DOWN':
                    window.electronAPI?.systemCommand('volume-down');
                    this.speak('Volume decreased.');
                    break;
                case 'WIFI_SCAN':
                    await this.handleWifiScan();
                    break;
                case 'WIFI_CONNECT':
                    await this.handleWifiConnect(intent.name);
                    break;
                case 'WIFI_DISCONNECT':
                    await this.handleWifiDisconnect();
                    break;
                case 'WIFI_INFO':
                    await this.handleWifiInfo();
                    break;
                case 'REMEMBER': {
                    const r = await ragService.ingest(intent.text, { source: 'voice-note' });
                    this.speak(r.stored ? 'Noted and stored, Sir.' : 'I already have that in memory, Sir.');
                    break;
                }
                case 'RECALL': {
                    const { context, results } = await ragService.recall(intent.query);
                    if (!results.length && !context) {
                        this.speak(`I have nothing in memory about ${intent.query}, Sir.`);
                    } else {
                        this.displayText(context.slice(0, 800), null);
                        this.speak(results[0] ? results[0].text.slice(0, 250) : context.slice(0, 250));
                    }
                    break;
                }
                case 'MEETING_MODE':
                    await this.handleMeetingMode();
                    break;
                case 'MEDIA_PLAYPAUSE':
                    window.electronAPI?.systemCommand('play-pause');
                    this.speak('Done.');
                    break;
                case 'MEDIA_NEXT':
                    window.electronAPI?.systemCommand('next-track');
                    this.speak('Next track.');
                    break;
                case 'MEDIA_PREV':
                    window.electronAPI?.systemCommand('prev-track');
                    this.speak('Previous track.');
                    break;
                case 'SET_KEY':
                    await this.handleStoreKey(intent.raw);
                    break;
                case 'LIST_KEYS':
                    await this.handleListKeys();
                    break;
                case 'WATCHLIST_ADD':
                    await this.handleWatchlistAdd(intent.symbol, intent.target, intent.stop);
                    break;
                case 'WATCHLIST_REMOVE':
                    await this.handleWatchlistRemove(intent.symbol);
                    break;
                case 'WATCHLIST_SHOW':
                    await this.handleWatchlistShow();
                    break;
                case 'QUANT_QUERY':
                    await this.handleQuantQuery(intent.metric, intent.entity);
                    break;
                case 'CHAIN_QUERY':
                    await this.handleOnchainQuery(intent);
                    break;
                case 'PRICE_QUERY':
                    await this.handlePriceQuery(intent.entity);
                    break;
                case 'NEWS_QUERY':
                    await this.handleNewsQuery(intent.topic);
                    break;
                case 'USAGE_STATS':
                    await this.handleUsageStats();
                    break;
                case 'REFLECT':
                    await this.handleReflect();
                    break;
                case 'WHAT_LEARNED':
                    await this.handleWhatLearned();
                    break;
                case 'CREATE_FOLDER':
                    await this.handleCreateFolder(intent.name);
                    break;
                case 'DELETE_FILE':
                    await this.handleDeleteFile(intent.name);
                    break;
                case 'LIST_FILES':
                    await this.handleListFiles(intent.location);
                    break;
                case 'SEARCH_FILE':
                    await this.handleSearchFile(intent.name);
                    break;
                case 'OPEN_WEBSITE':
                    await this.handleOpenWebsite(intent.url, intent.label);
                    break;
                case 'SEARCH_GOOGLE':
                    await this.handleSearchGoogle(intent.query);
                    break;
                case 'READ_CLIPBOARD':
                    await this.handleReadClipboard();
                    break;
                case 'WRITE_CLIPBOARD':
                    await this.handleWriteClipboard(intent.text);
                    break;
                case 'MINIMIZE_WINDOW':
                    await this.handleMinimizeWindow();
                    break;
                case 'MAXIMIZE_WINDOW':
                    await this.handleMaximizeWindow();
                    break;
                case 'CLOSE_WINDOW':
                    await this.handleCloseWindow();
                    break;
                case 'CAMERA_ON':
                    await this.toggleCamera(true);
                    break;
                case 'CAMERA_OFF':
                    await this.toggleCamera(false);
                    break;
                case 'SET_REMINDER':
                    await this.handleSetReminder(intent.text);
                    break;
                case 'SHOW_SCHEDULE':
                    await this.handleShowSchedule();
                    break;
                case 'ADD_EVENT':
                    await this.handleAddEvent(intent.text);
                    break;
                case 'VISUALIZER_MODE':
                    await this.handleVisualizerMode(intent.mode);
                    break;
                case 'SET_WAKE_WORD':
                    await this.handleSetWakeWord(intent.word);
                    break;
                case 'SET_SPEECH_RATE':
                    await this.handleSetSpeechRate(intent.rate);
                    break;
                case 'SHOW_SETTINGS':
                    await this.handleShowSettings();
                    break;
                case 'RESET_SETTINGS':
                    await this.handleResetSettings();
                    break;
                case 'NEURAL_LINK_ON':
                    this.displayText("Initiating neural link...", null);
                    await this.liveService.connect();
                    break;
                case 'NEURAL_LINK_OFF':
                    this.displayText("Severing neural link. Systems dormant.", null);
                    await this.liveService.disconnect();
                    break;
                case 'SET_VOICE':
                    await this.handleSetVoice(intent.voiceName);
                    break;
                case 'LIST_VOICES':
                    await this.handleListVoices();
                    break;
                case 'FACT':
                case 'JOKE':
                    await this.handleAICommand(command);
                    break;
                case 'AI_COMMAND':
                    await this.handleAICommand(command);
                    break;
                default:
                    await this.handleAICommand(command);
            }
        } catch (error) {
            console.error('Command processing error:', error);
            _turnOk = false;
            this.speak('I apologize, but I encountered an error processing that command.');
        } finally {
            // Persist the turn for later analysis before releasing the loop.
            this._logInteraction(command, intent, _turnStartedAt, _turnOk);
            this.isProcessing = false;
            this.wakeWordDetected = false;
            if (this.commandInput) {
                this.commandInput.disabled = false;
            }
            this.startAlwaysOnListening();
        }
    }

    // System Control Handlers
    async handleOpenApp(app) {
        if (window.electronAPI) {
            window.electronAPI.openApp(app);
            this.speak(`Opening ${app}`);
        } else {
            this.speak(`I cannot open ${app} in this environment`);
        }
    }

    async handleShutdown() {
        this.speak('Shutting down the system');
        setTimeout(() => {
            if (window.electronAPI) {
                window.electronAPI.systemCommand('shutdown');
            }
        }, 2000);
    }

    async handleRestart() {
        this.speak('Restarting the system');
        setTimeout(() => {
            if (window.electronAPI) {
                window.electronAPI.systemCommand('restart');
            }
        }, 2000);
    }

    async handleMute() {
        if (window.electronAPI) {
            window.electronAPI.systemCommand('mute');
            this.speak('Audio muted');
        }
    }

    async handleVolumeUp() {
        if (window.electronAPI) {
            window.electronAPI.systemCommand('volume-up');
            this.speak('Volume increased');
        }
    }

    async handleBrightnessUp() {
        if (window.electronAPI) {
            window.electronAPI.systemCommand('brightness-up');
            this.speak('Brightness increased');
        }
    }

    // Informational Handlers
    async handleWeather() {
        if (this.weather) {
            this.speak(`The weather is ${this.weather.description} with ${this.weather.temp} degrees`);
        } else {
            await this.initializeWeather();
            this.handleWeather();
        }
    }

    async handleTime() {
        const time = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
        this.speak(`It's ${time}`);
    }

    async handleDay() {
        const day = new Date().toLocaleDateString('en-US', { weekday: 'long' });
        this.speak(`Today is ${day}`);
    }

    async handleClearMemory() {
        this.memory.clearHistory();
        this.speak('Conversation history cleared');
    }

    async handleExportMemory() {
        const historyText = this.memory.exportHistory('text');
        if (historyText) {
            // Create download link
            const blob = new Blob([historyText], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `jarvis-conversation-${new Date().toISOString().split('T')[0]}.txt`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            this.speak('Conversation history exported');
        } else {
            this.speak('No conversation history to export');
        }
    }

    // Screen Capture Handlers
    async handleScreenshot() {
        try {
            if (window.electronAPI && window.electronAPI.captureScreen) {
                const result = await window.electronAPI.captureScreen();
                this.speak('Screenshot captured');
            } else {
                this.speak('Screenshot functionality not available');
            }
        } catch (error) {
            console.error('Screenshot error:', error);
            this.speak('Failed to capture screenshot');
        }
    }

    // Screen Analysis Handler
    // Prefers local Unlimited-OCR (private, structured Markdown) when the
    // SGLang server is up; falls back to Gemini Vision otherwise.
    // Read the screen: screenshot -> base64 -> local Gemma vision -> spoken
    // answer. Fully offline (gemma3 is multimodal). Answers the user's ACTUAL
    // question ("what error is showing?") rather than a fixed prompt.
    async handleReadScreen(question) {
        try {
            if (!window.electronAPI || !window.electronAPI.captureScreen) {
                this.speak('Screen capture is not available in this environment.');
                return;
            }

            this.speak('Let me take a look, Sir.');
            this.displayText('Capturing and reading your screen...', null);

            const shot = await window.electronAPI.captureScreen();
            if (!shot?.success || !shot.image) {
                this.speak('I could not capture your screen.');
                return;
            }

            // Build a focused prompt from what the user actually asked. Strip the
            // "read my screen" scaffolding so the real intent reaches the model.
            const cleaned = String(question || '')
                .replace(/\b(hey )?jarvis\b/gi, '')
                .replace(/\b(can you |could you |please )?/gi, '')
                .replace(/\b(read|look at|see|check|analyze|describe)\b/gi, '')
                .replace(/\b(my |the |on )?(screen|display|monitor)\b/gi, '')
                .replace(/[?.!]+$/, '').trim();
            const prompt = cleaned.length > 3
                ? `Looking at this screenshot of my screen: ${cleaned}. Answer concisely and specifically from what is visible. This is spoken aloud, so keep it under 3 sentences.`
                : 'Concisely describe what is on this screen: the application or content, and the key visible text or state. This is spoken aloud, so keep it under 3 sentences.';

            let answer;
            try {
                answer = await describeImageLocal(shot.image, prompt);
            } catch (e) {
                console.warn('Gemma vision failed:', e.message);
                // Optional fallback: dense-text OCR server, if the user runs one.
                if (await this.screenCapture.isOcrAvailable()) {
                    const md = await this.screenCapture.captureAndRead();
                    this.displayText(md.slice(0, 600), null);
                    this.speak('I read the text on your screen. It is displayed for you.');
                    return;
                }
                this.speak('I could not read the screen. Is the local model running?');
                return;
            }

            if (!answer) {
                this.speak('I looked, but could not make out the screen clearly.');
                return;
            }

            this.memory.addMessage('assistant', `Screen read: ${answer}`);
            this.displayText(answer, null);
            this.speak(answer);
        } catch (error) {
            console.error('Screen read error:', error);
            this.speak('I ran into an error reading your screen.');
        }
    }

    // File Operation Handlers
    async handleCreateFolder(name) {
        try {
            if (window.electronAPI && window.electronAPI.fileOperation) {
                let homedir = 'C:\\Users\\User';
                if (window.electronAPI.getOSInfo) {
                    const osInfo = await window.electronAPI.getOSInfo();
                    homedir = osInfo.homedir;
                }
                const downloadsPath = `${homedir}\\Downloads\\${name}`;
                const result = await window.electronAPI.fileOperation('create-folder', downloadsPath);
                if (result.success) {
                    this.speak(`Folder ${name} created in Downloads`);
                } else {
                    this.speak('Failed to create folder');
                }
            } else {
                this.speak('File operations not available');
            }
        } catch (error) {
            console.error('Create folder error:', error);
            this.speak('Failed to create folder');
        }
    }

    async handleDeleteFile(name) {
        try {
            if (window.electronAPI && window.electronAPI.fileOperation) {
                const result = await window.electronAPI.fileOperation('delete-file', name);
                if (result.success) {
                    this.speak(`File ${name} deleted`);
                } else {
                    this.speak('Failed to delete file');
                }
            } else {
                this.speak('File operations not available');
            }
        } catch (error) {
            console.error('Delete file error:', error);
            this.speak('Failed to delete file');
        }
    }

    async handleListFiles(location) {
        try {
            if (window.electronAPI && window.electronAPI.fileOperation) {
                let homedir = 'C:\\Users\\User';
                if (window.electronAPI.getOSInfo) {
                    const osInfo = await window.electronAPI.getOSInfo();
                    homedir = osInfo.homedir;
                }
                const locationMap = {
                    'downloads': `${homedir}\\Downloads`,
                    'desktop': `${homedir}\\Desktop`,
                    'documents': `${homedir}\\Documents`
                };
                const dirPath = locationMap[location.toLowerCase()] || location;
                const result = await window.electronAPI.fileOperation('list-files', dirPath);
                if (result.success && result.files) {
                    const fileList = result.files.slice(0, 10).join(', ');
                    this.speak(`Files in ${location}: ${fileList}`);
                } else {
                    this.speak('Failed to list files');
                }
            } else {
                this.speak('File operations not available');
            }
        } catch (error) {
            console.error('List files error:', error);
            this.speak('Failed to list files');
        }
    }

    async handleSearchFile(name) {
        try {
            if (window.electronAPI && window.electronAPI.fileOperation) {
                let homedir = 'C:\\Users\\User';
                if (window.electronAPI.getOSInfo) {
                    const osInfo = await window.electronAPI.getOSInfo();
                    homedir = osInfo.homedir;
                }
                const downloadsPath = `${homedir}\\Downloads`;
                const result = await window.electronAPI.fileOperation('search-files', downloadsPath, name);
                if (result.success && result.files.length > 0) {
                    const fileList = result.files.slice(0, 5).join(', ');
                    this.speak(`Found files: ${fileList}`);
                } else {
                    this.speak('No files found');
                }
            } else {
                this.speak('File operations not available');
            }
        } catch (error) {
            console.error('Search file error:', error);
            this.speak('Failed to search for file');
        }
    }

    // Common sites addressable by name. Bare spoken words ("open youtube") map
    // to a canonical URL here; anything domain-shaped ("open foo.com") is opened
    // directly and does not need an entry. Keys are lowercased and stripped of
    // non-alphanumerics, so "you tube" and "youtube" both resolve.
    static KNOWN_SITES = {
        youtube: 'youtube.com', yt: 'youtube.com',
        google: 'google.com', gmail: 'mail.google.com', gemini: 'gemini.google.com',
        maps: 'maps.google.com', googlemaps: 'maps.google.com', drive: 'drive.google.com',
        calendar: 'calendar.google.com', photos: 'photos.google.com',
        facebook: 'facebook.com', fb: 'facebook.com', instagram: 'instagram.com', insta: 'instagram.com',
        twitter: 'twitter.com', x: 'x.com', reddit: 'reddit.com', linkedin: 'linkedin.com',
        whatsapp: 'web.whatsapp.com', telegram: 'web.telegram.org', discord: 'discord.com',
        github: 'github.com', gitlab: 'gitlab.com', stackoverflow: 'stackoverflow.com',
        netflix: 'netflix.com', primevideo: 'primevideo.com', hotstar: 'hotstar.com',
        spotify: 'open.spotify.com', twitch: 'twitch.tv', amazon: 'amazon.com',
        flipkart: 'flipkart.com', wikipedia: 'wikipedia.org', chatgpt: 'chat.openai.com',
        claude: 'claude.ai', perplexity: 'perplexity.ai',
    };

    // Parse an "open/go to/visit <target>" command into an OPEN_WEBSITE intent,
    // or null when the target is neither a known site nor domain-shaped (so the
    // caller lets it fall through to the AI). Kept pure and side-effect free —
    // it only classifies.
    parseWebsiteIntent(cmd) {
        const m = cmd.match(/^(?:open|launch|go to|goto|navigate to|visit|pull up|bring up)\s+(.+)$/i);
        if (!m) return null;

        let target = m[1].trim()
            .replace(/\s+(?:for me|please|now|thanks)\s*$/i, '')
            .replace(/^(?:the|my|a)\s+/i, '')
            .replace(/^(?:website|url|site|web ?site|web page|page)\s+/i, '')
            .replace(/\s+(?:website|site|web ?site|web page|page)\s*$/i, '')
            .trim();
        if (!target) return null;

        // Spoken domains: "youtube dot com" -> "youtube.com".
        const spoken = target.toLowerCase().replace(/\s+dot\s+/g, '.').replace(/\s+/g, '');

        // Known site by name (punctuation/space-insensitive).
        const key = target.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (Jarvis.KNOWN_SITES[key]) {
            return { intent: 'OPEN_WEBSITE', url: `https://${Jarvis.KNOWN_SITES[key]}`, label: key };
        }

        // Domain-shaped token: at least one dot and a 2+ letter TLD. This is what
        // lets ANY website work ("open example.org", "open my.company.co.uk")
        // without being enumerated above.
        if (/^(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(\/[^\s]*)?$/i.test(spoken)) {
            const url = spoken.startsWith('http') ? spoken : `https://${spoken}`;
            let label = spoken.replace(/^https?:\/\//, '').split('/')[0];
            return { intent: 'OPEN_WEBSITE', url, label };
        }

        // A bare, unknown word ("open spotify-ish nonsense"): not confidently a
        // website. Fall through rather than guess.
        return null;
    }

    // Parse a spoken price question into the asset name/ticker, or null. Anchored
    // on explicit market words (price/stock/share/trading/quote) so everyday
    // "how much is a coffee" does not trigger a stock lookup. The entity is left
    // as spoken text — electron's resolveSymbol() maps "tesla" -> TSLA.
    parsePriceQuery(cmd) {
        const clean = (s) => s && s.replace(/[?.!,]+$/, '')
            .replace(/\b(stock|shares?|price|quote|cost|right now|now|today|please|currently)\b/gi, '')
            .replace(/^\s*(?:of|for|the|a)\s+/i, '').replace(/\s+/g, ' ').trim();
        let m;
        if ((m = cmd.match(/\b(?:price|quote)\s+(?:of|for)\s+(.+)/i))) return clean(m[1]) || null;
        if ((m = cmd.match(/\b(.+?)\s+(?:stock|share)\s+price\b/i))) return clean(m[1]) || null;
        if ((m = cmd.match(/\bhow much (?:is|are|does)\s+(.+?)(?:\s+cost|\s+worth|\s+trading|\s+stock|\s+shares?)?\s*\??$/i))
            && /\b(stock|shares?|worth|trading|cost|price)\b/i.test(cmd)) return clean(m[1]) || null;
        if ((m = cmd.match(/\bwhat(?:'s| is)\s+(.+?)\s+(?:stock\s+)?(?:trading at|worth|at now|priced at)\b/i))) return clean(m[1]) || null;
        if ((m = cmd.match(/\bhow(?:'s| is)\s+(.+?)\s+(?:stock|shares?)\s+doing\b/i))) return clean(m[1]) || null;
        return null;
    }

    // Parse a quant-analytics request into { metric, entity } or null. Metric is
    // one of: sharpe|sortino|volatility|drawdown|beta|return|summary. The entity
    // is spoken text (resolveSymbol maps it to a ticker on the main side).
    parseQuantQuery(cmd) {
        const clean = (s) => s && s.replace(/[?.!,]+$/, '')
            .replace(/\b(stock|shares?|the|a|please|now|right now|currently|over the (last|past) (year|month))\b/gi, '')
            .replace(/^\s*(?:of|for)\s+/i, '').replace(/\s+/g, ' ').trim();
        const METRIC = {
            sharpe: /\bsharpe\b/i, sortino: /\bsortino\b/i,
            volatility: /\b(volatility|volatile|std ?dev|standard deviation)\b/i,
            drawdown: /\b(max(imum)? )?drawdown\b/i,
            beta: /\b(beta|alpha)\b/i,
            return: /\b(annual(ized)? return|cagr|performance)\b/i,
        };
        let m;
        // "<metric> of <entity>" / "<metric> for <entity>"
        if ((m = cmd.match(/\b(sharpe( ratio)?|sortino( ratio)?|volatility|beta|alpha|max(imum)? drawdown|drawdown|annual(ized)? return|cagr)\s+(?:of|for|on)\s+(.+)/i))) {
            const entity = clean(m[m.length - 1]);
            if (entity) return { metric: this._metricOf(m[1], METRIC), entity };
        }
        // "how risky / how volatile is <entity>"
        if ((m = cmd.match(/\bhow\s+(risky|volatile)\s+is\s+(.+)/i))) {
            const entity = clean(m[2]);
            if (entity) return { metric: m[1].toLowerCase() === 'volatile' ? 'volatility' : 'summary', entity };
        }
        // "analyze / risk analysis of <entity>"
        if ((m = cmd.match(/\b(?:analyz|analys)e?\s+(.+)|(?:risk|quant)\s+analysis\s+(?:of|for)\s+(.+)/i))) {
            const entity = clean(m[1] || m[2]);
            if (entity && METRIC && !/[?]/.test(entity)) return { metric: 'summary', entity };
        }
        // trailing form: "<entity> sharpe / volatility / beta"
        if ((m = cmd.match(/^(.+?)\s+(sharpe|sortino|volatility|beta|drawdown|risk)\b/i))) {
            const entity = clean(m[1]);
            const metric = /risk/i.test(m[2]) ? 'summary' : this._metricOf(m[2], METRIC);
            if (entity) return { metric, entity };
        }
        return null;
    }

    _metricOf(word, METRIC) {
        const w = String(word).toLowerCase();
        for (const [key, re] of Object.entries(METRIC)) if (re.test(w)) return key;
        return 'summary';
    }

    // Parse a news request into { topic } (empty topic = top headlines), or null.
    parseNewsQuery(cmd) {
        const clean = (s) => s && s.replace(/[?.!,]+$/, '')
            .replace(/\b(right now|today|please|currently|for me)\b/gi, '')
            .replace(/^\s*(?:the|a)\s+/i, '').replace(/\s+/g, ' ').trim();
        let m;
        // Explicit topic after a connector: "news about X", "latest on X".
        if ((m = cmd.match(/\b(?:news|headlines?|updates?)\s+(?:about|on|for|regarding|around)\s+(.+)/i)))
            return { topic: clean(m[1]) || '' };
        if ((m = cmd.match(/\bwhat(?:'s| is| has| are)\s+(?:the\s+)?(?:latest|happening|new|going on)\s+(?:on|with|about|in|for)\s+(.+)/i)))
            return { topic: clean(m[1]) || '' };

        // Beyond this point it is only a news request if it actually mentions
        // news, or is one of a few fixed "catch me up" phrasings. This gate is
        // what stops "what's the price of Tesla" being read as news.
        const isNews = /\b(news|headlines?|breaking)\b/i.test(cmd) ||
            /\b(latest updates?|what'?s happening|what is happening|what'?s new|catch me up)\b/i.test(cmd);
        if (!isNews) return null;

        // Trailing-topic form: "<topic> news". The head must be a real subject,
        // not a question/request stem — "what is the news" and "give me the news"
        // are general headlines, not news about "the". Filler words are peeled
        // off the FRONT repeatedly until only a subject (or nothing) remains.
        if ((m = cmd.match(/^(.*?)\s+(?:news|headlines)\b/i))) {
            const FILLER = /^(?:what's|whats|what|is|are|has|do|does|the|a|an|of|about|on|any|some|latest|recent|top|breaking|world|local|more|good|bad|great|big|tell|me|give|show|get|read|catch|up|today|todays|here's|heres|there|please|us|'s)\b/i;
            let head = clean(m[1]);
            let prev;
            do { prev = head; head = head.replace(FILLER, '').trim(); } while (head && head !== prev);
            if (head) return { topic: head };
        }
        // Mentions news but no clean topic -> top headlines.
        return { topic: '' };
    }

    _fmtMoney(price, ccy) {
        const sym = { USD: '$', EUR: '€', GBP: '£', INR: '₹', JPY: '¥' }[ccy] || '';
        const digits = price >= 1000 ? 0 : price >= 1 ? 2 : 4;
        const n = Number(price).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
        return sym ? `${sym}${n}` : `${n} ${ccy || ''}`.trim();
    }

    // Finance & News Handlers
    async handlePriceQuery(entity) {
        if (!window.electronAPI?.getQuote) {
            this.speak('Live quotes are not available in this environment.');
            return;
        }
        this.displayText(`Fetching ${entity} quote...`, null);
        let q;
        try { q = await window.electronAPI.getQuote(entity); }
        catch (e) { console.error('Quote error:', e); this.speak(`I could not fetch a price for ${entity}.`); return; }
        if (!q || !q.success) {
            this.speak(`I could not find a live price for ${entity}.`);
            return;
        }
        const name = q.name || q.symbol;
        const priceStr = this._fmtMoney(q.price, q.currency);
        const arrow = q.changePct == null ? '' : q.changePct >= 0 ? ' ▲ ' : ' ▼ ';
        const pctStr = q.changePct == null ? '' : `${arrow}${Math.abs(q.changePct).toFixed(2)}%`;
        this.displayText(`${name} (${q.symbol})\n${priceStr}${pctStr}`, null);
        const spokenChg = q.changePct == null ? ''
            : `, ${q.changePct >= 0 ? 'up' : 'down'} ${Math.abs(q.changePct).toFixed(1)} percent today`;
        this.speak(`${name} is at ${priceStr}${spokenChg}.`);
    }

    // Quant analytics: fetch REAL historical prices and compute risk/return
    // metrics with the deterministic engine — the model never estimates these.
    async handleQuantQuery(metric, entity) {
        if (!window.electronAPI?.getHistory) {
            this.speak('Quant analytics are not available in this environment.');
            return;
        }
        this.displayText(`Analyzing ${entity}...`, null);
        let hist;
        try { hist = await window.electronAPI.getHistory({ text: entity, range: '1y' }); }
        catch (e) { console.error('History error:', e); this.speak(`I could not fetch price history for ${entity}.`); return; }
        if (!hist || !hist.success) {
            this.speak(`I could not find enough price history for ${entity}.`);
            return;
        }

        // Beta/alpha and the full summary need a market benchmark (S&P 500).
        let benchmarkPrices = null;
        if (metric === 'beta' || metric === 'summary') {
            const bench = await window.electronAPI.getHistory({ symbol: '^GSPC', range: '1y' }).catch(() => null);
            if (bench?.success) benchmarkPrices = bench.closes;
        }

        // 4% annual risk-free is a reasonable current default for Sharpe/Sortino.
        const a = quant.analyzeSeries(hist.closes, { benchmarkPrices, riskFree: 0.04 });
        const name = hist.name || hist.symbol;
        const pct = (x) => `${(x * 100).toFixed(1)} percent`;
        const num = (x) => x.toFixed(2);

        // On-screen: the full block. Spoken: focused on what was asked.
        const lines = [
            `${name} (${hist.symbol}) — 1-year`,
            `Return: ${pct(a.annualizedReturn)}   Total: ${pct(a.cumulativeReturn)}`,
            `Volatility: ${pct(a.annualizedVolatility)}   Max drawdown: ${pct(a.maxDrawdown)}`,
            `Sharpe: ${num(a.sharpe)}   Sortino: ${num(a.sortino)}`,
        ];
        if (a.beta != null) lines.push(`Beta: ${num(a.beta)}   Alpha: ${pct(a.alpha)}   Corr(SPX): ${num(a.correlation)}`);
        this.displayText(lines.join('\n'), null);

        let spoken;
        switch (metric) {
            case 'sharpe':
                spoken = `${name} has a one-year Sharpe ratio of ${num(a.sharpe)}, on an annualized return of ${pct(a.annualizedReturn)} and volatility of ${pct(a.annualizedVolatility)}.`;
                break;
            case 'sortino':
                spoken = `${name} has a Sortino ratio of ${num(a.sortino)} over the past year.`;
                break;
            case 'volatility':
                spoken = `${name} has an annualized volatility of ${pct(a.annualizedVolatility)} over the past year, with a maximum drawdown of ${pct(a.maxDrawdown)}.`;
                break;
            case 'drawdown':
                spoken = `${name}'s maximum drawdown over the past year was ${pct(a.maxDrawdown)}.`;
                break;
            case 'beta':
                spoken = a.beta != null
                    ? `${name} has a beta of ${num(a.beta)} to the S&P 500, with an annualized alpha of ${pct(a.alpha)}.`
                    : `I could not compute beta for ${name} — the benchmark data was unavailable.`;
                break;
            case 'return':
                spoken = `${name} returned ${pct(a.annualizedReturn)} annualized over the past year, ${pct(a.cumulativeReturn)} in total.`;
                break;
            default:
                spoken = `Over the past year, ${name} returned ${pct(a.annualizedReturn)} annualized with ${pct(a.annualizedVolatility)} volatility, a Sharpe of ${num(a.sharpe)}, and a maximum drawdown of ${pct(a.maxDrawdown)}.`;
                if (a.beta != null) spoken += ` Its beta to the market is ${num(a.beta)}.`;
        }
        this.speak(spoken);
    }

    // Parse an on-chain read into { kind, chain, address?, token? }, or null.
    //   kind: 'gas' | 'balance' | 'token' | 'txcount'
    // A 0x address is the primary trigger; "gas on <chain>" needs no address.
    parseOnchainQuery(cmd) {
        const text = String(cmd || '');

        // Transaction decode — a 0x…(64 hex) hash. "explain/what happened in tx 0x…".
        const txMatch = text.match(/0x[0-9a-fA-F]{64}/);
        if (txMatch) return { kind: 'tx', hash: txMatch[0], chain: onchain.resolveChain(text, 'ethereum') };

        const addr = onchain.extractAddress(text);
        // An ENS name works anywhere an address does ("balance of vitalik.eth").
        const ensMatch = !addr && text.match(/\b([a-z0-9-]+(?:\.[a-z0-9-]+)*\.eth)\b/i);
        const ensName = ensMatch ? ensMatch[1].toLowerCase() : null;

        // "who is <addr/name>" — identity via ENS (forward or reverse), the one
        // attribution that is on-chain truth rather than a proprietary label.
        if ((addr || ensName) && /\b(who is|who'?s|whose (address|wallet)|what name|identify)\b/i.test(text)) {
            return { kind: 'whois', address: addr, ensName, chain: 'ethereum' };
        }

        // Cross-chain portfolio — "scan vitalik.eth across all chains",
        // "portfolio of 0x…", "what does 0x… hold".
        if ((addr || ensName) && /\b(portfolio|holdings|hold(s)? (on|across)|all chains|cross.?chain|every chain|scan)\b/i.test(text)) {
            return { kind: 'portfolio', address: addr, ensName, chain: 'ethereum' };
        }

        // Watch / unwatch an address — checked BEFORE balance fallthrough so
        // "watch 0x…" never reads as a balance query. "watch vitalik.eth",
        // "stop watching 0x…", "monitor 0x… for activity".
        if ((addr || ensName) && /\b(stop|remove|unwatch|don'?t watch|quit watching)\b/i.test(text)) {
            return { kind: 'unwatch-address', address: addr, ensName, chain: 'ethereum' };
        }
        if ((addr || ensName) && /\b(watch|monitor|track|alert me|notify)\b/i.test(text)) {
            return { kind: 'watch-address', address: addr, ensName, chain: 'ethereum' };
        }

        // Whale stream control — needs no address. "watch for whales",
        // "monitor whale transfers", "stop whale alerts", "whale watch status".
        // History summary ("whale activity today") is checked FIRST or the
        // stream-control verbs would eat it.
        if (/\b(whales?|large transfers?|big moves?)\b/i.test(text)) {
            if (/\b(today|activity|summary|report|recap|so far)\b/i.test(text)) return { kind: 'whale-summary', chain: 'ethereum' };
            if (/\b(stop|off|disable|end|quit)\b/i.test(text)) return { kind: 'whale-stream', action: 'stop', chain: 'ethereum' };
            if (/\b(status|running|active)\b/i.test(text)) return { kind: 'whale-stream', action: 'status', chain: 'ethereum' };
            if (/\b(watch|monitor|alert|track|stream|start|on|live)\b/i.test(text)) return { kind: 'whale-stream', action: 'start', chain: 'ethereum' };
        }

        // Gas needs no address, but must be unambiguously about a chain (a named
        // chain, "gwei", or "gas fee") so it never eats "gas prices at the pump".
        if (!addr && !ensName && /\bgas\b/i.test(text) &&
            (/\b(arbitrum|arb|ethereum|eth|mainnet|base|optimism|\bop\b|polygon|matic|chain|network|l1|l2|gwei)\b/i.test(text) || /\bgas fees?\b/i.test(text))) {
            return { kind: 'gas', chain: onchain.resolveChain(text, 'ethereum') };
        }
        if (!addr && !ensName) return null; // other on-chain reads need a subject

        const chain = onchain.resolveChain(text, 'ethereum');
        // Contract classification — "what kind of token is 0x…", "is 0x… an NFT /
        // ERC-721", "what standard does 0x… implement". Deterministic (ERC-165).
        if (/\b(what (kind|type|standard)|which standard|classify|is (it|this|that)?\s*an?\s*(erc|nft|token)|is 0x[0-9a-fA-F]{40} an?|erc-?165|nft contract|token standard)\b/i.test(text)) {
            return { kind: 'classify', address: addr, ensName, chain };
        }
        if (/\b(how many (transactions|txs?|transfers)|transaction count|number of transactions|nonce)\b/i.test(text)) {
            return { kind: 'txcount', address: addr, ensName, chain };
        }
        const token = onchain.resolveToken(text, chain);
        if (token) return { kind: 'token', address: addr, ensName, chain, token };
        return { kind: 'balance', address: addr, ensName, chain };
    }

    // Resolve an ENS name (vitalik.eth) to an address via the mainnet registry.
    // Keyless, deterministic. Returns null if unregistered or unresolvable.
    async resolveEns(name) {
        if (!window.electronAPI?.onchainCall) return null;
        try {
            const node = ens.namehash(name);
            const rRaw = await window.electronAPI.onchainCall({ chain: 'ethereum', to: ens.ENS_REGISTRY, data: ens.encodeResolver(node) });
            const resolver = rRaw?.success ? ens.decodeAddress(rRaw.raw) : null;
            if (!resolver) return null;
            const aRaw = await window.electronAPI.onchainCall({ chain: 'ethereum', to: resolver, data: ens.encodeAddr(node) });
            return aRaw?.success ? ens.decodeAddress(aRaw.raw) : null;
        } catch { return null; }
    }

    // Reverse-resolve an address to its primary ENS name, or null.
    async reverseEns(address) {
        if (!window.electronAPI?.onchainCall) return null;
        try {
            const node = ens.reverseNode(address);
            const rRaw = await window.electronAPI.onchainCall({ chain: 'ethereum', to: ens.ENS_REGISTRY, data: ens.encodeResolver(node) });
            const resolver = rRaw?.success ? ens.decodeAddress(rRaw.raw) : null;
            if (!resolver) return null;
            const nRaw = await window.electronAPI.onchainCall({ chain: 'ethereum', to: resolver, data: ens.encodeName(node) });
            if (!nRaw?.success || ens.isZeroNodeResult(nRaw.raw)) return null;
            return onchain.decodeAbiString(nRaw.raw) || null;
        } catch { return null; }
    }

    async handleOnchainQuery(intent) {
        if (!window.electronAPI?.onchainGas) {
            this.speak('On-chain reads are not available in this environment.');
            return;
        }
        const meta = onchain.CHAINS[intent.chain];
        const chainName = meta?.name || intent.chain;
        try {
            if (intent.kind === 'gas') {
                this.displayText(`Reading gas on ${chainName}...`, null);
                const r = await window.electronAPI.onchainGas({ chain: intent.chain });
                if (!r.success) { this.speak(`I could not read the gas price on ${chainName}.`); return; }
                const line = `Gas on ${chainName} is ${onchain.formatGwei(r.wei)} gwei.`;
                this.displayText(line, null); this.speak(line); return;
            }
            if (intent.kind === 'tx') {
                await this.handleTx(intent.hash, intent.chain, chainName);
                return;
            }
            if (intent.kind === 'whois') {
                await this.handleWhois(intent);
                return;
            }
            if (intent.kind === 'whale-stream') {
                await this.handleWhaleStream(intent.action);
                return;
            }
            if (intent.kind === 'whale-summary') {
                await this.handleWhaleSummary();
                return;
            }

            // Resolve an ENS name to an address up front for reads that need one.
            if (!intent.address && intent.ensName) {
                this.displayText(`Resolving ${intent.ensName}...`, null);
                const resolved = await this.resolveEns(intent.ensName);
                if (!resolved) { this.speak(`I could not resolve ${intent.ensName} to an address.`); return; }
                intent.address = resolved;
                intent._resolvedFrom = intent.ensName;
            }

            const short = intent._resolvedFrom || onchain.shortAddress(intent.address);
            if (intent.kind === 'balance') {
                this.displayText(`Reading ${short} on ${chainName}...`, null);
                const r = await window.electronAPI.onchainBalance({ chain: intent.chain, address: intent.address });
                if (!r.success) { this.speak(`I could not read that address on ${chainName}.`); return; }
                const eth = onchain.groupThousands(onchain.formatEther(r.wei, 6));
                const line = `${short} holds ${eth} ${meta?.native || 'ETH'} on ${chainName}.`;
                this.displayText(line, null); this.speak(line); return;
            }
            if (intent.kind === 'token') {
                const { token } = intent;
                this.displayText(`Reading ${token.symbol} balance of ${short} on ${chainName}...`, null);
                const data = onchain.encodeBalanceOf(intent.address);
                const r = await window.electronAPI.onchainToken({ chain: intent.chain, token: token.address, data });
                if (!r.success) { this.speak(`I could not read the ${token.symbol} balance on ${chainName}.`); return; }
                const amt = onchain.groupThousands(onchain.formatUnits(onchain.hexToBigInt(r.raw), token.decimals, 4));
                const line = `${short} holds ${amt} ${token.symbol} on ${chainName}.`;
                this.displayText(line, null); this.speak(line); return;
            }
            if (intent.kind === 'txcount') {
                this.displayText(`Reading transaction count of ${short}...`, null);
                const r = await window.electronAPI.onchainTxCount({ chain: intent.chain, address: intent.address });
                if (!r.success) { this.speak(`I could not read the transaction count on ${chainName}.`); return; }
                const line = `${short} has made ${onchain.groupThousands(String(r.count))} transactions on ${chainName}.`;
                this.displayText(line, null); this.speak(line); return;
            }
            if (intent.kind === 'classify') {
                await this.handleClassify(intent.address, intent.chain, chainName, short);
                return;
            }
            if (intent.kind === 'portfolio') {
                await this.handlePortfolio(intent.address, short);
                return;
            }
            if (intent.kind === 'watch-address') {
                await this.handleWatchAddress(intent.address, short);
                return;
            }
            if (intent.kind === 'unwatch-address') {
                const r = await window.electronAPI.chainWatchlistRemove({ address: intent.address });
                this.speak(r?.removed ? `Understood. I have stopped watching ${short}.`
                    : `${short} was not on the watch list.`);
                return;
            }
        } catch (e) {
            console.error('On-chain query error:', e);
            this.speak(`That on-chain read on ${chainName} failed.`);
        }
    }

    /* Cross-chain portfolio: every chain and every known token queried in
       PARALLEL over the existing read-only IPC. Deterministic formatting via
       onchain.js — nothing here is estimated or guessed, and chains that fail
       are reported as unreadable rather than silently shown as zero. */
    async handlePortfolio(address, short) {
        // 45s cache: a repeated "scan X" (or a follow-up question seconds later)
        // answers instantly instead of re-firing ~20 RPC reads. Balances do not
        // meaningfully change inside a spoken conversation turn.
        this._portfolioCache = this._portfolioCache || new Map();
        const cached = this._portfolioCache.get(address.toLowerCase());
        if (cached && Date.now() - cached.at < 45000) {
            this.displayText(cached.display, null);
            this.speak(cached.spoken + ' From the scan a moment ago.');
            return;
        }
        this.displayText(`Scanning ${short} across ${Object.keys(onchain.CHAINS).length} chains...`, null);

        const scanChain = async (chainKey) => {
            const meta = onchain.CHAINS[chainKey];
            const [bal, txc] = await Promise.all([
                window.electronAPI.onchainBalance({ chain: chainKey, address }),
                window.electronAPI.onchainTxCount({ chain: chainKey, address }),
            ]);
            if (!bal?.success) return { chainKey, failed: true };

            const tokens = [];
            const known = onchain.TOKENS[chainKey] || {};
            const data = onchain.encodeBalanceOf(address);
            await Promise.all(Object.entries(known).map(async ([sym, info]) => {
                const r = await window.electronAPI.onchainToken({ chain: chainKey, token: info.address, data }).catch(() => null);
                if (!r?.success) return;
                const raw = onchain.hexToBigInt(r.raw);
                if (raw > 0n) tokens.push({ sym, amount: onchain.groupThousands(onchain.formatUnits(raw, info.decimals, 2)) });
            }));

            return {
                chainKey,
                name: meta.name,
                native: meta.native,
                nativeAmount: onchain.formatEther(bal.wei, 4),
                nativeWei: bal.wei,
                txCount: txc?.success ? txc.count : null,
                tokens: tokens.sort((a, b) => a.sym.localeCompare(b.sym)),
            };
        };

        const results = await Promise.all(Object.keys(onchain.CHAINS).map(scanChain));
        const readable = results.filter(r => !r.failed);
        const failed = results.filter(r => r.failed);

        const lines = [];
        const spokenParts = [];
        for (const r of readable) {
            const hasNative = onchain.hexToBigInt(r.nativeWei) > 0n;
            if (!hasNative && !r.tokens.length) continue;
            const bits = [];
            if (hasNative) bits.push(`${onchain.groupThousands(r.nativeAmount)} ${r.native}`);
            for (const t of r.tokens) bits.push(`${t.amount} ${t.sym}`);
            lines.push(`${r.name}: ${bits.join(', ')}${r.txCount != null ? ` (${onchain.groupThousands(String(r.txCount))} txs)` : ''}`);
            spokenParts.push(`${bits.join(' and ')} on ${r.name}`);
        }

        if (!lines.length) {
            this.speak(failed.length
                ? `${short} shows no holdings on the chains I could read, Sir. ${failed.length} of ${results.length} chains were unreadable.`
                : `${short} holds nothing I can see across all ${results.length} chains, Sir.`);
            return;
        }

        const display = [`Cross-chain portfolio for ${short}:`, ...lines];
        if (failed.length) display.push(`Unreadable: ${failed.map(f => f.chainKey).join(', ')}`);
        const displayStr = display.join('\n');
        this.displayText(displayStr, null);

        let spoken = `Cross-chain scan complete, Sir. ${short} holds ${spokenParts.slice(0, 3).join('; ')}.`;
        if (spokenParts.length > 3) spoken += ` Plus holdings on ${spokenParts.length - 3} more chains, on screen now.`;
        if (failed.length) spoken += ` ${failed.length} chains could not be read.`;
        this.speak(spoken);

        // Cache only clean, non-empty scans — a partial read must not become
        // the instant answer for the next 45 seconds.
        if (!failed.length) {
            this._portfolioCache.set(address.toLowerCase(), { at: Date.now(), display: displayStr, spoken });
        }
    }

    async handleWatchAddress(address, short) {
        const r = await window.electronAPI.chainWatchlistAdd({ address, label: short !== onchain.shortAddress(address) ? short : null });
        if (!r?.success) { this.speak(`I could not add ${short} to the watch list.`); return; }
        // Watching implies wanting the stream: start it so the promise
        // "I'll tell you when it moves" is actually kept.
        const s = await window.electronAPI.chainStreamStart({});
        this.speak(s?.success
            ? `Understood, Sir. I am now watching ${short} on Ethereum and will announce any activity.`
            : `${short} is on the watch list, but the live block stream failed to start — I will not see activity until it does.`);
    }

    async handleWhaleStream(action) {
        if (action === 'stop') {
            const r = await window.electronAPI.chainStreamStop();
            this._whaleAlertsOn = false;
            this.speak(r?.wasRunning ? 'Whale monitoring is off, Sir.' : 'The chain stream was not running.');
            return;
        }
        if (action === 'status') {
            const s = await window.electronAPI.chainStreamStatus();
            if (!s?.running) { this.speak('The chain stream is not running, Sir.'); return; }
            let line = `The chain stream is ${s.connected ? 'live' : 'reconnecting'} on ${s.chain}: ${s.blocks} blocks scanned in ${s.uptimeMin} minutes, ${s.alerts} alerts.`;
            if (s.reconnects) line += ` ${s.reconnects} reconnects.`;
            if (s.missedBlocks) line += ` ${s.missedBlocks} blocks were missed and handled.`;
            this.displayText(`Stream: block ${s.lastBlock}, avg scan ${s.avgProcessMs}ms, dedup ${s.dedupSize} entries`, null);
            this.speak(line);
            return;
        }
        const r = await window.electronAPI.chainStreamStart({});
        this._whaleAlertsOn = true;
        this.speak(r?.success
            ? 'Whale monitoring is live, Sir. I will announce native transfers of one hundred ETH or more as blocks confirm on Ethereum.'
            : 'I could not start the chain stream.');
    }

    // "Show whale activity today" — read back what was actually recorded in the
    // alert history, never a from-memory impression of the day.
    async handleWhaleSummary() {
        if (!window.electronAPI?.chainAlertsSummary) { this.speak('Alert history is not available here.'); return; }
        const s = await window.electronAPI.chainAlertsSummary();
        if (!s?.success) { this.speak('I could not read the alert history.'); return; }
        if (!s.whaleCount && !s.watchCount) {
            this.speak(s.streaming
                ? 'No whale or watchlist alerts recorded so far today, Sir.'
                : 'No alerts recorded today — the chain stream has not been running.');
            return;
        }
        let line = `Today I recorded ${s.whaleCount} whale transfer${s.whaleCount === 1 ? '' : 's'}`;
        if (s.watchCount) line += ` and ${s.watchCount} watched-address hit${s.watchCount === 1 ? '' : 's'}`;
        line += '.';
        if (s.largest) {
            const usd = s.largest.usd ? ` — about ${s.largest.usd.toLocaleString('en-US')} dollars` : '';
            line += ` The largest was ${s.largest.amount} ETH${usd}, in block ${s.largest.blockNumber}.`;
        }
        if (!s.streaming) line += ' The stream is not currently running.';
        this.displayText(`Chain activity today: ${s.whaleCount} whales, ${s.watchCount} watch hits.`, null);
        this.speak(line);
    }

    // DETERMINISTIC ERC classification via ERC-165 supportsInterface + ERC-20
    // metadata probing (inspired by SymGPT's sound interface-conformance subset).
    // No LLM, no vulnerability claims — it reports which token standard a
    // contract implements, nothing about whether it is safe.
    async handleClassify(address, chain, chainName, short) {
        if (!window.electronAPI?.onchainCall) { this.speak('Contract introspection is not available here.'); return; }
        this.displayText(`Inspecting ${short} on ${chainName}...`, null);
        const call = async (data) => {
            const r = await window.electronAPI.onchainCall({ chain, to: address, data }).catch(() => null);
            return r && r.success ? r.raw : null;
        };
        const supports = async (id) => {
            const raw = await call(onchain.encodeSupportsInterface(id));
            return raw != null && onchain.decodeBool(raw);
        };

        // ERC-165 NFT interfaces first (definitive), then ERC-20 metadata probe.
        const [is721, is1155] = await Promise.all([
            supports(onchain.INTERFACE_IDS.erc721),
            supports(onchain.INTERFACE_IDS.erc1155),
        ]);
        let is721Meta = false, is1155Meta = false, decimalsRaw = null, symbol = null;
        if (is721) is721Meta = await supports(onchain.INTERFACE_IDS.erc721Metadata);
        else if (is1155) is1155Meta = await supports(onchain.INTERFACE_IDS.erc1155MetadataURI);
        else decimalsRaw = await call(onchain.SELECTORS.decimals); // ERC-20 tell
        const symRaw = await call(onchain.SELECTORS.symbol);
        if (symRaw) symbol = onchain.decodeAbiString(symRaw) || null;

        const v = onchain.classifyContract({ is721, is1155, is721Meta, is1155Meta, decimalsRaw, symbol });
        const sym = v.symbol ? ` Symbol: ${v.symbol}.` : '';
        const line = v.standard
            ? `${short} on ${chainName} implements ${v.detail}.${sym}`
            : `${short} on ${chainName} — ${v.detail}.${sym}`;
        this.displayText(line, null); this.speak(line);
    }

    // "Who is <addr/name>" — ENS identity, the only on-chain-truthful attribution
    // (no proprietary exchange labels, no LLM guessing). Forward for a name,
    // reverse for an address; honest "no ENS name" when there is none.
    async handleWhois(intent) {
        if (!window.electronAPI?.onchainCall) { this.speak('Identity lookup is not available here.'); return; }
        if (intent.ensName) {
            this.displayText(`Resolving ${intent.ensName}...`, null);
            const addr = await this.resolveEns(intent.ensName);
            const line = addr
                ? `${intent.ensName} resolves to ${addr} on Ethereum.`
                : `${intent.ensName} does not resolve to an address (unregistered or no address record).`;
            this.displayText(line, null); this.speak(line); return;
        }
        const short = onchain.shortAddress(intent.address);
        this.displayText(`Looking up ${short}...`, null);
        const name = await this.reverseEns(intent.address);
        const line = name
            ? `${short} has the ENS name ${name}.`
            : `${short} has no primary ENS name set. On-chain data alone cannot tell you who owns it — anything more would be a guess.`;
        this.displayText(line, null); this.speak(line);
    }

    // DETERMINISTIC transaction decode: what token transfers actually happened in
    // one tx. Amounts come straight from the receipt logs (BigInt), never the LLM.
    // Honest scope: this one transaction only — no provenance, no entity labels.
    async handleTx(hash, chain, chainName) {
        if (!window.electronAPI?.onchainTx) { this.speak('Transaction decoding is not available here.'); return; }
        const shortHash = `${hash.slice(0, 10)}…${hash.slice(-6)}`;
        this.displayText(`Decoding ${shortHash} on ${chainName}...`, null);
        const r = await window.electronAPI.onchainTx({ chain, hash }).catch(() => null);
        if (!r || !r.success) { this.speak(`I could not decode that transaction on ${chainName}${r?.error ? ` (${r.error})` : ''}.`); return; }

        const status = r.receipt.status === '0x1' ? 'succeeded' : (r.receipt.status === '0x0' ? 'FAILED' : 'unknown');
        const transfers = (r.receipt.logs || []).map(onchain.decodeTransferLog).filter(Boolean);

        // Resolve decimals/symbol per unique token: known map first, else on-chain.
        const tokenInfo = new Map();
        for (const t of transfers) {
            if (t.isNft || tokenInfo.has(t.token)) continue;
            const known = onchain.resolveTokenByAddress(chain, t.token);
            if (known) { tokenInfo.set(t.token, known); continue; }
            const decRaw = await window.electronAPI.onchainCall({ chain, to: t.token, data: onchain.SELECTORS.decimals }).catch(() => null);
            const symRaw = await window.electronAPI.onchainCall({ chain, to: t.token, data: onchain.SELECTORS.symbol }).catch(() => null);
            tokenInfo.set(t.token, {
                decimals: decRaw?.success ? Number(onchain.hexToBigInt(decRaw.raw)) : 18,
                symbol: symRaw?.success ? (onchain.decodeAbiString(symRaw.raw) || 'tokens') : 'tokens',
            });
        }

        const fmt = (t) => {
            if (t.isNft) return `NFT #${t.amount} (${onchain.shortAddress(t.token)})`;
            const info = tokenInfo.get(t.token) || { decimals: 18, symbol: 'tokens' };
            return `${onchain.groupThousands(onchain.formatUnits(t.amount, info.decimals, 4))} ${info.symbol}`;
        };

        const lines = [`Tx ${shortHash} on ${chainName} ${status}.`];
        const nativeWei = r.tx?.value ? onchain.hexToBigInt(r.tx.value) : 0n;
        if (nativeWei > 0n) lines.push(`Native: ${onchain.formatEther(nativeWei, 6)} ${onchain.CHAINS[chain]?.native || 'ETH'} from ${onchain.shortAddress(r.tx.from)} to ${onchain.shortAddress(r.tx.to)}.`);
        if (transfers.length) {
            lines.push(`${transfers.length} token transfer${transfers.length === 1 ? '' : 's'}:`);
            for (const t of transfers.slice(0, 6)) {
                lines.push(`  ${fmt(t)}: ${onchain.shortAddress(t.from)} → ${onchain.shortAddress(t.to)}`);
            }
            if (transfers.length > 6) lines.push(`  …and ${transfers.length - 6} more.`);
        } else if (nativeWei === 0n) {
            lines.push('No token or native-value transfers (likely a contract call).');
        }

        this.displayText(lines.join('\n'), null);
        // Spoken: concise headline (the full breakdown is on screen).
        const headline = transfers.length
            ? `Transaction ${status}. ${fmt(transfers[0])} from ${onchain.shortAddress(transfers[0].from)} to ${onchain.shortAddress(transfers[0].to)}${transfers.length > 1 ? `, plus ${transfers.length - 1} more transfer${transfers.length - 1 === 1 ? '' : 's'}` : ''}.`
            : (nativeWei > 0n ? `Transaction ${status}: ${onchain.formatEther(nativeWei, 4)} ${onchain.CHAINS[chain]?.native || 'ETH'} transferred.` : `Transaction ${status}, with no token transfers.`);
        this.speak(headline);
    }

    async handleNewsQuery(topic) {
        if (!window.electronAPI?.getNews) {
            this.speak('News is not available in this environment.');
            return;
        }
        this.displayText(topic ? `Getting news about ${topic}...` : 'Getting the latest headlines...', null);
        let res;
        try { res = await window.electronAPI.getNews({ query: topic, limit: 5 }); }
        catch (e) { console.error('News error:', e); this.speak('I could not fetch the news right now.'); return; }
        if (!res || !res.success || !res.items.length) {
            this.speak(topic ? `I could not find recent news about ${topic}.` : 'I could not fetch the news right now.');
            return;
        }
        const items = res.items;
        const display = items.map((it, i) =>
            `${i + 1}. ${it.title}${it.source ? `  — ${it.source}` : ''}${it.publishedText ? `  (${it.publishedText})` : ''}`
        ).join('\n');
        this.displayText(`${topic ? `News: ${topic}` : 'Top headlines'}\n${display}`, null);
        const spoken = items.slice(0, 3).map((it, i) =>
            `${i + 1}. ${it.title}${it.source ? `, from ${it.source}` : ''}`
        ).join('. ');
        this.speak(`${topic ? `Here's the latest on ${topic}. ` : 'Here are the top headlines. '}${spoken}.`);
    }

    // Surface the interaction log — the self-improvement telemetry — as a
    // spoken + on-screen summary.
    async handleUsageStats() {
        if (!window.electronAPI?.getInteractionStats) {
            this.speak('Usage statistics are not available in this environment.');
            return;
        }
        const s = await window.electronAPI.getInteractionStats();
        if (!s || !s.success || !s.total) {
            this.speak('I have no interaction history logged yet.');
            return;
        }
        const top = Object.entries(s.byIntent).slice(0, 6)
            .map(([k, v]) => `${k}: ${v}`).join('\n');
        const since = s.firstTs ? new Date(s.firstTs).toLocaleDateString() : 'recently';
        this.displayText(
            `Usage since ${since}\n` +
            `Total turns: ${s.total}\n` +
            `Error rate: ${s.errorRate}%\n` +
            `Avg latency: ${s.avgLatencyMs != null ? s.avgLatencyMs + 'ms' : 'n/a'}\n` +
            `Top intents:\n${top}`,
            null
        );
        const busiest = Object.keys(s.byIntent)[0] || 'none';
        this.speak(
            `I have handled ${s.total} commands since ${since}, ` +
            `with a ${s.errorRate} percent error rate and about ${s.avgLatencyMs || 0} milliseconds average response. ` +
            `Your most common request type is ${busiest.replace(/_/g, ' ').toLowerCase()}.`
        );
    }

    // Memory consolidation — the "sleep" pass. Distills durable facts from
    // recent experience into long-term memory and reports self-improvement notes.
    async handleReflect() {
        this.speak('Consolidating my memory. One moment.');
        this.displayText('Reflecting on recent interactions...', null);
        try {
            const summary = await reflectionService.reflect();
            this.speak(summary);
        } catch (e) {
            console.error('Reflection error:', e);
            this.speak('I ran into a problem while consolidating my memory.');
        }
    }

    async handleWhatLearned() {
        try {
            const summary = await reflectionService.lastReflectionSummary();
            this.speak(summary);
        } catch (e) {
            console.error('Reflection recall error:', e);
            this.speak('I could not recall what I have learned.');
        }
    }

    // Web Automation Handlers
    async handleOpenWebsite(url, label) {
        try {
            if (window.electronAPI && window.electronAPI.openWebsite) {
                // Add https:// if no protocol specified
                const fullUrl = url.startsWith('http') ? url : `https://${url}`;
                window.electronAPI.openWebsite(fullUrl);
                // Speak the friendly name when we have one ("Opening YouTube"),
                // otherwise the host ("Opening example.com").
                const spokenName = label || fullUrl.replace(/^https?:\/\//, '').split('/')[0];
                this.speak(`Opening ${spokenName} in Chrome`);
            } else {
                this.speak('Web browser control not available');
            }
        } catch (error) {
            console.error('Open website error:', error);
            this.speak('Failed to open website');
        }
    }

    async handleSearchGoogle(query) {
        try {
            this.displayText(`Searching the neural web for: ${query}...`, null);
            await this.handleAICommand(`Search the web for: ${query}`);
        } catch (error) {
            console.error('Search Google error:', error);
            this.speak('Failed to initialize search');
        }
    }

    // Clipboard Handlers
    async handleReadClipboard() {
        try {
            if (window.electronAPI && window.electronAPI.readClipboard) {
                const text = await window.electronAPI.readClipboard();
                if (text) {
                    this.speak(`Clipboard contains: ${text.substring(0, 100)}`);
                } else {
                    this.speak('Clipboard is empty');
                }
            } else {
                this.speak('Clipboard access not available');
            }
        } catch (error) {
            console.error('Read clipboard error:', error);
            this.speak('Failed to read clipboard');
        }
    }

    async handleWriteClipboard(text) {
        try {
            if (window.electronAPI && window.electronAPI.writeClipboard) {
                await window.electronAPI.writeClipboard(text);
                this.speak('Text copied to clipboard');
            } else {
                this.speak('Clipboard access not available');
            }
        } catch (error) {
            console.error('Write clipboard error:', error);
            this.speak('Failed to write to clipboard');
        }
    }

    // Window Control Handlers
    async handleMinimizeWindow() {
        if (window.electronAPI && window.electronAPI.windowControl) {
            window.electronAPI.windowControl('minimize');
            this.speak('Window minimized');
        }
    }

    async handleMaximizeWindow() {
        if (window.electronAPI && window.electronAPI.windowControl) {
            window.electronAPI.windowControl('maximize');
            this.speak('Window maximized');
        }
    }

    async handleCloseWindow() {
        if (window.electronAPI && window.electronAPI.windowControl) {
            window.electronAPI.windowControl('close');
            this.speak('Closing window');
        }
    }

    // Calendar Handlers
    async handleSetReminder(text) {
        try {
            const { date, time } = this.calendar.parseDateTime(text);
            const reminderText = text.replace(/(?:at|on|in).+/i, '').trim() || text;
            const reminder = this.calendar.addReminder(reminderText, date, time);
            this.speak(`Reminder set for ${date} at ${time}: ${reminderText}`);
        } catch (error) {
            console.error('Set reminder error:', error);
            this.speak('Failed to set reminder');
        }
    }

    async handleShowSchedule() {
        try {
            const todayEvents = this.calendar.getTodayEvents();
            if (todayEvents.length > 0) {
                const eventList = todayEvents.map(e => e.title).join(', ');
                this.speak(`Today's schedule: ${eventList}`);
            } else {
                this.speak('No events scheduled for today');
            }
        } catch (error) {
            console.error('Show schedule error:', error);
            this.speak('Failed to retrieve schedule');
        }
    }

    async handleAddEvent(text) {
        try {
            const { date, time } = this.calendar.parseDateTime(text);
            const eventTitle = text.replace(/(?:at|on|in).+/i, '').trim() || text;
            const event = this.calendar.addEvent(eventTitle, date, time);
            this.speak(`Event added: ${eventTitle} on ${date} at ${time}`);
        } catch (error) {
            console.error('Add event error:', error);
            this.speak('Failed to add event');
        }
    }

    async handleVisualizerMode(mode) {
        try {
            // Access visualizer modes through window if available
            if (window.visualizerModes) {
                window.visualizerModes.switchMode(mode);
                this.settings.set('visualizerMode', mode);
                this.speak(`Switched to ${mode} mode`);
            } else {
                this.speak('Visualizer mode switching not available');
            }
        } catch (error) {
            console.error('Visualizer mode error:', error);
            this.speak('Failed to switch visualizer mode');
        }
    }

    // Settings Handlers
    async handleSetWakeWord(word) {
        try {
            if (word) {
                this.settings.set('wakeWords', [word.toLowerCase()]);
                this.speak(`Wake word set to ${word}`);
            } else {
                this.speak('Please specify a wake word');
            }
        } catch (error) {
            console.error('Set wake word error:', error);
            this.speak('Failed to set wake word');
        }
    }

    async handleSetSpeechRate(rate) {
        try {
            if (rate >= 0.1 && rate <= 2.0) {
                this.settings.set('speechRate', rate);
                this.speak(`Speech rate set to ${rate}`);
            } else {
                this.speak('Speech rate must be between 0.1 and 2.0');
            }
        } catch (error) {
            console.error('Set speech rate error:', error);
            this.speak('Failed to set speech rate');
        }
    }

    async handleShowSettings() {
        try {
            const settings = this.settings.getAll();
            const voiceName = this.selectedVoice ? this.selectedVoice.name : 'Default';
            const settingsText = `Wake words: ${settings.wakeWords.join(', ')}, Speech rate: ${settings.speechRate}, Voice: ${voiceName}, Visualizer mode: ${settings.visualizerMode}`;
            this.speak(settingsText);
        } catch (error) {
            console.error('Show settings error:', error);
            this.speak('Failed to retrieve settings');
        }
    }

    async handleResetSettings() {
        try {
            this.settings.reset();
            this.applySettings();
            this.speak('Settings reset to defaults');
        } catch (error) {
            console.error('Reset settings error:', error);
            this.speak('Failed to reset settings');
        }
    }

    // Voice Handlers
    async handleSetVoice(voiceName) {
        try {
            const voices = this.synthesis.getVoices();
            const voice = voices.find(v =>
                v.name.toLowerCase().includes(voiceName.toLowerCase()) ||
                voiceName.toLowerCase().includes(v.name.toLowerCase())
            );

            if (voice) {
                this.selectedVoice = voice;
                this.settings.set('voiceName', voice.name);
                this.speak(`Voice changed to ${voice.name}`);
            } else {
                this.speak(`Voice "${voiceName}" not found. Say "list voices" to see available voices.`);
            }
        } catch (error) {
            console.error('Set voice error:', error);
            this.speak('Failed to change voice');
        }
    }

    async handleListVoices() {
        try {
            const voices = this.synthesis.getVoices();
            const englishVoices = voices.filter(v => v.lang.startsWith('en'));
            const maleVoices = englishVoices.filter(v => {
                const name = v.name.toLowerCase();
                return name.includes('male') ||
                    name.includes('david') ||
                    name.includes('mark') ||
                    name.includes('daniel') ||
                    name.includes('alex') ||
                    name.includes('fred') ||
                    name.includes('tom') ||
                    name.includes('john') ||
                    name.includes('james') ||
                    name.includes('microsoft david') ||
                    name.includes('microsoft mark');
            });

            if (maleVoices.length > 0) {
                const voiceNames = maleVoices.slice(0, 5).map(v => v.name).join(', ');
                this.speak(`Available male voices: ${voiceNames}`);
            } else {
                const voiceNames = englishVoices.slice(0, 5).map(v => v.name).join(', ');
                this.speak(`Available voices: ${voiceNames}`);
            }
        } catch (error) {
            console.error('List voices error:', error);
            this.speak('Failed to list voices');
        }
    }

    // Phone Bridge: real-time notification announcements from the paired phone.
    // The phone (via MacroDroid) POSTs each notification to the LAN listener in
    // electron.js; here we announce it, display it, and store it in memory.
    setupPhoneBridge() {
        if (!window.electronAPI?.onPhoneNotification) return;

        window.electronAPI.onPhoneNotification((event, notif) => {
            if (!notif) return;

            // Dedupe: identical notification within 15s is announced once
            // (Android often re-posts the same notification on updates)
            const hash = `${notif.app}|${notif.title}|${notif.text}`.slice(0, 300);
            const now = Date.now();
            const last = this.recentNotifications.get(hash);
            if (last && now - last < 15000) return;
            this.recentNotifications.set(hash, now);
            // Prune old entries
            if (this.recentNotifications.size > 50) {
                for (const [k, ts] of this.recentNotifications) {
                    if (now - ts > 60000) this.recentNotifications.delete(k);
                }
            }

            const sender = notif.title || notif.app;
            const appName = notif.app.replace(/^com\.[a-z0-9.]*\./i, '');
            const announcement = notif.title
                ? `Sir, you have a new message from ${sender} on ${appName}.`
                : `Sir, new notification from ${appName}.`;

            this.speak(announcement);
            const preview = notif.text ? `${sender}: ${notif.text.slice(0, 200)}` : sender;
            this.displayText(`Phone - ${appName}\n${preview}`, null);

            // Store in long-term memory so "what messages did I get today?" works
            ragService.ingest(
                `Phone notification (${appName}) from ${sender}: ${notif.text || notif.title}`,
                { source: `phone-${appName}` }
            ).catch(() => { /* memory is best-effort here */ });

            // If the live session is up, give Gemini the context silently so
            // follow-up questions ("what did they say?") work naturally
            if (this.liveService && this.liveService.isConnected) {
                this.liveService.sendText(
                    `[System event, do not respond unless asked] Phone notification on ${appName} from ${sender}: ${notif.text || '(no text)'}`
                );
            }
        });
    }

    // Live transcript overlay on the visualizer: every mic state change and
    // every transcript is shown in real time, so you can always SEE that the
    // mic heard you — even for speech Jarvis chooses not to act on.
    _showTranscript(text, mode = 'ambient', status = '', hideAfterMs = 4500) {
        const box = document.getElementById('voice-transcript');
        const statusEl = document.getElementById('vt-status');
        const textEl = document.getElementById('vt-text');
        if (!box || !textEl) return;

        box.className = `visible ${mode}`;
        statusEl.textContent = status;
        textEl.textContent = text;

        clearTimeout(this._vtTimer);
        if (hideAfterMs > 0) {
            this._vtTimer = setTimeout(() => box.classList.remove('visible'), hideAfterMs);
        }
    }

    _onVoiceStatus(s) {
        console.log('LocalVoice status:', s);
        if (s === 'listening') {
            this._showTranscript('...', 'listening', 'LISTENING', 0);
        } else if (s === 'processing') {
            this._showTranscript('...', 'listening', 'TRANSCRIBING', 8000);
        } else if (s.startsWith('mic-active')) {
            const label = s.split(':')[1] || 'default device';
            this._showTranscript(`Microphone active: ${label}. Just speak - I am listening.`, 'acted', 'MIC ONLINE', 6000);
        } else if (s === 'stt-connected') {
            this._showTranscript('Speech recognition online.', 'acted', 'STT READY', 4000);
        } else if (s === 'mic-switching') {
            this._showTranscript('Audio device changed - switching microphone...', 'acted', 'MIC SWITCH', 5000);
        } else if (s === 'stt-disconnected') {
            this._showTranscript('Speech server offline - retrying. Voice input paused.', 'error', 'STT OFFLINE', 8000);
        } else if (s.startsWith('mic-error')) {
            this._showTranscript(`Microphone error: ${s.split(':')[1] || 'unknown'}`, 'error', 'MIC ERROR', 0);
        }
    }

    // Local voice transcripts: EVERYTHING heard is displayed on the
    // visualizer in real time. Only wake-word speech (or the 10 s follow-up
    // window) is acted on; ambient speech is shown, then dropped — never
    // stored anywhere.
    /**
     * Records what Jarvis just said, so the mic can recognise its own voice
     * coming back. Kept as a short time-boxed window — anything older than a
     * few seconds cannot still be echoing.
     */
    _rememberSpoken(text) {
        if (!text) return;
        this._spokenRecently = this._spokenRecently || [];
        this._spokenRecently.push({ words: this._echoWords(text), at: Date.now() });
        const cutoff = Date.now() - 20000;
        this._spokenRecently = this._spokenRecently.filter(e => e.at > cutoff);
        // Accumulate this turn's spoken output for the interaction log. Both
        // speak() and _speakQueued() (the streaming path) funnel through here, so
        // this is the one place that sees every word Jarvis says.
        // First words out is the latency the user actually perceives; everything
        // after this lands while they are already listening.
        perf.markFirstWord();
        this._turnResponse = ((this._turnResponse || '') + ' ' + text).trim();
    }

    // Append one local turn to the persistent interaction log. Best-effort and
    // fully guarded — telemetry must never break or slow a turn. Secret-bearing
    // commands are dropped here so a key never reaches disk via this path.
    _logInteraction(input, intent, startedAt, ok) {
        try {
            if (!window.electronAPI?.logInteraction) return;
            const name = (intent && intent.intent) || 'AI';
            if (name === 'SET_KEY' || name === 'LIST_KEYS' || /^\s*(store|set)\s+key\s+/i.test(input)) return;
            const profile = perf.endTurn();
            window.electronAPI.logInteraction({
                source: this._lastInputWasVoice ? 'voice' : 'text',
                input: String(input || '').slice(0, 500),
                intent: name,
                latencyMs: Date.now() - startedAt,
                ok: ok !== false,
                response: String(this._turnResponse || '').slice(0, 500),
                // Per-stage breakdown: which command is slow was already
                // answerable; this says where inside it the time went.
                stages: profile ? profile.stages : undefined,
                firstWordMs: profile ? profile.firstWordMs : undefined,
                sttMs: this._lastSttMs || undefined,
            });
        } catch { /* logging must never affect the turn */ }
    }

    _echoWords(text) {
        return new Set(
            String(text)
                .toLowerCase()
                .replace(/[^a-z0-9\s]/g, ' ')
                .split(/\s+/)
                .filter(w => w.length > 2)
        );
    }

    /**
     * True when a transcript overlaps heavily with something recently spoken.
     * Word-overlap rather than exact match, because the STT re-transcription of
     * synthesised speech is close but never identical.
     */
    _isEchoOfSelf(cmd) {
        const recent = this._spokenRecently || [];
        if (!recent.length) return false;

        const said = this._echoWords(cmd);
        if (said.size < 3) return false; // too short to judge; let it through

        for (const entry of recent) {
            if (!entry.words.size) continue;
            let hits = 0;
            for (const w of said) if (entry.words.has(w)) hits++;
            if (hits / said.size >= 0.6) return true;
        }
        return false;
    }

    _handleVoiceTranscript(text, meta) {
        // Carried into the interaction log so a voice turn's profile shows the
        // transcription cost alongside the stages this process controls.
        this._lastSttMs = meta && meta.sttMs ? Math.round(meta.sttMs) : null;
        const t = String(text).trim();
        if (!t) {
            this._showTranscript('(silence - nothing recognized)', 'ambient', 'HEARD', 2500);
            return;
        }
        const lower = t.toLowerCase();

        // OPEN CONVERSATION MODE: everything you say goes to the LLM and
        // Jarvis answers by voice. No wake word required. If you do lead
        // with "Jarvis" (or a Whisper mishear of it), it's stripped so the
        // model sees a clean sentence.
        const wakeRe = /^\s*(hey\s+)?(j[ae]rv[aeiu]s|gervais|jarvis)[,.!?\s]*/i;
        const cmd = lower.replace(wakeRe, '').trim();

        // Drop pure filler blips that would spam the model
        if (!cmd || cmd.length < 2 || /^(uh|um|hmm|mm)[.!?]?$/.test(cmd)) {
            this._showTranscript(t, 'ambient', 'HEARD');
            return;
        }

        // ECHO GUARD: the ttsActive gate is necessary but not sufficient —
        // SAPI audio bypasses Chromium's AEC, and the tail of an utterance can
        // land after the flag clears. Real logs show Jarvis's own words coming
        // back as a user turn ("sir, my current assessment suggests a focus
        // query related to that term, and one and two"), which it then answered,
        // talking to itself. Compare against what was recently spoken.
        if (this._isEchoOfSelf(cmd)) {
            this._showTranscript(t, 'ambient', 'ECHO IGNORED', 2500);
            return;
        }

        this._showTranscript(t, 'acted', 'YOU SAID');
        this._lastInputWasVoice = true;
        this.processCommand(cmd);
    }

    /**
     * Executes a structured phone tool and speaks the ACTUAL outcome.
     *
     * The LLM is deliberately not in this path. Earlier logs show it inventing
     * results ("Tab opened, rows closed") because it had no execution feedback;
     * here every spoken confirmation comes from what the phone reported back.
     */
    async handlePhoneTool(phoneIntent) {
        if (!window.electronAPI?.companionCommand) {
            this.speak('The companion bridge is not available in this build, Sir.');
            return;
        }

        const devices = await window.electronAPI.companionDevices();
        if (!devices.length) {
            this.speak('Your phone is not linked right now, Sir. Say connect to my mobile to pair it.');
            return;
        }

        this.displayText(`Phone: ${phoneIntent.tool} ${JSON.stringify(phoneIntent.parameters)}`, null);

        try {
            const out = await executePhoneTool(phoneIntent, devices[0].capabilities);
            this.speak(out.spoken);

            // Screen reads are worth keeping: they are how Jarvis answers
            // follow-up questions about what is on the phone.
            if (out.ok && phoneIntent.tool === 'phone.read_screen' && out.result?.nodes) {
                const visible = out.result.nodes
                    .map((n) => n.text || n.desc)
                    .filter(Boolean)
                    .slice(0, 40)
                    .join(', ');
                this.displayText(`Phone screen (${out.result.package}): ${visible}`, null);
                this._lastPhoneScreen = { at: Date.now(), text: visible, pkg: out.result.package };
            }
        } catch (e) {
            console.error('Phone tool failed:', e);
            this.speak(`I could not reach your phone, Sir. ${e.message}`);
        }
    }

    /**
     * Reports the real companion link state by asking the bridge, and — when
     * it is down — says which stage failed and what to do about it.
     *
     * Deliberately evidence-only: no LLM in this path. The model has no view of
     * the socket, so letting it answer produced confident fiction.
     */
    async handleCompanionStatus() {
        if (!window.electronAPI?.companionDevices) {
            this.speak('The companion bridge is not available in this build, Sir.');
            return;
        }

        const devices = await window.electronAPI.companionDevices();

        if (devices.length) {
            const d = devices[0];
            const name = d.model || d.remote || 'a device';
            const extra = d.accessibility === false
                ? ' Device control is limited: the accessibility service is not enabled on the phone.'
                : '';
            this.speak(`Your phone is connected, Sir. ${name} is linked over Wi-Fi.${extra}`);
            this.displayText(`Companion linked: ${name}${d.android ? ` (Android ${d.android})` : ''} at ${d.remote || 'unknown address'}`, null);
            return;
        }

        // Not linked — distinguish "never paired" from "paired but unreachable",
        // because the fix is different for each.
        const info = await window.electronAPI.getPhoneBridgeInfo?.();
        const addr = info?.addresses?.[0];
        this.speak('Your phone is not linked right now, Sir. Say connect to my mobile to open the pairing window, then open Jarvis on the phone.');
        this.displayText(
            `Companion: OFFLINE\n` +
            `Desktop bridge: ${addr ? `${addr}:${info.port}` : 'no LAN address'}\n` +
            `The phone must be on the same Wi-Fi and pairs within 5 minutes of opening the window.`,
            null
        );
    }

    // Event-Driven Core router: main-process watchers publish typed events;
    // this decides whether to announce, ingest, or stay silent.
    setupEventBus() {
        if (!window.electronAPI?.onJarvisEvent) return;

        window.electronAPI.onJarvisEvent(async (event, evt) => {
            if (!evt) return;
            try {
                switch (evt.type) {
                    case 'download-added': {
                        const { filePath, name } = evt.payload;
                        this.speak(`Sir, a new document arrived in Downloads: ${name}.`);
                        // Auto-read it if the local OCR server is up, then memorize
                        if (await this.screenCapture.isOcrAvailable()) {
                            const result = await window.electronAPI.performOCR({ filePath });
                            if (result.success) {
                                await ragService.ingest(result.markdown, { source: name });
                                this.speak(`I have read and memorized ${name}. Ask me about it anytime.`);
                                this.displayText(`Ingested: ${name} (${result.pages} page${result.pages > 1 ? 's' : ''})`, null);
                            }
                        }
                        break;
                    }

                    case 'clipboard-secret': {
                        // Privacy: only the masked hint ever reaches this process.
                        // Deliberately NOT stored in RAG or trajectory logs.
                        const { kind, masked } = evt.payload;
                        this.speak(`Sir, careful. I detected what looks like a ${kind} on your clipboard. Mind where you paste it.`);
                        this.displayText(`Clipboard warning: ${kind} detected (${masked})`, null);
                        break;
                    }

                    case 'active-window': {
                        // Silent context tracking — no announcements, just awareness.
                        this.activeWindow = evt.payload;
                        break;
                    }

                    case 'whale-alert': {
                        // Large native transfer seen in a confirmed block. Only
                        // spoken while whale monitoring was explicitly asked for;
                        // amounts are exact, USD is contextual, labels arrive
                        // pre-attributed from main (user watchlist or Arkham) —
                        // an unlabeled party is spoken as a shortened address,
                        // never guessed. Burst blocks arrive pre-collapsed: the
                        // loudest transfers as individual alerts, the rest as one
                        // summary payload, so a busy block costs one sentence.
                        const w = evt.payload;
                        const late = w.backfilled ? ' (recovered from a missed block)' : '';
                        if (w.summary) {
                            const usd = w.largestUsd ? ` (about ${w.largestUsd.toLocaleString('en-US')} dollars)` : '';
                            const line = `${w.count} further large transfers in block ${w.blockNumber}, the largest ${w.largestAmount} ETH${usd}.`;
                            this.displayText(`Whale summary: ${line}${late}`, null);
                            if (this._whaleAlertsOn) this.speak(`Also, ${line}`);
                            break;
                        }
                        const usd = w.usd ? `, approximately ${w.usd.toLocaleString('en-US')} dollars,` : '';
                        const line = `${w.amount} ETH${usd} moved from ${w.fromLabel} to ${w.toLabel} in block ${w.blockNumber}.`;
                        this.displayText(`Whale alert: ${line}${late}`, null);
                        if (this._whaleAlertsOn) this.speak(`Sir, significant movement on Ethereum. ${line}`);
                        break;
                    }

                    case 'chain-watch-hit': {
                        // Activity on an address the user asked to watch — always
                        // announce; that was the whole point of watching it.
                        const h = evt.payload;
                        const verb = h.direction === 'out' ? 'sent' : 'received';
                        const other = h.direction === 'out' ? 'to' : 'from';
                        const usd = h.usd ? ` — roughly ${h.usd.toLocaleString('en-US')} dollars` : '';
                        const line = `${h.label} just ${verb} ${h.amount} ETH ${other} ${h.counterparty} in block ${h.blockNumber}${usd}.`;
                        this.displayText(`Watched address: ${line}`, null);
                        this.speak(`Sir, your watched wallet has activity. ${line}`);
                        break;
                    }

                    case 'price-alert': {
                        // Watchlist target/stop crossing — always announce
                        const { message, type } = evt.payload;
                        const prefix = type === 'stop' ? 'Sir, heads up.' : 'Sir, good news.';
                        this.speak(`${prefix} ${message}`);
                        this.displayText(`Market alert: ${message}`, null);
                        break;
                    }
                }
            } catch (e) {
                console.warn('Event router error:', evt.type, e);
            }
        });
    }

    // Wi-Fi voice control: scan and connect to saved networks (no admin)
    async handleWifiScan() {
        if (!window.electronAPI?.wifiScan) {
            this.speak('Wi-Fi control is not available in this environment.');
            return;
        }
        this.displayText('Scanning Wi-Fi networks...', null);
        const result = await window.electronAPI.wifiScan();
        if (!result.success || !result.networks.length) {
            this.speak('I could not find any Wi-Fi networks in range, Sir.');
            return;
        }
        const sorted = result.networks.sort((a, b) => b.signal - a.signal);
        this.displayText('Networks in range\n' + sorted.map(n => `${n.ssid} - ${n.signal}%`).join('\n'), null);
        const top = sorted.slice(0, 4).map(n => `${n.ssid} at ${n.signal} percent`).join('. ');
        this.speak(`I found ${result.networks.length} network${result.networks.length > 1 ? 's' : ''}, Sir. ${top}.`);
    }

    async handleWifiConnect(name) {
        if (!window.electronAPI?.wifiConnect) {
            this.speak('Wi-Fi control is not available in this environment.');
            return;
        }
        this.speak(`Connecting to ${name}, Sir. One moment.`);
        this.displayText(`Connecting to ${name}...`, null);
        const result = await window.electronAPI.wifiConnect(name);
        if (result.success) {
            this.speak(`Connected to ${result.ssid}, Sir.`);
            this.displayText(`Connected: ${result.ssid}`, null);
        } else {
            this.speak(result.error);
            this.displayText(result.error, null);
        }
    }

    async handleWifiDisconnect() {
        if (!window.electronAPI?.wifiDisconnect) {
            this.speak('Wi-Fi control is not available in this environment.');
            return;
        }
        const result = await window.electronAPI.wifiDisconnect();
        if (result.alreadyOff) {
            this.speak('Wi-Fi is already disconnected, Sir.');
        } else if (result.success) {
            this.speak(`Disconnected from ${result.wasSsid || 'the network'}, Sir. No active wireless connection.`);
            this.displayText('Wi-Fi disconnected', null);
        } else {
            this.speak('I issued the disconnect, but Windows still reports a connection. It may auto-reconnect.');
        }
    }

    // Real, measured network + device intelligence — never fabricated numbers.
    async handleWifiInfo() {
        if (!window.electronAPI?.wifiInfo) {
            this.speak('Network intelligence is not available in this environment.');
            return;
        }
        this.displayText('Measuring your connection...', null);
        const n = await window.electronAPI.wifiInfo();
        if (!n.success || !n.connected) {
            this.speak('You are not connected to any Wi-Fi network right now, Sir.');
            return;
        }

        // Full details on the orb
        const lines = [
            `Network: ${n.ssid}`,
            n.bssid ? `Access point: ${n.bssid}` : null,
            n.band || n.radio ? `Radio: ${[n.radio, n.band].filter(Boolean).join(', ')}${n.channel ? `, ch ${n.channel}` : ''}` : null,
            n.signal ? `Signal: ${n.signal}` : null,
            n.linkRateMbps ? `Link rate: ${n.linkRateMbps} Mbps` : null,
            n.security ? `Security: ${n.security}` : null,
            n.ipv4 ? `IP: ${n.ipv4}` : null,
            n.gateway ? `Gateway: ${n.gateway}${n.gatewayLatencyMs != null ? ` (${n.gatewayLatencyMs} ms)` : ''}` : null,
            n.dns?.length ? `DNS: ${n.dns.join(', ')}` : null,
            n.internetLatencyMs != null ? `Internet: ${n.internetLatencyMs} ms, ${n.packetLossPct}% loss` : `Internet: unreachable`,
            `Quality: ${n.quality}`,
        ].filter(Boolean);
        this.displayText(lines.join('\n'), null);

        // Concise spoken summary — evidence first, like a real diagnostic
        const parts = [`You are on ${n.ssid}`];
        if (n.signal) parts.push(`signal ${n.signal}`);
        if (n.band) parts.push(n.band);
        if (n.linkRateMbps) parts.push(`${n.linkRateMbps} megabits`);
        if (n.internetReachable && n.internetLatencyMs != null) {
            parts.push(`internet latency ${n.internetLatencyMs} milliseconds`);
            parts.push(n.packetLossPct === 0 ? 'no packet loss' : `${n.packetLossPct} percent packet loss`);
            parts.push(`connection quality is ${n.quality}`);
        } else {
            parts.push('but the internet is not reachable');
        }
        this.speak(parts.join('. ') + ', Sir.');
    }

    // Bluetooth audio status (voice: "earbuds status" / "headphone battery")
    async handleEarbudsStatus() {
        if (!window.electronAPI?.getBluetoothAudio) {
            this.speak('Bluetooth status is not available in this environment.');
            return;
        }
        this.displayText('Checking Bluetooth devices...', null);
        const result = await window.electronAPI.getBluetoothAudio();
        if (!result.success || !result.devices.length) {
            this.speak('I could not find any Bluetooth audio devices.');
            return;
        }
        const connected = result.devices.filter(d => d.connected);
        if (!connected.length) {
            this.speak('No Bluetooth devices are currently connected.');
            return;
        }
        const parts = connected.map(d =>
            d.battery != null ? `${d.name} at ${d.battery} percent` : `${d.name}, battery unknown`
        );
        this.speak(`Connected: ${parts.join('. ')}.`);
        this.displayText(connected.map(d => `${d.name} - ${d.battery != null ? d.battery + '%' : 'battery n/a'}`).join('\n'), null);
    }

    // Meeting mode: route audio to connected earbuds and confirm readiness
    async handleMeetingMode() {
        this.displayText('Configuring meeting mode...', null);
        const bt = window.electronAPI?.getBluetoothAudio
            ? await window.electronAPI.getBluetoothAudio()
            : { success: false, devices: [] };
        const buds = (bt.devices || []).find(d => d.connected &&
            /buds|pods|headphone|headset|earphone/i.test(d.name)) || (bt.devices || []).find(d => d.connected);

        if (!buds) {
            this.speak('Meeting mode: I could not find connected earbuds. Connect them and try again.');
            return;
        }

        const sw = await window.electronAPI.switchAudioOutput(buds.name);
        if (sw.success) {
            const battery = buds.battery != null ? ` Earbuds at ${buds.battery} percent.` : '';
            this.speak(`Audio routed to ${buds.name}.${battery} You are ready, Sir.`);
        } else {
            // Most likely: SoundVolumeView.exe not yet placed in bin/
            this.speak(`Earbuds are connected, but I could not switch the audio output. ${sw.error}`);
            this.displayText(sw.error, null);
        }
    }

    // Common name -> ticker mapping for voice commands
    static SYMBOL_MAP = {
        bitcoin: 'BTC-USD', ethereum: 'ETH-USD', solana: 'SOL-USD',
        apple: 'AAPL', tesla: 'TSLA', nvidia: 'NVDA', microsoft: 'MSFT',
        google: 'GOOGL', amazon: 'AMZN', meta: 'META', netflix: 'NFLX'
    };

    _resolveSymbol(raw) {
        const key = String(raw).toLowerCase();
        return (Jarvis.SYMBOL_MAP[key] || raw).toUpperCase();
    }

    // Typed command: "store key <name> <value>" — value goes straight to the
    // OS-encrypted vault. Never spoken back, never sent to any LLM, never
    // stored in conversation memory (this path bypasses handleAICommand).
    async handleStoreKey(raw) {
        const parts = String(raw).trim().split(/\s+/);
        // ["store"|"set", "key", name, value...]
        if (parts.length < 4) {
            this.speak('Usage: store key, then the key name, then the value. For example: store key alpaca_key_id, then your ID.');
            return;
        }
        const name = parts[2];
        const value = parts.slice(3).join(' ');
        const result = await window.electronAPI.secureCredSet(name, value);
        if (result.success) {
            this.speak(`Key ${result.name} stored securely.`);
            this.displayText(`Stored: ${result.name} (${value.slice(0, 4)}${'*'.repeat(8)})`, null);
        } else {
            this.speak(`I could not store that key. ${result.error}`);
        }
    }

    async handleListKeys() {
        const names = await window.electronAPI.secureCredList();
        if (!names.length) {
            this.speak('The credential vault is empty. For market data via Alpaca, store alpaca_key_id and alpaca_secret.');
            return;
        }
        this.speak(`Stored keys: ${names.join(', ')}.`);
        this.displayText(`Vault: ${names.join(', ')}`, null);
    }

    // Finance watchlist handlers (read/manage only — no trading exists)
    async handleWatchlistAdd(rawSymbol, target, stop) {
        const symbol = this._resolveSymbol(rawSymbol);
        const result = await window.electronAPI.watchlistAdd({ symbol, target, stop });
        if (!result.success) {
            this.speak(`I could not add that. ${result.error}`);
            return;
        }
        const parts = [`${symbol} added to your watchlist`];
        if (target) parts.push(`target ${target}`);
        if (stop) parts.push(`stop ${stop}`);
        this.speak(`${parts.join(', ')}. I will alert you on a crossing.`);
    }

    async handleWatchlistRemove(rawSymbol) {
        const symbol = this._resolveSymbol(rawSymbol);
        await window.electronAPI.watchlistRemove(symbol);
        this.speak(`${symbol} removed from your watchlist.`);
    }

    async handleWatchlistShow() {
        const list = await window.electronAPI.watchlistGet();
        if (!list.length) {
            this.speak('Your watchlist is empty. Say: watch Apple at 190, or: add BTC-USD to watchlist.');
            return;
        }
        const lines = list.map(item => {
            const q = item.quote;
            const price = q ? this._fmtMoney(q.price, q.currency) : 'fetching';
            const chg = q && q.changePct != null
                ? `  ${q.changePct >= 0 ? '▲' : '▼'} ${Math.abs(q.changePct).toFixed(2)}%` : '';
            const extras = [
                item.target ? `target ${item.target}` : null,
                item.stop ? `stop ${item.stop}` : null
            ].filter(Boolean).join(', ');
            return `${item.symbol}: ${price}${chg}${extras ? ` (${extras})` : ''}`;
        });
        this.displayText(`Watchlist\n${lines.join('\n')}`, null);
        const spoken = list.slice(0, 5).map(item => {
            const q = item.quote;
            if (!q) return `${item.symbol}, price unknown`;
            const chg = q.changePct != null
                ? `, ${q.changePct >= 0 ? 'up' : 'down'} ${Math.abs(q.changePct).toFixed(1)} percent` : '';
            return `${item.symbol} at ${this._fmtMoney(q.price, q.currency)}${chg}`;
        }).join('. ');
        this.speak(spoken + '.');
    }

    // Speak the phone pairing instructions (voice command: "phone setup")
    async handlePhoneBridgeSetup() {
        if (!window.electronAPI?.getPhoneBridgeInfo) {
            this.speak('Phone bridge is not available in this environment.');
            return;
        }
        const info = await window.electronAPI.getPhoneBridgeInfo();
        if (!info.running || !info.exampleUrl) {
            this.speak('The phone bridge server is not running.');
            return;
        }
        this.displayText(
            `Phone Bridge Setup\n` +
            `1. Install MacroDroid on your phone (free)\n` +
            `2. New macro: Trigger = Notification Received (any app)\n` +
            `3. Action = HTTP Request, POST, JSON body:\n` +
            `   {"app":"[not_app_name]","title":"[not_title]","text":"[not_text]"}\n` +
            `4. URL: ${info.exampleUrl}\n` +
            `Phone and PC must be on the same Wi-Fi. Allow Jarvis through the Windows firewall when prompted.`,
            null
        );
        this.speak('Phone bridge details are on screen. Set up MacroDroid with the displayed URL, and I will announce your phone notifications in real time.');
    }

    // AI Command Handler — routes to cloud Gemini Live or local Gemma (Ollama)
    async handleAICommand(query) {
        try {
            this.displayText('Processing your request...', null);

            // Add user message to local memory for UI/logging
            this.memory.addMessage('user', query);

            // Local Mode: 100% private inference via Ollama (settings.llmProvider)
            if (this.settings.get('llmProvider') === 'gemma-local') {
                await this.handleLocalAICommand(query);
                return;
            }

            if (this.liveService && this.liveService.isConnected) {
                this.liveService.sendText(query);
            } else {
                this.speak("Connecting to neural link... please wait.");
                await this.liveService.connect();
                this.liveService.sendText(query);
            }
        } catch (error) {
            console.error('AI command error:', error);
            this.speak('I apologize, but I encountered an error processing your request.');
        }
    }

    // Local AI Command Handler (Gemma via Ollama, streamed to the display)
    async handleLocalAICommand(query) {
        const status = await checkOllama();
        if (!status.available) {
            this.speak('Local mode is enabled but the Ollama server is not responding. Start Ollama or switch back to cloud mode.');
            return;
        }

        // OBEDIENCE LAYER: imperative-sounding requests that no regex intent
        // caught get classified by Gemma into an executable action before we
        // fall back to conversation. "Play some music on YouTube" -> opens
        // youtube.com instead of an apologetic paragraph.
        if (/^(open|play|launch|start|go to|visit|show me|put on|bring up)\b/i.test(query)) {
            const route = await routeLocalAction(query);
            switch (route.action) {
                case 'open_app':
                    await this.handleOpenApp(route.arg);
                    return;
                case 'open_website': {
                    const site = route.arg.replace(/^https?:\/\//, '');
                    window.electronAPI?.openWebsite(`https://${site}`);
                    this.speak(`Opening ${site}, Sir.`);
                    return;
                }
                case 'web_search':
                    query = `search ${route.arg}`; // falls through to grounded chat below
                    break;
                case 'remember': {
                    const r = await ragService.ingest(route.arg, { source: 'voice-note' });
                    this.speak(r.stored ? 'Noted and stored, Sir.' : 'Already in memory, Sir.');
                    return;
                }
                case 'recall':
                    query = `what do I have in memory about ${route.arg}`;
                    break;
                // 'none' -> conversational answer below
            }
        }

        // Hybrid RAG recall: prepend long-term memory relevant to the query.
        // Kept small and best-first per the retrieval-generation gap findings
        // (arXiv:2606.25656 — more context does not mean better answers).
        let memoryContext = '';
        try {
            // Typed input can afford the reranker's ~5s; spoken input cannot,
            // so voice keeps the fast lexical ordering.
            const { context } = await ragService.recall(query, {
                rerank: !this._lastInputWasVoice
            });
            if (context) memoryContext = `\n\nRelevant long-term memory (most relevant first):\n${context}`;
        } catch (e) {
            console.warn('RAG recall failed (continuing without):', e);
        }

        // Live system grounding: questions about "my system/pc/cpu" get real
        // telemetry injected (observed user need: "know something about my system")
        let sysContext = '';
        if (/\b(my (system|computer|pc|laptop)|cpu|ram\b|memory usage|system status|uptime|what am i (working|running))\b/i.test(query)
            && window.electronAPI?.getSystemTelemetry) {
            try {
                const t = await window.electronAPI.getSystemTelemetry();
                sysContext = `\n\nLive system telemetry right now: CPU ${t.cpu}% across ${t.cores} cores, RAM ${t.memUsedGb}/${t.memTotalGb} GB (${t.memPercent}%), uptime ${t.uptimeHours}h, active window: ${t.activeWindow?.app ? t.activeWindow.app + ' - ' + t.activeWindow.title : 'unknown'}.`;
            } catch { /* answer without */ }
        }

        // Live web grounding: for search-shaped questions, fetch keyless
        // DuckDuckGo results and let Gemma answer from them with sources.
        let webContext = '';
        const needsWeb = /\b(search|look up|google|news|latest|current|today|yesterday|price of|who is|what is|happening|weather in)\b/i.test(query);
        if (needsWeb && window.electronAPI?.webSearch) {
            try {
                this.displayText('Searching the web...', null);
                const web = await window.electronAPI.webSearch(query);
                if (web.success && web.results.length) {
                    const lines = web.results.map((r, i) => `[${i + 1}] ${r.title} - ${r.snippet}`);
                    // The literal token "[n]" used to appear in this instruction
                    // and Gemma copied it straight into its answers — nearly
                    // every logged reply ended in "[n] 1 & 2", which then got
                    // spoken aloud as "and one and two".
                    webContext = `\n\nLive web search results for "${query}". Use them only if they are relevant, and refer to a source inline as [1] or [2]. Never write the placeholder "[n]".\n${lines.join('\n')}`;
                }
            } catch (e) {
                console.warn('Web search failed (continuing without):', e);
            }
        }

        // Build context from conversation memory (map to Ollama roles).
        //
        // processAICommand() already pushed this turn's user message into
        // memory, so the tail of the history IS the current query. Appending
        // `query` again sent it to Gemma twice, back to back — which the model
        // faithfully described ("the repeated query", "duplicate search query",
        // "I have executed the repeated command to close Chrome twice") and
        // which derailed most of the conversation log. Drop the duplicate here
        // rather than skipping the append, because `query` may have been
        // rewritten above (web_search / recall routing) and the rewrite is what
        // should reach the model.
        const history = this.memory.getContextMessages().slice(-11);
        if (history.length && history[history.length - 1].role === 'user') history.pop();

        const messages = [
            {
                role: 'system',
                content: 'You are Jarvis, a highly advanced AI assistant running fully locally and privately on the machine of Ashutosh, a software engineer and security researcher. Address him as Sir. Be helpful, precise, and concise — your answers are spoken aloud, so keep them to 1-3 short sentences unless asked for detail. Never use emojis or emoticons. If asked to do something you have no tool for, say so plainly in one sentence.'
                    // Without this, the model narrated actions it never took
                    // ("Tab opened, rows closed", "I have initiated playback of
                    // the requested video stream") because it receives no
                    // execution feedback and pattern-matches an obedient reply.
                    + ' You cannot open, close, play, or control anything yourself; a separate command layer does that and it reports back to the user directly. Never claim you performed an action. If a request needs an action, say what you would do, in one sentence.'
                    // The input is speech-to-text, so it arrives garbled, with
                    // fragments and mis-hearings. Earlier logs show the model
                    // treating that noise as meaningful and inventing theories
                    // about "system probing" and "diagnostic loops".
                    + ' Your input comes from speech recognition and may be garbled or incomplete. If a message is unclear, briefly ask what he meant. Never speculate about system probing, diagnostics, repeated input, or your own internal state.'
                    + sysContext + memoryContext + webContext
            },
            ...history,
            { role: 'user', content: query }
        ];

        // STREAMING SPEECH: speak each sentence the moment it completes in
        // the token stream, instead of waiting for the whole answer. Cuts
        // time-to-first-word from ~5-10s to ~1-2s.
        let displayed = '';
        let spokenUpTo = 0;
        try {
            const fullText = await generateContentLocal(messages, (chunk) => {
                displayed += chunk;
                this.displayText(displayed, null);

                // Find complete sentences beyond what we've already spoken
                const pending = displayed.slice(spokenUpTo);
                const m = pending.match(/^[\s\S]*?[.!?](?=\s|$)/);
                if (m && m[0].trim().length > 1) {
                    spokenUpTo += m[0].length;
                    this._speakQueued(m[0]);
                }
            });
            // Speak whatever remains after the stream ends
            const tail = displayed.slice(spokenUpTo).trim();
            if (tail) this._speakQueued(tail);
            this.memory.addMessage('assistant', fullText);
        } catch (error) {
            console.error('Local AI error:', error);
            this.speak('Local inference failed. ' + error.message);
        }
    }

    // Queued speech for streaming answers: does NOT cancel prior utterances
    // (unlike speak(), which flushes). Keeps the mic gate (ttsActive) held
    // until the last queued utterance finishes.
    _speakQueued(text) {
        try {
            // Same cleanup as speak(). This is the path Gemma's streamed
            // answers take, so it is the one that was actually reading "[n] 1
            // & 2" aloud — it had drifted out of sync with speak()'s filter.
            const clean = String(text)
                .replace(/```[\s\S]*?```/g, ' code block omitted ')
                .replace(/\[\s*n\s*\]/gi, '')
                .replace(/\[\s*\d+(\s*(,|&|and)\s*\d+)*\s*\]/g, '')
                .replace(/[*_#`>|]/g, '')
                .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
                .replace(/\s+/g, ' ')
                .trim();
            if (!clean) return;

            this._rememberSpoken(clean);

            this._utterCount = (this._utterCount || 0) + 1;
            this.ttsActive = true;

            const u = new SpeechSynthesisUtterance(clean);
            if (this.selectedVoice) u.voice = this.selectedVoice;
            u.rate = this.settings.get('speechRate') || 1.0;
            u.pitch = this.settings.get('speechPitch') || 1.0;
            u.volume = this.settings.get('speechVolume') || 1.0;
            const done = () => {
                this._utterCount = Math.max(0, (this._utterCount || 1) - 1);
                if (this._utterCount === 0) this.ttsActive = false;
            };
            u.onend = done;
            u.onerror = done;
            this.synthesis.speak(u);
        } catch (e) {
            console.warn('Queued TTS failed:', e);
        }
    }
}

export default Jarvis;

