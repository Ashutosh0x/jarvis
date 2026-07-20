# The WebView JS bridge is reached reflectively from JavaScript — R8 cannot
# see those call sites, so the annotated members must be kept explicitly.
-keepclassmembers class com.jarvis.companion.ui.VisualizerBridge {
    public *;
}
-keepattributes JavascriptInterface

# OkHttp ships its own consumer rules; these silence the known-benign
# warnings from its optional Conscrypt/BouncyCastle code paths.
-dontwarn okhttp3.internal.platform.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
