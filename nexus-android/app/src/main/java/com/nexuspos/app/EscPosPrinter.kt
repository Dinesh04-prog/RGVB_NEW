package com.nexuspos.app

import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream

/**
 * Builds an ESC/POS receipt in TEXT MODE using UTF-8 encoding.
 *
 * Why text mode and not bitmap:
 *   - Text mode sends ~1-2 KB per receipt (just character codes)
 *   - Bitmap/raster mode sends ~100-200 KB (one bit per pixel)
 *   - Result: text mode prints in <1 second; bitmap takes 5-10 seconds
 *
 * Devanagari (Marathi) works because modern thermal printers sold in India
 * have a built-in Unicode / UTF-8 font. Zobaze, CottonPOS, and similar apps
 * all use this same text-mode approach — they never send bitmaps for Marathi.
 *
 * Paper width assumed: 80 mm = 48 characters at standard font (Font A, 12 CPI).
 */
object EscPosPrinter {

    private const val LINE_CHARS = 48   // characters per line at 80mm, Font A

    // ── ESC/POS command bytes ──────────────────────────────────────────────────
    private val INIT        = cmd(0x1B, 0x40)
    private val ALIGN_LEFT  = cmd(0x1B, 0x61, 0x00)
    private val ALIGN_CTR   = cmd(0x1B, 0x61, 0x01)
    private val ALIGN_RIGHT = cmd(0x1B, 0x61, 0x02)
    private val BOLD_ON     = cmd(0x1B, 0x45, 0x01)
    private val BOLD_OFF    = cmd(0x1B, 0x45, 0x00)
    private val DBL_WH      = cmd(0x1D, 0x21, 0x11)   // double width + height
    private val DBL_H       = cmd(0x1D, 0x21, 0x01)   // double height only
    private val NORMAL_SIZE = cmd(0x1D, 0x21, 0x00)
    private val LF          = byteArrayOf(0x0A)
    private val FEED_CUT    = cmd(0x1B, 0x64, 0x05,   // feed 5 lines
                                  0x1D, 0x56, 0x41, 0x00)  // partial cut

    // ── Public entry point ────────────────────────────────────────────────────

    fun buildReceipt(json: JSONObject): ByteArray {
        val out = ByteArrayOutputStream()

        fun w(b: ByteArray) = out.write(b)
        fun nl()            = w(LF)
        fun text(s: String) = out.write(s.toByteArray(Charsets.UTF_8))
        fun line(s: String = "") { text(s); nl() }
        fun divider()       = line("-".repeat(LINE_CHARS))

        // ── Init ─────────────────────────────────────────────────────────────
        w(INIT)

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

        // ── Items ─────────────────────────────────────────────────────────────
        // Header row
        w(BOLD_ON)
        line(cols("Item", "Qty", "Rate", "Amt", LINE_CHARS))
        w(BOLD_OFF)
        divider()

        val items = json.optJSONArray("items") ?: JSONArray()
        for (i in 0 until items.length()) {
            val item = items.getJSONObject(i)
            val name = item.optString("name", "")
            val qty  = item.optDouble("qty",   0.0)
            val rate = item.optDouble("rate",  0.0)
            val amt  = item.optDouble("total", 0.0)
            val unit = item.optString("cartUnit", item.optString("unit", ""))

            // Item name on its own line (Marathi/Devanagari sent as UTF-8 bytes;
            // the printer's built-in Unicode font renders it natively — same speed
            // as ASCII because only character codes are transmitted, not pixels)
            line("${i + 1}. $name")

            // Numeric row — right-aligned
            w(ALIGN_RIGHT)
            line("${fmtN(qty)} $unit   ${fmtN(rate)}   ${fmtN(amt)}")
            w(ALIGN_LEFT)
        }
        divider()

        // ── Total ─────────────────────────────────────────────────────────────
        val total = json.optDouble("total", 0.0)
        w(BOLD_ON); w(DBL_H)
        val totalLine = padBothEnds("TOTAL", "Rs.${fmtN(total)}", LINE_CHARS)
        line(totalLine)
        w(NORMAL_SIZE); w(BOLD_OFF)
        divider()

        // ── Footer ────────────────────────────────────────────────────────────
        w(ALIGN_CTR)
        line("* Thank You — Visit Again! *")
        nl(); nl()

        // ── Feed + Cut ────────────────────────────────────────────────────────
        w(FEED_CUT)

        return out.toByteArray()
    }

    // ── Formatting helpers ────────────────────────────────────────────────────

    /** Pad left+right so that `left` is left-aligned and `right` is right-aligned. */
    private fun padBothEnds(left: String, right: String, width: Int): String {
        val space = (width - left.length - right.length).coerceAtLeast(1)
        return left + " ".repeat(space) + right
    }

    /** Simple 4-column header row with space-separated values. */
    private fun cols(c1: String, c2: String, c3: String, c4: String, width: Int): String {
        val right = "$c2   $c3   $c4"
        return padBothEnds(c1, right, width)
    }

    /** Format a number: no decimals if whole, 2 decimal places otherwise. */
    private fun fmtN(n: Double): String =
        if (n == n.toLong().toDouble()) n.toLong().toString()
        else "%.2f".format(n)

    private fun cmd(vararg bytes: Int) = ByteArray(bytes.size) { bytes[it].toByte() }
}
