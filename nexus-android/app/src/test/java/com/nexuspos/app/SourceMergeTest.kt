package com.nexuspos.app

import com.nexuspos.app.LabelParser.Field
import com.nexuspos.app.LabelParser.Line
import com.nexuspos.app.SourceMerge.GeminiRead
import com.nexuspos.app.SourceMerge.OffRead
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Gemini vs phone OCR vs Open Food Facts (gradle testDebugUnitTest). */
class SourceMergeTest {

    /** The phone's reading of the Tasty Nuts pack as it went wrong on the real phone. */
    private val badOcr = ScanMerge.merge(emptyList()).copy(
        name = Field("Tasty Sugar", 0.3), netQty = Field("20 g", 0.55), mrp = Field.none(), brand = Field.none(),
    )
    private val gemini = GeminiRead(
        nameEng = "Tasty Nuts Shing Bhujia", brand = "Tasty Nuts", netQty = "38 g", mrp = 10.0,
        confidence = mapOf("name_eng" to 0.92, "brand" to 0.9, "net_qty" to 0.88, "mrp" to 0.93),
    )

    @Test fun geminiIsPrimaryAndDisagreementIsWeakWithChips() {
        val r = SourceMerge.merge(badOcr, gemini, null)
        assertEquals("Tasty Nuts Shing Bhujia", r.nameEng.value)
        assertEquals("gemini", r.nameEng.source)
        assertTrue(r.nameEng.confidence <= 0.55)                    // OCR disagrees → yellow
        assertEquals(listOf("Tasty Sugar"), r.nameEng.alternates)
        assertEquals("38 g", r.netQty.value)
        assertEquals(listOf("20 g"), r.netQty.alternates)
        assertEquals(10.0, r.mrp.value!!, 0.001)                     // OCR had none: no disagreement
        assertEquals(0.93, r.mrp.confidence, 0.001)
        assertEquals("gemini", r.mrp.source)
    }

    @Test fun agreementRaisesConfidence() {
        val ocr = badOcr.copy(netQty = Field("38 g", 0.9), mrp = Field(10.0, 0.6), qtyAlternates = emptyList())
        val r = SourceMerge.merge(ocr, gemini, OffRead("Tasty Nuts Shing Bhujia 38g", "Tasty Nuts", "38 g"))
        assertEquals(0.9, r.netQty.confidence, 0.001)
        assertTrue(r.netQty.alternates.isEmpty())
        assertTrue(r.mrp.confidence >= 0.9)
        assertTrue(r.brand.confidence >= 0.9)
        // Name: OFF agrees (size ignored), OCR disagrees → still weak, OCR read offered
        assertEquals(listOf("Tasty Sugar"), r.nameEng.alternates)
    }

    @Test fun openFoodFactsBeatsAWeakWrongReadWhenGeminiIsMissing() {
        val r = SourceMerge.merge(badOcr, null, OffRead("Tasty Nuts Shing Bhujia", "Tasty Nuts", "38 g"))
        assertEquals("Tasty Nuts Shing Bhujia", r.nameEng.value)
        assertEquals("openfoodfacts", r.nameEng.source)
        assertTrue(r.nameEng.confidence <= 0.55)
        assertEquals(listOf("Tasty Sugar"), r.nameEng.alternates)
        assertEquals("38 g", r.netQty.value)                         // OCR 20 g was weak (0.55)
        assertEquals("Tasty Nuts", r.brand.value)                   // blank OCR brand filled
    }

    @Test fun strongOcrIsKeptAgainstOpenFoodFactsButMadeWeak() {
        val ocr = badOcr.copy(netQty = Field("40 g", 0.9))
        val r = SourceMerge.merge(ocr, null, OffRead(null, null, "38 g"))
        assertEquals("40 g", r.netQty.value)
        assertTrue(r.netQty.confidence <= 0.55)
        assertTrue("38 g" in r.netQty.alternates)
    }

    @Test fun geminiFailedOrMissingKeepsThePhoneResult() {
        val ocr = ScanMerge.merge(listOf(ScanMerge.Photo(listOf(Line("50|MAGGI".substringAfter('|'), 50),
            Line("2-Minute Noodles", 26), Line("MRP: ₹ 14.00"), Line("Net Wt.: 70 g")), emptyList())))
        val r = SourceMerge.merge(ocr, null, null)
        assertEquals("Maggi", r.brand.value)
        assertEquals(14.0, r.mrp.value!!, 0.001)
        assertEquals("70 g", r.netQty.value)
        assertEquals("mlkit-ocr", r.mrp.source)
        assertEquals(ocr.mrp.confidence, r.mrp.confidence, 0.001)
    }

    @Test fun lowConfidenceGeminiIsOnlyAnAlternate() {
        val ocr = badOcr.copy(netQty = Field("38 g", 0.9), qtyAlternates = emptyList())
        val r = SourceMerge.merge(ocr, GeminiRead(netQty = "36 g", confidence = mapOf("net_qty" to 0.4)), null)
        assertEquals("38 g", r.netQty.value)
        assertEquals("mlkit-ocr", r.netQty.source)
        assertEquals(listOf("36 g"), r.netQty.alternates)
        // Only Gemini, low confidence: used, but weak
        val only = SourceMerge.merge(ScanMerge.merge(emptyList()), GeminiRead(mrp = 25.0, confidence = mapOf("mrp" to 0.5)), null)
        assertEquals(25.0, only.mrp.value!!, 0.001)
        assertTrue(only.mrp.confidence <= 0.55)
    }

    @Test fun barcodeOnlyFromThePhone() {
        val withPhone = ScanMerge.merge(listOf(ScanMerge.Photo(emptyList(), emptyList(), "8901719101038" to "EAN_13")))
        assertNull(SourceMerge.merge(withPhone, GeminiRead(barcode = "8901063142046"), null).barcodeSuggestion)
        val none = ScanMerge.merge(emptyList())
        assertEquals("8901063142046", SourceMerge.merge(none, GeminiRead(barcode = "8901063142046"), null).barcodeSuggestion)
        assertNull(SourceMerge.merge(none, GeminiRead(barcode = "8901063142047"), null).barcodeSuggestion)   // bad checksum
    }

    @Test fun marathiFromGeminiOnlyWhenVerySureAndAlwaysWeak() {
        val sure = SourceMerge.merge(badOcr, GeminiRead(nameMarathi = "शिंग भुजिया", confidence = mapOf("name_marathi" to 0.85)), null)
        assertEquals("शिंग भुजिया", sure.nameMarathi.value)
        assertEquals("gemini", sure.nameMarathi.source)
        assertTrue(sure.nameMarathi.confidence <= 0.55)
        val unsure = SourceMerge.merge(badOcr, GeminiRead(nameMarathi = "शिंग भुजिया", confidence = mapOf("name_marathi" to 0.7)), null)
        assertNull(unsure.nameMarathi.value)
    }

    @Test fun sameTextIgnoresCaseSizeAndSmallOcrSlips() {
        assertTrue(SourceMerge.sameText("Tasty Nuts Shing Bhujia 38g", "tasty nuts shing bhujia"))
        assertTrue(SourceMerge.sameText("Parle-G", "PARLE G"))
        assertTrue(SourceMerge.sameText("Britannia", "Britania"))
        assertTrue(!SourceMerge.sameText("Tasty Sugar", "Tasty Nuts Shing Bhujia"))
        assertTrue(!SourceMerge.sameText("Bhujia", "Tasty Nuts Shing Bhujia"))   // a small part is not the same name
    }
}
