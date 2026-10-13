package com.nexuspos.app

import android.graphics.Bitmap
import android.util.Base64
import android.util.Log
import java.io.ByteArrayOutputStream
import java.io.File

/**
 * Small picture of the product for the inventory tile: the front photo (photo 1) as a JPEG data URL,
 * long edge ≤ 240 px and at most 25 KB including the "data:image/jpeg;base64," prefix.
 * Same limits as the web app's picture box (src/lib/itemImage.ts). Stored inside the item (Firestore +
 * IndexedDB), so it must stay tiny; a typical pack photo comes out at 8–15 KB on the first step.
 */
object ScanThumbnail {

    const val EDGE = 240
    const val MAX_CHARS = 25 * 1024
    private const val PREFIX = "data:image/jpeg;base64,"
    private const val TAG = "NexusPOS"

    /** Smaller and softer until it fits (long edge px to JPEG quality). */
    val STEPS = listOf(EDGE to 70, EDGE to 55, 200 to 50, 160 to 45, 120 to 40)

    /**
     * First step whose data URL fits the cap. [encode] gives base64 JPEG for (long edge, quality), or null
     * when encoding failed. Null when nothing fits or encoding failed.
     */
    fun fit(encode: (edge: Int, quality: Int) -> String?): String? {
        for ((edge, quality) in STEPS) {
            val b64 = encode(edge, quality) ?: return null
            if (PREFIX.length + b64.length <= MAX_CHARS) return PREFIX + b64
        }
        return null
    }

    /** Front photo → data URL, or null. Never throws: a missing picture must not affect the scan. */
    fun fromPhoto(file: File): String? {
        val bmp = ScanPipeline.loadBitmap(file, EDGE) ?: return null   // EXIF rotation applied
        return try {
            fit { edge, quality ->
                val long = maxOf(bmp.width, bmp.height)
                val scaled = if (long <= edge) bmp else Bitmap.createScaledBitmap(
                    bmp, maxOf(1, bmp.width * edge / long), maxOf(1, bmp.height * edge / long), true)
                try {
                    val bytes = ByteArrayOutputStream().also { scaled.compress(Bitmap.CompressFormat.JPEG, quality, it) }.toByteArray()
                    Base64.encodeToString(bytes, Base64.NO_WRAP)
                } finally {
                    if (scaled !== bmp) scaled.recycle()
                }
            }
        } catch (t: Throwable) {
            Log.w(TAG, "Thumbnail failed: ${t.javaClass.simpleName}")
            null
        } finally {
            bmp.recycle()
        }
    }
}
