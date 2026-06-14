package com.nexuspos.app

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream

/**
 * Hybrid ESC/POS receipt builder:
 *   - English text  → text mode (~1 byte/char, instant)
 *   - Item rows     → per-row bitmap with fixed pixel columns for perfect alignment
 */
object EscPosPrinter {

    private const val LINE_CHARS = 48
    private const val PAPER_W    = 576   // 80 mm at 203 DPI

    // Fixed right-edge X for each numeric column (pixels on 576px paper)
    private const val MARGIN_PX  = 4f
    private const val COL_QTY    = 395f   // Qty right edge
    private const val COL_RATE   = 475f   // Rate right edge (full bill only)
    private const val COL_AMT    = 555f   // Amt right edge (fixed)
    private const val NAME_MAX_W = 210f   // max px width for name text (4→214px)

    // Short bill has no Rate column
    private const val SB_COL_QTY = 390f

    // ── ESC/POS commands ──────────────────────────────────────────────────────
    private val INIT        = cmd(0x1B, 0x40)
    private val ALIGN_LEFT  = cmd(0x1B, 0x61, 0x00)
    private val ALIGN_CTR   = cmd(0x1B, 0x61, 0x01)
    private val BOLD_ON     = cmd(0x1B, 0x45, 0x01)
    private val BOLD_OFF    = cmd(0x1B, 0x45, 0x00)
    private val DBL_WH      = cmd(0x1D, 0x21, 0x11)
    private val DBL_H       = cmd(0x1D, 0x21, 0x01)
    private val NORMAL_SIZE = cmd(0x1D, 0x21, 0x00)
    private val LF          = byteArrayOf(0x0A)
    private val FEED_CUT    = cmd(0x1B, 0x64, 0x02, 0x1D, 0x56, 0x41, 0x00)

    // ── Public entry point ────────────────────────────────────────────────────

    fun buildReceipt(json: JSONObject, context: Context): ByteArray {
        val out = ByteArrayOutputStream()

        fun w(b: ByteArray) = out.write(b)
        fun nl()            = w(LF)
        fun text(s: String) = out.write(s.toByteArray(Charsets.UTF_8))
        fun line(s: String = "") { text(s); nl() }
        fun divider()       = line("-".repeat(LINE_CHARS))

        w(INIT)

        // ── Company logo ──────────────────────────────────────────────────────
        w(ALIGN_CTR)
        renderLogo(context)?.let { w(it) }

        // ── Shop header ───────────────────────────────────────────────────────
        w(ALIGN_CTR); w(BOLD_ON); w(DBL_WH)
        line("RAJENDRA GVB")
        w(NORMAL_SIZE); w(BOLD_OFF)
        line("Kirana & Grocery Store")
        divider()

        // ── Bill meta ─────────────────────────────────────────────────────────
        w(ALIGN_LEFT)
        line("Bill No : ${json.optString("receipt_no", "")}")
        line("Date    : ${json.optString("date", "")}")
        val customer = json.optString("customerName", "")
        val phone    = json.optString("customerPhone", "")
        if (customer.isNotEmpty()) line("Customer: $customer")
        if (phone.isNotEmpty())    line("Mobile  : $phone")
        divider()

        val isShortBill = json.optBoolean("isShortBill", false)

        // ── Items header — bitmap so pixel columns match item rows ────────────
        w(renderHeaderRow(26f, isShortBill))
        divider()

        // ── Items ─────────────────────────────────────────────────────────────
        val items = json.optJSONArray("items") ?: JSONArray()
        for (i in 0 until items.length()) {
            val item = items.getJSONObject(i)
            val name = item.optString("name", "")
            val qty  = item.optDouble("qty",   0.0)
            val rate = item.optDouble("rate",  0.0)
            val amt  = item.optDouble("total", 0.0)
            val unit = item.optString("cartUnit", item.optString("unit", ""))

            val displayName = "${i + 1}. $name"
            val qtyStr      = if (unit.isNotEmpty()) "${fmtN(qty)} $unit" else fmtN(qty)

            w(renderItemRow(displayName, qtyStr, fmtN(rate), fmtN(amt), 26f, isShortBill))
        }
        divider()

        // ── Total ─────────────────────────────────────────────────────────────
        val total = json.optDouble("total", 0.0)
        w(BOLD_ON); w(DBL_H)
        line(padBothEnds("TOTAL", "Rs.${fmtN(total)}", LINE_CHARS))
        w(NORMAL_SIZE); w(BOLD_OFF)
        divider()

        // ── Footer ────────────────────────────────────────────────────────────
        w(ALIGN_CTR)
        line("* Thank You -- Visit Again! *")

        w(FEED_CUT)
        return out.toByteArray()
    }

    // ── Bitmap row renderers ──────────────────────────────────────────────────

    /** Loads shop-logo.jpeg from assets, scales to 180px wide, centers on paper. */
    private fun renderLogo(context: Context): ByteArray? {
        return try {
            val raw = context.assets.open("shop-logo.jpeg").use {
                BitmapFactory.decodeStream(it)
            } ?: return null

            val logoW = 90
            val logoH = (raw.height.toFloat() * logoW / raw.width).toInt()
            val scaled = Bitmap.createScaledBitmap(raw, logoW, logoH, true)
            raw.recycle()

            val bm     = Bitmap.createBitmap(PAPER_W, logoH + 8, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(bm)
            canvas.drawColor(Color.WHITE)
            canvas.drawBitmap(scaled, ((PAPER_W - logoW) / 2).toFloat(), 4f, null)
            scaled.recycle()

            bitmapLineToEscPos(bm).also { bm.recycle() }
        } catch (_: Exception) {
            null
        }
    }

    /** Header row: "Item" left, columns right. Rate skipped for short bills. */
    private fun renderHeaderRow(fontSize: Float, isShortBill: Boolean): ByteArray {
        val lineH    = (fontSize * 1.6f).toInt().coerceAtLeast(40)
        val baseline = fontSize + 4f
        val colQty   = if (isShortBill) SB_COL_QTY else COL_QTY
        val bm       = Bitmap.createBitmap(PAPER_W, lineH, Bitmap.Config.ARGB_8888)
        val canvas   = Canvas(bm)
        canvas.drawColor(Color.WHITE)

        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color    = Color.BLACK
            textSize = fontSize
            typeface = Typeface.DEFAULT_BOLD
        }

        paint.textAlign = Paint.Align.LEFT
        canvas.drawText("Item", MARGIN_PX, baseline, paint)

        paint.textAlign = Paint.Align.RIGHT
        canvas.drawText("Qty", colQty,  baseline, paint)
        if (!isShortBill) canvas.drawText("Rate", COL_RATE, baseline, paint)
        canvas.drawText("Amt", COL_AMT, baseline, paint)

        return bitmapLineToEscPos(bm).also { bm.recycle() }
    }

    /**
     * Item row: name on the left (wraps to next line if too long),
     * qty/rate/amt each right-aligned at their own fixed column X.
     * Numbers always align with the first name line baseline.
     */
    private fun renderItemRow(
        displayName: String,
        qtyStr:      String,
        rateStr:     String,
        amtStr:      String,
        fontSize:    Float,
        isShortBill: Boolean = false
    ): ByteArray {
        val lineH  = (fontSize * 1.6f).toInt().coerceAtLeast(40)
        val colQty = if (isShortBill) SB_COL_QTY else COL_QTY

        val namePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color    = Color.BLACK
            textSize = fontSize
        }
        val nameLines = wrapText(displayName, namePaint, NAME_MAX_W)
        val totalH    = (nameLines.size * lineH + 6).coerceAtLeast(lineH)

        val bm     = Bitmap.createBitmap(PAPER_W, totalH, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bm)
        canvas.drawColor(Color.WHITE)

        // Name lines — left side
        namePaint.textAlign = Paint.Align.LEFT
        for ((idx, ln) in nameLines.withIndex()) {
            canvas.drawText(ln, MARGIN_PX, fontSize + 4f + idx * lineH, namePaint)
        }

        // Numbers — right-aligned at their fixed column X, on first-line baseline
        val numPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color     = Color.BLACK
            textSize  = fontSize
            textAlign = Paint.Align.RIGHT
        }
        val numY = fontSize + 4f
        canvas.drawText(qtyStr, colQty,  numY, numPaint)
        if (!isShortBill) canvas.drawText(rateStr, COL_RATE, numY, numPaint)
        canvas.drawText(amtStr, COL_AMT, numY, numPaint)

        return bitmapLineToEscPos(bm).also { bm.recycle() }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private fun wrapText(text: String, paint: Paint, maxW: Float): List<String> {
        val words = text.split(" ")
        val lines = mutableListOf<String>()
        var cur   = ""
        for (w in words) {
            val test = if (cur.isEmpty()) w else "$cur $w"
            if (paint.measureText(test) <= maxW) cur = test
            else { if (cur.isNotEmpty()) lines.add(cur); cur = w }
        }
        if (cur.isNotEmpty()) lines.add(cur)
        return lines.ifEmpty { listOf("") }
    }

    private fun bitmapLineToEscPos(bm: Bitmap): ByteArray {
        val w      = bm.width
        val h      = bm.height
        val bpr    = (w + 7) / 8
        val pixels = IntArray(w * h)
        bm.getPixels(pixels, 0, w, 0, 0, w, h)

        val out = ByteArrayOutputStream(8 + bpr * h)
        out.write(0x1D); out.write(0x76); out.write(0x30); out.write(0x00)
        out.write(bpr and 0xFF); out.write((bpr shr 8) and 0xFF)
        out.write(h   and 0xFF); out.write((h   shr 8) and 0xFF)

        for (y in 0 until h) {
            for (bx in 0 until bpr) {
                var byte = 0
                for (bit in 0 until 8) {
                    val x = bx * 8 + bit
                    if (x < w) {
                        val px  = pixels[y * w + x]
                        val lum = (Color.red(px) * 299 +
                                   Color.green(px) * 587 +
                                   Color.blue(px)  * 114) / 1000
                        if (lum < 128) byte = byte or (0x80 shr bit)
                    }
                }
                out.write(byte)
            }
        }
        return out.toByteArray()
    }

    private fun padBothEnds(left: String, right: String, width: Int): String {
        val space = (width - left.length - right.length).coerceAtLeast(1)
        return left + " ".repeat(space) + right
    }

    private fun fmtN(n: Double): String =
        if (n == n.toLong().toDouble()) n.toLong().toString()
        else "%.2f".format(n)

    private fun cmd(vararg bytes: Int) = ByteArray(bytes.size) { bytes[it].toByte() }
}
