package com.nexuspos.app

import android.util.Log
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * Free barcode lookup — https://world.openfoodfacts.org (no API key).
 * Rules: identify the app with a User-Agent, max 15 product reads per minute per IP.
 * One attempt per scan, no retries; any failure just returns a status and the scan continues.
 */
object OpenFoodFacts {

    /** Change here if the contact e-mail changes. Required format: AppName/Version (ContactEmail). */
    const val USER_AGENT = "NexusPOS/1.0 (dineshbattul04@gmail.com)"

    private const val TAG = "NexusPOS"
    private const val MAX_PER_MINUTE = 14   // stay just under their 15/min/IP limit
    private val recentCalls = ArrayDeque<Long>()

    data class Product(val name: String?, val brand: String?, val quantity: String?)

    /** status: found | not_found | error | rate_limited */
    data class Lookup(val status: String, val product: Product? = null)

    @Synchronized
    private fun acquireSlot(): Boolean {
        val now = System.currentTimeMillis()
        while (recentCalls.isNotEmpty() && now - recentCalls.first() > 60_000) recentCalls.removeFirst()
        if (recentCalls.size >= MAX_PER_MINUTE) return false
        recentCalls.addLast(now)
        return true
    }

    /** Blocking — call from a background thread. */
    fun lookup(barcode: String): Lookup {
        if (!barcode.all { it.isDigit() }) return Lookup("error")
        if (!acquireSlot()) return Lookup("rate_limited")
        var conn: HttpURLConnection? = null
        return try {
            val url = URL("https://world.openfoodfacts.org/api/v2/product/$barcode.json" +
                    "?fields=product_name,product_name_en,brands,quantity")
            conn = (url.openConnection() as HttpURLConnection).apply {
                connectTimeout = 4000
                readTimeout = 5000
                setRequestProperty("User-Agent", USER_AGENT)
                setRequestProperty("Accept", "application/json")
            }
            when (conn.responseCode) {
                404 -> Lookup("not_found")
                200 -> {
                    val json = JSONObject(conn.inputStream.bufferedReader().use { it.readText() })
                    val p = json.optJSONObject("product")
                    if (json.optInt("status", 0) != 1 || p == null) Lookup("not_found")
                    else Lookup("found", Product(
                        name = p.optString("product_name_en").ifBlank { p.optString("product_name") }.ifBlank { null },
                        brand = p.optString("brands").split(',').firstOrNull()?.trim()?.ifBlank { null },
                        quantity = p.optString("quantity").ifBlank { null },
                    ))
                }
                else -> Lookup("error")
            }
        } catch (e: Exception) {
            Log.w(TAG, "Open Food Facts lookup failed: ${e.message}")
            Lookup("error")
        } finally {
            conn?.disconnect()
        }
    }
}
