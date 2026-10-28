package com.nexuspos.app

import android.content.Context
import android.graphics.Bitmap
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.util.Base64
import android.util.Log
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL
import java.util.UUID

/**
 * Sends the scan's photos to the NexusPOS Gemini Worker (gemini-worker/) and returns what Gemini read.
 * Optional and best-effort: off when the build has no Worker URL / app key, when the user switched it off on the
 * camera screen, or when offline. Any failure returns a status; the scan always continues with the phone's reading.
 *
 * The app key is a shared secret (BuildConfig, from the GEMINI_APP_KEY GitHub secret). It can be extracted from the
 * APK, so the Worker bounds it: 6 scans/min per device, DAILY_CAP per day, 1.5 MB, 5 JPEGs. It is never logged.
 */
object GeminiClient {

    private const val TAG = "NexusPOS"
    private const val PREFS = "photo_scan"
    private const val KEY_USE = "use_gemini"
    private const val KEY_DEVICE = "device_id"
    private const val EDGE = 1280
    private const val MAX_BODY = 1_400_000   // Worker limit is 1.5 MB

    data class Outcome(
        /** ok | off | not_configured | offline | disabled | daily_cap | quota | rate_limited | timeout | unauthorized | error */
        val status: String,
        val read: SourceMerge.GeminiRead? = null,
        val raw: String? = null,
        val problems: List<String> = emptyList(),
        val model: String? = null,
        val ms: Long = 0,
    )

    fun configured() = BuildConfig.GEMINI_WORKER_URL.isNotBlank() && BuildConfig.GEMINI_APP_KEY.isNotBlank()

    /** The signed-in person's Firebase ID token, handed over by the web app (AndroidApp.setSignInToken); "" = none. */
    @Volatile var signInToken: String = ""

    fun usedByUser(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY_USE, true)

    fun setUsedByUser(ctx: Context, on: Boolean) =
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEY_USE, on).apply()

    /** Random id per install (not linked to the phone or the user), for the Worker's per-device limit. */
    private fun deviceId(ctx: Context): String {
        val p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        return p.getString(KEY_DEVICE, null) ?: UUID.randomUUID().toString().also { p.edit().putString(KEY_DEVICE, it).apply() }
    }

    private fun online(ctx: Context): Boolean = try {
        val cm = ctx.getSystemService(ConnectivityManager::class.java)
        cm?.getNetworkCapabilities(cm.activeNetwork)?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
    } catch (e: Exception) {
        false
    }

    /** Null when Gemini should run now; otherwise the reason it does not (a status for the result). */
    fun skipReason(ctx: Context): String? = when {
        !configured() -> "not_configured"
        !usedByUser(ctx) -> "off"
        !online(ctx) -> "offline"
        else -> null
    }

    /** Photos as base64 JPEGs, long edge ≤ 1280 px, smaller if the total would not fit the Worker's limit. */
    fun encode(photos: List<File>): List<String>? {
        for ((edge, quality) in listOf(EDGE to 80, EDGE to 65, 1024 to 60)) {
            val out = photos.mapNotNull { f ->
                val bmp = ScanPipeline.loadBitmap(f, edge) ?: return@mapNotNull null
                try {
                    val bytes = ByteArrayOutputStream().also { bmp.compress(Bitmap.CompressFormat.JPEG, quality, it) }.toByteArray()
                    Base64.encodeToString(bytes, Base64.NO_WRAP)
                } finally {
                    bmp.recycle()
                }
            }
            if (out.isEmpty()) return null
            if (out.sumOf { it.length + 3 } + 16 <= MAX_BODY) return out
        }
        return null
    }

    /** Blocking — call from a background thread. */
    fun read(ctx: Context, images: List<String>): Outcome {
        val t0 = System.currentTimeMillis()
        var conn: HttpURLConnection? = null
        return try {
            // The Worker reads this exact shape without JSON-parsing the photos (base64 needs no escaping)
            val body = images.joinToString("\",\"", "{\"images\":[\"", "\"]}").toByteArray(Charsets.UTF_8)
            conn = (URL(BuildConfig.GEMINI_WORKER_URL.trimEnd('/') + "/read").openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                doOutput = true
                connectTimeout = 6000
                readTimeout = 25000
                setFixedLengthStreamingMode(body.size)
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty("X-App-Key", BuildConfig.GEMINI_APP_KEY)
                setRequestProperty("X-Device-Id", deviceId(ctx))
                // Lets the Worker count scans per person (and refuse copies of the app key without a sign-in)
                signInToken.takeIf { it.isNotBlank() }?.let { setRequestProperty("Authorization", "Bearer $it") }
            }
            conn.outputStream.use { it.write(body) }
            val code = conn.responseCode
            val text = (if (code in 200..299) conn.inputStream else conn.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
            val ms = System.currentTimeMillis() - t0
            val json = try { JSONObject(text) } catch (e: Exception) { null }
            if (code !in 200..299 || json?.optBoolean("ok") != true) {
                val err = json?.optString("error").orEmpty()
                Log.w(TAG, "Gemini read failed: HTTP $code $err")
                return Outcome(statusOf(code, err), ms = ms)
            }
            val r = json.getJSONObject("read")
            val conf = r.optJSONObject("confidence")
            fun s(k: String) = if (r.isNull(k)) null else r.optString(k).ifBlank { null }
            val read = SourceMerge.GeminiRead(
                nameEng = s("name_eng"), nameMarathi = s("name_marathi"), brand = s("brand"), netQty = s("net_qty"),
                mrp = if (r.isNull("mrp")) null else r.optDouble("mrp").takeIf { !it.isNaN() },
                mfgDate = s("mfg_date"), expiryDate = s("expiry_date"), barcode = s("barcode"),
                confidence = conf?.keys()?.asSequence()?.associateWith { conf.optDouble(it, 0.0) } ?: emptyMap(),
            )
            val problems = json.optJSONArray("problems")?.let { a -> (0 until a.length()).map { a.optString(it) } } ?: emptyList()
            Outcome("ok", read, json.optString("raw"), problems, json.optString("model"), ms)
        } catch (e: SocketTimeoutException) {
            Outcome("timeout", ms = System.currentTimeMillis() - t0)
        } catch (e: Exception) {
            Log.w(TAG, "Gemini read failed: ${e.javaClass.simpleName}")
            Outcome("error", ms = System.currentTimeMillis() - t0)
        } finally {
            conn?.disconnect()
        }
    }

    private fun statusOf(code: Int, err: String) = when {
        err in setOf("disabled", "daily_cap", "quota", "rate_limited", "timeout", "unauthorized") -> err
        err == "user_daily_cap" -> "daily_cap"
        err == "sign_in_required" || err == "bad_sign_in" -> "unauthorized"
        code == 401 -> "unauthorized"
        code == 429 -> "quota"
        else -> "error"
    }
}
