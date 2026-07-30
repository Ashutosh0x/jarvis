package com.jarvis.companion.network

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import java.io.File
import java.io.InputStream
import java.security.MessageDigest

/**
 * One APK staged for sending: where to read the bytes from, how many there
 * are, and the digest the receiver has to reproduce.
 *
 * The source stays a stream factory rather than a File. A SAF pick hands back
 * a content:// URI that has no filesystem path at all, and copying a 100 MB
 * archive into the cache just to get one would double both the wait and the
 * storage cost for nothing.
 */
class ApkPayload private constructor(
    val displayName: String,
    val sizeBytes: Long,
    val sha256: String,
    private val open: () -> InputStream,
) {
    fun openStream(): InputStream = open()

    val sizeLabel: String get() = ShareOffer.humanSize(sizeBytes)

    companion object {
        private const val BUFFER_BYTES = 64 * 1024

        /**
         * The installed companion itself. Every app can read its own
         * sourceDir, so passing JARVIS on to the next phone needs no picker,
         * no storage permission, and no copy.
         *
         * Blocking: hashes the whole archive. Call from a background thread.
         */
        fun ownApk(context: Context): ApkPayload {
            val apk = File(context.applicationInfo.sourceDir)
            val name = "jarvis-${versionName(context)}.apk"
            return ApkPayload(
                displayName = ShareOffer.sanitizeFileName(name),
                sizeBytes = apk.length(),
                sha256 = digestOf(open = { apk.inputStream() }),
                open = { apk.inputStream() },
            )
        }

        /**
         * An APK the user picked through the document picker or shared in.
         *
         * Blocking: reads the file twice — once to hash, once to send. Call
         * from a background thread.
         */
        fun fromUri(context: Context, uri: Uri): ApkPayload {
            val resolver = context.contentResolver
            var name = "shared.apk"
            var size = -1L
            resolver.query(uri, null, null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                        .takeIf { it >= 0 && !c.isNull(it) }
                        ?.let { name = c.getString(it) }
                    c.getColumnIndex(OpenableColumns.SIZE)
                        .takeIf { it >= 0 && !c.isNull(it) }
                        ?.let { size = c.getLong(it) }
                }
            }

            val open = {
                resolver.openInputStream(uri)
                    ?: throw java.io.IOException("cannot open $uri")
            }
            // Some providers report no size at all; counting during the hash
            // pass is the only way to get a Content-Length the receiver can
            // draw a progress bar from.
            var counted = 0L
            val digest = digestOf(open = open, onBytes = { counted += it })

            return ApkPayload(
                displayName = ShareOffer.sanitizeFileName(name),
                sizeBytes = if (size > 0) size else counted,
                sha256 = digest,
                open = open,
            )
        }

        private fun digestOf(
            open: () -> InputStream,
            onBytes: (Int) -> Unit = {},
        ): String {
            val md = MessageDigest.getInstance("SHA-256")
            open().use { stream ->
                val buf = ByteArray(BUFFER_BYTES)
                while (true) {
                    val n = stream.read(buf)
                    if (n < 0) break
                    md.update(buf, 0, n)
                    onBytes(n)
                }
            }
            return md.digest().toHex()
        }

        private fun versionName(context: Context): String = try {
            context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: "app"
        } catch (e: Exception) {
            "app"
        }
    }
}
