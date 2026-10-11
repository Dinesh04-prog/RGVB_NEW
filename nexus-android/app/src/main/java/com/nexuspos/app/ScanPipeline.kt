package com.nexuspos.app

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.util.Base64
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
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * Photo → product details. Runs on a background thread; every step is best-effort, so a failure in
 * one layer (no barcode, OCR error, Open Food Facts down) never stops the review popup from opening.
 *
 *   1. ML Kit barcode (bundled)        → barcode + checksum check
 *   2. ML Kit OCR Latin + Devanagari   → LabelParser (MRP, size, dates, brand, name)
 *   3. Open Food Facts (free)          → fills name / brand / size only when OCR left them blank or weak
 */
object ScanPipeline {

    private const val TAG = "NexusPOS"
    private const val OCR_MAX_EDGE = 2048      // OCR reads small inkjet text better on bigger images
    private const val THUMB_MAX_EDGE = 1280
    private const val THUMB_JPEG_QUALITY = 80
    private const val WEAK = 0.6

    fun run(front: File?, back: File): JSONObject {
        val out = JSONObject()
        val confidence = JSONObject()
        val source = JSONObject()

        val backBmp = loadBitmap(back, OCR_MAX_EDGE)
        val frontBmp = front?.takeIf { it.exists() }?.let { loadBitmap(it, OCR_MAX_EDGE) }

        // 1) Barcode — back photo first, then front
        var barcode: String? = null
        var barcodeVerified = false
        for (bmp in listOfNotNull(backBmp, frontBmp)) {
            val hit = readBarcode(bmp) ?: continue
            barcode = hit.first
            barcodeVerified = LabelParser.isVerifiedBarcode(hit.first, hit.second)
            confidence.put("barcode", if (barcodeVerified) 0.95 else 0.3)
            source.put("barcode", "mlkit-barcode")
            break
        }

        // 2) OCR
        val backLines = backBmp?.let { ocr(it, devanagari = false) } ?: emptyList()
        val frontLines = frontBmp?.let { ocr(it, devanagari = false) } ?: emptyList()
        val devLines = (frontBmp ?: backBmp)?.let { ocr(it, devanagari = true) } ?: emptyList()
        val parsed = LabelParser.parse(frontLines, backLines, devLines)

        if (barcode == null && parsed.barcodeFromText.value != null) {
            barcode = parsed.barcodeFromText.value
            barcodeVerified = true   // only checksum-valid digit runs are returned
            confidence.put("barcode", parsed.barcodeFromText.confidence)
            source.put("barcode", "mlkit-ocr")
        }

        var name = parsed.name.value
        var nameConf = parsed.name.confidence
        var brand = parsed.brand.value
        var brandConf = parsed.brand.confidence
        var qty = parsed.netQty.value
        var qtyConf = parsed.netQty.confidence
        val ocrSrc = "mlkit-ocr"
        if (name != null) source.put("name_eng", ocrSrc)
        if (brand != null) source.put("brand", ocrSrc)
        if (qty != null) source.put("net_qty", ocrSrc)

        // 3) Open Food Facts — only for a valid barcode and only to fill weak/blank fields
        var offStatus = "skipped"
        val needsHelp = name == null || nameConf < WEAK || brand == null || brandConf < WEAK || qty == null
        if (barcode != null && barcodeVerified && needsHelp) {
            val res = OpenFoodFacts.lookup(barcode)
            offStatus = res.status
            res.product?.let { p ->
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

        out.put("name_eng", name ?: JSONObject.NULL)
        out.put("name_marathi", parsed.nameMarathi.value ?: JSONObject.NULL)
        out.put("brand", brand ?: JSONObject.NULL)
        out.put("unit", "pcs")
        out.put("net_qty", qty ?: JSONObject.NULL)
        out.put("mrp", parsed.mrp.value ?: JSONObject.NULL)
        out.put("barcode", barcode ?: JSONObject.NULL)
        out.put("barcodeVerified", barcodeVerified)
        out.put("mfg_date", parsed.mfgDate.value ?: JSONObject.NULL)
        out.put("expiry_date", parsed.expiryDate.value ?: JSONObject.NULL)
        out.put("offStatus", offStatus)

        if (name != null) confidence.put("name_eng", nameConf)
        if (brand != null) confidence.put("brand", brandConf)
        if (qty != null) confidence.put("net_qty", qtyConf)
        if (parsed.nameMarathi.value != null) { confidence.put("name_marathi", parsed.nameMarathi.confidence); source.put("name_marathi", ocrSrc) }
        if (parsed.mrp.value != null) { confidence.put("mrp", parsed.mrp.confidence); source.put("mrp", ocrSrc) }
        if (parsed.mfgDate.value != null) { confidence.put("mfg_date", parsed.mfgDate.confidence); source.put("mfg_date", ocrSrc) }
        if (parsed.expiryDate.value != null) { confidence.put("expiry_date", parsed.expiryDate.confidence); source.put("expiry_date", ocrSrc) }
        out.put("confidence", confidence)
        out.put("source", source)

        out.put("frontPhotoDataUrl", front?.takeIf { it.exists() }?.let { thumbnail(it) } ?: JSONObject.NULL)
        out.put("backPhotoDataUrl", thumbnail(back) ?: JSONObject.NULL)

        backBmp?.recycle()
        frontBmp?.recycle()
        return out
    }

    /** Result shape when processing itself crashed: the review popup still opens for manual entry. */
    fun emptyResult(front: File?, back: File): JSONObject = JSONObject().apply {
        listOf("name_eng", "name_marathi", "brand", "net_qty", "mrp", "barcode", "mfg_date", "expiry_date")
            .forEach { put(it, JSONObject.NULL) }
        put("unit", "pcs")
        put("barcodeVerified", false)
        put("offStatus", "error")
        put("confidence", JSONObject())
        put("source", JSONObject())
        put("frontPhotoDataUrl", front?.takeIf { it.exists() }?.let { thumbnail(it) } ?: JSONObject.NULL)
        put("backPhotoDataUrl", thumbnail(back) ?: JSONObject.NULL)
    }

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

    private fun thumbnail(file: File): String? {
        val bmp = loadBitmap(file, THUMB_MAX_EDGE) ?: return null
        return try {
            val bytes = ByteArrayOutputStream().use { os ->
                bmp.compress(Bitmap.CompressFormat.JPEG, THUMB_JPEG_QUALITY, os)
                os.toByteArray()
            }
            "data:image/jpeg;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP)
        } finally {
            bmp.recycle()
        }
    }
}
