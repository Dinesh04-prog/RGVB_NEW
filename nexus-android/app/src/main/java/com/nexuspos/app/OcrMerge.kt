package com.nexuspos.app

import com.nexuspos.app.LabelParser.Line

/**
 * Combines several OCR passes over one photo (plain, contrast-enhanced, sharpened) into one list of lines.
 * Pure Kotlin (unit-tested by ReplayTest / OcrMergeTest).
 *
 *  - Lines from different passes that cover the same region are one line: the read with the higher
 *    ML Kit confidence wins, with a penalty for OCR garbage ("2__.00", "?").
 *  - Lines only one pass found are added.
 *  - Reading order follows columns: a two-column back panel is read column by column, not mixed by height.
 */
object OcrMerge {

    /** Below this much readable text the photo is probably turned sideways: try 90° / 270°. */
    const val LITTLE_TEXT_CHARS = 12

    private val GARBAGE = Regex("""[_?#~*|]""")

    /** Score of one read: ML Kit confidence when known (else 0.6), minus a penalty for garbage characters. */
    fun quality(l: Line): Double {
        val conf = if (l.confidence > 0f) l.confidence.toDouble() else 0.6
        val chars = l.text.count { !it.isWhitespace() }.coerceAtLeast(1)
        return conf - 0.6 * GARBAGE.findAll(l.text).count() / chars
    }

    /** Readable characters, weighted by confidence: used to tell "very little text" and to pick a rotation. */
    fun textAmount(lines: List<Line>): Double = lines.sumOf { l ->
        val readable = l.text.count { it.isLetterOrDigit() }
        if (readable < 2) 0.0 else readable * quality(l).coerceIn(0.05, 1.0)
    }

    fun littleText(lines: List<Line>) = textAmount(lines) < LITTLE_TEXT_CHARS

    /** The rotation (degrees) whose pass read the most text. Ties keep the earlier one (0° first). */
    fun chooseOrientation(passes: List<Pair<Int, List<Line>>>): Int =
        passes.maxWithOrNull(compareBy { textAmount(it.second) })?.first ?: 0

    private fun hasBox(l: Line) = l.width > 0 && l.height > 0

    /** Same region of the photo: boxes overlap at least half vertically and a third horizontally. */
    fun sameRegion(a: Line, b: Line): Boolean {
        if (!hasBox(a) || !hasBox(b)) return false
        val vOverlap = minOf(a.top + a.height, b.top + b.height) - maxOf(a.top, b.top)
        val hOverlap = minOf(a.left + a.width, b.left + b.width) - maxOf(a.left, b.left)
        return vOverlap >= 0.5 * minOf(a.height, b.height) && hOverlap >= 0.33 * minOf(a.width, b.width)
    }

    private fun normText(s: String) = s.uppercase().replace(Regex("""\s+"""), " ").trim()

    /**
     * Merges passes over the same image (same coordinates). The first pass is the base.
     * Lines without a position cannot be matched by region: they are matched by identical text instead.
     */
    fun mergePasses(passes: List<List<Line>>): List<Line> {
        val merged = passes.firstOrNull()?.toMutableList() ?: return emptyList()
        for (pass in passes.drop(1)) {
            for (l in pass) {
                if (l.text.isBlank()) continue
                val i = merged.indexOfFirst { m -> sameRegion(m, l) || (!hasBox(l) && normText(m.text) == normText(l.text)) }
                when {
                    i < 0 -> merged += l
                    quality(l) > quality(merged[i]) + 0.02 -> merged[i] = l
                }
            }
        }
        return merged
    }

    /** True when some read is weak (low confidence or garbage): worth another, sharpened pass. */
    fun hasWeakLines(lines: List<Line>) = lines.any { it.text.count { c -> c.isLetterOrDigit() } >= 3 && quality(it) < 0.7 }

    /**
     * Reading order. Lines without positions keep the old order (by top). With positions, lines are grouped
     * into blocks (a line joins the block whose last line is just above it and overlaps it horizontally),
     * and blocks are read top to bottom, left to right.
     */
    fun readingOrder(lines: List<Line>): List<Line> {
        val byTop = lines.sortedWith(compareBy<Line> { it.top }.thenBy { it.left })
        if (byTop.none { hasBox(it) }) return byTop
        val blocks = mutableListOf<MutableList<Line>>()
        for (l in byTop) {
            val block = blocks.lastOrNull { b ->
                val last = b.last()
                val gap = l.top - (last.top + last.height)
                val h = maxOf(last.height, l.height, 1)
                gap <= 2.5 * h && gap >= -h && columnsOverlap(last, l)
            }
            if (block != null) block += l else blocks += mutableListOf(l)
        }
        // Blocks that start on the same text row are read left to right; rows top to bottom
        val rows = mutableListOf<MutableList<MutableList<Line>>>()
        for (b in blocks.sortedBy { it.first().top }) {
            val row = rows.lastOrNull()
            val first = row?.first()?.first()
            if (row != null && first != null && b.first().top - first.top <= maxOf(first.height, b.first().height)) row += b
            else rows += mutableListOf(b)
        }
        return rows.flatMap { row -> row.sortedBy { it.first().left }.flatten() }
    }

    private fun columnsOverlap(a: Line, b: Line): Boolean {
        if (!hasBox(a) || !hasBox(b)) return true
        val overlap = minOf(a.left + a.width, b.left + b.width) - maxOf(a.left, b.left)
        return overlap >= 0.3 * minOf(a.width, b.width)
    }
}
