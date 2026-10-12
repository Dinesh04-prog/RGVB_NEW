package com.nexuspos.app

import com.nexuspos.app.LabelParser.Line
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Replays hand-typed OCR output (the .txt files in src/test/resources/ocr-samples, format in README.txt there)
 * through the same merge code the phone runs, and prints a per-field accuracy table.
 */
class ReplayTest {

    class Pass(val kind: String, val lines: List<Line>)
    class PhotoSample(val barcode: Pair<String, String>?, val passes: List<Pass>)
    class Sample(val id: String, val expect: Map<String, String>, val photos: List<PhotoSample>)

    companion object {
        private val LINE = Regex("""^(\d+)(?:,(\d+))?(?:,(\d+))?(?:,(\d+))?(?:,([01](?:\.\d+)?))?\|(.*)$""")

        fun loadSamples(): List<Sample> {
            val dir = File(ReplayTest::class.java.classLoader!!.getResource("ocr-samples")!!.toURI())
            return dir.listFiles { f -> f.name.endsWith(".txt") && f.name != "README.txt" }!!
                .sortedBy { it.name }.map { parse(it.readText(Charsets.UTF_8)) }
        }

        fun parse(text: String): Sample {
            var id = ""
            val expect = mutableMapOf<String, String>()
            val photos = mutableListOf<PhotoSample>()
            var barcode: Pair<String, String>? = null
            var passes = mutableListOf<Pass>()
            var kind: String? = null
            var lines = mutableListOf<Line>()
            fun endPass() { kind?.let { passes += Pass(it, lines) }; kind = null; lines = mutableListOf() }
            fun endPhoto() { endPass(); if (passes.isNotEmpty() || barcode != null) photos += PhotoSample(barcode, passes); passes = mutableListOf(); barcode = null }
            for (raw in text.lines()) {
                val l = raw.trimEnd()
                when {
                    l.isBlank() || l.startsWith("#") -> {}
                    l.startsWith("id:") -> id = l.substringAfter(":").trim()
                    l.startsWith("expect.") -> expect[l.substringAfter("expect.").substringBefore(":").trim()] = l.substringAfter(":").trim()
                    l == "== photo" -> endPhoto()
                    l.startsWith("barcode:") && kind == null -> l.substringAfter(":").trim().split(" ").let { barcode = it[0] to it[1] }
                    l.startsWith("-- ") -> { endPass(); kind = l.removePrefix("-- ").trim() }
                    else -> {
                        val m = LINE.matchEntire(l)
                        val idx = lines.size
                        lines += if (m == null) Line(l, 14, idx * 40) else Line(
                            m.groupValues[6], m.groupValues[1].toInt(),
                            m.groupValues[2].ifEmpty { null }?.toInt() ?: (idx * 40),
                            m.groupValues[3].ifEmpty { null }?.toInt() ?: 0,
                            m.groupValues[4].ifEmpty { null }?.toInt() ?: 0,
                            m.groupValues[5].ifEmpty { null }?.toFloat() ?: -1f,
                        )
                    }
                }
            }
            endPhoto()
            return Sample(id, expect, photos)
        }
    }

    /** What the phone would produce for this sample. */
    private class Out(val mrp: Double?, val mrpAlts: List<Double>, val qty: String?, val mfg: String?, val exp: String?,
                      val brand: String?, val name: String?, val barcode: String?)

    /**
     * Same steps as ScanPipeline.run: turn the photo only when the plain pass read very little, merge the
     * passes of the chosen orientation, then ScanMerge.
     */
    private fun run(s: Sample): Out {
        val photos = s.photos.map { p ->
            val plain = p.passes.firstOrNull { it.kind == "latin" }?.lines ?: emptyList()
            val rotated = p.passes.filter { it.kind.startsWith("latin rot") }.map { it.kind.removePrefix("latin rot").toInt() to it.lines }
            val rotation = if (OcrMerge.littleText(plain) && rotated.isNotEmpty()) OcrMerge.chooseOrientation(listOf(0 to plain) + rotated) else 0
            val passes = if (rotation == 0) listOf(plain) + p.passes.filter { it.kind == "latin enhanced" || it.kind == "latin sharpened" }.map { it.lines }
                         else listOf(rotated.first { it.first == rotation }.second)
            val dev = p.passes.firstOrNull { it.kind == "devanagari" }?.lines ?: emptyList()
            ScanMerge.photoOf(passes, dev, p.barcode)
        }
        val m = ScanMerge.merge(photos)
        return Out(m.mrp.value, m.mrpAlternates, m.netQty.value, m.mfgDate.value, m.expiryDate.value, m.brand.value, m.name.value, m.barcode)
    }

    @Test fun replayAccuracyTable() {
        val samples = loadSamples()
        assertTrue("need at least 20 samples, found ${samples.size}", samples.size >= 20)
        val fields = listOf("mrp", "weight", "mfg", "exp", "brand", "name", "barcode", "mrp_alts")
        val pass = fields.associateWith { 0 }.toMutableMap()
        val total = fields.associateWith { 0 }.toMutableMap()
        val rows = StringBuilder()
        for (s in samples) {
            val o = run(s)
            fun want(k: String) = s.expect[k]?.takeIf { it != "-" }
            val ok = linkedMapOf(
                "mrp" to (o.mrp == want("mrp")?.toDouble()),
                "weight" to (o.qty == want("weight")),
                "mfg" to (o.mfg == want("mfg")),
                "exp" to (o.exp == want("exp")),
                "brand" to (o.brand.equals(want("brand"), ignoreCase = true) || (o.brand == null && want("brand") == null)),
                "name" to (want("name")?.split(" ")?.all { w -> o.name?.lowercase()?.split(Regex("[^a-z0-9']+"))?.contains(w) == true }
                           ?: (o.name == null)),
                "barcode" to (o.barcode == want("barcode")),
            )
            want("mrp_alts")?.let { alts -> ok["mrp_alts"] = alts.split(",").all { a -> a.trim().toDouble() in o.mrpAlts } }
            ok.forEach { (k, v) -> total[k] = total[k]!! + 1; if (v) pass[k] = pass[k]!! + 1 }
            rows.append(String.format("%-28s", s.id))
            fields.forEach { rows.append(when (ok[it]) { true -> "  ok   "; false -> "  --   "; null -> "   .   " }) }
            rows.append("  mrp=${o.mrp} alts=${o.mrpAlts} qty=${o.qty} mfg=${o.mfg} exp=${o.exp} brand=${o.brand} name=${o.name} bc=${o.barcode}\n")
        }
        println("\nREPLAY " + "%-21s".format("sample") + fields.joinToString("") { "%7s".format(it.take(7)) })
        print(rows)
        println("REPLAY TOTAL (${samples.size} samples): " + fields.joinToString("  ") { "$it ${pass[it]}/${total[it]}" })

        // Regression guard. Known misses: s24 brand/name (too damaged to fix safely), h01 weight ("m1") and
        // name ("Care" is treated as back-panel text), h10 name ("Pasle" is as close to "parle" as to "paste").
        val min = mapOf("mrp" to 34, "weight" to 33, "mfg" to 34, "exp" to 34, "brand" to 33, "name" to 31,
            "barcode" to 34, "mrp_alts" to 2)
        for (f in fields) assertTrue("$f accuracy dropped: ${pass[f]}/${total[f]} < ${min[f]}", pass[f]!! >= min[f]!!)
    }
}
