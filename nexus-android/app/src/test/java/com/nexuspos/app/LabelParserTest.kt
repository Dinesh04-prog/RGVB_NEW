package com.nexuspos.app

import com.nexuspos.app.LabelParser.Line
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Runs on the plain JVM (no device): `gradle testDebugUnitTest`.
 *
 * Two kinds of checks:
 *  - hard assertions (checksums, unit normalizer, OCR digit fixes) — must always pass;
 *  - an accuracy table over realistic noisy OCR samples, printed to the test log, with a
 *    per-field minimum so a parser regression fails the build.
 */
class LabelParserTest {

    // ── Hard checks ──────────────────────────────────────────────────────────

    @Test fun gtinChecksums() {
        assertTrue(LabelParser.isValidGtin("8901719101038"))   // EAN-13
        assertTrue(LabelParser.isValidGtin("8901063142046"))
        assertFalse(LabelParser.isValidGtin("8901063142047"))  // last digit wrong
        assertTrue(LabelParser.isValidGtin("96385074"))        // EAN-8
        assertFalse(LabelParser.isValidGtin("96385075"))
        assertTrue(LabelParser.isValidGtin("036000291452"))    // UPC-A
        assertFalse(LabelParser.isValidGtin("036000291453"))
        assertFalse(LabelParser.isValidGtin("89010631420"))    // wrong length
        assertFalse(LabelParser.isValidGtin("89O1063142046"))  // letter
        assertEquals("012345000065", LabelParser.upcEtoA("01234565"))
        assertTrue(LabelParser.isVerifiedBarcode("01234565", "UPC_E"))
        assertTrue(LabelParser.isVerifiedBarcode("8901063142046", "EAN_13"))
        assertFalse(LabelParser.isVerifiedBarcode("8901063142047", "EAN_13"))
        assertFalse(LabelParser.isVerifiedBarcode("ABC-123", "CODE_128"))
    }

    @Test fun unitNormalizer() {
        assertEquals("500 g", LabelParser.normalizeQty("500gm"))
        assertEquals("500 g", LabelParser.normalizeQty("500 GMS"))
        assertEquals("500 g", LabelParser.normalizeQty("5OOg"))
        assertEquals("1 kg", LabelParser.normalizeQty("1 Kg"))
        assertEquals("1.5 kg", LabelParser.normalizeQty("1,5kg"))
        assertEquals("250 ml", LabelParser.normalizeQty("250 ML"))
        assertEquals("1 L", LabelParser.normalizeQty("1 Ltr"))
        assertEquals("1 L", LabelParser.normalizeQty("1ltr"))
        assertEquals("1 L", LabelParser.normalizeQty("1 Litre"))
        assertEquals("100 g", LabelParser.normalizeQty("100 grams"))
        assertNull(LabelParser.normalizeQty("Rs 45"))
    }

    @Test fun ocrDigitFixes() {
        assertEquals("M.R.P Rs. 45.00", LabelParser.fixDigits("M.R.P Rs. 4S.00"))
        assertEquals("EXP 03/2027", LabelParser.fixDigits("EXP O3/2O27"))
        assertEquals("Net Wt 100g", LabelParser.fixDigits("Net Wt l00g"))
        assertEquals("Rs45", LabelParser.fixDigits("Rs45"))
        assertEquals("1ltr", LabelParser.fixDigits("1ltr"))
        assertEquals("SOAP B.No", LabelParser.fixDigits("SOAP B.No"))
    }

    @Test fun mrpIgnoresUnitPriceAndOffers() {
        assertEquals(45.0, LabelParser.parseMrp("Unit sale price Rs 0.45 per g\nMRP Rs.45/-").value!!, 0.001)
        assertEquals(30.0, LabelParser.parseMrp("SPECIAL OFFER PRICE ₹ 25\nMRP ₹ 30.00").value!!, 0.001)
        assertEquals(45.0, LabelParser.parseMrp("M.R.P. ₹ 45.00 (incl. of all taxes)").value!!, 0.001)
        assertEquals(1099.0, LabelParser.parseMrp("MRP ₹ 1,099.00").value!!, 0.001)
        assertNull(LabelParser.parseMrp("Net Wt 500 g\nBatch No 2512").value)
    }

    @Test fun relativeBestBefore() {
        val (mfg, exp) = LabelParser.parseDates("PKD: 12/01/2026\nBest before 9 months from the date of manufacture")
        assertEquals("2026-01-12", mfg.value)
        assertEquals("2026-10-12", exp.value)
    }

    @Test fun neverInventsDates() {
        val (mfg, exp) = LabelParser.parseDates("Best before 6 months from packaging")
        assertNull(mfg.value)
        assertNull(exp.value)
    }

    // ── Accuracy table ───────────────────────────────────────────────────────

    private class Sample(
        val id: String,
        val front: List<Line>,
        val back: String,
        val mrp: Double?,
        val qty: String?,
        val mfg: String?,
        val exp: String?,
        val brand: String?,
        val nameWords: List<String>?,  // all must appear in the parsed name (case-insensitive)
        val barcode: String?,
    )

    /** "60|PARLE-G" → Line(text="PARLE-G", height=60), top increasing in list order. */
    private fun f(vararg rows: String) = rows.mapIndexed { i, r ->
        val (h, t) = r.split("|", limit = 2)
        Line(t, h.toInt(), i * 50)
    }

    private val samples = listOf(
        Sample("biscuit-parleg", f("60|Parle-G", "30|Original Gluco Biscuits", "14|Rich in energy & taste"),
            "Parle Products Pvt. Ltd.\nM.R.P Rs. 1O.OO (Incl. of all taxes)\nNet Wt. 250g e\nPKD: 12/01/2026\nBest before 6 months from packaging\n8 901719 1O1038",
            10.0, "250 g", "2026-01-12", "2026-07-12", "Parle-G", listOf("gluco", "biscuits"), "8901719101038"),
        Sample("biscuit-goodday", f("40|BRITANNIA", "58|Good Day", "24|Cashew Cookies"),
            "MRP ₹ 3O/- (Inclusive of all taxes)\nNet Wt: 75 g\nUnit Sale Price: Rs. 0.40 per g\nMFD: 03/2026  EXP: 08/2026\nBritannia Industries Limited\n8901063 142046",
            30.0, "75 g", "2026-03-01", "2026-08-31", "Britannia", listOf("cookies"), "8901063142046"),
        Sample("biscuit-marie", f("36|Sunfeast", "48|MARIE LIGHT", "18|Oats"),
            "MRP Rs. 2O.OO\nNET WT 15O g\nMFD DT: 2O/O2/2O26\nBEST BEFORE 6 MONTHS FROM MFD\nITC Limited\nUnit Sale Price ₹ 0.13 per g",
            20.0, "150 g", "2026-02-20", "2026-08-20", "Sunfeast", listOf("marie"), null),
        Sample("biscuit-oreo-offer", f("50|OREO", "20|Chocolatey Sandwich Biscuits"),
            "SPECIAL OFFER PRICE ₹ 25\nMRP ₹ 3O.OO\nNet Wt 12O g\nMFD 01/2026 EXP 10/2026",
            30.0, "120 g", "2026-01-01", "2026-10-31", "Oreo", listOf("biscuits"), null),
        Sample("oil-fortune-1l", f("44|Fortune", "30|SUNLITE", "22|Refined Sunflower Oil"),
            "Net Qty: 1 L (910 g)\nMRP Rs.185.OO\nincl. of all taxes\nPKD ON: 15 FEB 2026\nBEST BEFORE 9 MONTHS FROM PACKING\nAdani Wilmar Ltd\nCustomer Care 1800 103 6300",
            185.0, "1 L", "2026-02-15", "2026-11-15", "Fortune", listOf("sunflower", "oil"), null),
        Sample("oil-saffola-5l", f("46|Saffola", "30|GOLD", "18|Pro Healthy Lifestyle Edible Oil"),
            "M.R.P. ₹1,O99.OO (Incl. of all taxes)\nNet Vol. 5 L\nPKD:2O.I2.25\nUSE BY: 19.09.26\nMarico Limited",
            1099.0, "5 L", "2025-12-20", "2026-09-19", "Saffola", listOf("gold"), null),
        Sample("oil-parachute", f("40|Parachute", "26|100% Pure Coconut Oil"),
            "MRP (Incl. of all taxes) ₹ 1O5.OO\n1OO ml\nUnit Sale Price ₹ 1.O5/ml\nMfg: 1O/25  Exp: O9/27",
            105.0, "100 ml", "2025-10-01", "2027-09-30", "Parachute", listOf("coconut", "oil"), null),
        Sample("oil-goldwinner", f("40|Gold Winner", "24|Refined Sunflower Oil"),
            "Net Qty: 1 Litre\nMRP Rs. 155.00\nNutrition per 100 ml: Energy 900 kcal\nPacked on 05/03/2026\nBest before 6 months",
            155.0, "1 L", "2026-03-05", "2026-09-05", "Gold Winner", listOf("sunflower", "oil"), null),
        Sample("soap-lux", f("52|LUX", "20|Soft Glow", "16|Rose & Vitamin E"),
            "Net Wt. 1OO g\nM.R.P. ₹ 45.OO incl of all taxes\nPer 100g: ₹ 45.00\nMfd by: Hindustan Unilever Ltd\nMFG: O1/2026 EXP: 12/2028\n89O1O3O 8O5431",
            45.0, "100 g", "2026-01-01", "2028-12-31", "Lux", listOf("soft", "glow"), "8901030805431"),
        Sample("soap-lifebuoy", f("48|Lifebuoy", "22|Total 10", "18|Germ Protection Soap"),
            "MRP Rs 3S/-\nNet Wt 1OOg\nB.No. A2B114 MFD O2/26\nBEST BEFORE 36 MONTHS FROM MANUFACTURE",
            35.0, "100 g", "2026-02-01", "2029-02-01", "Lifebuoy", listOf("total"), null),
        Sample("soap-medimix-stamp", f("44|MEDIMIX", "22|Classic Ayurvedic Soap"),
            "M.R.P.\n₹ 4S.OO\nNet Wt. 125 g\nMFD. EXP.\nO4/26 O3/29",
            45.0, "125 g", "2026-04-01", "2029-03-31", "Medimix", listOf("soap"), null),
        Sample("soap-vim-bar", f("36|vim", "24|Lemon dishwash bar"),
            "M R P ₹ 1O.OO\nNet Wt. 155 g\nMFD O1 26  USE BY 12 27",
            10.0, "155 g", "2026-01-01", "2027-12-31", "Vim", listOf("dishwash"), null),
        Sample("shampoo-clinic-sachet", f("30|Clinic Plus", "14|Strength & Shine", "12|Shampoo"),
            "MRP Rs.1/- (incl. of all taxes)\nNet Vol. 6 ml\nMfd: 11/2025 Use before 36 months from mfd.",
            1.0, "6 ml", "2025-11-01", "2028-11-01", "Clinic Plus", listOf("shampoo"), null),
        Sample("shampoo-hs", f("40|head&shoulders", "20|anti-dandruff shampoo", "14|smooth & silky"),
            "M.R.P.₹ 34O.OO\nNet Contents: 34O ml\nMFG. DATE: 1O/O1/2026\nEXP. DATE: O9/O1/2029\nProcter & Gamble Home Products\n89O1OO1 234567",
            340.0, "340 ml", "2026-01-10", "2029-01-09", "Head & Shoulders", listOf("shampoo"), "8901001234567"),
        Sample("shampoo-sunsilk-glare", f("38|SUNSILK", "20|Black Shine"),
            "M.R.P. ₹ 2__.00\nNet Vol 18O ml\nMFG 0?/2026",  // MRP digits lost to foil glare
            null, "180 ml", null, null, "Sunsilk", listOf("black", "shine"), null),
        Sample("tea-redlabel", f("38|BROOKE BOND", "56|RED LABEL", "18|NATURAL CARE", "16|TEA"),
            "MRP ₹ 135.OO (Inclusive of all taxes) Net Wt. 25Og\nMfd. On: O4 MAR 2026\nBest Before: 18 Months from manufacture\nHindustan Unilever Limited",
            135.0, "250 g", "2026-03-04", "2027-09-04", "Brooke Bond", listOf("red", "label"), null),
        Sample("tea-tata-premium", f("40|TATA TEA", "50|PREMIUM", "14|Desh ki Chai"),
            "MRP: Rs. 31O.OO\nNET WT. 5OO g\nPKD 2O/O1/2026\nBEST BEFORE 12 MONTHS FROM PACKING\nTata Consumer Products Ltd\n89O1O58 9O1238",
            310.0, "500 g", "2026-01-20", "2027-01-20", "Tata", listOf("premium"), "8901058901238"),
        Sample("tea-waghbakri", f("44|Wagh Bakri", "26|Premium Leaf Tea"),
            "M.R.P. Rs 26O.OO\nNet Wt 5OO g\nPKD O8/2O25 BEST BEFORE 18 MONTHS\n89O1O48 1O1O13",
            260.0, "500 g", "2025-08-01", "2027-02-01", "Wagh Bakri", listOf("leaf", "tea"), "8901048101013"),
        Sample("spice-everest-haldi", f("46|EVEREST", "30|TURMERIC POWDER", "16|Haldi"),
            "MRP ₹ 38.00\n(incl. of all taxes)\nNET WT 100 g\nMFD: AUG 2025  BB: JUL 2027\nUSP Rs 0.38/g",
            38.0, "100 g", "2025-08-01", "2027-07-31", "Everest", listOf("turmeric", "powder"), null),
        Sample("spice-mdh-garam", f("40|MDH", "34|GARAM MASALA"),
            "M.R.P.(Incl. of all taxes) ₹ 86.OO\nNet Wt. 1OO g\nB.No. 2512 Pkd. 11/25\nBest before 12 months from packing",
            86.0, "100 g", "2025-11-01", "2026-11-01", "MDH", listOf("garam", "masala"), null),
        Sample("spice-badshah-inkjet", f("40|BADSHAH", "26|Rajwadi Garam Masala"),
            "MRP Rs.7O/-\nNET WT. 5Og e\nMFG.: O6.O1.26\nEXP.: O5.O1.27",
            70.0, "50 g", "2026-01-06", "2027-01-05", "Badshah", listOf("garam", "masala"), null),
        Sample("spice-catch-hing", f("32|catch", "24|Hing", "14|Asafoetida Compounded"),
            "MRP ₹ 55 (incl. all taxes)\nNett Wt. 10 g\nPacked on: 12/2025  Expiry: 11/2027",
            55.0, "10 g", "2025-12-01", "2027-11-30", "Catch", listOf("hing"), null),
        Sample("salt-tata", f("42|TATA", "40|SALT", "14|Vacuum Evaporated Iodised Salt"),
            "Net Wt. 1 kg\nMRP ₹ 28.OO\nPkd. 12/2025\nBest before 24 months from packing",
            28.0, "1 kg", "2025-12-01", "2027-12-01", "Tata", listOf("salt"), null),
        Sample("ghee-amul", f("40|AMUL", "30|PURE GHEE"),
            "M.R.P. ₹ 65O.OO\nNet Qty. 1 L (91O g)\nMfg. 15/O3/2026\nBest Before 12 months from Mfg.",
            650.0, "1 L", "2026-03-15", "2027-03-15", "Amul", listOf("ghee"), null),
        Sample("detergent-surf", f("40|Surf excel", "20|Easy Wash"),
            "MRP Rs 1O/-\nNet Qty 8O g\nMFD 12/25",
            10.0, "80 g", "2025-12-01", null, "Surf Excel", listOf("wash"), null),
        Sample("noodles-maggi", f("50|MAGGI", "26|2-Minute Noodles", "14|Masala"),
            "MRP: ₹ 14.OO\nNet Wt.: 7O g\nPKD: MAY 2026\nUSE BEFORE 9 MONTHS FROM PACKAGING",
            14.0, "70 g", "2026-05-01", "2027-02-01", "Maggi", listOf("noodles"), null),
        Sample("snack-kurkure-foil", f("48|Kurkure", "22|Masala Munch"),
            "MRP ₹ 2O\nNet wt 3O g\n2O/O1/26 B.NO.K1234\n19/O4/26",   // inkjet: labels missing
            20.0, "30 g", "2026-01-20", "2026-04-19", "Kurkure", listOf("masala"), null),
        Sample("snack-haldiram", f("38|Haldiram's", "30|Aloo Bhujia"),
            "MRP:₹55/-\nNet Wt.: 15O g\nPKD:23/O1/26 USE BY:22/O5/26\n89O4O63 2O1O34",
            55.0, "150 g", "2026-01-23", "2026-05-22", "Haldiram's", listOf("bhujia"), "8904063201034"),
        Sample("toothpaste-colgate", f("50|Colgate", "30|Strong Teeth", "18|Dental Cream"),
            "MRP ₹ 1O8.OO\nNet Wt. 2OOg (inclusive of 1Og extra)\nMFD: O3/2026  EXP: O2/2028\n8 901314 01032 2",
            108.0, "200 g", "2026-03-01", "2028-02-29", "Colgate", listOf("strong", "teeth"), "8901314010322"),
        Sample("handwash-dettol-backonly", emptyList(),
            "Dettol Original Liquid Handwash\nM.R.P.: Rs.99.00 (incl of all taxes)\nNet Vol: 200 ml\nMfg: O2/2026 Exp: O1/2029\nReckitt Benckiser",
            99.0, "200 ml", "2026-02-01", "2029-01-31", "Dettol", null, null),

        // ── Harder cases added after the first run (not tuned against) ──
        Sample("ocr-rs-as-r5", f("40|Britannia", "30|Milk Bikis"),
            "MRP R5.40.00 (incl. of all taxes)\nNet Wt 200 g\nPKD 02/2026\nBest before 9 months",
            40.0, "200 g", "2026-02-01", "2026-11-01", "Britannia", listOf("milk"), null),
        Sample("new-mrp-sticker", f("40|Dabur", "26|Honey"),
            "MRP ₹ 199.00 (incl. of all taxes)\nNEW MRP ₹ 215.00\nNet Wt 250 g\nMFD 11/2025 EXP 10/2027",
            215.0, "250 g", "2025-11-01", "2027-10-31", "Dabur", listOf("honey"), null),
        Sample("hindi-only-mrp", f("36|Ghadi", "24|Detergent Powder"),
            "34fuchaH ₹ 10.00 (ufE)\nNet Wt 95 g\nMfg 01/26",
            10.0, "95 g", "2026-01-01", null, "Ghadi", listOf("detergent"), null),
        Sample("inkjet-spaced-dots", f("40|Patanjali", "24|Kesh Kanti Shampoo"),
            "MRP ₹ 85.00\nNet Vol 200 ml\nMFD : 1 2 . 0 3 . 2 0 2 6\nEXP : 1 1 . 0 3 . 2 0 2 8",
            85.0, "200 ml", "2026-03-12", "2028-03-11", "Patanjali", listOf("shampoo"), null),
        Sample("best-before-no-mfg", f("38|Bikaji", "26|Bhujia"),
            "MRP ₹ 50/-\nNet Wt 200 g\nBest before 4 months from manufacture",
            50.0, "200 g", null, null, "Bikaji", listOf("bhujia"), null),
    )

    @Test fun accuracyTable() {
        val fields = listOf("MRP", "weight", "MFG", "EXP", "brand", "name", "barcode")
        val pass = fields.associateWith { 0 }.toMutableMap()
        val rows = StringBuilder()
        for (s in samples) {
            val r = LabelParser.parse(s.front, s.back.lines().map { Line(it) })
            val ok = mapOf(
                "MRP" to (r.mrp.value == s.mrp),
                "weight" to (r.netQty.value == s.qty),
                "MFG" to (r.mfgDate.value == s.mfg),
                "EXP" to (r.expiryDate.value == s.exp),
                "brand" to (r.brand.value.equals(s.brand, ignoreCase = true) || (r.brand.value == null && s.brand == null)),
                "name" to (if (s.nameWords == null) r.name.value == null
                           else s.nameWords.all { w -> r.name.value?.lowercase()?.contains(w) == true }),
                "barcode" to (r.barcodeFromText.value == s.barcode),
            )
            ok.forEach { (k, v) -> if (v) pass[k] = pass[k]!! + 1 }
            rows.append(String.format("%-26s", s.id))
            fields.forEach { rows.append(if (ok[it] == true) "  ok  " else "  --  ") }
            rows.append("   mrp=${r.mrp.value} qty=${r.netQty.value} mfg=${r.mfgDate.value} exp=${r.expiryDate.value}")
            rows.append(" brand=${r.brand.value} name=${r.name.value} bc=${r.barcodeFromText.value}\n")
        }
        val n = samples.size
        println("\n%-26s".format("sample") + fields.joinToString("") { "%6s".format(it.take(6)) })
        print(rows)
        println("TOTAL (${n} samples): " + fields.joinToString("  ") { "$it ${pass[it]}/$n" })

        // Regression guard: minimum passes per field on this sample set.
        val min = mapOf("MRP" to 33, "weight" to 33, "MFG" to 31, "EXP" to 31, "brand" to 33, "name" to 33, "barcode" to 34)
        for (fName in fields) {
            assertTrue("$fName accuracy dropped: ${pass[fName]}/$n < ${min[fName]}", pass[fName]!! >= min[fName]!!)
        }
    }
}
