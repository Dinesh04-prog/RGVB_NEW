# Add project specific ProGuard rules here.
-keepattributes *Annotation*
-keep class com.nexuspos.app.** { *; }

# minifyEnabled is false today; these keep the WebView bridges and ML Kit working if it is turned on.
-keepattributes JavascriptInterface
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-keep class com.google.mlkit.** { *; }
-keep class com.google.android.gms.internal.mlkit_vision_** { *; }
