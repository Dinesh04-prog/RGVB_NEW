package com.nexuspos.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
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
        private const val BT_PERMISSION_REQUEST = 1001
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        btManager = BluetoothPrintManager(this)
        webView = findViewById(R.id.webView)

        setupWebView()
        requestBluetoothPermissions()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        // Serve bundled assets at https://appassets.androidplatform.net/
        // This gives a proper HTTPS origin so Firebase, OAuth, and IndexedDB all work.
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
            // Use a real Chrome Mobile UA — Google OAuth blocks requests from WebView UA strings
            userAgentString = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.82 Mobile Safari/537.36"
        }

        webView.addJavascriptInterface(AndroidBtBridge(this), "AndroidBT")

        webView.webViewClient = object : WebViewClientCompat() {
            override fun shouldInterceptRequest(
                view: WebView, request: WebResourceRequest
            ): WebResourceResponse? = assetLoader.shouldInterceptRequest(request.url)

            override fun onPageFinished(view: WebView?, url: String?) {
                injectBluetoothBridge()
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest?) {
                request?.grant(request.resources)
            }
        }

        webView.loadUrl("https://appassets.androidplatform.net/index.html")
    }

    private fun injectBluetoothBridge() {
        // Language: injected into every page load.
        // Replaces navigator.bluetooth with a fake implementation that routes all
        // BLE calls through AndroidBT JavascriptInterface → native Android BT socket.
        // The web app's own buildEscPos() still runs in JS; we only intercept the send.
        val js = """
(function() {
  if (window.__nexusBtInjected) return;
  window.__nexusBtInjected = true;

  // Pending promise resolvers keyed by operation name
  var _res = {}, _rej = {};

  function pending(key, resolve, reject) {
    _res[key] = resolve;
    _rej[key] = reject;
  }

  function resolve(key, value) {
    if (_res[key]) { _res[key](value); delete _res[key]; delete _rej[key]; }
  }

  function reject(key, msg) {
    if (_rej[key]) { _rej[key](new Error(msg)); delete _res[key]; delete _rej[key]; }
  }

  // --- Fake characteristic ---
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

  // --- Fake GATT server ---
  function makeFakeServer() {
    return {
      getPrimaryService: function(uuid) {
        return Promise.resolve({
          getCharacteristic: function(chrUuid) {
            return Promise.resolve(makeFakeChar());
          }
        });
      }
    };
  }

  // --- Fake device ---
  function makeFakeDevice(name, address) {
    var _disconnectHandler = null;
    window.__btDisconnectHandler = function() {
      if (_disconnectHandler) _disconnectHandler();
    };
    return {
      name: name,
      id: address,
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

  // --- navigator.bluetooth replacement ---
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

  // --- Callbacks called by Android via evaluateJavascript ---
  window.onBtDeviceSelected   = function(name, address) { resolve('requestDevice', makeFakeDevice(name, address)); };
  window.onBtDeviceCancelled  = function()              { reject('requestDevice', 'NotFoundError: cancelled'); };
  window.onBtConnected        = function()              { resolve('gattConnect'); };
  window.onBtConnectFailed    = function(msg)           { reject('gattConnect', msg); };
  window.onBtDisconnected     = function() {
    if (window.__btDisconnectHandler) window.__btDisconnectHandler();
  };

  console.log('[NexusPOS] Android BT bridge injected');
})();
        """.trimIndent()

        webView.evaluateJavascript("javascript:$js", null)
    }

    private fun requestBluetoothPermissions() {
        val needed = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            arrayOf(Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.BLUETOOTH_SCAN)
        } else {
            arrayOf(
                Manifest.permission.BLUETOOTH,
                Manifest.permission.BLUETOOTH_ADMIN,
                Manifest.permission.ACCESS_FINE_LOCATION
            )
        }

        val denied = needed.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }

        if (denied.isNotEmpty()) {
            ActivityCompat.requestPermissions(this, denied.toTypedArray(), BT_PERMISSION_REQUEST)
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int, permissions: Array<String>, grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == BT_PERMISSION_REQUEST) {
            val allGranted = grantResults.all { it == PackageManager.PERMISSION_GRANTED }
            if (!allGranted) {
                Toast.makeText(
                    this,
                    "Bluetooth permission is needed to connect to the printer.",
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
