-keepattributes JavascriptInterface
-keepclassmembers class com.akatsuki.app.MainActivity$NativeBridge {
    @android.webkit.JavascriptInterface <methods>;
}
-keep class com.akatsuki.app.MainActivity$NativeBridge { *; }
-dontwarn okhttp3.**
-keep class okhttp3.** { *; }
