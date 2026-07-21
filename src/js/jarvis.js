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
import * as chainIntel from './services/chainIntel.js';
import * as prediction from './services/predictionMarkets.js';
import * as security from './services/security.js';
import * as feeds from './services/feeds.js';
import { parseOndoQuery, ONDO_COUNT, HOT_LIST as ONDO_HOT_LIST } from './services/ondoRegistry.js';
import * as netInspect from './services/netInspect.js';
import * as netDiscovery from './services/netDiscovery.js';
import * as sysInspect from './services/sysInspect.js';
import * as inputControl from './services/inputControl.js';
import { LocalVoiceService } from './services/voiceService.js';
import { guardOutput } from './services/groundingGuard.js';
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

        /* Feed ingestion: once 90s after boot, then every 6 hours. SILENT by
           design — the corpus is the product, not the announcement, and an
           assistant that reads the news aloud unprompted is a worse assistant.
           Ask "brief me" to hear it. Staggered well clear of reflection so the
           two never contend for the embedder. */
        setTimeout(() => {
            this.ingestFeeds({ announce: false }).catch(e => console.warn('Feed ingest skipped:', e.message));
            setInterval(() => {
                if (this.isProcessing || this.ttsActive) return;   // never mid-turn
                this.ingestFeeds({ announce: false }).catch(() => {});
            }, 6 * 60 * 60 * 1000);
        }, 90000);

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
                    // Re-check inside the timer, not only before arming it: a
                    // turn can start during these 500ms, and dispatching on the
                    // stale check is what let turns overlap in the logs.
                    setTimeout(() => {
                        if (!this.isProcessing) this.processCommand(command);
                    }, 500);
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
            this._flushSpeechQueue();

            /* Multi-sentence answers go through the paced queue so they get the
               same breathing room as streamed ones. A whale alert is three
               facts — amount, both parties, the block — and running them
               together is what makes the delivery feel rushed. Single-sentence
               answers keep the direct path below, including its resume() nudge
               for Chromium's long-utterance pause bug. */
            const sentences = clean.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g)?.map(s => s.trim()).filter(Boolean) || [];
            if (sentences.length > 1) {
                this.ttsActive = true;
                this._utterCount = sentences.length;
                this._speechQueue = sentences;
                this._drainSpeech();
                return;
            }

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

        /* A PASTED DOCUMENT IS NOT A COMMAND.
           From the log: a Chrome release announcement was pasted three times in
           a row and each time answered "Your phone is not linked, Sir" —
           because the text happened to contain the word Android. Every action
           matcher below scans for keywords, and a long document will always
           contain some of them, so a paste can trigger an arbitrary action.
           Length and line count are what separate the two: nobody speaks 300
           characters, and a spoken command is never multi-paragraph. Documents
           go to the model as material to read, which is what pasting one
           means. */
        const looksPasted = command.length > 280 || (command.match(/\n/g) || []).length >= 2;
        if (looksPasted) return { intent: 'AI_COMMAND', pastedDocument: true };

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
        // Keyboard/window control ("type ...", "press enter", "close notepad").
        // Checked before the system/network matchers so "close chrome" acts on
        // the window rather than being read as a process question.
        const inputQ = inputControl.parseInputCommand(command);
        if (inputQ) return inputQ;

        // Process/system-activity questions. Checked before the socket matcher
        // so "what's using my CPU" is not read as a network question.
        const sysQ = this.parseSystemQuery(cmd);
        if (sysQ) return sysQ;

        // Live socket-level questions ("what IP are you connected to", "who is
        // my computer talking to", "which ports are open"). Checked BEFORE the
        // Wi-Fi matcher: the log shows "why don't you have network details...
        // every IP address and packet flow" being answered with the Wi-Fi link
        // report, which describes the radio, not the connections.
        const netQ = this.parseNetworkQuery(cmd);
        if (netQ) return netQ;

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

        // Finance watchlist. Whale-stream and address-watch commands must fall
        // through to the chain parser — a real log shows "watch for whales"
        // becoming WATCHLIST_ADD "FOR" because this block ran first.
        if ((cmd.includes('watchlist') || cmd.startsWith('watch ')) &&
            !/\b(whales?|large transfers?|big moves?)\b/.test(cmd) &&
            !/0x[0-9a-fA-F]{40}/.test(cmd) && !/\b[a-z0-9-]+\.eth\b/.test(cmd)) {
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

        /* FEED BRIEF — "brief me", "what changed today", "anything new".
           Checked before the news matcher: this reads the ingested event log
           with provenance, which is a different and better answer than a fresh
           headline scrape. */
        if (/\b(brief me|briefing|what'?s changed|what changed|anything new|catch me up on (the )?feeds?|feed brief|what did i miss)\b/.test(cmd)) {
            const h = /\bweek\b/.test(cmd) ? 168 : /\bhour\b/.test(cmd) ? 1 : 24;
            return { intent: 'FEED_BRIEF', hours: h };
        }

        /* SECURITY ADVISORIES. Checked before news and before the AI fallback,
           because this is the exact query that produced an invented CVE
           severity and then a defended correction. A CVE identifier is now
           answered from NVD, and "latest chrome vulnerabilities" from the
           Chrome Releases feed — never from the model. */
        {
            const cveId = security.extractCveId(cmd);
            if (cveId && /\b(what|which|tell|about|severity|score|details?|look ?up|explain|is)\b/.test(cmd)) {
                return { intent: 'CVE_LOOKUP', cveId };
            }
            if (/\b(cve|vulnerabilit(y|ies)|security (fix|fixes|update|patch|advisor)|patched?|zero.?day)\b/.test(cmd)
                && /\b(chrome|chromium|browser)\b/.test(cmd)) {
                return { intent: 'SECURITY_ADVISORY' };
            }
            if (cveId) return { intent: 'CVE_LOOKUP', cveId };
        }

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
        /* TURN SERIALISATION.
           Callers check `isProcessing` before dispatching, but the wake-word
           path checks it and THEN defers by 500ms (see onresult), so the check
           is stale by the time the turn actually starts. With a slow local
           model that window is wide open, and the 21 Jul 2026 log caught it:
           four turns at 15:03:25-15:03:50 completed inside 25 seconds while
           each reported 33-51s of latency, and their answers were shifted onto
           each other's inputs ("time" answered about stocks, "search latest
           stocks data" answered about the time).

           The new turn wins — a user who speaks again is correcting course, not
           queueing — so the in-flight one is aborted rather than blocked. */
        this._turnSeq = (this._turnSeq || 0) + 1;
        const turnId = this._turnSeq;
        if (this._turnAbort) {
            try { this._turnAbort.abort(); } catch { /* already settled */ }
        }
        const turnAbort = new AbortController();
        this._turnAbort = turnAbort;

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

        // Interaction-log bookkeeping: this turn's response buffer (filled by
        // _rememberSpoken) and the latency clock.
        //
        // The buffer is an object owned by THIS invocation, not a shared field.
        // It used to be `this._turnResponse`, so a superseded turn's late speech
        // accumulated into whatever turn was current when it finally arrived and
        // got logged under that turn's input. Holding the reference locally
        // means a turn can only ever log its own words.
        const _turnStartedAt = Date.now();
        const _buf = { text: '' };
        this._activeBuffer = _buf;
        let _turnOk = true;

        // A pending "shall I…?" owns the next turn: "yes"/"do it" must complete
        // the offered action rather than being re-parsed as a fresh command.
        if (this._pendingConfirm) {
            try {
                if (await this._consumeConfirmation(command)) {
                    this._logInteraction(command, { intent: 'CONFIRMATION' }, _turnStartedAt, true, _buf);
                    this.isProcessing = false;
                    if (this.commandInput) this.commandInput.disabled = false;
                    return;
                }
            } catch (e) { console.error('Confirmation error:', e); this._pendingConfirm = null; }
        }

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
                case 'NET_CONNECTIONS':
                    await this.handleNetConnections();
                    break;
                case 'NET_PROCESS':
                    await this.handleNetProcess(intent.name);
                    break;
                case 'NET_LISTENING':
                    await this.handleNetListening();
                    break;
                case 'NET_TRAFFIC':
                    await this.handleNetTraffic();
                    break;
                case 'NET_CAPTURE_INFO':
                    await this.handleNetCaptureInfo();
                    break;
                case 'SYS_TOP':
                    await this.handleSysTop(intent.resource);
                    break;
                case 'SYS_PROCESSES':
                    await this.handleSysProcesses();
                    break;
                case 'SYS_PROCESS':
                    await this.handleSysProcess(intent.name);
                    break;
                case 'SYS_OVERVIEW':
                    await this.handleSysOverview();
                    break;
                case 'DICTATE_START':
                    await this.handleDictateStart();
                    break;
                case 'TYPE_TEXT':
                    await this.handleTypeText(intent);
                    break;
                case 'PRESS_KEY':
                    await this.handlePressKey(intent);
                    break;
                case 'FOCUS_WINDOW':
                    await this.handleFocusWindow(intent.name);
                    break;
                case 'CLOSE_APP':
                    await this.handleCloseApp(intent.name);
                    break;
                case 'FOCUSED_WINDOW':
                    await this.handleFocusedWindow();
                    break;
                case 'SYS_HISTORY':
                    await this.handleSysHistory(intent.hours);
                    break;
                case 'SYS_EVENTS':
                    await this.handleSysEvents(intent.hours);
                    break;
                case 'RESOLVE_HOST':
                    await this.handleResolveHost(intent.target);
                    break;
                case 'WIFI_NETWORK_DETAIL':
                    await this.handleWifiNetworkDetail(intent.ssid);
                    break;
                case 'LAN_DEVICES':
                    await this.handleLanDevices();
                    break;
                case 'BT_DEVICES':
                    await this.handleBluetoothDevices();
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
                case 'FEED_BRIEF':
                    await this.handleFeedBrief(intent.hours);
                    break;
                case 'SECURITY_ADVISORY':
                    await this.handleSecurityAdvisory();
                    break;
                case 'CVE_LOOKUP':
                    await this.handleCveLookup(intent.cveId);
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
            // A superseded turn was cancelled on purpose — the user spoke again.
            // It is not a failure and must not apologise over the new answer.
            if (error?.name === 'AbortError' || turnAbort.signal.aborted) {
                console.log(`Turn ${turnId} superseded by a newer command.`);
            } else {
                console.error('Command processing error:', error);
                _turnOk = false;
                this.speak('I apologize, but I encountered an error processing that command.');
            }
        } finally {
            const superseded = turnId !== this._turnSeq;

            // Persist the turn for later analysis, from ITS OWN buffer.
            this._logInteraction(command, intent, _turnStartedAt, _turnOk && !superseded, _buf);
            /* Remember answers that came from MEASUREMENT rather than the model,
               so a bare follow-up is grounded in them. AI_COMMAND is excluded
               on purpose: feeding a model's own output back as "factual" is how
               an invented device name would become established truth. */
            if (_turnOk && !superseded && intent.intent !== 'AI_COMMAND' && _buf.text) {
                this._rememberFactualAnswer(intent.intent, _buf.text);
            }

            /* Only the newest turn owns the input loop. A superseded turn
               reaching its finally must not clear isProcessing or restart the
               recogniser underneath the turn that replaced it. */
            if (!superseded) {
                this.isProcessing = false;
                this.wakeWordDetected = false;
                if (this.commandInput) {
                    this.commandInput.disabled = false;
                }
                this.startAlwaysOnListening();
            }
        }
    }

    // System Control Handlers
    async handleOpenApp(app) {
        if (!window.electronAPI) { this.speak(`I cannot open ${app} in this environment`); return; }
        window.electronAPI.openApp(app);

        /* Text-editing apps are the whole point of voice typing, so offer it
           rather than making the user ask separately. The offer waits for the
           window to actually appear and takes focus from the REAL window —
           never from a process picked by name, which is how a test of mine
           once typed into an unrelated document that happened to be open. */
        const TEXT_APPS = ['notepad', 'wordpad', 'word', 'vscode', 'code'];
        if (!TEXT_APPS.includes(String(app).toLowerCase()) || !window.electronAPI.focusedWindow) {
            this.speak(`Opening ${app}`);
            return;
        }
        this.speak(`Opening ${app}`);
        const before = (await window.electronAPI.focusedWindow().catch(() => null))?.pid;
        for (let i = 0; i < 12; i++) {
            await new Promise(r => setTimeout(r, 500));
            const now = await window.electronAPI.focusedWindow().catch(() => null);
            if (now?.success && now.pid && now.pid !== before &&
                String(now.process || '').toLowerCase() !== 'electron') {
                this._armConfirmation('dictate-start', 'start voice typing');
                this.displayText(`${now.title} is ready. Say "yes" to start voice typing, or "start typing" any time.`, null);
                this.speak(`${app} is open, Sir. Shall I start voice typing into it?`);
                return;
            }
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

    /* Screen Analysis Handler.
       screenshot -> base64 -> local Gemma vision -> spoken answer. Fully
       offline; gemma3 is multimodal. Answers the user's ACTUAL question
       ("what error is showing?") rather than a fixed prompt.

       NOTE the fallback order, because a stale comment here previously claimed
       a Gemini Vision fallback and an audit reasonably read that as the code
       sending screenshots to Google. It does not, and has not since vision went
       local: the only fallback is the OPTIONAL Unlimited-OCR server, which also
       runs on loopback. If neither is up, the screen is not read and that is
       said plainly. No capture leaves this machine on this path. */
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
        if ((m = cmd.match(/\bhow much (?:is|are|does)\s+(.+?)(?:\s+cost|\s+worth|\s+trading|\s+stock|\s+shares?)?\s*\??$/i))) {
            const ent = clean(m[1]);
            // Fires on a finance word ("how much is X worth") OR a known asset
            // name. Real log: "how much is bitcoin" had neither guard-word, fell
            // to Gemma, and Gemma fabricated "$17,500" — the exact failure the
            // deterministic quote engine exists to prevent.
            const known = ent && Jarvis.SYMBOL_MAP[ent.toLowerCase()];
            if (ent && (known || /\b(stock|shares?|worth|trading|cost|price)\b/i.test(cmd))) return ent;
        }
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
            return { topic: this._resolveNewsPronoun(clean(m[1])) };
        if ((m = cmd.match(/\bwhat(?:'s| is| has| are)\s+(?:the\s+)?(?:latest|happening|new|going on)\s+(?:on|with|about|in|for)\s+(.+)/i)))
            return { topic: this._resolveNewsPronoun(clean(m[1])) };

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
            if (head) return { topic: this._resolveNewsPronoun(head) };
        }
        // Mentions news but no clean topic -> top headlines.
        return { topic: '' };
    }

    /* "news about him" — a pronoun is not a search term.
       From the log: "yesterdays news about him", one turn after asking about
       Elon Musk, searched for the literal word "him" and returned three
       unrelated stories that all happened to contain it. A pronoun refers to
       the last subject asked about, so that is what it resolves to; with no
       prior subject it falls back to headlines rather than searching for a
       word that means nothing on its own. */
    _resolveNewsPronoun(topic) {
        const t = String(topic || '').trim();
        if (!/^(him|her|them|it|he|she|they|that|this|those)$/i.test(t)) {
            if (t) this._lastNewsSubject = t;   // remember real subjects
            return t;
        }
        return this._lastNewsSubject || '';
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

        /* PREDICTION MARKETS. Checked first among chain intents because "odds"
           and "prediction market" are unambiguous, and because a question like
           "what are the odds bitcoin hits 200k" would otherwise be read as a
           crypto price query and answered with a spot price — a different
           question with a different answer. */
        // `markets?` — the third time a missing plural has sent a whole feature
        // to the model instead of its handler ("whale alerts", "usdc burns").
        if (/\b(prediction markets?|polymarket|kalshi)\b/i.test(text) ||
            /\b(odds|chances?|probability|likelihood)\b.*\b(of|on|that|for)\b/i.test(text)) {
            if (/\b(trending|most active|popular|what'?s hot|top market)/i.test(text)) {
                return { kind: 'prediction-trending', chain: 'ethereum' };
            }
            if (/\b(compare|versus|vs\b|both platforms|difference between)/i.test(text)) {
                return { kind: 'prediction-compare', query: text, chain: 'ethereum' };
            }
            // Everything left is a search: strip the scaffolding, keep the subject.
            const q = text
                .replace(/\b(hey )?jarvis\b/gi, '')
                .replace(/\b(what (are|is) the|show me|find|search|get|tell me)\b/gi, '')
                .replace(/\b(odds|chances?|probability|likelihood|prediction markets?|markets?)\b/gi, '')
                .replace(/\b(on|of|for|that|about|in)\b/gi, ' ')
                .replace(/\b(polymarket|kalshi)\b/gi, '')
                .replace(/[?.!]+$/, '').replace(/\s+/g, ' ').trim();
            const source = /\bpolymarket\b/i.test(text) ? 'polymarket'
                : /\bkalshi\b/i.test(text) ? 'kalshi' : 'both';
            if (q.length > 2) return { kind: 'prediction-search', query: q, source, chain: 'ethereum' };
            return { kind: 'prediction-trending', chain: 'ethereum' };
        }

        // Transaction decode — a 0x…(64 hex) hash. "explain/what happened in tx 0x…".
        const txMatch = text.match(/0x[0-9a-fA-F]{64}/);
        if (txMatch) return { kind: 'tx', hash: txMatch[0], chain: onchain.resolveChain(text, 'ethereum') };

        // Which chains can actually be read right now — "which chains can you
        // read", "chain providers", "are you connected to alchemy".
        if (/\b(which|what) chains?\b.*\b(read|see|access|support)\b/i.test(text) ||
            /\b(chain (providers?|coverage|access)|provider status|alchemy|helius)\b/i.test(text)) {
            return { kind: 'chain-capabilities', chain: 'ethereum' };
        }

        /* Solana. A base58 address is NOT self-identifying the way an 0x address
           is — plenty of ordinary words are valid base58 — so Solana reads
           require the chain to be named explicitly. Speech-safe by design. */
        if (/\bsol(ana)?\b/i.test(text)) {
            const solAddr = (text.match(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/) || [])[0] || null;
            if (solAddr) {
                if (/\b(activity|transactions?|txs?|history|recent|what happened|moves?)\b/i.test(text)) {
                    return { kind: 'solana-activity', address: solAddr, chain: 'solana' };
                }
                return { kind: 'solana-assets', address: solAddr, chain: 'solana' };
            }
        }

        // Ondo GM tokenized securities — "supply of tokenized apple", "mints and
        // redemptions for tokenized nvidia", "top holders of aaplon". The parser
        // is strictly gated (see ondoRegistry.js) so quote/quant/news speech
        // ("price of apple", "analyze tesla") is never stolen.
        const ondoQ = parseOndoQuery(text);
        if (ondoQ) return { chain: 'ethereum', ...ondoQ };

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
        /* Stablecoin issuance — "did Circle mint any USDC", "any big USDC
           burns today", "stablecoin supply". Checked BEFORE the whale block:
           "big USDC mints" contains no whale word, but "whale" plus "mint"
           would otherwise route to the whale stream. */
        // Plurals matter: "whale alerts" and "usdc burns" both fell through to
        // the model in his log because the regexes only matched the singular.
        if (/\b(mints?|minted|minting|burns?|burned|burnt|issuance|issued|supply)\b/i.test(text) &&
            /\b(usdc|usdt|tether|circle|stablecoins?|dai)\b/i.test(text)) {
            const solana = /\bsol(ana)?\b/i.test(text);
            return { kind: solana ? 'solana-supply' : 'issuance', chain: solana ? 'solana' : 'ethereum' };
        }

        /* Whale stream control. NOTE the `s?` on alert: his log has
           "give me whale alerts of solana" falling through this whole block to
           the model, which then invented an entire workflow ("I am sending the
           command to begin searching... the search is complete, no alerts
           available"). The plural simply did not match. */
        if (/\b(whales?|large transfers?|big moves?)\b/i.test(text)) {
            /* A chain this stream does not cover must be answered honestly, not
               by starting an Ethereum stream and calling it Solana. */
            const askedChain = /\bsol(ana)?\b/i.test(text) ? 'solana'
                : /\b(bitcoin|btc)\b/i.test(text) ? 'bitcoin'
                    : /\b(polygon|matic)\b/i.test(text) ? 'polygon' : null;
            if (askedChain) return { kind: 'whale-unsupported', askedChain, chain: 'ethereum' };
            // Recorded activity over a window — "whales in the last hour",
            // "whale summary for the last five minutes".
            if (/\b(last|past)\s+(\d+\s+)?(minute|min|hour|hr)/i.test(text)) {
                return { kind: 'whale-window', text, chain: 'ethereum' };
            }
        }
        if (/\b(whales?|large transfers?|big moves?)\b/i.test(text)) {
            // USD-priced whale flows come from Dune (key-gated) — the local
            // stream sees native-unit transfers only. Checked before the
            // summary so "whale activity today in dollars" routes here.
            if (/\b(dollars?|usd|dollar terms|by (dollar )?value|priced)\b/i.test(text)) {
                return { kind: 'whale-usd', chain: onchain.resolveChain(text, 'ethereum') };
            }
            if (/\b(today|activity|summary|report|recap|so far)\b/i.test(text)) return { kind: 'whale-summary', chain: 'ethereum' };
            if (/\b(stop|off|disable|end|quit)\b/i.test(text)) return { kind: 'whale-stream', action: 'stop', chain: 'ethereum' };
            if (/\b(status|running|active)\b/i.test(text)) return { kind: 'whale-stream', action: 'status', chain: 'ethereum' };
            if (/\b(watch|monitor|alerts?|track|stream|start|on|live|give me|show)\b/i.test(text)) return { kind: 'whale-stream', action: 'start', chain: 'ethereum' };
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
            // Ondo tokenized securities + USD-priced whale flows need no address.
            if (String(intent.kind).startsWith('ondo-')) {
                await this.handleOndoQuery(intent);
                return;
            }
            if (intent.kind === 'whale-usd') {
                await this.handleWhaleUsd(intent);
                return;
            }
            // Keyed-provider reads. Checked before ENS resolution: a Solana
            // address is not an EVM address and has no ENS name to resolve.
            if (intent.kind === 'prediction-search') { await this.handlePredictionSearch(intent.query, intent.source); return; }
            if (intent.kind === 'prediction-trending') { await this.handlePredictionTrending(); return; }
            if (intent.kind === 'prediction-compare') { await this.handlePredictionCompare(intent.query); return; }
            if (intent.kind === 'chain-capabilities') { await this.handleChainCapabilities(); return; }
            if (intent.kind === 'whale-unsupported') { await this.handleWhaleUnsupported(intent.askedChain); return; }
            if (intent.kind === 'whale-window') { await this.handleWhaleWindow(intent.text); return; }
            if (intent.kind === 'issuance') { await this.handleIssuance(); return; }
            if (intent.kind === 'solana-supply') { await this.handleSolanaSupply(); return; }
            if (intent.kind === 'solana-assets') { await this.handleSolanaAssets(intent.address); return; }
            if (intent.kind === 'solana-activity') { await this.handleSolanaActivity(intent.address); return; }

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

    /* =========================
       NETWORK CONNECTION INSPECTION
       Every live socket, its remote IP and owning process — the answer to
       "the IP address you are connected to", which the log shows Gemma
       refusing ("I do not have access to network connection details") because
       the capability genuinely did not exist. All figures come from the pure
       netInspect engine; the model is not in this path. */

    /** Text -> network intent, or null. Ordered so the most specific wins. */
    parseNetworkQuery(cmd) {
        const t = String(cmd || '').toLowerCase();
        if (!t) return null;

        // Packet-level asks are answered with a truthful capability report
        // rather than a pretend capture.
        if (/\b(packet|packets|wireshark|sniff|capture|pcap|deep packet|packet flow|tcpdump)\b/.test(t)) {
            return { intent: 'NET_CAPTURE_INFO' };
        }
        // Bluetooth enumeration. Checked before the audio/earbuds matcher only
        // for scan-shaped phrasings, so "earbuds battery" still routes there.
        if (/\b(bluetooth|bt)\b/.test(t) && /\b(scan|devices|list|nearby|around|near me|discover|find)\b/.test(t)) {
            return { intent: 'BT_DEVICES' };
        }
        // Devices on the LAN — "what devices are on my network", "who else is
        // on my wifi". Distinct from NET_CONNECTIONS (this machine's sockets).
        if (/\b(devices?|machines?|hosts?|who else|anyone else|what else)\b/.test(t) &&
            /\b(on|connected to|joined)\b/.test(t) &&
            /\b(my |the )?(network|wi-?fi|lan|router|hotspot)\b/.test(t)) {
            return { intent: 'LAN_DEVICES' };
        }
        // "what's the IP of <name>" — a REAL resolution. The log shows this
        // falling through to the model, which invented "192.168.1.10"; the
        // number now comes from the resolver or is reported as unresolvable.
        let hm = t.match(/\b(?:what(?:'s| is)?\s+)?(?:the\s+)?ip(?:\s+address)?\s+(?:of|for)\s+([a-z0-9 ._-]{2,40}?)\s*[?.!]*$/);
        if (!hm) hm = t.match(/\b(?:resolve|look ?up|ping)\s+([a-z0-9._-]{2,40})\s*[?.!]*$/);
        if (hm) {
            const raw = hm[1].trim();
            // "ip of this machine / my pc" asks for the LOCAL address, which the
            // Wi-Fi report already answers. Tested against the RAW text: an
            // earlier version stripped the leading "my" first, so "ip of my
            // computer" survived the guard and became a lookup for "computer".
            const isSelf = /^(the|my|your|this|that)?\s*(pc|computer|laptop|machine|system|device|network|wi-?fi|internet|router)$/.test(raw)
                || /^(me|you|us|it|this|that|mine|yours)$/.test(raw);
            const target = raw.replace(/^(the|my|a)\s+/, '');
            if (!isSelf && target) return { intent: 'RESOLVE_HOST', target };
        }
        // Details of a network in range that is NOT the one we are joined to.
        let nm = t.match(/\b(?:details?|info(?:rmation)?|signal|channel|strength|about)\b.*\b(?:network|wi-?fi|ssid)\s+(?:called\s+|named\s+)?([a-z0-9 ._-]{2,40}?)\s*[?.!]*$/);
        if (!nm) nm = t.match(/\b(?:another|other|different)\s+(?:wi-?fi|network)\b.*?\b(?:which is|called|named|is)\s+([a-z0-9 ._-]{2,40}?)\s*[?.!]*$/);
        if (nm) return { intent: 'WIFI_NETWORK_DETAIL', ssid: nm[1].trim() };
        // Data volume moved.
        if (/\b(how much data|data (used|usage|transferred|sent)|bandwidth|bytes (sent|received))\b/.test(t)) {
            return { intent: 'NET_TRAFFIC' };
        }
        // Exposed surface.
        if (/\b(open ports?|listening|ports? (are )?(open|listening)|what.s listening|exposed)\b/.test(t)) {
            return { intent: 'NET_LISTENING' };
        }
        // Per-application: "what is chrome connecting to".
        let m = t.match(/\b(?:what|where|who)\s+(?:is|are)\s+([a-z0-9 ._-]{2,30}?)\s+(?:connect(?:ing|ed)?|talking|sending|reaching)\b/);
        if (m && !/\b(my (pc|computer|laptop|machine|system)|you|jarvis|this (pc|computer|machine))\b/.test(m[1])) {
            return { intent: 'NET_PROCESS', name: m[1].trim() };
        }
        m = t.match(/\b(?:connections?|sockets?|traffic)\s+(?:of|for|from|by)\s+([a-z0-9 ._-]{2,30})\b/);
        if (m) return { intent: 'NET_PROCESS', name: m[1].trim() };

        // General connection questions, including the exact phrasings from the log.
        if (/\b(ip address(es)?|ip'?s)\b.*\b(connect|connected|talking|using|to)\b/.test(t) ||
            /\b(connect(ed|ing)?)\b.*\b(ip address(es)?)\b/.test(t) ||
            /\b(network (connections?|details)|active connections?|open connections?|established connections?)\b/.test(t) ||
            /\b(who|what)\b.*\b(is|are)\b.*\b(my (pc|computer|laptop|machine|system)|this (pc|computer|machine)|we|you)\b.*\b(talking to|connected to|connecting to|communicating with)\b/.test(t) ||
            /\b(show|list|check)\b.*\b(connections?|sockets?)\b/.test(t) ||
            /\bwhat (servers?|hosts?|addresses)\b.*\b(connect|talking)\b/.test(t)) {
            return { intent: 'NET_CONNECTIONS' };
        }
        return null;
    }

    /* Load Windows' own port->service table once per session. Until this
       resolves, ports simply go unnamed — which is correct, because the
       alternative is a hand-written guess list. */
    async _ensurePortServices() {
        if (this._portServicesLoaded) return;
        this._portServicesLoaded = true;
        try {
            const r = await window.electronAPI?.portServices?.();
            if (r?.success) netInspect.setPortServices(netInspect.parseServicesFile(r.text));
        } catch { /* unnamed ports are an acceptable degradation */ }
    }

    /** Fetch + parse the live socket table. Returns rows or null (already spoken). */
    async _netRows() {
        await this._ensurePortServices();
        if (!window.electronAPI?.networkConnections) {
            this.speak('Network inspection is not available in this environment.');
            return null;
        }
        const r = await window.electronAPI.networkConnections();
        if (!r?.success) {
            this.speak(`I could not read the connection table. ${r?.error || ''}`.trim());
            return null;
        }
        return netInspect.parseNetstat(r.netstat, netInspect.parseProcessTable(r.procs));
    }

    async handleNetConnections() {
        this.displayText('Reading the live connection table...', null);
        const rows = await this._netRows();
        if (!rows) return;
        const s = netInspect.summarize(rows);
        if (!s.established) {
            this.speak('There are no established connections right now, Sir.');
            return;
        }
        // Resolve only the public remotes actually being reported.
        const top = s.remotes.filter(r => r.scope === 'public').slice(0, 12);
        let names = {};
        if (window.electronAPI?.networkResolve && top.length) {
            const rr = await window.electronAPI.networkResolve({ addresses: top.map(r => r.address) });
            names = rr?.names || {};
        }
        const label = (r) => (names[r.address] ? `${r.address} (${names[r.address]})` : r.address);
        const lines = top.map(r =>
            `${label(r)}  :${r.ports.join(',')}  ${r.service || ''}  <- ${r.processes.join(', ')}${r.count > 1 ? `  x${r.count}` : ''}`);
        const procLine = s.processes.slice(0, 6).map(p => `${p.name} (${p.count})`).join(', ');
        this.displayText(
            `${s.established} established connections - ${s.scopes.public} to the internet, ${s.scopes.private} on your LAN, ${s.scopes.loopback} internal.\n` +
            `Busiest processes: ${procLine}\n\nRemote hosts:\n${lines.join('\n')}\n\n` +
            `${s.listening} listening sockets. Ask "which ports are open" for the exposed ones.`, null);
        const t1 = s.remotes[0];
        this.speak(
            `${s.established} established connections, Sir. ${s.scopes.public} to the internet, ${s.scopes.private} on your local network, ${s.scopes.loopback} internal to this machine. ` +
            `The busiest process is ${s.processes[0].name} with ${s.processes[0].count}. ` +
            (t1 ? `The most-used remote host is ${names[t1.address] || t1.address}${t1.service ? ` over ${t1.service}` : ''}. ` : '') +
            'The full list is on screen.');
    }

    async handleNetProcess(name) {
        this.displayText(`Checking what ${name} is connected to...`, null);
        const rows = await this._netRows();
        if (!rows) return;
        const mine = netInspect.connectionsForProcess(rows, name);
        if (!mine.length) {
            // Honest distinction: not running vs running with no open sockets.
            const anySocket = rows.some(r => r.process.toLowerCase().includes(String(name).toLowerCase()));
            this.speak(anySocket
                ? `${name} has sockets open but no established connections right now, Sir.`
                : `I see no process matching ${name} with network connections, Sir.`);
            return;
        }
        const remotes = netInspect.groupByRemote(mine);
        const pub = remotes.filter(r => r.scope === 'public').map(r => r.address);
        let names = {};
        if (window.electronAPI?.networkResolve && pub.length) {
            const rr = await window.electronAPI.networkResolve({ addresses: pub.slice(0, 12) });
            names = rr?.names || {};
        }
        const lines = remotes.slice(0, 15).map(r =>
            `${names[r.address] ? `${r.address} (${names[r.address]})` : r.address}  :${r.ports.join(',')}  ${r.service || ''}  ${r.scope}${r.count > 1 ? `  x${r.count}` : ''}`);
        this.displayText(`${mine[0].process}: ${mine.length} established connections to ${remotes.length} hosts\n\n${lines.join('\n')}`, null);
        const first = remotes[0];
        this.speak(`${mine[0].process} has ${mine.length} established connections to ${remotes.length} hosts, Sir. ` +
            `The top one is ${names[first.address] || first.address}${first.service ? ` over ${first.service}` : ''}. Details on screen.`);
    }

    async handleNetListening() {
        this.displayText('Reading listening sockets...', null);
        const rows = await this._netRows();
        if (!rows) return;
        const s = netInspect.summarize(rows);
        if (!s.exposedPorts.length) {
            this.speak('Nothing is listening on an address reachable from outside this machine, Sir.');
            return;
        }
        const lines = s.exposedPorts.map(p => `${p.port}  ${p.service || ''}  <- ${p.process}`);
        this.displayText(`${s.exposedPorts.length} ports reachable from your network (of ${s.listening} listening sockets):\n${lines.join('\n')}`, null);
        const named = s.exposedPorts.filter(p => p.service).slice(0, 4)
            .map(p => `${p.port} for ${p.service}`).join(', ');
        this.speak(`${s.exposedPorts.length} ports are reachable from your network, Sir${named ? `, including ${named}` : ''}. The full list is on screen. Loopback-only sockets are excluded because nothing outside this machine can reach them.`);
    }

    async handleNetTraffic() {
        if (!window.electronAPI?.networkTraffic) { this.speak('Adapter statistics are not available here.'); return; }
        this.displayText('Reading adapter counters...', null);
        const r = await window.electronAPI.networkTraffic();
        if (!r?.success || !r.adapters?.length) { this.speak('I could not read the adapter statistics, Sir.'); return; }
        const lines = r.adapters.map(a =>
            `${a.Name}: received ${netInspect.formatBytes(a.ReceivedBytes)}, sent ${netInspect.formatBytes(a.SentBytes)}`);
        this.displayText(lines.join('\n') + '\n\n(Counters are since the adapter last reset, typically at boot.)', null);
        const a = r.adapters[0];
        this.speak(`On ${a.Name}, ${netInspect.formatBytes(a.ReceivedBytes)} received and ${netInspect.formatBytes(a.SentBytes)} sent since the adapter last reset, Sir.`);
    }

    /* Truthful answer to "you should see every packet". States what is actually
       available on this machine instead of implying capture that is not
       happening — the same rule that keeps the chain and finance layers from
       inventing figures. */
    async handleNetCaptureInfo() {
        const cap = window.electronAPI?.networkCaptureCapability
            ? await window.electronAPI.networkCaptureCapability() : null;
        const rows = await this._netRows();
        const s = rows ? netInspect.summarize(rows) : null;

        const have = s ? `I can see every open socket: ${s.established} established connections, their remote IP addresses and ports, and which process owns each one. ` : '';
        let lack = 'I cannot read packet contents or per-packet timing. That needs a capture driver, which needs Administrator rights I do not have.';
        if (cap?.success) {
            if (cap.admin && cap.pktmon) lack = 'Packet capture is available: pktmon is present and this session is elevated. Say the word and I will explain the capture command, though I will not start one without you asking.';
            else if (cap.pktmon) lack = 'Windows pktmon is installed but this session is not elevated, so packet capture would fail. Connection-level detail is what I can give you right now.';
            if (cap.npcap) lack += ' Wireshark or Npcap is installed on this machine, so a full capture is possible there, outside my reach.';
        }
        const line = `${have}${lack}`;
        this.displayText(line, null);
        this.speak(line);
    }

    /* =========================
       SYSTEM PROCESS VISIBILITY — read-only.
       Answers "what is running", "what is eating my CPU", "is X running",
       "what's happening on my machine". Every figure is measured by the
       collector and shaped by the pure sysInspect engine; the model is not in
       this path, so no number here can be invented. */

    /** Text -> system intent, or null. */
    parseSystemQuery(cmd) {
        const t = String(cmd || '').toLowerCase();
        if (!t) return null;

        // "is X running" / "is X open"
        let m = t.match(/\bis\s+([a-z0-9 ._-]{2,30}?)\s+(?:still\s+)?(?:running|open|active|up)\b/);
        if (m) return { intent: 'SYS_PROCESS', name: m[1].trim() };
        m = t.match(/\b(?:how much|what)\s+(?:cpu|memory|ram)\s+(?:is\s+)?([a-z0-9 ._-]{2,30}?)\s+(?:using|taking|eating)\b/);
        if (m) return { intent: 'SYS_PROCESS', name: m[1].trim() };

        const resource = /\b(cpu|memory|ram|processor)\b/.test(t);
        const whatUses = /\b(what|which|who)\b.*\b(using|eating|hogging|consuming|taking|slowing)\b/.test(t);
        if (resource && whatUses) {
            return { intent: 'SYS_TOP', resource: /\b(memory|ram)\b/.test(t) ? 'memory' : 'cpu' };
        }
        // "why is my computer slow"
        if (/\bwhy\b.*\b(slow|lagging|freezing|sluggish|hot|fan)\b/.test(t) &&
            /\b(pc|computer|laptop|machine|system|it)\b/.test(t)) {
            return { intent: 'SYS_TOP', resource: 'cpu' };
        }
        // HISTORY questions go to the metric store, not to the live reading.
        // "what was my CPU an hour ago" was previously unanswerable: telemetry
        // was displayed and discarded.
        const past = /\b(was|were|has been|earlier|yesterday|last night|this morning|an hour ago|history|over the last|過)\b/.test(t);
        if (past && /\b(cpu|memory|ram|processor|usage|load|performance)\b/.test(t)) {
            let hours = 24;
            const hm = t.match(/\b(?:last|past)\s+(\d{1,3})\s*(hour|hr|minute|min|day)/);
            if (hm) {
                const n = parseInt(hm[1], 10);
                hours = /day/.test(hm[2]) ? n * 24 : /min/.test(hm[2]) ? Math.max(1, Math.ceil(n / 60)) : n;
            } else if (/\ban hour ago\b/.test(t)) hours = 2;
            else if (/\byesterday\b/.test(t)) hours = 48;
            return { intent: 'SYS_HISTORY', hours: Math.min(hours, 24 * 30) };
        }
        // "what happened today" -> the derived event log.
        if (/\b(what happened|any (alerts?|events?|problems?|issues?)|event log|anything (unusual|wrong))\b/.test(t)) {
            return { intent: 'SYS_EVENTS', hours: /\byesterday\b/.test(t) ? 48 : 24 };
        }

        // Process listings and general "what's happening"
        if (/\b(running (processes|apps|programs)|process list|list (all )?processes|task manager|what(?:'s| is) running|what apps are open|open (apps|programs|windows))\b/.test(t)) {
            return { intent: 'SYS_PROCESSES' };
        }
        if (/\b(what(?:'s| is) (happening|going on)|system (activity|status|overview|report)|how('s| is) my (pc|computer|laptop|machine|system))\b/.test(t)) {
            return { intent: 'SYS_OVERVIEW' };
        }
        return null;
    }

    /** Collect + analyse. Returns {summary, cores} or null (already spoken). */
    async _sysSummary() {
        if (!window.electronAPI?.systemProcesses) {
            this.speak('Process inspection is not available in this environment.');
            return null;
        }
        const r = await window.electronAPI.systemProcesses();
        if (!r?.success) {
            this.speak(`I could not read the process list. ${r?.error || ''}`.trim());
            return null;
        }
        return { summary: sysInspect.summarize(r.procs, { cores: r.cores }), cores: r.cores };
    }

    async handleSysTop(resource) {
        this.displayText(`Measuring ${resource === 'memory' ? 'memory' : 'CPU'} usage...`, null);
        const s = await this._sysSummary();
        if (!s) return;
        const { summary } = s;
        const list = resource === 'memory' ? summary.topMemory : summary.topCpu;
        const fmt = (g) => resource === 'memory'
            ? `${g.friendly}  ${sysInspect.formatMB(g.memMB)}  (${g.count} process${g.count === 1 ? '' : 'es'})`
            : `${g.friendly}  ${g.cpuPct}%  (${g.count} process${g.count === 1 ? '' : 'es'})`;
        this.displayText(
            `Top by ${resource}:\n${list.slice(0, 8).map(fmt).join('\n')}\n\n` +
            `${summary.processCount} processes in ${summary.groupCount} groups. ` +
            `Total measured CPU ${summary.totalCpuPct}% across ${summary.cores} cores, ` +
            `${sysInspect.formatMB(summary.totalMemMB)} resident.`, null);

        const top = list.slice(0, 3);
        const spoken = top.map(g => resource === 'memory'
            ? `${g.friendly} at ${sysInspect.formatMB(g.memMB)}`
            : `${g.friendly} at ${g.cpuPct} percent`).join(', ');
        this.speak(`The biggest consumers of ${resource === 'memory' ? 'memory' : 'CPU'} right now, Sir: ${spoken}. Full list on screen.`);
    }

    async handleSysProcesses() {
        this.displayText('Reading the process table...', null);
        const s = await this._sysSummary();
        if (!s) return;
        const { summary } = s;
        const apps = summary.userApps;
        const lines = apps.map(g =>
            `${g.friendly}  ${sysInspect.formatMB(g.memMB)}  ${g.cpuPct}%  ${g.windows[0] ? `- ${g.windows[0].slice(0, 60)}` : ''}`);
        this.displayText(
            `Applications with open windows:\n${lines.join('\n')}\n\n` +
            `${summary.processCount} processes total (${summary.groupCount} distinct programs), ` +
            `including Windows' own background services.`, null);
        this.speak(`${apps.length} applications have open windows, Sir, out of ${summary.processCount} processes in total. ` +
            (apps[0] ? `The largest is ${apps[0].friendly} at ${sysInspect.formatMB(apps[0].memMB)}. ` : '') +
            'The list is on screen.');
    }

    async handleSysProcess(name) {
        this.displayText(`Looking for ${name}...`, null);
        const s = await this._sysSummary();
        if (!s) return;
        const g = sysInspect.findProcess(s.summary.groups, name);
        if (!g) {
            this.speak(`${name} is not running, Sir.`);
            this.displayText(`No process matching "${name}" is running.`, null);
            return;
        }
        const line = `${g.friendly} is running: ${g.count} process${g.count === 1 ? '' : 'es'}, ` +
            `${g.cpuPct}% CPU, ${sysInspect.formatMB(g.memMB)} memory` +
            (g.windows.length ? `, window "${g.windows[0].slice(0, 70)}"` : ', no visible window') + '.';
        this.displayText(line + `\n\nCumulative processor time since start: ${g.cpuSeconds} seconds (this is total work done, not current usage).`, null);
        this.speak(line);
    }

    /* Historical metrics. Answered from the persisted time-series, never from
       the model — and when there is not enough history yet, it says so rather
       than describing a past it cannot see. */
    async handleSysHistory(hours) {
        if (!window.electronAPI?.getMetricHistory) { this.speak('Metric history is not available here.'); return; }
        this.displayText(`Reading the last ${hours} hours of measurements...`, null);
        const r = await window.electronAPI.getMetricHistory({ hours });
        if (!r?.success) { this.speak('I could not read the metric history, Sir.'); return; }

        const s = r.samples || [];
        if (s.length < 2) {
            const line = `I have only ${s.length} recorded sample${s.length === 1 ? '' : 's'} in that window, Sir. ` +
                `I began keeping metric history this session, so there is not enough yet to describe a trend. ` +
                `It records one reading a minute from now on.`;
            this.displayText(line, null); this.speak(line);
            return;
        }
        const cpu = this._statsOf(s, 'c');
        const mem = this._statsOf(s, 'm');
        /* Span in whichever unit is not absurd. Rounding straight to hours made
           a short window read "Over the last 0 hours, Sir" (logged 14:33:49),
           which sounds like a bug and hides that the window really was minutes. */
        const spanMs = s[s.length - 1].t - s[0].t;
        const spanH = Math.round((spanMs / 3600000) * 10) / 10;
        const spanPhrase = spanMs < 3600000
            ? `${Math.max(1, Math.round(spanMs / 60000))} minutes`
            : `${spanH} hours`;
        // Which process held the top slot most often.
        const tally = new Map();
        for (const x of s) if (x.p) tally.set(x.p, (tally.get(x.p) || 0) + 1);
        const top = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];

        const rollLines = (r.rollups || []).slice(-7).map(d =>
            `${d.day}  CPU avg ${d.cpu?.avg ?? '?'}% peak ${d.cpu?.peak ?? '?'}%  mem avg ${d.mem?.avg ?? '?'}%  ${d.topProcess ? `busiest ${d.topProcess.name}` : ''}`);
        this.displayText(
            `Last ${spanH}h from ${s.length} samples:\n` +
            `CPU  avg ${cpu.avg}%  peak ${cpu.peak}%  p95 ${cpu.p95}%\n` +
            `Mem  avg ${mem.avg}%  peak ${mem.peak}%\n` +
            (top ? `Busiest process: ${top[0]} (top in ${Math.round((top[1] / s.length) * 100)}% of readings)\n` : '') +
            (rollLines.length ? `\nDaily history:\n${rollLines.join('\n')}` : ''), null);
        this.speak(
            `Over the last ${spanPhrase}, Sir, CPU averaged ${cpu.avg} percent and peaked at ${cpu.peak}. ` +
            `Memory averaged ${mem.avg} percent. ` +
            (top ? `${top[0]} was the busiest process most of the time.` : ''));
    }

    /** avg/peak/p95 over a stored field. Nulls skipped, never counted as zero. */
    _statsOf(samples, field) {
        const v = samples.map(x => x[field]).filter(x => typeof x === 'number').sort((a, b) => a - b);
        if (!v.length) return { avg: 0, peak: 0, p95: 0 };
        const sum = v.reduce((a, b) => a + b, 0);
        return {
            avg: Math.round((sum / v.length) * 10) / 10,
            peak: v[v.length - 1],
            p95: v[Math.min(v.length - 1, Math.max(0, Math.ceil(0.95 * v.length) - 1))],
        };
    }

    /* The derived event log — threshold crossings and watched program
       start/stop, already deduped and debounced in the store. */
    async handleSysEvents(hours) {
        if (!window.electronAPI?.getSystemEvents) { this.speak('The event log is not available here.'); return; }
        this.displayText('Reading the event log...', null);
        const r = await window.electronAPI.getSystemEvents({ hours });
        if (!r?.success) { this.speak('I could not read the event log, Sir.'); return; }
        const evs = r.events || [];
        if (!evs.length) {
            this.speak(`Nothing notable was recorded in the last ${hours} hours, Sir. No threshold crossings and no watched programs starting or stopping.`);
            return;
        }
        const fmt = (e) => {
            const d = new Date(e.t);
            const hh = String(d.getHours()).padStart(2, '0'), mm = String(d.getMinutes()).padStart(2, '0');
            return `${hh}:${mm}  ${e.text}`;
        };
        const recent = evs.slice(-25);
        this.displayText(`${evs.length} events in the last ${hours}h:\n${recent.map(fmt).join('\n')}`, null);
        const thresholds = evs.filter(e => String(e.kind).endsWith('-high'));
        this.speak(`${evs.length} events in the last ${hours} hours, Sir. ` +
            (thresholds.length
                ? `${thresholds.length} were resource thresholds being crossed. The most recent: ${thresholds[thresholds.length - 1].text}`
                : `The most recent: ${evs[evs.length - 1].text}`));
    }

    async handleSysOverview() {
        this.displayText('Taking a system reading...', null);
        const s = await this._sysSummary();
        if (!s) return;
        const { summary } = s;
        const obs = sysInspect.observations(summary);
        const apps = summary.userApps.slice(0, 5).map(g => g.friendly).join(', ');
        this.displayText(
            `${summary.processCount} processes, ${summary.groupCount} distinct programs.\n` +
            `CPU ${summary.totalCpuPct}% of ${summary.cores} cores. Memory resident ${sysInspect.formatMB(summary.totalMemMB)}.\n` +
            `Foreground apps: ${apps}\n\n${obs.map(o => '- ' + o).join('\n')}`, null);
        this.speak(
            `${summary.processCount} processes running, Sir, using ${summary.totalCpuPct} percent of your ${summary.cores} cores ` +
            `and ${sysInspect.formatMB(summary.totalMemMB)} of memory. ` +
            (obs[0] || 'Nothing stands out as unusual.'));
    }

    /* =========================
       KEYBOARD + WINDOW CONTROL
       Typing lands in whatever window has focus, and the assistant cannot see
       the screen — so every confirmation NAMES the window that received the
       keystrokes. Parsing is rule-based (inputControl.js), never model-driven:
       a mis-parse here types into the wrong place. */

    async handleTypeText(intent) {
        const api = window.electronAPI;
        if (!api?.typeText) { this.speak('Keyboard control is not available in this environment.'); return; }

        const where = await api.focusedWindow();
        if (!where?.success || !where.title) {
            this.speak('I cannot tell which window has focus, Sir, so I will not type blindly. Click the field you want and ask again.');
            return;
        }
        const proc = String(where.process || '').toLowerCase();

        /* "search for X" used to mean a WEB search answered by the model, and
           that must keep working. It only becomes typing when a browser is
           actually in front — which is the case the user described (Chrome on
           google.com, wanting the words in the search box). */
        const BROWSERS = ['chrome', 'msedge', 'firefox', 'brave', 'opera', 'vivaldi'];
        if (intent.isSearch && !BROWSERS.includes(proc)) {
            await this.handleAICommand(`search ${intent.text}`);
            return;
        }

        // Refuse to type into ourselves — the orb has no text field, and it
        // would mean the user has not focused their target yet.
        if (proc === 'electron') {
            this.speak(`Focus is on my own window, Sir. Click the field you want the text in, then ask again.`);
            return;
        }

        let encoded = inputControl.escapeSendKeys(intent.text);
        if (intent.thenEnter) encoded += '{ENTER}';
        this.displayText(`Typing into ${where.title}...`, null);
        const r = await api.typeText({ encoded });
        if (!r?.success) { this.speak(`I could not send the keystrokes. ${r?.error || ''}`.trim()); return; }

        const target = r.target?.title || where.title;
        this.displayText(`Typed into ${target}:\n${intent.text}${intent.thenEnter ? '\n(then Enter)' : ''}`, null);
        this.speak(intent.isSearch
            ? `Searched for ${intent.text} in ${target}, Sir.`
            : `Typed into ${target}, Sir.`);
    }

    /* ---- VOICE TYPING (dictation mode) -----------------------------------
       While active, every transcript is typed into the window that had focus
       when dictation STARTED — captured once, so that a stray click mid-
       sentence cannot redirect the user's words somewhere unexpected. The
       target is re-asserted before each burst and verified afterwards. */
    async handleDictateStart() {
        const api = window.electronAPI;
        if (!api?.typeText) { this.speak('Keyboard control is not available in this environment.'); return; }

        const where = await api.focusedWindow();
        if (!where?.success || !where.title) {
            this.speak('I cannot tell which window has focus, Sir. Click the text field you want to dictate into, then say start typing.');
            return;
        }
        if (String(where.process || '').toLowerCase() === 'electron') {
            this.speak('My own window has focus, Sir. Click the document or search box you want to dictate into, then say start typing.');
            return;
        }
        this._dictation = { target: { pid: where.pid, title: where.title, process: where.process }, count: 0 };
        this._showTranscript(`DICTATING into ${where.title}`, 'acted', 'VOICE TYPING', 60000);
        this.displayText(
            `Voice typing into: ${where.title}\n\n` +
            `Everything you say is typed there. Say "new line", "delete that", "undo", "select all" or "save it" for editing.\n` +
            `Say "stop typing" when you are done.`, null);
        this.speak(`Voice typing into ${where.title}, Sir. Say stop typing when you are done.`);
    }

    /** Handle one transcript while dictation is active. Returns true if consumed. */
    async handleDictationTranscript(text) {
        const d = this._dictation;
        if (!d) return false;
        const parsed = inputControl.parseDictationInput(text);

        if (parsed.kind === 'stop') {
            const n = d.count;
            this._dictation = null;
            this._showTranscript('voice typing ended', 'ambient', 'STOPPED', 3000);
            this.displayText(`Voice typing stopped after ${n} entr${n === 1 ? 'y' : 'ies'}.`, null);
            this.speak(`Voice typing stopped, Sir.`);
            return true;
        }

        const api = window.electronAPI;
        const encoded = parsed.kind === 'key'
            ? parsed.chord
            : inputControl.escapeSendKeys(parsed.text ? parsed.text + ' ' : '');
        if (!encoded) return true;

        // Re-target the window dictation began in, so a stray focus change does
        // not scatter the user's words into another application.
        const r = await api.typeText({ encoded, targetPid: d.target.pid });
        if (!r?.success) {
            this._dictation = null;
            this.speak(`I lost the typing target, Sir, so I stopped voice typing. ${r?.error || ''}`.trim());
            return true;
        }
        d.count++;
        // Show what was typed and where — the user cannot otherwise verify it.
        const landed = r.target?.title || d.target.title;
        this._showTranscript(
            parsed.kind === 'key' ? `[${parsed.label}] -> ${landed}` : `${parsed.text} -> ${landed}`,
            'acted', 'TYPED', 6000);
        return true;
    }

    async handlePressKey(intent) {
        const api = window.electronAPI;
        if (!api?.typeText) { this.speak('Keyboard control is not available here.'); return; }
        const where = await api.focusedWindow();
        if (String(where?.process || '').toLowerCase() === 'electron') {
            this.speak('Focus is on my own window, Sir. Click where you want the keypress to go.');
            return;
        }
        const r = await api.typeText({ encoded: intent.chord });
        if (!r?.success) { this.speak(`I could not send that key. ${r?.error || ''}`.trim()); return; }
        const target = r.target?.title || where?.title || 'the active window';
        this.displayText(`Sent ${intent.spoken} to ${target}`, null);
        this.speak(`${intent.spoken} sent to ${target}, Sir.`);
    }

    async handleFocusWindow(name) {
        const api = window.electronAPI;
        if (!api?.listWindows) { this.speak('Window control is not available here.'); return; }
        const list = await api.listWindows();
        if (!list?.success) { this.speak('I could not enumerate the open windows, Sir.'); return; }
        const hit = inputControl.matchWindow(list.windows, name);
        if (!hit) {
            const open = list.windows.slice(0, 8).map(w => w.desc || w.process).join(', ');
            this.speak(`I see no open window matching ${name}, Sir. Currently open: ${open}.`);
            return;
        }
        const r = await api.focusWindow({ pid: hit.pid });
        if (!r?.success) { this.speak(`I could not bring ${hit.desc || hit.process} to the front, Sir.`); return; }
        this.displayText(`Focused: ${r.focused?.title || hit.title}`, null);
        this.speak(`${hit.desc || hit.process} is in front, Sir.`);
    }

    async handleCloseApp(name) {
        const api = window.electronAPI;
        if (!api?.listWindows) { this.speak('Window control is not available here.'); return; }
        const list = await api.listWindows();
        if (!list?.success) { this.speak('I could not enumerate the open windows, Sir.'); return; }
        const hit = inputControl.matchWindow(list.windows, name);
        if (!hit) { this.speak(`${name} does not appear to have an open window, Sir.`); return; }
        if (String(hit.process).toLowerCase() === 'electron') {
            this.speak('I will not close my own window, Sir.');
            return;
        }
        const r = await api.closeWindow({ pid: hit.pid });
        if (!r?.success) { this.speak(`I could not close ${name}, Sir. ${r?.error || ''}`.trim()); return; }
        // exited=false is the honest case: the app is probably asking to save.
        this.speak(r.exited
            ? `${hit.desc || hit.process} is closed, Sir.`
            : `I asked ${hit.desc || hit.process} to close, Sir, but it is still running. It may be asking you to save.`);
    }

    async handleFocusedWindow() {
        const r = await window.electronAPI?.focusedWindow?.();
        if (!r?.success || !r.title) { this.speak('I cannot read the focused window, Sir.'); return; }
        const line = `Focus is on ${r.title}${r.process ? ` (${r.process})` : ''}.`;
        this.displayText(line, null);
        this.speak(line);
    }

    /* ---- one-shot spoken confirmation for state-changing actions ----------
       Armed by a handler, consumed by the NEXT turn only. Kept deliberately
       narrow: a stale "yes" thirty seconds later must not flip a radio. */
    _armConfirmation(action, description) {
        this._pendingConfirm = { action, description, at: Date.now() };
    }

    /** Returns true if this turn was consumed as an answer to a pending ask. */
    async _consumeConfirmation(cmd) {
        const p = this._pendingConfirm;
        if (!p) return false;
        this._pendingConfirm = null;            // one shot, whatever the answer
        if (Date.now() - p.at > 60000) return false;

        const t = String(cmd || '').toLowerCase().trim();
        const yes = /^(yes|yeah|yep|yup|sure|ok|okay|do it|go ahead|please do|affirmative|switch it on|turn it on|proceed|confirm)\b/.test(t);
        const no = /^(no|nope|don'?t|cancel|stop|never ?mind|negative|leave it)\b/.test(t);
        if (!yes && !no) return false;          // unrelated: let normal routing run
        if (no) { this.speak('Understood, Sir. I will leave it as it is.'); return true; }

        if (p.action === 'bluetooth-on') {
            this.displayText('Switching Bluetooth on...', null);
            const r = await window.electronAPI.radioSet({ kind: 'bluetooth', state: 'on' });
            if (r?.success && r.applied) {
                this.speak('Bluetooth is on, Sir. Shall I list the paired devices?');
                this._armConfirmation('bluetooth-list', 'list paired Bluetooth devices');
            } else {
                // Never claim success the radio did not report.
                this.speak(`I could not switch Bluetooth on, Sir. ${r?.error || `the radio still reads ${r?.state || 'unknown'}`}.`);
            }
            return true;
        }
        if (p.action === 'bluetooth-list') { await this.handleBluetoothDevices(); return true; }
        if (p.action === 'dictate-start') { await this.handleDictateStart(); return true; }
        return false;
    }

    /* Record a deterministic answer so short follow-ups can be answered FROM IT
       instead of from the model's imagination.

       The log: BT_DEVICES correctly reported one paired device, then "them."
       and "tell me." fell through to Gemma, which produced "Headphones_XYZ"
       and "Smartwatch_ABC" — placeholder names it pattern-completed — and then
       defended them when challenged. */
    _rememberFactualAnswer(intent, text) {
        this._lastFactual = { intent, text: String(text || '').slice(0, 1200), at: Date.now() };
    }

    /** True for "them.", "tell me.", "and?", "go on" — a follow-up carrying no
     *  new content, which must not be treated as a fresh question. */
    _isBareFollowUp(cmd) {
        const t = String(cmd || '').toLowerCase().replace(/[?.!,]+$/, '').trim();
        if (!t || t.split(/\s+/).length > 4) return false;
        return /^(them|those|it|that|this|tell me|tell me more|show me|show them|list them|go on|continue|and|and\?|more|what about them|which ones|the names|names)$/.test(t);
    }

    /* Resolve a name to an address for real. The log contains the failure this
       replaces: asked for the IP of "pro haven", the model answered
       "192.168.1.10" — invented. Unresolvable now means unresolvable. */
    async handleResolveHost(target) {
        if (!window.electronAPI?.resolveHost) { this.speak('Name resolution is not available here.'); return; }
        // Speech gives "pro haven"; hostnames have no spaces. Try the spoken
        // form joined and hyphenated, plus .local for mDNS names.
        const base = String(target).trim();
        const variants = [...new Set([
            base, base.replace(/\s+/g, ''), base.replace(/\s+/g, '-'),
            `${base.replace(/\s+/g, '-')}.local`, `${base.replace(/\s+/g, '')}.local`,
        ])].filter(v => /^[a-zA-Z0-9._-]+$/.test(v));

        this.displayText(`Resolving ${base}...`, null);
        for (const v of variants) {
            const r = await window.electronAPI.resolveHost({ host: v });
            if (r?.success && r.found && r.addresses?.length) {
                const list = r.addresses.map(a => a.address);
                const line = `${v} resolves to ${list.join(', ')}.`;
                this.displayText(line, null);
                this.speak(`${base} resolves to ${list[0]}${list.length > 1 ? `, and ${list.length - 1} more` : ''}, Sir.`);
                return;
            }
        }
        // Explicitly refuse to produce a number here.
        const line = `${base} does not resolve to any address from this machine. I tried ${variants.length} name forms including mDNS. If it is a Wi-Fi network rather than a host, it has no IP address for me until I am connected to it — I will not invent one.`;
        this.displayText(line, null);
        this.speak(`${base} does not resolve to any address, Sir. If it is a Wi-Fi network rather than a device, it has no IP for me unless I am connected to it. I will not guess a number.`);
    }

    /* Radio facts for a network in range we are NOT joined to. */
    async handleWifiNetworkDetail(ssid) {
        if (!window.electronAPI?.wifiNetworksDetail) { this.speak('Wi-Fi scanning is not available here.'); return; }
        this.displayText(`Scanning for ${ssid}...`, null);
        const r = await window.electronAPI.wifiNetworksDetail();
        if (!r?.success) { this.speak('I could not scan the Wi-Fi radios, Sir.'); return; }
        const nets = netDiscovery.parseWifiNetworks(r.raw);
        const hit = netDiscovery.matchNetwork(nets, ssid);
        if (!hit) {
            const names = nets.map(n => n.ssid).join(', ');
            this.displayText(`No network matching "${ssid}" is in range.\nVisible now: ${names || 'none'}`, null);
            this.speak(`I cannot see a network called ${ssid} from here, Sir. ${nets.length ? `What is visible: ${names}.` : 'No networks are visible at all.'}`);
            return;
        }
        const ap = hit.bssids[0] || {};
        const lines = hit.bssids.map(b =>
            `${b.bssid}  ${b.signal != null ? b.signal + '%' : '?'}  ${b.band || ''} ch ${b.channel ?? '?'}  ${b.radio || ''}${b.stations != null ? `  ${b.stations} stations` : ''}`);
        this.displayText(`${hit.ssid}\nSecurity: ${hit.auth || 'unknown'} (${hit.encryption || 'unknown'})\nAccess points:\n${lines.join('\n')}\n\nNot connected to this network, so it has no IP address from here.`, null);
        this.speak(`${hit.ssid} is in range, Sir. Signal ${ap.signal ?? 'unknown'} percent, ${ap.band || 'unknown band'}, channel ${ap.channel ?? 'unknown'}, security ${hit.auth || 'unknown'}${hit.bssids.length > 1 ? `, across ${hit.bssids.length} access points` : ''}. I am not connected to it, so it has no IP address from here.`);
    }

    /* Devices this machine has actually exchanged traffic with on the LAN. */
    async handleLanDevices() {
        if (!window.electronAPI?.lanNeighbours) { this.speak('LAN inspection is not available here.'); return; }
        this.displayText('Reading the neighbour table...', null);
        const r = await window.electronAPI.lanNeighbours();
        if (!r?.success) { this.speak('I could not read the neighbour table, Sir.'); return; }
        const all = netDiscovery.parseArpTable(r.raw);
        // Virtual adapters (VirtualBox/Hyper-V) are not devices on his network.
        const real = all.filter(d => !/^192\.168\.56\./.test(d.ip));
        if (!real.length) { this.speak('No other devices are in the neighbour table right now, Sir.'); return; }

        const named = await Promise.all(real.slice(0, 20).map(async (d) => {
            const rr = window.electronAPI.networkResolve
                ? await window.electronAPI.networkResolve({ addresses: [d.ip] }) : null;
            // No vendor guess: the IEEE OUI registry is not on this machine,
            // so only what the address itself proves is reported.
            const f = netDiscovery.macFacts(d.mac);
            return { ...d, host: rr?.names?.[d.ip] || null, randomised: !!f?.locallyAdministered };
        }));
        const lines = named.map(d =>
            `${d.ip}  ${d.mac}${d.randomised ? '  (randomised MAC)' : ''}${d.host ? `  ${d.host}` : ''}`);
        this.displayText(`${real.length} devices in the neighbour table:\n${lines.join('\n')}\n\n(From the ARP cache — devices this machine has exchanged traffic with, not an active sweep of the network.)`, null);
        this.speak(`${real.length} devices are in my neighbour table, Sir${named[0] ? `, including ${named[0].ip}` : ''}. The list is on screen. This is from the address cache, not an active scan of your network.`);
    }

    /* Bluetooth devices Windows knows about.
       The radio's POWER STATE is checked first. The log shows this listing
       paired devices while Bluetooth was switched off, with no mention of it —
       the PnP tree reports the adapter as "OK" even when the radio is off, so
       only the WinRT radio state can tell the truth here. */
    async handleBluetoothDevices() {
        if (!window.electronAPI?.bluetoothDevices) { this.speak('Bluetooth enumeration is not available here.'); return; }
        this.displayText('Checking the Bluetooth radio...', null);

        if (window.electronAPI.radioState) {
            const rs = await window.electronAPI.radioState();
            const bt = rs?.success ? rs.radios.find(x => String(x.kind).toLowerCase() === 'bluetooth') : null;
            if (bt && String(bt.state).toLowerCase() !== 'on') {
                const canSet = rs.access === 'Allowed' && !!window.electronAPI.radioSet;
                const line = `Bluetooth is turned ${String(bt.state).toLowerCase()}, Sir.` +
                    (canSet ? ' Shall I switch it on?' : ' I cannot switch it on from here — Windows denied radio access. Say "open bluetooth settings" and I will take you there.');
                this.displayText(line, null);
                this.speak(line);
                // Arm a one-shot confirmation. Nothing is switched until he answers.
                if (canSet) this._armConfirmation('bluetooth-on', 'switch Bluetooth on');
                return;
            }
            if (!bt && !rs?.success) {
                // Unknown state is reported as unknown rather than assumed on.
                this.displayText(`I could not read the Bluetooth radio state (${rs?.error || 'unknown error'}); listing what Windows has paired.`, null);
            }
        }

        this.displayText('Reading Bluetooth devices...', null);
        const r = await window.electronAPI.bluetoothDevices();
        if (!r?.success) { this.speak('I could not enumerate Bluetooth devices, Sir.'); return; }
        const devs = netDiscovery.parseBluetoothDevices(r.devices);
        const paired = devs.filter(d => d.kind === 'device');
        if (!paired.length) {
            this.speak('Windows knows no paired Bluetooth devices on this machine, Sir.');
            return;
        }
        const lines = paired.map(d => `${d.connected ? '[connected]' : '[not connected]'}  ${d.name}`);
        const adapter = devs.find(d => d.kind === 'adapter');
        this.displayText(
            `${paired.length} paired Bluetooth devices:\n${lines.join('\n')}` +
            (adapter ? `\n\nAdapter: ${adapter.name}` : '') +
            '\n\nThese are devices already paired with Windows. Discovering nearby UNPAIRED devices needs the Windows Runtime radio API, which I cannot reach from here.', null);
        const conn = paired.filter(d => d.connected);
        this.speak(
            `${paired.length} paired Bluetooth devices, Sir` +
            (conn.length ? `, and ${conn.length === 1 ? `${conn[0].name} is connected` : `${conn.length} are connected`}` : ', none currently connected') +
            '. These are already-paired devices; I cannot sweep for new unpaired ones from here.');
    }

    /* =========================
       ONDO GM TOKENS — tokenized securities, read-only
       Supply and decimals via eth_call on BOTH chains; 24h mint/redeem flows
       via bounded keyless eth_getLogs (Ethereum only — free BSC endpoints cap
       log ranges at ~2h of blocks, which would be presented as a day's flows,
       so it is refused rather than misstated); holder rankings and issuance
       history via key-gated Dune. The 1:1 backing is ONDO'S CLAIM and is
       always attributed as such — the supply and the price are measured. */

    // "$33.3 million" style — spoken dollar figures for measured supply value.
    _fmtBigUsd(v) {
        if (!(v > 0)) return null;
        if (v >= 1e9) return `$${(v / 1e9).toFixed(1)} billion`;
        if (v >= 1e6) return `$${(v / 1e6).toFixed(1)} million`;
        return `$${onchain.groupThousands(String(Math.round(v)))}`;
    }

    async handleOndoQuery(intent) {
        const api = window.electronAPI;
        if (!api?.onchainCall) { this.speak('On-chain reads are not available in this environment.'); return; }
        try {
            if (intent.kind === 'ondo-catalog') {
                const hot = ONDO_HOT_LIST.map(t => t.k).join(', ');
                this.displayText(`Ondo Global Markets: ${ONDO_COUNT} tokenized securities (ERC-20, Ethereum + BNB Chain)\nExamples: ${hot}\nAsk: supply, mint/redeem flows, or top holders of any of them.`, null);
                this.speak(`I track ${ONDO_COUNT} Ondo tokenized securities on Ethereum and BNB Chain — stocks and ETFs. Ask about the supply, flows, or holders of any of them.`);
                return;
            }
            const tok = intent.ondo;
            if (!tok) { this.speak('I could not tell which tokenized security you meant.'); return; }
            if (intent.kind === 'ondo-holders') { await this.handleOndoHolders(tok); return; }
            if (intent.kind === 'ondo-flows') { await this.handleOndoFlows(tok, intent.days); return; }
            await this.handleOndoSupply(tok, intent.kind === 'ondo-info');
        } catch (e) {
            console.error('Ondo query error:', e);
            this.speak('That tokenized-security read failed.');
        }
    }

    async handleOndoSupply(tok, wantIntro) {
        const api = window.electronAPI;
        this.displayText(`Reading ${tok.s} supply on Ethereum and BNB Chain...`, null);
        const [ethSup, bscSup, decRaw, quote] = await Promise.all([
            api.onchainCall({ chain: 'ethereum', to: tok.e, data: onchain.SELECTORS.totalSupply }),
            tok.b ? api.onchainCall({ chain: 'bsc', to: tok.b, data: onchain.SELECTORS.totalSupply }) : Promise.resolve(null),
            api.onchainCall({ chain: 'ethereum', to: tok.e, data: onchain.SELECTORS.decimals }),
            api.getQuote ? api.getQuote(tok.k).catch(() => null) : Promise.resolve(null),
        ]);
        if (!ethSup?.success && !bscSup?.success) {
            this.speak(`I could not read the ${tok.s} supply on either chain right now.`);
            return;
        }
        const decimals = decRaw?.success ? Number(onchain.hexToBigInt(decRaw.raw)) : 18;
        const ethWei = ethSup?.success ? onchain.hexToBigInt(ethSup.raw) : null;
        const bscWei = bscSup?.success ? onchain.hexToBigInt(bscSup.raw) : null;
        const total = (ethWei ?? 0n) + (bscWei ?? 0n);
        const fmt = (wei) => onchain.groupThousands(onchain.formatUnits(wei, decimals, 2));

        const parts = [];
        if (ethWei !== null) parts.push(`${fmt(ethWei)} on Ethereum`);
        if (bscWei !== null) parts.push(`${fmt(bscWei)} on BNB Chain`);
        // A chain that failed to answer is reported unreadable, never as zero.
        if (ethWei === null) parts.push('Ethereum unreadable right now');
        if (bscWei === null && tok.b) parts.push('BNB Chain unreadable right now');

        let valueLine = '';
        if (quote?.success && quote.price > 0) {
            const usd = this._fmtBigUsd(Number(onchain.formatUnits(total, decimals, 6)) * quote.price);
            if (usd) valueLine = ` At the current ${tok.k} price of ${this._fmtMoney(quote.price, quote.currency)}, that supply represents approximately ${usd} — the one-to-one backing is Ondo's claim; the supply and the price are measured.`;
        }
        const intro = wantIntro ? `${tok.s} is Ondo's tokenized ${tok.n}${tok.t === 'ETF' ? ' ETF' : ''}, an ERC-20 on Ethereum and BNB Chain. ` : '';
        const line = `${intro}${fmt(total)} ${tok.s} exist — ${parts.join(', ')}.${valueLine}`;
        this.displayText(line, null);
        this.speak(line);
    }

    async handleOndoFlows(tok, days) {
        const api = window.electronAPI;
        // A period ("over 30 days", "history") needs an indexer — key-gated Dune.
        if (days) {
            this.displayText(`Querying ${tok.s} issuance history (${days} days) via Dune...`, null);
            const r = await api.duneSupplyHistory({ tokenAddress: tok.e, days });
            if (r?.needsKey) {
                this.speak('Issuance history needs a Dune API key. Say: store key dune underscore api underscore key, followed by the key. A free Dune account works.');
                this.displayText('Needs a Dune API key in the vault:\n  store key dune_api_key <key>\nFree tier at dune.com works.', null);
                return;
            }
            if (!r?.success) { this.speak(`The ${tok.s} issuance-history query failed: ${r?.error || 'unknown error'}.`); return; }
            const rows = r.rows || [];
            if (!rows.length) { this.speak(`Dune shows no ${tok.s} mint or redemption events on Ethereum in the last ${days} days.`); return; }
            const minted = rows.reduce((a, x) => a + (Number(x.minted) || 0), 0);
            const redeemed = rows.reduce((a, x) => a + (Number(x.redeemed) || 0), 0);
            const table = rows.slice(0, 10).map(x => `${String(x.day).slice(0, 10)}  +${(Number(x.minted) || 0).toFixed(2)} / -${(Number(x.redeemed) || 0).toFixed(2)}`).join('\n');
            this.displayText(`${tok.s} issuance, last ${days} days (Ethereum, via Dune${r.cached ? ', cached' : ''}):\nminted ${minted.toFixed(2)}, redeemed ${redeemed.toFixed(2)}\n${table}`, null);
            this.speak(`Over the last ${days} days on Ethereum, ${tok.s} minted ${minted.toFixed(0)} and redeemed ${redeemed.toFixed(0)} tokens — net ${minted - redeemed >= 0 ? 'issuance' : 'redemption'} of ${Math.abs(minted - redeemed).toFixed(0)}.`);
            return;
        }

        // Keyless 24h window via bounded eth_getLogs. Ethereum only: free BSC
        // endpoints cap log ranges at about two hours of blocks — refusing that
        // beats speaking two hours of flows as if they were a day.
        this.displayText(`Scanning ${tok.s} mint and redeem events (~24h, Ethereum)...`, null);
        const ZERO_TOPIC = '0x' + '0'.repeat(64);
        const [mints, redeems, decRaw] = await Promise.all([
            api.onchainLogs({ chain: 'ethereum', address: tok.e, topics: [onchain.TRANSFER_TOPIC, ZERO_TOPIC] }),
            api.onchainLogs({ chain: 'ethereum', address: tok.e, topics: [onchain.TRANSFER_TOPIC, null, ZERO_TOPIC] }),
            api.onchainCall({ chain: 'ethereum', to: tok.e, data: onchain.SELECTORS.decimals }),
        ]);
        if (!mints?.success || !redeems?.success) {
            this.speak(`I could not scan the ${tok.s} transfer logs right now.`);
            return;
        }
        const decimals = decRaw?.success ? Number(onchain.hexToBigInt(decRaw.raw)) : 18;
        const sum = (logs) => logs.reduce((a, l) => { try { return a + BigInt(l.data); } catch { return a; } }, 0n);
        const mintedWei = sum(mints.logs || []);
        const redeemedWei = sum(redeems.logs || []);
        const net = mintedWei - redeemedWei;
        const fmt = (wei) => onchain.groupThousands(onchain.formatUnits(wei < 0n ? -wei : wei, decimals, 2));
        const line = (mints.logs.length + redeems.logs.length) === 0
            ? `No ${tok.s} mint or redemption events on Ethereum in roughly the last 24 hours.`
            : `Over roughly the last 24 hours on Ethereum, ${tok.s} recorded ${mints.logs.length} mints totaling ${fmt(mintedWei)} and ${redeems.logs.length} redemptions totaling ${fmt(redeemedWei)} — net ${net >= 0n ? 'issuance' : 'redemption'} of ${fmt(net)}.`;
        this.displayText(`${line}\n(BNB Chain flows not covered: free log endpoints there serve ~2h windows.)`, null);
        this.speak(line);
    }

    async handleOndoHolders(tok) {
        const api = window.electronAPI;
        this.displayText(`Querying top ${tok.s} holders via Dune...`, null);
        const r = await api.duneTopHolders({ tokenAddress: tok.e });
        if (r?.needsKey) {
            this.speak('Holder rankings need a Dune API key. Say: store key dune underscore api underscore key, followed by the key. A free Dune account works.');
            this.displayText('Needs a Dune API key in the vault:\n  store key dune_api_key <key>\nFree tier at dune.com works.', null);
            return;
        }
        if (!r?.success) { this.speak(`The ${tok.s} holder query failed: ${r?.error || 'unknown error'}.`); return; }
        const rows = (r.rows || []).filter(x => x.address);
        if (!rows.length) { this.speak(`Dune returned no ${tok.s} holders on Ethereum.`); return; }
        const list = rows.map((x, i) => `${i + 1}. ${onchain.shortAddress(String(x.address))} — ${onchain.groupThousands((Number(x.balance) || 0).toFixed(2))} ${tok.s}`).join('\n');
        this.displayText(`Top ${tok.s} holders on Ethereum (via Dune${r.cached ? ', cached' : ''}):\n${list}`, null);
        const top = rows.slice(0, 3).map((x, i) => `number ${i + 1}, ${onchain.shortAddress(String(x.address))} with ${onchain.groupThousands((Number(x.balance) || 0).toFixed(0))}`).join('; ');
        this.speak(`The top ${tok.s} holders on Ethereum: ${top}. Full list on screen.`);
    }

    /* USD-priced whale transfers via Dune (key-gated). The local stream sees
       native-unit values only; dollar framing needs Dune's price joins. */
    async handleWhaleUsd(intent) {
        const api = window.electronAPI;
        if (!api?.duneWhaleTransfers) { this.speak('Dune queries are not available in this environment.'); return; }
        const duneChain = intent.chain === 'bsc' ? 'bnb' : intent.chain;
        this.displayText(`Querying transfers over $1M on ${duneChain} (24h) via Dune...`, null);
        const r = await api.duneWhaleTransfers({ chain: duneChain, minUsd: 1000000, hours: 24 });
        if (r?.needsKey) {
            this.speak('Dollar-priced whale flows need a Dune API key. Say: store key dune underscore api underscore key, followed by the key.');
            this.displayText('Needs a Dune API key in the vault:\n  store key dune_api_key <key>\nFree tier at dune.com works.', null);
            return;
        }
        if (!r?.success) { this.speak(`The whale-transfer query failed: ${r?.error || 'unknown error'}.`); return; }
        const rows = r.rows || [];
        if (!rows.length) { this.speak(`Dune shows no transfers over one million dollars on ${duneChain} in the last 24 hours.`); return; }
        const list = rows.slice(0, 10).map((x, i) =>
            `${i + 1}. ${this._fmtBigUsd(Number(x.amount_usd) || 0) || '$?'} ${x.symbol || '?'}  ${onchain.shortAddress(String(x.sender || ''))} -> ${onchain.shortAddress(String(x.receiver || ''))}`).join('\n');
        this.displayText(`Largest transfers, 24h, ${duneChain} (via Dune${r.cached ? ', cached' : ''}):\n${list}`, null);
        const top = rows[0];
        this.speak(`${rows.length} transfers over one million dollars on ${duneChain} in the last day. The largest: ${this._fmtBigUsd(Number(top.amount_usd) || 0)} of ${top.symbol || 'an unlabeled token'}. Full list on screen.`);
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
        // Keyed path first. The keyless scan below can only ask about tokens it
        // already knows the address of, so it CANNOT see an unlisted holding;
        // Alchemy returns whatever the wallet actually holds, priced. When no
        // key is configured (or the call fails) we fall through rather than
        // fail — a degraded answer beats no answer.
        if (window.electronAPI?.chainPortfolio) {
            const keyed = await window.electronAPI.chainPortfolio({ address }).catch(() => null);
            if (keyed?.success) {
                const holdings = chainIntel.parseTokenHoldings(keyed.payload, keyed.slugMap || {});
                if (holdings.length) {
                    const byChain = new Map();
                    for (const h of holdings) {
                        const chainKey = keyed.slugMap?.[h.network]?.chain || h.network;
                        if (!byChain.has(chainKey)) byChain.set(chainKey, []);
                        byChain.get(chainKey).push(h);
                    }
                    const lines = [`Portfolio for ${short}:`];
                    for (const [chainKey, rows] of byChain) {
                        const name = onchain.CHAINS[chainKey]?.name || chainKey;
                        const bits = rows
                            .sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1))
                            .slice(0, 8)
                            .map(h => `${onchain.groupThousands(h.exact.replace(/\.?0+$/, '') || '0')} ${h.symbol || 'unnamed token'}` +
                                (h.valueUsd != null ? ` (${chainIntel.formatUsd(h.valueUsd)})` : ''));
                        lines.push(`${name}: ${bits.join(', ')}`);
                    }
                    const { totalUsd, priced } = chainIntel.portfolioTotal(holdings);
                    if (priced) lines.push(`Total priced value: ${chainIntel.formatUsd(totalUsd)}`);
                    lines.push(`Source: Alchemy, ${(keyed.networks || []).length} networks.`);
                    const displayStr = lines.join('\n');
                    this.displayText(displayStr, null);
                    const spoken = chainIntel.describePortfolio(holdings);
                    this.speak(spoken);
                    this._portfolioCache.set(address.toLowerCase(), { at: Date.now(), display: displayStr, spoken });
                    return;
                }
                // A keyed read that came back genuinely empty is an answer, but
                // only for the networks the key covers — the keyless scan below
                // reaches chains Alchemy rejected, so it still runs.
            }
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

    /* What chain data Jarvis can actually reach right now. Answers from the
       startup PROBE, not from a list of chains someone hoped were available —
       and names the ones that were rejected, so "why can't you read polygon"
       has a real answer instead of a shrug. */
    async handleChainCapabilities() {
        if (!window.electronAPI?.chainProvidersStatus) {
            this.speak('Provider status is not available in this environment, Sir.');
            return;
        }
        const s = await window.electronAPI.chainProvidersStatus().catch(() => null);
        if (!s?.success) { this.speak('I could not read the provider status, Sir.'); return; }

        const keyed = Object.keys(s.alchemy?.networks || {});
        const rejected = Object.entries(s.alchemy?.unavailable || {});
        const lines = ['Chain data access:'];
        lines.push(`Keyless public RPC: ${Object.keys(onchain.CHAINS).join(', ')}`);
        lines.push(`Alchemy key: ${s.alchemy?.keyed ? (keyed.length ? keyed.join(', ') : 'configured, no networks verified') : 'not configured'}`);
        for (const [chain, why] of rejected) lines.push(`  unavailable — ${chain}: ${why}`);
        lines.push(`Helius (Solana): ${s.helius?.keyed ? 'configured' : 'not configured'}`);
        this.displayText(lines.join('\n'), null);

        let spoken;
        if (!s.alchemy?.keyed && !s.helius?.keyed) {
            spoken = `No provider keys are configured, Sir. I read ${Object.keys(onchain.CHAINS).length} chains over public endpoints, which covers balances, gas and transactions but not full wallet holdings or Solana.`;
        } else {
            spoken = keyed.length
                ? `With the Alchemy key I have verified access to ${keyed.join(', ')}`
                : 'The Alchemy key is configured but no networks verified';
            if (rejected.length) spoken += `. ${rejected.map(([c]) => c).join(' and ')} ${rejected.length === 1 ? 'is' : 'are'} not on the plan`;
            spoken += s.helius?.keyed ? '. Solana is available through Helius.' : '. Solana is not configured.';
        }
        this.speak(spoken);
    }

    /* Solana holdings via Helius DAS. Everything spoken here is provider-
       measured — balances, prices and the asset names come off the payload. */
    async handleSolanaAssets(address) {
        if (!window.electronAPI?.solanaAssets) { this.speak('Solana reads are not available in this environment, Sir.'); return; }
        this.displayText(`Reading Solana wallet ${address.slice(0, 4)}...${address.slice(-4)}`, null);
        const r = await window.electronAPI.solanaAssets({ address }).catch(() => null);
        if (r?.needsKey) { this.speak('I have no Helius key configured, Sir, so I cannot read Solana. Say: store key helius api key, followed by the key.'); return; }
        if (!r?.success) { this.speak(`That Solana read failed, Sir. ${r?.error || ''}`.trim()); return; }

        const parsed = chainIntel.parseSolanaAssets(r.payload, { limit: 20 });
        const lines = [`Solana wallet ${address.slice(0, 6)}...${address.slice(-4)}:`];
        if (parsed.nativeSol) {
            lines.push(`SOL: ${parsed.nativeSol.sol.toFixed(6)}` +
                (parsed.nativeSol.valueUsd != null ? ` (${chainIntel.formatUsd(parsed.nativeSol.valueUsd)})` : ''));
        }
        for (const a of parsed.assets) {
            lines.push(`${a.symbol || a.name || a.id.slice(0, 8)}${a.amount != null ? `: ${a.amount}` : ''} [${a.interface}${a.compressed ? ', compressed' : ''}]`);
        }
        this.displayText(lines.join('\n'), null);
        this.speak(chainIntel.describeSolanaAssets(parsed));
    }

    /* Recent Solana activity. Helius already returns a human sentence per
       transaction; speaking it verbatim is grounded provider output, which is
       exactly the thing the model is forbidden to produce on its own. */
    async handleSolanaActivity(address) {
        if (!window.electronAPI?.solanaActivity) { this.speak('Solana reads are not available in this environment, Sir.'); return; }
        this.displayText(`Reading recent Solana activity...`, null);
        const r = await window.electronAPI.solanaActivity({ address, limit: 10 }).catch(() => null);
        if (r?.needsKey) { this.speak('I have no Helius key configured, Sir, so I cannot read Solana history.'); return; }
        if (!r?.success) { this.speak(`That Solana history read failed, Sir. ${r?.error || ''}`.trim()); return; }

        const items = chainIntel.parseSolanaActivity(r.payload, { limit: 10 });
        const lines = [`Recent Solana activity for ${address.slice(0, 6)}...${address.slice(-4)}:`];
        for (const i of items) {
            lines.push(`${new Date(i.timestamp || 0).toLocaleString()} — ${i.type}${i.description ? `: ${i.description}` : ''}`);
        }
        this.displayText(lines.join('\n'), null);
        this.speak(chainIntel.describeSolanaActivity(items));
    }

    /* PREDICTION MARKETS. Read-only: nothing in this project can take a
       position, and the answers say what each venue is quoting, never what to
       do about it. Every probability comes from the tested parser, because a
       number a user might act on is the last place to accept a model's guess. */
    async handlePredictionSearch(query, source = 'both') {
        if (!window.electronAPI?.predictionSearch) { this.speak('Prediction markets are not available here, Sir.'); return; }
        this.displayText(`Searching prediction markets for "${query}"...`, null);
        const r = await window.electronAPI.predictionSearch({ query, source, limit: 6 }).catch(() => null);
        if (!r?.success) { this.speak(`I could not reach the prediction markets, Sir.`); return; }

        const poly = (r.polymarket || []).map(prediction.parsePolymarketEvent).filter(e => e && !e.closed);
        const kalshi = (r.kalshi || []).map(prediction.parseKalshiEvent).filter(Boolean);
        const all = [...poly, ...kalshi].filter(m => m.probability !== null);

        if (!all.length) {
            const failed = Object.keys(r.errors || {});
            if (failed.length) {
                this.speak(`I could not reach ${failed.join(' or ')}, Sir, so I have nothing on "${query}".`);
                return;
            }
            /* State the search that was actually performed. "I found nothing"
               and "I searched 12,000 series titles and 3 matched but none have
               an open market right now" are different claims, and the second is
               the one that is true. */
            const searched = Number.isFinite(r.kalshiSearched) ? r.kalshiSearched : null;
            const matched = Number.isFinite(r.kalshiSeriesMatched) ? r.kalshiSeriesMatched : null;
            let why = '';
            if (searched && matched) {
                why = ` On Kalshi I matched ${matched} market series out of ${searched.toLocaleString('en-US')}, but none has an open event trading right now.`;
            } else if (searched) {
                why = ` I searched ${searched.toLocaleString('en-US')} Kalshi series titles and nothing matched, so it may exist under different wording.`;
            }
            this.speak(`I found no open market matching "${query}", Sir.${why}`);
            return;
        }

        // Loudest first: a market with volume is a market with an opinion.
        all.sort((a, b) => (b.volume24hr ?? b.volume ?? 0) - (a.volume24hr ?? a.volume ?? 0));
        const lines = all.slice(0, 8).map(m => {
            const where = m.platform === 'kalshi' ? 'Kalshi' : 'Polymarket';
            const prob = prediction.formatProb(m.probability);
            const vol = prediction.formatVolume(m.volume24hr ?? m.volume);
            const closes = prediction.timeUntil(m.closeTime || m.endDate);
            return `${prob ? prob.padStart(4) : '  ? '}  ${m.title || m.question}  [${where}${vol !== '$0' ? `, ${vol}` : ''}${closes && closes !== 'ended' ? `, closes in ${closes}` : ''}]`;
        });
        this.displayText([`Prediction markets — "${query}"`, ...lines].join('\n'), null);
        this.speak(prediction.describeMarket(all[0]) +
            (all.length > 1 ? ` I found ${all.length - 1} other market${all.length - 1 === 1 ? '' : 's'}, on screen now.` : ''));
    }

    async handlePredictionTrending() {
        if (!window.electronAPI?.predictionTrending) { this.speak('Prediction markets are not available here, Sir.'); return; }
        this.displayText('Reading the most active prediction markets...', null);
        const r = await window.electronAPI.predictionTrending({ source: 'both', limit: 6 }).catch(() => null);
        if (!r?.success) { this.speak('I could not reach the prediction markets, Sir.'); return; }

        const poly = (r.polymarket || []).map(prediction.parsePolymarketEvent).filter(Boolean);
        const kalshi = (r.kalshi || []).map(prediction.parseKalshiEvent).filter(Boolean);
        const all = [...poly, ...kalshi].sort((a, b) => (b.volume24hr ?? b.volume ?? 0) - (a.volume24hr ?? a.volume ?? 0));
        if (!all.length) { this.speak('Neither platform returned an active market, Sir.'); return; }

        const lines = all.slice(0, 10).map(m => {
            const where = m.platform === 'kalshi' ? 'Kalshi' : 'Polymarket';
            const prob = prediction.formatProb(m.probability);
            return `${prob ? prob.padStart(4) : '  ? '}  ${m.title}  [${where}, ${prediction.formatVolume(m.volume24hr ?? m.volume)}]`;
        });
        this.displayText(['Most active prediction markets', ...lines].join('\n'), null);
        this.speak(prediction.describeTrending(all, { limit: 3 }));
    }

    /* The same question on both venues. Titles are matched on token overlap and
       anything below the threshold is reported as NOT matched — a forced pairing
       would invent a spread between two different questions. */
    async handlePredictionCompare(text) {
        if (!window.electronAPI?.predictionSearch) { this.speak('Prediction markets are not available here, Sir.'); return; }
        const query = String(text)
            .replace(/\b(compare|versus|vs|between|on both platforms|polymarket|kalshi|odds|prediction markets?)\b/gi, '')
            .replace(/[?.!]+$/, '').replace(/\s+/g, ' ').trim();
        this.displayText(`Comparing venues on "${query}"...`, null);
        const r = await window.electronAPI.predictionSearch({ query, source: 'both', limit: 10 }).catch(() => null);
        if (!r?.success) { this.speak('I could not reach both platforms, Sir.'); return; }

        const poly = (r.polymarket || []).map(prediction.parsePolymarketEvent).filter(e => e && e.probability !== null);
        const kalshi = (r.kalshi || []).map(prediction.parseKalshiEvent).filter(e => e && e.probability !== null);
        const pairs = prediction.matchMarkets(poly, kalshi);

        if (!pairs.length) {
            this.displayText([
                `No matching pair for "${query}".`,
                `Polymarket had ${poly.length} candidate${poly.length === 1 ? '' : 's'}, Kalshi ${kalshi.length}.`,
                'Titles below the match threshold are left unpaired on purpose.',
            ].join('\n'), null);
            this.speak(`I could not confidently match that question across both venues, Sir. ` +
                `Polymarket had ${poly.length} candidate${poly.length === 1 ? '' : 's'} and Kalshi ${kalshi.length}, but none matched closely enough to compare without guessing.`);
            return;
        }
        const best = pairs[0];
        this.displayText([
            `Cross-venue comparison (title match ${Math.round(best.similarity * 100)}%)`,
            `Polymarket: ${prediction.formatProb(best.polymarket.probability)}  ${best.polymarket.title}`,
            `Kalshi:     ${prediction.formatProb(best.kalshi.probability)}  ${best.kalshi.title}`,
        ].join('\n'), null);
        this.speak(prediction.describeComparison(best.polymarket, best.kalshi));
    }

    /* What can honestly be said about an address, in descending order of
       strength. Every field is measured on-chain or comes from the user's own
       watchlist — there is no entity guessing here, which is why an unknown
       address stays an unknown address instead of becoming "Binance".

       Cached for the session: whale blocks repeat the same hot addresses, and
       each lookup is 3 RPC reads. */
    async describeAddress(address) {
        if (!address) return { address: null, name: 'a contract creation', facts: [] };
        const key = address.toLowerCase();
        this._addrFacts = this._addrFacts || new Map();
        if (this._addrFacts.has(key)) return this._addrFacts.get(key);

        const [ensName, code, txc, bal] = await Promise.all([
            this.reverseEns(address).catch(() => null),
            window.electronAPI.onchainCode?.({ chain: 'ethereum', address }).catch(() => null),
            window.electronAPI.onchainTxCount?.({ chain: 'ethereum', address }).catch(() => null),
            window.electronAPI.onchainBalance?.({ chain: 'ethereum', address }).catch(() => null),
        ]);

        const facts = [];
        const isContract = code?.success ? code.isContract : null;
        if (isContract === true) facts.push('a contract');
        else if (isContract === false) facts.push('a wallet');
        // Nonce means "transactions sent" for a wallet but "contracts deployed"
        // for a contract — the live drill printed "a contract with 1 outgoing
        // transactions", which is not what that number means. Only wallets get it.
        if (isContract === false && txc?.success && Number.isFinite(txc.count)) {
            facts.push(`${onchain.groupThousands(String(txc.count))} transactions sent`);
        }
        if (bal?.success) {
            const eth = onchain.formatEther(bal.wei, 2);
            if (parseFloat(eth) > 0) facts.push(`holding ${onchain.groupThousands(eth)} ETH`);
        }

        const info = {
            address,
            // ENS is on-chain identity: the address itself claims that name.
            name: ensName || onchain.shortAddress(address),
            ensName: ensName || null,
            isContract,
            txCount: txc?.success ? txc.count : null,
            facts,
        };
        this._addrFacts.set(key, info);
        return info;
    }

    /** "0x28c6…ae44, a wallet with 1,204 transactions" — spoken form. */
    _partyPhrase(info, preLabel) {
        // A label from main (user watchlist or an attributed source) outranks
        // anything derived: the user named this address themselves.
        const base = preLabel && !/^0x/.test(preLabel) ? preLabel : info.name;
        if (!info.facts.length) return base;
        return `${base}, ${info.facts.slice(0, 2).join(' with ')}`;
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
            ? 'Whale monitoring is live, Sir. I will announce transfers of one hundred ETH or more, and stablecoin or wrapped-token movements above one million dollars, as blocks confirm on Ethereum. For each one I will tell you the amount, both addresses, and whatever the chain itself says about them.'
            : 'I could not start the chain stream.');
    }

    /* A chain the whale stream does not cover. His log shows the alternative:
       "give me whale alerts of solana" reached the model, which reported
       starting a search, then reported it complete, then reported no results —
       three fabrications about work that never happened. Saying what is and is
       not monitored costs one sentence and is true. */
    async handleWhaleUnsupported(askedChain) {
        const names = { solana: 'Solana', bitcoin: 'Bitcoin', polygon: 'Polygon' };
        const name = names[askedChain] || askedChain;
        const why = {
            // Measured, not assumed: the Helius socket delivered 239 token-program
            // events in 15 seconds. Filtering that on this machine is a different
            // kind of build, not a flag I can flip.
            solana: 'Solana emits token events far too fast to scan whole-network on this machine — I measured over two hundred in fifteen seconds. What I can do on Solana right now is read any wallet you name, its recent activity, and USDC and USDT supply.',
            bitcoin: 'Bitcoin is a different data source entirely and I am not connected to one.',
            polygon: 'My Alchemy key does not cover Polygon — it returns a plan error, so I have no reliable feed for it.',
        }[askedChain] || 'I have no feed for that chain.';
        const line = `I do not monitor whales on ${name}, Sir. ${why} My whale stream is Ethereum only: transfers over one hundred ETH, and stablecoin or wrapped-token movements over one million dollars.`;
        this.displayText(line, null);
        this.speak(line);
    }

    /* "Whales in the last hour" — answered from the recorded alert history, so
       the window covers what was actually observed while watching, never an
       impression. If the stream was not running, that is what gets said. */
    async handleWhaleWindow(text) {
        if (!window.electronAPI?.chainAlertsSummary) { this.speak('Alert history is not available here.'); return; }
        const m = String(text).match(/\b(last|past)\s+(\d+)?\s*(minute|min|hour|hr)/i);
        const n = m && m[2] ? parseInt(m[2], 10) : (m && /hour|hr/i.test(m[3]) ? 1 : 5);
        const minutes = m && /hour|hr/i.test(m[3]) ? n * 60 : n;
        const s = await window.electronAPI.chainAlertsSummary({ sinceMs: minutes * 60 * 1000 });
        if (!s?.success) { this.speak('I could not read the alert history, Sir.'); return; }

        const label = minutes >= 60 ? `${Math.round(minutes / 60)} hour${minutes >= 120 ? 's' : ''}` : `${minutes} minutes`;
        if (!s.whaleCount && !s.watchCount && !s.issuanceCount) {
            this.speak(s.streaming
                ? `Nothing above my thresholds in the last ${label}, Sir. I am watching.`
                : `I have no record for the last ${label}, Sir — the chain stream is not running, so nothing was observed.`);
            return;
        }
        const parts = [];
        for (const [sym, v] of Object.entries(s.byAsset || {})) {
            parts.push(`${v.count} ${sym} movement${v.count === 1 ? '' : 's'}${v.totalUsd ? ` worth ${this._fmtBigUsd(v.totalUsd)}` : ''}`);
        }
        let spoken = `In the last ${label}, Sir: ${parts.join(', ') || `${s.whaleCount} movements`}.`;
        if (s.largest) {
            spoken += ` Largest: ${s.largest.amount} ${s.largest.asset || 'ETH'}${s.largest.usd ? `, ${this._fmtBigUsd(s.largest.usd)}` : ''}.`;
        }
        if (s.issuanceCount) spoken += ` ${s.issuanceCount} stablecoin mint or burn events.`;
        this.displayText([`Chain activity, last ${label}:`, ...parts.map(p => `  ${p}`),
            s.largest ? `  Largest: ${s.largest.amount} ${s.largest.asset || 'ETH'} — tx ${s.largest.hash || 'n/a'}` : null].filter(Boolean).join('\n'), null);
        this.speak(spoken);
    }

    /* Stablecoin issuance. A mint is a Transfer from the zero address and a
       burn is one to it — supply changes are on-chain fact, so this needs no
       label database. Who ASKED for the mint is not on chain, and is not
       claimed. */
    async handleIssuance() {
        if (!window.electronAPI?.chainIssuance) { this.speak('Issuance reads are not available here, Sir.'); return; }
        this.displayText('Reading stablecoin mints and burns...', null);
        const r = await window.electronAPI.chainIssuance({ chain: 'ethereum', spanBlocks: 300 });
        if (!r?.success) { this.speak(`I could not read issuance activity, Sir. ${r?.error || ''}`.trim()); return; }

        // Partial coverage is stated, not smoothed over: "nothing happened" and
        // "I could only read part of the window" are different answers.
        const caveat = r.partial
            ? ` I could only read ${r.coverage} of the window — the free endpoints refused the rest, so this covers roughly ${r.approxMinutes} of the last ${r.requestedMinutes} minutes.`
            : '';
        const syms = Object.entries(r.summary || {});
        if (!syms.length) {
            this.speak(`No stablecoin mints or burns above one hundred thousand in roughly the last ${r.approxMinutes} minutes on Ethereum, Sir.${caveat}`);
            return;
        }
        const fmt = (n) => this._fmtBigUsd(n).replace('$', '');
        const lines = [`Stablecoin issuance, last ~${r.approxMinutes} minutes on Ethereum (blocks ${r.fromBlock}-${r.toBlock}):`];
        const spokenParts = [];
        for (const [sym, v] of syms) {
            lines.push(`${sym}: ${v.mints} mints totalling ${fmt(v.minted)}, ${v.burns} burns totalling ${fmt(v.burned)} — net ${v.net >= 0 ? '+' : ''}${fmt(Math.abs(v.net))}`);
            spokenParts.push(`${sym} saw ${fmt(v.minted)} minted and ${fmt(v.burned)} burned, a net ${v.net >= 0 ? 'increase' : 'decrease'} of ${fmt(Math.abs(v.net))}`);
        }
        for (const e of (r.events || []).slice(0, 5)) {
            lines.push(`  ${e.kind.toUpperCase()} ${e.amount} ${e.symbol} — ${e.kind === 'mint' ? 'to' : 'from'} ${e.counterparty} (block ${e.blockNumber})`);
        }
        this.displayText(lines.join('\n'), null);
        this.speak(`Over roughly the last ${r.approxMinutes} minutes on Ethereum, Sir: ${spokenParts.join('. ')}. Supply changes are measured on chain; who requested them is not something the chain records.${caveat}`);
    }

    /* Solana stablecoin supply. Read from the mint account itself — exact, and
       the delta between two readings is a mint or a burn. */
    async handleSolanaSupply() {
        if (!window.electronAPI?.solanaSupply) { this.speak('Solana reads are not available here, Sir.'); return; }
        const r = await window.electronAPI.solanaSupply({});
        if (r?.needsKey) { this.speak('I have no Helius key configured, Sir, so I cannot read Solana.'); return; }
        if (!r?.success || !Object.keys(r.supplies || {}).length) { this.speak('I could not read Solana stablecoin supply, Sir.'); return; }

        this._solSupply = this._solSupply || {};
        const lines = ['Solana stablecoin supply:'];
        const spoken = [];
        for (const [sym, v] of Object.entries(r.supplies)) {
            const prev = this._solSupply[sym];
            // A delta is only meaningful against a reading I actually took.
            const delta = prev ? v.amount - prev.amount : null;
            lines.push(`${sym}: ${v.amount.toLocaleString('en-US', { maximumFractionDigits: 0 })}` +
                (delta ? ` (${delta > 0 ? '+' : ''}${delta.toLocaleString('en-US', { maximumFractionDigits: 0 })} since my last reading)` : ''));
            spoken.push(`${sym} supply on Solana is ${this._fmtBigUsd(v.amount).replace('$', '')}` +
                (delta ? `, ${delta > 0 ? 'up' : 'down'} ${this._fmtBigUsd(Math.abs(delta)).replace('$', '')} since I last checked` : ''));
            this._solSupply[sym] = v;
        }
        this.displayText(lines.join('\n'), null);
        this.speak(spoken.join('. ') + '.');
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
        /* WHEN each headline was published, spoken as well as displayed. It was
           computed and shown on screen but dropped from speech, so a listener
           got no way to tell a story filed twenty minutes ago from one filed
           two days ago — and no way to notice a feed that had gone stale. */
        const display = items.map((it, i) =>
            `${i + 1}. ${it.title}${it.source ? `  — ${it.source}` : ''}` +
            `${it.publishedLocal ? `\n     ${it.publishedLocal}${it.publishedText ? ` (${it.publishedText})` : ''}` : ''}`
        ).join('\n');

        const now = new Date();
        const header = `${topic ? `News: ${topic}` : 'Top headlines'} — read at ${now.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` +
            `${res.provider ? ` via ${res.provider}` : ''}`;
        this.displayText(`${header}\n${display}`, null);

        const spoken = items.slice(0, 3).map((it, i) =>
            `${i + 1}. ${it.title}${it.source ? `, from ${it.source}` : ''}${it.publishedText ? `, ${it.publishedText.replace(/(\d+)m ago/, '$1 minutes ago').replace(/(\d+)h ago/, '$1 hours ago').replace(/(\d+)d ago/, '$1 days ago')}` : ''}`
        ).join('. ');

        /* A provider that starts serving a cached feed looks healthy from the
           inside; the only tell is the age of its newest story. Six hours is
           well beyond normal for a wire feed, so past that the age is stated
           plainly instead of the headlines being read as though they are current. */
        const stale = Number.isFinite(res.newestAgeMinutes) && res.newestAgeMinutes > 360;
        const lead = topic ? `Here's the latest on ${topic}. ` : 'Here are the top headlines. ';
        const caveat = stale
            ? ` Note that the freshest story here is ${Math.round(res.newestAgeMinutes / 60)} hours old, Sir, so this feed may not be current.`
            : '';
        this.speak(`${lead}${spoken}.${caveat}`);
    }

    /* CONTINUOUS INGESTION.
       One cycle: fetch every probe-verified feed, drop what has already been
       seen, record the rest with provenance, and put a short form of each into
       long-term memory. This is the answer to a measured gap — 227 turns of
       conversation had produced a 2-chunk corpus — so the point is the corpus,
       not the announcement. It runs quietly and says nothing unless asked. */
    async ingestFeeds({ domain = null, announce = false } = {}) {
        if (!window.electronAPI?.feedFetch) return { ingested: 0, failed: [] };
        const active = feeds.activeFeeds(domain);
        const seenRes = await window.electronAPI.feedSeenGet().catch(() => null);
        const seen = new Set(Array.isArray(seenRes) ? seenRes : []);

        const fresh = [];
        const failed = [];
        // Sequential on purpose: a dozen feeds fetched at once looks like a
        // scraper to the publisher, and none of this is time-critical.
        for (const feed of active) {
            const r = await window.electronAPI.feedFetch({ url: feed.url, needsUserAgent: !!feed.needsUserAgent }).catch(() => null);
            if (!r?.success) { failed.push({ id: feed.id, error: r?.error || 'unreachable' }); continue; }
            fresh.push(...feeds.dedupe(feeds.parseFeed(r.xml, feed, { limit: 20 }), seen));
        }
        if (!fresh.length) {
            if (announce) this.speak(failed.length
                ? `I could not reach ${failed.length} of my feeds, Sir, and the rest had nothing new.`
                : 'Nothing new in the feeds, Sir.');
            return { ingested: 0, failed };
        }

        await window.electronAPI.feedRecord({ events: fresh });
        for (const e of fresh) seen.add(e.id);
        await window.electronAPI.feedSeenSet({ ids: [...seen] });

        /* Into long-term memory, attributed. Ingested as 'feed' so a later
           forget() can evict the whole class without touching the user's own
           notes — news ages differently from what someone tells you. */
        let stored = 0;
        for (const e of fresh) {
            const text = feeds.toMemoryText(e);
            if (!text) continue;
            try { await ragService.ingest(text, { source: `feed:${e.feedId}`, url: e.url }); stored++; }
            catch { /* one bad ingest must not stop the cycle */ }
        }
        console.log(`Feeds: ${fresh.length} new events, ${stored} into memory, ${failed.length} feeds unreachable`);
        if (announce) this.speak(feeds.describeBrief(fresh));
        return { ingested: fresh.length, stored, failed };
    }

    /** "brief me" / "what changed today" — from the recorded log, not a fresh guess. */
    async handleFeedBrief(hours = 24) {
        if (!window.electronAPI?.feedHistory) { this.speak('Feed history is not available here, Sir.'); return; }
        this.displayText('Checking the feeds...', null);
        // Pull anything new first so the brief reflects now, not last cycle.
        const cycle = await this.ingestFeeds({ announce: false });
        const r = await window.electronAPI.feedHistory({ sinceMs: hours * 3600 * 1000 }).catch(() => null);
        if (!r?.success) { this.speak('I could not read the feed history, Sir.'); return; }

        const events = r.events || [];
        if (!events.length) {
            this.speak(`Nothing in the last ${hours} hours, Sir.` +
                (cycle.failed.length ? ` ${cycle.failed.length} feeds were unreachable.` : ''));
            return;
        }
        const grouped = feeds.groupByDomain(events);
        const lines = [`Feed brief — last ${hours}h, ${events.length} items`];
        for (const [domain, list] of Object.entries(grouped)) {
            lines.push('', `${domain.toUpperCase()} (${list.length})`);
            for (const e of list.sort((a, b) => (b.publishedTs || 0) - (a.publishedTs || 0)).slice(0, 6)) {
                const when = e.published ? new Date(e.published).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'undated';
                lines.push(`  ${when}  ${e.source}: ${e.title.slice(0, 88)}`);
            }
        }
        if (cycle.failed.length) lines.push('', `Unreachable: ${cycle.failed.map(f => f.id).join(', ')}`);
        this.displayText(lines.join('\n'), null);
        this.speak(feeds.describeBrief(events, { hours }));
        this._lastFactual = { text: lines.join('\n'), at: Date.now() };
    }

    /* Chrome security releases, read from the advisory itself.
       The model is not in this path at all: the feed is fetched, the tested
       parser extracts the CVE table, and the severities spoken are the ones
       Google published. */
    async handleSecurityAdvisory() {
        if (!window.electronAPI?.securityAdvisories) { this.speak('Advisory lookups are not available here, Sir.'); return; }
        this.displayText('Reading the Chrome release advisories...', null);
        const r = await window.electronAPI.securityAdvisories({ channel: 'desktop' }).catch(() => null);
        if (!r?.success) { this.speak(`I could not reach the Chrome release feed, Sir. ${r?.error || ''}`.trim()); return; }

        const posts = security.parseAdvisoryFeed(r.xml, { limit: 12 });
        /* The newest POST is not the newest SECURITY post — a driver or Android
           release often lands after the desktop advisory, and answering with it
           would answer a different question. */
        const latest = posts.find(p => p.securityUpdate);
        if (!latest) {
            this.speak('The recent Chrome releases in the feed carry no security fixes, Sir.');
            return;
        }
        const ranked = security.sortBySeverity(latest.cves);
        const counts = security.countBySeverity(latest.cves);
        const when = chainIntel.timeAgo(Date.parse(latest.published));
        this.displayText([
            `${latest.title} — ${new Date(latest.published).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}${when ? ` (${when})` : ''}`,
            `${latest.cves.length} security fixes: ${Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`).join(', ')}`,
            '',
            ...ranked.map(c => `${c.severity.padEnd(8)} ${c.id}  ${c.description}`),
            '',
            `Source: ${latest.url}`,
        ].join('\n'), null);
        this.speak(security.describeAdvisory(latest));
        this._lastFactual = { text: this.lastDisplayed || '', at: Date.now() };
    }

    /** One CVE, from NVD — the authority on severity, not the model. */
    async handleCveLookup(cveId) {
        if (!window.electronAPI?.cveLookup) { this.speak('CVE lookups are not available here, Sir.'); return; }
        this.displayText(`Looking up ${cveId}...`, null);
        const r = await window.electronAPI.cveLookup({ id: cveId }).catch(() => null);

        if (!r?.success) {
            /* Before giving up, check the Chrome advisories: a CVE published in
               the last few days is often in Google's feed with a severity while
               the NVD record is still empty. */
            const feed = await window.electronAPI.securityAdvisories?.({ channel: 'desktop' }).catch(() => null);
            if (feed?.success) {
                for (const post of security.parseAdvisoryFeed(feed.xml, { limit: 12 })) {
                    const hit = post.cves.find(c => c.id === cveId);
                    if (hit) {
                        this.displayText([
                            `${hit.id} — ${hit.severity}`,
                            hit.description,
                            '',
                            `From: ${post.title}, ${new Date(post.published).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`,
                            post.url,
                        ].join('\n'), null);
                        this.speak(`${hit.id} is rated ${hit.severity.toLowerCase()} by Google, Sir: ${hit.description}. ` +
                            `The NVD has not published a CVSS score for it yet.`);
                        return;
                    }
                }
            }
            this.speak(`I have no record for ${cveId}, Sir. ${r?.error === 'no such CVE in the NVD' ? 'It is not in the NVD and not in the recent Chrome advisories.' : ''}`.trim());
            return;
        }

        const cve = security.parseNvdCve(r.payload);
        if (!cve) { this.speak(`I could not read the record for ${cveId}, Sir.`); return; }

        /* Ask the vendor too, and compare. One source can be wrong or stale;
           two disagreeing sources is a fact worth stating rather than a tie to
           break silently. Costs one cached feed fetch. */
        let vendorEntry = null;
        const feed = await window.electronAPI.securityAdvisories?.({ channel: 'desktop' }).catch(() => null);
        if (feed?.success) {
            for (const post of security.parseAdvisoryFeed(feed.xml, { limit: 12 })) {
                const hit = post.cves.find(c => c.id === cveId);
                if (hit) { vendorEntry = hit; break; }
            }
        }
        const verdict = security.crossVerify(vendorEntry, cve, { vendorName: 'Google' });

        this.displayText([
            `${cve.id}${cve.severity ? ` — ${cve.severity}${cve.baseScore != null ? ` (CVSS ${cve.baseScore})` : ''}` : ' — no score assigned yet'}`,
            cve.vector ? `Vector: ${cve.vector}` : null,
            cve.published ? `Published: ${new Date(cve.published).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}` : null,
            cve.source ? `Source: ${cve.source}` : null,
            vendorEntry ? `Google advisory: ${vendorEntry.severity} — ${vendorEntry.description}` : null,
            `Verification: ${verdict.status}${verdict.sources.length ? ` (${verdict.sources.join(', ')})` : ''}`,
            '',
            cve.description || '',
        ].filter(Boolean).join('\n'), null);

        /* A disagreement between authorities outranks either one's own summary:
           it is the single most useful thing to say, and the thing a
           single-source answer would have hidden. */
        this.speak(verdict.status === 'conflict'
            ? security.describeVerification(verdict, cveId)
            : `${security.describeCve(cve)}${verdict.status === 'confirmed' ? ' Google\'s advisory agrees.' : ''}`);
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
        // Appends to whichever turn is current WHEN THE WORDS ARE SPOKEN. A
        // superseded turn's own buffer is held by reference in processCommand,
        // so late speech can no longer be attributed to the wrong input.
        if (this._activeBuffer) {
            this._activeBuffer.text = (this._activeBuffer.text + ' ' + text).trim();
        }
    }

    // Append one local turn to the persistent interaction log. Best-effort and
    // fully guarded — telemetry must never break or slow a turn. Secret-bearing
    // commands are dropped here so a key never reaches disk via this path.
    _logInteraction(input, intent, startedAt, ok, buf) {
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
                response: String((buf ? buf.text : this._activeBuffer?.text) || '').slice(0, 500),
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

        // Bare numbers are almost always the mic hearing Jarvis's own spoken
        // figures — the word-overlap echo guard needs 3+ words so it can't
        // catch them. Real log: Jarvis said "beta is 1.75", the mic fed back
        // "1.75" as a user turn, and Gemma answered it with an invented price.
        if (/^[\d\s.,:%$-]+$/.test(cmd)) {
            this._showTranscript(t, 'ambient', 'HEARD (number only - ignored)', 2500);
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

        // VOICE TYPING owns the transcript while it is active: the words are
        // the user's text, not commands for the model. Checked after the echo
        // guard so Jarvis's own speech is never dictated into the document.
        if (this._dictation) {
            this._lastInputWasVoice = true;
            this.handleDictationTranscript(cmd);
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
                            const sAgo = chainIntel.timeAgo(w.blockTs);
                            const line = `${w.count} further large transfers in block ${w.blockNumber}${sAgo ? `, ${sAgo}` : ''}, the largest ${w.largestAmount} ${w.largestAsset || 'ETH'}${usd}.`;
                            this.displayText(`Whale summary: ${line}${late}`, null);
                            if (this._whaleAlertsOn) this.speak(`Also, ${line}`);
                            break;
                        }
                        // Both ends of the movement, described from measured
                        // on-chain facts. Screen gets the full addresses and the
                        // tx hash; speech gets the readable form, because a
                        // 42-character hex string is unusable as audio.
                        const [fromInfo, toInfo] = await Promise.all([
                            this.describeAddress(w.from),
                            this.describeAddress(w.to),
                        ]);
                        const asset = w.asset || 'ETH';
                        const usd = w.usd ? `, approximately ${w.usd.toLocaleString('en-US')} dollars,` : '';
                        /* When it happened, from the block's own timestamp. A
                           live head is seconds old and a recovered one can be
                           many minutes old; announcing both the same way would
                           make stale news sound current. */
                        const ago = chainIntel.timeAgo(w.blockTs);
                        const clock = chainIntel.clockTime(w.blockTs);
                        const when = ago ? `, ${ago}` : '';
                        // A multi-hop route is one movement taking a path, and a
                        // round trip is money that ended up back where it began —
                        // saying "moved from A to B" for either would misdescribe it.
                        const route = w.hops > 1 ? ` It took ${w.hops} hops inside one transaction${w.roundTrip ? ', and returned to where it started' : ''}.` : '';
                        const spokenLine = `${w.amount} ${asset}${usd} moved from ${this._partyPhrase(fromInfo, w.fromLabel)} to ${this._partyPhrase(toInfo, w.toLabel)} in block ${w.blockNumber}${when}.${route}`;

                        const detail = [
                            `Whale alert — ${w.amount} ${asset}${w.usd ? ` ($${w.usd.toLocaleString('en-US')})` : ''} on ${w.chain || 'ethereum'}${late}`,
                            clock ? `TIME ${clock}${ago ? ` (${ago})` : ''}` : null,
                            w.hops > 1 ? `ROUTE ${w.hops} hops in one transaction${w.roundTrip ? ' (round trip)' : ''}` : null,
                            `FROM ${w.from || 'contract creation'}${fromInfo.ensName ? ` (${fromInfo.ensName})` : ''}${fromInfo.facts.length ? ` — ${fromInfo.facts.join(', ')}` : ''}`,
                            `TO   ${w.to || 'contract creation'}${toInfo.ensName ? ` (${toInfo.ensName})` : ''}${toInfo.facts.length ? ` — ${toInfo.facts.join(', ')}` : ''}`,
                            w.contract ? `TOKEN ${asset} at ${w.contract}` : null,
                            `TX   ${w.hash}`,
                            `Block ${w.blockNumber}`,
                        ].filter(Boolean).join('\n');
                        this.displayText(detail, null);
                        if (this._whaleAlertsOn) this.speak(`Sir, significant movement on ${w.chain === 'ethereum' || !w.chain ? 'Ethereum' : w.chain}. ${spokenLine}`);
                        break;
                    }

                    case 'stablecoin-issuance': {
                        /* Supply changed. This is a different event from money
                           moving, and often the more meaningful one — but the
                           chain records only WHAT happened, not who asked for
                           it, so no issuer is named as the actor. */
                        const e = evt.payload;
                        const verb = e.kind === 'mint' ? 'minted into' : 'burned from';
                        const eAgo = chainIntel.timeAgo(e.blockTs);
                        const eClock = chainIntel.clockTime(e.blockTs);
                        const line = `${e.amount} ${e.symbol} was ${verb} circulation in block ${e.blockNumber}${eAgo ? `, ${eAgo}` : ''}.`;
                        this.displayText([
                            `Stablecoin ${e.kind.toUpperCase()} — ${e.amount} ${e.symbol} on ${e.chain}`,
                            eClock ? `TIME ${eClock}${eAgo ? ` (${eAgo})` : ''}` : null,
                            `${e.kind === 'mint' ? 'TO  ' : 'FROM'} ${e.counterparty}`,
                            `TX   ${e.hash}`,
                        ].filter(Boolean).join('\n'), null);
                        if (this._whaleAlertsOn) this.speak(`Sir, stablecoin supply change. ${line}`);
                        break;
                    }

                    case 'chain-watch-hit': {
                        // Activity on an address the user asked to watch — always
                        // announce; that was the whole point of watching it.
                        const h = evt.payload;
                        const verb = h.direction === 'out' ? 'sent' : 'received';
                        const other = h.direction === 'out' ? 'to' : 'from';
                        const usd = h.usd ? ` — roughly ${h.usd.toLocaleString('en-US')} dollars` : '';
                        const cpInfo = await this.describeAddress(h.counterpartyAddress);
                        const hAgo = chainIntel.timeAgo(h.blockTs);
                        const hClock = chainIntel.clockTime(h.blockTs);
                        // "just" is only honest for a live block. A recovered one
                        // can be twenty minutes old, and saying "just" would be a
                        // small lie told confidently.
                        const recent = hAgo === 'just now';
                        const line = `${h.label} ${recent ? 'just ' : ''}${verb} ${h.amount} ${h.asset || 'ETH'} ${other} ${this._partyPhrase(cpInfo, h.counterparty)} in block ${h.blockNumber}${hAgo && !recent ? `, ${hAgo}` : ''}${usd}.`;
                        this.displayText([
                            `Watched address ${h.direction === 'out' ? 'SENT' : 'RECEIVED'} ${h.amount} ${h.asset || 'ETH'}${h.usd ? ` ($${h.usd.toLocaleString('en-US')})` : ''}`,
                            hClock ? `TIME ${hClock}${hAgo ? ` (${hAgo})` : ''}` : null,
                            `WATCHED ${h.watched}`,
                            `${h.direction === 'out' ? 'TO  ' : 'FROM'} ${h.counterpartyAddress || 'unknown'}${cpInfo.ensName ? ` (${cpInfo.ensName})` : ''}${cpInfo.facts.length ? ` — ${cpInfo.facts.join(', ')}` : ''}`,
                            `TX   ${h.hash}`,
                        ].join('\n'), null);
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
        /* A bare follow-up ("them.", "tell me.") right after a measured answer
           must be answered FROM that answer. Without this the model has only
           the conversation and invents plausible content — the log shows it
           producing "Headphones_XYZ" and "Smartwatch_ABC" after a real
           Bluetooth listing, then defending them when challenged. */
        let factContext = '';
        if (this._lastFactual && Date.now() - this._lastFactual.at < 180000) {
            const bare = this._isBareFollowUp(query);
            factContext = `\n\nThe last factual answer you gave, produced by a real measurement on this machine, was:\n"${this._lastFactual.text}"\n`
                + (bare
                    ? 'The user is asking you to elaborate on THAT answer. Restate or expand it using ONLY the facts in it. If it does not contain what he is asking for, say the measurement did not include that and offer to run it again. Do not add any name, number or item that is not in it.'
                    : 'Use it if relevant, but never add items to it.');
        }

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
                    // Logged fabrication: asked for the IP of a host called
                    // "pro haven" the model answered "192.168.1.10". Nothing
                    // resolved it; the address was invented and stated as fact.
                    // Concrete identifiers are the highest-harm thing to guess,
                    // because he acts on them.
                    + ' NEVER state a specific IP address, MAC address, port number, hostname, price, balance, device name, network name, or any other concrete measured value unless it appears verbatim in the context above. You have no ability to look these up or scan for them while answering. If you do not have the value, say you do not have it and stop — a plausible-looking number or a placeholder name is worse than no answer. Never invent example names such as "Device_XYZ".'
                    + sysContext + memoryContext + webContext + factContext
            },
            ...history,
            { role: 'user', content: query }
        ];

        // STREAMING SPEECH: speak each sentence the moment it completes in
        // the token stream, instead of waiting for the whole answer. Cuts
        // time-to-first-word from ~5-10s to ~1-2s.
        let displayed = '';
        let spokenUpTo = 0;

        /* GROUNDING: everything the model was actually given. Any concrete
           identifier it emits must appear in here verbatim or it is invented.
           The prompt already forbids this and the model does it anyway (see
           groundingGuard.js for the logged cases), so the rule is enforced on
           the way OUT, per sentence, before anything is spoken. */
        const groundingContext = [sysContext, memoryContext, webContext, factContext,
            history.map(h => h.content).join('\n'), query].join('\n');
        let tainted = false;

        // Guard one sentence. Returns false once the answer is tainted, which
        // stops the rest of a fabricating response from reaching the speaker.
        const speakGuarded = (sentence) => {
            if (tainted) return false;
            const g = guardOutput(sentence, groundingContext);
            if (!g.blocked) { this._speakQueued(sentence); return true; }

            tainted = true;
            console.warn('Grounding guard blocked ungrounded output:',
                g.found.map(f => `${f.kind}=${f.value}`).join(', '));
            this._speakQueued(g.text);
            this.displayText(`${displayed}\n\n[blocked: ${g.found.map(f => f.value).join(', ')} — not present in any measurement]`, null);
            /* Store the refusal, never the fabrication. When the invention was
               allowed into history the model quoted it back as established fact
               on the next turn and defended it when challenged. */
            this.memory.addMessage('assistant', g.text);
            return false;
        };

        // This turn's cancellation token, captured now: if a newer turn arrives
        // it replaces this._turnAbort, but the signal handed to the generator
        // stays bound to this turn and aborts it.
        const signal = this._turnAbort?.signal;

        try {
            const fullText = await generateContentLocal(messages, (chunk) => {
                if (tainted) return;
                displayed += chunk;
                this.displayText(displayed, null);

                // Find complete sentences beyond what we've already spoken
                const pending = displayed.slice(spokenUpTo);
                const m = pending.match(/^[\s\S]*?[.!?](?=\s|$)/);
                if (m && m[0].trim().length > 1) {
                    spokenUpTo += m[0].length;
                    speakGuarded(m[0]);
                }
            }, { signal });
            // Speak whatever remains after the stream ends
            const tail = displayed.slice(spokenUpTo).trim();
            if (tail) speakGuarded(tail);
            if (!tainted) this.memory.addMessage('assistant', fullText);
        } catch (error) {
            console.error('Local AI error:', error);
            this.speak(this._describeLocalFailure(error));
        }
    }

    /* Turn a local-inference failure into something worth hearing. The raw
       error was spoken verbatim — "Ollama error 500: is 'gemma3:4b' pulled?
       Try: ollama pull gemma3:4b" — which is a developer's message read aloud
       to a user whose real problem was that the machine sat at 97% memory and
       the model was being evicted. */
    _describeLocalFailure(error) {
        const msg = String(error?.message || error || '');
        if (error?.name === 'LocalTimeoutError' || /stalled|produced nothing/i.test(msg)) {
            return 'The local model did not respond in time, Sir. It is usually memory pressure — closing a few Chrome tabs normally fixes it. Ask me again when you are ready.';
        }
        if (/50\d/.test(msg)) {
            return 'The local model failed to load, Sir. That is normally low memory. I have left the request alone rather than guess an answer.';
        }
        if (/fetch|network|ECONNREFUSED|Failed to fetch/i.test(msg)) {
            return 'I cannot reach the local model server, Sir. Ollama does not appear to be running.';
        }
        return 'Local inference failed, Sir, so I have no answer for that rather than an invented one.';
    }

    /* Queued speech for streaming answers: does NOT cancel prior utterances
       (unlike speak(), which flushes). Keeps the mic gate (ttsActive) held
       until the last queued line has finished AND its trailing pause elapsed.

       PACING: the browser plays queued utterances back to back with no gap, so
       a multi-sentence answer arrives as one unbroken wall of speech — the
       listener gets no boundary between "1,278,685 USDC moved from A to B" and
       the next alert. Lines are therefore drained one at a time with a real
       silence between them. The gap is inside the mic gate on purpose: opening
       the microphone during the pause would let Jarvis transcribe its own next
       sentence. */
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
            (this._speechQueue = this._speechQueue || []).push(clean);
            this._drainSpeech();
        } catch (e) {
            console.warn('Queued TTS failed:', e);
        }
    }

    /** Speak one queued line, pause, then the next. Never runs twice at once. */
    _drainSpeech() {
        if (this._speechDraining) return;
        const queue = this._speechQueue || [];
        if (!queue.length) return;

        this._speechDraining = true;
        const line = queue.shift();
        const u = new SpeechSynthesisUtterance(line);
        if (this.selectedVoice) u.voice = this.selectedVoice;
        u.rate = this.settings.get('speechRate') || 1.0;
        u.pitch = this.settings.get('speechPitch') || 1.0;
        u.volume = this.settings.get('speechVolume') || 1.0;

        let settled = false;
        const finish = () => {
            if (settled) return;   // onend and the safety timer can both fire
            settled = true;
            clearTimeout(safety);
            this._utterCount = Math.max(0, (this._utterCount || 1) - 1);
            // The pause. ttsActive stays true across it so the microphone does
            // not open into the gap and hear the line that follows.
            setTimeout(() => {
                this._speechDraining = false;
                if ((this._speechQueue || []).length) this._drainSpeech();
                else if (this._utterCount === 0) this.ttsActive = false;
            }, this.settings.get('speechGapMs') ?? 450);
        };
        u.onend = finish;
        u.onerror = finish;
        /* A line that never reports back must not stall the queue forever —
           the same eventless-death problem as the mic watchdog. Budget is
           generous (SAPI runs ~450ms/word) and only fires if onend does not. */
        const safety = setTimeout(finish, Math.min(line.split(/\s+/).length * 500 + 4000, 40000));

        this.synthesis.speak(u);
    }

    /** Drop anything still waiting — used when a newer turn takes over. */
    _flushSpeechQueue() {
        this._speechQueue = [];
        this._speechDraining = false;
        this._utterCount = 0;
    }
}

export default Jarvis;

