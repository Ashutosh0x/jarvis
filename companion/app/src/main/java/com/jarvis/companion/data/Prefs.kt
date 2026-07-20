package com.jarvis.companion.data

import android.content.Context

/**
 * Pairing state. The token is the desktop's existing phone-bridge token
 * (electron.js writes it to phone-bridge.json); it arrives here via the QR
 * payload and authenticates every subsequent WebSocket frame.
 */
class Prefs(context: Context) {

    private val sp = context.getSharedPreferences("jarvis_companion", Context.MODE_PRIVATE)

    var host: String?
        get() = sp.getString(KEY_HOST, null)
        set(v) = sp.edit().putString(KEY_HOST, v).apply()

    var port: Int
        get() = sp.getInt(KEY_PORT, DEFAULT_WS_PORT)
        set(v) = sp.edit().putInt(KEY_PORT, v).apply()

    var token: String?
        get() = sp.getString(KEY_TOKEN, null)
        set(v) = sp.edit().putString(KEY_TOKEN, v).apply()

    val isPaired: Boolean
        get() = !host.isNullOrBlank() && !token.isNullOrBlank()

    fun save(host: String, port: Int, token: String) {
        sp.edit()
            .putString(KEY_HOST, host)
            .putInt(KEY_PORT, port)
            .putString(KEY_TOKEN, token)
            .apply()
    }

    fun clear() = sp.edit().clear().apply()

    companion object {
        // 8765 is the existing HTTP phone bridge; the command socket sits on 8766.
        const val DEFAULT_WS_PORT = 8766
        private const val KEY_HOST = "host"
        private const val KEY_PORT = "port"
        private const val KEY_TOKEN = "token"
    }
}
