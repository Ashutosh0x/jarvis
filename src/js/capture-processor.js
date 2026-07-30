/**
 * Audio Capture Processor - Official Pattern
 *
 * AudioWorkletProcessor running on the Web Audio render thread. Buffers raw
 * mic input into fixed 256-sample frames and posts them to the main thread
 * via transferable ArrayBuffers for zero-copy delivery.
 */
class AudioCaptureProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.bufferSize = 256;
        this.buffer = new Float32Array(this.bufferSize);
        this.bufferIndex = 0;
        this.framesProcessed = 0; // diagnostic counter
    }

    process(inputs, outputs, parameters) {
        const input = inputs[0];

        if (input && input.length > 0) {
            const inputChannel = input[0];

            // Buffer the incoming audio
            for (let i = 0; i < inputChannel.length; i++) {
                this.buffer[this.bufferIndex++] = inputChannel[i];

                // When buffer is full, send it to main thread
                if (this.bufferIndex >= this.bufferSize) {
                    // Allocate a fresh ArrayBuffer and transfer ownership to
                    // the main thread — zero-copy, no structured clone overhead.
                    const outBuffer = new ArrayBuffer(this.bufferSize * 4);
                    const outView = new Float32Array(outBuffer);
                    outView.set(this.buffer);

                    this.port.postMessage({
                        type: "audio",
                        data: outView,
                        frames: ++this.framesProcessed
                    }, [outBuffer]);

                    // Reset buffer
                    this.bufferIndex = 0;
                }
            }
        }

        // Return true to keep the processor alive
        return true;
    }
}

registerProcessor("audio-capture-processor", AudioCaptureProcessor);
