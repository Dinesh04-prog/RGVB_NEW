package com.nexuspos.app

import android.webkit.JavascriptInterface

/**
 * JavascriptInterface exposed as "AndroidScan" inside the WebView (see src/lib/androidScan.ts).
 * JS calls startProductScan(); Android answers via window.onProductScanResult(json) / onProductScanCancel().
 */
class AndroidScanBridge(private val activity: MainActivity) {

    @JavascriptInterface
    fun startProductScan() {
        activity.runOnUiThread { activity.launchProductScan() }
    }

    /** Result of a scan that finished while the WebView was being recreated; "" when none. */
    @JavascriptInterface
    fun takePendingResult(): String = activity.takePendingScanResult() ?: ""
}
