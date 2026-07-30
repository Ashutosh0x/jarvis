/**
 * Decodes base64 string to a Uint8Array.
 */
export function base64ToUint8Array(base64) {
    const binaryString = atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
}

/**
 * Encodes Uint8Array to base64 string.
 * Uses chunked String.fromCharCode.apply to avoid O(n²) string
 * concatenation and call-stack overflow on large buffers.
 */
export function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    const chunkSize = 8192;
    for (let i = 0; i < len; i += chunkSize) {
        const chunk = bytes.subarray(i, i + chunkSize);
        binary += String.fromCharCode.apply(null, chunk);
    }
    return btoa(binary);
}

/**
 * Converts Float32Array (from AudioContext) to 16-bit PCM (for Gemini).
 */
export function float32To16BitPCM(float32Arr) {
    const buffer = new ArrayBuffer(float32Arr.length * 2);
    const view = new DataView(buffer);
    for (let i = 0; i < float32Arr.length; i++) {
        let s = Math.max(-1, Math.min(1, float32Arr[i]));
        view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true); // Little endian
    }
    return buffer;
}

/**
 * Decodes raw PCM 16-bit data to AudioBuffer.
 * Not async — contains no awaits and returns synchronously.
 */
export function pcm16ToAudioBuffer(
    pcmData,
    audioContext,
    sampleRate = 24000,
    channels = 1
) {
    // Guarantee Int16Array alignment: if byteOffset is odd, slice to a
    // new aligned buffer. Without this, V8 throws RangeError on unaligned
    // typed-array construction.
    let bufferData = pcmData;
    if (pcmData.byteOffset % 2 !== 0) {
        bufferData = pcmData.slice();
    }
    const dataInt16 = new Int16Array(bufferData.buffer, bufferData.byteOffset, bufferData.byteLength / 2);
    const frameCount = dataInt16.length / channels;
    const buffer = audioContext.createBuffer(channels, frameCount, sampleRate);

    for (let channel = 0; channel < channels; channel++) {
        const channelData = buffer.getChannelData(channel);
        for (let i = 0; i < frameCount; i++) {
            channelData[i] = dataInt16[i * channels + channel] / 32768.0;
        }
    }
    return buffer;
}
