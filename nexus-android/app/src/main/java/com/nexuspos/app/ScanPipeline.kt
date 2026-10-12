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
 *   per photo, read at full resolution (EXIF rotation handed to ML Kit, no rotated copy):
 *     ML Kit barcode
 *     OCR Latin on the photo as taken; only if it reads very little text, also turned 90° and 270°
 *     OCR Devanagari (same orientation)
 *     OCR Latin again on a grey, contrast-stretched copy, and on a sharpened copy when some reads are weak
 *     OcrMerge: one line per region (highest ML Kit confidence wins), in column reading order
 *   ScanMerge: picks each field across photos (MRP: all readings of all passes vote, see ScanMerge.kt)
 *   Open Food Facts (free): fills blank name / brand / size; disagreements with weak reads become suggestions
 *
 * Photos are not returned to the web app; only text fields and raw debug text.
 */
object ScanPipeline {

    private const val TAG = "NexusPOS"
    private const val OCR_MAX_EDGE = 4096       // a 12 MP photo (4000×3000) is read at full size
    private const val OCR_FALLBACK_EDGE = 2048  // only after running out of memory
    private const val WEAK = 0.6
    private const val MAX_RECOGNISED = 150

    fun run(photos: List<File>): JSONObject {
        val t0 = System.currentTimeMillis()
        val debugPhotos = JSONArray()
        val recognised = JSONArray()
        val scans = mutableListOf<ScanMerge.Photo>()

        // One photo at a time, so only one big bitmap is in memory on cheap phones
        photos.forEachIndexed { i, file ->
            val tp = System.currentTimeMillis()
            val decoded = decodeForOcr(file, OCR_MAX_EDGE) ?: decodeForOcr(file, OCR_FALLBACK_EDGE)
            val d = JSONObject().put("photo", i + 1)
                .put("size", decoded?.let { "${it.first.width}x${it.first.height}" } ?: "decode failed")
            if (decoded == null) { debugPhotos.put(d); return@forEachIndexed }
            val (bmp, exif) = decoded
            try {
                val bc = readBarcode(bmp, exif)
                val plain = ocr(bmp, devanagari = false, rotation = exif)
                // Sideways text (side panels): turn only when the photo as taken reads very little
                var turn = 0
                var base = plain
                if (OcrMerge.littleText(plain)) {
                    val turned = listOf(90, 270).map { r -> r to ocr(bmp, devanagari = false, rotation = (exif + r) % 360) }
                    turn = OcrMerge.chooseOrientation(listOf(0 to plain) + turned)
                    base = turned.firstOrNull { it.first == turn }?.second ?: plain
                }
                val angle = (exif + turn) % 360
                val dev = ocr(bmp, devanagari = true, rotation = angle)
                val passes = mutableListOf(base)
                val passNames = mutableListOf("plain")
                // The plain bitmap is no longer needed: enhance it in place (no second big bitmap)
                if (greyStretchInPlace(bmp)) {
                    passes += ocr(bmp, devanagari = false, rotation = angle); passNames += "contrast"
                }
                if (OcrMerge.hasWeakLines(OcrMerge.mergePasses(passes))) {
                    sharpenInPlace(bmp)
                    passes += ocr(bmp, devanagari = false, rotation = angle); passNames += "sharpened"
                }
                val photo = ScanMerge.photoOf(passes, dev, bc)
                scans += photo
                photo.latin.map { it.text.trim() }.filter { it.length >= 2 }.forEach {
                    if (recognised.length() < MAX_RECOGNISED) recognised.put(JSONObject().put("photo", i + 1).put("text", it))
                }
                d.put("barcodeMlkit", bc?.let {
                    JSONObject().put("value", it.first).put("format", it.second)
                        .put("checksumOk", LabelParser.isVerifiedBarcode(it.first, it.second))
                } ?: JSONObject.NULL)
                d.put("exifRotation", exif).put("turned", turn).put("passes", passNames.joinToString(", "))
                d.put("ocrLatin", lines(photo.latin))
                d.put("ocrDevanagari", lines(dev))
                d.put("ms", System.currentTimeMillis() - tp)
            } finally {
                bmp.recycle()
            }
            debugPhotos.put(d)
        }
        val t1 = System.currentTimeMillis()

        val m = ScanMerge.merge(scans)
        val confidence = JSONObject()
        val source = JSONObject()
        val suggestions = JSONObject()
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

        // Open Food Facts — only for a valid barcode and only when something is blank or weak.
        // Blank fields are filled; a weak read that disagrees stays, and the Open Food Facts value is a suggestion.
        var offStatus = "skipped"
        var offDebug: JSONObject? = null
        val needsHelp = name == null || nameConf < WEAK || brand == null || brandConf < WEAK || qty == null || qtyConf < WEAK
        val barcode = m.barcode
        if (barcode != null && m.barcodeVerified && needsHelp) {
            val res = OpenFoodFacts.lookup(barcode)
            offStatus = res.status
            res.product?.let { p ->
                offDebug = JSONObject().put("name", p.name ?: JSONObject.NULL)
                    .put("brand", p.brand ?: JSONObject.NULL).put("quantity", p.quantity ?: JSONObject.NULL)
                val offName = p.name?.let { stripSize(it) }?.ifBlank { null }
                when {
                    offName == null -> {}
                    name == null -> { name = offName; nameConf = 0.5; source.put("name_eng", "openfoodfacts") }
                    similar(name!!, offName) -> nameConf = maxOf(nameConf, 0.7)
                    nameConf < WEAK -> suggestions.put("name_eng", offName)
                }
                when {
                    p.brand == null -> {}
                    brand == null -> { brand = p.brand; brandConf = 0.5; source.put("brand", "openfoodfacts") }
                    similar(brand!!, p.brand) -> brandConf = maxOf(brandConf, 0.8)
                    brandConf < WEAK -> suggestions.put("brand", p.brand)
                }
                val offQty = p.quantity?.let { LabelParser.normalizeQty(it) }
                when {
                    offQty == null -> {}
                    qty == null -> { qty = offQty; qtyConf = 0.5; source.put("net_qty", "openfoodfacts") }
                    qty == offQty -> qtyConf = maxOf(qtyConf, 0.85)
                    else -> suggestions.put("net_qty", offQty)
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
        out.put("mrp_alternates", JSONArray(m.mrpAlternates))
        out.put("alternates", JSONObject().put("mrp", JSONArray(m.mrpAlternates)).put("net_qty", JSONArray(m.qtyAlternates)))
        out.put("barcode", barcode ?: JSONObject.NULL)
        out.put("barcodeVerified", m.barcodeVerified)
        out.put("mfg_date", m.mfgDate.value ?: JSONObject.NULL)
        out.put("expiry_date", m.expiryDate.value ?: JSONObject.NULL)
        out.put("offStatus", offStatus)
        out.put("photoCount", photos.size)
        out.put("warnings", JSONArray(m.warnings))
        out.put("suggestions", suggestions)
        out.put("recognised", recognised)

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
            .put("mrpReadings", JSONArray(m.mrpDebug))
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

    private fun lines(ls: List<LabelParser.Line>) = ls.joinToString("\n") { l ->
        "[h${l.height}" + (if (l.confidence > 0f) " c${(l.confidence * 100).toInt()}" else "") + "] ${l.text}"
    }

    private fun stripSize(s: String) =
        s.replace(Regex("""\d+(?:[.,]\d+)?\s*(?:g|gm|gms|kg|ml|l|ltr)\b""", RegexOption.IGNORE_CASE), " ")
            .replace(Regex("""\s+"""), " ").trim()

    /** Same name/brand apart from case, spacing, punctuation or a couple of OCR letters. */
    private fun similar(a: String, b: String): Boolean {
        val x = a.lowercase().replace(Regex("""[^a-z0-9]"""), "")
        val y = b.lowercase().replace(Regex("""[^a-z0-9]"""), "")
        if (x.isEmpty() || y.isEmpty()) return false
        return x == y || x.contains(y) || y.contains(x) || NameSpell.osa(x, y, 2) <= 2
    }

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
    private fun readBarcode(bmp: Bitmap, rotation: Int): Pair<String, String>? {
        val options = BarcodeScannerOptions.Builder()
            .setBarcodeFormats(Barcode.FORMAT_EAN_13, Barcode.FORMAT_EAN_8, Barcode.FORMAT_UPC_A,
                Barcode.FORMAT_UPC_E, Barcode.FORMAT_CODE_128)
            .build()
        val scanner = BarcodeScanning.getClient(options)
        return try {
            val codes = await(scanner.process(InputImage.fromBitmap(bmp, rotation))) ?: return null
            codes.sortedBy { if (it.format == Barcode.FORMAT_EAN_13) 0 else 1 }
                .firstNotNullOfOrNull { c -> c.rawValue?.let { v -> RETAIL_FORMATS[c.format]?.let { v to it } } }
        } finally {
            scanner.close()
        }
    }

    /** OCR lines with box, position and ML Kit confidence, in the coordinates of the turned image. */
    private fun ocr(bmp: Bitmap, devanagari: Boolean, rotation: Int): List<LabelParser.Line> {
        val recognizer = if (devanagari) TextRecognition.getClient(DevanagariTextRecognizerOptions.Builder().build())
                         else TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)
        return try {
            val text: Text = await(recognizer.process(InputImage.fromBitmap(bmp, rotation))) ?: return emptyList()
            text.textBlocks.flatMap { b -> b.lines }.map { l ->
                val box = l.boundingBox
                LabelParser.Line(l.text, box?.height() ?: 0, box?.top ?: 0, box?.left ?: 0, box?.width() ?: 0, lineConfidence(l))
            }
        } finally {
            recognizer.close()
        }
    }

    /** ML Kit line confidence; the element average when the line has none (some model versions return 0). */
    private fun lineConfidence(l: Text.Line): Float {
        if (l.confidence > 0f) return l.confidence
        val els = l.elements.map { it.confidence }.filter { it > 0f }
        return if (els.isEmpty()) -1f else els.average().toFloat()
    }

    /** Grey + contrast stretch (1st–99th percentile), in place. False when the photo already uses the full range. */
    private fun greyStretchInPlace(bmp: Bitmap): Boolean {
        if (!bmp.isMutable) return false
        val w = bmp.width
        val h = bmp.height
        val row = IntArray(w)
        val hist = IntArray(256)
        for (y in 0 until h step 2) {
            bmp.getPixels(row, 0, w, 0, y, w, 1)
            for (x in 0 until w step 2) hist[ImageQuality.grey(row[x])]++
        }
        val (lo, hi) = ImageQuality.stretchLimits(hist) ?: return false
        for (y in 0 until h) {
            bmp.getPixels(row, 0, w, 0, y, w, 1)
            for (x in 0 until w) row[x] = argbGrey(ImageQuality.stretch(ImageQuality.grey(row[x]), lo, hi))
            bmp.setPixels(row, 0, w, 0, y, w, 1)
        }
        return true
    }

    /** 3×3 sharpen on the grey values, in place, keeping only three source rows in memory. */
    private fun sharpenInPlace(bmp: Bitmap) {
        if (!bmp.isMutable) return
        val w = bmp.width
        val h = bmp.height
        if (w < 3 || h < 3) return
        val buf = IntArray(w)
        fun greyRow(y: Int) = IntArray(w).also { r -> bmp.getPixels(buf, 0, w, 0, y, w, 1); for (x in 0 until w) r[x] = ImageQuality.grey(buf[x]) }
        var prev = greyRow(0)
        var cur = greyRow(1)
        val out = IntArray(w)
        for (y in 1 until h - 1) {
            val next = greyRow(y + 1)
            ImageQuality.sharpenRow(prev, cur, next, out, w)
            for (x in 0 until w) buf[x] = argbGrey(out[x])
            bmp.setPixels(buf, 0, w, 0, y, w, 1)
            prev = cur
            cur = next
        }
    }

    private fun argbGrey(v: Int) = (0xFF shl 24) or (v shl 16) or (v shl 8) or v

    /** EXIF orientation in degrees (0/90/180/270). Mirrored orientations do not occur on the back camera. */
    private fun exifDegrees(file: File): Int = try {
        when (ExifInterface(file.path).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)) {
            ExifInterface.ORIENTATION_ROTATE_90 -> 90
            ExifInterface.ORIENTATION_ROTATE_180 -> 180
            ExifInterface.ORIENTATION_ROTATE_270 -> 270
            else -> 0
        }
    } catch (e: Exception) {
        0
    }

    /**
     * Mutable bitmap for OCR, long edge ≤ [maxEdge] using only power-of-two subsampling (a 12 MP photo is not
     * scaled at all), plus the EXIF rotation, which ML Kit applies itself. Null when out of memory.
     */
    private fun decodeForOcr(file: File, maxEdge: Int): Pair<Bitmap, Int>? = try {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.path, bounds)
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / sample > maxEdge) sample *= 2
        BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = sample; inMutable = true })
            ?.let { it to exifDegrees(file) }
    } catch (e: OutOfMemoryError) {
        Log.w(TAG, "Out of memory decoding ${file.name} at $maxEdge px")
        null
    } catch (e: Exception) {
        Log.w(TAG, "Could not decode ${file.name}: ${e.message}")
        null
    }

    /** Decode with EXIF rotation applied, long edge ≤ [maxEdge] (photo preview and quality check). */
    fun loadBitmap(file: File, maxEdge: Int): Bitmap? = try {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.path, bounds)
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= maxEdge) sample *= 2
        val raw = BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = sample })
        raw?.let {
            val rotation = exifDegrees(file).toFloat()
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

    /** Blur / dark / glare check of a captured photo, on the guide-frame area at about 800 px wide. */
    fun checkQuality(file: File): ImageQuality.Report? {
        val bmp = loadBitmap(file, 1100) ?: return null
        return try {
            // Same area as the on-screen guide frame (7–93 % across, 22–72 % down)
            val x0 = (bmp.width * 0.07).toInt()
            val y0 = (bmp.height * 0.22).toInt()
            val w = (bmp.width * 0.86).toInt().coerceAtLeast(3)
            val h = (bmp.height * 0.50).toInt().coerceAtLeast(3)
            val px = IntArray(w * h)
            bmp.getPixels(px, 0, w, x0, y0, w, h)
            for (i in px.indices) px[i] = ImageQuality.grey(px[i])
            ImageQuality.assess(px, w, h)
        } catch (e: Exception) {
            Log.w(TAG, "Quality check failed: ${e.message}")
            null
        } finally {
            bmp.recycle()
        }
    }
}
