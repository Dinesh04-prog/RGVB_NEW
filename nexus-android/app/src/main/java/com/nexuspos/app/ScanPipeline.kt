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
import android.content.Context
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

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
 *   Gemini (GeminiClient → gemini-worker, online, optional): sent before OCR starts, read while OCR runs
 *   Open Food Facts (free): one lookup for a checksum-valid barcode
 *   SourceMerge: Gemini first when sure, cross-checked with OCR and Open Food Facts (see SourceMerge.kt)
 *
 * Photos are not returned to the web app; only text fields and raw debug text.
 */
object ScanPipeline {

    private const val TAG = "NexusPOS"
    private const val OCR_MAX_EDGE = 4096       // a 12 MP photo (4000×3000) is read at full size
    private const val OCR_FALLBACK_EDGE = 2048  // only after running out of memory
    private const val MAX_RECOGNISED = 150

    fun run(ctx: Context, photos: List<File>): JSONObject {
        val t0 = System.currentTimeMillis()
        val debugPhotos = JSONArray()
        val recognised = JSONArray()
        val scans = mutableListOf<ScanMerge.Photo>()

        // Gemini (online, optional): small JPEGs first, then the request runs while ML Kit reads the photos.
        // Nothing here can fail the scan: every problem becomes a status.
        val geminiPool = Executors.newSingleThreadExecutor()
        var geminiSkip = GeminiClient.skipReason(ctx)
        val geminiFuture: Future<GeminiClient.Outcome>? = if (geminiSkip != null) null else try {
            GeminiClient.encode(photos)?.let { images -> geminiPool.submit<GeminiClient.Outcome> { GeminiClient.read(ctx, images) } }
                .also { if (it == null) geminiSkip = "error" }
        } catch (t: Throwable) {
            Log.w(TAG, "Gemini prepare failed: ${t.javaClass.simpleName}")
            geminiSkip = "error"
            null
        }

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

        // Gemini's answer (waits at most GEMINI_WAIT_MS more; it has been running during OCR)
        val gemini: GeminiClient.Outcome = geminiFuture?.let { f ->
            try { f.get(GEMINI_WAIT_MS, TimeUnit.MILLISECONDS) } catch (e: TimeoutException) {
                f.cancel(true); GeminiClient.Outcome("timeout")
            } catch (t: Throwable) {
                GeminiClient.Outcome("error")
            }
        } ?: GeminiClient.Outcome(geminiSkip ?: "error")
        geminiPool.shutdownNow()

        // Open Food Facts: one call per scan for a checksum-valid barcode; cross-checks name, brand and size
        var offStatus = "skipped"
        var offDebug: JSONObject? = null
        var off: SourceMerge.OffRead? = null
        val barcode = m.barcode
        if (barcode != null && m.barcodeVerified) {
            val res = OpenFoodFacts.lookup(barcode)
            offStatus = res.status
            res.product?.let { p ->
                offDebug = JSONObject().put("name", p.name ?: JSONObject.NULL)
                    .put("brand", p.brand ?: JSONObject.NULL).put("quantity", p.quantity ?: JSONObject.NULL)
                off = SourceMerge.OffRead(p.name?.let { stripSize(it) }?.ifBlank { null }, p.brand,
                    p.quantity?.let { LabelParser.normalizeQty(it) })
            }
        }

        val r = SourceMerge.merge(m, gemini.read, off)
        val confidence = JSONObject()
        val source = JSONObject()
        val out = JSONObject()
        fun <T> put(key: String, v: SourceMerge.Value<T>) {
            out.put(key, v.value ?: JSONObject.NULL)
            if (v.value != null) { confidence.put(key, v.confidence); source.put(key, v.source) }
        }
        put("name_eng", r.nameEng)
        put("name_marathi", r.nameMarathi)
        put("brand", r.brand)
        put("net_qty", r.netQty)
        put("mrp", r.mrp)
        put("mfg_date", r.mfgDate)
        put("expiry_date", r.expiryDate)
        out.put("unit", "pcs")
        out.put("mrp_alternates", JSONArray(r.mrp.alternates))
        out.put("alternates", JSONObject().put("mrp", JSONArray(r.mrp.alternates)).put("net_qty", JSONArray(r.netQty.alternates))
            .put("name_eng", JSONArray(r.nameEng.alternates)))
        out.put("barcode", barcode ?: JSONObject.NULL)
        out.put("barcodeVerified", m.barcodeVerified)
        if (barcode != null) { confidence.put("barcode", m.barcodeConfidence); source.put("barcode", m.barcodeSource) }
        out.put("offStatus", offStatus)
        out.put("geminiStatus", gemini.status)
        out.put("photoCount", photos.size)
        val warnings = m.warnings.toMutableList()
        val mfg = r.mfgDate.value
        val exp = r.expiryDate.value
        if (mfg != null && exp != null && exp <= mfg && warnings.none { it.contains("expiry date") }) {
            warnings += "The expiry date read ($exp) is not after the manufacture date ($mfg). Check both dates."
        }
        out.put("warnings", JSONArray(warnings))
        // A barcode only Gemini saw is never filled: offered as an unverified suggestion
        out.put("suggestions", JSONObject().apply { r.barcodeSuggestion?.let { put("barcode", it) } })
        out.put("recognised", recognised)
        out.put("confidence", confidence)
        out.put("source", source)

        // Raw details for "Show raw scan details" — text only, stays on the phone
        val picked = JSONObject().also { j -> m.pickedFrom.forEach { (k, v) -> j.put(k, v) } }
        out.put("debug", JSONObject()
            .put("photos", debugPhotos)
            .put("pickedFrom", picked)
            .put("mrpReadings", JSONArray(m.mrpDebug))
            .put("ocrOnly", JSONObject()
                .put("name_eng", m.name.value ?: JSONObject.NULL).put("brand", m.brand.value ?: JSONObject.NULL)
                .put("net_qty", m.netQty.value ?: JSONObject.NULL).put("mrp", m.mrp.value ?: JSONObject.NULL))
            .put("gemini", JSONObject().put("status", gemini.status).put("model", gemini.model ?: JSONObject.NULL)
                .put("ms", gemini.ms).put("raw", gemini.raw ?: JSONObject.NULL).put("problems", JSONArray(gemini.problems)))
            .put("openFoodFacts", offDebug ?: JSONObject.NULL)
            .put("timingsMs", JSONObject().put("photos", t1 - t0).put("total", System.currentTimeMillis() - t0)))
        return out
    }

    private const val GEMINI_WAIT_MS = 20_000L

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
