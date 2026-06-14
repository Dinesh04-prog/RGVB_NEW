package com.nexuspos.app

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream

/**
 * Hybrid ESC/POS receipt builder:
 *   - English text  → text mode (~1 byte/char, instant)
 *   - Devanagari    → small per-line inline bitmap (~2 KB/line, fast)
 * Total data: ~25-30 KB vs ~150 KB for full bitmap → prints in 2-3 seconds.
 */
object EscPosPrinter {

    private const val LINE_CHARS = 48
    private const val PAPER_W    = 576   // 80 mm at 203 DPI

    // ── ESC/POS commands ──────────────────────────────────────────────────────
    private val INIT        = cmd(0x1B, 0x40)
    private val ALIGN_LEFT  = cmd(0x1B, 0x61, 0x00)
    private val ALIGN_CTR   = cmd(0x1B, 0x61, 0x01)
    private val ALIGN_RIGHT = cmd(0x1B, 0x61, 0x02)
    private val BOLD_ON     = cmd(0x1B, 0x45, 0x01)
    private val BOLD_OFF    = cmd(0x1B, 0x45, 0x00)
    private val DBL_WH      = cmd(0x1D, 0x21, 0x11)
    private val DBL_H       = cmd(0x1D, 0x21, 0x01)
    private val NORMAL_SIZE = cmd(0x1D, 0x21, 0x00)
    private val LF          = byteArrayOf(0x0A)
    private val FEED_CUT    = cmd(0x1B, 0x64, 0x05, 0x1D, 0x56, 0x41, 0x00)

    // ── Public entry point ────────────────────────────────────────────────────

    fun buildReceipt(json: JSONObject): ByteArray {
        val out = ByteArrayOutputStream()

        fun w(b: ByteArray) = out.write(b)
        fun nl()            = w(LF)
        fun text(s: String) = out.write(s.toByteArray(Charsets.UTF_8))
        fun line(s: String = "") { text(s); nl() }
        fun divider()       = line("-".repeat(LINE_CHARS))

        w(INIT)

        // ── Shop header (English – text mode) ─────────────────────────────────
        w(ALIGN_CTR); w(BOLD_ON); w(DBL_WH)
        line("RAJENDRA GVB")
        w(NORMAL_SIZE); w(BOLD_OFF)
        line("Kirana & Grocery Store")
        divider()

        // ── Bill meta (English – text mode) ───────────────────────────────────
        w(ALIGN_LEFT)
        line("Bill No : ${json.optString("receipt_no", "")}")
        line("Date    : ${json.optString("date", "")}")
        val customer = json.optString("customerName", "")
        val phone    = json.optString("customerPhone", "")
        if (customer.isNotEmpty()) line("Customer: $customer")
        if (phone.isNotEmpty())    line("Mobile  : $phone")
        divider()

        // ── Items header ──────────────────────────────────────────────────────
        w(BOLD_ON)
        line(cols("Item", "Qty", "Rate", "Amt", LINE_CHARS))
        w(BOLD_OFF)
        divider()

        // ── Items (hybrid) ────────────────────────────────────────────────────
        val items = json.optJSONArray("items") ?: JSONArray()
        for (i in 0 until items.length()) {
            val item = items.getJSONObject(i)
            val name = item.optString("name", "")
            val qty  = item.optDouble("qty",   0.0)
            val rate = item.optDouble("rate",  0.0)
            val amt  = item.optDouble("total", 0.0)
            val unit = item.optString("cartUnit", item.optString("unit", ""))

            val displayName = "${i + 1}. $name"
            w(ALIGN_LEFT)

            if (hasDevanagari(name)) {
                // Render as a tiny per-line bitmap so the printer's built-in
                // Android Noto Devanagari font draws it — ~2 KB per line
                w(renderDevanagariLine(displayName, 26f))
            } else {
                line(displayName)
            }

            // Numbers are always ASCII → text mode
            w(ALIGN_RIGHT)
            line("${fmtN(qty)} $unit   ${fmtN(rate)}   ${fmtN(amt)}")
            w(ALIGN_LEFT)
        }
        divider()

        // ── Total (text mode) ─────────────────────────────────────────────────
        val total = json.optDouble("total", 0.0)
        w(BOLD_ON); w(DBL_H)
        line(padBothEnds("TOTAL", "Rs.${fmtN(total)}", LINE_CHARS))
        w(NORMAL_SIZE); w(BOLD_OFF)
        divider()

        // ── Footer ────────────────────────────────────────────────────────────
        w(ALIGN_CTR)
        line("* Thank You — Visit Again! *")
        nl(); nl()

        w(FEED_CUT)
        return out.toByteArray()
    }

    // ── Devanagari → inline ESC/POS raster ───────────────────────────────────

    private fun hasDevanagari(text: String): Boolean =
        text.any { it.code in 0x0900..0x097F }

    private fun renderDevanagariLine(text: String, fontSize: Float): ByteArray {
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color    = Color.BLACK
            textSize = fontSize
        }
        val lineH = (fontSize * 1.6f).toInt().coerceAtLeast(40)
        val bm = Bitmap.createBitmap(PAPER_W, lineH, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bm)
        canvas.drawColor(Color.WHITE)
        canvas.drawText(text, 4f, fontSize + 6f, paint)

        return bitmapLineToEscPos(bm).also { bm.recycle() }
    }

    private fun bitmapLineToEscPos(bm: Bitmap): ByteArray {
        val w      = bm.width
        val h      = bm.height
        val bpr    = (w + 7) / 8
        val pixels = IntArray(w * h)
        bm.getPixels(pixels, 0, w, 0, 0, w, h)

        val out = ByteArrayOutputStream(8 + bpr * h)
        // GS v 0 — raster image
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

    // ── Text helpers ──────────────────────────────────────────────────────────

    private fun padBothEnds(left: String, right: String, width: Int): String {
        val space = (width - left.length - right.length).coerceAtLeast(1)
        return left + " ".repeat(space) + right
    }

    private fun cols(c1: String, c2: String, c3: String, c4: String, width: Int): String =
        padBothEnds(c1, "$c2   $c3   $c4", width)

    private fun fmtN(n: Double): String =
        if (n == n.toLong().toDouble()) n.toLong().toString()
        else "%.2f".format(n)

    private fun cmd(vararg bytes: Int) = ByteArray(bytes.size) { bytes[it].toByte() }
}
