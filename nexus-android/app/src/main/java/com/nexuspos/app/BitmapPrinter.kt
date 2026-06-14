package com.nexuspos.app

import android.graphics.*
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream

/**
 * Renders a receipt as a bitmap using Android Canvas.
 * Devanagari (Marathi) text is drawn automatically via Android's built-in
 * Noto Sans Devanagari font — identical to how Zobaze POS handles it.
 * The bitmap is then converted to ESC/POS raster format for thermal printers.
 */
object BitmapPrinter {

    private const val PAPER_W = 576        // 80 mm at 203 DPI
    private const val MARGIN  = 18f
    private const val LINE_GAP = 6f

    // ── Public entry point ────────────────────────────────────────────────────

    /** Receipt JSON → ready-to-send ESC/POS byte array */
    fun receiptToEscPos(json: JSONObject): ByteArray {
        val bitmap = drawReceipt(json)
        return bitmapToEscPos(bitmap).also { bitmap.recycle() }
    }

    // ── Drawing ───────────────────────────────────────────────────────────────

    private fun drawReceipt(json: JSONObject): Bitmap {
        // Draw on an oversized canvas, then crop to actual content height
        val scratch = Bitmap.createBitmap(PAPER_W, 8000, Bitmap.Config.ARGB_8888)
        val canvas  = Canvas(scratch)
        canvas.drawColor(Color.WHITE)

        val bold   = makePaint(bold = true)
        val normal = makePaint(bold = false)
        val line   = Paint().apply { color = Color.BLACK; strokeWidth = 2f }

        var y = MARGIN

        // ── Shop header ──────────────────────────────────────────────────────
        bold.textSize   = 38f
        bold.textAlign  = Paint.Align.CENTER
        canvas.drawText("RAJENDRA GVB", PAPER_W / 2f, y + 38f, bold)
        y += 50f

        normal.textSize  = 22f
        normal.textAlign = Paint.Align.CENTER
        canvas.drawText("Kirana & Grocery Store", PAPER_W / 2f, y + 22f, normal)
        y += 32f

        y = divider(canvas, line, y)

        // ── Bill meta ────────────────────────────────────────────────────────
        normal.textAlign = Paint.Align.LEFT
        normal.textSize  = 22f
        y = textRow(canvas, "Bill No : ${json.optString("receipt_no", "")}", normal, y)
        y = textRow(canvas, "Date    : ${json.optString("date", "")}", normal, y)
        val customer = json.optString("customerName", "")
        val phone    = json.optString("customerPhone", "")
        if (customer.isNotEmpty()) y = textRow(canvas, "Customer: $customer", normal, y)
        if (phone.isNotEmpty())    y = textRow(canvas, "Mobile  : $phone",    normal, y)

        y = divider(canvas, line, y)

        // ── Items header ─────────────────────────────────────────────────────
        bold.textSize   = 22f
        bold.textAlign  = Paint.Align.LEFT
        canvas.drawText("#  Item", MARGIN, y + 22f, bold)
        bold.textAlign  = Paint.Align.RIGHT
        canvas.drawText("Qty    Rate    Amt", PAPER_W - MARGIN, y + 22f, bold)
        y += 30f
        y = divider(canvas, line, y)

        // ── Items ────────────────────────────────────────────────────────────
        val items = json.optJSONArray("items") ?: JSONArray()
        for (i in 0 until items.length()) {
            val item  = items.getJSONObject(i)
            val name  = "${i + 1}.  ${item.optString("name", "")}"
            val qty   = item.optDouble("qty", 0.0)
            val rate  = item.optDouble("rate", 0.0)
            val amt   = item.optDouble("total", 0.0)
            val unit  = item.optString("cartUnit", item.optString("unit", ""))

            // Wrap name within 55% of paper width (leaves room for numbers)
            val nameMaxW = PAPER_W * 0.55f - MARGIN
            normal.textSize  = 24f
            normal.textAlign = Paint.Align.LEFT
            val nameLines = wrapText(name, normal, nameMaxW)
            val rowH = (nameLines.size * 30f + LINE_GAP).coerceAtLeast(34f)

            // Draw name lines (Devanagari rendered via Android font fallback)
            for ((li, ln) in nameLines.withIndex()) {
                canvas.drawText(ln, MARGIN, y + 24f + li * 30f, normal)
            }

            // Numbers — right-aligned, vertically centred in the row
            val numPaint = makePaint(bold = false).apply {
                textSize  = 22f
                textAlign = Paint.Align.RIGHT
            }
            val midY = y + rowH / 2f + 11f
            val qtyStr = "${fmtNum(qty)} $unit"
            canvas.drawText("$qtyStr   ${fmtNum(rate)}   ${fmtNum(amt)}",
                PAPER_W - MARGIN, midY, numPaint)

            y += rowH
        }

        y = divider(canvas, line, y)

        // ── Total ────────────────────────────────────────────────────────────
        val total = json.optDouble("total", 0.0)
        bold.textSize   = 32f
        bold.textAlign  = Paint.Align.LEFT
        canvas.drawText("TOTAL", MARGIN, y + 32f, bold)
        bold.textAlign  = Paint.Align.RIGHT
        canvas.drawText("Rs. ${fmtNum(total)}", PAPER_W - MARGIN, y + 32f, bold)
        y += 44f

        y = divider(canvas, line, y)

        // ── Footer ───────────────────────────────────────────────────────────
        normal.textSize  = 22f
        normal.textAlign = Paint.Align.CENTER
        canvas.drawText("*** Thank You — Visit Again! ***", PAPER_W / 2f, y + 22f, normal)
        y += 36f

        // Crop to actual content
        val finalH = (y + MARGIN).toInt().coerceAtMost(scratch.height)
        val cropped = Bitmap.createBitmap(scratch, 0, 0, PAPER_W, finalH)
        scratch.recycle()
        return cropped
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private fun makePaint(bold: Boolean) = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color     = Color.BLACK
        typeface  = if (bold) Typeface.DEFAULT_BOLD else Typeface.DEFAULT
    }

    private fun divider(canvas: Canvas, paint: Paint, y: Float): Float {
        canvas.drawLine(MARGIN, y + 6f, PAPER_W - MARGIN, y + 6f, paint)
        return y + 14f
    }

    private fun textRow(canvas: Canvas, text: String, paint: Paint, y: Float): Float {
        canvas.drawText(text, MARGIN, y + paint.textSize, paint)
        return y + paint.textSize + LINE_GAP + 4f
    }

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

    private fun fmtNum(n: Double): String =
        if (n == n.toLong().toDouble()) n.toLong().toString()
        else "%.2f".format(n)

    // ── ESC/POS raster conversion ─────────────────────────────────────────────

    /**
     * Converts a black-and-white bitmap to ESC/POS raster (GS v 0) bytes.
     * Pixels darker than 50% luminance print as black dots.
     */
    fun bitmapToEscPos(src: Bitmap): ByteArray {
        // Scale to exact paper width if needed
        val bm = if (src.width == PAPER_W) src
                 else Bitmap.createScaledBitmap(src, PAPER_W, src.height, true)

        val w    = bm.width
        val h    = bm.height
        val bpr  = (w + 7) / 8          // bytes per row

        val out  = ByteArrayOutputStream()

        // ESC @ — initialise printer
        out.write(byteArrayOf(0x1B, 0x40))
        // ESC a 1 — centre alignment
        out.write(byteArrayOf(0x1B, 0x61, 0x01))

        // GS v 0 0 xL xH yL yH — raster bit image, normal density
        out.write(0x1D); out.write(0x76); out.write(0x30); out.write(0x00)
        out.write(bpr and 0xFF);       out.write((bpr shr 8) and 0xFF)
        out.write(h   and 0xFF);       out.write((h   shr 8) and 0xFF)

        for (y in 0 until h) {
            for (bx in 0 until bpr) {
                var byte = 0
                for (bit in 0 until 8) {
                    val x = bx * 8 + bit
                    if (x < w) {
                        val px  = bm.getPixel(x, y)
                        val lum = (Color.red(px) * 0.299 +
                                   Color.green(px) * 0.587 +
                                   Color.blue(px)  * 0.114).toInt()
                        if (lum < 128) byte = byte or (0x80 shr bit)
                    }
                }
                out.write(byte)
            }
        }

        // Feed 5 lines + partial cut
        out.write(byteArrayOf(0x1B, 0x64, 0x05))
        out.write(byteArrayOf(0x1D, 0x56, 0x41, 0x00))

        if (bm !== src) bm.recycle()
        return out.toByteArray()
    }
}
