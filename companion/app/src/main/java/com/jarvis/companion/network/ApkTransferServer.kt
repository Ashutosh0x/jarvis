package com.jarvis.companion.network

import android.util.Log
import org.json.JSONObject
import java.io.BufferedOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketException
import java.security.MessageDigest
import java.security.SecureRandom
import kotlin.concurrent.thread

/**
 * The sending half: a throwaway HTTP server that serves exactly one file.
 *
 * HTTP rather than a bespoke framing protocol because the receiving side then
 * needs no protocol at all — OkHttp is already a dependency here, and in a
 * pinch a plain browser on the other phone can fetch the same URL.
 *
 * Scope is kept deliberately narrow, because this listens on an interface
 * shared with whoever else is on that Wi-Fi:
 *  - two routes, GET only, one payload, chosen by the user before the socket
 *    ever opens — there is no path that maps a request onto the filesystem;
 *  - every request must carry the token from the TXT record, compared in
 *    constant time;
 *  - the listener closes after one complete transfer.
 */
class ApkTransferServer(
    private val payload: ApkPayload,
    private val onProgress: (sent: Long, total: Long) -> Unit,
    private val onDone: (error: String?) -> Unit,
) {
    companion object {
        private const val TAG = "JarvisApkServer"
        private const val BUFFER_BYTES = 64 * 1024
        private const val PROGRESS_INTERVAL_MS = 100L

        /** Long enough to read a request line; short enough that a stalled
         *  peer cannot pin the single accept loop open indefinitely. */
        private const val REQUEST_TIMEOUT_MS = 15_000

        const val TOKEN_HEADER = "x-jarvis-share-token"
    }

    /** Shared with the receiver through the service advertisement, not the network. */
    val token: String = ByteArray(16).also { SecureRandom().nextBytes(it) }.toHex()

    @Volatile private var server: ServerSocket? = null
    @Volatile private var running = false
    @Volatile private var delivered = false

    /** Binds an ephemeral port on every interface and returns the port. */
    fun start(): Int {
        val socket = ServerSocket(0)
        server = socket
        running = true
        thread(name = "apk-share-server") { acceptLoop(socket) }
        Log.i(TAG, "serving ${payload.displayName} on :${socket.localPort}")
        return socket.localPort
    }

    fun stop() {
        running = false
        try {
            server?.close()
        } catch (e: IOException) {
            Log.d(TAG, "close: ${e.message}")
        }
        server = null
    }

    private fun acceptLoop(socket: ServerSocket) {
        while (running) {
            val client = try {
                socket.accept()
            } catch (e: IOException) {
                // Expected: stop() closes the socket out from under accept().
                if (running) Log.w(TAG, "accept failed: ${e.message}")
                return
            }
            // Served one at a time. Two receivers pulling at once would halve
            // each one's throughput and make the progress bar meaningless.
            try {
                client.use { handle(it) }
            } catch (e: Exception) {
                Log.w(TAG, "request failed: ${e.message}")
            }
            if (delivered) {
                stop()
                return
            }
        }
    }

    private fun handle(client: Socket) {
        client.soTimeout = REQUEST_TIMEOUT_MS
        val input = client.getInputStream()
        val output = BufferedOutputStream(client.getOutputStream())

        val requestLine = readAsciiLine(input) ?: return
        val parts = requestLine.split(' ')
        if (parts.size < 2) {
            respondError(output, 400, "Bad Request")
            return
        }
        val method = parts[0].uppercase()
        val path = parts[1].substringBefore('?')

        val headers = mutableMapOf<String, String>()
        while (true) {
            val line = readAsciiLine(input) ?: break
            if (line.isEmpty()) break
            val idx = line.indexOf(':')
            if (idx > 0) {
                headers[line.substring(0, idx).trim().lowercase()] =
                    line.substring(idx + 1).trim()
            }
        }

        if (method != "GET") {
            respondError(output, 405, "Method Not Allowed")
            return
        }
        if (!tokenMatches(headers[TOKEN_HEADER])) {
            Log.w(TAG, "rejected request with bad token from ${client.inetAddress?.hostAddress}")
            respondError(output, 403, "Forbidden")
            return
        }

        when (path) {
            "/meta" -> respondMeta(output)
            "/apk" -> respondApk(output)
            else -> respondError(output, 404, "Not Found")
        }
    }

    private fun tokenMatches(supplied: String?): Boolean {
        val given = supplied ?: return false
        // Length is public anyway (it is fixed), and isEqual is the only
        // comparison here that does not leak the matching prefix by timing.
        return MessageDigest.isEqual(
            given.toByteArray(Charsets.US_ASCII),
            token.toByteArray(Charsets.US_ASCII),
        )
    }

    private fun respondMeta(out: OutputStream) {
        val body = JSONObject()
            .put("name", payload.displayName)
            .put("size", payload.sizeBytes)
            .put("sha256", payload.sha256)
            .toString()
            .toByteArray(Charsets.UTF_8)

        writeHeaders(out, 200, "OK", "application/json; charset=utf-8", body.size.toLong())
        out.write(body)
        out.flush()
    }

    private fun respondApk(out: OutputStream) {
        val total = payload.sizeBytes
        writeHeaders(
            out,
            200,
            "OK",
            "application/vnd.android.package-archive",
            total,
            extra = "Content-Disposition: attachment; filename=\"${payload.displayName}\"\r\n",
        )

        var sent = 0L
        var lastTick = 0L
        try {
            payload.openStream().use { source ->
                val buf = ByteArray(BUFFER_BYTES)
                while (true) {
                    val n = source.read(buf)
                    if (n < 0) break
                    out.write(buf, 0, n)
                    sent += n

                    val now = System.currentTimeMillis()
                    if (now - lastTick >= PROGRESS_INTERVAL_MS) {
                        lastTick = now
                        onProgress(sent, total)
                    }
                }
                out.flush()
            }
        } catch (e: SocketException) {
            // Receiver walked away mid-stream; the offer stays open for a retry.
            Log.w(TAG, "transfer interrupted after $sent/$total bytes: ${e.message}")
            onDone("Transfer interrupted after ${ShareOffer.humanSize(sent)}")
            return
        }

        onProgress(sent, total)
        if (sent == total) {
            delivered = true
            onDone(null)
        } else {
            // Content-Length promised more than the source produced: the file
            // changed under us. Say so rather than let the receiver blame its
            // own digest check.
            onDone("Sent $sent of $total bytes — the source file changed while sending")
        }
    }

    private fun respondError(out: OutputStream, code: Int, reason: String) {
        val body = reason.toByteArray(Charsets.UTF_8)
        writeHeaders(out, code, reason, "text/plain; charset=utf-8", body.size.toLong())
        out.write(body)
        out.flush()
    }

    private fun writeHeaders(
        out: OutputStream,
        code: Int,
        reason: String,
        contentType: String,
        length: Long,
        extra: String = "",
    ) {
        val head = buildString {
            append("HTTP/1.1 $code $reason\r\n")
            append("Content-Type: $contentType\r\n")
            append("Content-Length: $length\r\n")
            append("Connection: close\r\n")
            append(extra)
            append("\r\n")
        }
        out.write(head.toByteArray(Charsets.US_ASCII))
    }

    /**
     * Reads one CRLF-terminated line straight off the socket. A BufferedReader
     * would be shorter but is wrong here: it reads ahead into its own buffer,
     * so any request that ever carried a body would arrive truncated.
     */
    private fun readAsciiLine(input: InputStream): String? {
        val sb = StringBuilder()
        while (true) {
            val c = input.read()
            if (c < 0) return if (sb.isEmpty()) null else sb.toString()
            if (c == '\n'.code) return sb.toString().removeSuffix("\r")
            sb.append(c.toChar())
            if (sb.length > 8192) return null // no legitimate request line is this long
        }
    }
}
