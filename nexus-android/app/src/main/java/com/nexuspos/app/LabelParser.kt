package com.nexuspos.app

import java.time.LocalDate
import java.time.YearMonth

/**
 * Pure-Kotlin parser for OCR text read from Indian packaged-goods labels.
 * No Android imports — runs in plain JVM unit tests (see LabelParserTest).
 *
 * Every field comes back with a 0..1 confidence. The parser never invents a
 * value: when nothing matches clearly the value is null.
 */
object LabelParser {

    /**
     * One OCR line. [height] = bounding-box height in px (0 when unknown), [top]/[left] = box corner,
     * [width] = box width (0 = position unknown), [confidence] = ML Kit line confidence 0..1 (-1 = unknown).
     */
    data class Line(
        val text: String, val height: Int = 0, val top: Int = 0,
        val left: Int = 0, val width: Int = 0, val confidence: Float = -1f,
    )

    data class Field<T>(val value: T?, val confidence: Double) {
        companion object {
            fun <T> none(): Field<T> = Field(null, 0.0)
        }
    }

    data class Result(
        val mrp: Field<Double>,
        val netQty: Field<String>,
        val mfgDate: Field<String>,      // ISO yyyy-MM-dd
        val expiryDate: Field<String>,   // ISO yyyy-MM-dd
        val brand: Field<String>,
        val name: Field<String>,
        val nameMarathi: Field<String>,
        val barcodeFromText: Field<String>,
    )

    /**
     * @param front  OCR lines of the front photo (Latin recognizer), may be empty.
     * @param back   OCR lines of the back photo (Latin recognizer).
     * @param devanagari OCR lines from the Devanagari recognizer (front first, then back).
     */
    fun parse(front: List<Line>, back: List<Line>, devanagari: List<Line> = emptyList()): Result {
        val backText = back.joinToString("\n") { it.text }
        val allText = (back + front).joinToString("\n") { it.text }

        val mrp = parseMrp(backText).let { if (it.value == null) parseMrp(allText) else it }
        val qtyBack = parseNetQty(backText)
        val qtyFront = parseNetQty(front.joinToString("\n") { it.text })
        val netQty = if ((qtyFront.confidence) > qtyBack.confidence) qtyFront else qtyBack
        val dates = parseDates(backText)

        val (brand, name) = parseBrandAndName(front, back)
        return Result(
            mrp = mrp,
            netQty = netQty,
            mfgDate = dates.first,
            expiryDate = dates.second,
            brand = brand,
            name = name,
            nameMarathi = parseDevanagariName(devanagari),
            barcodeFromText = findBarcodeInText(allText),
        )
    }

    // ── OCR clean-up ─────────────────────────────────────────────────────────

    private val DIGIT_LOOKALIKE = mapOf(
        'O' to '0', 'o' to '0', 'Q' to '0', 'D' to '0',
        'S' to '5', 's' to '5',
        'I' to '1', 'l' to '1', '|' to '1', 'i' to '1',
        'Z' to '2', 'B' to '8',
    )

    /**
     * Fix common OCR confusions, but only *inside numbers*:
     * "4S.00" → "45.00", "2O27" → "2027", "l00g" → "100g", "5OOg" → "500g".
     * Words stay untouched: "Rs45" keeps its s, "1ltr" keeps its l, "B12" (batch) keeps its B.
     */
    fun fixDigits(s: String): String {
        val c = s.replace("₨", "Rs").toCharArray()
        fun look(ch: Char) = DIGIT_LOOKALIKE.containsKey(ch)
        var i = 0
        while (i < c.size) {
            if (!(c[i].isDigit() || look(c[i]))) { i++; continue }
            var j = i
            while (j < c.size && (c[j].isDigit() || look(c[j]))) j++
            if ((i until j).any { c[it].isDigit() }) {
                var a = i
                var b = j - 1
                // Leading look-alikes glued to a word are letters ("Rs45" → the s stays)
                if (i > 0 && c[i - 1].isLetter()) while (a <= b && !c[a].isDigit()) a++
                // Trailing l/I/S before letters start a unit/word ("1ltr", "2Sachets")
                if (j < c.size && c[j].isLetter()) {
                    while (b >= a && !c[b].isDigit() && c[b] in "lIiSsBD") b--
                }
                for (k in a..b) {
                    val r = DIGIT_LOOKALIKE[c[k]] ?: continue
                    // B, D, i only count as digits when surrounded by digits ("1B0")
                    if (c[k] in "BDi" && !(k > a && k < b && c[k - 1].isDigit() && c[k + 1].isDigit())) continue
                    c[k] = r
                }
            }
            i = j
        }
        return String(c)
    }

    // ── MRP ──────────────────────────────────────────────────────────────────

    private val MRP_ANCHOR = Regex(
        """M\s?\.?\s?R\s?\.?\s?P\s?\.?|MAX(?:IMUM)?\.?\s*RETAIL\s*PRICE|MAX\.?\s*R\.?\s*P""",
    )
    // "MRP" misread by OCR (MRF, MPR, NRP, HRP): only counts when a number follows right away
    private val MRP_ANCHOR_MISREAD = Regex("""\b(?:MRF|MPR|NRP|HRP|MRR)\b\s?[:.]?(?=\s*(?:₹|RS\.?)?\s*\d)""")
    private val CURRENCY_ANCHOR = Regex("""₹|\bRS\s?\.?|\bINR\b|\bRUPEES\b""")
    private val PRICE_NUM = Regex("""(\d{1,2},\d{3}(?:\.\d{1,2})?|\d{1,5}(?:[.,]\d{1,2})?)(\s*/\s*-)?""")
    private val NOT_MRP_CONTEXT = Regex(
        """PER\b|UNIT\s*SALE|UNIT\s*PRICE|\bUSP\b|OFFER|SPECIAL\s*PRICE|DEAL|SAVE|\bOFF\b|DISCOUNT|B\s?\.?\s?NO|BATCH|\bLOT\b|FSSAI|LIC|CARE|PH\s?\.?|TEL|\bCALL|TOLL|KCAL|COUPON|CASHBACK"""
    )
    private val UNIT_AFTER = Regex("""^\s*(?:/|PER)\s*(?:\d+\s*)?(?:G|GM|KG|ML|L|LTR|UNIT|PC|PCS|N)\b""")
    // Inkjet MRP with a space between characters: "1 2 0 . 0 0"
    private val SPACED_PRICE = Regex("""(?<![\d.])\d(?: [\d.]){2,}(?![\d.])""")
    // A print gap inside the number right after the anchor, only with paise: "₹ 1 08.00"
    private val SPLIT_PRICE = Regex("""^([^\d]{0,12}?)(\d{1,2}) (\d{2,3}\.\d{2})(?!\d)""")

    /** One MRP reading. [score] 0..1; [line] = line index in the text it was read from. */
    data class PriceCandidate(val value: Double, val score: Double, val line: Int, val reason: String)

    /** All MRP readings of a text, plus numbers that looked like a price but were rejected (value to why). */
    data class MrpScan(val candidates: List<PriceCandidate>, val rejected: List<Pair<String, String>>)

    fun parseMrp(text: String): Field<Double> {
        val cands = mrpCandidates(text).candidates
        if (cands.isEmpty()) return Field.none()
        val best = cands.sortedWith(compareByDescending<PriceCandidate> { it.score }.thenBy { it.line }).first()
        // Two different strong candidates → still return the first strong one, but lower confidence.
        val conflicting = cands.any { it.score >= 0.7 && it.value != best.value }
        return Field(best.value, if (conflicting) minOf(best.score, 0.55) else best.score)
    }

    /** On a line with a price anchor: "1 2 0 . 0 0" → "120.00". Other lines are untouched. */
    fun normalizePriceLine(line: String): String {
        if (!MRP_ANCHOR.containsMatchIn(line) && !MRP_ANCHOR_MISREAD.containsMatchIn(line) &&
            !CURRENCY_ANCHOR.containsMatchIn(line)) return line
        return SPACED_PRICE.replace(line) { m ->
            val v = m.value.replace(" ", "")
            if (Regex("""\d{1,5}\.\d{2}""").matches(v)) v else m.value   // only a whole "120.00" shape
        }
    }

    fun mrpCandidates(text: String): MrpScan {
        // OCR often reads "Rs." as "R5." / "R S." — restore it before numbers are parsed
        val lines = text.lines().map {
            normalizePriceLine(fixDigits(it).uppercase().replace(Regex("""\bR\s?[5S]\s?\.(?=\s?\d)"""), "RS. "))
        }
        val cands = mutableListOf<PriceCandidate>()
        val rejected = mutableListOf<Pair<String, String>>()
        // MRP is usually printed next to the net weight
        val netLines = lines.indices.filter { NET_ANCHOR.containsMatchIn(lines[it]) }
        fun near(li: Int) = if (netLines.any { kotlin.math.abs(it - li) <= 2 }) 0.03 else 0.0

        for ((li, line) in lines.withIndex()) {
            val hasIncl = line.contains("INCL") || line.contains("ALL TAX")
            // 1) Strong anchor: MRP / Max Retail Price
            for (m in MRP_ANCHOR.findAll(line)) {
                val after = line.substring(m.range.last + 1)
                val num = firstPriceAfter(after, rejected = rejected)
                if (num != null) {
                    // A "NEW MRP" sticker overrides the printed MRP
                    val isNew = line.substring(0, m.range.first).trimEnd().endsWith("NEW")
                    cands += PriceCandidate(num, 0.9 + (if (hasIncl) 0.05 else 0.0) + (if (isNew) 0.1 else 0.0) + near(li),
                        li, if (isNew) "new MRP sticker" else "MRP")
                } else if (li + 1 < lines.size) {
                    // Anchor on one line, value on the next (common on MRP stamps)
                    firstPriceAfter(lines[li + 1], allowUnanchoredStart = true, rejected = rejected)?.let {
                        cands += PriceCandidate(it, 0.7 + near(li), li, "MRP, value on next line")
                    }
                }
            }
            if (MRP_ANCHOR.containsMatchIn(line)) continue
            // 2) "MRP" misread by OCR ("MRF: 99.00")
            val misread = MRP_ANCHOR_MISREAD.findAll(line).toList()
            for (m in misread) {
                firstPriceAfter(line.substring(m.range.last + 1), rejected = rejected)?.let {
                    cands += PriceCandidate(it, 0.75 + (if (hasIncl) 0.05 else 0.0) + near(li), li, "MRP read as ${m.value.trim()}")
                }
            }
            if (misread.isNotEmpty()) continue
            // 3) Weak anchor: currency symbol without "MRP"; a price badge may put "Rs." and "10/-" on two lines
            var found = false
            for (m in CURRENCY_ANCHOR.findAll(line)) {
                val before = line.substring(0, m.range.first)
                if (NOT_MRP_CONTEXT.containsMatchIn(before.takeLast(25))) continue
                val rest = line.substring(m.range.last + 1)
                val num = firstPriceAfter(rest, strictUnit = true, rejected = rejected)
                if (num != null) {
                    cands += PriceCandidate(num, 0.5 + (if (hasIncl) 0.15 else 0.0) + near(li), li, "currency sign"); found = true
                } else if (rest.none { it.isLetterOrDigit() } && li + 1 < lines.size) {
                    firstPriceAfter(lines[li + 1], allowUnanchoredStart = true, strictUnit = true, rejected = rejected)?.let {
                        cands += PriceCandidate(it, 0.5 + near(li), li, "currency sign, value on next line"); found = true
                    }
                }
            }
            if (found) continue
            // 4) "10/-" is itself an Indian price mark, even without Rs / ₹ / MRP
            for (m in SLASH_DASH_PRICE.findAll(line)) {
                if (NOT_MRP_CONTEXT.containsMatchIn(line.substring(0, m.range.first).takeLast(25))) continue
                val v = m.groupValues[1].toDoubleOrNull() ?: continue
                if (v < 1.0 || v > 10000.0) { rejected += m.groupValues[1] to "outside ₹1 to ₹10,000"; continue }
                cands += PriceCandidate(v, 0.55 + near(li), li, "price written as ${m.value.replace(" ", "")}")
            }
        }
        return MrpScan(cands, rejected)
    }

    private val SLASH_DASH_PRICE = Regex("""(?<![\d.,])(\d{1,5}(?:\.\d{1,2})?)\s*/\s*-""")

    /** First plausible price in [s]; rejects per-unit prices ("Rs 0.09/g"), phone numbers and impossible values. */
    private fun firstPriceAfter(
        s0: String, allowUnanchoredStart: Boolean = false, strictUnit: Boolean = false,
        rejected: MutableList<Pair<String, String>>? = null,
    ): Double? {
        val s = SPLIT_PRICE.replace(s0) { m -> m.groupValues[1] + m.groupValues[2] + m.groupValues[3] }
        val m = PRICE_NUM.find(s) ?: return null
        val gap = s.substring(0, m.range.first)
        // Only filler allowed between anchor and number: ":", ".", "RS", "₹", "(INCL. OF ALL TAXES)", spaces.
        val filler = gap.replace(Regex("""INCL\w*\.?|OF|ALL|TAX(?:ES)?|INCLUSIVE|\bRS\b\.?|₹|INR|[\s:.()\-*/=]"""), "")
        if (filler.length > (if (allowUnanchoredStart) 2 else 4) || gap.length > 45) return null
        if (NOT_MRP_CONTEXT.containsMatchIn(gap)) return null
        val rest = s.substring(m.range.last + 1)
        // Digits running into OCR garbage ("₹ 2__.00", "4?.00") are unreadable — never guess
        if (Regex("""^[_?#*~]""").containsMatchIn(rest)) return null
        if (strictUnit && m.groupValues[2].isEmpty() && UNIT_AFTER.containsMatchIn(rest)) return null
        // Number directly followed by a weight unit is a quantity, not a price ("500G")
        if (Regex("""^\s*(?:G|GM|GMS|KG|ML|L|LTR)\b""").containsMatchIn(rest)) return null
        // Phone / toll-free number: more digit groups follow ("1800 266 0123", "1800-22-6000")
        if (Regex("""^[\s\-]\d{2,}[\s\-]\d{3,}""").containsMatchIn(rest)) {
            rejected?.add(m.groupValues[1] to "phone number"); return null
        }
        val raw = m.groupValues[1]
        val v = (if (Regex("""^\d{1,2},\d{3}""").containsMatchIn(raw)) raw.replace(",", "") else raw.replace(',', '.'))
            .toDoubleOrNull() ?: return null
        if (v < 1.0 || v > 10000.0) {
            if (v > 0.0) rejected?.add(raw to "outside ₹1 to ₹10,000")
            return null
        }
        return v
    }

    // ── Net quantity ─────────────────────────────────────────────────────────

    private val QTY = Regex(
        """(\d+(?:[.,]\d+)?)\s*(KGS?|KILO(?:GRAM)?S?|GMS?|GRAMS?|GR|G|MLS?|MILLILITRES?|LTRS?|LITRES?|LITERS?|LT|L)(?![A-Z])"""
    )
    private val NET_ANCHOR = Regex("""NETT?\s*\.?\s*(?:WT|WEIGHT|QTY|QUANTITY|CONTENTS?|VOL(?:UME)?|MASS)|NET\b""")
    private val NUTRITION = Regex("""NUTRI|ENERGY|PROTEIN|FAT|CARBO|SUGARS?\b|SODIUM|KCAL|FIBRE|FIBER|SERVING|CALCIUM|IRON|VITAMIN|CHOLESTEROL""")

    // "20g EXTRA", "FREE 20 g", "+20g", "BONUS 10g", "20g MORE" are offers, not the pack size
    private val CLAIM_AFTER = Regex("""^\s*(?:FREE|EXTRA|BONUS|MORE)\b""")
    private val CLAIM_BEFORE = Regex("""(?:FREE|EXTRA|BONUS|\+)\s*$""")

    /** The pack size of every line that has one (first quantity on the line), with its confidence. */
    fun qtyCandidates(text: String): List<Field<String>> {
        val out = mutableListOf<Field<String>>()
        for (raw in text.lines()) {
            val line = fixDigits(raw).uppercase()
            val anchored = NET_ANCHOR.containsMatchIn(line)
            if (!anchored && NUTRITION.containsMatchIn(line)) continue
            for (m in QTY.findAll(line)) {
                val before = line.substring(0, m.range.first).takeLast(12)
                if (Regex("""PER\s*$|/\s*$|X\s*$""").containsMatchIn(before)) continue
                if (CLAIM_AFTER.containsMatchIn(line.substring(m.range.last + 1)) || CLAIM_BEFORE.containsMatchIn(before)) continue
                val norm = normalizeQty(m.value) ?: continue
                out += Field(norm, if (anchored) 0.9 else 0.55)
                break  // first qty on a line is the main one ("1 kg (1000 g)")
            }
        }
        return out
    }

    /** Best pack size; two different sizes read equally well → kept, but weak (yellow, both offered). */
    fun parseNetQty(text: String): Field<String> {
        val cands = qtyCandidates(text)
        val best = cands.maxByOrNull { it.confidence } ?: return Field.none()
        val tie = cands.any { it.value != best.value && it.confidence >= best.confidence }
        return if (tie) Field(best.value, minOf(best.confidence, 0.5)) else best
    }

    /** "500gm" → "500 g", "1 Ltr" → "1 L", "1,5kg" → "1.5 kg", "250 ML" → "250 ml". Null if not a quantity. */
    fun normalizeQty(s: String): String? {
        val m = QTY.find(fixDigits(s).uppercase().trim()) ?: return null
        val num = m.groupValues[1].replace(',', '.').toDoubleOrNull() ?: return null
        val unit = when (m.groupValues[2]) {
            "KG", "KGS", "KILO", "KILOS", "KILOGRAM", "KILOGRAMS" -> "kg"
            "G", "GM", "GMS", "GR", "GRAM", "GRAMS" -> "g"
            "ML", "MLS", "MILLILITRE", "MILLILITRES" -> "ml"
            else -> "L"
        }
        // A shop pack is between a 1 g / 1 ml sachet and a 50 kg / 50 L sack; anything else is a misread
        val max = if (unit == "kg" || unit == "L") 50.0 else 50000.0
        if (num <= 0 || num > max || ((unit == "g" || unit == "ml") && num < 1)) return null
        val n = if (num == Math.floor(num)) num.toLong().toString() else num.toString().trimEnd('0').trimEnd('.')
        return "$n $unit"
    }

    // ── Dates ────────────────────────────────────────────────────────────────

    private val MFG_ANCHOR = Regex(
        """MFG|MFD|MANUFACTUR\w*|\bDOM\b|PKD|PACKED|PACKING|PKG|DATE\s*OF\s*(?:MFG|MANUFACTURE|PACKING|PACKAGING)|\bMF\b"""
    )
    private val EXP_ANCHOR = Regex("""EXP\w*|BEST\s*BEFORE|\bBB\b|\bBBE\b|USE\s*BY|USE\s*BEFORE|CONSUME\s*BEFORE""")
    private const val MON =
        "(?:JAN(?:UARY)?|FEB(?:RUARY)?|MAR(?:CH)?|APR(?:IL)?|MAY|JUNE?|JULY?|AUG(?:UST)?|SEPT?(?:EMBER)?|OCT(?:OBER)?|NOV(?:EMBER)?|DEC(?:EMBER)?)(?![A-Z])"
    private val D_DMY = Regex("""(?<!\d)(\d{1,2})\s?[./\-]\s?(\d{1,2})\s?[./\-]\s?(\d{4}|\d{2})(?!\d)""")
    private val D_DMONY = Regex("""(?<!\d)(\d{1,2})\s*[./\-]?\s*($MON)\s*[./,'\-]?\s*(\d{4}|\d{2})(?!\d)""")
    private val D_MONY = Regex("""\b($MON)\s*[./,'\-]?\s*(\d{4}|\d{2})(?!\d)""")
    private val D_MY = Regex("""(?<![\d.])(\d{1,2})\s?[./\-]\s?(\d{4}|\d{2})(?![\d.])""")
    private val RELATIVE = Regex(
        """(?:BEST\s*BEFORE|USE\s*(?:BY|WITHIN|BEFORE)|EXPIRY|SHELF\s*LIFE)[^\d]{0,25}(\d{1,2})\s*(MONTHS?|MTHS?|DAYS?|YEARS?|YRS?)"""
    )

    private enum class Kind { MFG, EXP }
    private data class DateHit(val date: LocalDate, val monthOnly: Boolean, val pos: Int)

    /** Returns (mfg, expiry) as ISO strings. */
    // Inkjet printers space out characters: "1 2 . 0 3 . 2 0 2 6" (single chars, single spaces)
    private val SPACED_CHARS = Regex("""(?<![\d./\-])[\d./\-](?: [\d./\-]){3,}(?![\d./\-])""")
    private val DATE_ANCHOR = "(?:${MFG_ANCHOR.pattern}|${EXP_ANCHOR.pattern})"
    // "MFD 01 26" / "USE BY 12 03 26": space used as the date separator right after an anchor
    private val ANCHOR_DMY_SPACED = Regex("""($DATE_ANCHOR[\s:.\-]*)(\d{1,2}) (\d{1,2}) (\d{4}|\d{2})(?![\d./\-])""")
    private val ANCHOR_MY_SPACED = Regex("""($DATE_ANCHOR[\s:.\-]*)(\d{1,2}) (\d{4}|\d{2})(?![\d./\-])""")

    /**
     * Only on lines that carry an MFG/EXP/BEST BEFORE anchor: collapse spaces between digits and date
     * separators, and treat "MM YY" / "DD MM YY" right after an anchor as a date. Other lines are untouched.
     */
    fun normalizeSpacedDates(line: String): String {
        if (!MFG_ANCHOR.containsMatchIn(line) && !EXP_ANCHOR.containsMatchIn(line)) return line
        var l = SPACED_CHARS.replace(line) { m ->
            val v = m.value.replace(" ", "")
            if (Regex("""[./\-]""").containsMatchIn(v)) v else m.value   // need a separator to be a date
        }
        l = ANCHOR_DMY_SPACED.replace(l) { m -> "${m.groupValues[1]}${m.groupValues[2]}/${m.groupValues[3]}/${m.groupValues[4]}" }
        l = ANCHOR_MY_SPACED.replace(l) { m -> "${m.groupValues[1]}${m.groupValues[2]}/${m.groupValues[3]}" }
        return l
    }

    fun parseDates(text: String): Pair<Field<String>, Field<String>> {
        val lines = text.lines().map { normalizeSpacedDates(fixDigits(it).uppercase()) }
        var mfg: Field<LocalDate> = Field.none()
        var exp: Field<LocalDate> = Field.none()
        val unanchored = mutableListOf<LocalDate>()

        for ((li, line) in lines.withIndex()) {
            val anchors = (MFG_ANCHOR.findAll(line).map { it.range.last + 1 to Kind.MFG } +
                    EXP_ANCHOR.findAll(line).map { it.range.last + 1 to Kind.EXP })
                .sortedBy { it.first }.toList()
            val datesHere = findDates(line)

            if (anchors.isEmpty()) {
                unanchored += datesHere.map { it.date }
                continue
            }
            val pendingKinds = mutableListOf<Kind>()
            for ((idx, a) in anchors.withIndex()) {
                val (pos, kind) = a
                val nextAnchor = anchors.getOrNull(idx + 1)?.first ?: line.length
                val hit = datesHere.firstOrNull { it.pos >= pos && it.pos < nextAnchor + 1 && it.pos - pos <= 30 }
                if (hit == null) {
                    if (!(kind == Kind.EXP && RELATIVE.containsMatchIn(line))) pendingKinds += kind
                    continue
                }
                val d = if (hit.monthOnly && kind == Kind.EXP) YearMonth.from(hit.date).atEndOfMonth() else hit.date
                val conf = if (hit.monthOnly) 0.75 else 0.85
                if (kind == Kind.MFG && conf > mfg.confidence) mfg = Field(d, conf)
                if (kind == Kind.EXP && conf > exp.confidence) exp = Field(d, conf)
            }
            // Labels on this line, values on the next line (e.g. "MFD.  EXP." / "01/26 12/26")
            if (pendingKinds.isNotEmpty() && li + 1 < lines.size &&
                !MFG_ANCHOR.containsMatchIn(lines[li + 1]) && !EXP_ANCHOR.containsMatchIn(lines[li + 1])) {
                val nextDates = findDates(lines[li + 1])
                if (nextDates.size >= pendingKinds.size) {
                    for ((k, kind) in pendingKinds.withIndex()) {
                        val hit = nextDates[k]
                        val d = if (hit.monthOnly && kind == Kind.EXP) YearMonth.from(hit.date).atEndOfMonth() else hit.date
                        if (kind == Kind.MFG && mfg.value == null) mfg = Field(d, 0.65)
                        if (kind == Kind.EXP && exp.value == null) exp = Field(d, 0.65)
                    }
                }
            }
        }

        // "Best before 9 months from manufacture/packing"
        if (exp.value == null && mfg.value != null) {
            val rel = RELATIVE.find(lines.joinToString(" "))
            if (rel != null) {
                val n = rel.groupValues[1].toLong()
                val u = rel.groupValues[2]
                val base = mfg.value!!
                val d = when {
                    u.startsWith("D") -> base.plusDays(n)
                    u.startsWith("Y") -> base.plusYears(n)
                    else -> base.plusMonths(n)
                }
                exp = Field(d, minOf(mfg.confidence, 0.7))
            }
        }

        // Inkjet stamps often lose their labels: exactly two bare dates → earlier = mfg, later = exp.
        if (mfg.value == null && exp.value == null) {
            val ds = unanchored.distinct().sorted()
            if (ds.size == 2) { mfg = Field(ds[0], 0.35); exp = Field(ds[1], 0.35) }
        }

        // Sanity: expiry must be after mfg
        if (mfg.value != null && exp.value != null && !exp.value!!.isAfter(mfg.value)) {
            exp = Field(exp.value, 0.2)
        }
        fun iso(f: Field<LocalDate>) = Field(f.value?.toString(), f.confidence)
        return iso(mfg) to iso(exp)
    }

    private fun findDates(line: String): List<DateHit> {
        val hits = mutableListOf<DateHit>()
        val used = mutableListOf<IntRange>()
        fun free(r: IntRange) = used.none { it.first <= r.last && r.first <= it.last }

        for (m in D_DMONY.findAll(line)) {
            val d = mkDate(m.groupValues[3], monthIndex(m.groupValues[2]), m.groupValues[1].toInt()) ?: continue
            hits += DateHit(d, false, m.range.first); used += m.range
        }
        for (m in D_DMY.findAll(line)) {
            if (!free(m.range)) continue
            val d = mkDate(m.groupValues[3], m.groupValues[2].toInt(), m.groupValues[1].toInt()) ?: continue
            hits += DateHit(d, false, m.range.first); used += m.range
        }
        for (m in D_MONY.findAll(line)) {
            if (!free(m.range)) continue
            val d = mkDate(m.groupValues[2], monthIndex(m.groupValues[1]), 1) ?: continue
            hits += DateHit(d, true, m.range.first); used += m.range
        }
        for (m in D_MY.findAll(line)) {
            if (!free(m.range)) continue
            val d = mkDate(m.groupValues[2], m.groupValues[1].toInt(), 1) ?: continue
            hits += DateHit(d, true, m.range.first); used += m.range
        }
        return hits.sortedBy { it.pos }
    }

    private fun monthIndex(m: String): Int =
        listOf("JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC")
            .indexOf(m.take(3)) + 1

    private fun mkDate(yearStr: String, month: Int, day: Int): LocalDate? {
        val y = yearStr.toInt().let { if (yearStr.length == 2) 2000 + it else it }
        if (y !in 2015..2045 || month !in 1..12) return null
        return try { LocalDate.of(y, month, day) } catch (_: Exception) { null }
    }

    // ── Brand and product name (front photo) ─────────────────────────────────

    /** Canonical brand spelling, matched case-insensitively at word boundaries. Longest first. */
    val KNOWN_BRANDS: List<String> = listOf(
        "Parle-G", "Parle", "Britannia", "Sunfeast", "ITC", "Tata Sampann", "Tata", "Fortune", "Saffola", "Dhara",
        "Gemini", "Sundrop", "Gold Winner", "Colgate", "Pepsodent", "Close Up", "Closeup", "Sensodyne", "Dabur",
        "Patanjali", "Himalaya", "Lux", "Lifebuoy", "Dove", "Pears", "Santoor", "Cinthol", "Godrej", "Dettol",
        "Medimix", "Hamam", "Margo", "Rexona", "Liril", "Fiama", "Vivel", "Clinic Plus", "Sunsilk",
        "Head & Shoulders", "Pantene", "Chik", "Nyle", "Red Label", "Brooke Bond", "Taj Mahal", "Wagh Bakri",
        "Society", "Girnar", "Everest", "MDH", "Badshah", "Catch", "Ramdev", "Suhana", "Haldiram's",
        "Haldiram", "Bikaji", "Maggi", "Yippee", "Nestle", "Amul", "Aashirvaad", "Pillsbury", "Rin",
        "Surf Excel", "Tide", "Ariel", "Wheel", "Ghadi", "Nirma", "Vim", "Exo", "Pril", "Harpic", "Lizol",
        "Kissan", "Kurkure", "Lay's", "Bingo", "Good Day", "Marie Gold", "Hide & Seek", "Bourbon", "Monaco",
        "Krackjack", "Oreo", "Cadbury", "Horlicks", "Bournvita", "Boost", "Complan", "Kellogg's", "Nivea",
        "Pond's", "Vaseline", "Parachute", "Bajaj", "Nihar", "Vicco", "Meswak", "Comfort", "Nescafe", "Bru",
        "Patanjali", "Priya", "Chitale", "Pravin", "Ruchi", "Mother Dairy", "Saffola", "Emami", "Boroline",
    ).distinct().sortedByDescending { it.length }

    private val AMBIGUOUS_BRANDS = setOf(
        "Society", "Catch", "Boost", "Comfort", "Wheel", "Bourbon", "Tide", "Priya", "Exo", "Rin", "Vim", "Bru", "Dove",
    )

    private val FRONT_NOISE = Regex(
        """NET\b|\bWT\b|MRP|M\.R\.P|\bRS\b|₹|%|FREE|\bNEW\b|OFFER|PACK\s*OF|\bVEG\b|KCAL|ENERGY|PROTEIN|INGREDIENT|""" +
        """NUTRI|FSSAI|\bLIC\b|MFD|MFG|\bEXP|WWW|\.COM|@|\bSAVE\b|EXTRA|\bONLY\b|""" +
        """SINCE\s*\d|\bNO\.?\s*1\b|\bWITH\b|CONTAINS|MADE\s*WITH|""" +
        """GERM|PROTECTION|\bFOR\b|\bAND\b.*\bAND\b|""" +
        // back/side-of-pack text: company lines, storage and usage instructions
        """\bPVT\b|\bLTD\b|LIMITED|MARKETED|MANUFACTURED|\bPACKED\b|CUSTOMER|\bCARE\b|\bPLOT\b|\bROAD\b|""" +
        """\bDIST\b|\bSTORE\b|\bKEEP\b|\bDRY\b|\bPLACE\b|DIRECTION|WARNING|CAUTION|ALLERG|\bUSE\b|BATCH"""
    )
    /**
     * Marketing words make a line noise only when the whole line is marketing ("Tasty & Delicious"):
     * they are also part of brand names ("Tasty Nuts", "Healthy Choice").
     */
    private val MARKETING_WORDS = setOf(
        "TASTY", "DELICIOUS", "HEALTHY", "GOODNESS", "IMPROVED", "BEST", "TRUSTED", "ZERO", "YUMMY", "CRUNCHY",
        "CRISPY", "SUPER", "FRESH", "RICH", "PURE", "REAL", "TASTE", "QUALITY", "PREMIUM",
        // glue
        "&", "AND", "IN", "OF", "THE", "A", "SO", "VERY", "MORE", "TOO",
    )

    private fun isMarketingOnly(s: String): Boolean {
        val ws = s.uppercase().split(Regex("""[^A-Z&]+""")).filter { it.isNotEmpty() }
        return ws.isNotEmpty() && ws.all { it in MARKETING_WORDS } &&
            ws.any { it in setOf("TASTY", "DELICIOUS", "HEALTHY", "GOODNESS", "IMPROVED", "BEST", "TRUSTED", "ZERO", "YUMMY") }
    }

    private val PRODUCT_WORDS = Regex(
        """BISCUITS?|COOKIES?|OIL|SOAP|SHAMPOO|CONDITIONER|TEA|COFFEE|SALT|POWDER|MASALA|ATTA|FLOUR|DAL|RICE|""" +
        """TOOTHPASTE|PASTE|DETERGENT|NOODLES|GHEE|SUGAR|JAM|SAUCE|KETCHUP|CHIPS|BAR|CREAM|LOTION|WASH|LIQUID|""" +
        """HANDWASH|BESAN|RAVA|SUJI|POHA|CHILLI|HALDI|TURMERIC|CORIANDER|DHANIA|JEERA|CUMIN|GARAM|HING|""" +
        """MUSTARD|SUNFLOWER|GROUNDNUT|SOYABEAN|COCONUT|HAIR|DISHWASH|CLEANER|GLUCOSE|CRACKERS?|WAFERS?|RUSK|""" +
        """MILK|CHOCOLATE|NAMKEEN|BHUJIA|PICKLE|PAPAD|VERMICELLI|SEVAI|DRINK|JUICE|AGARBATTI|MATCHBOX"""
    )

    private fun cleanLine(s: String) =
        s.replace(Regex("""[®™©]"""), "")
            .replace(Regex("""\b100\s*%"""), " ")   // "100% Pure Coconut Oil" is a name, not an offer
            .replace(Regex("""\s+"""), " ").trim()

    private fun findKnownBrand(text: String): String? {
        val up = " " + text.uppercase().replace(Regex("""[^A-Z0-9&'\- ]"""), " ").replace(Regex("""\s+"""), " ") + " "
        val compact = up.replace(" ", "")
        for (b in KNOWN_BRANDS) {
            val key = b.uppercase()
            if (Regex("""(?<![A-Z0-9])${Regex.escape(key)}(?![A-Z0-9])""").containsMatchIn(up)) return b
            // OCR often drops the hyphen / apostrophe ("PARLE G", "HALDIRAMS")
            val loose = key.replace("-", " ").replace("'", "")
            if (loose != key && Regex("""(?<![A-Z0-9])${Regex.escape(loose)}(?![A-Z0-9])""").containsMatchIn(up)) return b
            // Multi-word brands printed without spaces ("HEAD&SHOULDERS", "REDLABEL")
            if ((key.contains(' ') || key.contains('&')) && compact.contains(key.replace(" ", ""))) return b
        }
        return null
    }

    private fun hasType(s: String) = PRODUCT_WORDS.containsMatchIn(s.uppercase())
    private fun words(s: String) = s.split(" ").filter { it.isNotEmpty() }.size

    fun parseBrandAndName(front: List<Line>, back: List<Line>): Pair<Field<String>, Field<String>> {
        // OCR spelling fixes first ("BRITANIA" → "BRITANNIA", "Crearn" → "Cream"), so brands are recognised
        val suspicious = mutableListOf<String>()
        var cands = front.map { l ->
            val fix = NameSpell.correctLine(cleanLine(l.text))
            suspicious += fix.suspicious
            l.copy(text = fix.text)
        }.filter { l ->
                val letters = l.text.count { it.isLetter() }
                letters >= 2 && letters >= l.text.length / 2 && !FRONT_NOISE.containsMatchIn(l.text.uppercase()) &&
                    !isMarketingOnly(l.text)
            }

        // 1) Brand: a known brand on the front beats geometry; then the company line on the back.
        var brandF: Field<String> = Field.none()
        val frontBrand = cands.firstNotNullOfOrNull { findKnownBrand(it.text) }
        if (frontBrand != null) {
            brandF = Field(frontBrand, 0.75)
        } else {
            findKnownBrand(back.joinToString(" ") { NameSpell.correctLine(it.text).text })
                ?.takeIf { it !in AMBIGUOUS_BRANDS }
                ?.let { brandF = Field(it, 0.45) }
        }
        // Unknown brand: the tallest 1–2 word line without product words is a weak guess,
        // but only when another line is left over to be the product name.
        if (brandF.value == null && cands.size >= 2) {
            val maxH = cands.maxOf { it.height }
            val tall = cands.filter { words(it.text) <= 2 && !hasType(it.text) }.maxByOrNull { it.height }
            if (tall != null && tall.height > 0 && tall.height >= maxH * 0.8) {
                brandF = Field(titleCase(tall.text), 0.3)
                cands = cands - tall
            }
        }

        // 2) Strip the brand out of every line ("PARLE-G GLUCOSE BISCUITS" → "GLUCOSE BISCUITS").
        val brand = brandF.value
        val nameCands = cands.map { l ->
            var t = l.text
            if (brand != null) {
                for (v in listOf(brand, brand.replace("-", " "), brand.replace("'", ""), brand.replace(" ", ""))) {
                    t = t.replace(Regex("""(?<![A-Za-z])${Regex.escape(v)}(?![A-Za-z])""", RegexOption.IGNORE_CASE), " ")
                }
                t = t.replace(Regex("""\s+"""), " ").trim()
            }
            l.copy(text = t)
        }.filter { it.text.count { c -> c.isLetter() } >= 3 }

        // 3) Name = tallest short line (taglines with 5+ words count half);
        //    if it has no product-type word, append the first short line that does ("Red Label" + "Tea").
        val top = nameCands.maxByOrNull { it.height * (if (words(it.text) <= 4) 1.0 else 0.5) }
            ?: return brandF to Field.none()
        var text = top.text
        if (!hasType(text)) {
            nameCands.filter { it !== top && hasType(it.text) && words(it.text) <= 4 }
                .maxByOrNull { it.height }
                ?.let { text = "$text ${it.text}" }
        }
        // A word that still looks misread ("Exce1") and could not be fixed safely: keep it, but ask to check
        val unsure = suspicious.any { w -> text.contains(w, ignoreCase = true) }
        return brandF to Field(titleCase(text), if (unsure) 0.3 else if (hasType(text)) 0.5 else 0.3)
    }

    private fun titleCase(s: String) = s.lowercase().split(" ").joinToString(" ") { w ->
        w.replaceFirstChar { it.uppercase() }
    }

    // ── Devanagari name ──────────────────────────────────────────────────────

    fun parseDevanagariName(lines: List<Line>): Field<String> {
        val dev = Regex("""[ऀ-ॿ]""")
        val best = lines
            .map { it.copy(text = it.text.replace(Regex("""[^ऀ-ॿ\s\-]"""), " ").replace(Regex("""\s+"""), " ").trim()) }
            .filter { l -> dev.findAll(l.text).count() >= 3 && l.text.split(" ").size <= 5 }
            .filter { l -> !Regex("""मूल्य|किंमत|कीमत|वजन|सामग्री|उत्पादक|पोषण|शुद्ध|निर्मित""").containsMatchIn(l.text) }
            .maxByOrNull { it.height }
            ?: return Field.none()
        return Field(best.text, 0.4)
    }

    // ── Barcode ──────────────────────────────────────────────────────────────

    /** GTIN mod-10 check (EAN-8, UPC-A, EAN-13). */
    fun isValidGtin(code: String): Boolean {
        if (!code.all { it.isDigit() } || code.length !in setOf(8, 12, 13, 14)) return false
        val digits = code.map { it - '0' }
        val body = digits.dropLast(1).reversed()
        val sum = body.withIndex().sumOf { (i, d) -> if (i % 2 == 0) d * 3 else d }
        return (10 - sum % 10) % 10 == digits.last()
    }

    /** UPC-E (8 digits) → UPC-A (12 digits), or null if not a valid UPC-E shape. */
    fun upcEtoA(e: String): String? {
        if (e.length != 8 || !e.all { it.isDigit() } || (e[0] != '0' && e[0] != '1')) return null
        val d = e.substring(1, 7)
        val body = when (d[5]) {
            '0', '1', '2' -> "${d[0]}${d[1]}${d[5]}0000${d[2]}${d[3]}${d[4]}"
            '3' -> "${d[0]}${d[1]}${d[2]}00000${d[3]}${d[4]}"
            '4' -> "${d[0]}${d[1]}${d[2]}${d[3]}00000${d[4]}"
            else -> "${d[0]}${d[1]}${d[2]}${d[3]}${d[4]}0000${d[5]}"
        }
        return "${e[0]}$body${e[7]}"
    }

    /** Validate a decoded barcode. ML Kit format names: EAN_13, EAN_8, UPC_A, UPC_E; others are not checked. */
    fun isVerifiedBarcode(raw: String, format: String): Boolean = when (format) {
        "EAN_13", "EAN_8", "UPC_A" -> isValidGtin(raw)
        "UPC_E" -> upcEtoA(raw)?.let { isValidGtin(it) } ?: false
        else -> false
    }

    /** Fallback when ML Kit cannot decode the bars: the human-readable digits printed under the barcode. */
    fun findBarcodeInText(text: String): Field<String> {
        val skip = Regex("""FSSAI|LIC|PH\b|PHONE|TEL|CARE|TOLL|BATCH|B\.?\s?NO|LOT|CIN|GST""", RegexOption.IGNORE_CASE)
        var best: Field<String> = Field.none()
        for (raw in text.lines()) {
            if (skip.containsMatchIn(raw)) continue
            val groups = Regex("""\d+""").findAll(fixDigits(raw)).toList()
            for (a in groups.indices) {
                var code = ""
                for (b in a until groups.size) {
                    if (b > a && groups[b].range.first - groups[b - 1].range.last != 2) break  // single separator only
                    code += groups[b].value
                    if (code.length > 13) break
                    if (code.length !in setOf(8, 12, 13) || !isValidGtin(code)) continue
                    val conf = if (code.length == 13 && code.startsWith("890")) 0.6 else 0.45
                    if (conf > best.confidence) best = Field(code, conf)
                }
            }
        }
        return best
    }
}
