package com.jarvis.companion.network

import android.content.Context
import android.os.Environment
import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * The receiving half: pulls the offered APK and refuses to hand back anything
 * whose digest does not match what was advertised.
 *
 * The file lands in the app's own external files dir. That needs no storage
 * permission on any API level this app supports, survives scoped storage
 * unchanged, and is still reachable by the package installer through the
 * FileProvider — the public Downloads folder buys nothing here and costs a
 * permission prompt.
 */
class ApkTransferClient(private val context: Context) {

    companion object {
        private const val TAG = "JarvisApkClient"
        private const val BUFFER_BYTES = 64 * 1024
        private const val PROGRESS_INTERVAL_MS = 100L
        private const val SUBDIR = "incoming"
    }

    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        // Applies between reads, not to the whole body: a large APK on a slow
        // link must not be killed just for taking a while.
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    @Volatile private var cancelled = false

    fun cancel() {
        cancelled = true
    }

    /**
     * Downloads and verifies, off the caller's thread. Exactly one of the two
     * [onDone] arguments is non-null.
     */
    fun fetch(
        offer: ShareOffer,
        onProgress: (received: Long, total: Long) -> Unit,
        onDone: (file: File?, error: String?) -> Unit,
    ) {
        cancelled = false
        thread(name = "apk-share-client") {
            try {
                val file = download(offer, onProgress)
                onDone(file, null)
            } catch (e: Exception) {
                Log.w(TAG, "fetch failed", e)
                onDone(null, e.message ?: e.javaClass.simpleName)
            }
        }
    }

    private fun download(offer: ShareOffer, onProgress: (Long, Long) -> Unit): File {
        val host = offer.host ?: throw IllegalStateException("No route to the sender yet")

        val dir = File(
            context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)
                ?: context.filesDir,
            SUBDIR,
        )
        if (!dir.exists() && !dir.mkdirs()) throw IllegalStateException("Cannot create $dir")

        if (dir.usableSpace in 1 until offer.sizeBytes + (8L shl 20)) {
            throw IllegalStateException(
                "Not enough free space for ${offer.sizeLabel}"
            )
        }

        // Download to a partial file. A half-written .apk sitting in the
        // directory is something a user can be talked into installing.
        val target = File(dir, offer.fileName)
        val partial = File(dir, "${offer.fileName}.part")
        partial.delete()

        val request = Request.Builder()
            .url("http://$host:${offer.port}/apk")
            .addHeader(ApkTransferServer.TOKEN_HEADER, offer.token)
            .build()

        val digest = MessageDigest.getInstance("SHA-256")
        var received = 0L

        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                throw IllegalStateException("Sender replied ${response.code}")
            }
            val body = response.body ?: throw IllegalStateException("Empty response")
            val total = body.contentLength().takeIf { it > 0 } ?: offer.sizeBytes

            body.byteStream().use { source ->
                FileOutputStream(partial).use { sink ->
                    val buf = ByteArray(BUFFER_BYTES)
                    var lastTick = 0L
                    while (true) {
                        if (cancelled) throw IllegalStateException("Cancelled")
                        val n = source.read(buf)
                        if (n < 0) break
                        sink.write(buf, 0, n)
                        digest.update(buf, 0, n)
                        received += n

                        val now = System.currentTimeMillis()
                        if (now - lastTick >= PROGRESS_INTERVAL_MS) {
                            lastTick = now
                            onProgress(received, total)
                        }
                    }
                    sink.fd.sync()
                }
            }
            onProgress(received, total)
        }

        if (received != offer.sizeBytes) {
            partial.delete()
            throw IllegalStateException(
                "Truncated: got ${ShareOffer.humanSize(received)} of ${offer.sizeLabel}"
            )
        }

        val actual = digest.digest().toHex()
        if (!MessageDigest.isEqual(
                actual.toByteArray(Charsets.US_ASCII),
                offer.sha256.toByteArray(Charsets.US_ASCII),
            )
        ) {
            partial.delete()
            throw IllegalStateException("Checksum mismatch — the file was corrupted in transit")
        }

        target.delete()
        if (!partial.renameTo(target)) {
            partial.delete()
            throw IllegalStateException("Cannot finalise ${target.name}")
        }
        Log.i(TAG, "verified ${target.name} (${offer.sizeLabel}, sha256=$actual)")
        return target
    }
}
