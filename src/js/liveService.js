import { GoogleGenAI } from "@google/genai";
import {
    base64ToUint8Array,
    arrayBufferToBase64,
} from "./audioUtils.js";
import { performSearch, generateImage, reimagineImage } from "./toolService.js";
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

    async start() {
        try {
            console.log("🎙️ [START] Requesting microphone access...");
            this.mediaStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    sampleRate: this.sampleRate,
                    // ✅ OPTIMIZATION: Disable all browser-level processing for near-zero latency
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false,
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
            source.connect(this.audioWorklet);

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
        await this._connectInternal();
    }

    async _connectInternal() {
        if (this.isConnected) return;
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
                        const wasExceeded = reason?.reason?.includes("quota") || reason?.code === 1011;

                        this.isConnected = false;
                        this.onStateChange('DISCONNECTED');
                        this.stopAll();
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
                        parts: [{ text: "You are Jarvis, a highly advanced AI assistant. You are helpful, precise, and have a futuristic personality. \n\nCRITICAL RULES:\n1. If the user asks to 'create', 'generate', or 'draw' an image from scratch, you MUST use the `create_illustration` tool.\n2. If the user asks to 'take a photo', 'capture me', 'selfie', 'picture of me', or 'reimagine' them, you MUST use the `reimagine_user` tool. Do NOT just describe the video feed textually. You must generate an actual image using the tool.\n3. For real-time information, current events, or world facts, proactively use the Google Search grounding capability to provide accurate, up-to-date answers instantly.\n4. Always confirm verbally when you are about to perform an action (e.g., 'Capturing that for you now...')." }]
                    },
                    tools: [
                        { googleSearchRetrieval: {} },
                        { functionDeclarations: [createTool, reimagineTool] }
                    ]
                }
            });

        } catch (error) {
            console.error("LiveService: Connection failed", error);
            this.onStateChange('ERROR');
            if (this.retryCount < this.maxRetries) {
                this.handleRetry();
            }
        }
    }

    handleRetry() {
        this.retryCount++;
        const delay = this.retryDelay * Math.pow(2, this.retryCount - 1);
        console.warn(`LiveService: Quota exceeded or connection lost. Retrying in ${delay}ms (Attempt ${this.retryCount}/${this.maxRetries})`);
        this.onStateChange('RETRYING');

        setTimeout(() => {
            this._connectInternal();
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
                    }

                    if (this.isSessionLive()) {
                        this.session.sendToolResponse({
                            functionResponses: [{
                                id: fc.id,
                                name: fc.name,
                                response: result
                            }]
                        });
                    }
                } catch (e) {
                    console.error("Tool execution error:", e);
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
