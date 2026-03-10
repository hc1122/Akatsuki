package com.akatsuki.app

import android.annotation.SuppressLint
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.view.View
import android.view.WindowManager
import android.webkit.*
import androidx.appcompat.app.AppCompatActivity
import kotlinx.coroutines.*
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit

class MainActivity : AppCompatActivity() {
    private lateinit var webView: WebView
    private val scope = CoroutineScope(Dispatchers.Main + SupervisorJob())
    private val handler = Handler(Looper.getMainLooper())
    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .writeTimeout(10, TimeUnit.SECONDS)
        .connectionPool(ConnectionPool(5, 5, TimeUnit.MINUTES))
        .build()
    private val prefs by lazy { getSharedPreferences("akatsuki_prefs", MODE_PRIVATE) }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_LAYOUT_STABLE or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
        )

        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.databaseEnabled = true
            settings.allowFileAccess = true
            settings.cacheMode = WebSettings.LOAD_NO_CACHE
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            settings.setSupportZoom(false)
            settings.builtInZoomControls = false
            settings.useWideViewPort = true
            settings.loadWithOverviewMode = true
            webViewClient = object : WebViewClient() {
                override fun onReceivedError(view: WebView?, request: WebResourceRequest?, error: WebResourceError?) {
                    super.onReceivedError(view, request, error)
                }
            }
            addJavascriptInterface(NativeBridge(), "NativeBridge")
            loadUrl("file:///android_asset/index.html")
        }
        setContentView(webView)
    }

    @Deprecated("Use OnBackPressedDispatcher")
    override fun onBackPressed() {
        if (webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }

    override fun onDestroy() {
        scope.cancel()
        webView.destroy()
        super.onDestroy()
    }

    inner class NativeBridge {

        @JavascriptInterface
        fun httpRequest(callbackId: String, method: String, url: String, headersJson: String, body: String, contentType: String) {
            scope.launch(Dispatchers.IO) {
                try {
                    val headers = if (headersJson.isNotEmpty()) JSONObject(headersJson) else JSONObject()
                    val builder = Request.Builder().url(url)
                    headers.keys().forEach { key ->
                        builder.addHeader(key, headers.getString(key))
                    }

                    val reqBody = if (body.isNotEmpty()) {
                        val ct = if (contentType.isNotEmpty()) contentType else "application/json"
                        body.toRequestBody(ct.toMediaType())
                    } else null

                    when (method.uppercase()) {
                        "POST" -> builder.post(reqBody ?: "".toRequestBody("application/json".toMediaType()))
                        "PUT" -> builder.put(reqBody ?: "".toRequestBody("application/json".toMediaType()))
                        "DELETE" -> if (reqBody != null) builder.delete(reqBody) else builder.delete()
                        else -> builder.get()
                    }

                    val response = client.newCall(builder.build()).execute()
                    val responseBody = response.body?.string() ?: "{}"
                    val statusCode = response.code
                    val b64 = Base64.encodeToString(responseBody.toByteArray(Charsets.UTF_8), Base64.NO_WRAP)

                    handler.post {
                        webView.evaluateJavascript(
                            "window.__nativeCallback('$callbackId',$statusCode,'$b64')", null
                        )
                    }
                } catch (e: Exception) {
                    val errMsg = (e.message ?: "Network error").replace("'", "\\'").replace("\n", " ")
                    val errJson = """{"error":"$errMsg"}"""
                    val b64 = Base64.encodeToString(errJson.toByteArray(Charsets.UTF_8), Base64.NO_WRAP)
                    handler.post {
                        webView.evaluateJavascript(
                            "window.__nativeCallback('$callbackId',0,'$b64')", null
                        )
                    }
                }
            }
        }

        @JavascriptInterface
        fun downloadText(callbackId: String, url: String, headersJson: String) {
            scope.launch(Dispatchers.IO) {
                try {
                    val headers = if (headersJson.isNotEmpty()) JSONObject(headersJson) else JSONObject()
                    val builder = Request.Builder().url(url).get()
                    headers.keys().forEach { key ->
                        builder.addHeader(key, headers.getString(key))
                    }
                    val response = client.newCall(builder.build()).execute()
                    val text = response.body?.string() ?: ""
                    val file = File(cacheDir, "csv_$callbackId.txt")
                    file.writeText(text)
                    handler.post {
                        webView.evaluateJavascript(
                            "window.__nativeDownloadDone('$callbackId','${file.absolutePath}',${text.length})", null
                        )
                    }
                } catch (e: Exception) {
                    handler.post {
                        webView.evaluateJavascript(
                            "window.__nativeDownloadDone('$callbackId','',0)", null
                        )
                    }
                }
            }
        }

        @JavascriptInterface
        fun readFileChunk(path: String, offset: Int, length: Int): String {
            return try {
                val file = File(path)
                if (!file.exists()) return ""
                val reader = file.bufferedReader()
                val text = reader.use { it.readText() }
                val end = minOf(offset + length, text.length)
                if (offset >= text.length) "" else text.substring(offset, end)
            } catch (e: Exception) { "" }
        }

        @JavascriptInterface
        fun getFileSize(path: String): Long {
            return try { File(path).length() } catch (e: Exception) { 0 }
        }

        @JavascriptInterface
        fun saveData(key: String, value: String) {
            prefs.edit().putString(key, value).apply()
        }

        @JavascriptInterface
        fun loadData(key: String): String {
            return prefs.getString(key, "") ?: ""
        }

        @JavascriptInterface
        fun deleteData(key: String) {
            prefs.edit().remove(key).apply()
        }

        @JavascriptInterface
        fun deleteFile(path: String) {
            try { File(path).delete() } catch (_: Exception) {}
        }
    }
}
