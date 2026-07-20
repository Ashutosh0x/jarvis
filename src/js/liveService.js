import { GoogleGenAI } from "@google/genai";
import {
    base64ToUint8Array,
    arrayBufferToBase64,
} from "./audioUtils.js";
import { performSearch, generateImage, reimagineImage } from "./toolService.js";
import ragService from "./services/ragService.js";
import { config } from "../config.js";
import captureProcessorUrl from './capture-processor.js?url';
import playbackProcessorUrl from './playback-processor.js?url';


const createTool = {
    name: "create_illustration",
    description: "Create an illustration or image based on a description. Use this tool whenever the user asks to generate, create, or draw an image from scratch.",
    parameters: {
        type: "OBJECT",
        properties: {
            prompt: { type: "STRING", description: "Detailed description of the image to create." },
        },
        required: ["prompt"],
    },
};

const reimagineTool = {
    name: "reimagine_user",
    description: "Captures the current view from the user's camera to create a new AI-generated image based on it. Use this tool triggers for: 'take a photo of me', 'take a picture', 'capture me', 'selfie', 'make me look like...', 'turn me into...', or 'reimagine this scene'.",
    parameters: {
        type: "OBJECT",
        properties: {
            prompt: { type: "STRING", description: "The visual description for the new image. If the user simply asks to 'take a photo' without specifying a style, use 'A high quality professional portrait of the person'." },
        },
        required: ["prompt"],
    },
};

const parseDocumentOcrTool = {
    name: "parse_document_ocr",
    description: "Parse a local image or PDF file into structured Markdown using the local Unlimited-OCR model (Baidu, long-horizon document parsing). Use when the user asks to read, scan, parse, or extract text/tables from a document, invoice, paper, or screenshot file.",
    parameters: {
        type: "OBJECT",
        properties: {
            filePath: { type: "STRING", description: "Absolute path to the document (e.g. C:\\Users\\Name\\Downloads\\invoice.pdf). Images and multi-page PDFs are supported." }
        },
        required: ["filePath"],
    },
};

const ocrScreenTool = {
    name: "ocr_screen",
    description: "Capture the user's current screen and parse everything visible into structured Markdown using the local Unlimited-OCR model. Use when the user says 'read my screen', 'what does my screen say', 'OCR the screen', or asks about text/tables/code currently visible on their display.",
    parameters: {
        type: "OBJECT",
        properties: {},
    },
};

const systemStatusTool = {
    name: "get_system_status",
    description: "Read live system diagnostics: CPU load, RAM usage, core count, and uptime. Use when the user asks about their computer's performance, load, memory, or system health.",
    parameters: {
        type: "OBJECT",
        properties: {},
    },
};

const rememberFactTool = {
    name: "remember_fact",
    description: "Store a fact, note, decision, or piece of information into Jarvis's persistent long-term memory. Use when the user says 'remember that...', 'note this down', 'save this', or shares durable personal/project information worth keeping. Also extract any entities and relationships mentioned.",
    parameters: {
        type: "OBJECT",
        properties: {
            content: { type: "STRING", description: "The fact or information to store, written as a complete standalone statement." },
            entities: {
                type: "ARRAY",
                description: "Named entities mentioned (people, companies, projects, files).",
                items: {
                    type: "OBJECT",
                    properties: {
                        name: { type: "STRING" },
                        type: { type: "STRING", description: "person | company | project | file | thing" }
                    },
                    required: ["name"]
                }
            },
            relations: {
                type: "ARRAY",
                description: "Relationships between entities, e.g. {subject: 'Ashutosh', relation: 'works_on', object: 'FurlPay'}.",
                items: {
                    type: "OBJECT",
                    properties: {
                        subject: { type: "STRING" },
                        relation: { type: "STRING" },
                        object: { type: "STRING" }
                    },
                    required: ["subject", "relation", "object"]
                }
            }
        },
        required: ["content"],
    },
};

const marketWatchlistTool = {
    name: "get_market_watchlist",
    description: "Read the user's stock/crypto watchlist with live prices, targets, and stop levels. Use when the user asks about their watchlist, portfolio watch, stock prices they track, or how their symbols are doing. READ-ONLY: you cannot place trades or modify the watchlist — the user manages it by voice commands themselves.",
    parameters: {
        type: "OBJECT",
        properties: {},
    },
};

const recallMemoryTool = {
    name: "recall_memory",
    description: "Search Jarvis's persistent long-term memory (facts, parsed documents, past notes, entity relationships). Use when the user asks about something previously discussed, stored, or scanned — 'what did I say about...', 'find my notes on...', 'do you remember...'. IMPORTANT: if the user's question is plural or open-ended, report ALL relevant results, not just the first.",
    parameters: {
        type: "OBJECT",
        properties: {
            query: { type: "STRING", description: "What to search for." }
        },
        required: ["query"],
    },
};

/**
 * Audio Streamer - Captures and streams microphone audio (Official Pattern)
 */
class AudioStreamer {
    constructor(onVolume, onAudio) {
        this.onVolume = onVolume;
        this.onAudio = onAudio;
        this.audioContext = null;
        this.audioWorklet = null;
        this.mediaStream = null;
        this.isStreaming = false;
        this.isMuted = false; // 🔥 FIX: Initialize as NOT muted
        this.sampleRate = 16000;
        console.log("🎙️ [INIT] AudioStreamer created, isMuted:", this.isMuted);
    }

    // Read audio-conditioning prefs saved by SettingsManager (localStorage)
    _getAudioSettings() {
        try {
            const stored = JSON.parse(localStorage.getItem('jarvis_settings') || '{}');
            return {
                echoCancellation: stored.echoCancellation !== false, // default ON: stops speaker output feeding back into the mic
                noiseSuppression: stored.noiseSuppression !== false, // default ON: filters fans/keystrokes
                autoGainControl: stored.autoGainControl === true,    // default OFF: preserves dynamics
            };
        } catch {
            return { echoCancellation: true, noiseSuppression: true, autoGainControl: false };
        }
    }

    async start() {
        try {
            console.log("🎙️ [START] Requesting microphone access...");
            const audioPrefs = this._getAudioSettings();
            this.mediaStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    sampleRate: this.sampleRate,
                    ...audioPrefs,
                },
            });
            console.log("🎙️ [START] Microphone access GRANTED");

            this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: this.sampleRate,
            });
            console.log("🎙️ [START] AudioContext created, state:", this.audioContext.state);

            // ✅ Bypass autoplay policy
            if (this.audioContext.state === 'suspended') {
                console.log("🎙️ [START] AudioContext suspended, resuming...");
                await this.audioContext.resume();
            }
            console.log("🎙️ [START] AudioContext state:", this.audioContext.state);

            await this.audioContext.audioWorklet.addModule(captureProcessorUrl);
            console.log("🎙️ [START] AudioWorklet module loaded");

            this.audioWorklet = new AudioWorkletNode(this.audioContext, "audio-capture-processor");
            console.log("🎙️ [START] AudioWorkletNode created, isMuted:", this.isMuted);

            this.audioWorklet.port.onmessage = (event) => {
                if (!this.isStreaming) return;

                if (event.data.type === "audio") {
                    const float32Array = event.data.data;

                    // Volume calculation (always calculate for visualization)
                    let sum = 0;
                    for (let i = 0; i < float32Array.length; i++) {
                        sum += float32Array[i] * float32Array[i];
                    }
                    const rms = Math.sqrt(sum / float32Array.length);
                    this.onVolume(rms * 100);

                    // Skip audio sending if muted (Push-to-Talk)
                    if (this.isMuted) {
                        // 🔇 VERBOSE: Log that we're muted and not sending
                        if (!this._mutedLogThrottle) {
                            console.log("🔇 [VERBOSE] Mic is MUTED - not sending audio");
                            this._mutedLogThrottle = true;
                            setTimeout(() => this._mutedLogThrottle = false, 3000);
                        }
                        return;
                    }

                    // 🎤 VERBOSE: Log that we're sending audio
                    if (!this._audioLogThrottle) {
                        console.log("🎤 [VERBOSE] Sending audio chunk to Gemini, size:", float32Array.length);
                        this._audioLogThrottle = true;
                        setTimeout(() => this._audioLogThrottle = false, 2000);
                    }

                    // Float32 to PCM16
                    const int16Array = new Int16Array(float32Array.length);
                    for (let i = 0; i < float32Array.length; i++) {
                        const sample = Math.max(-1, Math.min(1, float32Array[i]));
                        int16Array[i] = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
                    }

                    const base64Audio = arrayBufferToBase64(int16Array.buffer);
                    this.onAudio(base64Audio);
                }
            };

            const source = this.audioContext.createMediaStreamSource(this.mediaStream);

            // ✅ Low-cut filter: roll off sub-80Hz rumble (desk vibration, HVAC)
            // before the audio ever reaches the encoder.
            this.lowCutFilter = this.audioContext.createBiquadFilter();
            this.lowCutFilter.type = 'highpass';
            this.lowCutFilter.frequency.value = 80;
            this.lowCutFilter.Q.value = 0.707;

            // ✅ Gentle compressor: evens out loud/quiet speech before encoding
            // (broadcast-style levelling — no pumping at these settings)
            this.compressor = this.audioContext.createDynamicsCompressor();
            this.compressor.threshold.value = -24;
            this.compressor.knee.value = 30;
            this.compressor.ratio.value = 4;
            this.compressor.attack.value = 0.003;
            this.compressor.release.value = 0.25;

            // ✅ FFT Analyser: real frequency-band data for the visualizer
            // (replaces the flat RMS number — the sphere can now react to
            // sibilants vs bass differently). Exposed globally for scripts.js.
            this.analyser = this.audioContext.createAnalyser();
            this.analyser.fftSize = 256;
            this.analyser.smoothingTimeConstant = 0.75;
            this.frequencyData = new Uint8Array(this.analyser.frequencyBinCount);
            window.jarvisAnalyser = this.analyser;
            window.jarvisFrequencyData = this.frequencyData;

            source.connect(this.lowCutFilter);
            this.lowCutFilter.connect(this.compressor);
            this.compressor.connect(this.audioWorklet);
            this.lowCutFilter.connect(this.analyser); // parallel tap — analysis only (pre-compression)

            // ✅ FIX: Routing mic-to-speaker causes echo and latency. Use a silent gain node.
            const silentGain = this.audioContext.createGain();
            silentGain.gain.value = 0;
            this.audioWorklet.connect(silentGain);
            silentGain.connect(this.audioContext.destination);

            this.isStreaming = true;
            this.isMuted = false;
            console.log("LiveService: Audio capture started");
        } catch (error) {
            console.error("LiveService: Failed to start audio capture", error);
            throw error;
        }
    }

    // Push-to-Talk: Mute microphone (stop sending audio)
    mute() {
        this.isMuted = true;
        console.log("🔇 [VERBOSE] AudioStreamer: Microphone MUTED");
    }

    // Push-to-Talk: Unmute microphone (resume sending audio)
    unmute() {
        this.isMuted = false;
        console.log("🎤 [VERBOSE] AudioStreamer: Microphone UNMUTED - now sending audio");
    }

    stop() {
        this.isStreaming = false;
        this.isMuted = false;
        if (this.analyser) {
            this.analyser.disconnect();
            this.analyser = null;
            window.jarvisAnalyser = null;
        }
        if (this.compressor) {
            this.compressor.disconnect();
            this.compressor = null;
        }
        if (this.lowCutFilter) {
            this.lowCutFilter.disconnect();
            this.lowCutFilter = null;
        }
        if (this.audioWorklet) {
            this.audioWorklet.disconnect();
            this.audioWorklet = null;
        }
        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
        }
        if (this.mediaStream) {
            this.mediaStream.getTracks().forEach((track) => track.stop());
            this.mediaStream = null;
        }
    }
}

/**
 * Audio Player - Plays audio responses (Official Pattern)
 */
class AudioPlayer {
    constructor() {
        this.audioContext = null;
        this.workletNode = null;
        this.isInitialized = false;
        this.sampleRate = 24000;
    }

    async init() {
        if (this.isInitialized) return;
        try {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: this.sampleRate,
            });

            await this.audioContext.audioWorklet.addModule(playbackProcessorUrl);
            this.workletNode = new AudioWorkletNode(this.audioContext, "audio-playback-processor");
            this.workletNode.connect(this.audioContext.destination);
            this.isInitialized = true;
        } catch (error) {
            console.error("LiveService: Failed to init audio player", error);
        }
    }

    async play(base64Audio) {
        if (!this.isInitialized) await this.init();
        if (this.audioContext.state === "suspended") await this.audioContext.resume();

        const binaryString = atob(base64Audio);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }

        const inputArray = new Int16Array(bytes.buffer);
        const float32Data = new Float32Array(inputArray.length);
        for (let i = 0; i < inputArray.length; i++) {
            float32Data[i] = inputArray[i] / 32768;
        }

        this.workletNode.port.postMessage(float32Data);
    }

    interrupt() {
        if (this.workletNode) {
            this.workletNode.port.postMessage("interrupt");
        }
    }

    stop() {
        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
        }
        this.isInitialized = false;
    }
}

export class LiveService {
    constructor() {
        const apiKey = config.geminiApiKey;
        console.log("LiveService: Initializing with Refined Implementation");

        try {
            this.ai = new GoogleGenAI({ apiKey });
        } catch (e) {
            console.error("LiveService: SDK initialization failed", e);
        }

        this.session = null;
        this.streamer = null;
        this.player = new AudioPlayer();
        this.currentCameraFrame = null;
        this.isConnected = false;

        this.onStateChange = () => { };
        this.onMessage = () => { };
        this.onVolume = () => { };

        // Bind for camera framing
        this.lastFrameTime = 0;
        this.retryCount = 0;
        this.maxRetries = 5;
        this.retryDelay = 2000; // Starting delay 2s
    }

    updateCameraFrame(base64) {
        this.currentCameraFrame = base64;

        // Throttling vision to ~1 FPS for quota safety (standard demo pattern)
        const now = Date.now();
        if (now - this.lastFrameTime < 1000) return;
        this.lastFrameTime = now;

        // Only send if connected and NOT in a retry cooldown
        if (this.isSessionLive() && this.retryCount === 0) {
            const imageBase64 = base64.replace(/^data:image\/[a-z]+;base64,/, "");
            this.session.sendRealtimeInput({
                media: [{
                    mimeType: 'image/jpeg',
                    data: imageBase64
                }]
            });
        }
    }

    isSessionLive() {
        return this.session && this.isConnected;
    }

    async disconnect() {
        console.log("LiveService: Manually disconnecting...");
        this.manualDisconnect = true; // suppress always-on auto-reconnect
        if (this.session) {
            this.session.close();
            this.session = null;
        }
        this.isConnected = false;
        this.onStateChange('DISCONNECTED');
        this.stopAll();
        this.retryCount = 0; // Reset retries on manual disconnect
    }

    async connect() {
        this.retryCount = 0; // Reset on manual connect
        this.manualDisconnect = false;
        await this._connectInternal();
    }

    async _connectInternal() {
        if (this.isConnected) return;

        // No Gemini key -> cloud voice is disabled; stay offline quietly
        // instead of spinning the reconnect loop against a dead endpoint.
        if (!config.geminiApiKey || config.geminiApiKey.startsWith('YOUR_')) {
            console.warn('LiveService: no Gemini API key - cloud voice disabled, local mode only');
            this.onStateChange('DISCONNECTED');
            return;
        }
        this.onStateChange('CONNECTING');

        try {
            await this.player.init();

            this.streamer = new AudioStreamer(
                (vol) => this.onVolume(vol),
                (base64) => {
                    if (this.isSessionLive()) {
                        this.session.sendRealtimeInput({
                            media: [{
                                mimeType: 'audio/pcm;rate=16000',
                                data: base64
                            }]
                        });
                    }
                }
            );

            console.log("LiveService: Connecting to Gemini Live...");

            this.session = await this.ai.live.connect({
                model: "gemini-2.0-flash-exp",
                callbacks: {
                    onopen: () => {
                        console.log("LiveService: Session opened");
                        this.isConnected = true;
                        this.onStateChange('CONNECTED');
                        this.streamer.start().catch(e => console.error("Mic start failed", e));

                        // Reset retries only after 10 seconds of stable connection
                        this.stableConnectionTimeout = setTimeout(() => {
                            if (this.isConnected) {
                                console.log("LiveService: Connection stable, resetting retries");
                                this.retryCount = 0;
                                this.retryDelay = 2000;
                            }
                        }, 10000);
                    },
                    onmessage: (msg) => this.handleMessage(msg),
                    onclose: (reason) => {
                        console.log("LiveService: Session closed", reason);

                        this.isConnected = false;
                        this.onStateChange('DISCONNECTED');
                        this.stopAll();

                        // ALWAYS-ON: unexpected closes self-heal with capped backoff.
                        // Only a manual disconnect stays disconnected.
                        if (!this.manualDisconnect) {
                            this.handleRetry();
                        }
                    },
                    onerror: (err) => {
                        console.error("LiveService: Session error", err);
                        this.onStateChange('ERROR');
                        this.stopAll();
                    }
                },
                config: {
                    responseModalities: ["audio"],
                    inputAudioTranscription: {},
                    speechConfig: {
                        voiceConfig: {
                            prebuiltVoiceConfig: {
                                voiceName: "Aoede"
                            }
                        }
                    },
                    systemInstruction: {
                        parts: [{ text: "You are Jarvis, a highly advanced AI assistant. You are helpful, precise, and have a futuristic personality. \n\nCRITICAL RULES:\n1. If the user asks to 'create', 'generate', or 'draw' an image from scratch, you MUST use the `create_illustration` tool.\n2. If the user asks to 'take a photo', 'capture me', 'selfie', 'picture of me', or 'reimagine' them, you MUST use the `reimagine_user` tool. Do NOT just describe the video feed textually. You must generate an actual image using the tool.\n3. For real-time information, current events, or world facts, proactively use the Google Search grounding capability to provide accurate, up-to-date answers instantly.\n4. If the user asks to read, scan, parse, or extract text from a document FILE (PDF, image, invoice, paper), use the `parse_document_ocr` tool with the file's absolute path.\n5. If the user asks to read or OCR their SCREEN ('what's on my screen', 'read this error'), use the `ocr_screen` tool.\n6. If the user asks about their computer's performance, CPU, RAM, or system health, use the `get_system_status` tool and report the numbers.\n7. If the user shares information worth keeping ('remember that...', durable facts about their projects/preferences), use `remember_fact` — include entities and relations. If they ask about past information ('what did I say about...', 'find my notes on...'), use `recall_memory`. When a recall question is plural or open-ended, enumerate ALL relevant results, not just the top one.\n8. Always confirm verbally when you are about to perform an action (e.g., 'Scanning that document now...'). Document parsing can take up to a minute — tell the user you're working on it." }]
                    },
                    tools: [
                        { googleSearchRetrieval: {} },
                        { functionDeclarations: [createTool, reimagineTool, parseDocumentOcrTool, ocrScreenTool, systemStatusTool, rememberFactTool, recallMemoryTool, marketWatchlistTool] }
                    ]
                }
            });

        } catch (error) {
            console.error("LiveService: Connection failed", error);
            this.onStateChange('ERROR');
            if (!this.manualDisconnect) {
                this.handleRetry();
            }
        }
    }

    handleRetry() {
        this.retryCount++;
        // Capped exponential backoff (max 30s) — the session keeps trying
        // forever so Jarvis stays "always listening" through network blips.
        const delay = Math.min(this.retryDelay * Math.pow(2, this.retryCount - 1), 30000);
        console.warn(`LiveService: Connection lost. Reconnecting in ${delay}ms (attempt ${this.retryCount})`);
        this.onStateChange('RETRYING');

        setTimeout(() => {
            if (!this.manualDisconnect) this._connectInternal();
        }, delay);
    }

    stopAll() {
        if (this.stableConnectionTimeout) {
            clearTimeout(this.stableConnectionTimeout);
        }
        if (this.streamer) this.streamer.stop();
        if (this.player) {
            this.player.interrupt();
            this.player.stop();
        }
        this.isConnected = false;
    }

    // Push-to-Talk: Mute microphone
    muteMic() {
        if (this.streamer) {
            this.streamer.mute();
        }
    }

    // Push-to-Talk: Unmute microphone
    unmuteMic() {
        if (this.streamer) {
            this.streamer.unmute();
        }
    }

    // Check if mic is muted
    get isMicMuted() {
        return this.streamer ? this.streamer.isMuted : true;
    }

    sendText(text) {
        if (this.isSessionLive()) {
            this.session.sendClientContent({
                turns: [{
                    role: 'user',
                    parts: [{ text }]
                }],
                turnComplete: true
            });
        }
    }

    // 🔥 NEW: Explicitly end turn for near-zero latency response
    sendTurnComplete() {
        if (this.isSessionLive()) {
            console.log("🎙️ [SEND] Manually finalizing turn...");
            this.session.sendClientContent({
                turns: [{ role: "user", parts: [{ text: "" }] }],
                turnComplete: true
            });
        }
    }

    async handleMessage(message) {
        // Handle Setup Complete
        if (message.setupComplete) {
            console.log("LiveService: Setup complete");
            return;
        }

        // Handle Real-time User Speech Transcription (display as user speaks)
        if (message.serverContent?.inputTranscript) {
            const transcript = message.serverContent.inputTranscript;
            console.log("LiveService: User transcript:", transcript);
            // Display user's speech in real-time
            this.onMessage({ role: 'user', text: transcript, isTranscript: true });
        }

        // Handle Real-time AI Output Transcription
        if (message.serverContent?.outputTranscript) {
            const transcript = message.serverContent.outputTranscript;
            console.log("LiveService: AI transcript:", transcript);
            // This arrives with audio, so text will also be shown
        }

        // Handle Interrupted
        if (message.serverContent?.interrupted) {
            console.log("LiveService: Interrupted by user");
            this.player.interrupt();
            return;
        }

        // Handle Tool Calls
        if (message.toolCall) {
            for (const fc of message.toolCall.functionCalls) {
                let result = { result: "ok" };
                const startedAt = Date.now();

                try {
                    if (fc.name === "create_illustration") {
                        this.onMessage({ role: 'model', text: `Initiating visual cortex for: ${fc.args.prompt}...` });
                        this.setMediaLoading(true);
                        generateImage(fc.args.prompt).then(imgResult => {
                            this.setMediaLoading(false);
                            if (imgResult.imageUrl) {
                                this.updateMediaDisplay(imgResult.imageUrl);
                                this.onMessage({ role: 'system', text: fc.args.prompt, metadata: { type: 'image_gen', image: imgResult.imageUrl } });
                            }
                        });
                        result = { result: "Image generation started. Inform user it will be ready shortly." };

                    } else if (fc.name === "reimagine_user") {
                        const currentFrame = this.currentCameraFrame;
                        if (!currentFrame) {
                            result = { error: "Camera frame not available." };
                            this.onMessage({ role: 'system', text: `Error: Camera frame missing.` });
                        } else {
                            const promptText = fc.args.prompt || "A high quality professional portrait of the person";
                            this.onMessage({ role: 'model', text: `Processing your image with prompt: "${promptText}"...` });
                            this.setMediaLoading(true);
                            const rawBase64 = currentFrame.replace(/^data:image\/\w+;base64,/, "");

                            reimagineImage(rawBase64, promptText).then(imgResult => {
                                this.setMediaLoading(false);
                                if (imgResult.imageUrl) {
                                    this.updateMediaDisplay(imgResult.imageUrl);
                                    this.onMessage({ role: 'system', text: promptText, metadata: { type: 'reimagine', image: imgResult.imageUrl } });
                                }
                            });
                            result = { result: "Photo captured and processing." };
                        }

                    } else if (fc.name === "parse_document_ocr") {
                        const filePath = fc.args.filePath;
                        this.onMessage({ role: 'model', text: `Parsing document: ${filePath}...` });
                        if (!window.electronAPI?.performOCR) {
                            result = { error: "OCR bridge not available in this environment." };
                        } else {
                            // Long-horizon parsing can take a while — defer the tool response
                            result = null;
                            window.electronAPI.performOCR({ filePath }).then(ocr => {
                                if (ocr.success) {
                                    this.onMessage({
                                        role: 'system',
                                        text: `Document parsed (${ocr.pages} page${ocr.pages > 1 ? 's' : ''}, ${ocr.mode} mode)`,
                                        metadata: { type: 'ocr_markdown', content: ocr.markdown, source: filePath }
                                    });
                                    // Auto-ingest into long-term memory: parsed docs become recallable
                                    ragService.ingest(ocr.markdown, { source: filePath })
                                        .catch(e => console.warn('RAG ingest of OCR failed:', e));
                                    this._sendToolResult(fc, { parsed_content: ocr.markdown });
                                } else {
                                    this.onMessage({ role: 'system', text: `OCR failed: ${ocr.error}` });
                                    this._sendToolResult(fc, { error: ocr.error });
                                }
                            }).catch(e => this._sendToolResult(fc, { error: e.message }));
                        }

                    } else if (fc.name === "ocr_screen") {
                        this.onMessage({ role: 'model', text: `Scanning your screen...` });
                        if (!window.electronAPI?.captureScreen) {
                            result = { error: "Screen capture bridge not available." };
                        } else {
                            result = null;
                            window.electronAPI.captureScreen().then(cap => {
                                if (!cap?.success) throw new Error(cap?.error || 'Screen capture failed');
                                return window.electronAPI.performOCR({ imageBase64: cap.image, mode: 'gundam' });
                            }).then(ocr => {
                                if (ocr.success) {
                                    this.onMessage({
                                        role: 'system',
                                        text: 'Screen parsed',
                                        metadata: { type: 'ocr_markdown', content: ocr.markdown, source: 'screen' }
                                    });
                                    ragService.ingest(ocr.markdown, { source: `screen-${new Date().toISOString().slice(0, 10)}` })
                                        .catch(e => console.warn('RAG ingest of screen OCR failed:', e));
                                    this._sendToolResult(fc, { screen_content: ocr.markdown });
                                } else {
                                    this.onMessage({ role: 'system', text: `Screen OCR failed: ${ocr.error}` });
                                    this._sendToolResult(fc, { error: ocr.error });
                                }
                            }).catch(e => this._sendToolResult(fc, { error: e.message }));
                        }

                    } else if (fc.name === "get_system_status") {
                        if (!window.electronAPI?.getSystemTelemetry) {
                            result = { error: "Telemetry bridge not available." };
                        } else {
                            const t = await window.electronAPI.getSystemTelemetry();
                            result = {
                                cpu_load_percent: t.cpu,
                                ram_used_gb: t.memUsedGb,
                                ram_total_gb: t.memTotalGb,
                                ram_percent: t.memPercent,
                                cpu_cores: t.cores,
                                uptime_hours: t.uptimeHours,
                                active_window: t.activeWindow?.app
                                    ? `${t.activeWindow.app}: ${t.activeWindow.title}`
                                    : 'unknown'
                            };
                        }

                    } else if (fc.name === "remember_fact") {
                        const { stored, deduped } = await ragService.ingest(fc.args.content, {
                            source: 'voice-note',
                            entities: fc.args.entities,
                            relations: fc.args.relations,
                        });
                        this.onMessage({ role: 'system', text: `Memory stored: ${fc.args.content.slice(0, 80)}${fc.args.content.length > 80 ? '…' : ''}` });
                        result = { status: stored ? "stored" : (deduped ? "already known" : "stored"), memory_stats: ragService.stats() };

                    } else if (fc.name === "get_market_watchlist") {
                        if (!window.electronAPI?.watchlistGet) {
                            result = { error: "Watchlist bridge not available." };
                        } else {
                            const list = await window.electronAPI.watchlistGet();
                            result = {
                                watchlist: list.map(item => ({
                                    symbol: item.symbol,
                                    price: item.quote?.price ?? null,
                                    currency: item.quote?.currency ?? 'USD',
                                    target: item.target,
                                    stop: item.stop
                                })),
                                note: "Read-only data. Trading is not possible through this system."
                            };
                        }

                    } else if (fc.name === "recall_memory") {
                        const { context, results } = await ragService.recall(fc.args.query);
                        if (results.length || context) {
                            result = { recalled: context, result_count: results.length };
                        } else {
                            result = { recalled: "", result_count: 0, note: "Nothing in memory matches this query." };
                        }
                    }

                    // result === null means the tool defers its response until its async work finishes
                    if (result !== null) {
                        this._logTrajectory(fc, result, startedAt);
                        if (this.isSessionLive()) {
                            this.session.sendToolResponse({
                                functionResponses: [{
                                    id: fc.id,
                                    name: fc.name,
                                    response: result
                                }]
                            });
                        }
                    } else {
                        // Deferred tools log their outcome in _sendToolResult
                        fc._startedAt = startedAt;
                    }
                } catch (e) {
                    console.error("Tool execution error:", e);
                    this._logTrajectory(fc, { error: e.message }, startedAt);
                }
            }
        }

        // Handle Server Content (Audio/Text + Grounding)
        const parts = message.serverContent?.modelTurn?.parts;
        if (parts) {
            for (const part of parts) {
                if (part.inlineData) {
                    this.player.play(part.inlineData.data);
                }
                if (part.text) {
                    this.onMessage({ role: 'model', text: part.text });
                }
            }
        }

        // Extract grounding metadata if available (Search Results)
        const groundingMetadata = message.serverContent?.modelTurn?.groundingMetadata;
        if (groundingMetadata) {
            console.log("LiveService: Grounding Metadata received", groundingMetadata);
            const sources = (groundingMetadata.groundingChunks || [])
                .map(chunk => chunk.web)
                .filter(web => web && web.uri && web.title)
                .map(web => ({ title: web.title, uri: web.uri }));

            if (sources.length > 0) {
                this.onMessage({
                    role: 'system',
                    text: "Grounded Intelligence Sources",
                    metadata: { type: 'search', sources }
                });
            }
        }
    }

    // Send a deferred tool response (used by long-running tools like OCR)
    _sendToolResult(fc, response) {
        this._logTrajectory(fc, response, fc._startedAt || Date.now());
        if (this.isSessionLive()) {
            this.session.sendToolResponse({
                functionResponses: [{
                    id: fc.id,
                    name: fc.name,
                    response
                }]
            });
        }
    }

    // ATDP-lite trajectory event (arXiv:2607.01120): observation → action →
    // outcome → latency, persisted as JSONL for future learning/replay.
    _logTrajectory(fc, response, startedAt) {
        if (!window.electronAPI?.logTrajectory) return;
        const truncate = (obj) => {
            const s = JSON.stringify(obj) || '';
            return s.length > 500 ? s.slice(0, 500) + '…' : s;
        };
        window.electronAPI.logTrajectory({
            action: fc.name,
            args: truncate(fc.args || {}),
            outcome: truncate(response),
            success: !response?.error,
            latencyMs: Date.now() - startedAt,
        }).catch(() => { /* never break the agent loop */ });
    }

    setMediaLoading(isLoading) {
        const container = document.getElementById('media-output-container');
        if (container) {
            if (isLoading) {
                container.classList.add('active', 'loading');
            } else {
                container.classList.remove('loading');
            }
        }
    }

    updateMediaDisplay(imageUrl) {
        const container = document.getElementById('media-output-container');
        const img = document.getElementById('media-image');
        if (container && img) {
            img.src = imageUrl;
            container.classList.add('active');
        }
    }
}
