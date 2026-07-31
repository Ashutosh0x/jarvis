/**
 * Jarvis Neural TTS Service — WebSocket client for the local TTS server.
 *
 * Architecture:
 *   text → WebSocket → tts-server.py (edge-tts neural voices)
 *     → MP3 chunks → WebSocket back → AudioContext.decodeAudioData
 *     → Float32Array → playback AudioWorklet ring buffer → speakers
 *
 * This replaces Windows SAPI with neural TTS that:
 *   - Sounds natural (Microsoft Azure neural voices, 47+ English)
 *   - Streams MP3 chunks for low time-to-first-audio
 *   - Routes through WebAudio (enables AEC, fixes echo)
 *   - Supports interrupt for barge-in
 *
 * Falls back to SAPI if the TTS server is unavailable.
 */

import playbackProcessorUrl from '../playback-processor.js?url';

const TTS_URL = 'ws://127.0.0.1:8771';

export class NeuralTTSService {
    constructor({ onSpeakStart, onSpeakEnd, onStatus }) {
        this.onSpeakStart = onSpeakStart || (() => {});
        this.onSpeakEnd = onSpeakEnd || (() => {});
        this.onStatus = onStatus || (() => {});

        this.ws = null;
        this.wsReady = false;
        this.audioContext = null;
        this.workletNode = null;
        this.speaking = false;
        this.available = false;
        this._currentResolve = null;
        this._stopped = false;

        // Utterance identity. The server keeps streaming for a few frames
        // after an interrupt (the cancel and the socket race), and without an
        // id those late chunks decode and play — Jarvis goes quiet when
        // interrupted and then resumes talking. Audio is attributed to the
        // last `begin` frame seen and dropped unless it is the live utterance.
        this._nextId = 1;
        this._currentId = null;    // what we asked for
        this._streamId = null;     // what the server is currently sending

        // MP3 accumulation. Chunks are NOT decoded in isolation: an MP3 frame
        // straddles chunk boundaries, so a mid-stream slice either fails to
        // decode outright or drops the partial frames at both ends. The whole
        // utterance-so-far is re-decoded instead and only the newly revealed
        // tail is pushed, which is always a valid stream from byte zero.
        this._mp3Bytes = new Uint8Array(0);
        this._samplesPushed = 0;
        this._decodeTimer = null;
        this._decoding = false;
        this._awaitingDrain = false;
        this._drainTimer = null;
        this._lastUnderruns = 0;
        this._lastDrainConsumed = 0;
    }

    /* -------------------- WebSocket Connection -------------------- */

    async connect() {
        if (this.ws && this.wsReady) return true;
        this._stopped = false;

        return new Promise((resolve) => {
            try {
                this.ws = new WebSocket(TTS_URL);
                this.ws.binaryType = 'arraybuffer';

                this.ws.onopen = () => {
                    this.wsReady = true;
                    this.available = true;
                    this.onStatus('tts-connected');
                    console.log('NeuralTTS: server connected');
                    resolve(true);
                };

                this.ws.onmessage = (e) => this._handleMessage(e);

                this.ws.onclose = () => {
                    this.wsReady = false;
                    this.available = false;
                    this.onStatus('tts-disconnected');
                    // A socket that dies mid-utterance leaves speak() awaiting
                    // a 'done' that can never arrive. Settle it as a failure so
                    // the caller falls back to SAPI instead of the whole voice
                    // loop wedging on an unresolved promise.
                    this._settle(false);
                    if (!this._stopped) {
                        setTimeout(() => this.connect().catch(() => {}), 10000);
                    }
                };

                this.ws.onerror = () => {
                    this.wsReady = false;
                    this.available = false;
                    resolve(false);
                };

                setTimeout(() => {
                    if (!this.wsReady) resolve(false);
                }, 3000);
            } catch {
                resolve(false);
            }
        });
    }

    /* -------------------- Audio Playback Setup -------------------- */

    async _ensureAudio() {
        if (this.audioContext && this.workletNode) return;

        this.audioContext = new AudioContext({ sampleRate: 48000 });
        if (this.audioContext.state === 'suspended') {
            await this.audioContext.resume();
        }

        await this.audioContext.audioWorklet.addModule(playbackProcessorUrl);
        this.workletNode = new AudioWorkletNode(this.audioContext, 'audio-playback-processor');
        this.workletNode.port.onmessage = (e) => this._onWorkletMessage(e.data);
        this.workletNode.connect(this.audioContext.destination);

        console.log('NeuralTTS: WebAudio playback initialized (48kHz)');
    }

    /**
     * The worklet reports the moment the ring buffer empties. That — not the
     * arrival of the last MP3 byte — is when Jarvis has stopped talking, and
     * it is what releases the microphone gate.
     */
    _onWorkletMessage(msg) {
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'drained') {
            // Recorded even when nothing is waiting yet: the buffer can empty
            // while the final decode is still running, and that drain is the
            // one that ends the utterance. Without keeping it, the 'done'
            // handler waits for an event that has already been and gone and
            // the mic stays shut until the backstop fires.
            this._lastDrainConsumed = msg.consumed || 0;
            if (this._awaitingDrain && this._lastDrainConsumed >= this._samplesPushed) {
                this._finishUtterance();
            }
        } else if (msg.type === 'status' && msg.underruns > this._lastUnderruns) {
            // Underruns mean the decoder is not keeping ahead of playback:
            // audible gaps. Worth seeing rather than silently tolerating.
            this._lastUnderruns = msg.underruns;
            console.debug(`NeuralTTS: playback underruns=${msg.underruns}`);
        }
    }

    /* -------------------- Message Handling -------------------- */

    _handleMessage(event) {
        if (event.data instanceof ArrayBuffer) {
            // Binary frames belong to whichever utterance the last `begin`
            // announced. Anything from a superseded one is late audio from a
            // cancelled sentence and must not reach the speakers.
            if (this._streamId === null || this._streamId !== this._currentId) return;
            this._append(new Uint8Array(event.data));
            this._scheduleDecode();
            return;
        }

        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }

        switch (msg.type) {
            case 'begin':
                this._streamId = msg.id ?? null;
                break;

            case 'done':
                if (msg.id != null && msg.id !== this._currentId) break;
                console.log(`NeuralTTS: done in ${msg.ms}ms (${msg.bytes} bytes)`);
                // Decode the tail, then wait for the buffer to actually empty
                // before declaring the utterance over.
                this._flushDecode().then(() => {
                    if (this._samplesPushed === 0 ||
                        this._lastDrainConsumed >= this._samplesPushed) {
                        // Nothing decoded, or the buffer already ran dry while
                        // that last decode was in flight: no drain is coming.
                        this._finishUtterance();
                    } else {
                        this._awaitingDrain = true;
                        // Backstop: if the drain event is lost, the mic must
                        // still reopen. Sized off what is left in the buffer.
                        clearTimeout(this._drainTimer);
                        this._drainTimer = setTimeout(() => this._finishUtterance(), 15000);
                    }
                });
                break;

            case 'error':
                // Synthesis died — usually no route to the voice endpoint.
                // Resolving false is what triggers the SAPI fallback upstream,
                // so a failure here costs the user a nicer voice, not speech.
                if (msg.id != null && msg.id !== this._currentId) break;
                console.warn('NeuralTTS: server error —', msg.message);
                this._currentId = null;
                this._resetStream();
                this.speaking = false;
                this._settle(false);
                this.onSpeakEnd();
                break;

            case 'interrupted':
                // Server confirms the synthesis task is dead. The local flush
                // already happened in interrupt(); this just settles the wait.
                if (msg.id != null && msg.id !== this._currentId) break;
                this._settle(true);
                break;
        }
    }

    /** Ends the current utterance exactly once, releasing the mic gate. */
    _finishUtterance() {
        clearTimeout(this._drainTimer);
        this._awaitingDrain = false;
        this.speaking = false;
        this._settle(true);
        this.onSpeakEnd();
    }

    /** Resolves a pending speak() at most once. */
    _settle(ok) {
        const resolve = this._currentResolve;
        this._currentResolve = null;
        if (resolve) resolve(ok);
    }

    _append(bytes) {
        const merged = new Uint8Array(this._mp3Bytes.length + bytes.length);
        merged.set(this._mp3Bytes, 0);
        merged.set(bytes, this._mp3Bytes.length);
        this._mp3Bytes = merged;
    }

    /**
     * Batch decoding so a 40-byte frame does not trigger its own decode pass.
     */
    _scheduleDecode() {
        if (this._decodeTimer) return;
        this._decodeTimer = setTimeout(() => {
            this._decodeTimer = null;
            this._flushDecode();
        }, 150);
    }

    /**
     * Decode everything received so far and push only the samples that are
     * new since the last pass.
     *
     * Re-decoding from byte zero every time looks wasteful, and is: it is
     * O(n²) in the length of the utterance. It is also the only version that
     * is correct. decodeAudioData needs a stream it can start at, and MP3
     * frames straddle WebSocket chunk boundaries — decoding each batch alone
     * silently loses the partial frame at each end, and when the batch has no
     * frame header at all the decode throws and the audio is dropped outright.
     * A ten-second utterance costs a few tens of milliseconds of decode spread
     * across its whole length, which is far cheaper than the gaps were.
     */
    async _flushDecode() {
        if (this._decodeTimer) {
            clearTimeout(this._decodeTimer);
            this._decodeTimer = null;
        }
        if (this._decoding) return;           // decodeAudioData is async; no overlap
        if (!this._mp3Bytes.length || !this.audioContext || !this.workletNode) return;

        this._decoding = true;
        const snapshotId = this._currentId;
        try {
            // decodeAudioData detaches the buffer it is given, so it gets a copy.
            const audioBuffer = await this.audioContext.decodeAudioData(
                this._mp3Bytes.slice().buffer
            );
            // The utterance was interrupted while this decode was in flight.
            if (snapshotId !== this._currentId) return;

            const channel = audioBuffer.getChannelData(0);
            if (channel.length > this._samplesPushed) {
                // Copy: the worklet takes ownership of what it is handed, and
                // the next pass re-reads this same decoded buffer.
                const tail = channel.slice(this._samplesPushed);
                this._samplesPushed = channel.length;
                this.workletNode.port.postMessage(tail);
            }
        } catch (e) {
            // Too few bytes to form a frame yet. The bytes are kept, so the
            // next pass decodes them together with what follows.
            console.debug('NeuralTTS: awaiting more audio', e.message);
        } finally {
            this._decoding = false;
        }
    }

    /* -------------------- Public API -------------------- */

    async speak(text, opts = {}) {
        if (!this.wsReady) {
            const connected = await this.connect();
            if (!connected) return false;
        }

        await this._ensureAudio();

        // Anything still in flight belongs to the previous sentence.
        this.interrupt();

        return new Promise((resolve) => {
            const id = this._nextId++;
            this._currentId = id;
            this._streamId = null;
            this.speaking = true;
            this.onSpeakStart();

            this._currentResolve = resolve;

            try {
                this.ws.send(JSON.stringify({
                    type: 'speak',
                    id,
                    text: text,
                    voice: opts.voice || 'en-US-EmmaNeural',
                    speed: opts.speed || 1.0
                }));
            } catch (e) {
                console.warn('NeuralTTS: send failed', e);
                this.speaking = false;
                this._currentResolve = null;
                resolve(false);
            }
        });
    }

    interrupt() {
        if (this.wsReady) {
            try {
                this.ws.send(JSON.stringify({ type: 'interrupt', id: this._currentId }));
            } catch { /* noop */ }
        }
        if (this.workletNode) {
            this.workletNode.port.postMessage('interrupt');
        }
        // Retiring the id is what makes the interrupt stick: chunks already on
        // the wire, and any decode still running, are now attributed to a dead
        // utterance and discarded instead of played after the silence.
        this._currentId = null;
        this._streamId = null;
        this._resetStream();
        this.speaking = false;
        this._settle(true);
    }

    _resetStream() {
        this._mp3Bytes = new Uint8Array(0);
        this._samplesPushed = 0;
        this._lastDrainConsumed = 0;
        this._awaitingDrain = false;
        clearTimeout(this._drainTimer);
        if (this._decodeTimer) {
            clearTimeout(this._decodeTimer);
            this._decodeTimer = null;
        }
    }

    isSpeaking() { return this.speaking; }
    isAvailable() { return this.available && this.wsReady; }

    stop() {
        // Set first: interrupt() closes nothing, but onclose must not schedule
        // a reconnect for a service that has been deliberately shut down.
        this._stopped = true;
        this.interrupt();
        if (this.ws) try { this.ws.close(); } catch { /* noop */ }
        if (this.audioContext) this.audioContext.close().catch(() => {});
        this.ws = null;
        this.wsReady = false;
        this.available = false;
        this.audioContext = null;
        this.workletNode = null;
    }
}
