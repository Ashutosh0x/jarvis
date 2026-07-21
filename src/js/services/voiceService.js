/**
 * Jarvis Local Voice Service - always-on microphone loop, fully offline.
 *
 * Pipeline:
 *   mic (echo cancellation + noise suppression + AGC off)
 *     -> 80 Hz low-cut -> AudioWorklet 16 kHz PCM frames (16 ms each)
 *       -> adaptive energy VAD (noise-floor tracking, pre-roll, hangover)
 *         -> one utterance = one WebSocket send to the local faster-whisper
 *            server (ws://127.0.0.1:8770) -> transcript callback
 *
 * Design notes:
 * - The VAD is gated while Jarvis's own TTS is speaking: Windows SAPI audio
 *   bypasses Chromium's echo canceller reference, so without the gate Jarvis
 *   would hear and transcribe itself. Trade-off: no barge-in over TTS yet.
 * - If the STT server is down, the loop idles quietly and retries every 10 s;
 *   the mic itself stays hot so recovery is instant.
 */

import captureProcessorUrl from '../capture-processor.js?url';

const STT_URL = 'ws://127.0.0.1:8770';
const FRAME_MS = 16;                 // 256 samples @ 16 kHz
const PRE_ROLL_FRAMES = 20;          // 320 ms kept before speech onset
const HANGOVER_FRAMES = 90;          // 1.44 s of silence ends the utterance
                                     // (880 ms cut users off mid-thought in
                                     // conversational speech — live-tested)
const MAX_UTTERANCE_FRAMES = 1875;   // 30 s hard cap

export class LocalVoiceService {
    constructor({ onTranscript, onVolume, onStatus, isTtsSpeaking }) {
        this.onTranscript = onTranscript || (() => {});
        this.onVolume = onVolume || (() => {});
        this.onStatus = onStatus || (() => {});
        this.isTtsSpeaking = isTtsSpeaking || (() => false);

        this.ws = null;
        this.wsReady = false;
        this.audioContext = null;
        this.mediaStream = null;
        this.running = false;

        // VAD state
        this.noiseFloor = 0.004;     // adapts upward/downward with the room
        this.speaking = false;
        this.silenceFrames = 0;
        this.speechFrames = 0;
        this.preRoll = [];           // ring buffer of recent Int16Array frames
        this.utterance = [];         // frames of the current utterance
        this.ttsTailUntil = 0;       // ignore mic briefly after TTS stops
    }

    /* ---------------- WebSocket to the local STT server ---------------- */

    _connectWs() {
        if (this.ws) try { this.ws.close(); } catch { /* noop */ }
        this.ws = new WebSocket(STT_URL);
        this.ws.binaryType = 'arraybuffer';

        this.ws.onopen = () => {
            this.wsReady = true;
            this.onStatus('stt-connected');
            console.log('LocalVoice: STT server connected');
        };
        this.ws.onmessage = (e) => {
            try {
                const msg = JSON.parse(e.data);
                if (msg.type === 'final' && msg.text) {
                    console.log(`LocalVoice: [${msg.ms}ms] "${msg.text}"`);
                    // The server already reports how long transcription took;
                    // pass it on so the turn profile can attribute it rather
                    // than leaving STT as an unmeasured gap.
                    this.onTranscript(msg.text, { sttMs: msg.ms });
                }
            } catch { /* ignore malformed frames */ }
        };
        this.ws.onclose = () => {
            this.wsReady = false;
            this.onStatus('stt-disconnected');
            if (this.running) setTimeout(() => this._connectWs(), 10000);
        };
        this.ws.onerror = () => { /* onclose handles retry */ };
    }

    /* ---------------- Microphone + VAD loop ---------------- */

    async start() {
        if (this.running) return;
        this.running = true;
        this._connectWs();

        // Follow the OS default mic: when a headset/earbuds connect or
        // disconnect, restart capture on the new default device. Without
        // this, the stream stays pinned to whatever mic existed at startup.
        if (!this._deviceListener) {
            this._deviceListener = () => {
                clearTimeout(this._deviceDebounce);
                this._deviceDebounce = setTimeout(() => {
                    if (!this.running) return;
                    console.log('LocalVoice: audio devices changed - restarting mic capture');
                    this.onStatus('mic-switching');
                    this._restartMic();
                }, 1500);
            };
            navigator.mediaDevices.addEventListener('devicechange', this._deviceListener);
        }

        await this._startMic();
    }

    async _restartMic() {
        if (this._restarting) return; // collapse overlapping restart triggers
        this._restarting = true;
        try {
            try {
                if (this.mediaStream) this.mediaStream.getTracks().forEach(t => t.stop());
                if (this.audioContext) await this.audioContext.close();
            } catch { /* noop */ }
            this.mediaStream = null;
            this.audioContext = null;
            this._resetVad();

            // RETRY UNTIL ALIVE: a Bluetooth profile switch (A2DP<->HFP when
            // TTS plays to earbuds) makes getUserMedia fail transiently while
            // the device is mid-transition. One failed attempt must never
            // leave the mic permanently dead — root cause of the Jul 20 outage.
            let attempt = 0;
            while (this.running) {
                try {
                    await this._startMic();
                    console.log(`LocalVoice: mic recovered (attempt ${attempt + 1})`);
                    return;
                } catch (e) {
                    attempt++;
                    console.warn(`LocalVoice: mic restart attempt ${attempt} failed:`, e.name || e.message);
                    this.onStatus(`mic-error:${e.name || 'retrying'}`);
                    await new Promise(r => setTimeout(r, Math.min(3000 + attempt * 2000, 15000)));
                }
            }
        } finally {
            this._restarting = false;
        }
    }

    /**
     * Deliberate microphone selection. Never trust the OS default blindly:
     * "Stereo Mix" style loopback devices record the SYSTEM'S OWN OUTPUT —
     * picking one makes Jarvis listen to itself instead of the user.
     *
     * Ranking: user preference (settings.micPreference: 'headset'|'internal')
     * -> headset/earbuds -> internal mic -> any real input. Virtual/loopback
     * devices are excluded outright.
     */
    async _pickMicDevice() {
        let devices = await navigator.mediaDevices.enumerateDevices();
        // Labels are empty until mic permission has been granted once —
        // prime with a throwaway stream, then enumerate again.
        if (!devices.some(d => d.kind === 'audioinput' && d.label)) {
            try {
                const prime = await navigator.mediaDevices.getUserMedia({ audio: true });
                prime.getTracks().forEach(t => t.stop());
                devices = await navigator.mediaDevices.enumerateDevices();
            } catch { /* selection falls back to default below */ }
        }

        const VIRTUAL = /stereo mix|what u hear|loopback|virtual|vb-audio|cable (output|input)|voicemeeter/i;
        const HEADSET = /buds|headset|hands-?free|earphone|airpod|neckband/i;
        const INTERNAL = /microphone array|built-?in|internal|realtek/i;

        const inputs = devices.filter(d =>
            d.kind === 'audioinput' &&
            d.deviceId !== 'default' && d.deviceId !== 'communications' &&
            d.label && !VIRTUAL.test(d.label)
        );
        if (!inputs.length) return null; // let the OS decide as last resort

        let pref = 'auto';
        try { pref = JSON.parse(localStorage.getItem('jarvis_settings') || '{}').micPreference || 'auto'; } catch { /* auto */ }

        const headset = inputs.find(d => HEADSET.test(d.label));
        const internal = inputs.find(d => INTERNAL.test(d.label));

        if (pref === 'headset') return headset || internal || inputs[0];
        if (pref === 'internal') return internal || inputs[0];
        return headset || internal || inputs[0];
    }

    async _startMic() {
        try {
            const device = await this._pickMicDevice();
            this.currentMicLabel = device?.label || 'system default';
            console.log(`LocalVoice: selected microphone -> ${this.currentMicLabel}`);

            this.mediaStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    ...(device ? { deviceId: { exact: device.deviceId } } : {}),
                    sampleRate: 16000,
                    channelCount: 1,
                    echoCancellation: true,
                    noiseSuppression: true,
                    // AGC ON: quiet laptop/headset mics otherwise sit below the
                    // VAD threshold and Jarvis appears deaf.
                    autoGainControl: true,
                },
            });
        } catch (e) {
            this.onStatus(`mic-error:${e.name || 'unknown'}`);
            throw e;
        }

        this.audioContext = new AudioContext({ sampleRate: 16000 });
        if (this.audioContext.state === 'suspended') await this.audioContext.resume();
        await this.audioContext.audioWorklet.addModule(captureProcessorUrl);

        const source = this.audioContext.createMediaStreamSource(this.mediaStream);

        const lowCut = this.audioContext.createBiquadFilter();
        lowCut.type = 'highpass';
        lowCut.frequency.value = 80;

        const worklet = new AudioWorkletNode(this.audioContext, 'audio-capture-processor');
        worklet.port.onmessage = (event) => {
            if (event.data.type === 'audio') this._onFrame(event.data.data);
        };

        source.connect(lowCut);
        lowCut.connect(worklet);
        const sink = this.audioContext.createGain();
        sink.gain.value = 0;
        worklet.connect(sink);
        sink.connect(this.audioContext.destination);

        // Expose an analyser so the orb reacts to the mic in local mode too
        this.analyser = this.audioContext.createAnalyser();
        this.analyser.fftSize = 256;
        lowCut.connect(this.analyser);
        window.jarvisAnalyser = this.analyser;
        window.jarvisFrequencyData = new Uint8Array(this.analyser.frequencyBinCount);

        // Device-death listeners: the instant Windows kills the capture track
        // (BT profile switch, device unplug), restart immediately.
        const track = this.mediaStream.getAudioTracks()[0];
        if (track) {
            track.onended = () => {
                console.warn('LocalVoice: capture track ENDED - restarting');
                this._restartMic();
            };
            track.onmute = () => console.warn('LocalVoice: capture track muted');
        }

        // Frame-flow watchdog: some deaths fire no event at all — the track
        // looks "live" but frames stop flowing. If nothing arrives for 15 s,
        // force a restart. Also resumes a suspended AudioContext.
        this._lastFrameAt = Date.now();
        clearInterval(this._watchdog);
        this._watchdog = setInterval(() => {
            if (!this.running) return;
            if (this.audioContext?.state === 'suspended') {
                console.warn('LocalVoice: AudioContext suspended - resuming');
                this.audioContext.resume().catch(() => {});
            }
            if (Date.now() - this._lastFrameAt > 15000 && !this._restarting) {
                console.warn('LocalVoice: no audio frames for 15s - forcing mic restart');
                this.onStatus('mic-switching');
                this._restartMic();
            }
        }, 5000);

        console.log('LocalVoice: always-on microphone active');
        this.onStatus(`mic-active:${this.currentMicLabel}`);
    }

    // Change mic preference ('headset' | 'internal' | 'auto') and re-acquire
    setMicPreference(pref) {
        try {
            const s = JSON.parse(localStorage.getItem('jarvis_settings') || '{}');
            s.micPreference = pref;
            localStorage.setItem('jarvis_settings', JSON.stringify(s));
        } catch { /* noop */ }
        this._restartMic();
    }

    _onFrame(float32) {
        this._lastFrameAt = Date.now(); // watchdog heartbeat

        // RMS energy of this 16 ms frame
        let sum = 0;
        for (let i = 0; i < float32.length; i++) sum += float32[i] * float32[i];
        const rms = Math.sqrt(sum / float32.length);
        this.onVolume(rms * 100);

        // Gate while Jarvis speaks (+400 ms tail) so it never hears itself
        if (this.isTtsSpeaking()) {
            this.ttsTailUntil = performance.now() + 400;
            this._resetVad();
            return;
        }
        if (performance.now() < this.ttsTailUntil) return;

        // Adaptive noise floor: fast decay down, slow creep up
        if (rms < this.noiseFloor) this.noiseFloor = this.noiseFloor * 0.9 + rms * 0.1;
        else this.noiseFloor = this.noiseFloor * 0.999 + rms * 0.001;
        const threshold = Math.max(this.noiseFloor * 3, 0.008);

        // Float32 -> Int16 frame
        const int16 = new Int16Array(float32.length);
        for (let i = 0; i < float32.length; i++) {
            const s = Math.max(-1, Math.min(1, float32[i]));
            int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }

        if (!this.speaking) {
            // Keep a rolling pre-roll so word onsets aren't clipped
            this.preRoll.push(int16);
            if (this.preRoll.length > PRE_ROLL_FRAMES) this.preRoll.shift();

            if (rms > threshold) {
                this.speechFrames++;
                if (this.speechFrames >= 3) { // ~50 ms of sustained energy
                    this.speaking = true;
                    this.silenceFrames = 0;
                    this.utterance = [...this.preRoll];
                    this.onStatus('listening');
                }
            } else {
                this.speechFrames = 0;
            }
        } else {
            this.utterance.push(int16);

            if (rms > threshold) this.silenceFrames = 0;
            else this.silenceFrames++;

            const tooLong = this.utterance.length >= MAX_UTTERANCE_FRAMES;
            if (this.silenceFrames >= HANGOVER_FRAMES || tooLong) {
                this._endUtterance();
            }
        }
    }

    _endUtterance() {
        const frames = this.utterance;
        this._resetVad();
        this.onStatus('processing');

        if (!this.wsReady || !frames.length) return;

        // Concatenate and ship the whole utterance, then signal the boundary
        const total = frames.reduce((n, f) => n + f.length, 0);
        const pcm = new Int16Array(total);
        let offset = 0;
        for (const f of frames) { pcm.set(f, offset); offset += f.length; }

        try {
            this.ws.send(pcm.buffer);
            this.ws.send(JSON.stringify({ type: 'end' }));
        } catch (e) {
            console.warn('LocalVoice: send failed', e);
        }
    }

    _resetVad() {
        this.speaking = false;
        this.speechFrames = 0;
        this.silenceFrames = 0;
        this.utterance = [];
        this.preRoll = [];
    }

    stop() {
        this.running = false;
        clearInterval(this._watchdog);
        if (this.ws) try { this.ws.close(); } catch { /* noop */ }
        if (this.audioContext) this.audioContext.close();
        if (this.mediaStream) this.mediaStream.getTracks().forEach(t => t.stop());
        this.audioContext = null;
        this.mediaStream = null;
    }
}
