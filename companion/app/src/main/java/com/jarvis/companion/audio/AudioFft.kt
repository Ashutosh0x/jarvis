package com.jarvis.companion.audio

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Log
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.ln
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Microphone -> FFT -> 64 frequency bins, mirroring what the desktop app gets
 * from a WebAudio AnalyserNode so the visualizer reacts identically.
 *
 * WebAudio's getByteFrequencyData returns dB magnitudes mapped onto 0..255
 * across minDecibels(-100)..maxDecibels(-30). The same mapping is applied here
 * rather than a raw linear magnitude, otherwise the orb barely moves at normal
 * speaking volume.
 */
class AudioFft(
    private val onFrame: (volume: Float, bins: ByteArray) -> Unit
) {
    companion object {
        private const val TAG = "JarvisAudioFft"
        private const val SAMPLE_RATE = 44100
        private const val FFT_SIZE = 1024        // power of two; 512 bins -> folded to 64
        private const val OUTPUT_BINS = 64
        private const val MIN_DB = -100f
        private const val MAX_DB = -30f
    }

    @Volatile private var running = false
    private var thread: Thread? = null
    private var record: AudioRecord? = null

    // Precomputed Hann window — recomputing per frame is pure waste.
    private val window = FloatArray(FFT_SIZE) { i ->
        0.5f * (1f - cos(2.0 * Math.PI * i / (FFT_SIZE - 1)).toFloat())
    }

    private val re = FloatArray(FFT_SIZE)
    private val im = FloatArray(FFT_SIZE)
    private val bins = ByteArray(OUTPUT_BINS)

    @SuppressLint("MissingPermission") // caller gates on RECORD_AUDIO
    fun start() {
        if (running) return
        val minBuf = AudioRecord.getMinBufferSize(
            SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT
        )
        if (minBuf <= 0) {
            Log.w(TAG, "AudioRecord unavailable (minBufferSize=$minBuf)")
            return
        }

        val bufSize = maxOf(minBuf, FFT_SIZE * 2 * 2)
        val rec = try {
            AudioRecord(
                MediaRecorder.AudioSource.VOICE_RECOGNITION,
                SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                bufSize
            )
        } catch (e: Exception) {
            Log.w(TAG, "AudioRecord construction failed: ${e.message}")
            return
        }

        if (rec.state != AudioRecord.STATE_INITIALIZED) {
            Log.w(TAG, "AudioRecord not initialized; mic may be held by another app")
            rec.release()
            return
        }

        record = rec
        running = true
        rec.startRecording()

        thread = Thread({ loop(rec) }, "jarvis-fft").apply {
            priority = Thread.NORM_PRIORITY + 1
            start()
        }
    }

    fun stop() {
        running = false
        thread?.join(500)
        thread = null
        record?.let {
            try {
                if (it.recordingState == AudioRecord.RECORDSTATE_RECORDING) it.stop()
            } catch (_: IllegalStateException) { /* already stopped */ }
            it.release()
        }
        record = null
    }

    private fun loop(rec: AudioRecord) {
        val pcm = ShortArray(FFT_SIZE)
        while (running) {
            val read = rec.read(pcm, 0, FFT_SIZE)
            if (read <= 0) continue

            // RMS -> the same 0..100-ish scale the desktop's volume meter uses.
            var sumSq = 0.0
            for (i in 0 until read) {
                val s = pcm[i] / 32768f
                sumSq += (s * s).toDouble()
            }
            val rms = sqrt(sumSq / read).toFloat()
            val volume = (rms * 300f).coerceIn(0f, 100f)

            for (i in 0 until FFT_SIZE) {
                re[i] = if (i < read) (pcm[i] / 32768f) * window[i] else 0f
                im[i] = 0f
            }
            fft(re, im)
            magnitudesToBins()

            onFrame(volume, bins.copyOf())
        }
    }

    /**
     * Folds the FFT's 512 usable magnitudes into 64 bins and converts each to
     * the 0..255 byte scale using WebAudio's dB mapping.
     */
    private fun magnitudesToBins() {
        val usable = FFT_SIZE / 2          // 512
        val perBin = usable / OUTPUT_BINS  // 8
        for (b in 0 until OUTPUT_BINS) {
            var peak = 0f
            val start = b * perBin
            for (k in start until start + perBin) {
                val m = hypot(re[k], im[k]) / (FFT_SIZE / 2f)
                if (m > peak) peak = m
            }
            // Linear magnitude -> dBFS. Floor guards log(0).
            val db = 20f * (ln(maxOf(peak, 1e-7f)) / ln(10f))
            val norm = ((db - MIN_DB) / (MAX_DB - MIN_DB)).coerceIn(0f, 1f)
            bins[b] = (norm * 255f).toInt().coerceIn(0, 255).toByte()
        }
    }

    /** In-place iterative radix-2 Cooley-Tukey. FFT_SIZE must be a power of two. */
    private fun fft(real: FloatArray, imag: FloatArray) {
        val n = real.size

        // Bit-reversal permutation.
        var j = 0
        for (i in 1 until n) {
            var bit = n shr 1
            while (j and bit != 0) {
                j = j xor bit
                bit = bit shr 1
            }
            j = j or bit
            if (i < j) {
                val tr = real[i]; real[i] = real[j]; real[j] = tr
                val ti = imag[i]; imag[i] = imag[j]; imag[j] = ti
            }
        }

        var len = 2
        while (len <= n) {
            val ang = -2.0 * Math.PI / len
            val wRealStep = cos(ang).toFloat()
            val wImagStep = sin(ang).toFloat()
            var i = 0
            while (i < n) {
                var wReal = 1f
                var wImag = 0f
                for (k in 0 until len / 2) {
                    val uRe = real[i + k]
                    val uIm = imag[i + k]
                    val vRe = real[i + k + len / 2] * wReal - imag[i + k + len / 2] * wImag
                    val vIm = real[i + k + len / 2] * wImag + imag[i + k + len / 2] * wReal
                    real[i + k] = uRe + vRe
                    imag[i + k] = uIm + vIm
                    real[i + k + len / 2] = uRe - vRe
                    imag[i + k + len / 2] = uIm - vIm
                    val nextWReal = wReal * wRealStep - wImag * wImagStep
                    wImag = wReal * wImagStep + wImag * wRealStep
                    wReal = nextWReal
                }
                i += len
            }
            len = len shl 1
        }
    }
}
