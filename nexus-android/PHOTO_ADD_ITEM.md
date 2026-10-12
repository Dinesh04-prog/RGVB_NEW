# Fill an inventory item from photos (Android app)

A **📷 Fill from Photos** button sits at the top of the normal **Add / Edit Inventory Item** popup
(only inside the Android app). Take 1–5 photos of the pack (front, back, side, crimp); the app reads them on the
phone and fills the popup's empty fields. Everything stays editable, and **SAVE CHANGES** works exactly as before.
Running cost: **zero**, with no API keys and no billing account. All text of this feature is English; only product
data (Marathi names) is in Devanagari. Colours follow the app: blue `#0d6efd` (main buttons), light blue `#e7f1ff`,
dark blue `#0a3d62`, green `#16A34A` (Done), white backgrounds, and a soft yellow `#FFF9DB` for "auto-filled, check this".

## How it works

```
Add / Edit popup → "📷 Fill from Photos"                   PhotoScanFill.tsx + usePhotoScanFill.ts
  → window.AndroidScan.startProductScan()                    AndroidScanBridge.kt
  → ProductScanActivity (CameraX, ~12 MP): "Photo 2/5", "↺ Retake", "+ Add another photo", "✓ Done",
    tap-to-focus, torch, guide frame. Each shot focuses first; each photo is checked for blur / dark / glare
    and a problem makes "Retake" the main button (the user may keep the photo).
  → ScanPipeline (background thread), per photo at full resolution:
      ML Kit barcode; OCR Latin as taken (turned 90°/270° only when that reads very little text);
      OCR Devanagari; OCR Latin again on a grey contrast-stretched copy and, if some reads are weak, a sharpened copy;
      OcrMerge: one line per region (highest ML Kit confidence wins), read column by column
  → ScanMerge.kt picks each field across photos (below)
  → Open Food Facts (free, no key): fills blank name / brand / size; disagreements with weak reads become suggestions
  → result JSON in filesDir/scan_result.json → MainActivity → window.onProductScanResult(json)
  → photoFill.ts fills only empty fields of the open popup → the user edits → SAVE CHANGES
  → saveInventoryEdit() → upsertInventoryItem() (the only write path)
```

**Bridge result** (`ProductScanResult` in `src/lib/androidScan.ts`): `name_eng, name_marathi, brand, unit, net_qty,
mrp, mrp_alternates[], barcode, barcodeVerified, mfg_date, expiry_date, confidence{}, source{}, offStatus, photoCount,
warnings[], suggestions{}, recognised[], debug`. Photos and thumbnails are **not** sent to the web app.

### Merging photos (ScanMerge.kt)
* **Barcode:** the first photo whose ML Kit barcode passes the EAN/UPC checksum. Otherwise checksum-valid digits
  read by OCR (highest confidence). Otherwise the first ML Kit barcode, marked unverified.
* **MRP:** every reading of every photo **and** every OCR pass is a candidate. Score = anchor (MRP / M.R.P / Max
  Retail Price 0.9, "MRP" misread as MRF/MPR 0.75, ₹/Rs only 0.5) + "incl. of all taxes" + next to the net weight
  + 0.06 for each extra pass/photo that read the same value − 0.3 when the price per kg / L is outside ₹2–₹20,000.
  Rejected: unit prices, offer / save / special prices, batch numbers, phone numbers, values outside ₹1–₹10,000,
  digits running into glare (`2__.00`). Split and inkjet-spaced digits are joined (`₹ 1 08.00`, `1 2 0 . 0 0`).
  The best one is used; other values come back as `mrp_alternates`. A close strong alternate marks the MRP weak.
* **Net qty, MFG, EXP:** parsed on every photo **and** on all photos' text joined, so that "best before 9
  months" on one photo combines with the PKD date on another. The highest confidence wins, with the earliest photo
  on ties. If another photo has a different value with similar confidence, the value is kept but marked weak.
  Sizes outside 1 g / 1 ml – 50 kg / 50 L are treated as misreads.
* **Brand and English name:** each photo is parsed as if it were the front, after OCR spelling fixes (below).
  A known brand or product word scores first, then the photo with the largest text (normally the front).
  Company lines, storage and usage text are ignored.
* **Marathi name:** the photo with the tallest Devanagari name line.
* An expiry that is not after the MFG date is kept but marked weak, with a warning to check both dates.

### Spelling of names
* On the phone (`NameSpell.kt`): brand words (`LabelParser.KNOWN_BRANDS`) and common product words. A word is changed
  only when it is not a known word and either undoing an OCR confusion makes it one (rn→m, vv→w, cl→d, 1→l/i, 0→o,
  5→s, l↔i, c→e) or exactly one known word is 1 edit away (5–7 letters) / 2 edits away (8+ letters). Ties and
  far-off words are kept as read; a word that still looks misread ("Exce1") lowers the name confidence.
* In the popup (`spellFixEnglish` in `itemNames.ts`): the same rule with the shop's own vocabulary (every word of
  the inventory names and brands, and the word lists) plus corrections the user made before (`!fix:<read>` in
  `photo_name_map`, learned when a suggested English word is edited before Save).

### Filling the popup (photoFill.ts)
* Only **empty** fields are filled, and never a field the user has typed in this popup. In **Edit** mode, saved
  values are never overwritten. A price or MRP of 0 counts as empty.
* **Two name fields**, one below the other: **Item Name (English)** → `name_eng` and **Item Name (Marathi)** →
  `name_marathi`. Each is filled on its own when empty, each has its own yellow, and editing one never changes or
  converts the other (the old A / अ toggle is gone). `name` = Marathi if present, otherwise English.
  Older items with only `name` show it in the matching box. Save needs at least one name; a soft-yellow note says
  when the other one is empty. Shop style: `"parle-g gluco biscuit 250g"` / `"पारले-जी ग्लुको बिस्किट २५० ग्रॅम"`.
* Also filled: barcode, MRP → `purchase_price`, sale rate = MRP when empty, unit (`pcs`; a new item's default
  `kg` counts as empty), `net_qty` (shown as **PACK SIZE** after a scan), and the hidden `brand`, `expiry_date`,
  `mfg_date`. For an existing item with no short code, `search_key` is filled too. **Stock is never filled.**
* Auto-filled fields get a soft yellow background, which disappears when the user edits that field.
* **MRP chips:** when the photos gave different prices, chips under MRP (`₹45 · ₹40`) switch it in one tap
  (the sale rate follows while it is still the auto-filled MRP).
* **Suggestions:** an Open Food Facts name or size that disagrees with a weak read is shown as a chip; it is used
  only when tapped.
* **Recognised text** (collapsed, above "Show raw scan details"): every merged OCR line; tap a line, then
  **→ English name / → MRP / → Weight / → Barcode**. Prices need MRP / ₹ / Rs or a lone number; weights need a unit;
  barcodes need 8, 12 or 13 digits; anything else shows a short message and changes nothing.
* **Warnings** (soft yellow): expiry not after MFG, and prices that were ignored when no MRP was found.
* **Duplicates** (only after a scan): the same barcode on another item shows a red **"This item already exists"**
  notice with **Open existing item**, and Save is blocked for a new item. The same name and size without a barcode
  match shows a yellow warning, and Save is still allowed.
* Scan failed, nothing read, or no internet / Open Food Facts down: a short message appears and the popup keeps
  whatever was decoded.
* After a save, word pairs, removed words and English spelling fixes the user made in a suggested name are
  remembered locally (`photo_name_map`).
* Low-memory phones: photos live in `cacheDir` and the count and step survive Activity recreation. The result waits
  on disk; if the app restarted, a new-item popup opens and is filled.
* Open Food Facts: one call per scan, no retries, capped at 14 calls/min in the app (their limit is 15/min/IP).
  User-Agent is `OpenFoodFacts.USER_AGENT`.

## Short names for the receipt

Pack text is long, and the 58/80 mm receipt prints names as bitmap rows, so the popup gets a **short name**.
The long pack text is kept in `full_name_eng`, which is searchable (Fuse weight 0.3) but not shown.

* `shortenProductName()` and `shortBilingualName()` in `src/lib/itemNames.ts` are pure and deterministic.
  The limits are in one place: `SHORT_NAME_LIMITS = { eng: 28, marathi: 24 }`. English counts characters;
  Marathi counts **printed letters** (matras, virama, nukta and anusvara share a column), both including the size.
* **Kept:** the brand when it is the product's identity, the core product word, the variant that matters, and the size.
  The parent brand is dropped when a sub-brand carries the name ("britannia good day" → "good day").
  `VARIANT_PHRASES` (kesh kanti, intensive care, easy wash, natural care, strong teeth, total 10, tea premium…) stay
  together with the brand; when brand + variant + size fits the limit, that is the core and the type word may go.
  "natural" and "premium" are kept right after the brand (Tata Tea Premium) and dropped elsewhere.
* **Marathi spellings:** medicines, OTC brands and variants have built-in spellings in `PRODUCT_PHRASES`
  (निओमायसिन, बीटाडीन, व्हिक्स व्हेपोरब, डायक्लोफेनॅक, क्रोसिन, झंडू बाम, इनो…); unknown words are transliterated and need a check.
  Makers that are not the identity (Cipla, HUL, ITC…) are dropped.
* **Always dropped:** `FILLER_WORDS` (original, premium, classic, new, special, pure, natural, fresh, family/value pack,
  combo, with, net wt, approx, vacuum/evaporated/iodised, compounded…), `PHARMA_SUFFIXES` (sulphate, hydrochloride,
  sodium, USP, IP, BP…), `COMPANY_WORDS` (pvt, ltd, industries, foods, products…), repeated words, "100%", and
  taglines after "with / enriched with" once the product type has been named.
* **Too long:** first `SOFT_WORDS` go (refined, anticavity, herbal, ayurvedic, extra…), then the type word the brand
  already implies (`BRAND_IMPLIES`: colgate → toothpaste, maggi → noodles…), then other words from the end.
  The size and the core word are never dropped.
* **Unsure** (no product type and no known brand, or words had to be cut): brand + the 2 most prominent words + size,
  and a "Check the name" note appears in the popup.
* **Marathi** is built word by word from the short English name, never cut from a long string. If it is too wide,
  one more English word goes and both names are rebuilt. Synonyms that give the same Marathi word are kept once
  ("hing asafoetida" → हिंग).
* **Learning:** when the user deletes a word from a suggested Marathi name before saving, the matching English word
  is stored as `!drop:<word>` in `photo_name_map` and is dropped next time. Type words and brands are never learned as drops.
* Size style: `250g`, `1kg`, `200ml`, `1l` (inventory.json only has g and kg; litres follow the same pattern).

## Data mapping

| Scan field | InventoryItem field | Note |
|---|---|---|
| MRP | `purchase_price` | The card already shows `purchase_price` as the struck-through MRP; the "X% सूट" badge = `price < purchase_price`; voice "mrp 50" matches it (`scoreCandidate`). Nothing computes profit from it. |
| Sale rate | `price` | Defaults to MRP |
| Pack size | `net_qty` (new, optional) | `unit` stays the billing unit (`pcs` default; kg/pack selectable) |
| Expiry / MFG | `expiry_date` / `mfg_date` (new, optional ISO) | |
| Names | `name_marathi`, `name_eng`, `name` = Marathi | Short, shop style: `"neomycin cream 10g"` / `"निओमायसिन क्रीम १० ग्रॅम"` |
| Long pack name | `full_name_eng` (new, optional) | e.g. `"neomycin sulphate cream usp 10g"`; search only |
| Short code | `search_key` | lowercase(first 4 of `name_eng` + " " + first 4 of `name_marathi`); matches all 163 items in inventory.json |

Bilingual names (`src/lib/itemNames.ts`): Devanagari OCR (Hindi words respelled to Marathi) → the shop's
own inventory word map → the `phonetic.ts` dictionary → brand and loanword lists → Sanscript phonetic
transliteration (flagged). Word pairs the user corrects are remembered in IndexedDB (`photo_name_map`).

## Tests

* `nexus-android`: `gradle testDebugUnitTest` runs `LabelParserTest` (checksums, unit normalizer, OCR digit fixes,
  spaced inkjet dates, and an accuracy table over 35 noisy label samples with a minimum per field), `ScanMergeTest`
  (MRP only on photo 3, barcode only on photo 2, bad checksum on one photo, best-before and PKD on different photos,
  conflicting names and MRPs), `AccuracyHelpersTest` (spelling fixes, pass merging, reading order, rotation choice,
  blur / dark / glare, MRP candidates and rejections, weight limits, alternates and warnings) and `ReplayTest`.
  It runs in CI before `assembleRelease`.
* **Replay samples:** `app/src/test/resources/ocr-samples/*.txt`, one scan per file (format in `README.txt` there):
  expected values plus the OCR lines of each photo and pass (`latin`, `latin enhanced`, `latin rot90/rot270`,
  `devanagari`), with box positions and ML Kit confidence. They are typed by hand with realistic OCR mistakes, not
  captured from a phone. `s01–s24` were written together with the fixes; `h01–h10` were written afterwards and run
  once without tuning. `ReplayTest` runs them through the phone's own merge code and fails the build below a per-field
  minimum. Known misses: s24 (brand too damaged to fix safely), h01 ("ml" read as "m1"; "Care" taken as back text),
  h10 ("Pasle" is as close to "parle" as to "paste", so it is kept).
  To add a real case: copy the OCR text from **📋 Copy details** into a new sample file and write the expected values.
* `nexus-react-pos`: `npm run test:names` checks bilingual names, short code, size format, learning, duplicates,
  the popup fill rules (new vs edit, the two name fields filled and kept separately, typed fields protected, stock
  never filled), spelling fixes with the shop vocabulary and learned fixes, tap-to-pick parsing and the "Copy details" text.

## APK size

The bundled models add about 2.4 MB (barcode) plus about 4 MB per script per CPU type (Latin, Devanagari).
`abiFilters 'arm64-v8a', 'armeabi-v7a'` keeps this to about +18–20 MB in total. The CI log prints the final APK size.
Emulators need an ARM system image because of the ABI filter.

## Raw scan details (for tuning)

After a scan, the Add / Edit popup has a small **"Show raw scan details"** link at the bottom (collapsed by default). It shows:
- for each photo: the ML Kit barcode result, the OCR passes used, EXIF rotation and any turn, and the merged OCR
  text (Latin and Devanagari, with box heights and ML Kit confidence);
- for each merged field: value, source, confidence and which photo it came from;
- every MRP value read with its score and reason, the alternates offered, and warnings;
- the barcode that was used, the Open Food Facts response and suggestions, spelling fixes made with the shop's
  words, and timings.

Photos are read at full size (12 MP is not downscaled; larger sensors are subsampled to ≤ 4096 px). After an
out-of-memory error a photo is read again at 2048 px. Three Latin passes per photo take longer than one; the per-photo
time is shown as `ms` in these details.

**"📋 Copy details"** copies it as plain text, without photos. Nothing is sent anywhere.

## Testing safely: test items go to the live shop data

The APK is built in CI with the **production** Firebase config (`VITE_FIREBASE_PROJECT_ID: nexus-pos-817c3` in
`.github/workflows/build-apk.yml`). A Save from the popup (camera-filled or not) calls `upsertInventoryItem`, which does this:

1. Updates the phone's in-memory list and IndexedDB cache (`custom_inventory`).
2. Calls `saveInventoryItemToCloud` → `setDoc(inventory/<id>)` in the production Firestore project.
3. Every other signed-in device (shop PCs, owner app) gets it right away through `subscribeToInventory`,
   and the item becomes searchable and billable everywhere.

The Excel auto-sync only runs on a desktop browser that has an Excel file linked. It does not run inside the APK, because Android WebView has no File System Access API.

**Deleting test items:**
1. Before testing, put **TEST** at the start of the English name (for example `test parle-g 250g`) so test items are easy to find.
2. To delete in the app: Inventory tab → search "test" → tap the item → **DELETE** (top right of the edit popup) → confirm.
   This removes it locally and from Firestore (`removeInventoryItemFromCloud`), and other devices update within seconds.
3. To delete in the Firebase console: project `nexus-pos-817c3` → Firestore → collection `inventory`.
   New items have ids `INV-<timestamp>`, and camera-filled ones usually have a `net_qty` field; delete the test documents there.
4. Learned name corrections stay only on that phone (IndexedDB key `photo_name_map`).
   Clear the app's storage to reset them; they are never uploaded.

## Phase 2 notes (not built)

**Optional "Try smart read" with Gemini.** Deferred.
* Free tier (checked 2026-10-11): Flash / Flash-Lite models only. Quotas are shown per project in AI Studio, not in a public table.
  Free-tier inputs **may be used to improve Google products and read by human reviewers**. It is not available for users in the EEA/UK.
  Label photos are not sensitive, so this is acceptable, but check the terms again before building.
* The key must never be in the APK, the web bundle or a `VITE_` variable. Plan: a Cloudflare Worker (free plan, no card)
  holding `GEMINI_API_KEY` as a secret (`npx wrangler secret put GEMINI_API_KEY`), with a request size cap, the
  rate-limit binding (10 s / 60 s windows only) and strict JSON output (null when unsure, per-field confidence).
* Blocker: the app does not keep the Google ID token (`LoginPage.tsx` decodes and drops it; tokens expire after 1 h).
  The Worker needs a way to authenticate the caller, for example storing the credential and asking for sign-in again on expiry.
  That means a change to login and token handling, which was out of scope.
* Hook point: `ScanPipeline.run` already reports `source` per field; add `"gemini"` results the same way, as suggestions.
