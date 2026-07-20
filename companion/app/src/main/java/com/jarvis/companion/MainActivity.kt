package com.jarvis.companion

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.util.Log
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.webkit.WebViewAssetLoader
import com.jarvis.companion.audio.AudioFft
import com.jarvis.companion.services.LinkService

/**
 * Fullscreen host for the visualizer.
 *
 * The orb is the desktop app's own Three.js scene, loaded from assets. This
 * activity does three things: keep it on screen, feed it microphone FFT, and
 * reflect the desktop link state into its HUD.
 */
class MainActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "JarvisMain"
        private const val REQ_PERMS = 1001

        // Virtual origin backed by WebViewAssetLoader — nothing leaves the device.
        private const val VISUALIZER_URL =
            "https://appassets.androidplatform.net/assets/visualizer/index.html"

        /** Set so LinkService can push link state into the WebView. */
        @Volatile
        var active: MainActivity? = null
            private set
    }

    private lateinit var webView: WebView
    private var audioFft: AudioFft? = null
    private var visualizerReady = false

    // Throttle: the FFT thread produces ~43 frames/sec at 1024 samples, but
    // evaluateJavascript marshals across threads and the orb cannot show more
    // than display refresh anyway.
    private var lastPush = 0L

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        active = this

        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        // Serves app assets over https://appassets.androidplatform.net/ instead
        // of file://. The visualizer page uses <script type="module"> plus an
        // import map, and module scripts are fetched with CORS — from a file://
        // page the origin is opaque, the fetch is blocked, and the result is a
        // black screen with only a console error to show for it.
        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView = WebView(this).apply {
            setBackgroundColor(0x00000000)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            // Not needed once assets come from the loader, and leaving them on
            // widens the attack surface for no benefit.
            settings.allowFileAccess = false
            settings.allowContentAccess = false

            webChromeClient = object : WebChromeClient() {
                override fun onConsoleMessage(msg: ConsoleMessage): Boolean {
                    // WebGL/shader errors surface here and nowhere else —
                    // without this a black screen gives no clue why.
                    Log.d(TAG, "webview: ${msg.message()} @${msg.sourceId()}:${msg.lineNumber()}")
                    return true
                }
            }

            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(
                    view: WebView,
                    request: WebResourceRequest
                ): WebResourceResponse? = assetLoader.shouldInterceptRequest(request.url)

                override fun onPageFinished(view: WebView?, url: String?) {
                    visualizerReady = true
                    pushLinkState(LinkService.lastState, LinkService.lastDetail)
                }
            }
        }
        setContentView(webView)
        // Must follow setContentView: the insets controller is owned by the
        // DecorView, which does not exist until a content view is attached.
        goImmersive()
        webView.loadUrl(VISUALIZER_URL)

        ensurePermissions()
        LinkService.start(this)
    }

    private fun goImmersive() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(false)
            window.insetsController?.hide(android.view.WindowInsets.Type.systemBars())
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility =
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
                    View.SYSTEM_UI_FLAG_FULLSCREEN or
                    View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                    View.SYSTEM_UI_FLAG_LAYOUT_STABLE
        }
    }

    private fun ensurePermissions() {
        val needed = mutableListOf<String>()
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED
        ) needed += Manifest.permission.RECORD_AUDIO

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED
        ) needed += Manifest.permission.POST_NOTIFICATIONS

        if (needed.isEmpty()) startAudio() else
            ActivityCompat.requestPermissions(this, needed.toTypedArray(), REQ_PERMS)
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQ_PERMS) return
        val micIndex = permissions.indexOf(Manifest.permission.RECORD_AUDIO)
        if (micIndex >= 0 && grantResults.getOrNull(micIndex) == PackageManager.PERMISSION_GRANTED) {
            startAudio()
        } else {
            // The orb still renders and idles; it just won't react to sound.
            Log.i(TAG, "mic denied — visualizer will idle without FFT")
        }
    }

    private fun startAudio() {
        if (audioFft != null) return
        audioFft = AudioFft { volume, bins ->
            val now = System.currentTimeMillis()
            if (now - lastPush < 33) return@AudioFft   // ~30fps ceiling
            lastPush = now
            pushAudio(volume, bins)
        }.also { it.start() }
    }

    private fun pushAudio(volume: Float, bins: ByteArray) {
        if (!visualizerReady) return
        // Bins are unsigned 0..255 but Kotlin ByteArray is signed; mask before
        // serialising or every value above 127 arrives negative and the orb
        // reacts backwards.
        val sb = StringBuilder(bins.size * 4)
        sb.append('[')
        for (i in bins.indices) {
            if (i > 0) sb.append(',')
            sb.append(bins[i].toInt() and 0xFF)
        }
        sb.append(']')
        val js = "window.jarvisPushAudio && window.jarvisPushAudio($volume, $sb);"
        webView.post { webView.evaluateJavascript(js, null) }
    }

    fun pushLinkState(state: String, detail: String) {
        if (!visualizerReady) return
        val online = state == "CONNECTED"
        val label = when (state) {
            "CONNECTED" -> "Online"
            "CONNECTING" -> "Linking"
            else -> "Offline"
        }
        val js = "window.jarvisSetLinkState && window.jarvisSetLinkState(" +
            "${jsString(label)}, $online);"
        webView.post { webView.evaluateJavascript(js, null) }
    }

    fun pushVisualizerMode(mode: String) {
        if (!visualizerReady) return
        val js = "window.jarvisSetMode && window.jarvisSetMode(${jsString(mode)});"
        webView.post { webView.evaluateJavascript(js, null) }
    }

    private fun jsString(s: String): String =
        "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) goImmersive()
    }

    override fun onDestroy() {
        audioFft?.stop()
        audioFft = null
        if (active === this) active = null
        webView.destroy()
        super.onDestroy()
    }
}
