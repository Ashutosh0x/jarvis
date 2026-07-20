package com.jarvis.companion.network

import org.json.JSONObject

/**
 * Executes a command that arrived from JARVIS Desktop.
 *
 * The callback form (rather than a return value) is deliberate: gestures
 * complete asynchronously via GestureResultCallback, and TTS only reports
 * success on an utterance listener. A blocking signature would force those
 * to lie about whether they actually succeeded.
 */
interface CommandExecutor {

    fun interface Reply {
        fun done(ok: Boolean, result: JSONObject?, error: String?)
    }

    fun execute(action: String, params: JSONObject, reply: Reply)

    /** Identity sent on connect so the desktop can label the device. */
    fun deviceInfo(): JSONObject
}
