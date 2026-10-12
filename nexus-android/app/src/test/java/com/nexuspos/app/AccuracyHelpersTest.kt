package com.nexuspos.app

import com.nexuspos.app.LabelParser.Line
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Spelling fixes, OCR pass merging, photo checks and MRP candidates (gradle testDebugUnitTest). */
class AccuracyHelpersTest {

    // ── NameSpell ────────────────────────────────────────────────────────────

    @Test fun ocrConfusionsAreUndone() {
        assertEquals("Cream", NameSpell.correctWord("Crearn"))            // rn → m
        assertEquals("Dishwash", NameSpell.correctWord("Dishvvash"))      // vv → w
        assertEquals("Handwash", NameSpell.correctWord("Hanclwash"))      // cl → d
        assertEquals("Colgate", NameSpell.correctWord("Co1gate"))         // 1 → l
        assertEquals("TURMERIC", NameSpell.correctWord("TURMERlC"))       // l → i, case kept
        assertEquals("Haldiram's", NameSpell.correctWord("Ha1diram's"))   // apostrophe form kept
    }

    @Test fun closeWordsAreFixedOnlyWhenUnique() {
        assertEquals("Britannia", NameSpell.correctWord("Britania"))      // one letter lost
        assertEquals("Lifebuoy", NameSpell.correctWord("Lifebouy"))       // swap
        assertNull(NameSpell.correctWord("Brtnia"))                       // too far: never guessed
        assertNull(NameSpell.correctWord("pasle", setOf("paste", "parle")))   // tie: kept
    }

    @Test fun knownShortAndUnknownWordsAreKept() {
        for (w in listOf("Biscuits", "Rajwadi", "Munch", "Tea", "200g", "B12", "A2B114", "Bikis", "Gluco", "Sunlite", "Strength")) {
            assertNull("$w must not change", NameSpell.correctWord(w))
        }
        val fix = NameSpell.correctLine("BRITANIA Good Day 75g")
        assertEquals("BRITANNIA Good Day 75g", fix.text)
        assertEquals(listOf("BRITANIA" to "BRITANNIA"), fix.changes)
        assertTrue(NameSpell.correctLine("Zx1kq Tea").suspicious.contains("Zx1kq"))
    }

    @Test fun osaDistance() {
        assertEquals(1, NameSpell.osa("noodels", "noodles"))
        assertEquals(1, NameSpell.osa("britania", "britannia"))
        assertEquals(3, NameSpell.osa("strength", "strong"))
    }

    // ── OcrMerge ─────────────────────────────────────────────────────────────

    @Test fun passesMergeByRegionKeepingTheBetterRead() {
        val plain = listOf(Line("MRP ₹ 4_.00", 14, 100, 20, 300, 0.5f), Line("Net Wt 100 g", 14, 140, 20, 200, 0.9f))
        val enhanced = listOf(Line("MRP ₹ 45.00", 14, 101, 22, 298, 0.85f), Line("Net Wt 10O q", 14, 140, 20, 200, 0.4f),
            Line("PKD 01/2026", 14, 180, 20, 200, 0.8f))
        val merged = OcrMerge.mergePasses(listOf(plain, enhanced)).map { it.text }
        assertEquals(listOf("MRP ₹ 45.00", "Net Wt 100 g", "PKD 01/2026"), merged)
    }

    @Test fun readingOrderFollowsColumns() {
        val lines = listOf(
            Line("M.R.P.", 14, 100, 20, 200), Line("Mfd: 02/2026", 14, 102, 400, 200),
            Line("Rs. 120.00", 14, 140, 20, 200), Line("Exp: 01/2027", 14, 141, 400, 200),
        )
        assertEquals(listOf("M.R.P.", "Rs. 120.00", "Mfd: 02/2026", "Exp: 01/2027"), OcrMerge.readingOrder(lines).map { it.text })
        // Without positions the old order (by top) is kept
        val noBox = listOf(Line("b", 14, 40), Line("a", 14, 0))
        assertEquals(listOf("a", "b"), OcrMerge.readingOrder(noBox).map { it.text })
    }

    @Test fun rotationOnlyWhenLittleText() {
        val junk = listOf(Line("lI1", 14, 0, 0, 20, 0.2f), Line("~", 14, 40, 0, 10, 0.2f))
        val text = listOf(Line("M.R.P. ₹ 25.00 (incl. of all taxes)", 14, 0, 0, 300, 0.85f))
        assertTrue(OcrMerge.littleText(junk))
        assertFalse(OcrMerge.littleText(text))
        assertEquals(90, OcrMerge.chooseOrientation(listOf(0 to junk, 90 to text, 270 to emptyList())))
        assertEquals(0, OcrMerge.chooseOrientation(listOf(0 to text, 90 to text)))   // tie keeps the photo as taken
    }

    // ── ImageQuality ─────────────────────────────────────────────────────────

    private fun image(w: Int, h: Int, f: (Int, Int) -> Int) = IntArray(w * h) { i -> f(i % w, i / w) }

    @Test fun blurDarkAndGlareAreFlagged() {
        val sharp = ImageQuality.assess(image(80, 60) { x, y -> if ((x / 4 + y / 4) % 2 == 0) 30 else 220 }, 80, 60)
        assertTrue("sharp text-like image: ${sharp.sharpness}", sharp.issues.isEmpty())
        val flat = ImageQuality.assess(image(80, 60) { x, _ -> 120 + x / 20 }, 80, 60)
        assertEquals(listOf(ImageQuality.Issue.BLURRY), flat.issues)
        val dark = ImageQuality.assess(image(80, 60) { x, y -> if ((x / 4 + y / 4) % 2 == 0) 5 else 40 }, 80, 60)
        assertEquals(listOf(ImageQuality.Issue.DARK), dark.issues)
        val glare = ImageQuality.assess(image(80, 60) { x, y -> if (x < 20) 255 else if ((x / 4 + y / 4) % 2 == 0) 30 else 200 }, 80, 60)
        assertTrue(ImageQuality.Issue.GLARE in glare.issues)
    }

    @Test fun contrastStretchAndSharpen() {
        val hist = IntArray(256).also { for (v in 90..160) it[v] = 100 }
        val (lo, hi) = ImageQuality.stretchLimits(hist)!!
        assertTrue(lo in 90..92 && hi in 158..160)
        assertEquals(0, ImageQuality.stretch(lo, lo, hi))
        assertEquals(255, ImageQuality.stretch(hi, lo, hi))
        assertNull(ImageQuality.stretchLimits(IntArray(256).also { it[0] = 50; it[255] = 50; it[128] = 900 }))
        val out = IntArray(3)
        ImageQuality.sharpenRow(intArrayOf(100, 100, 100), intArrayOf(100, 200, 100), intArrayOf(100, 100, 100), out, 3)
        assertEquals(255, out[1])   // 5×200 − 4×100 = 600 → clamped
    }

    // ── MRP candidates and value checks ──────────────────────────────────────

    @Test fun mrpCandidatesAndRejections() {
        assertEquals(108.0, LabelParser.parseMrp("MRP ₹ 1 08.00").value!!, 0.001)              // print gap
        assertEquals(120.0, LabelParser.parseMrp("M.R.P ₹ 1 2 0 . 0 0").value!!, 0.001)        // inkjet spacing
        assertEquals(99.0, LabelParser.parseMrp("MRF: 99.00 (incl. of all taxes)").value!!, 0.001)   // misread anchor
        assertNull(LabelParser.parseMrp("MRP Rs. 1800 266 0123").value)                         // phone number
        val scan = LabelParser.mrpCandidates("MRP ₹ 12500\nMRP Rs. 1800 266 0123")
        assertTrue(scan.candidates.isEmpty())
        assertTrue(scan.rejected.any { it.first == "12500" && it.second.contains("outside") })
        assertTrue(scan.rejected.any { it.second == "phone number" })
        // MRP next to the net weight scores a little higher
        val near = LabelParser.mrpCandidates("Net Wt 100 g\nMRP ₹ 45.00").candidates.single()
        val far = LabelParser.mrpCandidates("MRP ₹ 45.00").candidates.single()
        assertTrue(near.score > far.score)
        // Plain price lines without an anchor are unchanged
        assertEquals("Net Wt 1 2 . 5 g", LabelParser.normalizePriceLine("Net Wt 1 2 . 5 g"))
    }

    @Test fun impossibleWeightsAreRejected() {
        assertNull(LabelParser.normalizeQty("500 kg"))
        assertNull(LabelParser.normalizeQty("0.5 g"))
        assertEquals("50 kg", LabelParser.normalizeQty("50 kg"))
        assertEquals("1 g", LabelParser.normalizeQty("1 g"))
    }

    @Test fun mergeOffersAlternatesAndWarnings() {
        val back = ScanMerge.photoOf(listOf(
            listOf(Line("MRP ₹ 45.00 (incl. of all taxes)", 14, 100, 20, 300, 0.8f), Line("Net Wt 100 g", 14, 140, 20, 200, 0.8f)),
            listOf(Line("MRP ₹ 45.00 (incl. of all taxes)", 14, 100, 20, 300, 0.9f)),
        ), emptyList(), null)
        val crimp = ScanMerge.photoOf(listOf(listOf(Line("MRP Rs. 40.00", 14, 60, 20, 200, 0.7f),
            Line("MFG 05/2026 EXP 04/2026", 14, 100, 20, 300, 0.7f))), emptyList(), null)
        val m = ScanMerge.merge(listOf(back, crimp))
        assertEquals(45.0, m.mrp.value!!, 0.001)
        assertEquals(listOf(40.0), m.mrpAlternates)
        assertTrue("conflict → weak", m.mrp.confidence <= 0.55)
        assertTrue(m.warnings.any { it.contains("not after the manufacture date") })
        // An implausible price for the size loses to the same pack's plausible one
        val dot = ScanMerge.photoOf(listOf(listOf(Line("MRP ₹ 4500", 14, 0), Line("Net Wt 100 g", 14, 40)),
            listOf(Line("MRP ₹ 45.00", 14, 0))), emptyList(), null)
        assertEquals(45.0, ScanMerge.merge(listOf(dot)).mrp.value!!, 0.001)
    }
}
