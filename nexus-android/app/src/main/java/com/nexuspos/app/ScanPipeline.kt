package com.nexuspos.app

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.util.Log
import com.google.android.gms.tasks.Task
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.Text
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.devanagari.DevanagariTextRecognizerOptions
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * 1–5 photos of one pack → product details. Runs on a background thread; every step is best-effort, so a
 * failure in one layer (no barcode, OCR error, Open Food Facts down) never stops the result.
 *
 *   per photo: ML Kit barcode (bundled) + OCR Latin + OCR Devanagari
 *   ScanMerge: picks each field across photos (see ScanMerge.kt)
 *   Open Food Facts (free): fills name / brand / size only when OCR left them blank or weak
 *
 * Photos are not returned to the web app; only text fields and raw debug text.
 */
object ScanPipeline {

    private const val TAG = "NexusPOS"
    private const val OCR_MAX_EDGE = 2048      // OCR reads small inkjet text better on bigger images
    private const val WEAK = 0.6

    fun run(photos: List<File>): JSONObject {
        val t0 = System.currentTimeMillis()
        val debugPhotos = JSONArray()
        val scans = mutableListOf<ScanMerge.Photo>()

        // One photo at a time, so only one big bitmap is in memory on cheap phones
        photos.forEachIndexed { i, file ->
            val bmp = loadBitmap(file, OCR_MAX_EDGE)
            val d = JSONObject().put("photo", i + 1).put("size", bmp?.let { "${it.width}x${it.height}" } ?: "decode failed")
            if (bmp == null) { debugPhotos.put(d); return@forEachIndexed }
            try {
                val bc = readBarcode(bmp)
                val latin = ocr(bmp, devanagari = false)
                val dev = ocr(bmp, devanagari = true)
                scans += ScanMerge.Photo(latin, dev, bc)
                d.put("barcodeMlkit", bc?.let {
                    JSONObject().put("value", it.first).put("format", it.second)
                        .put("checksumOk", LabelParser.isVerifiedBarcode(it.first, it.second))
                } ?: JSONObject.NULL)
                d.put("ocrLatin", lines(latin))
                d.put("ocrDevanagari", lines(dev))
            } finally {
                bmp.recycle()
            }
            debugPhotos.put(d)
        }
        val t1 = System.currentTimeMillis()

        val m = ScanMerge.merge(scans)
        val confidence = JSONObject()
        val source = JSONObject()
        val ocrSrc = "mlkit-ocr"

        var name = m.name.value
        var nameConf = m.name.confidence
        var brand = m.brand.value
        var brandConf = m.brand.confidence
        var qty = m.netQty.value
        var qtyConf = m.netQty.confidence
        if (name != null) source.put("name_eng", ocrSrc)
        if (brand != null) source.put("brand", ocrSrc)
        if (qty != null) source.put("net_qty", ocrSrc)

        // Open Food Facts — only for a valid barcode and only to fill weak/blank fields
        var offStatus = "skipped"
        var offDebug: JSONObject? = null
        val needsHelp = name == null || nameConf < WEAK || brand == null || brandConf < WEAK || qty == null
        val barcode = m.barcode
        if (barcode != null && m.barcodeVerified && needsHelp) {
            val res = OpenFoodFacts.lookup(barcode)
            offStatus = res.status
            res.product?.let { p ->
                offDebug = JSONObject().put("name", p.name ?: JSONObject.NULL)
                    .put("brand", p.brand ?: JSONObject.NULL).put("quantity", p.quantity ?: JSONObject.NULL)
                val offName = p.name?.let { stripSize(it) }?.ifBlank { null }
                if ((name == null || nameConf < WEAK) && offName != null) {
                    name = offName; nameConf = 0.5; source.put("name_eng", "openfoodfacts")
                }
                if ((brand == null || brandConf < WEAK) && p.brand != null) {
                    brand = p.brand; brandConf = 0.5; source.put("brand", "openfoodfacts")
                }
                val offQty = p.quantity?.let { LabelParser.normalizeQty(it) }
                if (qty == null && offQty != null) {
                    qty = offQty; qtyConf = 0.5; source.put("net_qty", "openfoodfacts")
                }
            }
        }

        val out = JSONObject()
        out.put("name_eng", name ?: JSONObject.NULL)
        out.put("name_marathi", m.nameMarathi.value ?: JSONObject.NULL)
        out.put("brand", brand ?: JSONObject.NULL)
        out.put("unit", "pcs")
        out.put("net_qty", qty ?: JSONObject.NULL)
        out.put("mrp", m.mrp.value ?: JSONObject.NULL)
        out.put("barcode", barcode ?: JSONObject.NULL)
        out.put("barcodeVerified", m.barcodeVerified)
        out.put("mfg_date", m.mfgDate.value ?: JSONObject.NULL)
        out.put("expiry_date", m.expiryDate.value ?: JSONObject.NULL)
        out.put("offStatus", offStatus)
        out.put("photoCount", photos.size)

        if (name != null) confidence.put("name_eng", nameConf)
        if (brand != null) confidence.put("brand", brandConf)
        if (qty != null) confidence.put("net_qty", qtyConf)
        if (barcode != null) { confidence.put("barcode", m.barcodeConfidence); source.put("barcode", m.barcodeSource) }
        if (m.nameMarathi.value != null) { confidence.put("name_marathi", m.nameMarathi.confidence); source.put("name_marathi", ocrSrc) }
        if (m.mrp.value != null) { confidence.put("mrp", m.mrp.confidence); source.put("mrp", ocrSrc) }
        if (m.mfgDate.value != null) { confidence.put("mfg_date", m.mfgDate.confidence); source.put("mfg_date", ocrSrc) }
        if (m.expiryDate.value != null) { confidence.put("expiry_date", m.expiryDate.confidence); source.put("expiry_date", ocrSrc) }
        out.put("confidence", confidence)
        out.put("source", source)

        // Raw details for "Show raw scan details" — text only, stays on the phone
        val picked = JSONObject().also { j -> m.pickedFrom.forEach { (k, v) -> j.put(k, v) } }
        out.put("debug", JSONObject()
            .put("photos", debugPhotos)
            .put("pickedFrom", picked)
            .put("openFoodFacts", offDebug ?: JSONObject.NULL)
            .put("timingsMs", JSONObject().put("photos", t1 - t0).put("total", System.currentTimeMillis() - t0)))
        return out
    }

    /** Result when processing itself crashed: the popup stays as it is, with a short message. */
    fun emptyResult(photoCount: Int, error: String): JSONObject = JSONObject().apply {
        listOf("name_eng", "name_marathi", "brand", "net_qty", "mrp", "barcode", "mfg_date", "expiry_date")
            .forEach { put(it, JSONObject.NULL) }
        put("unit", "pcs")
        put("barcodeVerified", false)
        put("offStatus", "error")
        put("photoCount", photoCount)
        put("confidence", JSONObject())
        put("source", JSONObject())
        put("debug", JSONObject().put("error", "scan processing failed: $error (logcat tag NexusPOS)"))
    }

    private fun lines(ls: List<LabelParser.Line>) = ls.joinToString("\n") { "[h${it.height}] ${it.text}" }

    private fun stripSize(s: String) =
        s.replace(Regex("""\d+(?:[.,]\d+)?\s*(?:g|gm|gms|kg|ml|l|ltr)\b""", RegexOption.IGNORE_CASE), " ")
            .replace(Regex("""\s+"""), " ").trim()

    private fun <T> await(task: Task<T>): T? = try {
        Tasks.await(task, 15, TimeUnit.SECONDS)
    } catch (e: Exception) {
        Log.w(TAG, "ML Kit task failed: ${e.message}")
        null
    }

    private val RETAIL_FORMATS = mapOf(
        Barcode.FORMAT_EAN_13 to "EAN_13", Barcode.FORMAT_EAN_8 to "EAN_8",
        Barcode.FORMAT_UPC_A to "UPC_A", Barcode.FORMAT_UPC_E to "UPC_E",
        Barcode.FORMAT_CODE_128 to "CODE_128",
    )

    /** (rawValue, format name) of the first retail barcode, or null. */
    private fun readBarcode(bmp: Bitmap): Pair<String, String>? {
        val options = BarcodeScannerOptions.Builder()
            .setBarcodeFormats(Barcode.FORMAT_EAN_13, Barcode.FORMAT_EAN_8, Barcode.FORMAT_UPC_A,
                Barcode.FORMAT_UPC_E, Barcode.FORMAT_CODE_128)
            .build()
        val scanner = BarcodeScanning.getClient(options)
        return try {
            val codes = await(scanner.process(InputImage.fromBitmap(bmp, 0))) ?: return null
            codes.sortedBy { if (it.format == Barcode.FORMAT_EAN_13) 0 else 1 }
                .firstNotNullOfOrNull { c -> c.rawValue?.let { v -> RETAIL_FORMATS[c.format]?.let { v to it } } }
        } finally {
            scanner.close()
        }
    }

    private fun ocr(bmp: Bitmap, devanagari: Boolean): List<LabelParser.Line> {
        val recognizer = if (devanagari) TextRecognition.getClient(DevanagariTextRecognizerOptions.Builder().build())
                         else TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)
        return try {
            val text: Text = await(recognizer.process(InputImage.fromBitmap(bmp, 0))) ?: return emptyList()
            text.textBlocks.flatMap { b -> b.lines }.map { l ->
                LabelParser.Line(l.text, l.boundingBox?.height() ?: 0, l.boundingBox?.top ?: 0)
            }.sortedBy { it.top }
        } finally {
            recognizer.close()
        }
    }

    /** Decode with EXIF rotation applied, long edge ≤ [maxEdge]. */
    fun loadBitmap(file: File, maxEdge: Int): Bitmap? = try {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.path, bounds)
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= maxEdge) sample *= 2
        val raw = BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = sample })
        raw?.let {
            val rotation = when (ExifInterface(file.path).getAttributeInt(
                ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)) {
                ExifInterface.ORIENTATION_ROTATE_90 -> 90f
                ExifInterface.ORIENTATION_ROTATE_180 -> 180f
                ExifInterface.ORIENTATION_ROTATE_270 -> 270f
                else -> 0f
            }
            val scale = minOf(1f, maxEdge.toFloat() / maxOf(it.width, it.height))
            if (rotation == 0f && scale == 1f) it
            else {
                val m = Matrix().apply { postRotate(rotation); postScale(scale, scale) }
                Bitmap.createBitmap(it, 0, 0, it.width, it.height, m, true).also { r -> if (r !== it) it.recycle() }
            }
        }
    } catch (e: Exception) {
        Log.w(TAG, "Could not decode ${file.name}: ${e.message}")
        null
    } catch (e: OutOfMemoryError) {
        Log.w(TAG, "Out of memory decoding ${file.name}")
        null
    }
}
