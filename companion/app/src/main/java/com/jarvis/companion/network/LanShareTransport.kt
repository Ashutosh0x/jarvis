package com.jarvis.companion.network

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import android.util.Log
import java.util.ArrayDeque

/**
 * The other half of the story: when both phones are already on the same Wi-Fi
 * — a home router, an office AP, a laptop hotspot — there is nothing to
 * negotiate. mDNS carries the same offer Wi-Fi Direct puts in its TXT record,
 * and the transfer runs over the network that already exists.
 *
 * Still no internet involved: mDNS is link-local multicast and the socket
 * never leaves the subnet.
 *
 * Mirrors the resolve serialisation in NsdDiscoveryHelper for the same reason
 * — resolveService throws outright if one is already in flight, so resolves
 * are queued rather than fired as services appear.
 */
class LanShareTransport(
    context: Context,
    private val onOffer: (ShareOffer) -> Unit,
    private val onStatus: (String) -> Unit,
    private val onError: (String) -> Unit,
) {
    companion object {
        private const val TAG = "JarvisLanShare"
    }

    private val nsd =
        context.applicationContext.getSystemService(Context.NSD_SERVICE) as NsdManager

    private var registration: NsdManager.RegistrationListener? = null
    private var discovery: NsdManager.DiscoveryListener? = null

    private val pending = ArrayDeque<NsdServiceInfo>()
    private var resolveInFlight = false
    private val seen = mutableSetOf<String>()

    // ---- sender ----------------------------------------------------------

    fun advertise(offer: ShareOffer) {
        if (registration != null) return
        val info = NsdServiceInfo().apply {
            serviceName = "${ShareOffer.INSTANCE_PREFIX}-${offer.port}"
            serviceType = ShareOffer.NSD_SERVICE_TYPE
            port = offer.port
            offer.toTxt().forEach { (k, v) -> setAttribute(k, v) }
        }
        val listener = object : NsdManager.RegistrationListener {
            override fun onServiceRegistered(info: NsdServiceInfo) {
                Log.i(TAG, "advertising ${info.serviceName}")
                onStatus("Visible on this Wi-Fi — waiting for the other phone…")
            }

            override fun onRegistrationFailed(info: NsdServiceInfo, errorCode: Int) {
                registration = null
                onError("Could not advertise on this network (error $errorCode)")
            }

            override fun onServiceUnregistered(info: NsdServiceInfo) = Unit
            override fun onUnregistrationFailed(info: NsdServiceInfo, errorCode: Int) = Unit
        }
        registration = listener
        nsd.registerService(info, NsdManager.PROTOCOL_DNS_SD, listener)
    }

    // ---- receiver --------------------------------------------------------

    fun discover() {
        if (discovery != null) return
        seen.clear()
        val listener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) {
                onStatus("Looking for a sender on this Wi-Fi…")
            }

            override fun onServiceFound(service: NsdServiceInfo) {
                if (!service.serviceName.startsWith(ShareOffer.INSTANCE_PREFIX)) return
                enqueueResolve(service)
            }

            override fun onServiceLost(service: NsdServiceInfo) {
                Log.d(TAG, "lost ${service.serviceName}")
            }

            override fun onDiscoveryStopped(serviceType: String) = Unit

            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                discovery = null
                onError("Could not search this network (error $errorCode)")
            }

            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {
                Log.w(TAG, "stop discovery failed: $errorCode")
            }
        }
        discovery = listener
        nsd.discoverServices(
            ShareOffer.NSD_SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, listener
        )
    }

    @Synchronized
    private fun enqueueResolve(service: NsdServiceInfo) {
        pending.add(service)
        pumpResolve()
    }

    @Synchronized
    private fun pumpResolve() {
        if (resolveInFlight) return
        val next = pending.poll() ?: return
        resolveInFlight = true

        @Suppress("DEPRECATION") // registerServiceInfoCallback is API 34+
        nsd.resolveService(next, object : NsdManager.ResolveListener {
            override fun onResolveFailed(info: NsdServiceInfo, errorCode: Int) {
                Log.w(TAG, "resolve failed for ${info.serviceName}: $errorCode")
                finishResolve()
            }

            override fun onServiceResolved(info: NsdServiceInfo) {
                val host = hostOf(info)
                val txt = info.attributes.mapNotNull { (k, v) ->
                    v?.let { k to String(it, Charsets.UTF_8) }
                }.toMap()

                val offer = ShareOffer.fromTxt(txt, host)
                when {
                    host == null -> Log.w(TAG, "${info.serviceName} resolved without an address")
                    offer == null -> Log.w(TAG, "${info.serviceName} has malformed TXT records")
                    seen.add("$host:${offer.port}") -> onOffer(offer)
                }
                finishResolve()
            }
        })
    }

    @Synchronized
    private fun finishResolve() {
        resolveInFlight = false
        pumpResolve()
    }

    @Suppress("DEPRECATION")
    private fun hostOf(info: NsdServiceInfo): String? {
        val raw = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            info.hostAddresses.mapNotNull { it.hostAddress }
        } else {
            listOfNotNull(info.host?.hostAddress)
        }
        // IPv4 only — the server binds 0.0.0.0, and a link-local address is
        // never the one that works.
        return raw.firstOrNull {
            it.contains('.') && !it.contains(':') && !it.startsWith("169.254.")
        }
    }

    // ---- teardown --------------------------------------------------------

    fun stop() {
        registration?.let {
            try {
                nsd.unregisterService(it)
            } catch (e: IllegalArgumentException) {
                Log.d(TAG, "registration was not active")
            }
        }
        registration = null

        discovery?.let {
            try {
                nsd.stopServiceDiscovery(it)
            } catch (e: IllegalArgumentException) {
                Log.d(TAG, "discovery was not active")
            }
        }
        discovery = null

        synchronized(this) {
            pending.clear()
            seen.clear()
        }
    }
}
