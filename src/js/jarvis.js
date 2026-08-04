// Jarvis AI Assistant Core Module
import ConversationMemory from './memory.js';
import ScreenCapture from './screenCapture.js';
import CalendarSystem from './calendar.js';
import SettingsManager from './settings.js';
import { LiveService } from './liveService.js';
import { generateContentLocal, checkOllama, routeLocalAction, describeImageLocal } from './toolService.js';
import { routePhoneCommand, targetsPhone, executePhoneTool } from './services/phoneTools.js';
import { parseMirrorCommand } from './services/mirrorIntent.js';
import HapticManager from './services/hapticManager.js';
import { parseSystemCommand, SYSTEM_INTENTS } from './services/systemCommands.js';
import { parseFoundryCommand, FOUNDRY_ACTIONS } from './services/foundry/foundryIntent.js';
import ragService from './services/ragService.js';
import { parseWebSearchQuery, summarizeForSpeech, formatForDisplay } from './services/webSearchIntent.js';
import reflectionService from './services/reflectionService.js';
import * as quant from './services/quant.js';
import * as portfolio from './services/portfolio.js';
import * as onchain from './services/onchain.js';
import * as ens from './services/ens.js';
import * as chainIntel from './services/chainIntel.js';
import * as prediction from './services/predictionMarkets.js';
import * as security from './services/security.js';
import * as feeds from './services/feeds.js';
import { parseEdgarQuery, buildSearchUrl as buildEdgarUrl, parseSearchResults as parseEdgarResults, describeResults as describeEdgarResults, toMemoryText as edgarMemoryText } from './services/edgarSearch.js';
import * as edgarCompany from './services/edgarCompany.js';
import * as secSections from './services/secSections.js';
import * as investigation from './services/investigation.js';
import * as feedback from './services/feedback.js';
import { parseOndoQuery, ONDO_COUNT, HOT_LIST as ONDO_HOT_LIST } from './services/ondoRegistry.js';
import * as netInspect from './services/netInspect.js';
import * as netDiscovery from './services/netDiscovery.js';
import * as sysInspect from './services/sysInspect.js';
import * as inputControl from './services/inputControl.js';
import { parseFileCommand, inferCodeFilename } from './services/fileCommands.js';
import { parseAlarmCommand, parseAlarmCancel, parseAlarmList, formatDuration, formatClock } from './services/alarmParser.js';
import { AlarmService } from './services/alarmService.js';

/* How long after launch a missing TTS server is treated as "still starting"
   rather than "broken". The Python server plus edge-tts import lands well
   inside this on a cold boot. */
const TTS_STARTUP_GRACE_MS = 20000;
import { MeetingScheduler } from './services/meetingScheduler.js';
import { MeetingMonitor, describeAlert } from './services/meetingMonitor.js';
import { LocalVoiceService } from './services/voiceService.js';
import { NeuralTTSService } from './services/ttsService.js';
import { guardOutput } from './services/groundingGuard.js';
import { config } from '../config.js';
import perf from './services/perf.js';
import { diagnoseLocalFailure, health } from './services/selfHeal.js';

class Jarvis {
    constructor() {
        this.isListening = false;
        this.isProcessing = false;
        this.wakeWordDetected = false;
        this.recognition = null;
        this.synthesis = window.speechSynthesis;
        this.selectedVoice = null; // Will be set during initialization
        this.neuralTTS = null;     // edge-tts neural voice (initialized below)
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

        // Alarms and timers. speak/display are bound so the service can
        // announce a missed alarm on startup without reaching into the app.
        this.alarms = new AlarmService({
            speak: (t) => this.speak(t),
            display: (t) => this.displayText(t, null),
        });
        this.calendar.requestNotificationPermission();

        // Settings Manager
        this.settings = new SettingsManager();
        this.applySettings();

        /* Feedback. Probes what this machine can actually do rather than
           assuming — on the desktop that is animation plus a synthesized
           click, because navigator.vibrate is callable in Electron and moves
           nothing. The probe result is logged so a missing channel is a stated
           fact instead of a mystery. */
        this.haptics = HapticManager;
        const hapticCaps = HapticManager.init({
            enabled: this.settings.get('hapticsEnabled') !== false,
            intensity: this.settings.get('hapticIntensity') ?? 0.7
        });
        console.log('Jarvis: feedback channels', hapticCaps);

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
                // Gate mic while EITHER SAPI or neural TTS is speaking
                isTtsSpeaking: () => this.ttsActive || (this.neuralTTS && this.neuralTTS.isSpeaking()),
                // Barge-in is only offered while the neural voice is carrying
                // the reply. It plays through WebAudio, so Chromium's echo
                // canceller has a reference for it and what reaches the mic is
                // residual. SAPI plays out of process with no reference at all:
                // there the mic hears the reply at full strength and no
                // threshold can separate it from the user.
                canBargeIn: () => !!(this.neuralTTS && this.neuralTTS.isSpeaking()),
                onBargeIn: () => this._onBargeIn(),
            });
            setTimeout(() => {
                this.localVoice.start().catch(e => {
                    console.warn('LocalVoice: mic start failed (voice input disabled)', e);
                    this._showTranscript(`Microphone unavailable: ${e.name || e.message}`, 'error', 'MIC ERROR', 0);
                });
            }, 1500);
        }

        // Neural TTS: natural-sounding voice through WebAudio, which also
        // gives Chromium's echo canceller a proper reference signal (SAPI
        // plays out of process and bypasses it entirely).
        //
        // NOT LOCAL. server/tts-server.py uses edge-tts, which streams the
        // text to Microsoft's endpoint and streams MP3 back. Every sentence
        // Jarvis speaks leaves the machine, and with no network there is no
        // neural voice. That is the opposite of what the rest of this build
        // guarantees, so it is stated here rather than buried: the SAPI path
        // below is the offline voice, and the fallback is what keeps the
        // offline promise true when this is unreachable.
        //
        // Connects asynchronously — if the TTS server is not running, speak()
        // falls back to SAPI transparently.
        this.neuralTTS = new NeuralTTSService({
            onSpeakStart: () => { this.ttsActive = true; },
            onSpeakEnd: () => { this.ttsActive = false; },
            onStatus: (s) => console.log('NeuralTTS:', s),
        });
        this._startedAt = Date.now();
        this.neuralTTS.connect().then(ok => {
            if (ok) {
                // Recovered — clear the latch so a LATER outage warns again
                // instead of being suppressed by a startup-time warning.
                this._warnedNoVoice = false;
                console.log('NeuralTTS: edge-tts connected — natural voice active (NOT local)');
            } else {
                console.log('NeuralTTS: server not up yet — retrying with backoff');
            }
        }).catch(() => {});

        /* Learned timeout budgets survive a restart. Without this every launch
           re-learns this machine's speed from the seed constants, which means
           the first few turns after every start pay the same too-tight deadline
           that caused the problem in the first place. */
        this._restoreHealthState();
        setInterval(() => this._persistHealthState(), 60000);

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

    /* The Web Speech API exposes no gender on SpeechSynthesisVoice, so the
       judgement has to come off the name. One list, used by both the selection
       above and `list voices`, so the two can never disagree about what counts.
       Matching by known female names rather than by excluding male ones keeps
       an unrecognised voice out of the assistant's mouth instead of letting it
       through by default. */
    isFemaleVoice(name) {
        return /\b(female|zira|aria|jenny|michelle|ava|emma|hazel|samantha|sonia|libby|maisie|natasha|clara|molly|neerja|victoria|karen|moira|tessa|fiona)\b/i
            .test(String(name || ''));
    }

    // Initialize voice selection
    initializeVoice() {
        // Wait for voices to be loaded
        const loadVoices = () => {
            const voices = this.synthesis.getVoices();
            const savedVoiceName = this.settings.get('voiceName');

            /* The saved name wins over the defaults on merge, so an install
               that already stored a male system voice would keep speaking with
               it forever and the selection below would never run. A stored name
               is therefore honoured only while it still passes isFemaleVoice —
               that is what evicts the old default, without this file having to
               carry a list of male names to match against. */
            if (savedVoiceName && this.isFemaleVoice(savedVoiceName)) {
                const savedVoice = voices.find(v => v.name === savedVoiceName);
                if (savedVoice) {
                    this.selectedVoice = savedVoice;
                    console.log('Using saved voice:', savedVoice.name);
                    return;
                }
            } else if (savedVoiceName) {
                console.log('Discarding stored non-female voice:', savedVoiceName);
                this.settings.set('voiceName', null);
            }

            /* Preferred order for the stand-in voice, best-first: Windows 11
               "Natural" voices, then the classic SAPI ones (Zira is the only
               female voice on a stock Windows install), then Chromium's own. */
            const preferredVoices = [
                'Microsoft Aria', 'Microsoft Jenny', 'Microsoft Michelle', 'Microsoft Ava',
                'Microsoft Emma', 'Microsoft Sonia', 'Microsoft Libby', 'Microsoft Hazel',
                'Microsoft Zira Desktop', 'Microsoft Zira',
                'Google UK English Female',
                'Samantha', 'Victoria', 'Karen', 'Moira', 'Tessa'
            ];

            for (const name of preferredVoices) {
                const voice = voices.find(v => v.name.includes(name) || name.includes(v.name));
                if (voice) {
                    this.selectedVoice = voice;
                    this.settings.set('voiceName', voice.name);
                    console.log('Selected female voice:', voice.name);
                    return;
                }
            }

            // Nothing preferred is installed — take any English voice that reads as female.
            const femaleVoice = voices.find(v =>
                v.lang.toLowerCase().startsWith('en') && this.isFemaleVoice(v.name));

            if (femaleVoice) {
                this.selectedVoice = femaleVoice;
                this.settings.set('voiceName', femaleVoice.name);
                console.log('Selected female voice (fallback):', femaleVoice.name);
            } else {
                /* No female voice installed. Deliberately leaves selectedVoice
                   null rather than taking the system default — on a stock
                   Windows install that default is David, and speaking as him
                   because a server was down is worse than not speaking. The
                   neural server is the voice; this path only matters when it is
                   unavailable AND systemVoiceFallback was turned on. */
                this.selectedVoice = null;
                console.warn('No female system voice installed — the system fallback will stay silent. '
                    + 'Install one under Settings > Time & language > Speech.');
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
                    this.haptics.acknowledge();
                    console.log("🎤 [TRANSCRIPT] User said:", msg.text);
                    this.appendLiveTranscript(msg.text);
                    this.logToHUD(msg.text, 'user');
                }
                return;
            }

            // Also check serverContent.inputTranscript (SDK format)
            if (msg.serverContent?.inputTranscript) {
                this.haptics.acknowledge();
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

            // ──────────────────────────────────────────────────────────────
            // NEURAL TTS (edge-tts): try first for natural-sounding voice.
            // Routes audio through WebAudio, giving Chromium's AEC a proper
            // reference signal. Falls back to SAPI if server unavailable.
            // ──────────────────────────────────────────────────────────────
            if (this.neuralTTS && this.neuralTTS.isAvailable()) {
                this.ttsActive = true;
                // Interrupt any in-progress speech
                this.neuralTTS.interrupt();
                this.synthesis.cancel();
                this._flushSpeechQueue();

                const maxMs = Math.min(clean.split(/\s+/).length * 450 + 5000, 60000);
                clearTimeout(this._ttsSafetyTimer);
                this._ttsSafetyTimer = setTimeout(() => { this.ttsActive = false; }, maxMs);

                this.neuralTTS.speak(clean, {
                    voice: this.settings.get('neuralVoice') || 'en-US-EmmaNeural',
                    speed: this.settings.get('speechRate') || 1.0
                }).then((ok) => {
                    clearTimeout(this._ttsSafetyTimer);
                    this.ttsActive = false;
                    if (!ok) {
                        // Neural TTS failed mid-flight, fall back to SAPI
                        console.warn('NeuralTTS: failed, falling back to SAPI');
                        this._speakSAPI(clean);
                    }
                }).catch(() => {
                    clearTimeout(this._ttsSafetyTimer);
                    this.ttsActive = false;
                });
                return;
            }

            // ──────────────────────────────────────────────────────────────
            // SAPI FALLBACK: used when the neural TTS server is unavailable
            // ──────────────────────────────────────────────────────────────
            this._speakSAPI(clean);
        } catch (e) {
            console.warn('TTS unavailable:', e);
        }
    }

    /**
     * System-voice fallback. Disabled by default — see `systemVoiceFallback`.
     *
     * Reports the outage once per session instead of speaking in a different
     * voice. Going silent with no explanation would be its own bug, so the
     * text stays on screen and the reason is stated.
     */
    _systemVoiceAllowed() {
        if (!this.settings.get('systemVoiceFallback')) {
            /* Silent during startup. The TTS server is a Python process that
               takes a few seconds to spawn, so the first speech attempt of
               every launch legitimately finds it missing. Warning there told
               the user the voice was broken when it was merely not up yet —
               and because the flag latched, the message stayed on screen long
               after the voice had recovered. */
            const uptimeMs = Date.now() - (this._startedAt || Date.now());
            if (uptimeMs > TTS_STARTUP_GRACE_MS && !this._warnedNoVoice) {
                this._warnedNoVoice = true;
                console.warn('Neural TTS is unavailable and the system-voice fallback is off, '
                    + 'so replies are text-only. Enable systemVoiceFallback to use a system voice.');
                try { this.displayText('Voice server unavailable — replies are text-only.', null); }
                catch { /* display is best-effort */ }
            }
            return false;
        }
        // Enabled, but nothing acceptable installed: still never speak as David.
        return Boolean(this.selectedVoice);
    }

    /** System-voice fallback — off by default, female voices only. */
    _speakSAPI(clean) {
        if (!this._systemVoiceAllowed()) return;
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

        /* Screen mirroring. Checked BEFORE targetsPhone, because "mirror to my
           phone" and "stop mirroring to my phone" satisfy that matcher too and
           would be handed to routePhoneCommand, which has no mirror tool and
           returns null — the command would fall through to the model and be
           answered with an apology. mirrorIntent.test.mjs asserts both the
           overlap and that nothing is stolen from the phone tools. */
        const mirrorCmd = parseMirrorCommand(cmd);
        if (mirrorCmd) {
            if (mirrorCmd.action === 'stop') return { intent: 'MIRROR_STOP' };
            if (mirrorCmd.action === 'snapshot') return { intent: 'MIRROR_SNAPSHOT' };
            return { intent: 'MIRROR_START' };
        }

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
        /* Alarms and timers. Placed BEFORE the calendar reminder branch:
           "remind me in 40 minutes" matched there and resolved to 12:00,
           because parseDateTime applied the offset to the date but returned
           the default time string. Rule-based, and an unresolved time asks
           rather than guessing. */
        if (this.alarms?.isRinging && /(stop|dismiss|off|quiet|enough|okay|ok)/.test(cmd))
            return { intent: 'ALARM_DISMISS' };
        const alarmCancel = parseAlarmCancel(cmd);
        if (alarmCancel) return { intent: 'ALARM_CANCEL', all: alarmCancel.all };
        if (parseAlarmList(cmd)) return { intent: 'ALARM_LIST' };
        /* A scheduling conversation owns every turn until it finishes. Without
           this, "project review" mid-flow would be classified as a web search. */
        if (this.scheduler?.isActive) return { intent: 'SCHEDULING_TURN', text: command };

        if (/(?:start|launch|run|open).*(?:with|on|at).*(?:windows|boot|startup|login|start ?up)/.test(cmd)
            || /autostart|start automatically/.test(cmd))
            return { intent: 'AUTOSTART', enable: !/(?:don'?t|do not|stop|disable|never|no longer)/.test(cmd) };
        if (/(?:hide yourself|go to the tray|minimi[sz]e yourself|get out of the way|hide the window)/.test(cmd))
            return { intent: 'HIDE_WINDOW' };

        if (/(?:connect|link|set ?up).*calendar/.test(cmd)) return { intent: 'CALENDAR', action: 'connect' };
        if (/schedule.*(?:meeting|call|meet)|set ?up a (?:meeting|call)|book a (?:meeting|call)/.test(cmd))
            return { intent: 'CALENDAR', action: 'schedule' };
        if (/(?:create|open|start|make).*meet (?:room|space|link)|instant meet/.test(cmd))
            return { intent: 'CALENDAR', action: 'meet-room' };
        if (/next meeting|when is my (?:next )?(?:meeting|call)/.test(cmd))
            return { intent: 'CALENDAR', action: 'next' };
        if (/(?:my|any|what).*(?:meetings|schedule|calendar)|what'?s on today/.test(cmd))
            return { intent: 'CALENDAR', action: 'list' };
        if (/i know about.*meeting|ack(?:nowledge)? (?:the )?meeting/.test(cmd))
            return { intent: 'CALENDAR', action: 'acknowledge' };

        const alarmCmd = parseAlarmCommand(cmd);
        if (alarmCmd) return { intent: 'SET_ALARM', alarm: alarmCmd };

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
        /* INVESTIGATE — "investigate the goldman sachs filing", "dig into X",
           "look into the nvidia note and tell me what it says".

           Before EDGAR search and before parseInputCommand, because an
           investigation subsumes a search: it runs the search AND reads the
           document AND corroborates. Requires an explicit investigate verb, so
           an ordinary question never pays the latency. */
        {
            const m = cmd.match(/^(?:\w+\s+){0,2}(?:investigate|dig into|look into|research|do a deep dive (?:on|into)|deep dive (?:on|into))\s+(.+)/i);
            if (m) {
                const subject = m[1].replace(/\s+(?:for me|please|sir)\s*$/i, '').replace(/[?.!]+$/, '').trim();
                if (subject.length > 2) return { intent: 'INVESTIGATE', query: subject };
            }
        }

        /* EDGAR FULL-TEXT SEARCH — "search edgar for tokenized securities",
           "which companies mention stablecoin in their filings".

           MUST be checked before parseInputCommand below. That matcher turns
           any "search X" into keystrokes typed at the focused window, and it
           silently swallowed every EDGAR phrasing during development — the same
           failure already in this project's log, where "google stock price" was
           TYPED INTO A WINDOW instead of answered. Ordering is the whole fix;
           the routing tests assert both directions.

           parseEdgarQuery returns null unless there is a search lead-in AND a
           subject, so "any new sec filings" still reaches the feed brief. */
        const edgarQ = parseEdgarQuery(cmd);
        if (edgarQ) return { intent: 'EDGAR_SEARCH', ...edgarQ };

        /* PER-COMPANY FILINGS — "sec filings of google", "apple's 10-Ks",
           "what did tesla file".

           Found the same way the domain-scoped feed brief was: by routing a
           real phrasing. "sec filings of google" matched nothing above it —
           parseEdgarQuery needs a search lead-in and there is none, and the
           feed brief below needs one of its recency words, which "sec filings
           of google" also lacks. It therefore reached the MODEL, which has no
           filing data and answers about Google's filings from imagination.
           That is the exact failure the investigation pipeline was built for,
           arriving through the front door.

           Position matters in both directions and both are asserted in the
           routing tests. AFTER EDGAR_SEARCH, so "which companies mention
           stablecoin in their filings" stays a full-text search. BEFORE the
           feed brief, so "latest sec filings of google" is not swallowed by
           the "latest" + "sec filings" branch and answered with everyone
           else's filings. */
        const companyQ = edgarCompany.parseCompanyFilingsQuery(cmd);
        if (companyQ) return { intent: 'COMPANY_FILINGS', ...companyQ };

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

        /* PORTFOLIO RISK, checked before the watchlist block below. "How risky
           is my watchlist" says "watchlist", so that block claimed it and
           answered with a list of prices — a different question. The parser
           requires a risk word AND rejects add/remove wording, so "what's on my
           watchlist" and "add micron to my watchlist" still fall through. */
        const portQ = this.parsePortfolioQuery(cmd);
        if (portQ) return { intent: 'PORTFOLIO_QUERY', group: portQ.group, symbols: portQ.symbols };

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
        /* BEFORE the quant parser. "decompose Micron" and "break down the
           memory sector" both contain a metric-free entity that parseQuantQuery
           would take as a plain risk-summary request, answering a
           sector-relative question with an absolute one. */
        const sectorQ = this.parseSectorQuery(cmd);
        if (sectorQ) return { intent: 'SECTOR_QUERY', entity: sectorQ.entity };

        const quantQ = this.parseQuantQuery(cmd);
        if (quantQ) return { intent: 'QUANT_QUERY', metric: quantQ.metric, entity: quantQ.entity };

        // Live price query — "price of Tesla", "how much is Bitcoin", "AAPL stock
        // price", "what's Apple trading at". Answered from the reliable Yahoo
        // quote endpoint, NOT the web-search fallback that used to field these and
        // returned stale snippet text. Checked before news so "Tesla stock price"
        // is a quote, not a headline search.
        const priceEntity = this.parsePriceQuery(cmd);
        if (priceEntity) return { intent: 'PRICE_QUERY', entity: priceEntity };

        /* SELF-CRITIQUE — "what are you getting wrong", "where do you fail".
           Answered from the interaction log, so it reports measured failures
           rather than a modest-sounding guess. */
        if (/\b(what are you getting wrong|where do you fail|what do you get wrong|your (weak|failure)|self ?critique|how often are you wrong)\b/.test(cmd)) {
            return { intent: 'SELF_CRITIQUE' };
        }

        /* FEED BRIEF — "brief me", "what changed today", "anything new".
           Checked before the news matcher: this reads the ingested event log
           with provenance, which is a different and better answer than a fresh
           headline scrape. */
        if (/\b(brief me|briefing|what'?s changed|what changed|anything new|catch me up on (the )?feeds?|feed brief|what did i miss)\b/.test(cmd)) {
            const h = /\bweek\b/.test(cmd) ? 168 : /\bhour\b/.test(cmd) ? 1 : 24;
            return { intent: 'FEED_BRIEF', hours: h };
        }

        /* DOMAIN-SCOPED FEED QUERY — "any new sec filings", "latest filings",
           "anything new in research".

           Found by routing a live prompt: "any new sec filings" matched none of
           the phrasings above ("anything new" is not "any new") and reached the
           MODEL, which has no feed history and answers about SEC filings from
           imagination. Nine SEC feeds are ingested and none of them were
           reachable by the obvious question. Placed after the general brief so
           "anything new" keeps its existing meaning, and after EDGAR search so
           a query WITH a subject still goes to full-text search. */
        {
            const scoped = /\b(any|anything|what'?s|whats|show me|list|latest|newest|recent|new|what did)\b/.test(cmd);
            /* The enforcement wording is here because the SEC's own vocabulary
               is not "filings": litigation releases, administrative
               proceedings and trading suspensions are three separate ingested
               feeds, and asking for any of them by name reached the MODEL
               until this line existed. Found by routing the phrasings a person
               actually uses, not the ones the registry uses. */
            const domain = /\b(sec filings?|filings?|edgar|8-?ks?|10-?ks?|litigation|enforcement|administrative proceedings?|trading suspensions?|suspensions?|sec (announce|announced|press|say|said))\b/.test(cmd) ? 'finance'
                : /\b(advisor(y|ies)|vulnerabilit(y|ies)|security feeds?)\b/.test(cmd) ? 'security'
                    : /\b(papers?|preprints?|arxiv|research feeds?)\b/.test(cmd) ? 'research'
                        : null;
            if (scoped && domain) {
                const h = /\bweek\b/.test(cmd) ? 168 : /\bhour\b/.test(cmd) ? 1 : /\bmonth\b/.test(cmd) ? 720 : 24;
                return { intent: 'FEED_BRIEF', hours: h, domain };
            }
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

        /* Real web search. Must sit AFTER news and the other specialised
           handlers (they are faster and better sourced) but BEFORE dictation:
           "search about jamie diamond" was being classified TYPE_TEXT, so
           asking for a search started typing instead. Anything that reached the
           local model instead was answered with invented citations, which is
           what this exists to stop. */
        /* Filesystem authoring. Sits BEFORE web search deliberately: "write a
           quicksort in python" is search-shaped and would otherwise be sent to
           the web instead of producing a file. Rule-based (fileCommands.js) and
           returns null unless the phrasing is unambiguous, so a sentence that
           merely mentions a folder still reaches conversation. */
        const fileCmd = parseFileCommand(cmd);
        if (fileCmd) return { intent: 'FILE_COMMAND', command: fileCmd };

        const websearch = parseWebSearchQuery(cmd);
        if (websearch) return { intent: 'WEB_SEARCH', query: websearch.query };

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

        /* Windows system commands — lock, sleep, sign out, empty the bin,
           theme, do-not-disturb, disk, uptime, radio toggles.

           PLACED HERE ON PURPOSE, after REFLECT. "go to sleep and learn" is
           memory consolidation, not suspend-to-RAM, and it contains the word
           this parser matches on. The parser carries the same guard, so the
           rule holds either way — but the ordering is the first line of it.

           From the interaction log of 2 Aug 2026: "empty recycle bin" was
           answered "You've noted an empty recycle bin, Sir. Is there anything
           specific you require regarding this observation?" The parser existed
           and nothing called it. That is the same class as the alarm bug fixed
           in 606fa69 — a recognised command described instead of executed. */
        const sysCmd = parseSystemCommand(cmd);
        if (sysCmd) return { intent: 'SYSTEM_COMMAND', ...sysCmd };

        /* Foundry — build something in 3D.

           PLACED AFTER the system commands and BEFORE the file operations,
           and both sides of that matter. "create folder" is a file operation
           and contains the verb this parser matches on; the parser requires a
           3D noun as well, so it declines, but the ordering means it never has
           to be relied on alone.

           The parser is deterministic rather than semantic because building
           spawns a process and writes files — `write` blast radius, per the
           rule in capabilities.js. "how would I model a gear" is an embedding
           neighbour of "model me a gear" and must not build anything. */
        /* Globe — "show me what's happening in San Francisco".

           PLACED BEFORE FOUNDRY because "show me ..." is a display verb that
           foundryIntent also inspects; Foundry declines anything without a
           noun it owns, but the ordering means that guard is never the only
           thing standing between a map query and a 3D build.

           Deliberately narrow: it needs an explicit globe/map/happening verb
           AND a place, so "show me the model" and "what's happening with my
           build" do not fly the camera to a city. */
        /* STRIP THE TRAILING FRAMING BEFORE LOOKING FOR A PLACE.
           The extraction pattern is anchored at the end, so the LAST
           preposition wins — and in "show me bengaluru on map" that is "on",
           which captured "map" as the place name. Nominatim then resolved
           "map" to a Ministry of State Assets and the globe flew there.
           Removing "on the map" / "on the globe" first leaves the sentence the
           user actually meant; the keyword test still runs against the
           ORIGINAL text, because that trailing phrase is the very signal that
           this was a globe request. */
        const framing = /\s+\b(?:on|in|over|at)\b\s+(?:the\s+)?(?:world\s+)?(?:globe|map|earth|world)\b\s*[.?!]?$/i;
        const cmdNoFraming = cmd.replace(framing, '').trim();
        const placePattern = /\b(?:on|to|at|over|in|into|towards?)\s+(?:the\s+)?([a-z][a-z .'-]{1,40}?)\s*[.?!]?$/i;
        const globeCmd = /\b(?:show|take|fly|zoom|go|bring|point|look)\b/i.test(cmdNoFraming)
            && /\b(globe|map|earth|world|happening|going on|situation|activity|news|live)\b/i.test(cmd)
            ? placePattern.exec(cmdNoFraming)?.[1]?.trim()
            : null;
        if (globeCmd && window.jarvisGlobe) {
            return { intent: 'GLOBE_SHOW', place: globeCmd };
        }
        /* "Show me San Francisco." No preposition, no globe keyword — the
           phrasing people actually use, and the pattern above cannot match it
           without also swallowing "show me the model".

           So this branch does not guess from wording at all: it asks the
           bundled gazetteer whether the trailing words name a city it knows.
           A real place answers, "the model" and "my calendar" do not. That is
           a fact lookup rather than a heuristic, which is why it can afford to
           be this permissive. Requires a confident hit (>= 0.8) so a fuzzy
           near-miss cannot hijack an unrelated command. */
        /* Events at a place — "what events are happening in Tokyo".
           Routed to GLOBE_SHOW with a flag rather than a separate intent: the
           work is identical (fly there, mark it up) and only the spoken line
           differs. A second intent would duplicate the whole pipeline. */
        /* A ROUTE — "show me flights from Bengaluru to Tokyo".
           Checked BEFORE the single-place flight query, because "from X to Y"
           also contains "to Y" and the single-place pattern would happily
           match the destination alone and lose the origin. */
        const route = /\b(?:flights?|aircraft|planes?|flying)\b/i.test(cmd)
            ? /\bfrom\s+([a-z][a-z .'-]{1,40}?)\s+(?:to|and|towards?)\s+([a-z][a-z .'-]{1,40}?)\s*[.?!]?$/i.exec(cmdNoFraming)
            : null;
        if (route && window.jarvisGlobe) {
            return {
                intent: 'GLOBE_ROUTE',
                from: route[1].trim(),
                to: route[2].trim()
            };
        }

        /* Aircraft over a place — "what's flying over Tokyo".
           Same routing trick as events: one intent, a focus flag, and only the
           spoken line differs. */
        const flightsAt = /\b(?:flights?|aircraft|planes?|airplanes?|flying)\b/i.test(cmd)
            ? /\b(?:in|at|near|over|around|above)\s+(?:the\s+)?([a-z][a-z .'-]{1,40}?)\s*[.?!]?$/i.exec(cmdNoFraming)?.[1]?.trim()
            : null;
        if (flightsAt && window.jarvisGlobe) {
            return { intent: 'GLOBE_SHOW', place: flightsAt, focus: 'flights' };
        }

        const eventsAt = /\b(?:events?|meetups?|conferences?|hackathons?)\b/i.test(cmd)
            ? /\b(?:in|at|near|around|on)\s+(?:the\s+)?([a-z][a-z .'-]{1,40}?)\s*[.?!]?$/i.exec(cmdNoFraming)?.[1]?.trim()
            : null;
        if (eventsAt && window.jarvisGlobe) {
            return { intent: 'GLOBE_SHOW', place: eventsAt, focus: 'events' };
        }

        const bareShow = /^(?:jarvis[,\s]+)?(?:show|display|pull\s+up|bring\s+up|take\s+me\s+to|go\s+to|fly\s+to|zoom\s+(?:in\s+)?to)\s+(?:me\s+|my\s+|us\s+)?(?:jarvis[,\s]+)?(?:the\s+)?([a-z][a-z .'-]{1,40}?)(?:\s+(?:city|globe|map))?\s*[.?!]?$/i.exec(cmdNoFraming);
        if (bareShow && window.jarvisGlobe?.resolveLocal) {
            const candidate = bareShow[1].trim();
            /* WHEN THE USER SAID "ON MAP", THE GAZETTEER DOES NOT GET A VETO.
               The offline index holds cities only, so gating on it rejected
               "show me japan on map" and "show me karnataka on map" — a
               country and a state are not populated places. But that trailing
               "on map" is the user stating outright that this is a location,
               which is better evidence than a 162 KB city list. The resolver
               downstream handles every granularity; if nothing resolves it
               says so, which is the honest failure.

               Without that phrasing the gate still applies, because "show me
               the model" must not become a map query. */
            const saidMap = framing.test(cmd) || /\b(globe|map|earth|world)\b/i.test(cmd);
            const hit = window.jarvisGlobe.resolveLocal(candidate);
            if (saidMap || (hit && hit.score >= 0.8)) {
                return { intent: 'GLOBE_SHOW', place: candidate };
            }
        }
        /* Bare mode toggles. */
        if (/^(?:jarvis[,\s]+)?(?:show|open|activate|enter)\s+(?:the\s+)?(?:globe|world map|command cent(?:er|re))\b/i.test(cmd)) {
            return { intent: 'GLOBE_TOGGLE', on: true };
        }
        if (/^(?:jarvis[,\s]+)?(?:close|exit|hide|leave)\s+(?:the\s+)?(?:globe|world map|command cent(?:er|re))\b/i.test(cmd)) {
            return { intent: 'GLOBE_TOGGLE', on: false };
        }

        const foundryCmd = parseFoundryCommand(cmd);
        if (foundryCmd) {
            const intentByAction = {
                [FOUNDRY_ACTIONS.CREATE]: 'FOUNDRY_CREATE',
                [FOUNDRY_ACTIONS.SHOW]: 'FOUNDRY_SHOW',
                [FOUNDRY_ACTIONS.REFINE]: 'FOUNDRY_REFINE',
                [FOUNDRY_ACTIONS.EXPORT]: 'FOUNDRY_EXPORT',
                [FOUNDRY_ACTIONS.PRINT]: 'FOUNDRY_PRINT'
            };
            return { intent: intentByAction[foundryCmd.action], ...foundryCmd };
        }

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
                case 'MIRROR_START':
                    await this.handleMirrorStart();
                    break;
                case 'MIRROR_STOP':
                    await this.handleMirrorStop();
                    break;
                case 'MIRROR_SNAPSHOT':
                    await this.handleMirrorSnapshot();
                    break;
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
                case 'SYSTEM_COMMAND':
                    await this.handleSystemCommand(intent);
                    break;
                case 'FOUNDRY_CREATE':
                    await this.handleFoundryCreate(intent);
                    break;
                case 'FOUNDRY_SHOW':
                    await this.handleFoundryShow(intent);
                    break;
                case 'GLOBE_SHOW':
                    await this.handleGlobeShow(intent);
                    break;
                case 'GLOBE_ROUTE':
                    await this.handleGlobeRoute(intent);
                    break;
                case 'GLOBE_SATELLITES':
                    await this.handleGlobeSatellites(intent);
                    break;
                case 'GLOBE_TOGGLE':
                    await this.handleGlobeToggle(intent);
                    break;
                case 'FOUNDRY_REFINE':
                case 'FOUNDRY_EXPORT':
                case 'FOUNDRY_PRINT':
                    await this.handleFoundryUnbuilt(intent);
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
                case 'SECTOR_QUERY':
                    await this.handleSectorQuery(intent.entity);
                    break;
                case 'PORTFOLIO_QUERY':
                    await this.handlePortfolioQuery({ group: intent.group, symbols: intent.symbols });
                    break;
                case 'CHAIN_QUERY':
                    await this.handleOnchainQuery(intent);
                    break;
                case 'EDGAR_SEARCH':
                    await this.handleEdgarSearch(intent);
                    break;
                case 'COMPANY_FILINGS':
                    await this.handleCompanyFilings(intent);
                    break;
                case 'INVESTIGATE':
                    await this.handleInvestigate(intent.query);
                    break;
                case 'PRICE_QUERY':
                    await this.handlePriceQuery(intent.entity);
                    break;
                case 'NEWS_QUERY':
                    await this.handleNewsQuery(intent.topic);
                    break;
                case 'FILE_COMMAND':
                    await this.handleFileCommand(intent.command);
                    break;
                case 'WEB_SEARCH':
                    await this.handleWebSearch(intent.query);
                    break;
                case 'SELF_CRITIQUE':
                    await this.handleSelfCritique();
                    break;
                case 'FEED_BRIEF':
                    await this.handleFeedBrief(intent.hours, intent.domain);
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
                case 'SCHEDULING_TURN':
                    await this.continueScheduling(intent.text);
                    break;
                case 'AUTOSTART':
                    await this.handleAutostart(intent.enable);
                    break;
                case 'HIDE_WINDOW':
                    this.speak('Hiding, Sir. I will still be listening.');
                    await window.electronAPI.hideWindow?.();
                    break;
                case 'CALENDAR':
                    await this.handleCalendarCommand(intent.action);
                    break;
                case 'SET_ALARM':
                    await this.handleSetAlarm(intent.alarm);
                    break;
                case 'ALARM_CANCEL':
                    await this.handleAlarmCancel(intent.all);
                    break;
                case 'ALARM_LIST':
                    await this.handleAlarmList();
                    break;
                case 'ALARM_DISMISS':
                    this.alarms.dismiss();
                    this.speak('Alarm off, Sir.');
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
            //
            // `ok` and `superseded` are recorded separately. Folding them
            // together logged genuine successes as failures whenever the user
            // spoke again before the turn finished — the 31 Jul log has
            // "Opening notepad" stored with ok:false after the action had
            // already happened — which both corrupts the success rate and, via
            // reflectionService's ok!==false filter, quietly drops the turn
            // from memory consolidation.
            this._logInteraction(command, intent, _turnStartedAt, _turnOk, _buf, superseded);
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
        this.haptics.warn();
        this.memory.clearHistory();
        this.speak('Conversation history cleared');
    }

    /**
     * Windows system commands.
     *
     * Every branch speaks what actually happened, from what the IPC returned —
     * never a confirmation composed before the call. The whole reason this
     * handler exists is that "empty recycle bin" was previously answered with
     * a description of the request instead of the act.
     *
     * The destructive ones fire `warn` FIRST — pulse, pause, pulse — so the
     * feedback lands before the machine locks or the files go, not after.
     */
    async handleSystemCommand({ intent, kind, on }) {
        if (SYSTEM_INTENTS[intent]?.destructive) this.haptics.warn();
        else this.haptics.click();

        const api = window.electronAPI;
        try {
            switch (intent) {
                case 'LOCK_SCREEN':
                    await api.systemAction('lock');
                    break;   // no speech: the screen is already gone

                case 'SLEEP':
                case 'HIBERNATE':
                case 'SIGN_OUT': {
                    const word = { SLEEP: 'sleep', HIBERNATE: 'hibernate', SIGN_OUT: 'sign out' }[intent];
                    /* Spoken BEFORE the call, uniquely in this handler. These
                       end the session, so a confirmation afterwards would be
                       said to nobody — the speech synthesiser goes down with
                       everything else. */
                    this.speak(`Going to ${word} now, Sir.`);
                    await new Promise((r) => setTimeout(r, 1200));
                    await api.systemAction(
                        { SLEEP: 'sleep', HIBERNATE: 'hibernate', SIGN_OUT: 'signout' }[intent]
                    );
                    break;
                }

                case 'EMPTY_TRASH': {
                    const r = await api.emptyRecycleBin();
                    if (r?.alreadyEmpty) this.speak('The recycle bin is already empty, Sir.');
                    else if (r?.success) { this.haptics.success(); this.speak('Recycle bin emptied, Sir.'); }
                    else this.speak(`I could not empty it, Sir. ${r?.error || ''}`.trim());
                    break;
                }

                case 'DARK_MODE':
                case 'LIGHT_MODE': {
                    const mode = intent === 'DARK_MODE' ? 'dark' : 'light';
                    const r = await api.setTheme(mode);
                    this.speak(r?.success ? `Switched to ${mode} mode, Sir.`
                        : 'I could not change the theme, Sir.');
                    break;
                }

                case 'DND_ON':
                case 'DND_OFF': {
                    const on2 = intent === 'DND_ON';
                    const r = await api.setDnd(on2);
                    this.speak(r?.success
                        ? (on2 ? 'Do not disturb is on, Sir.' : 'Notifications are back on, Sir.')
                        : 'I could not change the notification setting, Sir.');
                    break;
                }

                case 'DISK_SPACE': {
                    const r = await api.diskSpace();
                    if (!r?.success || !r.disks?.length) { this.speak('I could not read the disks, Sir.'); break; }
                    /* Exact figures from the measurement, not "running low" —
                       the register asks for the number when there is one. */
                    const parts = r.disks.map((d) =>
                        `${d.drive} has ${d.freeGB} of ${d.totalGB} gigabytes free, ${d.percentFree} percent`);
                    this.speak(`${parts.join('. ')}.`);
                    this.displayText(parts.join('\n'), null);
                    /* Unprompted concern, on a threshold rather than a guess. */
                    if (r.disks.some((d) => d.percentFree <= 10)) {
                        this.haptics.attention();
                        this.speak('That is low enough to cause problems, Sir.');
                    }
                    break;
                }

                case 'UPTIME': {
                    const r = await api.systemUptime();
                    if (!r?.success) { this.speak('I could not read the uptime, Sir.'); break; }
                    const h = Math.floor(r.seconds / 3600);
                    const m = Math.floor((r.seconds % 3600) / 60);
                    this.speak(h ? `Up for ${h} hours and ${m} minutes, Sir.`
                        : `Up for ${m} minutes, Sir.`);
                    break;
                }

                case 'RADIO_TOGGLE': {
                    const label = kind === 'bluetooth' ? 'Bluetooth' : 'Wi-Fi';
                    /* SIGNATURE: radioSet takes ONE object, {kind, state}, and
                       state is the string 'on'/'off' — not two positional args
                       and not a boolean. Called wrongly it silently defaults to
                       Bluetooth On, which is a wrong radio in a wrong direction.

                       CONFIRMATION IS REQUIRED HERE BY CONVENTION. preload.js
                       states radioSet "is only called after the user answers an
                       explicit spoken confirmation", and it earns that: turning
                       Wi-Fi off drops the network, the phone bridge and the
                       companion link at once.

                       Armed through _armConfirmation, which stores a STRING
                       action and a timestamp. A first attempt assigned a
                       closure to _pendingConfirm directly and would have failed
                       silently: _consumeConfirmation reads p.at, which is
                       undefined on a function, and dispatches on p.action,
                       which would never match — the ask would be spoken and the
                       answer would do nothing. */
                    this._armConfirmation(`radio-${kind}-${on ? 'on' : 'off'}`,
                        `turn ${label} ${on ? 'on' : 'off'}`);
                    this.speak(`That will turn ${label} ${on ? 'on' : 'off'}, Sir. Shall I?`);
                    break;
                }

                default:
                    this.speak('I recognised that but have no handler for it, Sir.');
            }
        } catch (e) {
            this.haptics.error();
            this.speak(`That failed, Sir. ${e.message}`);
        }
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

        /* THE BARE FORMS, gated on the asset actually being known.
           "how is nvidia doing" and "what's MU at" are how people ask, and both
           reached the model instead: the log for 30 Jul 2026 shows the first
           answered "The context does not contain information regarding
           NVIDIA's performance" while the deterministic quote engine sat
           unused. The branches above require the word "stock" or "trading at",
           which is not how the question gets asked.
           The SYMBOL_MAP guard is what keeps this narrow — the same precedent
           as "how much is bitcoin" above. Without it, "how is my day going"
           becomes a ticker lookup. */
        const bare = cmd.match(/\bhow(?:'s| is)\s+(.+?)\s+doing\b/i)
            || cmd.match(/\bwhat(?:'s| is)\s+(.+?)\s+at\b\s*\??$/i);
        if (bare) {
            const ent = clean(bare[1]);
            if (ent && (Jarvis.SYMBOL_MAP[ent.toLowerCase()] || /^[a-z]{1,5}$/i.test(ent))) return ent;
        }
        return null;
    }

    // Parse a quant-analytics request into { metric, entity } or null. Metric is
    // one of: sharpe|sortino|volatility|drawdown|beta|return|summary. The entity
    // is spoken text (resolveSymbol maps it to a ticker on the main side).
    parseQuantQuery(cmd) {
        const clean = (s) => s && s.replace(/[?.!,]+$/, '')
            /* LEADING INTERROGATIVE. The trailing form below captures
               everything before the metric word, so "what's micron's
               volatility" handed the resolver "what's micron's" and it
               answered "I could not find enough price history for what's
               micron's." Caught in the interaction log on 30 Jul 2026, twice
               in twenty seconds. The question words are never part of a
               company name. */
            .replace(/^\s*(?:what'?s|what is|whats|how'?s|how is|show me|tell me|give me|get me|find)\s+/i, '')
            .replace(/\b(stock|shares?|the|a|please|now|right now|currently|over the (last|past) (year|month))\b/gi, '')
            /* A possessive is how people name a company before a metric —
               "micron's volatility" — and the 's is not part of the ticker. */
            .replace(/(?:'s|s')\s*$/i, '')
            .replace(/^\s*(?:of|for)\s+/i, '').replace(/\s+/g, ' ').trim();
        const METRIC = {
            sharpe: /\bsharpe\b/i, sortino: /\bsortino\b/i,
            volatility: /\b(volatility|volatile|std ?dev|standard deviation)\b/i,
            drawdown: /\b(max(imum)? )?drawdown\b/i,
            beta: /\b(beta|alpha)\b/i,
            return: /\b(annual(ized)? return|cagr|performance)\b/i,
            var: /\b(va ?r|value at risk|expected shortfall|cvar|tail risk)\b/i,
        };
        let m;
        // "<metric> of <entity>" / "<metric> for <entity>"
        if ((m = cmd.match(/\b(sharpe( ratio)?|sortino( ratio)?|volatility|beta|alpha|max(imum)? drawdown|drawdown|annual(ized)? return|cagr|value at risk|va ?r|expected shortfall|cvar|tail risk)\s+(?:of|for|on)\s+(.+)/i))) {
            const entity = clean(m[m.length - 1]);
            if (entity) return { metric: this._metricOf(m[1], METRIC), entity };
        }
        // "how risky / how volatile is <entity>"
        if ((m = cmd.match(/\bhow\s+(risky|volatile)\s+is\s+(.+)/i))) {
            const entity = clean(m[2]);
            if (entity) return { metric: m[1].toLowerCase() === 'volatile' ? 'volatility' : 'summary', entity };
        }
        /* "analyze / risk analysis of <entity>"
           ANCHORED near the start, and the entity may not begin with a
           conjunction. From the live log of 22 Jul 2026:

             "investigate what might me his future plans next move analyze and
              tell me"
               -> QUANT_QUERY entity="and tell me"
               -> "I could not find enough price history for and tell me."

           The verb was the ninth word of a sentence about something else, and
           `analyze\s+(.+)` took the rest of the line as a ticker. A real quant
           request leads with the verb; this one merely contained it. Same
           class as the watchlist stealing "watch for whales" -> "FOR". */
        if ((m = cmd.match(/^(?:\w+\s+){0,2}(?:analyz|analys)e?\s+(.+)|(?:risk|quant)\s+analysis\s+(?:of|for)\s+(.+)/i))) {
            const entity = clean(m[1] || m[2]);
            const startsWithFiller = /^(?:and|or|but|then|so|it|that|this|these|those|me|my|him|her|them|us|there|please)\b/i.test(entity || '');
            if (entity && METRIC && !startsWithFiller && !/[?]/.test(entity)) return { metric: 'summary', entity };
        }
        // trailing form: "<entity> sharpe / volatility / beta"
        if ((m = cmd.match(/^(.+?)\s+(sharpe|sortino|volatility|beta|drawdown|risk)\b/i))) {
            const entity = clean(m[1]);
            const metric = /risk/i.test(m[2]) ? 'summary' : this._metricOf(m[2], METRIC);
            if (entity) return { metric, entity };
        }
        return null;
    }

    /* Parse a peer-relative request into { entity }, or null.
       "Micron fell 9.9%" and "the sector fell 5% and Micron fell 9.9%" are
       different answers, and this is how a listener asks for the second one.

       ANCHORED, for the reason parseQuantQuery documents at length: a verb like
       "break down" or "decompose" appearing in the middle of a sentence about
       something else must not swallow the rest of the line as a ticker. */
    parseSectorQuery(cmd) {
        const clean = (s) => s && s.replace(/[?.!,]+$/, '')
            .replace(/\b(please|now|right now|currently|today|for me|stock|shares?)\b/gi, '')
            .replace(/^\s*(?:the|a|of|for|on)\s+/i, '')
            .replace(/'s\b/gi, '')
            /* "decompose micron's move" leaves "micron move", which resolves to
               no ticker at all. The motion noun is the thing being decomposed,
               never part of the name. */
            .replace(/\s+(?:move|moves|movement|drop|fall|decline|selloff|sell-off|gain|rise|performance|action)\s*$/i, '')
            .replace(/\s+/g, ' ').trim();
        const FILLER = /^(?:and|or|but|then|so|it|that|this|these|those|me|my|him|her|them|us|there)\b/i;
        const ok = (e) => e && !FILLER.test(e) && e.length <= 40 ? { entity: e } : null;
        let m;

        // "how much of X's drop is the sector" / "...is company specific"
        if ((m = cmd.match(/\bhow much of\s+(.+?)(?:'s)?\s+(?:drop|fall|decline|move|gain|rise|selloff)\s+is\s+(?:the\s+)?(?:sector|market|company|peer)/i))) {
            return ok(clean(m[1]));
        }
        // "decompose X" / "break down X" — verb within the first two words only.
        if ((m = cmd.match(/^(?:\w+\s+){0,2}(?:decompose|break\s*down)\s+(.+)/i))) {
            return ok(clean(m[1]));
        }
        // "sector move / peer analysis / relative strength of X"
        if ((m = cmd.match(/\b(?:sector (?:move|analysis|breakdown)|peer (?:analysis|comparison|relative)|relative strength)\s+(?:of|for|on|in)\s+(.+)/i))) {
            return ok(clean(m[1]));
        }
        // "is X's fall the sector or the company"
        if ((m = cmd.match(/\bis\s+(?:this|the)\s+(?:a\s+)?sector[- ]wide\b/i))) {
            return ok('memory'); // only meaningful with a group in view
        }
        // "who is outperforming in memory" / "who's holding up in memory"
        if ((m = cmd.match(/\bwho(?:'s| is|se)?\s+(?:out\s?performing|holding up|strongest|weakest)\b(?:\s+in\s+(.+))?/i))) {
            return ok(clean(m[1] || 'memory'));
        }
        return null;
    }

    /* Peer-relative decomposition. Every figure comes from sectorMove.js in the
       main process; the model narrates and computes nothing. */
    async handleSectorQuery(entity) {
        if (!window.electronAPI?.getSectorMove) {
            this.speak('Sector analysis is not available in this environment.');
            return;
        }
        this.displayText(`Decomposing ${entity}...`, null);
        let r;
        try { r = await window.electronAPI.getSectorMove({ text: entity, range: '6mo' }); }
        catch (e) { console.error('Sector move error:', e); this.speak(`I could not analyze ${entity}.`); return; }
        if (!r || !r.success) {
            this.speak(r?.error ? `I could not analyze ${entity}. ${r.error}.` : `I could not analyze ${entity}.`);
            return;
        }
        const pc = (x, dp = 1) => (x == null ? 'n/a' : `${x >= 0 ? '+' : ''}${x.toFixed(dp)}%`);

        if (r.groupWide) {
            const lines = [`${r.groupName} — move vs. peer group`, ''];
            for (const a of r.members) {
                lines.push(`${(a.symbol || '').padEnd(10)} ${pc(a.move).padStart(7)}  sector ${pc(a.sectorMove).padStart(7)}` +
                    `  β ${a.beta == null ? ' n/a' : a.beta.toFixed(2)}  own ${pc(a.idiosyncratic).padStart(7)}`);
            }
            if (r.offIndex?.length) lines.push('', `Not in the index: ${r.offIndex.join(', ')}`);
            if (r.unavailable?.length) lines.push(`No data: ${r.unavailable.map((u) => u.symbol).join(', ')}`);
            this.displayText(lines.join('\n'), null);

            const ranked = r.members.filter((a) => a.idiosyncratic != null);
            const best = ranked[0], worst = ranked[ranked.length - 1];
            let spoken = `Across ${r.groupName.toLowerCase()}, `;
            if (best && worst && best !== worst) {
                spoken += `${best.symbol} is the strongest after adjusting for the sector, ${pc(best.idiosyncratic)} beyond what its beta explains, `
                    + `and ${worst.symbol} the weakest at ${pc(worst.idiosyncratic)}.`;
            } else {
                spoken += 'I could not separate the sector from the individual names — the peer overlap was too short.';
            }
            this.speak(spoken);
            return;
        }

        const a = r.analysis;
        const lines = [
            `${r.name || a.symbol} (${a.symbol}) — vs. ${r.groupName}`,
            `Move: ${pc(a.move, 2)}   Sector: ${pc(a.sectorMove, 2)}   Beta: ${a.beta == null ? 'n/a' : a.beta.toFixed(2)}`,
            `Explained by sector: ${pc(a.explainedBySector, 2)}   Company-specific: ${pc(a.idiosyncratic, 2)}`,
            `Correlation: ${a.correlation == null ? 'n/a' : a.correlation.toFixed(2)}   Volatility: ${pc(a.volAnnualisedPct, 0)}`,
        ];
        if (a.drawdown) lines.push(`Drawdown: ${pc(a.drawdown.pct)} from its ${a.drawdown.highDate} high`);
        if (a.breadth) lines.push(`Breadth: ${a.breadth.down} of ${a.breadth.of} peers fell`);
        /* The limits are displayed, not hidden — a three-week-old listing
           produces nulls that otherwise read as a malfunction. */
        if (a.limits?.length) lines.push('', ...a.limits.map((l) => `Note: ${l}`));
        this.displayText(lines.join('\n'), null);
        this.speak(r.spoken);
    }

    /* Parse a portfolio-level request into { group } | {} , or null.
       "How risky is Micron" is a quant question about one security; "how risky
       is my watchlist" is a different question that only the covariance can
       answer, and answering the second with the first is the failure this
       intent exists to prevent. */
    parsePortfolioQuery(cmd) {
        const t = String(cmd || '');
        /* "add micron to my watchlist" is a different intent that also says
           "watchlist". Checked first so nothing below can claim it. */
        if (/\b(add|remove|delete|drop)\b/i.test(t)) return null;

        // A BOOK — a watchlist, a portfolio, or a named peer group.
        const book = /\b(my (?:watchlist|portfolio|holdings|book|positions)|the (?:watchlist|portfolio)|portfolio|watchlist)\b/i.test(t);
        const groupM = t.match(/\b(memory)\b\s*(?:sector|stocks?|complex|names?)?/i);

        /* A NAMED METHOD is itself a portfolio question. "What would risk
           parity do here" names no book and asks nothing that reads as a risk
           word on its own, so it fell through to the single-security parser
           and tried to resolve "here" as a ticker. Naming the method is enough;
           the book then defaults to the watchlist. */
        const method = /\b(risk parity|min(?:imum)?[- ]variance|max(?:imum)?[- ]sharpe|tangency|mean[- ]variance|efficient frontier)\b/i.test(t);

        /* An EXPLICIT LIST — "for MU, SNDK, WDC". Two or more separated tokens
           are required: one bare word after "for" is far more likely to be a
           company name for a single-security question than a one-stock book. */
        let symbols = null;
        const listM = t.match(/\b(?:for|of|across|on|between)\s+([a-z0-9.\-]{1,6}(?:\s*(?:,|and|&)\s*[a-z0-9.\-]{1,6}){1,19})/i);
        if (listM) {
            const parts = listM[1].split(/\s*(?:,|and|&)\s*/).map((s) => s.trim().toUpperCase()).filter(Boolean);
            if (parts.length >= 2) symbols = parts;
        }

        if (!book && !groupM && !method && !symbols) return null;

        /* Leading \b only. A trailing one cannot match an inflected word:
           /\bdiversif\b/ fails on "diversified" because the boundary needs a
           non-word character after the "f", so "how diversified is my
           portfolio" fell through to the model.
           "position" is here because "is my portfolio really just one position"
           is the diversification question asked in plain words. */
        const asksRisk = /(\brisk|\bvolatil|\bdiversif|\bconcentrat|\bcorrelat|\bexposure|\bparity|\ballocation|\bweight|\boptimi|\bvar\b|\btail|\bposition)/i.test(t);
        /* A named method or an explicit multi-symbol list IS the request; it
           does not also have to contain a risk noun. */
        if (!asksRisk && !method && !symbols) return null;

        const out = {};
        if (symbols) out.symbols = symbols;
        else if (groupM && !book) out.group = groupM[1].toLowerCase();
        return out;
    }

    /* Portfolio risk. Main fetches dated closes; every number here is computed
       by portfolio.js in this process — the model narrates only. */
    async handlePortfolioQuery(opts = {}) {
        if (!window.electronAPI?.getPortfolioSeries) {
            this.speak('Portfolio analysis is not available in this environment.');
            return;
        }
        this.displayText('Analyzing portfolio risk...', null);
        let r;
        try { r = await window.electronAPI.getPortfolioSeries({ group: opts.group, symbols: opts.symbols, range: '6mo' }); }
        catch (e) { console.error('Portfolio error:', e); this.speak('I could not analyze the portfolio.'); return; }
        if (!r || !r.success) {
            this.speak(r?.error ? `I could not analyze it. ${r.error}.` : 'I could not analyze the portfolio.');
            return;
        }

        const a = portfolio.analyzePortfolio(r.seriesBySymbol);
        if (a.error) { this.speak(`I could not analyze the portfolio. ${a.error}.`); return; }

        const pc = (x, dp = 1) => (x == null ? 'n/a' : `${(x * 100).toFixed(dp)}%`);
        const lines = [
            `Portfolio risk — ${a.symbols.length} holdings, equal weight`,
            `${a.observations} overlapping sessions (${a.from} to ${a.to})`,
            '',
            `Volatility: ${pc(a.volatility)}   Diversification ratio: ${a.diversificationRatio?.toFixed(2) ?? 'n/a'}`,
            '',
            'Risk contribution (dollar weight -> share of risk):',
            ...a.symbols.map((s, i) => `  ${s.padEnd(11)} ${pc(a.weights[i])} -> ${pc(a.riskContribution[i])}`),
        ];
        if (a.tail) {
            lines.push('', `Portfolio VaR 95%: ${pc(a.tail.var)}   Expected shortfall: ${pc(a.tail.expectedShortfall)}`);
        }
        const rp = a.alternatives?.riskParity;
        if (rp?.converged) {
            lines.push('', 'Risk parity would hold:',
                ...a.symbols.map((s, i) => `  ${s.padEnd(11)} ${pc(rp.weights[i])}`),
                `  -> volatility ${pc(rp.vol)} vs ${pc(a.volatility)} equal-weight`);
        }
        const mv = a.alternatives?.minVariance;
        if (mv) {
            lines.push('', `Minimum variance: ${a.symbols.map((s, i) => `${s} ${pc(mv.weights[i])}`).join('  ')}`
                + (mv.hasShorts ? '   [requires short positions]' : ''));
        }
        if (a.limits?.length) lines.push('', ...a.limits.map((l) => `Note: ${l}`));
        this.displayText(lines.join('\n'), null);

        /* Spoken: the gap between dollar weight and risk weight, which is the
           one thing a dollar-weighted view cannot show. */
        const top = a.concentration;
        let spoken = `Across ${a.symbols.length} holdings the portfolio's annualised volatility is ${pc(a.volatility, 0)}. `;
        if (top) {
            spoken += `${top.symbolAtMostRisk} is ${pc(top.largestWeight, 0)} of the money but ${pc(top.largestRiskShare, 0)} of the risk. `;
        }
        if (a.diversificationRatio != null && a.diversificationRatio < 1.2) {
            spoken += `The diversification ratio is only ${a.diversificationRatio.toFixed(2)}, so these holdings are behaving close to a single position. `;
        }
        if (a.tail) spoken += `One-day value at risk is ${pc(a.tail.var)} at 95 percent confidence.`;
        this.speak(spoken.trim());
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
        /* Bare "latest on X" / "any update on X" — no leading "what's". The
           harness found 50 of these falling through to the model, which then
           answered a news question from its training data. */
        if ((m = cmd.match(/^(?:the\s+)?(?:latest|any(?:thing)?\s+new|updates?)\s+(?:on|about|for|with)\s+(.+)/i)))
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
        /* R2 first: it says whether the beta and alpha above mean anything. A
           low one is grounds to disregard them, not to footnote them. */
        if (a.rSquared != null) {
            lines.push(`R²: ${num(a.rSquared)}${a.rSquared < 0.3 ? ' (low — beta and alpha are weakly determined)' : ''}`
                + (a.informationRatio != null ? `   Info ratio: ${num(a.informationRatio)}` : ''));
        }
        if (a.capture?.up != null && a.capture?.down != null) {
            lines.push(`Capture: ${num(a.capture.up * 100)}% up / ${num(a.capture.down * 100)}% down`);
        }
        /* The only figures here about tomorrow rather than the past. */
        if (a.var95) {
            lines.push(`1-day VaR 95%: ${pct(-a.var95.var)}   99%: ${pct(-a.var99?.var ?? 0)}`
                + (a.cvar95 ? `   Expected shortfall: ${pct(-a.cvar95.expectedShortfall)}` : ''));
        }
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
            case 'var':
                spoken = a.var95
                    ? `${name}'s one-day value at risk is ${pct(a.var95.var)} at 95 percent confidence, `
                      + `${pct(a.var99.var)} at 99 percent. On the days that threshold was breached, `
                      + `the average loss was ${pct(a.cvar95.expectedShortfall)}. `
                      + `That is historical simulation over ${a.var95.observations} sessions, not a normal-distribution estimate.`
                    : `I do not have enough history to estimate value at risk for ${name}.`;
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
        /* The connector alternatives below exist because requiring of|on|that|for
           after the odds-word MISSED the most natural phrasing there is:
           "what are the odds THE FED cuts rates" has no preposition at all, so
           it fell through to the model — which then invents a probability, the
           single worst failure available here. Found by routing a live prompt,
           not by reading the regex. Two additions, both narrow:
             * a determiner  ("odds the ...", "chances a ...")
             * a nearby outcome verb ("chances bitcoin HITS 200k")
           Both still require the odds-word itself, so ordinary speech that
           merely contains "the" is untouched. */
        if (/\b(prediction markets?|polymarket|kalshi)\b/i.test(text) ||
            /\b(odds|chances?|probability|likelihood)\b.*\b(of|on|that|for)\b/i.test(text) ||
            /\b(odds|chances?|probability|likelihood)\s+(?:the|a|an)\b/i.test(text) ||
            /\b(odds|chances?|probability|likelihood)\b[^.?!]{0,40}\b(will|hits?|reaches?|wins?|cuts?|beats?|passes|happens)\b/i.test(text)) {
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
            // bsc/bnb were missing — "gas on bsc" fell through to the model
            // despite BSC being one of the four chains the key verifies.
            (/\b(arbitrum|arb|ethereum|eth|mainnet|base|optimism|\bop\b|polygon|matic|bsc|bnb|binance|chain|network|l1|l2|gwei)\b/i.test(text) || /\bgas fees?\b/i.test(text))) {
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

    /* INVESTIGATE — collect, READ, corroborate, then answer.
       Built from the failure of 22 Jul 2026: the assistant held a filing title
       and invented its contents over eight turns. The document was 0.68s away.
       The contract here is that no evidence means no answer, and the model is
       called ONCE, at the end, over text that was actually fetched.

       This is deliberately the SLOW path. The 23rd pass measured gemma3:4b at
       ~3s per planning call and concluded a multi-step loop is unusable when
       spoken; so this runs only when explicitly asked, reports each stage as it
       goes, and is never reached from a bare question. */
    async handleInvestigate(query) {
        const plan = investigation.planInvestigation(query);
        if (!plan) { this.speak('What should I investigate, Sir?'); return; }

        const evidence = [];
        const trace = [];
        const note = (s) => { trace.push(s); this.displayText(`Investigating "${query}"...\n\n${trace.join('\n')}`, null); };

        // 1. MEMORY — what is already known, before spending any request.
        try {
            const { results = [] } = await ragService.recall(query, { rerank: false });
            for (const r of results.slice(0, 4)) evidence.push({ kind: 'memory', text: r.text, source: r.source });
            note(`memory: ${results.length} passage${results.length === 1 ? '' : 's'}`);
        } catch { note('memory: unavailable'); }

        // 2. SEARCH — EDGAR full text, which returns filing metadata AND the
        //    document URLs that step 3 reads.
        let hits = [];
        if (plan.steps.includes('search') && window.electronAPI?.edgarSearch) {
            const url = buildEdgarUrl({ q: plan.subject, forms: plan.forms });
            const res = url ? await window.electronAPI.edgarSearch({ url }).catch(() => null) : null;
            if (res?.success) {
                hits = parseEdgarResults(res.json, { limit: 5 }).results;
                for (const h of hits) evidence.push({ kind: 'search', text: edgarMemoryText(h) || '', url: h.url, published: h.filedAt });
                note(`edgar: ${hits.length} filing${hits.length === 1 ? '' : 's'}`);
            } else note(`edgar: ${res?.error || 'unavailable'}`);
        }

        /* 2b. FEED FALLBACK — where the document URL actually comes from in the
               case that caused all this. EDGAR full-text search returned ZERO
               hits for the Goldman 424B2 (verified 22 Jul), because full text
               does not index every form; but the feed store had the filing,
               with its URL, all along. Searching and finding nothing is not
               the same as there being nothing. */
        if (plan.steps.includes('document') && !hits.length && window.electronAPI?.feedHistory) {
            const fh = await window.electronAPI.feedHistory({ sinceMs: 7 * 24 * 3600 * 1000 }).catch(() => null);
            const terms = plan.subject.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
            const matched = (fh?.events || [])
                .filter((e) => e.url && terms.some((t) => `${e.title} ${e.summary}`.toLowerCase().includes(t)))
                .slice(0, 3);
            for (const e of matched) {
                evidence.push({ kind: 'feed', text: `${e.title}. ${e.summary || ''}`.trim(), url: e.url, published: e.published });
            }
            if (matched.length) {
                hits = matched.map((e) => ({ url: e.url, company: e.source, filedAt: e.published }));
                note(`feeds: ${matched.length} matching event${matched.length === 1 ? '' : 's'} (edgar search found none)`);
            }
        }

        /* 3. READ — the stage whose absence is the whole reason for this method.
              Only the top hit: a filing is ~76k characters and the budget is
              6k, so a second document buys nothing but latency. */
        if (plan.steps.includes('document') && hits.length && window.electronAPI?.secDocument) {
            const target = hits[0];
            const doc = await this._readSecFiling(target, query);
            if (doc.text) {
                evidence.push({
                    kind: 'document', text: doc.text,
                    url: doc.url, published: target.filedAt,
                    source: target.company, entity: target.company,
                });
                note(`document: ${doc.note} (${target.company || 'filer'})`);
            } else note(`document: ${doc.note}`);
        }

        // 4. CORROBORATE — open web, for context the filing does not carry.
        if (plan.steps.includes('web') && window.electronAPI?.webSearch) {
            // webSearch takes the query STRING, not an object — the preload
            // signature is `webSearch: (query) => invoke('web-search', query)`.
            const w = await window.electronAPI.webSearch(query).catch(() => null);
            const results = Array.isArray(w?.results) ? w.results : [];
            for (const r of results.slice(0, 3)) {
                evidence.push({ kind: 'web', text: `${r.title || ''}. ${r.snippet || ''}`.trim(), url: r.url });
            }
            note(`web: ${results.length} result${results.length === 1 ? '' : 's'}${w?.provider ? ` (${w.provider})` : ''}`);
        }

        // 5. LEDGER — dedupe, weight, and report what was actually gathered.
        let ledger = investigation.buildLedger(evidence);

        /* TEMPORAL GATEWAY (WorldReasoner, arXiv 2606.11816). That paper
           measured six agent conditions and found temporally valid retrieval to
           be the strongest driver of accuracy — 68.8% vs 58.7% without, 74.7%
           with the boundary at one day before resolution. It is also why there
           is no causal-graph layer here: their Causal Simulation condition
           scored 56.6%, below the no-retrieval baseline, and adding graphs to
           search cost 4.4 points. Retrieval timing, not reasoning machinery. */
        const scope = investigation.parseTemporalScope(query);
        if (scope.kind === 'as-of') {
            const gate = investigation.applyTemporalGate(ledger, scope);
            ledger = gate.ledger;
            if (gate.excluded.length) {
                note(`temporal: ${gate.excluded.length} item(s) published after ${scope.asOf.toISOString().slice(0, 10)} excluded as hindsight`);
            }
            if (gate.undated) note(`temporal: ${gate.undated} undated item(s) kept — age unknown`);
        }
        /* Age is computed for every investigation, not only gated ones: an
           answer that does not say when its evidence is from is asserting a
           currency it has not earned. */
        const freshness = investigation.describeFreshness(ledger, { scope });
        if (freshness.stale) note(`temporal: STALE — newest evidence is ${freshness.ageDays} days old`);

        const summary = investigation.describeLedger(ledger);
        note(`evidence: ${summary.items} items, ${summary.chars.toLocaleString()} chars${summary.hasPrimary ? ', including the primary document' : ', NO primary document'}`);

        /* 6. ANSWER — or refuse. A null prompt means nothing was gathered, and
              that is exactly the state in which the model previously invented
              eight turns of detail. It does not get called. */
        /* ENTITY-ATTRIBUTION GATE (deceptive grounding, arXiv 2607.09349).
           Reproduced on this machine 22 Jul 2026: given only a Morgan Stanley
           424B2 and asked about Goldman Sachs, the model reported Morgan
           Stanley's $700,000 principal and $950.40 estimated value as
           Goldman's — and the money guard PASSED it, correctly by its own rule,
           because every figure was genuinely in the evidence. Figure-presence
           is not entity-ownership.

           The check runs BEFORE the model, because the paper's ablation finds
           retrieval is the high-leverage lever and prompt-based anchoring works
           on some model families and not others. A gate cannot be talked
           around; an instruction can. */
        const attribution = investigation.verifyEntityAttribution(query, ledger);
        if (attribution.applies && !attribution.ok) {
            const said = investigation.describeAttributionMismatch(query, attribution);
            this.speak(said);
            this.displayText(`${said}\n\n--- what was actually retrieved ---\n${investigation.renderEvidence(ledger)}`, null);
            console.warn('Investigation refused on entity attribution:', JSON.stringify(attribution));
            return;
        }

        const prompt = investigation.buildSynthesisPrompt(query, ledger, { freshness });
        if (!prompt) {
            this.speak('I found no evidence I could verify, Sir, so I have nothing to report rather than a guess.');
            return;
        }

        const answer = await generateContentLocal(
            [{ role: 'system', content: prompt }, { role: 'user', content: query }], null, {}
        ).catch((e) => ({ error: e.message }));

        if (!answer || answer.error) {
            this.speak(`The analysis step failed, Sir: ${answer?.error || 'no response'}. The evidence is on screen.`);
            return;
        }

        /* The guard runs over the evidence that was actually gathered, so any
           figure the model adds to it is caught — the money class exists
           because of this exact investigation. */
        const grounded = guardOutput(String(answer), investigation.renderEvidence(ledger));
        /* The staleness rule is also in the prompt, but a 4B model drops
           instructions under load and the log shows it doing so. Prepending the
           caveat here makes it unconditional: the age of the evidence is stated
           whether or not the model chose to. */
        const body = grounded.blocked ? grounded.text : String(answer);
        const said = freshness.stale ? `${freshness.note} ${body}` : body;
        this.speak(said);
        this.displayText(
            `${said}\n\n--- evidence (${summary.items} items) ---\n${investigation.renderEvidence(ledger)}`,
            null);

        if (grounded.blocked) {
            console.warn('Investigation answer blocked:', grounded.found.map(f => `${f.kind}=${f.value}`).join(', '));
        }
    }

    /* READ ONE SEC FILING — resolve an index page to the primary document,
       fetch it, and reduce it to the query-relevant passages.

       Extracted from handleInvestigate so both callers share ONE implementation.
       Two copies of this would drift, and the specific thing that would drift is
       the index-resolution step: a feed event links the filing INDEX, not the
       filing, and fetching that yields ~11KB of table markup that reads like a
       document and contains none of the filing's prose. That trap is the reason
       the whole investigation pipeline exists.

       @returns {{text?: string, url?: string, note: string}}
    */
    async _readSecFiling(filing, query) {
        if (!window.electronAPI?.secDocument) return { note: 'sec-document unavailable' };
        let docUrl = filing?.indexUrl || filing?.url;
        if (!docUrl) return { note: 'no url on this filing' };

        if (/-index\.html?$/i.test(docUrl)) {
            const dir = docUrl.replace(/\/[^/]*$/, '');
            const listing = await window.electronAPI.secDocument({ url: `${dir}/index.json` }).catch(() => null);
            if (listing?.success) {
                let items = [];
                try { items = JSON.parse(listing.body)?.directory?.item || []; } catch { /* fall through */ }
                const primary = investigation.pickPrimaryDocument(items, { accession: filing.accession || '' });
                if (primary) docUrl = `${dir}/${primary}`;
            }
        }

        const doc = await window.electronAPI.secDocument({ url: docUrl }).catch((e) => ({ success: false, error: e.message }));
        if (!doc?.success) {
            /* A real 10-K can exceed the fetch ceiling — the Alphabet 10-K is
               15MB per its own feed entry. Saying so is the honest outcome; a
               silent failure here reads as "the filing said nothing". */
            return { note: `could not read: ${doc?.error || 'no response'}` };
        }

        const text = investigation.extractDocumentText(doc.body);

        /* SECTION-AWARE RETRIEVAL, before any sentence scoring.
           Measured on Alphabet's real 10-Q: selecting sentences from the whole
           198,885-character document for the query "as cc filings of google"
           returned the trademark notice and the 1998 incorporation history,
           with no financial figure in it. Narrowing to named sections first
           returns the disaggregated revenue table and the Wiz acquisition note.
           Same selector, same query, same document — the only change is that it
           is no longer asked to search the boilerplate. */
        const sections = secSections.parseSections(text);
        const plan = secSections.planSectionRetrieval(sections, query, { maxChars: 6000 });
        /* `parts` is the section list AFTER hierarchical descent — a section
           that fits is used whole, one that does not is narrowed to its
           topic-matching subsections. MD&A alone is 12,794 tokens against this
           model's 4,096-token window. */
        const scope = plan.parts.length
            ? plan.parts.map((p) => p.text).join('\n\n')
            : text;                                  // unparseable filing: fall back whole
        const selected = ragService.selectRelevant(scope, query, { maxChars: 6000 });

        const cov = secSections.coverage(sections, plan.topics);
        return {
            text: selected,
            url: doc.url,
            sections: plan.sections,
            /* Missing sections are named. "I could not find the section that
               would answer this" is a useful thing to know and is invisible if
               only the retrieved text is reported. */
            missing: cov.missing,
            note: `read ${doc.bytes.toLocaleString()} bytes in ${doc.ms}ms; `
                + `${sections.length} sections, ${plan.reason}; `
                + `-> ${secSections.describeSections(plan.sections)}; ${selected.length} chars selected`
                + (cov.missing.length ? `; NO SECTION FOUND for: ${cov.missing.join(', ')}` : ''),
        };
    }

    /* PER-COMPANY FILINGS — "sec filings of google".
       Feed first, then memory, then the model. In that order, and the order is
       the whole design:

         1. RESOLVE the spoken name to a CIK from the SEC's own ticker map.
         2. READ the company's EDGAR filings feed. This is the RSS side, and it
            is where every fact in the answer comes from.
         3. INGEST each filing into long-term memory with its date, form and
            accession, so the next question about this company is answerable
            without another request — and so an ordinary follow-up, which goes
            through processAICommand, retrieves them via RAG automatically.
         4. ANSWER from the feed deterministically, THEN let the model talk
            about that evidence and nothing else.

       Step 4 is split in two on purpose. The counts and dates are spoken from
       the parsed feed with no model in the path, exactly as handleEdgarSearch
       does; the model only ever sees an evidence ledger it must cite. The log
       of 22 Jul 2026 is what this buys: asked about SEC filings with only
       titles in context, the model invented a Goldman compensation structure
       ending at "$8.5 billion". Here it cannot, because the gate in front of
       it is the same one handleInvestigate uses. */
    async handleCompanyFilings({ name, forms = [], raw = '' }) {
        if (!window.electronAPI?.secCompanyFeed || !window.electronAPI?.secTickers) {
            this.speak('EDGAR company filings are not available in this environment, Sir.');
            return;
        }

        this.displayText(`Looking up SEC filings for "${name}"...`, null);

        /* 1. RESOLVE. The ticker map is the only source: EDGAR's own
              company-name search answers "google" with CapitalG GP LLC, which
              is Alphabet's venture fund and not the filer anyone means. */
        const tick = await window.electronAPI.secTickers().catch((e) => ({ success: false, error: e.message }));
        if (!tick?.success) {
            this.speak(`I could not load the SEC company list, Sir: ${tick?.error || 'no response'}.`);
            return;
        }
        const matches = edgarCompany.resolveCompany(name, tick.rows);
        if (!matches.length) {
            /* Deliberately not a guess. A fuzzy resolver answers "openai" with
               Opendoor Technologies — a real company, confidently wrong. Saying
               nothing matched is the correct answer for a private company. */
            this.speak(`I have no filer matching "${name}" in the SEC company list, Sir. `
                + 'That usually means it is private, or files under a different name.');
            return;
        }

        const company = matches[0];
        const alsoMatched = matches.slice(1, 3).map((m) => m.title);

        /* 2. THE FEED. EDGAR takes one form type, so a multi-form question is
              narrowed to the first and the rest is said out loud rather than
              silently dropped. */
        const form = forms[0] || '';
        const res = await window.electronAPI.secCompanyFeed({ cik: company.cik, type: form, count: 40 })
            .catch((e) => ({ success: false, error: e.message }));
        if (!res?.success) {
            this.speak(`I could not reach the EDGAR filings feed for ${company.title}, Sir: ${res?.error || 'no response'}.`);
            return;
        }

        const parsed = edgarCompany.parseCompanyFeed(res.xml, { limit: 20 });
        if (!parsed.ok) {
            /* An unknown CIK comes back as HTTP 200 with an HTML page. Reporting
               that as "no filings" would be a false statement about a real
               company, so the two cases are kept apart. */
            this.speak(`EDGAR did not return a filings feed for ${company.title}, Sir — ${parsed.error}.`);
            return;
        }

        const filed = parsed.filings;
        const entity = parsed.company || company.title;

        /* 3. INGEST. Every line carries the filer, the form, the date, the
              accession number and the index URL, so a later answer built on it
              can be checked. Failures here never affect the answer: the feed is
              already parsed and memory is a side effect. */
        let ingested = 0;
        try {
            for (const f of filed) {
                const text = edgarCompany.toMemoryText(entity, f);
                if (!text) continue;
                await ragService.ingest(text, { source: 'sec-company-feed' });
                ingested++;
            }
        } catch (e) { console.warn('Company filing ingest failed (answer unaffected):', e); }

        /* 4a. THE DETERMINISTIC ANSWER. No model in this path.
              Spoken from the MATERIALITY-ranked list, not the raw feed order:
              "most recent: 4, S-8, 10-Q" led with an insider transaction and
              buried the quarterly report, which is the one filing the question
              was actually about. */
        const { ranked, suppressed, counts } = edgarCompany.rankFilings(filed);
        const alsoFiled = edgarCompany.describeSuppressed(suppressed, counts);
        const said = edgarCompany.describeFilings(entity, ranked, { forms: form ? [form] : [], total: filed.length });
        const caveats = [];
        /* WHAT ACTUALLY HAPPENED, in the SEC's own words and with no model in
           the path. An 8-K's item codes name the event from a closed regulatory
           vocabulary — a departure, an acquisition, a restatement, an earnings
           release — so this is the one part of "what changed today" that can be
           answered without any possibility of invention. It leads the caveats
           because it is the answer, not a footnote to it. */
        const events = edgarCompany.describeEvents(entity, filed);
        if (events) caveats.push(events);
        if (alsoFiled) caveats.push(alsoFiled);
        if (forms.length > 1) caveats.push(`I narrowed that to ${form}; you also asked for ${forms.slice(1).join(', ')}.`);
        /* EDGAR prefix-matches the form, so a 10-K request returns 10-K/A too.
           An amendment presented as the original is a real misreading, and the
           feed tells us when one is present — so say it. */
        if (form && filed.some((f) => f.form && f.form !== form)) {
            const extra = [...new Set(filed.map((f) => f.form).filter((x) => x && x !== form))];
            caveats.push(`EDGAR matches ${form} by prefix, so ${extra.join(' and ')} ${extra.length === 1 ? 'is' : 'are'} included.`);
        }
        if (alsoMatched.length) caveats.push(`Other filers also matched that name: ${alsoMatched.join(', ')}.`);

        this.speak([said, ...caveats].join(' '));
        this.displayText([
            said,
            ...caveats,
            '',
            `--- ${filed.length} filing${filed.length === 1 ? '' : 's'} from EDGAR (CIK ${parsed.cik || company.cik}${parsed.sic ? `, ${parsed.sic}` : ''}), most material first ---`,
            ...ranked.map((f) => `${(f.filedAt || 'undated').padEnd(12)} ${(f.form || '?').padEnd(10)} ${f.formName || ''}\n    ${f.indexUrl || ''}`),
            ...(suppressed.length ? ['', `--- ${suppressed.length} routine filing(s) not detailed ---`,
                ...suppressed.map((f) => `${(f.filedAt || 'undated').padEnd(12)} ${(f.form || '?').padEnd(10)}`)] : []),
            '',
            `${ingested} filing${ingested === 1 ? '' : 's'} added to long-term memory — ask me about ${entity} and I will answer from these.`,
        ].join('\n'), null);

        if (!filed.length) return;      // nothing to discuss; no model call

        /* 4b. THE LEDGER, built from the materiality-ranked list computed above.
               The live run of 24 Jul 2026 fed twenty filings to gemma3:4b in
               reverse-chronological order — fifteen of them Form 4s — and the
               answer never mentioned the 10-Q at all. See rankFilings() for the
               SEFD and Fin-RATE measurements this ordering comes from. */
        const evidence = ranked.map((f) => ({
            kind: 'feed',
            /* The SEC's own purpose line rides along with each filing. The
               model invented its own description of Form 144 ("a company
               intends to sell a significant block of its own stock ... potential
               dilution" — wrong on both counts) when nothing authoritative was
               in front of it. */
            text: [edgarCompany.toMemoryText(entity, f), edgarCompany.formPurpose(f.form)]
                .filter(Boolean).join(' Form purpose: ') + '.',
            url: f.indexUrl,
            published: f.filedAt,
            source: 'SEC EDGAR',
            entity,
        }));

        /* 4c. READ THE TOP FILING. The stage whose absence produced the worst
               fabrication in this project's log, and the one Fin-RATE measures
               as the dominant bottleneck: "the retriever's failure to surface
               essential evidence, not deficiencies in generation."

               Bounded deliberately. ONE document, only when the top-ranked
               filing is genuinely material (a periodic or event report, not an
               S-8 or a Form 4), because this is the slow step and the voice
               path cannot afford it on every question. */
        const question = raw || `What has ${entity} filed with the SEC recently?`;

        const target = ranked[0];
        if (target && edgarCompany.formMateriality(target.form) >= 70 && window.electronAPI?.secDocument) {
            this.displayText(`${said}\n\nReading the ${target.form} filed ${target.filedAt}...`, null);
            const doc = await this._readSecFiling(target, question);
            if (doc?.text) {
                evidence.unshift({
                    kind: 'document', text: doc.text, url: doc.url,
                    published: target.filedAt, source: entity, entity,
                });
            }
            if (doc?.note) console.info('Company filings document read:', doc.note);
        }

        const ledger = investigation.buildLedger(evidence);
        const scope = investigation.parseTemporalScope(question);
        const freshness = investigation.describeFreshness(ledger, { scope });

        const prompt = investigation.buildSynthesisPrompt(question, ledger, { freshness });
        if (!prompt) return;

        const answer = await generateContentLocal(
            [{ role: 'system', content: prompt }, { role: 'user', content: question }], null, {}
        ).catch((e) => ({ error: e.message }));
        if (!answer || answer.error) return;    // the filing list is already on screen

        /* The guard runs over the ledger, so any figure the model adds to a set
           of filing titles is caught. This is the highest-risk sentence in the
           whole path: a form type and a date invite a confident summary of
           contents that were never fetched. */
        const grounded = guardOutput(String(answer), investigation.renderEvidence(ledger));
        const body = grounded.blocked ? grounded.text : String(answer);
        const withAge = freshness.stale ? `${freshness.note} ${body}` : body;

        this.speak(withAge);
        this.displayText(`${said}\n\n${withAge}\n\n--- evidence (${ledger.length} filings) ---\n${investigation.renderEvidence(ledger)}`, null);
        if (grounded.blocked) {
            console.warn('Company filings answer blocked:', grounded.found.map((f) => `${f.kind}=${f.value}`).join(', '));
        }
    }

    /* EDGAR FULL-TEXT SEARCH — the pull side of the SEC data already arriving
       by feed. The feeds say what was filed most recently; this answers "which
       companies have said X", across the whole full-text index (2001 onward).

       Every number and name spoken here comes out of the SEC's response. The
       model is not in this path at all, which is the point: it is the same
       contract as the quant and on-chain engines, for the same reason — a
       plausible-sounding filing that does not exist is worse than no answer. */
    async handleEdgarSearch({ term, forms = [], recent = false }) {
        if (!window.electronAPI?.edgarSearch) {
            this.speak('EDGAR search is not available in this environment, Sir.');
            return;
        }

        /* Recency is resolved HERE because this is where a clock exists; the
           parser stays pure. One year back, which is what "recently" means for
           filings that arrive quarterly. */
        let startdt = null, enddt = null;
        if (recent) {
            const now = new Date();
            enddt = now.toISOString().slice(0, 10);
            startdt = new Date(now.getTime() - 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);
        }

        const url = buildEdgarUrl({ q: term, forms, startdt, enddt });
        if (!url) { this.speak('I did not catch what to search EDGAR for, Sir.'); return; }

        this.displayText(`Searching EDGAR full text for "${term}"${forms.length ? ` in ${forms.join(', ')}` : ''}...`, null);
        const res = await window.electronAPI.edgarSearch({ url }).catch((e) => ({ success: false, error: e.message }));
        if (!res?.success) {
            // Named failure, never a silent fallback to the model.
            this.speak(`I could not reach EDGAR, Sir: ${res?.error || 'no response'}.`);
            return;
        }

        const parsed = parseEdgarResults(res.json, { limit: 10 });
        const said = describeEdgarResults(term, parsed);
        this.speak(said);
        this.displayText(
            `${said}\n\n` + parsed.results.map((r, i) =>
                `${i + 1}. ${r.company || 'CIK ' + r.cik}${r.ticker ? ` (${r.ticker})` : ''} — ${r.form || ''} ${r.filedAt || ''}`
                + `${r.items?.length ? ` [items ${r.items.join(', ')}]` : ''}\n   ${r.url || ''}`).join('\n'),
            null);

        /* Results go into long-term memory with their own provenance, so a
           later question can be answered from what was actually found rather
           than from a second live search. Best-effort: a memory failure must
           never lose the answer that was already spoken. */
        try {
            for (const r of parsed.results.slice(0, 5)) {
                const text = edgarMemoryText(r);
                if (text) await ragService.ingest(text, { source: 'sec-edgar-search' });
            }
        } catch (e) { console.warn('EDGAR result ingest failed (answer already given):', e); }
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
        /* "what's happening" must be about THIS MACHINE to mean a system
           report. Caught by the 1000-prompt harness: "what's happening with
           nvidia" returned CPU and RAM statistics — 46 finance questions
           answered with telemetry. A bare "what's happening with X" is a news
           query about X, so the machine words are now required. */
        if (/\b(system (activity|status|overview|report)|how('s| is) my (pc|computer|laptop|machine|system))\b/.test(t)
            || (/\bwhat(?:'s| is) (happening|going on)\b/.test(t)
                && (/\b(on|with|in) (my |this )?(pc|computer|laptop|machine|system|here)\b/.test(t) || /^what(?:'s| is) (happening|going on)\??$/.test(t.trim())))) {
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

        /* Radio toggles armed by SYSTEM_COMMAND. Both directions and both
           radios, and like the branch above it reports what the radio actually
           reads afterwards rather than what was requested — `applied` is the
           radio's own answer, and a request that did not take is not a
           success. */
        const radio = p.action.match(/^radio-(bluetooth|wifi)-(on|off)$/);
        if (radio) {
            const [, kind, state] = radio;
            const label = kind === 'bluetooth' ? 'Bluetooth' : 'Wi-Fi';
            this.displayText(`Switching ${label} ${state}...`, null);
            const r = await window.electronAPI.radioSet({ kind, state });
            if (r?.success && r.applied) {
                this.haptics?.success();
                this.speak(`${label} is ${state}, Sir.`);
            } else {
                this.haptics?.error();
                this.speak(`I could not switch ${label} ${state}, Sir. ${r?.error || `the radio still reads ${r?.state || 'unknown'}`}.`);
            }
            return true;
        }
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

    /**
     * Web search.
     *
     * Modelled on handleNewsQuery rather than on the AI_COMMAND path, and that
     * is the whole speed story: news returns in 542-1188ms because it fetches
     * and reads out, while the old search route ran retrieval plus local
     * generation and measured 31-51s. Results are spoken as titles and sources
     * only — nothing is passed to the model to summarise, because a model
     * summarising search results is how the fabricated citations got in.
     */
    /**
     * Spoken file and folder authoring.
     *
     * The command has already been parsed by rules (fileCommands.js) — the
     * filename, the location and the language are all fixed before we get
     * here. This method only carries them out, and for `write-code` asks the
     * local model for the file CONTENTS.
     *
     * Every path goes through the main process's validatePath, so the worst a
     * misheard command can do is create a badly-named file in one of the
     * user's own folders.
     */
    async handleFileCommand(command) {
        const api = window.electronAPI;
        if (!api?.fileOperation) {
            this.speak('File operations are not available in this environment.');
            return;
        }

        const root = await this._resolveLocation(command.location);
        if (!root) {
            this.speak(`I could not find your ${command.location} folder, Sir.`);
            return;
        }

        try {
            if (command.kind === 'create-folder') {
                const res = await api.fileOperation('create-folder', this._join(root, command.name));
                if (!res?.success) throw new Error(res?.error || 'Could not create the folder.');
                this.displayText(`Created ${command.name} in ${command.location}.`, null);
                this.speak(`Created the folder ${command.name} on your ${command.location}.`);
                return;
            }

            if (command.kind === 'create-file') {
                const res = await api.fileOperation(
                    'write-file', this._join(root, command.name), command.content ?? ''
                );
                if (res?.code === 'EEXIST') {
                    // Never silently overwrite something the user already has.
                    this.speak(`${command.name} already exists on your ${command.location}. I have not touched it.`);
                    return;
                }
                if (!res?.success) throw new Error(res?.error || 'Could not create the file.');
                this.displayText(`Created ${command.name} in ${command.location}.`, null);
                this.speak(`Created ${command.name} on your ${command.location}.`);
                return;
            }

            if (command.kind === 'write-code') {
                await this._writeCodeFile(command, root);
            }
        } catch (e) {
            console.error('File command failed:', e);
            this.speak(`I could not do that, Sir. ${e.message}`);
        }
    }

    _join(dir, name) {
        return `${String(dir).replace(/[\\/]+$/, '')}\\${name}`;
    }

    /**
     * Absolute path for a spoken location.
     *
     * Probed, not hardcoded. Windows redirects Desktop/Documents/Pictures under
     * OneDrive when it is enabled, and a guess-map that assumes one layout is
     * exactly the kind of thing that works on the author's machine and nowhere
     * else. The probe asks the filesystem which one exists.
     */
    async _resolveLocation(location) {
        this._locationCache = this._locationCache || {};
        if (this._locationCache[location]) return this._locationCache[location];

        const info = await window.electronAPI.getOsInfo?.().catch(() => null);
        const home = info?.homedir;
        if (!home) return null;

        const candidates = {
            desktop: [`${home}\\OneDrive\\Desktop`, `${home}\\Desktop`],
            documents: [`${home}\\OneDrive\\Documents`, `${home}\\Documents`],
            pictures: [`${home}\\OneDrive\\Pictures`, `${home}\\Pictures`],
            downloads: [`${home}\\Downloads`],
            videos: [`${home}\\Videos`],
            music: [`${home}\\Music`],
        }[location];
        if (!candidates) return null;

        for (const dir of candidates) {
            const probe = await window.electronAPI.fileOperation('list-files', dir).catch(() => null);
            if (probe?.success) {
                this._locationCache[location] = dir;
                return dir;
            }
        }
        return null;
    }

    /** Ask the local model for a file's contents, then write and open it. */
    async _writeCodeFile(command, root) {
        const filename = command.name || inferCodeFilename(command.prompt, command.language);
        const target = this._join(root, filename);

        this.displayText(`Writing ${filename}...`, null);
        this.speak(`Writing ${command.prompt} in ${command.language.label}.`);

        // The model writes ONLY the file body. It does not choose the filename,
        // the directory, or whether to write at all — the rules decided those
        // before this ran, which is what keeps a misheard word from becoming a
        // file in an unexpected place.
        const stem = filename.replace(/\.[^.]+$/, '');
        const instructions = [
            `You are writing the complete contents of one ${command.language.label} source file.`,
            'Output ONLY code. No markdown fences, no commentary before or after.',
            command.language.ext === 'java' || command.language.ext === 'cs'
                ? `The public class MUST be named ${stem} so the file compiles.`
                : '',
            'Start with a one-line comment saying what it does. Make it runnable as written.',
        ].filter(Boolean).join(' ');

        let code = '';
        try {
            code = await generateContentLocal(
                [{ role: 'user', parts: [{ text: `${instructions}\n\nWrite: ${command.prompt}` }] }],
                null,
                { temperature: 0.2 }
            );
        } catch (e) {
            console.error('Local model failed while writing code:', e);
            this.speak('The local model is not responding, so I have not created the file.');
            return;
        }

        code = this._stripCodeFences(code);
        if (!code.trim()) {
            // Creating an empty file and announcing success would be a lie.
            this.speak('The model returned nothing, so I have not created the file.');
            return;
        }

        const res = await window.electronAPI.fileOperation('write-file', target, code);
        if (res?.code === 'EEXIST') {
            this.speak(`${filename} already exists on your ${command.location}. I have not overwritten it.`);
            return;
        }
        if (!res?.success) {
            this.speak(`I could not write the file, Sir. ${res?.error || ''}`);
            return;
        }

        this.displayText(`Wrote ${filename} to ${command.location}.`, null);

        if (command.openIn) {
            const opened = await window.electronAPI.openEditor?.(target, command.openIn);
            if (opened?.success) {
                const where = opened.editor === 'vscode' ? 'VS Code' : opened.editor;
                this.speak(`${filename} is written and open in ${where}.`);
            } else {
                this.speak(`${filename} is on your ${command.location}, but I could not open the editor.`);
            }
            return;
        }
        this.speak(`Written to your ${command.location} as ${filename}.`);
    }

    /**
     * Strip markdown fences the model adds despite being told not to.
     *
     * Instructing a model is not the same as it complying, and a fence on line
     * one makes the file fail to compile. Measured, not assumed: Gemma emits
     * them for code requests most of the time.
     */
    _stripCodeFences(text) {
        let out = String(text || '').trim();
        const FENCE = String.fromCharCode(96, 96, 96);
        if (!out.startsWith(FENCE)) return out;

        const firstNewline = out.indexOf('\n');
        if (firstNewline === -1) return '';
        out = out.slice(firstNewline + 1);

        const closing = out.lastIndexOf(FENCE);
        if (closing !== -1) out = out.slice(0, closing);
        return out.trim();
    }

    async handleWebSearch(query) {
        if (!window.electronAPI?.webSearch) {
            this.speak('Web search is not available in this environment.');
            return;
        }
        this.displayText(`Searching the web for ${query}...`, null);

        let res;
        try {
            res = await window.electronAPI.webSearch({ query, limit: 6 });
        } catch (e) {
            console.error('Web search error:', e);
            this.speak(`I could not run that search, Sir.`);
            return;
        }

        if (!res || !res.success || !res.results?.length) {
            /* Say so plainly. The failure mode being replaced is a confident
               invented answer, so an honest miss is the improvement. */
            this.speak(`I could not find any results for ${query}, Sir.`);
            if (res?.error) console.warn('Web search failed:', res.error);
            return;
        }

        /* The correction is always SHOWN, but only SPOKEN when it changes the
           subject. Reading "showing results for situational awareness" aloud
           after the user said "situtational awareness" is noise — they know
           what they meant, and hearing it every time trains them to ignore it.
           An entity fix is different: "jamie diamond" becoming Jamie Dimon is a
           different person, and answering about someone else without saying so
           is indistinguishable from being wrong. */
        const searched = res.correction?.corrected || query;
        if (res.correction?.kind === 'entity') {
            this.speak(`I took that as ${searched}.`);
        }

        this.displayText(formatForDisplay(res.results, searched, {
            provider: res.cached ? `${res.provider}, cached` : res.provider,
            answer: res.answer,
            correction: res.correction ? query : null,
        }), null);
        this.speak(summarizeForSpeech(res.results, searched, { answer: res.answer }));

        /* Feed the results to RAG so a follow-up question ("what did the first
           one say?") has real retrieved text to work from.

           NOT awaited, and batched into ONE ingest. This was six sequential
           awaited ingests, each costing an embedding round trip, and it ran
           AFTER the answer had already been spoken — so the user heard the
           reply at 1.9s while the turn stayed open for 32s, holding the
           microphone gate and blocking the follow-up question that indexing
           exists to support. Indexing is a background side effect of answering,
           never part of it. */
        const indexable = res.results
            .map((r) => `${r.title}. ${r.snippet || ''}`.trim())
            .filter(Boolean)
            .join('\n\n');
        if (indexable) {
            ragService.ingest(indexable, { source: 'web-search', url: res.results[0]?.url })
                .catch((e) => console.warn('Web search: could not index results', e.message));
        }
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

    /* Where the ROUTER is wrong on real traffic. The 1000-prompt harness scores
       prompts I wrote; this scores what actually happened in front of the user,
       which is the only set neither of us can bias. Nothing here changes a
       weight — it ranks what to fix next by evidence. */
    async handleSelfCritique() {
        if (!window.electronAPI?.getInteractions) { this.speak('The interaction log is not available here, Sir.'); return; }
        const r = await window.electronAPI.getInteractions({ sinceTs: 0 }).catch(() => null);
        const turns = r?.interactions || r?.rows || [];
        if (!turns.length) { this.speak('I have no interaction history to learn from yet, Sir.'); return; }

        const a = feedback.analyze(turns);
        const missed = feedback.rankFallbacks(a.fallbacks);
        const lines = [`Self-critique over ${a.total} recorded turns`, ''];
        if (missed.length) {
            lines.push('QUESTIONS THAT REACHED THE MODEL BUT HAVE A HANDLER');
            for (const g of missed) {
                lines.push(`  ${String(g.count).padStart(3)}  ${g.handler.padEnd(11)} ${Math.round(g.wastedMs / 1000)}s of model time`);
                for (const ex of g.examples) lines.push(`         "${ex.slice(0, 72)}"`);
            }
            lines.push('');
        }
        lines.push(`rephrased: ${a.rephrases.length}    corrected: ${a.corrections.length}`);
        if (a.worstIntents.length) {
            lines.push('', 'WEAKEST PATHS');
            for (const w of a.worstIntents.slice(0, 6)) {
                lines.push(`  ${w.intent.padEnd(16)} ${Math.round(w.failRate * 100)}% of ${w.turns} turns`);
            }
        }
        /* The log spans fixes: a question that missed a handler in the morning
           may route correctly now. Said out loud so the list is not mistaken
           for a list of CURRENT bugs. */
        lines.push('', 'Note: this log spans past fixes — some entries are already resolved.');
        this.displayText(lines.join('\n'), null);
        this.speak(feedback.describeFailures(a) + ' Some of those are already fixed; the log goes back further than the fixes do.');
        this._lastFactual = { text: lines.join('\n'), at: Date.now() };
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
    /**
     * Set an alarm or a timer.
     *
     * The parser has already resolved the instant. If it could not, `at` is
     * null and we say so — an assistant that answers "alarm set" without
     * having set one is the failure mode this whole path exists to avoid.
     */
    /**
     * Google Calendar. Connect, list, schedule, and stay aware of meetings.
     *
     * The scheduler is a state machine — once it is active, every utterance
     * goes to it until the meeting is created or cancelled. See
     * meetingScheduler.js for why the model does not decide any field that
     * lands in the calendar.
     */
    /** Turn "start when I sign in" on or off by voice. */
    async handleAutostart(enable) {
        const api = window.electronAPI;
        if (!api?.autostartSet) {
            this.speak('That is not available in this environment, Sir.');
            return;
        }
        const res = await api.autostartSet(enable);
        if (!res.ok) {
            // Never claim it worked. In a development run there is no
            // installed executable to register, and a confident "done" would
            // be discovered as false only at the next reboot.
            this.speak(`I could not change that, Sir. ${res.reason || ''}`);
            return;
        }
        this.speak(res.enabled
            ? 'I will start with your machine, Sir, and wait in the tray.'
            : 'I will no longer start on its own, Sir.');
    }

    async handleCalendarCommand(action, payload) {
        const api = window.electronAPI;
        if (!api?.gcalStatus) {
            this.speak('Calendar access is not available in this environment.');
            return;
        }

        const status = await api.gcalStatus();

        if (action === 'connect') {
            if (!status.configured) {
                this.speak('Google credentials are not set up yet, Sir. See the calendar section of the readme.');
                return;
            }
            if (status.connected) {
                this.speak('Your calendar is already connected, Sir.');
                return;
            }
            this.displayText('Opening Google sign-in in your browser...', null);
            const res = await api.gcalConnect();
            this.speak(res.connected
                ? 'Connected to your calendar, Sir.'
                : `I could not connect, Sir. ${res.error || ''}`);
            if (res.connected) this.startMeetingMonitor();
            return;
        }

        if (!status.connected) {
            this.speak('Your calendar is not connected, Sir. Say "connect my calendar" to set it up.');
            return;
        }

        if (action === 'list') return this._listMeetings();
        if (action === 'schedule') return this._beginScheduling();
        if (action === 'next') return this._nextMeeting();
        if (action === 'acknowledge') return this._acknowledgeMeeting();
        if (action === 'meet-room') return this._createMeetRoom();
    }

    async _listMeetings() {
        const res = await window.electronAPI.gcalList({ hoursAhead: 24 });
        if (!res.success) {
            // Never invent a schedule. If the fetch failed, say so.
            this.speak(`I could not read your calendar, Sir. ${res.error || ''}`);
            return;
        }
        const events = res.events.filter((e) => !e.allDay);
        if (!events.length) {
            this.speak('Nothing on your calendar for the next day, Sir.');
            return;
        }

        const lines = events.map((e) => {
            const when = new Date(e.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
            return `${when}  ${e.summary}${e.meetLink ? '  (Meet)' : ''}`;
        });
        this.displayText(lines.join('\n'), null);

        const first = events[0];
        const when = new Date(first.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        this.speak(events.length === 1
            ? `One meeting, Sir: ${first.summary} at ${when}.`
            : `${events.length} meetings, Sir. The next is ${first.summary} at ${when}.`);
    }

    async _nextMeeting() {
        const next = this.meetingMonitor?.nextMeeting();
        if (!next) {
            // Fall back to a live read rather than claiming nothing is on when
            // the monitor simply has not polled yet.
            return this._listMeetings();
        }
        const mins = Math.round((next.startMs - Date.now()) / 60000);
        this.speak(`${next.summary}, in ${mins} minute${mins === 1 ? '' : 's'}, Sir.`);
        if (next.meetLink) this.displayText(next.meetLink, null);
    }

    _beginScheduling() {
        this.scheduler = this.scheduler || new MeetingScheduler({
            // The ONLY thing the model does here: propose a better title when
            // the user gave a generic one. Everything else is rule-parsed.
            suggestTitle: async (purpose) => {
                const out = await generateContentLocal(
                    [{ role: 'user', parts: [{ text:
                        `Give a 2-4 word meeting title for this purpose. Title only, no quotes, no explanation.\n\n${purpose}` }] }],
                    null, { temperature: 0.3 }
                );
                return String(out || '').split('\n')[0].replace(/["'.]/g, '').trim().slice(0, 60);
            },
        });
        const opening = this.scheduler.start();
        this.speak(opening.say);
    }

    /** Routed here while a scheduling conversation is open. */
    async continueScheduling(transcript) {
        const res = await this.scheduler.handle(transcript);
        if (res.say) this.speak(res.say);

        if (res.create) {
            const out = await window.electronAPI.gcalCreate(res.create);
            if (!out.success) {
                this.speak(`I could not create it, Sir. ${out.error || ''}`);
                return;
            }
            const ev = out.event;
            this.displayText(
                `${ev.summary}\n${new Date(ev.start).toLocaleString()}\n${ev.meetLink || ''}`.trim(),
                null
            );

            if (ev.meetLink) {
                this.speak('Done, Sir. The Meet link is on screen.');
            } else if (ev.meetUnavailable) {
                // Stated plainly. A personal Gmail cannot create a Meet link
                // through the API, and implying otherwise would send someone
                // to a meeting with no way in.
                this.speak('Created, Sir — but without a Meet link. That needs a Google Workspace account.');
            } else {
                this.speak('Created, Sir.');
            }
            await this.meetingMonitor?._refresh();
        }
    }

    async _createMeetRoom() {
        const res = await window.electronAPI.gcalMeetSpace();
        if (!res.success) {
            this.speak(`I could not open a Meet room, Sir. ${res.error || ''}`);
            return;
        }
        this.displayText(res.uri, null);
        this.speak('Your Meet room is ready, Sir. The link is on screen.');
    }

    _acknowledgeMeeting() {
        const ack = this.meetingMonitor?.acknowledgeCurrent();
        this.speak(ack
            ? `Understood, Sir. I will not mention ${ack.summary} again.`
            : 'There is nothing to acknowledge, Sir.');
    }

    /** Start background meeting awareness. Safe to call twice. */
    startMeetingMonitor() {
        if (this.meetingMonitor?.running) return;

        this.meetingMonitor = this.meetingMonitor || new MeetingMonitor({
            fetchEvents: async () => {
                const res = await window.electronAPI.gcalList({ hoursAhead: 12 });
                if (!res.success) throw new Error(res.error || 'calendar unavailable');
                return res.events;
            },
            onAlert: (alert) => {
                this.displayText(`📅 ${alert.event.summary} — ${alert.minutesUntil} min`, null);
                this.speak(describeAlert(alert));
                if (alert.event.meetLink) this.displayText(alert.event.meetLink, null);
            },
        });
        this.meetingMonitor.start();
    }

    async handleSetAlarm(alarm) {
        if (!alarm?.at) {
            this.speak('I did not catch when. Try "set a timer for twenty minutes", or "set an alarm for seven thirty".');
            return;
        }

        // A time in the past means the parse was wrong, not that the user
        // wants an instant alarm.
        if (alarm.at.getTime() <= Date.now()) {
            this.speak('That time has already passed, Sir.');
            return;
        }

        const { at } = this.alarms.schedule({
            kind: alarm.kind,
            at: alarm.at,
            label: alarm.label,
        });

        const noun = alarm.kind === 'timer' ? 'Timer' : 'Alarm';
        const subject = alarm.label ? ` for ${alarm.label}` : '';
        const when = alarm.kind === 'timer'
            ? formatDuration(at.getTime() - Date.now())
            : formatClock(at);

        this.displayText(`${noun}${subject} — ${when} (${at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })})`, null);
        this.speak(alarm.kind === 'timer'
            ? `${noun} set${subject} for ${when}.`
            : `${noun} set${subject} for ${when}.`);

        // Said once per session, not on every alarm. This is a renderer-side
        // scheduler: if Jarvis is closed the alarm does not fire, and letting
        // someone believe otherwise is worse than the limitation itself.
        if (!this._warnedAlarmScope) {
            this._warnedAlarmScope = true;
            this.displayText('Note: alarms only fire while Jarvis is running.', null);
        }
    }

    async handleAlarmCancel(all) {
        if (all) {
            const n = this.alarms.cancelAll();
            this.speak(n ? `Cancelled ${n} alarm${n === 1 ? '' : 's'}, Sir.` : 'There was nothing to cancel.');
            return;
        }

        const pending = this.alarms.list();
        if (!pending.length) {
            this.speak('You have no alarms set, Sir.');
            return;
        }

        // Cancel the SOONEST rather than asking which. With one pending — the
        // common case — a disambiguation prompt is friction for no gain.
        const next = pending[0];
        this.alarms.cancel(next.id);
        const subject = next.label ? ` for ${next.label}` : '';
        this.speak(`Cancelled your ${next.kind}${subject}, Sir.`);

        if (pending.length > 1) {
            this.displayText(`${pending.length - 1} other alarm${pending.length === 2 ? '' : 's'} still set.`, null);
        }
    }

    async handleAlarmList() {
        const pending = this.alarms.list();
        if (!pending.length) {
            this.speak('You have no alarms or timers set, Sir.');
            return;
        }

        const lines = pending.map((a) => {
            const subject = a.label ? ` — ${a.label}` : '';
            const at = a.at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
            return `${a.kind === 'timer' ? 'Timer' : 'Alarm'} ${at} (in ${formatDuration(a.remainingMs)})${subject}`;
        });
        this.displayText(lines.join('\n'), null);

        const next = pending[0];
        const subject = next.label ? ` for ${next.label}` : '';
        this.speak(pending.length === 1
            ? `One ${next.kind}${subject}, in ${formatDuration(next.remainingMs)}.`
            : `${pending.length} set. The next${subject} is in ${formatDuration(next.remainingMs)}.`);
    }

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
            const femaleVoices = englishVoices.filter(v => this.isFemaleVoice(v.name));

            if (femaleVoices.length > 0) {
                const voiceNames = femaleVoices.slice(0, 5).map(v => v.name).join(', ');
                this.speak(`Available female voices: ${voiceNames}`);
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

            this.haptics.attention();
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
        this._spokenRecently.push({ words: this._echoWords(text), phrase: this._echoPhrase(text), at: Date.now() });
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
    _logInteraction(input, intent, startedAt, ok, buf, superseded = false) {
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
                // Whether a NEWER turn replaced this one. Distinct from ok: the
                // user interrupting is not the turn failing, and only the
                // interrupted turn can have a truncated response. Omitted when
                // false so the common row stays as it was.
                ...(superseded ? { superseded: true } : {}),
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

    // Normalised phrase for substring echo detection — catches partial echoes
    // where the mic picks up a fragment of Jarvis's speech that has too few
    // words for the word-overlap guard (e.g. 2 words of a 10-word sentence).
    _echoPhrase(text) {
        return String(text)
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    /**
     * True when a transcript overlaps heavily with something recently spoken.
     * Word-overlap rather than exact match, because the STT re-transcription of
     * synthesised speech is close but never identical.
     *
     * Three detection strategies (any match → echo):
     *   1. Overlap ratio: ≥60% of input words appear in spoken words
     *   2. Jaccard similarity: |intersection|/|union| ≥ 0.4
     *   3. Substring match: normalised input appears inside a recent phrase
     *      (catches 2-word fragments the word guards can't score)
     */
    _isEchoOfSelf(cmd) {
        const recent = this._spokenRecently || [];
        if (!recent.length) return false;

        const said = this._echoWords(cmd);
        // Lowered from 3→2: two-word echoes like "seventeen thousand" are real
        // and were slipping through. Single words are still too ambiguous.
        if (said.size < 2) return false;

        const cmdPhrase = this._echoPhrase(cmd);

        for (const entry of recent) {
            if (!entry.words.size) continue;

            // Strategy 1: overlap ratio (original guard)
            let hits = 0;
            for (const w of said) if (entry.words.has(w)) hits++;
            if (hits / said.size >= 0.6) return true;

            // Strategy 2: Jaccard similarity — symmetric measure that catches
            // cases where the input has few words but they are a subset of a
            // much larger spoken phrase (overlap ratio is asymmetric).
            const union = new Set([...said, ...entry.words]);
            if (union.size > 0 && hits / union.size >= 0.4) return true;

            // Strategy 3: substring match — if the normalised input phrase is
            // contained verbatim within a recent spoken phrase, it's almost
            // certainly echo. Only applies when input is ≥8 chars to avoid
            // false-positives on common short phrases.
            if (cmdPhrase.length >= 8 && entry.phrase && entry.phrase.includes(cmdPhrase)) {
                return true;
            }
        }
        return false;
    }

    /**
     * The user started talking over the reply. Stop talking.
     *
     * Everything queued is dropped rather than paused: the answer to a
     * question the user has already moved on from is not worth finishing, and
     * resuming mid-sentence afterwards sounds like a fault.
     */
    _onBargeIn() {
        console.log('Jarvis: barge-in — user is speaking, stopping playback');
        if (this.neuralTTS) this.neuralTTS.interrupt();
        try { this.synthesis.cancel(); } catch { /* noop */ }
        this._flushSpeechQueue();
        clearTimeout(this._ttsSafetyTimer);
        this.ttsActive = false;
        this._showTranscript('', 'ambient', 'LISTENING', 1200);
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
            // A barged transcript that turns out to be Jarvis's own words is
            // proof the echo canceller is not holding on this hardware. One
            // such miss is enough: keep barge-in on and every reply gets cut
            // off by itself, which is worse than not having it.
            if (meta && meta.barged && this.localVoice) {
                this.localVoice.disableBargeIn('barge-in transcript was self-echo');
            }
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

        this.haptics.acknowledge();
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
    /**
     * Opens the live screen mirror.
     *
     * Speaks only what the session actually reported. An earlier version of
     * this file's phone handlers announced success before the phone answered,
     * which is the failure mode this project keeps re-learning: the mirror
     * either produced a resolution and a codec or it did not, and there is no
     * useful sentence in between.
     */
    /* ---------------------------------------------------------------------
       FOUNDRY — build it in Blender.

       The spoken reply is assembled from what the pipeline actually returned:
       the object names, the polygon count, the engine, and the device Blender
       resolved at run time. None of it is phrased in advance, because every
       one of those can differ from what was asked for — a Cycles request falls
       back to CPU on a card without a usable compute backend, and saying "on
       the GPU" then would be a claim this project does not get to make.
       --------------------------------------------------------------------- */
    async handleFoundryCreate({ subject, engine, wantsExport }) {
        const api = window.electronAPI;
        if (!api?.foundryCreate) {
            this.speak('The Foundry is not available in this build, Sir.');
            return;
        }

        this.haptics.click();
        this.speak(`Working on ${subject}, Sir. This will take a moment.`);

        /* Progress arrives from the main process as it happens. A render is
           tens of seconds and silence for that long reads as a hang. */
        const off = api.onFoundryStatus?.((line) => this.showStatus?.(`Foundry: ${line}`));

        try {
            const result = await api.foundryCreate({ utterance: subject, engine, exportFormat: wantsExport || null });

            if (!result?.ok) {
                /* Say which stage failed. "I couldn't do that" is the answer
                   this project has removed everywhere else it appeared. */
                const stage = {
                    runtime: 'the local model is not reachable',
                    locate: 'Blender is not installed',
                    plan: 'I could not turn that into a buildable scene',
                    refused: 'that cannot be built from the shapes I have',
                    validate: 'the plan it produced was not valid',
                    timeout: 'Blender ran too long and was stopped',
                    result: 'Blender exited without producing anything'
                }[result?.stage] || 'it failed';
                this.speak(`I could not build that, Sir — ${stage}.`);
                if (result?.error) this.showStatus?.(`Foundry: ${result.error}`);
                if (result?.hint) this.showStatus?.(`Foundry: ${result.hint}`);
                this.haptics.warn();
                return;
            }

            const built = result.build || {};
            const count = built.objects?.length ?? 0;
            const printable = result.printability
                ? (result.printability.watertight ? ' It is watertight, so it will slice.' : ' It is not watertight, so it will not slice cleanly yet.')
                : '';

            this.speak(
                `Done, Sir. ${count} object${count === 1 ? '' : 's'}, ${built.polygons ?? 0} polygons, rendered with ${built.engine === 'CYCLES' ? 'Cycles' : 'EEVEE'} in ${result.seconds} seconds.${printable}`
            );
            this.showStatus?.(`Foundry: ${result.image}`);
            /* Open the image rather than describe it. The output of this
               feature is a picture; reading a file path aloud is not a result. */
            if (result.image && api.revealInFolder) api.revealInFolder(result.image);

            for (const w of built.warnings || []) this.showStatus?.(`Foundry warning: ${w}`);
        } catch (e) {
            console.error('Foundry error:', e);
            this.speak('The Foundry failed, Sir.');
            this.showStatus?.(`Foundry: ${e.message}`);
            this.haptics.warn();
        } finally {
            off?.();
        }
    }

    /* ---------------------------------------------------------------------
       GLOBE — fly the command centre to a place and report what is there.

       The spoken line is built from what the feeds ACTUALLY returned. "Real-
       time data active" over an empty feed would be the exact species of
       claim this project keeps removing: it says how many events there are,
       or it says there are none.
       --------------------------------------------------------------------- */
    async handleGlobeShow({ place, focus }) {
        const globe = window.jarvisGlobe;
        if (!globe) {
            this.speak('The globe view is not available in this build, Sir.');
            return;
        }

        this.haptics.click();
        this.speak(`Bringing up ${place}, Sir.`);

        try {
            const result = await globe.showLocation(place);
            if (!result.ok) {
                this.speak(`I could not place ${place} on the map, Sir.`);
                this.haptics.warn();
                return;
            }

            const { place: found, nearby, source, dossier, images, events } = result;
            /* Say where the coordinates came from when they came off the
               network — the offline index is the normal path and worth
               distinguishing from a lookup that needed the internet. */
            if (source === 'nominatim') this.showStatus?.(`Globe: geocoded ${found.name} online`);

            /* Build a briefing from what actually came back. Every fragment is
               optional — a missing dossier or an empty feed should shorten the
               sentence, not block it. */
            const parts = [found.name];

            /* Dossier: temperature, local time, air quality — the facts a
               command-centre briefing opens with. */
            if (dossier) {
                /* FLAT field names. These read `dossier.weather.temperature`
                   and `dossier.airQuality.index` before, while the service has
                   always returned `temperatureC` and `aqi` at the top level —
                   so every guard failed and the briefing silently dropped the
                   weather, the time and the air quality it had just fetched. */
                const temp = dossier.temperatureC;
                const desc = dossier.condition;
                const aqi = dossier.aqi;

                if (Number.isFinite(dossier.utcOffsetSec)) {
                    const d = new Date(Date.now() + dossier.utcOffsetSec * 1000);
                    parts.push(`Local time ${String(d.getUTCHours()).padStart(2, '0')} ${String(d.getUTCMinutes()).padStart(2, '0')}`);
                }
                if (Number.isFinite(temp)) {
                    parts.push(`${Math.round(temp)} degrees${desc ? `, ${String(desc).toLowerCase()}` : ''}`);
                }
                if (Number.isFinite(aqi)) {
                    const quality = dossier.aqiCategory
                        ? String(dossier.aqiCategory).replace(/ air quality$/i, '').toLowerCase()
                        : (aqi <= 50 ? 'good' : aqi <= 100 ? 'moderate' : aqi <= 150 ? 'unhealthy for sensitive groups' : 'unhealthy');
                    parts.push(`Air quality index ${aqi}, ${quality}`);
                }
                if (Number.isFinite(dossier.elevationM)) {
                    parts.push(`Elevation ${Math.round(dossier.elevationM)} metres`);
                }
            }

            if (focus === 'events') {
                /* Asked about events; seismic activity is not the answer. */
            } else if (nearby.length) {
                const worst = nearby.reduce((a, b) => ((b.magnitude ?? 0) > (a.magnitude ?? 0) ? b : a));
                parts.push(
                    `${nearby.length} seismic event${nearby.length === 1 ? '' : 's'} within nine hundred kilometres, the largest a magnitude ${(worst.magnitude ?? 0).toFixed(1)} near ${worst.place}`
                );
            } else {
                parts.push('No significant seismic activity nearby');
            }

            /* Events. When the user ASKED about events this leads the briefing
               and the seismic line is dropped — "what events are in Tokyo"
               answered with earthquake counts is answering a different
               question.

               "No events" is only said when the feed is actually working. An
               unconfigured Luma calendar must not be reported as an empty
               city, because that is a claim about the world made from a
               missing API key. */
            const eventFeed = globe.feeds?.status?.().find((f) => f.key === 'events');
            if (focus === 'events') {
                if (eventFeed && !eventFeed.configured) {
                    this.speak(`${found.name} is on screen, Sir. I have no events calendar connected — Luma needs an API key before I can answer that.`);
                    return;
                }
                if (events?.length) {
                    const next = events[0];
                    parts.push(`${events.length} event${events.length === 1 ? '' : 's'} nearby`);
                    if (next?.name) parts.push(`the nearest is ${next.name}`);
                } else {
                    parts.push('No events on your calendar near there');
                }
            } else if (events?.length) {
                parts.push(`${events.length} event${events.length === 1 ? '' : 's'} on your calendar nearby`);
            }

            if (images?.length) {
                parts.push(`${images.length} photograph${images.length === 1 ? '' : 's'} acquired`);
            }

            this.speak(parts.join('. ') + '.');
        } catch (e) {
            console.error('Globe error:', e);
            this.speak('The globe failed to acquire that location, Sir.');
            this.haptics.warn();
        }
    }

    /* A route between two places, with the aircraft currently over it.

       THE WORDING IS DELIBERATE. OpenSky's state vectors carry no origin and
       no destination, and its departure endpoint refuses historical windows on
       anonymous access while reporting a null arrival airport for everything
       still airborne. So Jarvis says what is true — how many aircraft are over
       the corridor — and never claims they are flying from one named city to
       the other, because the data cannot support that and some of them are
       simply crossing. */
    async handleGlobeRoute({ from, to }) {
        const globe = window.jarvisGlobe;
        if (!globe?.showRoute) {
            this.speak('The globe view is not available in this build, Sir.');
            return;
        }
        this.haptics.click();
        this.speak(`Plotting ${from} to ${to}, Sir.`);
        try {
            const r = await globe.showRoute(from, to);
            if (!r.ok) {
                this.speak(r.error || `I could not plot that route, Sir.`);
                this.haptics.warn();
                return;
            }
            const parts = [`${r.from.name} to ${r.to.name}`, `${Math.round(r.distanceKm)} kilometres`];

            /* REAL flights first when a schedule provider answered. These have
               a stated origin and destination, so they can be described as the
               route itself rather than as traffic that happens to be over it. */
            if (r.scheduled?.length) {
                const s = r.scheduled;
                parts.push(`${s.length} flight${s.length === 1 ? '' : 's'} on the ${r.fromAirport.iata} to ${r.toAirport.iata} route`);
                const airlines = [...new Set(s.map((f) => f.airline).filter(Boolean))].slice(0, 3);
                if (airlines.length) parts.push(`flown by ${airlines.join(', ')}`);
                const airborne = s.filter((f) => f.isLive);
                if (airborne.length) parts.push(`${airborne.length} airborne now`);
                const delayed = s.filter((f) => (f.departureDelayMin ?? 0) > 15);
                if (delayed.length) {
                    parts.push(`${delayed.length} delayed by more than fifteen minutes`);
                }
                this.speak(parts.join('. ') + '.');
                return;
            }

            if (r.flights.length) {
                parts.push(`${r.flights.length} aircraft over the corridor right now`);
                const lead = r.flights[0];
                if (lead?.callsign) {
                    parts.push(`the nearest to ${r.from.name} is ${lead.callsign}, ${lead.fromKm} kilometres out`);
                }
                /* Said out loud, once, because the visual cannot carry it. */
                parts.push('I cannot confirm their destinations — the open feed does not publish them');
            } else {
                parts.push('No aircraft over that corridor at the moment');
            }
            this.speak(parts.join('. ') + '.');
        } catch (e) {
            console.error('Globe route error:', e);
            this.speak('The globe failed to plot that route, Sir.');
            this.haptics.warn();
        }
    }

    /* Satellites on the globe, and what is actually up there.

       The count is read from the layer AFTER it loads rather than stated in
       advance: the number of tracked objects in a CelesTrak group changes, and
       a figure quoted from memory would be decoration. */
    async handleGlobeSatellites({ on }) {
        const globe = window.jarvisGlobe;
        if (!globe?.satellites) {
            this.speak('The globe view is not available in this build, Sir.');
            return;
        }
        this.haptics.click();
        if (!globe.isActive() && on) {
            globe.setActive(true);
            for (const m of window.visualizerModes?.meshes || []) if (m) m.visible = false;
        }
        if (!on) {
            await globe.satellites.toggle(false);
            this.speak('Orbital tracking off, Sir.');
            return;
        }

        this.speak('Acquiring orbital elements, Sir.');
        const ok = await globe.satellites.toggle(true);
        if (!ok) {
            this.speak('I could not reach the orbital element service, Sir.');
            this.haptics.warn();
            return;
        }
        const n = globe.satellites.layer.count();
        this.speak(
            n
                ? `Tracking ${n} objects in orbit, Sir. Positions are propagated live from the current element set.`
                : 'The element set came back empty, Sir.'
        );
    }

    async handleGlobeToggle({ on }) {
        const globe = window.jarvisGlobe;
        if (!globe) {
            this.speak('The globe view is not available in this build, Sir.');
            return;
        }
        this.haptics.click();
        globe.setActive(on);
        /* Keep the orb and the globe mutually exclusive, exactly as F3 does. */
        for (const m of window.visualizerModes?.meshes || []) if (m) m.visible = !on;
        this.speak(on ? 'Command centre online, Sir.' : 'Returning to standby, Sir.');
    }

    /* Show what has already been built.

       `read` effects: it opens a viewer and starts nothing. This is the intent
       "show me the model" should always have had — from the interaction log of
       3 Aug 2026 it was routed to CREATE and built a six-polygon cube, because
       the noun "model" was read as the verb. */
    async handleFoundryShow({ which }) {
        if (!window.jarvisFoundry) {
            this.speak('The Foundry viewer is not available in this build, Sir.');
            return;
        }

        this.haptics.click();
        const info = await window.jarvisFoundry.open(which || { position: 'newest' });

        if (!info || !info.count) {
            this.speak('Nothing has been built yet, Sir. Ask me to model something and I will show it to you.');
            return;
        }

        const job = info.job;
        /* Say what is on screen, including when it is a failure. Opening a
           panel silently onto a failed job is the same as claiming success. */
        if (!job) {
            this.speak(`I have ${info.count} build${info.count === 1 ? '' : 's'}, Sir, but none of them could be displayed.`);
            return;
        }

        if (info.reason) this.showStatus?.(`Foundry: ${info.reason}`);

        if (job.state === 'failed') {
            this.speak(`The most recent build, ${job.name}, failed at the ${job.stage} stage, Sir. It is on screen.`);
            return;
        }
        if (job.state === 'incomplete') {
            this.speak(`${job.name} never finished, Sir — there is no render to show.`);
            return;
        }

        const printable = job.printability
            ? (job.printability.watertight ? ' It is watertight.' : ' It is not watertight, so it will not slice cleanly.')
            : '';
        this.speak(
            `Here is ${job.name}, Sir — ${job.objects.length} object${job.objects.length === 1 ? '' : 's'}, ${job.polygons ?? 0} polygons.${printable}`
        );
    }

    /* Refine, export and print are recognised and not yet built.

       Saying so is the whole point. A recognised command that gets a plausible
       sentence instead of an action is the exact bug this codebase has fixed
       repeatedly — the alarm in 606fa69, the recycle bin on 2 Aug. Recognising
       it and admitting the gap is honest; describing it as though it happened
       is not. */
    async handleFoundryUnbuilt({ intent }) {
        const what = {
            FOUNDRY_REFINE: 'refining a model I have already built',
            FOUNDRY_EXPORT: 'exporting an existing scene on its own',
            FOUNDRY_PRINT: 'sending a model to a 3D printer'
        }[intent];
        this.speak(`I understood that, Sir, but ${what} is not wired up yet. I can build and render something new, and export it in the same step.`);
        this.haptics.warn();
    }

    async handleMirrorStart() {
        if (!window.jarvisMirror || !window.electronAPI?.mirror) {
            this.speak('Screen mirroring is not available in this build, Sir.');
            return;
        }
        if (window.jarvisMirror.isOpen()) {
            this.speak('Your phone is already on screen, Sir.');
            return;
        }

        this.displayText('Starting the phone mirror…', null);
        const res = await window.jarvisMirror.open();

        if (!res.ok) {
            /* The service turns library errors into a sentence naming the
               thing the user controls — an unauthorised device, a missing ADB
               server — so it is spoken verbatim rather than summarised. */
            this.speak(`I could not mirror your phone, Sir. ${res.error}`);
            return;
        }

        const s = res.status || {};
        const where = s.connection === 'tcpip' ? 'over Wi-Fi' : 'over USB';
        const size = s.width && s.height ? ` at ${s.width} by ${s.height}` : '';
        this.speak(`Mirroring ${s.model || 'your phone'} ${where}${size}, Sir.`);

        /* The timings are printed only when they were actually measured. The
           first version of this line said "first frame ?ms" every time,
           because the status was snapshotted before any frame had arrived —
           a placeholder that reads like a real reading is worse than no
           reading, which is the rule this project already applies to prices
           and IP addresses. */
        const timings = [
            s.startMs !== null && s.startMs !== undefined ? `handshake ${s.startMs}ms` : null,
            s.firstFrameMs !== null && s.firstFrameMs !== undefined ? `first frame ${s.firstFrameMs}ms` : null
        ].filter(Boolean).join(', ');
        this.displayText(
            `Mirror: ${s.model || s.serial} ${where}, ${s.width}x${s.height} ${s.codec}` +
            (timings ? ` — ${timings}` : ''), null);
    }

    async handleMirrorStop() {
        if (!window.jarvisMirror) {
            this.speak('Screen mirroring is not available in this build, Sir.');
            return;
        }
        if (!window.jarvisMirror.isOpen()) {
            this.speak('The mirror is not running, Sir.');
            return;
        }
        await window.jarvisMirror.close();
        this.speak('Mirror closed, Sir.');
    }

    /**
     * Grabs a still from the live mirror and describes it with local vision.
     *
     * Distinct from PHONE_TOOL's phone.screenshot, which goes through the
     * companion's AccessibilityService and needs the APK installed and
     * enabled. This one reads the frame already on screen, so it works
     * whenever the mirror does — but it only works when the mirror is up, and
     * it says so rather than silently starting one.
     */
    async handleMirrorSnapshot() {
        if (!window.jarvisMirror?.isOpen()) {
            this.speak('The mirror is not running, Sir. Say mirror my phone first.');
            return;
        }

        const dataUrl = await window.jarvisMirror.snapshot();
        if (!dataUrl) {
            this.speak('I could not capture a frame, Sir.');
            return;
        }

        this.displayText('Captured your phone screen.', null);

        // Describing it is best-effort: without a local vision model the
        // capture still happened, and claiming otherwise would be a lie in
        // either direction.
        try {
            const description = await describeImageLocal(dataUrl, 'Describe what is on this phone screen.');
            if (description) {
                this.speak(description);
                return;
            }
        } catch (e) {
            console.warn('Mirror snapshot description failed:', e.message);
        }
        this.speak('I have your phone screen, Sir, but no local vision model is available to read it.');
    }

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
                        this.haptics.attention();
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
                        this.haptics.warn();
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
                        if (this._whaleAlertsOn) { this.haptics.attention(); this.speak(`Sir, significant movement on ${w.chain === 'ethereum' || !w.chain ? 'Ethereum' : w.chain}. ${spokenLine}`); }
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
                        if (this._whaleAlertsOn) { this.haptics.attention(); this.speak(`Sir, stablecoin supply change. ${line}`); }
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
                        this.haptics.attention();
                        this.speak(`Sir, your watched wallet has activity. ${line}`);
                        break;
                    }

                    case 'price-alert': {
                        // Watchlist target/stop crossing — always announce
                        const { message, type } = evt.payload;
                        this.haptics.attention();
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
        // Scheduling verbs are included because the model was reliably
        // RECOGNISING these and then only describing them — the 31 Jul log has
        // it answering "I would request the command layer to set an alarm for
        // seven thirty" instead of setting one. Recognition without a route to
        // execution is just a more fluent failure.
        //
        // A leading filler ("okay, ...") is skipped so the verb is still found.
        // This does not rescue an anaphoric command like "do it for 7 30" —
        // that needs the previous turn, not a wider regex.
        if (/^(?:(?:ok|okay|alright|yeah|yes|hey|now|please|jarvis)\b[,\s]+)*(?:open|play|launch|start|go to|visit|show me|put on|bring up|set|create|make|wake me|remind me)\b/i.test(query)) {
            const route = await routeLocalAction(query);
            switch (route.action) {
                case 'set_timer':
                case 'set_alarm': {
                    // Re-parse the model's argument with the rule-based parser
                    // rather than trusting it. An alarm the user cannot rely on
                    // is worse than no alarm, so the time still has to resolve
                    // unambiguously or this falls through to conversation.
                    const kind = route.action === 'set_timer' ? 'timer' : 'alarm';
                    const parsed = parseAlarmCommand(`set a ${kind} for ${route.arg}`);
                    if (parsed?.at) {
                        await this.handleSetAlarm(parsed);
                        return;
                    }
                    break;
                }
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
                    /* THE OFFER-THEN-FABRICATE LOOP, from the live session of
                       22 Jul 2026. The model answered "I can access SEC XBRL
                       filings from July 21st... Would you like me to display
                       the details?" — it could not; the feed carries a title,
                       a date and a link. The user said "yes", and over eight
                       turns it invented an entire Goldman Sachs compensation
                       structure, ending at "$8.5 billion" and "1.25 skew
                       factor". The existing rules forbid claiming an ACTION;
                       nothing forbade claiming ACCESS, and the offer is what
                       obliged it to produce something on the next turn. */
                    + ' Never offer to retrieve, display, elaborate on, or look up anything. You have no ability to fetch anything while answering: the only information you have is the context above. If the context contains a filing title and date but not its contents, say exactly that and stop — do not offer to show details you do not have. Answer from what is in front of you or say it is not there.'
                    + ' NEVER state a specific IP address, MAC address, port number, hostname, price, balance, device name, network name, dollar amount, financial metric, or any other concrete measured value unless it appears verbatim in the context above. You have no ability to look these up or scan for them while answering. If you do not have the value, say you do not have it and stop — a plausible-looking number or a placeholder name is worse than no answer. Never invent example names such as "Device_XYZ".'
                    /* REGISTER. The rules above are all prohibitions, and a
                       model given only prohibitions answers like a compliance
                       notice. These describe how to sound while obeying them.

                       Every line here is compatible with grounding, and one
                       reinforces it: preferring the exact number FROM CONTEXT
                       over a vague paraphrase is the same instruction as
                       "quote, do not approximate".

                       DELIBERATELY ABSENT: "always find a way to help, never
                       say you cannot." That is the pressure that produced both
                       logged fabrication classes above — the invented IP and
                       the eight-turn Goldman Sachs number. Saying plainly that
                       something is not available IS the helpful answer here,
                       and it stays. */
                    + ' Register: calm, warm, and lightly formal — a trusted colleague, not a corporate interface. Never panic, never lecture, never condescend, and never open with praise like "Great question". Prefer the exact figure from the context over a vague description ("battery at 14 percent" rather than "battery is low"). Wit, when it appears, is dry and understated and lives inside a useful answer, never as a joke on its own.'
                    + ' When he proposes something risky or destructive: state the specific consequence, offer the safer alternative, then do as he asks if he still wants it. Inform, suggest, comply — in that order, once, without repeating the warning.'
                    + ' When something has failed or is unavailable, say so calmly and say what still works rather than only what does not. A failure is a fact to report, not an apology to perform.'
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
       the model was being evicted.

       That fix then over-corrected into a different lie: every timeout was
       blamed on memory pressure regardless of cause. On 30 Jul it told the user
       to close Chrome tabs eleven times while 9GB was free and the model was
       resident — the real cost was a 6s rerank timeout on every query. The
       stage timings that say so were already being recorded, so they are read
       here rather than guessed at. */
    /** Load learned budgets. Never throws — supervision must not break startup. */
    _restoreHealthState() {
        try {
            const raw = localStorage.getItem('jarvis_health');
            if (raw) health.load(JSON.parse(raw));
        } catch (e) {
            console.warn('Health state restore failed (starting from defaults):', e.message);
        }
    }

    _persistHealthState() {
        try {
            localStorage.setItem('jarvis_health', JSON.stringify(health.toJSON()));
        } catch { /* quota or private mode — learning just restarts next launch */ }
    }

    _describeLocalFailure(error) {
        return diagnoseLocalFailure({
            stages: perf.snapshot()?.stages || {},
            error,
            // Only claim memory pressure when memory has actually been measured.
            freeMemoryGb: Number.isFinite(this._freeMemoryGb) ? this._freeMemoryGb : null,
        });
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

        /* A line that never reports back must not stall the queue forever —
           the same eventless-death problem as the mic watchdog. Budget is
           generous (SAPI runs ~450ms/word) and only fires if onend does not. */
        const safety = setTimeout(finish, Math.min(line.split(/\s+/).length * 500 + 4000, 40000));

        /* Same voice as speak(). This queue used to go straight to SAPI while
           speak() went through the neural server, so a streamed local-model
           answer came out in the system voice and everything else in the neural
           one — two different voices inside a single reply. Draining one line at
           a time means the interrupt inside neuralTTS.speak() only ever cancels
           an utterance that has already finished. */
        if (this.neuralTTS && this.neuralTTS.isAvailable()) {
            this.neuralTTS.speak(line, {
                voice: this.settings.get('neuralVoice') || 'en-US-EmmaNeural',
                speed: this.settings.get('speechRate') || 1.0
            }).then((ok) => {
                if (ok) finish();
                else this._drainSpeechViaSAPI(line, finish);
            }).catch(() => this._drainSpeechViaSAPI(line, finish));
            return;
        }

        this._drainSpeechViaSAPI(line, finish);
    }

    /** Speak one queued line through the system voice.

        OFF unless `systemVoiceFallback` was explicitly enabled, and even then
        only with a voice that passed isFemaleVoice. Jarvis speaks as Emma; a
        dead neural server must not quietly change that. */
    _drainSpeechViaSAPI(line, finish) {
        if (!this._systemVoiceAllowed()) { finish(); return; }
        const u = new SpeechSynthesisUtterance(line);
        if (this.selectedVoice) u.voice = this.selectedVoice;
        u.rate = this.settings.get('speechRate') || 1.0;
        u.pitch = this.settings.get('speechPitch') || 1.0;
        u.volume = this.settings.get('speechVolume') || 1.0;
        u.onend = finish;
        u.onerror = finish;
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

