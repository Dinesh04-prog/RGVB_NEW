package com.nexuspos.app

import com.nexuspos.app.LabelParser.Line
import com.nexuspos.app.ScanMerge.Photo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Merging 1–5 photos of one pack (gradle testDebugUnitTest). */
class ScanMergeTest {

    /** "60|PARLE-G" → Line(text, height); plain strings get height 14 (small print). */
    private fun lines(vararg rows: String) = rows.mapIndexed { i, r ->
        val parts = r.split("|", limit = 2)
        if (parts.size == 2 && parts[0].all { it.isDigit() }) Line(parts[1], parts[0].toInt(), i * 40) else Line(r, 14, i * 40)
    }

    private val front = Photo(lines("60|Parle-G", "30|Original Gluco Biscuits", "14|Rich in energy"),
        lines("40|पारले-जी", "26|ग्लुको बिस्किट"))
    private val back = Photo(lines("Parle Products Pvt. Ltd.", "Net Wt. 250g e", "Ingredients: wheat flour, sugar"), emptyList(),
        barcode = "8901719101038" to "EAN_13")
    private val side = Photo(lines("M.R.P Rs. 1O.OO (Incl. of all taxes)", "Best before 6 months from packaging"), emptyList())
    private val crimp = Photo(lines("PKD: 12/01/2026", "B.No. A123"), emptyList())

    @Test fun mrpOnlyOnPhoto3_barcodeOnlyOnPhoto2() {
        val m = ScanMerge.merge(listOf(front, back, side))
        assertEquals(10.0, m.mrp.value!!, 0.001)
        assertEquals(3, m.pickedFrom["mrp"])
        assertEquals("8901719101038", m.barcode)
        assertTrue(m.barcodeVerified)
        assertEquals(2, m.pickedFrom["barcode"])
        assertEquals("250 g", m.netQty.value)
        assertEquals("Parle-G", m.brand.value)
        assertEquals("Original Gluco Biscuits", m.name.value)
        assertEquals(1, m.pickedFrom["name_eng"])
        assertEquals("पारले-जी", m.nameMarathi.value)
    }

    @Test fun relativeBestBeforeCombinesAcrossPhotos() {
        // "best before 6 months" is on photo 3, the PKD date on photo 4 → combined text gives the expiry
        val m = ScanMerge.merge(listOf(front, back, side, crimp))
        assertEquals("2026-01-12", m.mfgDate.value)
        assertEquals("2026-07-12", m.expiryDate.value)
        assertEquals(0, m.pickedFrom["expiry_date"])   // 0 = all photos combined
    }

    @Test fun conflictingNamesPickFrontPhoto() {
        // Side panel repeats a different, smaller product line; the big front text wins
        val sidePanel = Photo(lines("18|Good Day Butter Cookies", "Britannia Industries Limited", "Customer care 1800 22 6000"), emptyList())
        val frontGd = Photo(lines("40|BRITANNIA", "58|Good Day", "24|Cashew Cookies"), emptyList())
        val m = ScanMerge.merge(listOf(sidePanel, frontGd))
        assertEquals("Britannia", m.brand.value)
        assertEquals("Good Day Cashew Cookies", m.name.value)
        assertEquals(2, m.pickedFrom["name_eng"])
    }

    @Test fun conflictingMrpIsKeptButWeak() {
        val a = Photo(lines("MRP ₹ 199.00 (incl. of all taxes)"), emptyList())
        val b = Photo(lines("MRP ₹ 215.00 (incl. of all taxes)"), emptyList())
        val m = ScanMerge.merge(listOf(a, b))
        assertEquals(199.0, m.mrp.value!!, 0.001)       // earliest photo on a tie
        assertTrue("conflict must be flagged", m.mrp.confidence <= 0.55)
    }

    @Test fun badChecksumOnOnePhotoGoodOnAnother() {
        val p1 = Photo(lines("Net Wt 100 g"), emptyList(), barcode = "8901063142047" to "EAN_13")   // bad check digit
        val p2 = Photo(lines("MRP ₹ 30.00"), emptyList(), barcode = "8901063142046" to "EAN_13")
        val m = ScanMerge.merge(listOf(p1, p2))
        assertEquals("8901063142046", m.barcode)
        assertTrue(m.barcodeVerified)
        assertEquals(2, m.pickedFrom["barcode"])
    }

    @Test fun onlyBadChecksumIsUnverified_textDigitsPreferred() {
        val p1 = Photo(lines("Net Wt 100 g"), emptyList(), barcode = "8901063142047" to "EAN_13")
        assertFalse(ScanMerge.merge(listOf(p1)).barcodeVerified)
        val p2 = Photo(lines("8901063 142046"), emptyList())
        val m = ScanMerge.merge(listOf(p1, p2))
        assertEquals("8901063142046", m.barcode)
        assertTrue(m.barcodeVerified)
        assertEquals("mlkit-ocr", m.barcodeSource)
    }

    @Test fun singlePhotoStillWorks() {
        val m = ScanMerge.merge(listOf(Photo(lines("50|MAGGI", "26|2-Minute Noodles", "MRP: ₹ 14.OO", "Net Wt.: 7O g"), emptyList())))
        assertEquals(14.0, m.mrp.value!!, 0.001)
        assertEquals("70 g", m.netQty.value)
        assertEquals("Maggi", m.brand.value)
        assertNull(m.barcode)
    }

    @Test fun nothingReadReturnsNulls() {
        val m = ScanMerge.merge(listOf(Photo(emptyList(), emptyList()), Photo(lines("@@@"), emptyList())))
        assertNull(m.mrp.value); assertNull(m.name.value); assertNull(m.barcode); assertNull(m.expiryDate.value)
        assertTrue(m.pickedFrom.isEmpty())
    }
}
