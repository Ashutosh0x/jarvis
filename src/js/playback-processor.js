/**
 * Audio Playback Processor - Official Pattern
 *
 * AudioWorkletProcessor for low-latency streaming playback. Uses a
 * pre-allocated circular (ring) buffer instead of a JS array queue,
 * eliminating all heap allocations in the real-time process() callback.
 *
 * The ring buffer holds ~10 seconds of audio at 48 kHz. Incoming chunks
 * are written into the buffer by the message handler; process() reads
 * from it with zero allocation. Interrupt support resets readPos to
 * writePos for instant queue flush.
 */
class AudioPlaybackProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        // Pre-allocated ring buffer: 480000 samples ≈ 10s at 48 kHz
        this.bufferCapacity = 480000;
        this.ringBuffer = new Float32Array(this.bufferCapacity);
        this.readPos = 0;
        this.writePos = 0;

        // Diagnostics
        this.underruns = 0;
        this.processCalls = 0;

        // Drain tracking. The main thread needs to know when the LAST sample
        // has actually left the buffer, not when the last byte was decoded:
        // that instant is when Jarvis has genuinely stopped talking and the
        // mic can safely reopen. Guessing it with a fixed timeout reopens the
        // mic mid-sentence and Jarvis transcribes itself.
        this.hadData = false;
        // Cumulative samples actually handed to the device. The main thread
        // compares this against what it pushed, so a drain that arrives while
        // the decoder is still mid-flight is recognised as premature instead
        // of ending the utterance early.
        this.consumed = 0;

        this.port.onmessage = (event) => {
            if (event.data === "interrupt") {
                // Clear the queue on interrupt — instant barge-in support.
                // No drain event: the caller asked for silence and already
                // knows it happened, so announcing a drain here would fire a
                // speech-finished callback for speech that never finished.
                this.readPos = this.writePos;
                this.hadData = false;
                // Restarts the accounting alongside the main thread's own
                // reset, so the two counters stay comparable.
                this.consumed = 0;
            } else if (event.data instanceof Float32Array) {
                // Write incoming audio data into the ring buffer
                const data = event.data;
                if (data.length > 0) this.hadData = true;
                for (let i = 0; i < data.length; i++) {
                    this.ringBuffer[this.writePos] = data[i];
                    this.writePos = (this.writePos + 1) % this.bufferCapacity;
                    // If write overtakes read, advance read (overflow protection)
                    if (this.writePos === this.readPos) {
                        this.readPos = (this.readPos + 1) % this.bufferCapacity;
                    }
                }
            }
        };
    }

    _queueLevel() {
        if (this.writePos >= this.readPos) {
            return this.writePos - this.readPos;
        }
        return this.bufferCapacity - this.readPos + this.writePos;
    }

    process(inputs, outputs, parameters) {
        const output = outputs[0];
        if (output.length === 0) return true;

        const channel = output[0];
        let outputIndex = 0;

        this.processCalls++;

        const available = this._queueLevel();

        // Zero-allocation read from ring buffer
        const toRead = Math.min(available, channel.length);
        for (let i = 0; i < toRead; i++) {
            channel[outputIndex++] = this.ringBuffer[this.readPos];
            this.readPos = (this.readPos + 1) % this.bufferCapacity;
        }
        this.consumed += toRead;

        // Fill remaining output with silence (prevents clicks/pops)
        while (outputIndex < channel.length) {
            channel[outputIndex++] = 0;
        }

        // Track underruns (when we had less data than requested)
        if (toRead < channel.length && toRead > 0) {
            this.underruns++;
        }

        // The buffer just went empty after holding audio: the last sample has
        // been handed to the device. Fires once per utterance, not per block.
        if (this.hadData && this._queueLevel() === 0) {
            this.hadData = false;
            this.port.postMessage({ type: "drained", consumed: this.consumed });
        }

        // Report queue health periodically (every ~267ms at 48kHz/128 samples)
        if (this.processCalls % 100 === 0) {
            this.port.postMessage({
                type: "status",
                queueLevel: this._queueLevel(),
                underruns: this.underruns
            });
        }

        return true;
    }
}

registerProcessor("audio-playback-processor", AudioPlaybackProcessor);
