package com.jarvis.companion.network

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import android.util.Log

/**
 * Finds JARVIS Desktop on the LAN via mDNS so the user never types an IP.
 *
 * Guards against two real NsdManager foot-guns:
 *  - resolveService() throws if a resolve is already in flight, so resolves
 *    are serialised through a single-flight flag.
 *  - stopServiceDiscovery() throws IllegalArgumentException if the listener
 *    was never successfully registered.
 */
class NsdDiscoveryHelper(
    context: Context,
    /**
     * Receives EVERY address the desktop advertises, best-effort ordered.
     * A dev machine is usually multi-homed (VirtualBox/WSL/Docker adapters all
     * answer mDNS), and the first address is frequently a host-only bridge the
     * phone cannot route to — so the caller must be free to try the others.
     */
    private val onServerFound: (hosts: List<String>, port: Int) -> Unit
) {
    companion object {
        private const val TAG = "JarvisNsd"
        const val SERVICE_TYPE = "_jarvis._tcp."
        const val SERVICE_NAME = "JARVIS-Desktop"
    }

    private val nsdManager =
        context.applicationContext.getSystemService(Context.NSD_SERVICE) as NsdManager

    private var discovering = false
    private var resolveInFlight = false

    private val discoveryListener = object : NsdManager.DiscoveryListener {
        override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
            Log.e(TAG, "discovery start failed: $errorCode")
            discovering = false
        }

        override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {
            Log.e(TAG, "discovery stop failed: $errorCode")
        }

        override fun onDiscoveryStarted(regType: String) {
            Log.d(TAG, "discovery started")
            discovering = true
        }

        override fun onDiscoveryStopped(regType: String) {
            Log.d(TAG, "discovery stopped")
            discovering = false
        }

        override fun onServiceFound(service: NsdServiceInfo) {
            if (!service.serviceName.contains(SERVICE_NAME, ignoreCase = true)) return
            if (resolveInFlight) return
            resolveInFlight = true
            @Suppress("DEPRECATION") // resolveService replacement is API 34+ only
            nsdManager.resolveService(service, object : NsdManager.ResolveListener {
                override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
                    Log.e(TAG, "resolve failed: $errorCode")
                    resolveInFlight = false
                }

                override fun onServiceResolved(serviceInfo: NsdServiceInfo) {
                    resolveInFlight = false
                    val hosts = hostsOf(serviceInfo)
                    if (hosts.isEmpty()) return
                    Log.i(TAG, "resolved desktop at ${hosts.joinToString()}:${serviceInfo.port}")
                    onServerFound(hosts, serviceInfo.port)
                }
            })
        }

        override fun onServiceLost(service: NsdServiceInfo) {
            Log.d(TAG, "service lost: ${service.serviceName}")
        }
    }

    @Suppress("DEPRECATION")
    private fun hostsOf(info: NsdServiceInfo): List<String> {
        val raw = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            info.hostAddresses.mapNotNull { it.hostAddress }
        } else {
            listOfNotNull(info.host?.hostAddress)
        }
        // IPv4 only (the bridge binds 0.0.0.0), and drop the host-only /
        // link-local ranges outright — they are never the desktop's real LAN
        // address and each one costs a 5s connect timeout to rule out.
        return raw
            .filter { it.contains('.') && !it.contains(':') }
            .filterNot { it.startsWith("169.254.") || it.startsWith("192.168.56.") }
            .distinct()
    }

    fun start() {
        if (discovering) return
        try {
            nsdManager.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, discoveryListener)
        } catch (e: Exception) {
            Log.w(TAG, "discoverServices failed: ${e.message}")
        }
    }

    fun stop() {
        if (!discovering) return
        try {
            nsdManager.stopServiceDiscovery(discoveryListener)
        } catch (e: IllegalArgumentException) {
            Log.d(TAG, "listener was not registered: ${e.message}")
        }
        discovering = false
    }
}
