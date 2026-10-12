package com.nexuspos.app

/**
 * Conservative spelling fixes for product names read by OCR. Pure Kotlin (unit-tested).
 *
 * A word is changed only when
 *  - it is not a known word itself, and
 *  - it becomes a known word by undoing common OCR confusions (rn→m, vv→w, cl→d, 1→l/i, 0→o, 5→s, l↔i, c→e), or
 *  - exactly one known word is within a small edit distance (1 for 6–7 letters, 2 for 8+; swaps count 1),
 *    starting with the same (or an OCR-confusable) letter, and the word is not next to a known food word.
 * Anything else is kept as read. The shop's own item names and learned corrections are added on the web side
 * (itemNames.ts), because the inventory lives there.
 */
object NameSpell {

    /** Product, type and variant words printed on Indian packs (lowercase). Brand words come from LabelParser. */
    private val PRODUCT_WORDS = """
        biscuit biscuits cookie cookies cracker crackers cream creamy wafer wafers rusk toast cake cakes bread bun
        chocolate chocolatey choco cocoa candy toffee sandwich glucose gluco marie digestive cashew butter
        oil oils refined sunflower groundnut mustard soyabean soybean coconut olive sesame rice bran palm kachi ghani
        ghee vanaspati milk powder dairy whitener curd paneer cheese yogurt
        tea leaf leaves coffee instant chai dust granules
        salt sugar jaggery honey jam sauce ketchup pickle papad vinegar
        masala garam chilli chili turmeric haldi coriander dhania cumin jeera hing asafoetida pepper cardamom
        elaichi clove cinnamon fenugreek methi ajwain kasuri sambar rasam biryani pav bhaji chhole chana chaat
        atta flour besan rava suji sooji maida poha dal toor tuvar moong masoor urad chana rajma
        noodles pasta vermicelli sevai macaroni oats cornflakes muesli
        namkeen bhujia sev mixture chips crisps wafers puffs
        soap shampoo conditioner toothpaste toothbrush paste dental detergent liquid bar cake handwash
        dishwash cleaner lotion talc talcum deodorant hair face body wash gel scrub balm ointment tablet
        capsule syrup drops spray agarbatti incense matchbox candle
        lemon lime orange mango strawberry vanilla rose sandal sandalwood neem tulsi aloe vera saffron almond
        badam pista elaichi kesar mint pudina ginger garlic onion tomato potato aloo
        original classic premium special gold silver natural pure fresh active total strong soft smooth silky
        shine black white extra super lite light rich royal gentle mild herbal ayurvedic vitamin protein
        anti dandruff germ protection care daily family pack value easy quick instant minute
        teeth whitening sensitive fluoride charcoal clove
        purifying moisturising moisturizing nourishing glow radiance fairness beauty
        unpolished polished whole split roasted salted plain spicy tangy sweet hot
        kesh kanti dant kanti munch bikis
    """.trim().split(Regex("""\s+""")).toSet()

    /** Vocabulary: product words plus every word of the known brands ("tata sampann" → tata, sampann). */
    val VOCAB: Set<String> by lazy {
        PRODUCT_WORDS + LabelParser.KNOWN_BRANDS.flatMap { b ->
            b.lowercase().split(Regex("""[\s&]+""")).filter { it.isNotEmpty() }.flatMap { listOf(it, norm(it)) }
        }
    }

    /** lowercase, apostrophes and hyphens removed ("haldiram's" → "haldirams") */
    private fun norm(w: String) = w.lowercase().replace(Regex("""['’\-]"""), "")

    // Longest spelling wins, so "haldirams" maps back to "haldiram's"
    private val NORM_TO_WORD: Map<String, String> by lazy { byNorm(VOCAB) }
    private fun byNorm(words: Set<String>) = words.sortedBy { it.length }.associateBy { norm(it) }

    /** Single-character OCR confusions (read → meant). */
    private val CHAR_SWAPS: Map<Char, List<Char>> = mapOf(
        '1' to listOf('l', 'i'), 'l' to listOf('i'), 'i' to listOf('l'), '0' to listOf('o'), 'o' to listOf('0'),
        '5' to listOf('s'), '8' to listOf('b'), '6' to listOf('g'), 'c' to listOf('e'), 'e' to listOf('c'),
        '|' to listOf('l'), 'u' to listOf('v'), 'v' to listOf('u'),
    )
    /** Multi-character OCR confusions (read → meant). */
    private val SEQ_SWAPS = listOf("rn" to "m", "vv" to "w", "cl" to "d", "ii" to "u", "li" to "h", "nn" to "m")

    data class Fix(val text: String, val changes: List<Pair<String, String>>, val suspicious: List<String>)

    private val TOKEN = Regex("""[A-Za-z0-9|'’]+""")

    /** Food / product-type words: an unknown word next to one is likely a product name ("Shing Bhujia", "Moong Dal"). */
    private val FOOD_WORDS = """
        bhujia sev namkeen mixture chivda chips wafers puffs biscuit biscuits cookies rusk cake masala dal atta
        flour besan rava poha rice oil ghee tea coffee salt sugar jaggery honey jam sauce ketchup pickle papad noodles
        vermicelli sevai chakli chikki ladoo barfi halwa peda soap shampoo cream paste powder
    """.trim().split(Regex("""\s+""")).toSet()

    /**
     * Corrects each word of [line]; keeps spaces, punctuation and the word's letter case.
     * A word right next to a known food word ("Shing Bhujia") is probably a product name the vocabulary does not know:
     * only OCR confusions are undone there, never an edit-distance guess.
     */
    fun correctLine(line: String, vocab: Set<String> = VOCAB): Fix {
        val changes = mutableListOf<Pair<String, String>>()
        val suspicious = mutableListOf<String>()
        val tokens = TOKEN.findAll(line).map { it.value.lowercase() }.toList()
        var idx = -1
        val out = TOKEN.replace(line) { m ->
            idx++
            val w = m.value
            val besideFood = tokens.getOrNull(idx - 1) in FOOD_WORDS || tokens.getOrNull(idx + 1) in FOOD_WORDS
            val fixed = correctWord(w, vocab, allowDistance = !besideFood)
            when {
                fixed != null -> { changes += w to fixed; fixed }
                looksMisread(w) -> { suspicious += w; w }
                else -> w
            }
        }
        return Fix(out, changes, suspicious)
    }

    /** Letters mixed with digit look-alikes ("Exce1", "Suns1lk"), or "rn"/"vv"/"cl" runs inside a word. */
    fun looksMisread(w: String): Boolean {
        val letters = w.count { it.isLetter() }
        if (letters < 3) return false
        val digits = w.count { it.isDigit() || it == '|' }
        return digits in 1..2 && w.any { it in "1|05" } && !Regex("""^\d+[A-Za-z]{1,3}$""").matches(w)
    }

    /** The corrected word in the case style of [w], or null when [w] is known, too short or unclear. */
    fun correctWord(w: String, vocab: Set<String> = VOCAB, allowDistance: Boolean = true): String? {
        val lower = w.lowercase()
        val n = norm(lower)
        if (n.count { it.isLetter() } < 4) return null
        if (Regex("""^\d+[a-z]{0,3}$""").matches(n)) return null         // sizes and codes: "200g", "b12"
        val normVocab = if (vocab === VOCAB) NORM_TO_WORD else byNorm(vocab)
        if (n in normVocab) return null                                   // already a known word

        // 1) Undo OCR confusions: up to two edits from the confusion tables
        val viaConfusion = confusionVariants(n).mapNotNull { normVocab[it] }.toSet()
        if (viaConfusion.size == 1) return matchCase(w, viaConfusion.first())
        if (viaConfusion.size > 1) return null

        // 2) Small edit distance to exactly one known word (6+ letters only: short words have too many neighbours)
        if (!allowDistance || n.any { it.isDigit() }) return null
        val max = when { n.length >= 8 -> 2; n.length >= 6 -> 1; else -> 0 }
        if (max == 0) return null
        var best: String? = null
        var bestD = Int.MAX_VALUE
        var tie = false
        for ((vn, word) in normVocab) {
            if (kotlin.math.abs(vn.length - n.length) > max) continue
            if (vn[0] != n[0] && CHAR_SWAPS[n[0]]?.contains(vn[0]) != true) continue
            val d = osa(n, vn, max)
            if (d < bestD) { best = word; bestD = d; tie = false } else if (d == bestD && word != best) tie = true
        }
        return if (best != null && bestD <= max && !tie) matchCase(w, best) else null
    }

    private fun confusionVariants(n: String): Set<String> {
        fun step(s: String): Set<String> {
            val out = mutableSetOf<String>()
            for ((from, to) in SEQ_SWAPS) {
                var i = s.indexOf(from)
                while (i >= 0) { out += s.substring(0, i) + to + s.substring(i + from.length); i = s.indexOf(from, i + 1) }
            }
            for ((i, c) in s.withIndex()) CHAR_SWAPS[c]?.forEach { r -> out += s.substring(0, i) + r + s.substring(i + 1) }
            return out
        }
        val one = step(n)
        return one + one.flatMap { step(it) }
    }

    /** Optimal string alignment distance (adjacent swap = 1), stops early above [max]. */
    fun osa(a: String, b: String, max: Int = Int.MAX_VALUE): Int {
        val d = Array(a.length + 1) { IntArray(b.length + 1) }
        for (i in 0..a.length) d[i][0] = i
        for (j in 0..b.length) d[0][j] = j
        for (i in 1..a.length) {
            var rowMin = Int.MAX_VALUE
            for (j in 1..b.length) {
                val cost = if (a[i - 1] == b[j - 1]) 0 else 1
                var v = minOf(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
                if (i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1]) v = minOf(v, d[i - 2][j - 2] + 1)
                d[i][j] = v
                rowMin = minOf(rowMin, v)
            }
            if (rowMin > max) return max + 1
        }
        return d[a.length][b.length]
    }

    /**
     * "BRITANIA" → "BRITANNIA", "Britania" → "Britannia", "britania" → "britannia".
     * A capitals word with a misread lowercase l / i ("TURMERlC") is still a capitals word.
     */
    private fun matchCase(original: String, word: String): String {
        val letters = original.filter { it.isLetter() }
        val upper = letters.count { it.isUpperCase() }
        return when {
            upper >= 2 && letters.filter { it.isLowerCase() }.all { it in "li" } &&
                letters.count { it.isLowerCase() } <= 1 -> word.uppercase()
            original.firstOrNull()?.isUpperCase() == true -> word.replaceFirstChar { it.uppercase() }
            else -> word
        }
    }
}
