package com.jarvis.companion.share

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.location.LocationManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.util.Log
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import com.jarvis.companion.R
import com.jarvis.companion.databinding.ActivityApkShareBinding
import com.jarvis.companion.network.ApkPayload
import com.jarvis.companion.network.ApkTransferClient
import com.jarvis.companion.network.ApkTransferServer
import com.jarvis.companion.network.LanShareTransport
import com.jarvis.companion.network.ShareOffer
import com.jarvis.companion.network.WifiDirectTransport
import java.io.File
import kotlin.concurrent.thread

/**
 * Moves an APK between two phones with no internet, no router, and no cloud.
 *
 * The whole path is: pick a file, advertise it over Wi-Fi Direct (or plain
 * mDNS when both phones already share a network), serve it from a one-shot
 * HTTP server, verify the SHA-256 on arrival, and hand the result to the
 * system package installer.
 *
 * Reachable from the launcher as "JARVIS Share", and registered for ACTION_SEND
 * so an APK can be shared straight in from any file manager.
 */
class ApkShareActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "JarvisApkShare"
        private const val REQ_NEARBY = 2001

        /** Runtime grants Wi-Fi Direct needs, which differ across the API 33 line. */
        private val nearbyPermissions: Array<String>
            get() = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                arrayOf(Manifest.permission.NEARBY_WIFI_DEVICES)
            } else {
                // Below 33 the Wi-Fi Direct APIs are gated on fine location.
                // Coarse rides along because Android 12 refuses to show the
                // precise option unless both are requested together — but only
                // the precise grant actually makes discovery return peers.
                arrayOf(
                    Manifest.permission.ACCESS_FINE_LOCATION,
                    Manifest.permission.ACCESS_COARSE_LOCATION,
                )
            }

        /** The one grant in [nearbyPermissions] that the radio genuinely needs. */
        private val decisivePermission: String
            get() = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                Manifest.permission.NEARBY_WIFI_DEVICES
            } else {
                Manifest.permission.ACCESS_FINE_LOCATION
            }
    }

    private lateinit var binding: ActivityApkShareBinding

    private var wifiDirect: WifiDirectTransport? = null
    private var lan: LanShareTransport? = null
    private var server: ApkTransferServer? = null
    private var client: ApkTransferClient? = null

    private var downloaded: File? = null
    private var pendingRole: Role? = null

    private enum class Role { SEND_SELF, SEND_PICKED, RECEIVE }

    private val useWifiDirect: Boolean get() = binding.radioDirect.isChecked

    private val pickApk = registerForActivityResult(
        ActivityResultContracts.OpenDocument()
    ) { uri -> if (uri != null) startSending { ApkPayload.fromUri(this, uri) } }

    private val afterInstallPermission = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { downloaded?.let { launchInstaller(it) } }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityApkShareBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.transportGroup.setOnCheckedChangeListener { _, _ ->
            binding.transportHint.setText(
                if (useWifiDirect) R.string.share_hint_direct else R.string.share_hint_lan
            )
            reset()
        }

        binding.btnSendSelf.setOnClickListener {
            withNearbyPermission(Role.SEND_SELF) {
                startSending { ApkPayload.ownApk(this) }
            }
        }
        binding.btnSendPick.setOnClickListener {
            withNearbyPermission(Role.SEND_PICKED) {
                pickApk.launch(
                    arrayOf(
                        "application/vnd.android.package-archive",
                        // Plenty of file managers hand APKs back as a generic
                        // blob; without this the picker greys them all out.
                        "application/octet-stream",
                    )
                )
            }
        }
        binding.btnReceive.setOnClickListener {
            withNearbyPermission(Role.RECEIVE) { startReceiving() }
        }
        binding.btnInstall.setOnClickListener { downloaded?.let { install(it) } }
        binding.btnReset.setOnClickListener { reset() }

        handleShareIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleShareIntent(intent)
    }

    /** An APK shared in from a file manager skips straight to sending. */
    private fun handleShareIntent(intent: Intent?) {
        if (intent?.action != Intent.ACTION_SEND) return
        @Suppress("DEPRECATION") // typed getParcelableExtra is API 33+
        val uri = intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM) ?: return
        withNearbyPermission(Role.SEND_PICKED) {
            startSending { ApkPayload.fromUri(this, uri) }
        }
    }

    // ---- sending ---------------------------------------------------------

    /**
     * [source] is invoked off the main thread: it hashes the whole archive,
     * which for a 100 MB APK is comfortably longer than a dropped frame.
     */
    private fun startSending(source: () -> ApkPayload) {
        teardown()
        setBusy(true)
        status(getString(R.string.share_status_hashing))

        thread(name = "apk-share-stage") {
            val payload = try {
                source()
            } catch (e: Exception) {
                Log.w(TAG, "staging failed", e)
                runOnUiThread { fail(e.message ?: "Could not read that file") }
                return@thread
            }
            runOnUiThread { serve(payload) }
        }
    }

    private fun serve(payload: ApkPayload) {
        val transfer = ApkTransferServer(
            payload = payload,
            onProgress = { sent, total -> runOnUiThread { showProgress(sent, total) } },
            onDone = { error ->
                runOnUiThread {
                    if (error == null) {
                        status(getString(R.string.share_status_sent, payload.displayName))
                        detail(getString(R.string.share_detail_sha, payload.sha256))
                        finished()
                    } else {
                        fail(error)
                    }
                }
            },
        )
        server = transfer

        val port = try {
            transfer.start()
        } catch (e: Exception) {
            fail("Could not open a port: ${e.message}")
            return
        }

        val offer = ShareOffer(
            deviceName = "${Build.MANUFACTURER} ${Build.MODEL}".trim(),
            fileName = payload.displayName,
            sizeBytes = payload.sizeBytes,
            sha256 = payload.sha256,
            port = port,
            token = transfer.token,
        )
        detail(
            getString(R.string.share_detail_offering, payload.displayName, payload.sizeLabel)
        )

        if (useWifiDirect) {
            if (locationServicesBlocked()) {
                fail(getString(R.string.share_error_location_off))
                return
            }
            val direct = newWifiDirect()
            if (!direct.start()) {
                fail(getString(R.string.share_error_no_direct))
                return
            }
            direct.advertise(offer) { /* group is up; nothing else to do but wait */ }
        } else {
            newLan().advertise(offer)
        }
    }

    // ---- receiving -------------------------------------------------------

    private fun startReceiving() {
        teardown()
        setBusy(true)
        binding.peers.removeAllViews()
        status(getString(R.string.share_status_searching))

        if (useWifiDirect) {
            if (locationServicesBlocked()) {
                fail(getString(R.string.share_error_location_off))
                return
            }
            val direct = newWifiDirect()
            if (!direct.start()) {
                fail(getString(R.string.share_error_no_direct))
                return
            }
            direct.discover()
        } else {
            newLan().discover()
        }
    }

    private fun addOffer(offer: ShareOffer) {
        val row = Button(this).apply {
            text = getString(
                R.string.share_peer_row, offer.deviceName, offer.fileName, offer.sizeLabel
            )
            gravity = Gravity.START or Gravity.CENTER_VERTICAL
            isAllCaps = false
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            )
            setOnClickListener { accept(offer) }
        }
        binding.peers.addView(row)
    }

    private fun accept(offer: ShareOffer) {
        binding.peers.removeAllViews()
        if (useWifiDirect) {
            status(getString(R.string.share_status_joining, offer.deviceName))
            wifiDirect?.connect(offer) { host ->
                runOnUiThread { download(offer.copy(host = host)) }
            }
        } else {
            download(offer)
        }
    }

    private fun download(offer: ShareOffer) {
        status(getString(R.string.share_status_receiving, offer.fileName))
        val transfer = ApkTransferClient(this)
        client = transfer
        transfer.fetch(
            offer = offer,
            onProgress = { got, total -> runOnUiThread { showProgress(got, total) } },
            onDone = { file, error ->
                runOnUiThread {
                    if (file != null) {
                        downloaded = file
                        status(getString(R.string.share_status_verified))
                        detail(getString(R.string.share_detail_sha, offer.sha256))
                        binding.btnInstall.visibility = View.VISIBLE
                        finished()
                    } else {
                        fail(error ?: "Transfer failed")
                    }
                }
            },
        )
    }

    // ---- install ---------------------------------------------------------

    private fun install(file: File) {
        // Sideloading is gated per-app since Oreo. Sending the user to the
        // settings page directly is the only way to clear it; the installer
        // intent just bounces otherwise.
        if (!packageManager.canRequestPackageInstalls()) {
            status(getString(R.string.share_status_allow_installs))
            afterInstallPermission.launch(
                Intent(
                    Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:$packageName"),
                )
            )
            return
        }
        launchInstaller(file)
    }

    private fun launchInstaller(file: File) {
        if (!packageManager.canRequestPackageInstalls()) return
        val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", file)
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        try {
            startActivity(intent)
        } catch (e: Exception) {
            fail("No installer available: ${e.message}")
        }
    }

    // ---- permissions -----------------------------------------------------

    private fun withNearbyPermission(role: Role, action: () -> Unit) {
        if (!useWifiDirect) return action()

        val missing = nearbyPermissions.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isEmpty()) return action()

        pendingRole = role
        requestPermissions(missing.toTypedArray(), REQ_NEARBY)
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQ_NEARBY) return
        val role = pendingRole
        pendingRole = null

        // Android 12 can come back with coarse granted and fine denied, which
        // looks like success and then finds no peers at all. Judge the one
        // permission that decides whether the radio works.
        val decisive = permissions.indexOf(decisivePermission)
        val ok = decisive >= 0 &&
            grantResults.getOrNull(decisive) == PackageManager.PERMISSION_GRANTED
        if (!ok) {
            fail(getString(R.string.share_error_permission))
            return
        }
        when (role) {
            Role.SEND_SELF -> startSending { ApkPayload.ownApk(this) }
            Role.SEND_PICKED -> pickApk.launch(
                arrayOf(
                    "application/vnd.android.package-archive",
                    "application/octet-stream",
                )
            )
            Role.RECEIVE -> startReceiving()
            null -> Unit
        }
    }

    // ---- transports ------------------------------------------------------

    /**
     * Below API 33, Wi-Fi Direct discovery returns an empty peer list while
     * the location master switch is off, with no error anywhere to explain it.
     * Better to say so than to spin forever finding nothing.
     */
    private fun locationServicesBlocked(): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) return false
        val lm = getSystemService(LocationManager::class.java) ?: return false
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            !lm.isLocationEnabled
        } else {
            !lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER) &&
                !lm.isProviderEnabled(LocationManager.GPS_PROVIDER)
        }
    }

    private fun newWifiDirect(): WifiDirectTransport =
        WifiDirectTransport(
            context = this,
            onOffer = { runOnUiThread { addOffer(it) } },
            onStatus = { runOnUiThread { status(it) } },
            onError = { runOnUiThread { fail(it) } },
        ).also { wifiDirect = it }

    private fun newLan(): LanShareTransport =
        LanShareTransport(
            context = this,
            onOffer = { runOnUiThread { addOffer(it) } },
            onStatus = { runOnUiThread { status(it) } },
            onError = { runOnUiThread { fail(it) } },
        ).also { lan = it }

    // ---- ui plumbing -----------------------------------------------------

    private fun status(text: String) {
        binding.txtStatus.text = text
    }

    private fun detail(text: String) {
        binding.txtDetail.text = text
    }

    private fun showProgress(done: Long, total: Long) {
        binding.progress.visibility = View.VISIBLE
        // Permille rather than percent: on a 100 MB file a whole percent is
        // a megabyte of apparently frozen bar.
        binding.progress.progress =
            if (total > 0) ((done * 1000) / total).toInt().coerceIn(0, 1000) else 0
        detail(
            getString(
                R.string.share_detail_progress,
                ShareOffer.humanSize(done),
                ShareOffer.humanSize(total),
            )
        )
    }

    private fun setBusy(busy: Boolean) {
        binding.btnSendSelf.isEnabled = !busy
        binding.btnSendPick.isEnabled = !busy
        binding.btnReceive.isEnabled = !busy
        binding.transportGroup.isEnabled = !busy
        binding.radioDirect.isEnabled = !busy
        binding.radioLan.isEnabled = !busy
        binding.btnReset.visibility = if (busy) View.VISIBLE else View.GONE
        if (!busy) binding.progress.visibility = View.GONE
    }

    private fun finished() {
        binding.progress.visibility = View.VISIBLE
        binding.btnReset.visibility = View.VISIBLE
        teardownTransports()
    }

    private fun fail(message: String) {
        status(getString(R.string.share_status_failed, message))
        binding.progress.visibility = View.GONE
        binding.btnReset.visibility = View.VISIBLE
        teardownTransports()
    }

    private fun reset() {
        teardown()
        downloaded = null
        binding.peers.removeAllViews()
        binding.btnInstall.visibility = View.GONE
        binding.progress.progress = 0
        detail("")
        status(getString(R.string.share_status_idle))
        setBusy(false)
    }

    /** Stops discovery and the radio group but leaves a finished result on screen. */
    private fun teardownTransports() {
        wifiDirect?.stop()
        wifiDirect = null
        lan?.stop()
        lan = null
    }

    private fun teardown() {
        teardownTransports()
        server?.stop()
        server = null
        client?.cancel()
        client = null
    }

    override fun onDestroy() {
        teardown()
        super.onDestroy()
    }
}
