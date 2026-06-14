package com.nexuspos.app

import android.webkit.JavascriptInterface
import org.json.JSONArray

/**
 * JavascriptInterface exposed as "AndroidBT" inside the WebView.
 * JS calls these methods; Android calls back via evaluateJavascript().
 */
class AndroidBtBridge(private val activity: MainActivity) {

    private val btManager get() = activity.btManager

    @JavascriptInterface
    fun showDevicePicker() {
        activity.runOnUiThread { btManager.showDevicePicker() }
    }

    @JavascriptInterface
    fun connectDevice(address: String) {
        btManager.connectDevice(address)
    }

    @JavascriptInterface
    fun writeBytes(jsonBytes: String) {
        try {
            val arr = JSONArray(jsonBytes)
            val bytes = ByteArray(arr.length()) { arr.getInt(it).toByte() }
            btManager.writeBytes(bytes)
        } catch (e: Exception) {
            activity.runOnUiThread {
                android.widget.Toast.makeText(
                    activity, "Print data error: ${e.message}", android.widget.Toast.LENGTH_SHORT
                ).show()
            }
        }
    }

    /** Called by the web app when running in Android WebView — bypasses web rendering pipeline */
    @JavascriptInterface
    fun printBillNative(receiptJson: String) {
        activity.runOnUiThread {
            android.widget.Toast.makeText(activity, "Printing…", android.widget.Toast.LENGTH_SHORT).show()
        }
        btManager.printBillNative(receiptJson)
    }

    @JavascriptInterface
    fun disconnect() {
        btManager.disconnect()
    }
}
