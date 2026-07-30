package com.jarvis.companion.network

import android.annotation.SuppressLint
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.wifi.p2p.WifiP2pConfig
import android.net.wifi.p2p.WifiP2pDevice
import android.net.wifi.p2p.WifiP2pInfo
import android.net.wifi.p2p.WifiP2pManager
import android.net.wifi.p2p.nsd.WifiP2pDnsSdServiceInfo
import android.net.wifi.p2p.nsd.WifiP2pDnsSdServiceRequest
import android.os.Looper
import android.util.Log
import androidx.core.content.ContextCompat

/**
 * Peer-to-peer link between two handsets with no router, no hotspot to join,
 * and nothing for the user to type.
 *
 * The sender becomes an autonomous group owner. That is the one arrangement
 * where both sides know the sender's address without exchanging it: a Wi-Fi
 * Direct group owner is always 192.168.49.1, and the joining client reads it
 * straight out of WifiP2pInfo. Left to normal negotiation the roles are
 * decided by intent values at connect time, and half the time the phone
 * holding the file ends up as the client — reachable only at an address
 * nobody has told the other side.
 *
 * The offer's port and token ride in a DNS-SD TXT record, so the receiver
 * knows exactly what it is joining before the group even forms.
 */
class WifiDirectTransport(
    private val context: Context,
    private val onOffer: (ShareOffer) -> Unit,
    private val onStatus: (String) -> Unit,
    private val onError: (String) -> Unit,
) {
    companion object {
        private const val TAG = "JarvisP2p"
        /** Group owner address is fixed by the Wi-Fi Direct spec's DHCP range. */
        const val GROUP_OWNER_ADDRESS = "192.168.49.1"
    }

    private val manager: WifiP2pManager? =
        context.getSystemService(Context.WIFI_P2P_SERVICE) as? WifiP2pManager
    private var channel: WifiP2pManager.Channel? = null
    private var receiver: BroadcastReceiver? = null

    /** Filled in as soon as a group forms; the address to hand the client. */
    @Volatile private var onGroupReady: ((host: String) -> Unit)? = null

    /** TXT records seen during discovery, keyed by peer MAC, awaiting nothing else. */
    private val seen = mutableMapOf<String, ShareOffer>()

    val isSupported: Boolean get() = manager != null

    fun start(): Boolean {
        val m = manager ?: return false
        if (channel != null) return true
        channel = m.initialize(context, Looper.getMainLooper()) {
            Log.w(TAG, "p2p channel disconnected")
            channel = null
        }
        registerReceiver()
        return channel != null
    }

    fun stop() {
        val m = manager
        val c = channel
        receiver?.let {
            try {
                context.unregisterReceiver(it)
            } catch (e: IllegalArgumentException) {
                Log.d(TAG, "receiver was not registered")
            }
        }
        receiver = null
        onGroupReady = null
        seen.clear()

        if (m != null && c != null) {
            // Order matters: drop the advertisement and the outstanding
            // request before tearing the group down, or the framework keeps
            // answering probes for a service that no longer has a server.
            m.clearLocalServices(c, null)
            m.clearServiceRequests(c, null)
            m.removeGroup(c, null)
        }
        channel = null
    }

    // ---- sender ----------------------------------------------------------

    /**
     * Creates the group and advertises the offer. [onReady] fires once the
     * group exists — the sender is then reachable at [GROUP_OWNER_ADDRESS].
     */
    @SuppressLint("MissingPermission") // caller gates on the runtime grant
    fun advertise(offer: ShareOffer, onReady: () -> Unit) {
        val m = manager ?: return onError("This device has no Wi-Fi Direct radio")
        val c = channel ?: return onError("Wi-Fi Direct is not initialised")

        onStatus("Creating a private Wi-Fi Direct group…")
        m.createGroup(c, object : WifiP2pManager.ActionListener {
            override fun onSuccess() {
                publishService(m, c, offer)
                onReady()
            }

            override fun onFailure(reason: Int) {
                // BUSY here almost always means a group from a previous run is
                // still up. Tearing it down and retrying once is the fix that
                // otherwise requires the user to toggle Wi-Fi off and on.
                if (reason == WifiP2pManager.BUSY) {
                    m.removeGroup(c, object : WifiP2pManager.ActionListener {
                        override fun onSuccess() = advertise(offer, onReady)
                        override fun onFailure(r: Int) =
                            onError("Wi-Fi Direct is busy (${reasonText(r)})")
                    })
                } else {
                    onError("Could not create the group: ${reasonText(reason)}")
                }
            }
        })
    }

    @SuppressLint("MissingPermission")
    private fun publishService(
        m: WifiP2pManager,
        c: WifiP2pManager.Channel,
        offer: ShareOffer,
    ) {
        val info = WifiP2pDnsSdServiceInfo.newInstance(
            "${ShareOffer.INSTANCE_PREFIX}-${offer.port}",
            ShareOffer.P2P_SERVICE_TYPE,
            offer.toTxt(),
        )
        m.clearLocalServices(c, object : WifiP2pManager.ActionListener {
            override fun onSuccess() {
                m.addLocalService(c, info, object : WifiP2pManager.ActionListener {
                    override fun onSuccess() {
                        onStatus("Waiting for the other phone to pick this up…")
                    }

                    override fun onFailure(reason: Int) =
                        onError("Could not advertise: ${reasonText(reason)}")
                })
            }

            override fun onFailure(reason: Int) =
                onError("Could not reset advertisements: ${reasonText(reason)}")
        })
    }

    // ---- receiver --------------------------------------------------------

    /** Starts listening for offers. Each one found is reported to [onOffer]. */
    @SuppressLint("MissingPermission")
    fun discover() {
        val m = manager ?: return onError("This device has no Wi-Fi Direct radio")
        val c = channel ?: return onError("Wi-Fi Direct is not initialised")
        seen.clear()

        m.setDnsSdResponseListeners(
            c,
            { _, _, _ -> /* instance-level callback; the TXT one carries the payload */ },
            { _, txt, device ->
                val offer = ShareOffer.fromTxt(
                    txt = txt,
                    host = null, // no address until the group forms
                    p2pAddress = device.deviceAddress,
                )
                if (offer == null) {
                    Log.d(TAG, "ignoring malformed TXT from ${device.deviceAddress}")
                } else {
                    val named = offer.copy(
                        deviceName = device.deviceName.ifBlank { offer.deviceName }
                    )
                    if (seen.put(device.deviceAddress, named) == null) onOffer(named)
                }
            },
        )

        val request = WifiP2pDnsSdServiceRequest.newInstance(ShareOffer.P2P_SERVICE_TYPE)
        m.clearServiceRequests(c, object : WifiP2pManager.ActionListener {
            override fun onSuccess() {
                m.addServiceRequest(c, request, object : WifiP2pManager.ActionListener {
                    override fun onSuccess() {
                        onStatus("Looking for a nearby phone…")
                        m.discoverServices(c, object : WifiP2pManager.ActionListener {
                            override fun onSuccess() = Unit
                            override fun onFailure(reason: Int) = onError(
                                "Discovery failed: ${reasonText(reason)}"
                            )
                        })
                    }

                    override fun onFailure(reason: Int) =
                        onError("Could not request services: ${reasonText(reason)}")
                })
            }

            override fun onFailure(reason: Int) =
                onError("Could not reset service requests: ${reasonText(reason)}")
        })
    }

    /** Joins the sender's group. [onReady] gets the address to download from. */
    @SuppressLint("MissingPermission")
    fun connect(offer: ShareOffer, onReady: (host: String) -> Unit) {
        val m = manager ?: return onError("This device has no Wi-Fi Direct radio")
        val c = channel ?: return onError("Wi-Fi Direct is not initialised")
        val address = offer.p2pAddress ?: return onError("That offer has no peer address")

        onGroupReady = onReady
        onStatus("Joining ${offer.deviceName}…")

        val config = WifiP2pConfig().apply {
            deviceAddress = address
            // The sender already owns a group; asking for zero intent keeps
            // this side a client so the group owner stays the phone that
            // actually has the file.
            groupOwnerIntent = 0
        }
        m.connect(c, config, object : WifiP2pManager.ActionListener {
            override fun onSuccess() = Unit // completion arrives as a broadcast
            override fun onFailure(reason: Int) {
                onGroupReady = null
                onError("Could not join: ${reasonText(reason)}")
            }
        })
    }

    // ---- broadcasts ------------------------------------------------------

    private fun registerReceiver() {
        val filter = IntentFilter().apply {
            addAction(WifiP2pManager.WIFI_P2P_STATE_CHANGED_ACTION)
            addAction(WifiP2pManager.WIFI_P2P_CONNECTION_CHANGED_ACTION)
        }
        val r = object : BroadcastReceiver() {
            override fun onReceive(ctx: Context, intent: Intent) {
                when (intent.action) {
                    WifiP2pManager.WIFI_P2P_STATE_CHANGED_ACTION -> {
                        val enabled = intent.getIntExtra(
                            WifiP2pManager.EXTRA_WIFI_STATE, -1
                        ) == WifiP2pManager.WIFI_P2P_STATE_ENABLED
                        if (!enabled) onError("Wi-Fi is off — Wi-Fi Direct needs the radio on")
                    }

                    WifiP2pManager.WIFI_P2P_CONNECTION_CHANGED_ACTION -> {
                        @Suppress("DEPRECATION") // typed extra is API 29+ only
                        val info = intent.getParcelableExtra<WifiP2pInfo>(
                            WifiP2pManager.EXTRA_WIFI_P2P_INFO
                        )
                        handleConnectionInfo(info)
                    }
                }
            }
        }
        ContextCompat.registerReceiver(
            context, r, filter, ContextCompat.RECEIVER_NOT_EXPORTED
        )
        receiver = r
    }

    private fun handleConnectionInfo(info: WifiP2pInfo?) {
        if (info == null || !info.groupFormed) return
        val ready = onGroupReady ?: return

        if (info.isGroupOwner) {
            // Only reachable if the sender's group vanished and this phone got
            // promoted. The sender's address is unknowable from here, so stop
            // rather than dial into the dark.
            onGroupReady = null
            onError("Joined as group owner — ask the sender to restart the share")
            return
        }
        val host = info.groupOwnerAddress?.hostAddress ?: GROUP_OWNER_ADDRESS
        onGroupReady = null
        onStatus("Connected — $host")
        ready(host)
    }

    private fun reasonText(reason: Int): String = when (reason) {
        WifiP2pManager.P2P_UNSUPPORTED -> "not supported on this device"
        WifiP2pManager.BUSY -> "the Wi-Fi Direct stack is busy"
        WifiP2pManager.ERROR -> "internal error"
        WifiP2pManager.NO_SERVICE_REQUESTS -> "no service requests"
        else -> "code $reason"
    }
}
