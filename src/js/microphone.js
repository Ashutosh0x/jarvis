// Microphone Audio Input for Visualizer
class MicrophoneAudio {
    constructor() {
        this.audioContext = null;
        this.analyser = null;
        this.microphone = null;
        this.dataArray = null;
        this.isRecording = false;
        this.stream = null;
    }

    async initialize() {
        try {
            this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            this.analyser = this.audioContext.createAnalyser();
            this.microphone = this.audioContext.createMediaStreamSource(this.stream);
            
            this.analyser.fftSize = 32; // Match Three.js AudioAnalyser default
            this.analyser.smoothingTimeConstant = 0.8;
            this.microphone.connect(this.analyser);
            
            const bufferLength = this.analyser.frequencyBinCount;
            this.dataArray = new Uint8Array(bufferLength);
            
            this.isRecording = true;
            console.log('Microphone initialized successfully');
            return this.analyser;
        } catch (error) {
            console.error('Microphone initialization error:', error);
            // Return a dummy analyser that returns 0
            return {
                getAverageFrequency: () => 0,
                getByteFrequencyData: () => {}
            };
        }
    }

    getFrequencyData() {
        if (this.analyser && this.dataArray) {
            this.analyser.getByteFrequencyData(this.dataArray);
            return this.dataArray;
        }
        return null;
    }

    getAverageFrequency() {
        if (!this.analyser || !this.dataArray) return 0;
        
        this.analyser.getByteFrequencyData(this.dataArray);
        
        let sum = 0;
        for (let i = 0; i < this.dataArray.length; i++) {
            sum += this.dataArray[i];
        }
        const average = sum / this.dataArray.length;
        // Scale to match expected range (0-255 -> 0-30 for visualizer)
        return (average / 255) * 30;
    }

    stop() {
        if (this.microphone) {
            this.microphone.disconnect();
        }
        if (this.stream) {
            this.stream.getTracks().forEach(track => track.stop());
        }
        if (this.audioContext) {
            this.audioContext.close();
        }
        this.isRecording = false;
    }
}

export default MicrophoneAudio;

