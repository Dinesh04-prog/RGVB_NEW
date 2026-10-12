package com.nexuspos.app

import com.nexuspos.app.LabelParser.Field
import com.nexuspos.app.LabelParser.Line

/**
 * Merges what was read from 1–5 photos of one pack into one result. Pure Kotlin (unit-tested).
 *
 *  - Barcode: the first photo whose ML Kit barcode passes the checksum; else the first ML Kit barcode
 *    (marked unverified); else checksum-valid digits read by OCR, highest confidence.
 *  - MRP: every reading from every photo and every OCR pass is a candidate. Score = anchor strength
 *    (MRP / misread MRP / ₹ only, "incl. of all taxes", next to the net weight) + agreement (the same value
 *    read in more than one pass or photo) − implausible for the pack size. The best one is used; the other
 *    readings are returned as alternates, and a close strong alternate marks the MRP weak (yellow + chips).
 *  - Size, MFG, EXP: parsed per photo AND on all photos' text joined (so "best before 9 months"
 *    on one photo can combine with the PKD date on another); highest confidence wins, earliest photo on ties.
 *    If another photo gives a different value with similar confidence, the field is kept but marked weak.
 *  - Brand, English name: per photo with that photo's text sizes; known-brand/product-word confidence first,
 *    then the photo with the largest text (normally the front).
 *  - Devanagari name: the photo whose best Devanagari line is tallest.
 */
object ScanMerge {

    /**
     * One photo: merged OCR lines in reading order, the ML Kit barcode (raw value, format name) if any, and
     * the raw Latin OCR passes (plain, enhanced, sharpened) — each pass counts as a separate MRP reading.
     */
    data class Photo(
        val latin: List<Line>, val devanagari: List<Line>, val barcode: Pair<String, String>? = null,
        val passes: List<List<Line>> = emptyList(),
    )

    data class Merged(
        val mrp: Field<Double>,
        val netQty: Field<String>,
        val mfgDate: Field<String>,
        val expiryDate: Field<String>,
        val brand: Field<String>,
        val name: Field<String>,
        val nameMarathi: Field<String>,
        val barcode: String?,
        val barcodeFormat: String?,
        val barcodeVerified: Boolean,
        val barcodeConfidence: Double,
        val barcodeSource: String?,      // "mlkit-barcode" | "mlkit-ocr"
        /** field → photo number (1-based) it came from; 0 = all photos' text combined */
        val pickedFrom: Map<String, Int>,
        /** other MRP values read (best first), offered as one-tap chips in the popup */
        val mrpAlternates: List<Double> = emptyList(),
        /** short messages for the popup ("check the dates", ignored prices) */
        val warnings: List<String> = emptyList(),
        /** every MRP reading with its score, for the raw scan details */
        val mrpDebug: List<String> = emptyList(),
    )

    /** One MRP value with all its readings combined. */
    private class PriceVote(val value: Double, val score: Double, val sources: Int, val photo: Int, val reason: String, val final: Double)

    /** Pack size in g or ml ("250 g" → 250, "1 L" → 1000), or null. */
    private fun sizeInBaseUnits(qty: String?): Double? {
        val m = Regex("""^([\d.]+) (g|kg|ml|L)$""").matchEntire(qty ?: return null) ?: return null
        val n = m.groupValues[1].toDoubleOrNull() ?: return null
        return if (m.groupValues[2] == "kg" || m.groupValues[2] == "L") n * 1000 else n
    }

    /** −0.3 when the price per kg / L is outside what a shop sells (₹2 to ₹20,000 per kg or L). */
    private fun sizePenalty(price: Double, qty: String?): Double {
        val base = sizeInBaseUnits(qty) ?: return 0.0
        val perKg = price / base * 1000
        return if (perKg > 20000 || perKg < 2) -0.3 else 0.0
    }

    private fun voteMrp(photos: List<Photo>, qty: String?): Triple<Field<Double>, Int, List<PriceVote>> {
        class Reading(val photo: Int, val source: Int, val c: LabelParser.PriceCandidate)
        val readings = mutableListOf<Reading>()
        photos.forEachIndexed { i, p ->
            val sources = p.passes.ifEmpty { listOf(p.latin) }
            sources.forEachIndexed { k, lines ->
                LabelParser.mrpCandidates(lines.joinToString("\n") { it.text }).candidates
                    .groupBy { it.value }.forEach { (_, cs) -> readings += Reading(i + 1, k, cs.maxBy { it.score }) }
            }
        }
        val votes = readings.groupBy { it.c.value }.map { (v, rs) ->
            val top = rs.maxWith(compareBy<Reading> { it.c.score }.thenByDescending { it.photo })
            val sources = rs.map { it.photo to it.source }.distinct().size
            val final = top.c.score + 0.06 * (minOf(sources, 4) - 1) + sizePenalty(v, qty)
            PriceVote(v, top.c.score, sources, rs.minOf { it.photo }, top.c.reason, final)
        }.sortedWith(compareByDescending<PriceVote> { it.final }.thenBy { it.photo })
        val best = votes.firstOrNull() ?: return Triple(Field.none(), -1, emptyList())
        val others = votes.drop(1).filter { it.score >= 0.5 }
        val conflict = others.any { it.score >= 0.7 && it.final >= best.final - 0.3 }
        var conf = minOf(best.score, 0.99)
        if (conflict) conf = minOf(conf, WEAK)
        if (sizePenalty(best.value, qty) < 0) conf = minOf(conf, 0.45)
        return Triple(Field(best.value, conf), best.photo, votes)
    }

    /** A photo from its Latin OCR passes (same orientation): merged by region, then put in reading order. */
    fun photoOf(passes: List<List<Line>>, devanagari: List<Line>, barcode: Pair<String, String>?): Photo =
        Photo(OcrMerge.readingOrder(OcrMerge.mergePasses(passes)), devanagari, barcode, passes)

    private const val CONFLICT_GAP = 0.1
    private const val WEAK = 0.55

    private data class Cand<T>(val field: Field<T>, val photo: Int, val score: Double = field.confidence)

    /** Highest score wins, earlier photo on ties; a close different value lowers the confidence. */
    private fun <T> pick(cands: List<Cand<T>>): Pair<Field<T>, Int> {
        val real = cands.filter { it.field.value != null }
        if (real.isEmpty()) return Field.none<T>() to -1
        val best = real.sortedWith(compareByDescending<Cand<T>> { it.score }.thenBy { if (it.photo == 0) 99 else it.photo }).first()
        val conflict = real.any { it.field.value != best.field.value && it.field.confidence >= best.field.confidence - CONFLICT_GAP }
        val f = if (conflict) Field(best.field.value, minOf(best.field.confidence, WEAK)) else best.field
        return f to best.photo
    }

    fun merge(photos: List<Photo>): Merged {
        val picked = mutableMapOf<String, Int>()
        val texts = photos.map { p -> p.latin.joinToString("\n") { it.text } }
        val allText = texts.joinToString("\n")
        fun <T> perPhoto(parse: (String) -> Field<T>): List<Cand<T>> =
            texts.mapIndexed { i, t -> Cand(parse(t), i + 1) } + Cand(parse(allText), 0)

        val (qty, qtyFrom) = pick(perPhoto { LabelParser.parseNetQty(it) })
        val (mrp, mrpFrom, mrpVotes) = voteMrp(photos, qty.value)
        val dates = texts.map { LabelParser.parseDates(it) } + listOf(LabelParser.parseDates(allText))
        fun dateCands(sel: (Pair<Field<String>, Field<String>>) -> Field<String>) =
            dates.mapIndexed { i, d -> Cand(sel(d), if (i == texts.size) 0 else i + 1) }
        val (mfg, mfgFrom) = pick(dateCands { it.first })
        val (exp, expFrom) = pick(dateCands { it.second })

        // Brand + name: each photo is treated as the "front", the others as the "back"
        val maxH = photos.map { p -> p.latin.maxOfOrNull { it.height } ?: 0 }
        val globalMaxH = (maxH.maxOrNull() ?: 0).coerceAtLeast(1)
        val brandCands = mutableListOf<Cand<String>>()
        val nameCands = mutableListOf<Cand<String>>()
        photos.forEachIndexed { i, p ->
            val others = photos.filterIndexed { j, _ -> j != i }.flatMap { it.latin }
            val (b, n) = LabelParser.parseBrandAndName(p.latin, others)
            val sizeBonus = 0.15 * maxH[i] / globalMaxH   // big text = front of the pack
            brandCands += Cand(b, i + 1, b.confidence + sizeBonus)
            nameCands += Cand(n, i + 1, n.confidence + sizeBonus)
        }
        // A brand name that disagrees is normal (e.g. company line on the back), so no conflict penalty
        val brandBest = brandCands.filter { it.field.value != null }
            .sortedWith(compareByDescending<Cand<String>> { it.score }.thenBy { it.photo }).firstOrNull()
        val brand = brandBest?.field ?: Field.none()
        val nameBest = nameCands.filter { it.field.value != null }
            .sortedWith(compareByDescending<Cand<String>> { it.score }.thenBy { it.photo }).firstOrNull()
        val name = nameBest?.field ?: Field.none()

        // Devanagari: the photo with the tallest Devanagari name line
        var devBest: Field<String> = Field.none()
        var devFrom = -1
        var devH = -1
        photos.forEachIndexed { i, p ->
            val f = LabelParser.parseDevanagariName(p.devanagari)
            val h = if (f.value == null) -1 else p.devanagari.filter { f.value.contains(it.text.trim()) || it.text.contains(f.value) }
                .maxOfOrNull { it.height } ?: 0
            if (f.value != null && h > devH) { devBest = f; devFrom = i + 1; devH = h }
        }

        // Barcode
        var barcode: String? = null
        var format: String? = null
        var verified = false
        var bcConf = 0.0
        var bcSource: String? = null
        var bcFrom = -1
        val mlkit = photos.mapIndexedNotNull { i, p -> p.barcode?.let { Triple(i + 1, it.first, it.second) } }
        val good = mlkit.firstOrNull { LabelParser.isVerifiedBarcode(it.second, it.third) }
        if (good != null) {
            barcode = good.second; format = good.third; verified = true; bcConf = 0.95; bcSource = "mlkit-barcode"; bcFrom = good.first
        } else {
            val (fromText, textFrom) = pick(perPhoto { LabelParser.findBarcodeInText(it) })
            if (fromText.value != null) {
                barcode = fromText.value; verified = true; bcConf = fromText.confidence; bcSource = "mlkit-ocr"; bcFrom = textFrom
            } else mlkit.firstOrNull()?.let {
                barcode = it.second; format = it.third; verified = false; bcConf = 0.3; bcSource = "mlkit-barcode"; bcFrom = it.first
            }
        }

        if (mrp.value != null) picked["mrp"] = mrpFrom
        if (qty.value != null) picked["net_qty"] = qtyFrom
        if (mfg.value != null) picked["mfg_date"] = mfgFrom
        if (exp.value != null) picked["expiry_date"] = expFrom
        brandBest?.let { picked["brand"] = it.photo }
        nameBest?.let { picked["name_eng"] = it.photo }
        if (devBest.value != null) picked["name_marathi"] = devFrom
        if (barcode != null) picked["barcode"] = bcFrom

        val warnings = mutableListOf<String>()
        // Expiry must be after mfg when both came from different photos
        val badDates = mfg.value != null && exp.value != null && exp.value <= mfg.value
        val expChecked = if (badDates) Field(exp.value, 0.2) else exp
        if (badDates) warnings += "The expiry date read (${exp.value}) is not after the manufacture date (${mfg.value}). Check both dates."
        if (mrp.value == null) {
            val ignored = photos.flatMap { p -> p.passes.ifEmpty { listOf(p.latin) } }
                .flatMap { LabelParser.mrpCandidates(it.joinToString("\n") { l -> l.text }).rejected }.distinct()
            if (ignored.isNotEmpty()) warnings += "No MRP read. Ignored: " + ignored.joinToString(", ") { "${it.first} (${it.second})" } + "."
        }
        val alternates = mrpVotes.drop(1).filter { it.score >= 0.5 }.take(3).map { it.value }
        val mrpDebug = mrpVotes.map { v ->
            "₹${v.value}: score ${String.format(java.util.Locale.ROOT, "%.2f", v.final)} (${v.reason}, read ${v.sources}×, photo ${v.photo}" +
                (if (sizePenalty(v.value, qty.value) < 0) ", implausible for ${qty.value}" else "") + ")"
        }

        return Merged(mrp, qty, mfg, expChecked, brand, name, devBest, barcode, format, verified, bcConf, bcSource, picked,
            alternates, warnings, mrpDebug)
    }
}
