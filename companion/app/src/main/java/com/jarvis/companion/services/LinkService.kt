package com.jarvis.companion.services

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.lifecycle.LifecycleService
import com.jarvis.companion.MainActivity
import com.jarvis.companion.R
import com.jarvis.companion.data.Prefs
import com.jarvis.companion.network.DesktopLink
import com.jarvis.companion.network.NsdDiscoveryHelper
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Owns the desktop connection for the lifetime of the app.
 *
 * Foreground because the link must survive the activity being backgrounded —
 * a bare background service gets killed within minutes on modern Android.
 */
class LinkService : LifecycleService() {

    companion object {
        private const val TAG = "JarvisLinkSvc"
        private const val CHANNEL_ID = "jarvis_link"
        private const val NOTIF_ID = 42
        private const val BRIDGE_PORT = 8765   // existing HTTP phone bridge
        private const val PAIR_RETRY_MS = 10_000L

        @Volatile var lastState: String = "DISCONNECTED"
            private set
        @Volatile var lastDetail: String = ""
            private set

        fun start(context: Context) {
            val intent = Intent(context, LinkService::class.java)
            ContextCompat_startForegroundService(context, intent)
        }

        private fun ContextCompat_startForegroundService(context: Context, intent: Intent) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }
    }

    private lateinit var prefs: Prefs
    private lateinit var executor: DeviceCommandExecutor
    private lateinit var link: DesktopLink
    private var nsd: NsdDiscoveryHelper? = null

    private val handler = android.os.Handler(android.os.Looper.getMainLooper())
    private var pairRetry: Runnable? = null

    /** Addresses mDNS last resolved, retained so pairing can retry without it. */
    @Volatile private var lastSeenHosts: List<String> = emptyList()
    /** Guards against overlapping pair() calls from timer + NSD callback. */
    @Volatile private var pairing = false

    private val http = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(5, TimeUnit.SECONDS)
        .build()

    override fun onCreate() {
        super.onCreate()
        prefs = Prefs(this)

        executor = DeviceCommandExecutor(
            context = applicationContext,
            onVisualizerMode = { mode -> MainActivity.active?.pushVisualizerMode(mode) }
        ).also { it.initTts() }

        link = DesktopLink(executor) { state, detail ->
            lastState = state.name
            lastDetail = detail
            MainActivity.active?.pushLinkState(state.name, detail)
            updateNotification()
        }

        createChannel()
        startForeground(NOTIF_ID, buildNotification())

        if (prefs.isPaired) {
            connectSaved()
        }
        // Discovery runs regardless: it refreshes the desktop's address after
        // a DHCP change, which would otherwise strand an already-paired phone.
        startDiscovery()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        super.onStartCommand(intent, flags, startId)
        return START_STICKY
    }

    override fun onBind(intent: Intent): IBinder? {
        super.onBind(intent)
        return null
    }

    private fun startDiscovery() {
        nsd = NsdDiscoveryHelper(this) { hosts, _ ->
            lastSeenHosts = hosts
            if (prefs.isPaired) {
                // Reconnect only if the saved address is no longer advertised.
                if (prefs.host !in hosts) {
                    val next = hosts.firstOrNull() ?: return@NsdDiscoveryHelper
                    Log.i(TAG, "desktop moved to $next, reconnecting")
                    prefs.host = next
                    connectSaved()
                }
            } else {
                pairAny(hosts)
            }
        }.also { it.start() }

        startPairRetryLoop()
    }

    /**
     * Retries pairing on a timer for as long as the device is unpaired.
     *
     * Pairing used to be attempted ONLY from the NSD resolve callback, which
     * made the whole flow a race: the desktop hands out a token only while its
     * 5-minute pairing window is open, but discovery normally resolves long
     * before the user opens that window. The single attempt got a 403 and
     * nothing ever tried again, so the phone sat "OFFLINE" forever even after
     * the window opened. NSD also does not re-fire reliably after a
     * "service lost", so it cannot be the only trigger.
     */
    private fun startPairRetryLoop() {
        pairRetry = object : Runnable {
            override fun run() {
                if (!prefs.isPaired) {
                    val hosts = lastSeenHosts
                    if (hosts.isNotEmpty()) {
                        pairAny(hosts)
                    } else {
                        // Discovery has not resolved yet (mDNS can be flaky on
                        // consumer APs). Nudge it rather than waiting forever.
                        nsd?.stop()
                        nsd?.start()
                    }
                }
                // Keep polling even once paired: cheap, and it re-arms
                // immediately if the user ever clears pairing.
                handler.postDelayed(this, PAIR_RETRY_MS)
            }
        }
        handler.postDelayed(pairRetry!!, PAIR_RETRY_MS)
    }

    /**
     * Fetches the bridge token from the desktop. The desktop only answers while
     * the user has an explicit pairing window open, so an attacker on the same
     * Wi-Fi cannot silently claim the device.
     */
    /**
     * Tries each advertised address in turn until one hands back a token.
     * A multi-homed desktop advertises several; only one is reachable from the
     * phone's subnet, and there is no way to tell which from the phone side.
     */
    private fun pairAny(hosts: List<String>) {
        if (pairing || prefs.isPaired) return
        pairing = true
        Thread {
            try {
                for (host in hosts) {
                    if (prefs.isPaired) break
                    if (tryPair(host)) break
                }
            } finally {
                pairing = false
            }
        }.start()
    }

    /** @return true once a token has been obtained and the link started. */
    private fun tryPair(host: String): Boolean {
        return try {
            val payload = JSONObject()
                .put("model", "${Build.MANUFACTURER} ${Build.MODEL}")
                .put("android", Build.VERSION.RELEASE)
                .toString()

            val req = Request.Builder()
                .url("http://$host:$BRIDGE_PORT/pair")
                .post(payload.toRequestBody("application/json".toMediaType()))
                .build()

            http.newCall(req).execute().use { res ->
                val body = res.body?.string().orEmpty()
                if (!res.isSuccessful) {
                    // 403 = pairing window closed. Expected and common: the
                    // retry loop will come back once the user opens it.
                    Log.i(TAG, "pair refused by $host (${res.code}): $body")
                    return false
                }
                val json = JSONObject(body)
                val token = json.optString("token")
                val wsPort = json.optInt("wsPort", Prefs.DEFAULT_WS_PORT)
                if (token.isBlank()) {
                    Log.w(TAG, "pair response from $host had no token")
                    return false
                }
                prefs.save(host, wsPort, token)
                Log.i(TAG, "paired with $host:$wsPort")
                connectSaved()
                true
            }
        } catch (e: Exception) {
            Log.w(TAG, "pair to $host failed: ${e.message}")
            false
        }
    }

    private fun connectSaved() {
        val host = prefs.host ?: return
        val token = prefs.token ?: return
        link.connect(host, prefs.port, token)
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.link_channel_name),
            NotificationManager.IMPORTANCE_LOW   // silent; it is a status, not an alert
        ).apply { description = getString(R.string.link_channel_desc) }
        nm.createNotificationChannel(channel)
    }

    private fun buildNotification(): Notification {
        val tapIntent = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val text = when (lastState) {
            "CONNECTED" -> "Linked to $lastDetail"
            "CONNECTING" -> "Connecting to $lastDetail"
            else -> if (prefs.isPaired) "Waiting for desktop" else "Searching for JARVIS Desktop"
        }
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("JARVIS")
            .setContentText(text)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(tapIntent)
            .build()
    }

    private fun updateNotification() {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(NOTIF_ID, buildNotification())
    }

    override fun onDestroy() {
        pairRetry?.let { handler.removeCallbacks(it) }
        nsd?.stop()
        link.disconnect()
        executor.shutdown()
        super.onDestroy()
    }
}
