package com.nexuspos.app

import android.content.ActivityNotFoundException
import android.content.ContentValues
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import android.widget.Toast
import java.io.File

/**
 * JavascriptInterface exposed as "AndroidApp" (see src/lib/androidApp.ts). The WebView cannot do these itself:
 *  - openExternal(url): wa.me / WhatsApp links open the WhatsApp app (window.open only opened an in-app
 *    popup that cannot leave the WebView)
 *  - saveFile(name, mime, base64): "downloads" (Excel export, backup, receipt image) are saved to the phone's
 *    Downloads folder and offered in the share sheet (a WebView ignores <a download> and blob links)
 */
class AndroidAppBridge(private val activity: MainActivity) {

    private companion object {
        const val TAG = "NexusPOS"
        val ALLOWED_SCHEMES = setOf("https", "http", "whatsapp", "tel", "mailto")
    }

    /** The web app's Firebase sign-in token (sent again whenever Firebase refreshes it, about hourly). */
    @JavascriptInterface
    fun setSignInToken(token: String) {
        GeminiClient.signInToken = if (token.length in 1..4096) token else ""
    }

    /** True when the link was handed to another app. */
    @JavascriptInterface
    fun openExternal(url: String): Boolean {
        val uri = try { Uri.parse(url) } catch (e: Exception) { null }
        if (uri?.scheme?.lowercase() !in ALLOWED_SCHEMES) return false
        return try {
            activity.runOnUiThread {
                try {
                    activity.startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                } catch (e: ActivityNotFoundException) {
                    Toast.makeText(activity, "No app can open this link", Toast.LENGTH_LONG).show()
                }
            }
            true
        } catch (e: Exception) {
            Log.w(TAG, "openExternal failed: ${e.message}")
            false
        }
    }

    /**
     * Saves the file in Downloads, then opens the share sheet for it. Returns where it was saved
     * ("Downloads/name"), or "" on failure. Runs on the JS bridge thread (not the UI thread).
     */
    @JavascriptInterface
    fun saveFile(fileName: String, mimeType: String, base64: String): String {
        val name = fileName.replace(Regex("[\\\\/:*?\"<>|]"), "_").ifBlank { "file" }
        val mime = mimeType.ifBlank { "application/octet-stream" }
        return try {
            val bytes = Base64.decode(base64, Base64.DEFAULT)
            val (uri, where) = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val values = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, name)
                    put(MediaStore.Downloads.MIME_TYPE, mime)
                    put(MediaStore.Downloads.IS_PENDING, 1)
                }
                val resolver = activity.contentResolver
                val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: return ""
                resolver.openOutputStream(uri)?.use { it.write(bytes) } ?: return ""
                values.clear()
                values.put(MediaStore.Downloads.IS_PENDING, 0)
                resolver.update(uri, values, null, null)
                uri to "Downloads/$name"
            } else {
                // Android 8–9: the app's own Downloads folder (no storage permission needed); no share sheet
                val dir = activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: return ""
                val file = File(dir, name).apply { writeBytes(bytes) }
                null to file.absolutePath
            }
            activity.runOnUiThread {
                Toast.makeText(activity, "Saved to $where", Toast.LENGTH_LONG).show()
                if (uri != null) {
                    val send = Intent(Intent.ACTION_SEND).setType(mime).putExtra(Intent.EXTRA_STREAM, uri)
                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    try { activity.startActivity(Intent.createChooser(send, "Share $name")) }
                    catch (e: ActivityNotFoundException) { /* saved; nothing to share with */ }
                }
            }
            where
        } catch (e: Exception) {
            Log.e(TAG, "saveFile failed", e)
            ""
        }
    }
}
