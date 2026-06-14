package com.nexuspos.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Message
import android.util.Log
import android.view.ViewGroup
import android.webkit.*
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat

class MainActivity : AppCompatActivity() {

    lateinit var webView: WebView
    lateinit var btManager: BluetoothPrintManager

    companion object {
        private const val TAG = "NexusPOS"
        private const val PERMISSION_REQUEST = 1001
        // Domains that belong to our app — navigate inside WebView
        private val APP_HOSTS = setOf("appassets.androidplatform.net")
        // Domains that belong to Google OAuth — open in a popup WebView, not externally
        private val GOOGLE_HOSTS = setOf(
            "accounts.google.com", "oauth2.googleapis.com",
            "apis.google.com", "content.googleapis.com"
        )
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        btManager = BluetoothPrintManager(this)
        webView = findViewById(R.id.webView)

        setupWebView()
        requestAllPermissions()
        webView.loadUrl("https://appassets.androidplatform.net/index.html")
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        with(webView.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            cacheMode = WebSettings.LOAD_DEFAULT
            setSupportMultipleWindows(true)   // required for onCreateWindow
            javaScriptCanOpenWindowsAutomatically = true
            // Full Chrome Mobile UA — prevents Google from blocking OAuth in WebView
            userAgentString = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.82 Mobile Safari/537.36"
        }

        webView.addJavascriptInterface(AndroidBtBridge(this), "AndroidBT")

        webView.webViewClient = object : WebViewClientCompat() {

            override fun shouldInterceptRequest(
                view: WebView, request: WebResourceRequest
            ): WebResourceResponse? = assetLoader.shouldInterceptRequest(request.url)

            override fun shouldOverrideUrlLoading(
                view: WebView, request: WebResourceRequest
            ): Boolean {
                val host = request.url.host ?: return false
                // App URLs — load inside WebView normally
                if (APP_HOSTS.any { host.endsWith(it) }) return false
                // Google OAuth hosts — let the popup WebView handle these (not override)
                if (GOOGLE_HOSTS.any { host.endsWith(it) }) return false
                // Any other external URL — prevent navigation (keep user in app)
                Log.w(TAG, "Blocked external navigation to: ${request.url}")
                return true
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                injectBluetoothBridge()
            }

            override fun onReceivedError(
                view: WebView, request: WebResourceRequest, error: WebResourceError
            ) {
                Log.e(TAG, "WebView error: ${error.description} on ${request.url}")
            }
        }

        webView.webChromeClient = object : WebChromeClient() {

            // Bridge JS console messages to Android logcat
            override fun onConsoleMessage(msg: ConsoleMessage): Boolean {
                val level = when (msg.messageLevel()) {
                    ConsoleMessage.MessageLevel.ERROR -> Log.ERROR
                    ConsoleMessage.MessageLevel.WARNING -> Log.WARN
                    else -> Log.DEBUG
                }
                Log.println(level, TAG, "[JS] ${msg.message()} — ${msg.sourceId()}:${msg.lineNumber()}")
                return true
            }

            // Handle popups opened by Google OAuth (window.open)
            override fun onCreateWindow(
                view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message?
            ): Boolean {
                val popupWebView = WebView(this@MainActivity)
                popupWebView.settings.javaScriptEnabled = true
                popupWebView.settings.domStorageEnabled = true
                popupWebView.settings.userAgentString = webView.settings.userAgentString

                // Add popup WebView on top of the main view
                val container = webView.parent as ViewGroup
                val params = ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT
                )
                container.addView(popupWebView, params)

                popupWebView.webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(
                        view: WebView, request: WebResourceRequest
                    ): Boolean {
                        val host = request.url.host ?: return false
                        // When OAuth redirects back to our app, close popup and load in main WebView
                        if (APP_HOSTS.any { host.endsWith(it) }) {
                            container.removeView(popupWebView)
                            webView.loadUrl(request.url.toString())
                            return true
                        }
                        return false
                    }
                }

                popupWebView.webChromeClient = object : WebChromeClient() {
                    override fun onCloseWindow(window: WebView?) {
                        container.removeView(popupWebView)
                    }
                }

                // Wire the popup's transport to the new WebView
                val transport = resultMsg?.obj as? WebView.WebViewTransport
                transport?.webView = popupWebView
                resultMsg?.sendToTarget()
                return true
            }

            // Grant camera / microphone to web app automatically (already requested at OS level)
            override fun onPermissionRequest(request: PermissionRequest?) {
                request?.grant(request.resources)
            }

            // Geolocation prompt (not needed but prevents silent failures)
            override fun onGeolocationPermissionsShowPrompt(
                origin: String?, callback: GeolocationPermissions.Callback?
            ) {
                callback?.invoke(origin, false, false)
            }
        }
    }

    private fun injectBluetoothBridge() {
        val js = """
(function() {
  if (window.__nexusBtInjected) return;
  window.__nexusBtInjected = true;

  var _res = {}, _rej = {};
  function pending(key, resolve, reject) { _res[key] = resolve; _rej[key] = reject; }
  function resolve(key, value) { if (_res[key]) { _res[key](value); delete _res[key]; delete _rej[key]; } }
  function reject(key, msg)    { if (_rej[key]) { _rej[key](new Error(msg)); delete _res[key]; delete _rej[key]; } }

  function makeFakeChar() {
    return {
      properties: { writeWithoutResponse: true },
      writeValueWithoutResponse: function(data) {
        AndroidBT.writeBytes(JSON.stringify(Array.from(new Uint8Array(data))));
        return Promise.resolve();
      },
      writeValue: function(data) {
        AndroidBT.writeBytes(JSON.stringify(Array.from(new Uint8Array(data))));
        return Promise.resolve();
      }
    };
  }

  function makeFakeServer() {
    return {
      getPrimaryService: function(uuid) {
        return Promise.resolve({ getCharacteristic: function() { return Promise.resolve(makeFakeChar()); } });
      }
    };
  }

  function makeFakeDevice(name, address) {
    var _disconnectHandler = null;
    window.__btDisconnectHandler = function() { if (_disconnectHandler) _disconnectHandler(); };
    return {
      name: name, id: address,
      gatt: {
        connect: function() {
          return new Promise(function(res, rej) {
            pending('gattConnect', function() { res(makeFakeServer()); }, rej);
            AndroidBT.connectDevice(address);
          });
        },
        disconnect: function() { AndroidBT.disconnect(); }
      },
      addEventListener: function(evt, fn) {
        if (evt === 'gattserverdisconnected') _disconnectHandler = fn;
      }
    };
  }

  Object.defineProperty(navigator, 'bluetooth', {
    configurable: true,
    get: function() {
      return {
        requestDevice: function(opts) {
          return new Promise(function(res, rej) {
            pending('requestDevice', res, rej);
            AndroidBT.showDevicePicker();
          });
        }
      };
    }
  });

  window.onBtDeviceSelected   = function(name, address) { resolve('requestDevice', makeFakeDevice(name, address)); };
  window.onBtDeviceCancelled  = function()              { reject('requestDevice', 'NotFoundError: cancelled'); };
  window.onBtConnected        = function()              { resolve('gattConnect'); };
  window.onBtConnectFailed    = function(msg)           { reject('gattConnect', msg); };
  window.onBtDisconnected     = function()              { if (window.__btDisconnectHandler) window.__btDisconnectHandler(); };

  console.log('[NexusPOS] Android BT bridge ready');
})();
        """.trimIndent()
        webView.evaluateJavascript("javascript:$js", null)
    }

    private fun requestAllPermissions() {
        val needed = mutableListOf(
            Manifest.permission.CAMERA,
            Manifest.permission.RECORD_AUDIO
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            needed += Manifest.permission.BLUETOOTH_CONNECT
            needed += Manifest.permission.BLUETOOTH_SCAN
        } else {
            needed += Manifest.permission.BLUETOOTH
            needed += Manifest.permission.BLUETOOTH_ADMIN
            needed += Manifest.permission.ACCESS_FINE_LOCATION
        }

        val denied = needed.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (denied.isNotEmpty()) {
            ActivityCompat.requestPermissions(this, denied.toTypedArray(), PERMISSION_REQUEST)
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int, permissions: Array<String>, grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == PERMISSION_REQUEST) {
            val denied = permissions.filterIndexed { i, _ ->
                grantResults.getOrElse(i) { PackageManager.PERMISSION_DENIED } != PackageManager.PERMISSION_GRANTED
            }
            if (denied.isNotEmpty()) {
                Toast.makeText(
                    this,
                    "Some features need permissions: ${denied.joinToString { it.substringAfterLast('.') }}",
                    Toast.LENGTH_LONG
                ).show()
            }
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }
}
