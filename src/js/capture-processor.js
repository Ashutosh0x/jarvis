/**
 * Audio Capture Processor - Official Pattern
 */
class AudioCaptureProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.bufferSize = 256;
        this.buffer = new Float32Array(this.bufferSize);
        this.bufferIndex = 0;
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
                    // Send the buffered audio to the main thread
                    // ✅ FIX: Use new Float32Array(this.buffer) for production-grade GC hygiene
                    this.port.postMessage({
                        type: "audio",
                        data: new Float32Array(this.buffer),
                    });

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
