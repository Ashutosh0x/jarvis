package com.jarvis.companion.network

import android.os.Handler
import android.os.Looper
import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit
import kotlin.math.min
import kotlin.math.pow

/**
 * Persistent command socket to JARVIS Desktop.
 *
 * The phone always dials OUT. That avoids running a listener on the handset
 * (battery, Doze, and the fact that a phone's LAN address churns) and means
 * only the desktop needs a stable address.
 */
class DesktopLink(
    private val executor: CommandExecutor,
    private val onState: (state: State, detail: String) -> Unit
) {
    enum class State { DISCONNECTED, CONNECTING, CONNECTED }

    companion object {
        private const val TAG = "JarvisLink"
        private const val MAX_BACKOFF_MS = 30_000L
    }

    private val client = OkHttpClient.Builder()
        // Server pings every 20s; this keeps NAT/Wi-Fi power-save from
        // silently dropping an idle socket without either side noticing.
        .pingInterval(20, TimeUnit.SECONDS)
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS) // 0 = no read timeout for WS
        .build()

    private val main = Handler(Looper.getMainLooper())

    @Volatile private var socket: WebSocket? = null
    @Volatile private var shouldRun = false
    @Volatile private var attempt = 0

    private var host: String? = null
    private var port: Int = 0
    private var token: String? = null

    fun connect(host: String, port: Int, token: String) {
        this.host = host
        this.port = port
        this.token = token
        shouldRun = true
        attempt = 0
        openSocket()
    }

    fun disconnect() {
        shouldRun = false
        socket?.close(1000, "client shutdown")
        socket = null
        onState(State.DISCONNECTED, "stopped")
    }

    val isConnected: Boolean get() = socket != null

    /** Fire-and-forget event to the desktop (notifications, clipboard, battery). */
    fun sendEvent(event: String, payload: JSONObject = JSONObject()) {
        val s = socket ?: return
        val msg = JSONObject().put("event", event).put("payload", payload)
        s.send(msg.toString())
    }

    private fun openSocket() {
        val h = host ?: return
        val t = token ?: return
        if (!shouldRun) return

        onState(State.CONNECTING, "$h:$port")

        val request = Request.Builder()
            .url("ws://$h:$port/ws")
            // Token travels as a header, not a query string: query strings end
            // up in server logs and process listings.
            .addHeader("X-Jarvis-Token", t)
            .build()

        client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                Log.i(TAG, "connected to $h:$port")
                socket = webSocket
                attempt = 0
                onState(State.CONNECTED, "$h:$port")
                webSocket.send(
                    JSONObject()
                        .put("event", "hello")
                        .put("payload", executor.deviceInfo())
                        .toString()
                )
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                handleCommand(webSocket, text)
            }

            override fun onFailure(webSocket: WebSocket, t2: Throwable, response: Response?) {
                Log.w(TAG, "socket failure: ${t2.message}")
                socket = null
                onState(State.DISCONNECTED, t2.message ?: "failure")
                scheduleReconnect()
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                Log.i(TAG, "socket closed: $code $reason")
                socket = null
                onState(State.DISCONNECTED, reason)
                scheduleReconnect()
            }
        })
    }

    private fun scheduleReconnect() {
        if (!shouldRun) return
        // Exponential backoff, capped — a desktop that is asleep should not be
        // hammered, but reconnect must still be quick when it wakes.
        val delay = min(MAX_BACKOFF_MS, (1000L * 2.0.pow(attempt).toLong()))
        attempt = min(attempt + 1, 5)
        Log.d(TAG, "reconnecting in ${delay}ms")
        main.postDelayed({ openSocket() }, delay)
    }

    private fun handleCommand(webSocket: WebSocket, text: String) {
        val req = try {
            JSONObject(text)
        } catch (e: Exception) {
            Log.w(TAG, "malformed frame: ${text.take(120)}")
            return
        }

        val id = req.optString("id", "")
        val action = req.optString("action", "")
        val params = req.optJSONObject("params") ?: JSONObject()

        // Dispatched off the socket thread: gestures and UI-tree dumps can
        // block, and stalling the reader would back up every later command.
        executor.execute(action, params) { ok, result, error ->
            val reply = JSONObject()
                .put("id", id)
                .put("ok", ok)
            if (result != null) reply.put("result", result)
            if (error != null) reply.put("error", error)
            try {
                webSocket.send(reply.toString())
            } catch (e: Exception) {
                Log.w(TAG, "reply failed: ${e.message}")
            }
        }
    }
}
