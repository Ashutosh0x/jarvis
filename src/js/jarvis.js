// Jarvis AI Assistant Core Module
import ConversationMemory from './memory.js';
import ScreenCapture from './screenCapture.js';
import CalendarSystem from './calendar.js';
import SettingsManager from './settings.js';
import { LiveService } from './liveService.js';

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

        // Live Service (Gemini Multimodal Live)
        this.liveService = new LiveService();
        this.setupLiveService();

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
        // this.initializeVoice(); // Voice is now handled by Gemini Audio
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
                this.pttIndicator.textContent = '🎙️ ALWAYS LISTENING';
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
                this.pttIndicator.textContent = '🎙️ SPEAKING';
            } else {
                this.pttIndicator.classList.remove('active');
                this.pttIndicator.textContent = '⏸️ HOLD SPACE TO TALK';
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
            icon = '🛰️';
            color = 'text-cyan-400';
        } else if (role === 'user') {
            icon = '👤';
            color = 'text-slate-100';
        } else {
            icon = '⚙️';
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

        // Note: Clean speech is now handled directly by Gemini Audio output 
        // through the LiveService. Local speak method is now UI only to prevent
        // system voice (e.g., David/Mark) from interrupting the neural link.
        console.log("Jarvis (UI):", text);
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

        // System Control Commands
        if (cmd.includes('open chrome')) return { intent: 'OPEN_APP', app: 'chrome' };
        if (cmd.includes('open notepad')) return { intent: 'OPEN_APP', app: 'notepad' };
        if (cmd.includes('open explorer')) return { intent: 'OPEN_APP', app: 'explorer' };
        if (cmd.includes('open downloads')) return { intent: 'OPEN_APP', app: 'downloads' };
        if (cmd.includes('open vs code') || cmd.includes('open code')) return { intent: 'OPEN_APP', app: 'vscode' };
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
        if (cmd.includes('read screen') || cmd.includes('what\'s on my screen') || cmd.includes('read my screen')) return { intent: 'READ_SCREEN' };

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

        const intent = this.detectIntent(command);
        console.log('Intent:', intent);

        try {
            switch (intent.intent) {
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
                    await this.handleReadScreen();
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
                    await this.handleOpenWebsite(intent.url);
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
            this.speak('I apologize, but I encountered an error processing that command.');
        } finally {
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

    // Screen Analysis Handler - Uses Gemini Vision for OCR + Analysis
    async handleReadScreen() {
        try {
            this.displayText('Analyzing your screen...', null);

            if (!window.electronAPI || !window.electronAPI.captureScreen) {
                this.speak('Screen analysis is not available in this environment');
                return;
            }

            const screenshot = await window.electronAPI.captureScreen();

            if (!screenshot.success) {
                this.speak('Failed to capture screen');
                return;
            }

            // Extract base64 data from data URL
            const base64Image = screenshot.image.replace(/^data:image\/\w+;base64,/, '');

            // Send to Gemini Vision via LiveService
            if (this.liveService && this.liveService.isConnected) {
                // Use sendClientContent with image for vision analysis
                this.liveService.session.sendClientContent({
                    turns: [{
                        role: 'user',
                        parts: [
                            {
                                inlineData: {
                                    mimeType: 'image/png',
                                    data: base64Image
                                }
                            },
                            {
                                text: 'Analyze this screenshot of my screen. Tell me: 1) What application or content is visible? 2) Extract and summarize any visible text. 3) Describe what the user appears to be working on.'
                            }
                        ]
                    }],
                    turnComplete: true
                });
            } else {
                this.speak('Neural link not connected. Connecting now...');
                await this.liveService.connect();
                // Retry after connection
                setTimeout(() => this.handleReadScreen(), 2000);
            }
        } catch (error) {
            console.error('Screen analysis error:', error);
            this.speak('Failed to analyze screen');
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

    // Web Automation Handlers
    async handleOpenWebsite(url) {
        try {
            if (window.electronAPI && window.electronAPI.openWebsite) {
                // Add http:// if no protocol specified
                const fullUrl = url.startsWith('http') ? url : `https://${url}`;
                window.electronAPI.openWebsite(fullUrl);
                this.speak(`Opening ${url}`);
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

    // AI Command Handler (Gemini)
    async handleAICommand(query) {
        try {
            this.displayText('Processing your request...', null);

            // Add user message to local memory for UI/logging
            this.memory.addMessage('user', query);

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
}

export default Jarvis;

