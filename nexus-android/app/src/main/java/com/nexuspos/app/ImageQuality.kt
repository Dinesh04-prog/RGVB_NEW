package com.nexuspos.app

/**
 * Photo checks and OCR image clean-up on plain grey values (0..255). Pure Kotlin (unit-tested);
 * ScanPipeline / ProductScanActivity convert Android bitmaps to rows of grey values and back.
 */
object ImageQuality {

    /** Thresholds are for a ~800 px wide crop of the guide frame. They only trigger a warning; the user decides. */
    const val BLUR_MIN_VARIANCE = 45.0
    const val DARK_MAX_MEAN = 55.0
    const val GLARE_MIN_FRACTION = 0.06

    enum class Issue(val message: String) {
        BLURRY("Too blurry. Hold steady and tap the text to focus."),
        DARK("Too dark. Turn on the torch or move to more light."),
        GLARE("Glare on the pack. Tilt it slightly away from the light."),
    }

    data class Report(val sharpness: Double, val brightness: Double, val glare: Double, val issues: List<Issue>)

    fun grey(argb: Int): Int = (((argb shr 16) and 0xFF) * 299 + ((argb shr 8) and 0xFF) * 587 + (argb and 0xFF) * 114) / 1000

    /** [g] = grey values row by row, [w]×[h]. */
    fun assess(g: IntArray, w: Int, h: Int): Report {
        require(g.size >= w * h && w >= 3 && h >= 3)
        var sum = 0.0
        var clipped = 0
        for (i in 0 until w * h) { sum += g[i]; if (g[i] >= 250) clipped++ }
        // Variance of the 4-neighbour Laplacian: low = few sharp edges = blurry
        var lSum = 0.0
        var lSq = 0.0
        var n = 0
        for (y in 1 until h - 1) for (x in 1 until w - 1) {
            val i = y * w + x
            val lap = (g[i - 1] + g[i + 1] + g[i - w] + g[i + w] - 4 * g[i]).toDouble()
            lSum += lap; lSq += lap * lap; n++
        }
        val mean = lSum / n
        val sharpness = lSq / n - mean * mean
        val brightness = sum / (w * h)
        val glare = clipped.toDouble() / (w * h)
        val issues = buildList {
            if (brightness < DARK_MAX_MEAN) add(Issue.DARK)
            else if (sharpness < BLUR_MIN_VARIANCE) add(Issue.BLURRY)   // a dark photo always looks blurry
            if (glare >= GLARE_MIN_FRACTION) add(Issue.GLARE)
        }
        return Report(sharpness, brightness, glare, issues)
    }

    /**
     * Contrast stretch limits from a 256-bin grey histogram: the 1st and 99th percentile.
     * Returns null when the photo already uses the full range (nothing to gain).
     */
    fun stretchLimits(hist: IntArray): Pair<Int, Int>? {
        val total = hist.sum().takeIf { it > 0 } ?: return null
        var acc = 0
        var lo = 0
        while (lo < 255 && acc + hist[lo] <= total / 100) { acc += hist[lo]; lo++ }
        acc = 0
        var hi = 255
        while (hi > 0 && acc + hist[hi] <= total / 100) { acc += hist[hi]; hi-- }
        if (hi - lo < 16) return null          // flat image: stretching would only amplify noise
        if (lo <= 8 && hi >= 247) return null
        return lo to hi
    }

    fun stretch(v: Int, lo: Int, hi: Int): Int = ((v - lo) * 255 / (hi - lo)).coerceIn(0, 255)

    /** 3×3 sharpen (centre 5, neighbours −1) of row [cur] using the rows above/below; edges copied. */
    fun sharpenRow(prev: IntArray, cur: IntArray, next: IntArray, out: IntArray, w: Int) {
        out[0] = cur[0]
        out[w - 1] = cur[w - 1]
        for (x in 1 until w - 1) {
            out[x] = (5 * cur[x] - cur[x - 1] - cur[x + 1] - prev[x] - next[x]).coerceIn(0, 255)
        }
    }
}
