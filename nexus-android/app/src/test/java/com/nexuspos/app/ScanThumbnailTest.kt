package com.nexuspos.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Thumbnail size cap (gradle testDebugUnitTest). The JPEG encoding itself needs a device. */
class ScanThumbnailTest {

    private val prefix = "data:image/jpeg;base64,"

    @Test fun firstStepIsUsedWhenItFits() {
        val tried = mutableListOf<Pair<Int, Int>>()
        val url = ScanThumbnail.fit { e, q -> tried += e to q; "A".repeat(12_000) }
        assertEquals(listOf(240 to 70), tried)
        assertEquals(prefix + "A".repeat(12_000), url)
    }

    @Test fun shrinksUntilUnderTheCap() {
        // Pretend size falls with each step: 40 KB, 30 KB, 24 KB …
        val sizes = mapOf((240 to 70) to 40_000, (240 to 55) to 30_000, (200 to 50) to 24_000)
        val url = ScanThumbnail.fit { e, q -> "A".repeat(sizes[e to q] ?: 1) }!!
        assertEquals(prefix.length + 24_000, url.length)
        assertTrue(url.length <= ScanThumbnail.MAX_CHARS)
    }

    @Test fun capCountsThePrefix() {
        val exact = ScanThumbnail.MAX_CHARS - prefix.length
        assertEquals(ScanThumbnail.MAX_CHARS, ScanThumbnail.fit { _, _ -> "A".repeat(exact) }!!.length)
        // one character over on every step → no picture rather than an oversized one
        assertNull(ScanThumbnail.fit { _, _ -> "A".repeat(exact + 1) })
    }

    @Test fun encodingFailureGivesNoPicture() {
        assertNull(ScanThumbnail.fit { _, _ -> null })
    }
}
