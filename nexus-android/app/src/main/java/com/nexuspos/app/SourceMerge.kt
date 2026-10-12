package com.nexuspos.app

import com.nexuspos.app.LabelParser.Field

/**
 * Combines the three readers of a pack into one value per field. Pure Kotlin (SourceMergeTest).
 *
 *  - Gemini (read like a person, online) is the primary source when its confidence is ≥ 0.6.
 *  - The phone's OCR (ScanMerge) and Open Food Facts (only for a checksum-valid barcode) cross-check it:
 *    agreement raises the confidence; disagreement keeps Gemini's value but makes it weak (yellow) and offers
 *    the other values as alternates (chips).
 *  - Without a usable Gemini value the OCR value is used; Open Food Facts fills a blank, and when it disagrees
 *    with a weak OCR read it wins as a weak value with the OCR read offered as a chip (e.g. "tasty sugar").
 *  - Barcode: only ML Kit / OCR digits (checksum-validated in ScanMerge). A Gemini barcode never fills the
 *    field; it is only an unverified suggestion when the phone read none.
 *  - Marathi name: Gemini's Devanagari only at confidence ≥ 0.8 (the web side still applies the shop's spellings).
 */
object SourceMerge {

    const val GEMINI_MIN = 0.6
    const val GEMINI_MARATHI_MIN = 0.8
    private const val WEAK = 0.55
    private const val AGREE = 0.9
    private const val OCR_WEAK = 0.6

    /** What Gemini returned (already validated by the Worker). Null fields = not clearly visible. */
    data class GeminiRead(
        val nameEng: String? = null, val nameMarathi: String? = null, val brand: String? = null,
        val netQty: String? = null, val mrp: Double? = null, val mfgDate: String? = null, val expiryDate: String? = null,
        val barcode: String? = null, val confidence: Map<String, Double> = emptyMap(),
    )

    /** Open Food Facts product for a checksum-valid barcode (quantity already normalised, e.g. "38 g"). */
    data class OffRead(val name: String?, val brand: String?, val netQty: String?)

    data class Value<T>(val value: T?, val confidence: Double, val source: String?, val alternates: List<T> = emptyList())

    data class Result(
        val nameEng: Value<String>, val nameMarathi: Value<String>, val brand: Value<String>, val netQty: Value<String>,
        val mrp: Value<Double>, val mfgDate: Value<String>, val expiryDate: Value<String>,
        /** Gemini's barcode when the phone read none: shown as an unverified suggestion, never filled */
        val barcodeSuggestion: String?,
    )

    private const val OCR = "mlkit-ocr"
    private const val GEMINI = "gemini"
    private const val OFF = "openfoodfacts"

    /** Same name / brand apart from case, spaces, punctuation, a size or a couple of OCR letters. */
    fun sameText(a: String, b: String): Boolean {
        fun n(s: String) = s.lowercase()
            .replace(Regex("""\d+(?:[.,]\d+)?\s*(?:g|gm|gms|kg|ml|l|ltr)\b"""), " ")
            .replace(Regex("""[^a-z0-9ऀ-ॿ]"""), "")
        val x = n(a)
        val y = n(b)
        if (x.isEmpty() || y.isEmpty()) return false
        if (x == y) return true
        // one contains the other only when the shorter is most of the longer ("Shing Bhujia" vs "Tasty Nuts Shing Bhujia")
        val (s, l) = if (x.length <= y.length) x to y else y to x
        if (l.contains(s) && s.length * 2 >= l.length) return true
        return NameSpell.osa(x, y, 2) <= 2
    }

    private fun <T> merge(
        gemini: T?, geminiConf: Double, ocr: Field<T>, off: T?, same: (T, T) -> Boolean,
    ): Value<T> {
        val others = listOfNotNull(ocr.value?.let { it to OCR }, off?.let { it to OFF })
        if (gemini != null && geminiConf >= GEMINI_MIN) {
            val agrees = others.any { same(gemini, it.first) }
            val disagree = others.filter { !same(gemini, it.first) }.map { it.first }
            val conf = when {
                disagree.isNotEmpty() -> minOf(geminiConf, WEAK)
                agrees -> maxOf(geminiConf, AGREE)
                else -> geminiConf
            }
            return Value(gemini, conf, GEMINI, distinctBy(disagree, same))
        }
        // No usable Gemini value: the phone's reading, checked against Open Food Facts
        val lowGemini = listOfNotNull(gemini)
        val o = ocr.value
        return when {
            o != null && off != null && same(o, off) ->
                Value(o, maxOf(ocr.confidence, AGREE), OCR, distinctBy(lowGemini.filter { !same(it, o) }, same))
            o != null && off != null && ocr.confidence < OCR_WEAK ->
                Value(off, WEAK, OFF, distinctBy(listOf(o) + lowGemini.filter { !same(it, off) }, same))
            o != null && off != null ->
                Value(o, minOf(ocr.confidence, WEAK), OCR, distinctBy(listOf(off) + lowGemini.filter { !same(it, o) }, same))
            o != null -> Value(o, ocr.confidence, OCR, distinctBy(lowGemini.filter { !same(it, o) }, same))
            off != null -> Value(off, 0.5, OFF, distinctBy(lowGemini.filter { !same(it, off) }, same))
            gemini != null -> Value(gemini, minOf(geminiConf, WEAK), GEMINI)   // low-confidence Gemini, still better than nothing: weak
            else -> Value(null, 0.0, null)
        }
    }

    private fun <T> distinctBy(xs: List<T>, same: (T, T) -> Boolean): List<T> =
        xs.fold(mutableListOf()) { acc, x -> if (acc.none { same(it, x) }) acc += x; acc }

    fun merge(ocr: ScanMerge.Merged, gemini: GeminiRead?, off: OffRead?): Result {
        val g = gemini ?: GeminiRead()
        fun c(f: String) = g.confidence[f] ?: 0.0
        val eq: (String, String) -> Boolean = { a, b -> a == b }
        val mrp = merge(g.mrp, c("mrp"), ocr.mrp, null) { a, b -> kotlin.math.abs(a - b) < 0.005 }
        // The phone's other MRP readings stay as chips too
        val mrpAlts = (mrp.alternates + ocr.mrpAlternates + listOfNotNull(ocr.mrp.value))
            .filter { kotlin.math.abs(it - (mrp.value ?: -1.0)) >= 0.005 }.distinct().take(4)
        val qty = merge(g.netQty, c("net_qty"), ocr.netQty, off?.netQty, eq)
        val qtyAlts = (qty.alternates + ocr.qtyAlternates + listOfNotNull(ocr.netQty.value)).filter { it != qty.value }.distinct().take(4)

        val gMr = g.nameMarathi
        val marathi: Value<String> = when {
            gMr != null && c("name_marathi") >= GEMINI_MARATHI_MIN ->
                Value(gMr, minOf(c("name_marathi"), WEAK), GEMINI)   // always weak: the shop checks Marathi
            ocr.nameMarathi.value != null -> Value(ocr.nameMarathi.value, ocr.nameMarathi.confidence, OCR)
            else -> Value(null, 0.0, null)
        }
        return Result(
            nameEng = merge(g.nameEng, c("name_eng"), ocr.name, off?.name, ::sameText),
            nameMarathi = marathi,
            brand = merge(g.brand, c("brand"), ocr.brand, off?.brand, ::sameText),
            netQty = qty.copy(alternates = qtyAlts),
            mrp = mrp.copy(alternates = mrpAlts),
            mfgDate = merge(g.mfgDate, c("mfg_date"), ocr.mfgDate, null, eq),
            expiryDate = merge(g.expiryDate, c("expiry_date"), ocr.expiryDate, null, eq),
            barcodeSuggestion = if (ocr.barcode == null && g.barcode != null && LabelParser.isValidGtin(g.barcode)) g.barcode else null,
        )
    }
}
