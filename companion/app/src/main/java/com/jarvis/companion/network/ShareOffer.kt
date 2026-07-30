package com.jarvis.companion.network

import java.util.Locale

private const val HEX_DIGITS = "0123456789abcdef"

/** Lowercase hex, the form every sha256sum tool prints and compares. */
internal fun ByteArray.toHex(): String {
    val out = StringBuilder(size * 2)
    for (b in this) {
        val v = b.toInt() and 0xFF
        out.append(HEX_DIGITS[v ushr 4]).append(HEX_DIGITS[v and 0x0F])
    }
    return out.toString()
}

/**
 * Everything a receiver needs before a single byte of APK moves: which socket
 * to dial, the secret that unlocks it, and the digest to check the result
 * against.
 *
 * Deliberately tiny — the whole thing has to survive a round trip through a
 * DNS-SD TXT record, which is advertised in probe responses and is not the
 * place for anything large.
 */
data class ShareOffer(
    val deviceName: String,
    val fileName: String,
    val sizeBytes: Long,
    val sha256: String,
    val port: Int,
    val token: String,
    /**
     * Null until a Wi-Fi Direct group forms. On a shared LAN mDNS resolves the
     * address up front; over Wi-Fi Direct the sender's address does not exist
     * until the group is negotiated, and is then always the group owner's.
     */
    val host: String? = null,
    /** MAC of the advertising peer. Wi-Fi Direct only — the handle to connect to. */
    val p2pAddress: String? = null,
) {
    fun toTxt(): Map<String, String> = mapOf(
        KEY_DEVICE to deviceName,
        KEY_NAME to fileName,
        KEY_SIZE to sizeBytes.toString(),
        KEY_SHA to sha256,
        KEY_PORT to port.toString(),
        KEY_TOKEN to token,
    )

    val sizeLabel: String get() = humanSize(sizeBytes)

    companion object {
        /** NsdManager wants the trailing dot; the Wi-Fi Direct API rejects it. */
        const val NSD_SERVICE_TYPE = "_jarvisapk._tcp."
        const val P2P_SERVICE_TYPE = "_jarvisapk._tcp"
        const val INSTANCE_PREFIX = "JARVIS-Share"

        private const val KEY_DEVICE = "dev"
        private const val KEY_NAME = "name"
        private const val KEY_SIZE = "size"
        private const val KEY_SHA = "sha"
        private const val KEY_PORT = "port"
        private const val KEY_TOKEN = "tok"

        /**
         * Rebuilds an offer from a peer's TXT records. Returns null rather than
         * a half-populated offer: a record missing its port, token, or digest
         * is not something to start a transfer against.
         */
        fun fromTxt(
            txt: Map<String, String>,
            host: String?,
            p2pAddress: String? = null,
        ): ShareOffer? {
            val port = txt[KEY_PORT]?.toIntOrNull()?.takeIf { it in 1..65535 } ?: return null
            val token = txt[KEY_TOKEN]?.takeIf { it.isNotBlank() } ?: return null
            val sha = txt[KEY_SHA]?.takeIf { it.length == 64 } ?: return null
            val size = txt[KEY_SIZE]?.toLongOrNull()?.takeIf { it > 0 } ?: return null
            return ShareOffer(
                deviceName = txt[KEY_DEVICE].orEmpty().ifBlank { "Unknown device" },
                fileName = sanitizeFileName(txt[KEY_NAME].orEmpty()),
                sizeBytes = size,
                sha256 = sha.lowercase(Locale.US),
                port = port,
                token = token,
                host = host,
                p2pAddress = p2pAddress,
            )
        }

        /**
         * The name arrives from another device, so it is untrusted input that
         * ends up in a File(). Strip every path separator and traversal chunk
         * so a hostile peer cannot steer the write outside the download dir.
         */
        fun sanitizeFileName(raw: String): String {
            val base = raw.substringAfterLast('/').substringAfterLast('\\')
                .replace("..", "")
                .filter { it.isLetterOrDigit() || it in "._- " }
                .trim()
                .take(96)
            val named = base.ifBlank { "shared" }
            return if (named.endsWith(".apk", ignoreCase = true)) named else "$named.apk"
        }

        fun humanSize(bytes: Long): String = when {
            bytes >= 1L shl 30 -> String.format(Locale.US, "%.1f GB", bytes / (1L shl 30).toDouble())
            bytes >= 1L shl 20 -> String.format(Locale.US, "%.1f MB", bytes / (1L shl 20).toDouble())
            bytes >= 1L shl 10 -> String.format(Locale.US, "%.0f KB", bytes / (1L shl 10).toDouble())
            else -> "$bytes B"
        }
    }
}
