# Fill an inventory item from photos (Android app)

A **📷 फोटोवरून भरा** button sits at the top of the normal **Add / Edit Inventory Item** popup
(only inside the Android app). Take 1–5 photos of the pack (front, back, side, crimp); the app reads them on the
phone and fills the popup's empty fields. Everything stays editable, and **SAVE CHANGES** works exactly as before.
Running cost: **zero**, with no API keys and no billing account.

## How it works

```
Add / Edit popup → "📷 फोटोवरून भरा"                       PhotoScanFill.tsx + usePhotoScanFill.ts
  → window.AndroidScan.startProductScan()                    AndroidScanBridge.kt
  → ProductScanActivity (CameraX): photo counter 1–5, "पुन्हा घ्या" (retake last), "+ आणखी फोटो",
    "✓ झाले" (Done), tap-to-focus, torch, guide frame
  → ScanPipeline (background thread), per photo: ML Kit barcode + OCR Latin + OCR Devanagari
  → ScanMerge.kt picks each field across photos (below)
  → Open Food Facts (free, no key): fills name / brand / size only if OCR left them blank or weak
  → result JSON in filesDir/scan_result.json → MainActivity → window.onProductScanResult(json)
  → photoFill.ts fills only empty fields of the open popup → the user edits → SAVE CHANGES
  → saveInventoryEdit() → upsertInventoryItem() (the only write path)
```

**Bridge result** (`ProductScanResult` in `src/lib/androidScan.ts`): `name_eng, name_marathi, brand, unit, net_qty,
mrp, barcode, barcodeVerified, mfg_date, expiry_date, confidence{}, source{}, offStatus, photoCount, debug`.
Photos and thumbnails are **not** sent to the web app.

### Merging photos (ScanMerge.kt)
* **Barcode:** the first photo whose ML Kit barcode passes the EAN/UPC checksum. Otherwise checksum-valid digits
  read by OCR (highest confidence). Otherwise the first ML Kit barcode, marked unverified.
* **MRP, net qty, MFG, EXP:** parsed on every photo **and** on all photos' text joined, so that "best before 9
  months" on one photo combines with the PKD date on another. The highest confidence wins, with the earliest photo
  on ties. If another photo has a different value with similar confidence, the value is kept but marked weak.
* **Brand and English name:** each photo is parsed as if it were the front. A known brand or product word scores
  first, then the photo with the largest text (normally the front). Company lines, storage and usage text are ignored.
* **Marathi name:** the photo with the tallest Devanagari name line.
* An expiry that is not after the MFG date is kept but marked weak.

### Filling the popup (photoFill.ts)
* Only **empty** fields are filled, and never a field the user has typed in this popup. In **Edit** mode, saved
  values are never overwritten. A price or MRP of 0 counts as empty.
* The visible name box gets the Marathi name (`name` = `name_marathi`). The hidden `name_eng` is added only
  together with it, in the shop style (`"parle-g original gluco biscuits 250g"` / `"पारले-जी … २५० ग्रॅम"`).
* Also filled: barcode, MRP → `purchase_price`, sale rate = MRP when empty, unit (`pcs`; a new item's default
  `kg` counts as empty), and the hidden `brand`, `net_qty`, `expiry_date`, `mfg_date`.
  For an existing item with no short code, `search_key` is filled too. **Stock is never filled.**
* Auto-filled fields get a light yellow background, which disappears when the user edits that field.
* **Duplicates** (only after a scan): the same barcode on another item shows a red **"Item already exists"** notice
  with **Open existing item**, and Save is blocked for a new item. The same name and size without a barcode match
  shows a yellow warning, and Save is still allowed.
* Scan failed, nothing read, or no internet / Open Food Facts down: a short message appears and the popup keeps
  whatever was decoded.
* After a save, word pairs the user corrected in a suggested name are remembered locally (`photo_name_map`).
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
  and a "नाव तपासा" note appears in the popup.
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
  spaced inkjet dates, and an accuracy table over 35 noisy label samples with a minimum per field) and `ScanMergeTest`
  (MRP only on photo 3, barcode only on photo 2, bad checksum on one photo, best-before and PKD on different photos,
  conflicting names and MRPs). It runs in CI before `assembleRelease`.
* `nexus-react-pos`: `npm run test:names` checks bilingual names, short code, size format, learning, duplicates,
  the popup fill rules (new vs edit, typed fields protected, stock never filled) and the "Copy details" text.

## APK size

The bundled models add about 2.4 MB (barcode) plus about 4 MB per script per CPU type (Latin, Devanagari).
`abiFilters 'arm64-v8a', 'armeabi-v7a'` keeps this to about +18–20 MB in total. The CI log prints the final APK size.
Emulators need an ARM system image because of the ABI filter.

## Raw scan details (for tuning)

After a scan, the Add / Edit popup has a small **"Show raw scan details"** link at the bottom (collapsed by default). It shows:
- for each photo: the ML Kit barcode result, and the raw OCR text (Latin and Devanagari, with box heights);
- for each merged field: value, source, confidence and which photo it came from;
- the barcode that was used, the Open Food Facts response, and timings.

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
