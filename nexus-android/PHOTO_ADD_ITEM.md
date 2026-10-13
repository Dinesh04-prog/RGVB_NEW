# Fill an inventory item from photos (Android app)

A **📷 Fill from Photos** button sits at the top of the normal **Add / Edit Inventory Item** popup
(only inside the Android app). Take 1–5 photos of the pack (front, back, side, crimp); the app reads them on the
phone and fills the popup's empty fields. Everything stays editable, and **SAVE CHANGES** works exactly as before.
When the phone is online and the build has a Gemini Worker (see **Gemini** below), the photos are also read by Google
Gemini (free tier) through a small Cloudflare Worker; the phone's own reading stays as the fallback and cross-check.
Running cost: **zero** (free tiers, no billing account). All text of this feature is English; only product
data (Marathi names) is in Devanagari. Colours follow the app: blue `#0d6efd` (main buttons), light blue `#e7f1ff`,
dark blue `#0a3d62`, green `#16A34A` (Done), white backgrounds, and a soft yellow `#FFF9DB` for "auto-filled, check this".

## How it works

```
Add / Edit popup → "📷 Fill from Photos"                   PhotoScanFill.tsx + usePhotoScanFill.ts
  → window.AndroidScan.startProductScan()                    AndroidScanBridge.kt
  → ProductScanActivity (CameraX, ~12 MP): "Photo 2/5", "↺ Retake", "+ Add another photo", "✓ Done",
    tap-to-focus, torch, guide frame. Each shot focuses first; each photo is checked for blur / dark / glare
    and a problem makes "Retake" the main button (the user may keep the photo).
  → ScanPipeline (background thread):
      Gemini (if configured, switched on and online): 1–5 JPEGs ≤ 1280 px → GeminiClient → gemini-worker → Gemini;
        sent first, answered while the phone reads the photos (waits at most 20 s more)
      per photo at full resolution:
      ML Kit barcode; OCR Latin as taken (turned 90°/270° only when that reads very little text);
      OCR Devanagari; OCR Latin again on a grey contrast-stretched copy and, if some reads are weak, a sharpened copy;
      OcrMerge: one line per region (highest ML Kit confidence wins), read column by column
  → ScanMerge.kt picks each field across photos (below)
  → Open Food Facts (free, no key): one lookup for a checksum-valid barcode
  → SourceMerge.kt: Gemini first when sure, cross-checked with the phone's OCR and Open Food Facts (see Gemini)
  → result JSON in filesDir/scan_result.json → MainActivity → window.onProductScanResult(json)
  → photoFill.ts fills only empty fields of the open popup → the user edits → SAVE CHANGES
  → saveInventoryEdit() → upsertInventoryItem() (the only write path)
```

**Bridge result** (`ProductScanResult` in `src/lib/androidScan.ts`): `name_eng, name_marathi, brand, unit, net_qty,
mrp, mrp_alternates[], alternates{name_eng, net_qty, mrp}, barcode, barcodeVerified, mfg_date, expiry_date,
confidence{}, source{} (mlkit-ocr / mlkit-barcode / gemini / openfoodfacts per field), offStatus, geminiStatus,
photoCount, image, warnings[], suggestions{barcode}, recognised[], debug`. The photos are **not** sent to the web app;
`image` is one thumbnail of photo 1 (front), a JPEG data URL of at most 240 px and 25 KB (`ScanThumbnail.kt`), filled into
the item's picture only when it has none.

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
  blur / dark / glare, MRP candidates and rejections, weight limits, alternates and warnings), `SourceMergeTest`
  (Gemini vs OCR vs Open Food Facts: agreeing, disagreeing, missing, Gemini failed or unsure, barcode only from the
  phone, Marathi threshold) and `ReplayTest`. It runs in CI before `assembleRelease`, with or without the Gemini secrets.
* `gemini-worker`: `npm test` (request checks, answer validation, kill switch, auth and key rotation, limits, failure
  codes, no secrets in logs); `npm run measure` for the CPU estimate.
* `t01-tasty-nuts-shing-bhujia.txt` is **SYNTHETIC** (written from the diagnosis of a real scan). Replace its OCR lines
  with the real **📋 Copy details** text when available (instructions in the file header).
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

## Gemini (online reading of the photos)

**Photograph only the pack — never people, customers, bills or screens.** Free-tier Gemini inputs may be used by
Google to improve its products and may be read by human reviewers (terms checked 2026-10-12). The camera screen says
"Photos are read by Google Gemini when online." and has a **Use Gemini when online** switch (kept on the phone, default on).

### How the readers are combined (SourceMerge.kt)
* **Gemini is primary** for name, brand, size, MRP and dates when its confidence is ≥ 0.6.
  If the phone's OCR or Open Food Facts gives the same value, the confidence goes up. If one disagrees, Gemini's value
  is kept but the field is yellow and the other values are chips under **English name**, **PACK SIZE** and **MRP**.
* **No usable Gemini value** (off, offline, failed, or unsure): the phone's reading, as before. Open Food Facts fills a
  blank, and when it disagrees with a weak OCR read it is used (yellow) with the OCR read as a chip ("tasty sugar").
* **Barcode** comes only from ML Kit (checksum-validated). A barcode only Gemini read is never filled; it is shown under
  the barcode field as "Barcode read by Gemini (not verified, check it)".
* **Marathi name** from Gemini only when it is ≥ 0.8 sure. Even then the shop's spellings win (learned corrections,
  inventory words, the medicine / product list, brands: a Gemini word that sounds the same is replaced), the short-name
  rules are applied, the field is yellow and the popup asks to check the name. Otherwise Marathi is built from the
  short English name as before.
* Gemini's full English name goes through the same spelling fixes, short-name rules, `full_name_eng` and learning as
  the phone's reading ("Tasty Nuts Shing Bhujia" + 38 g → `tasty nuts shing bhujia 38g`).
* **A scan never fails because of Gemini.** Offline, daily limit reached, quota used up, timeout or a bad answer: a short
  English note in the popup ("Gemini's daily limit is reached. Filled from the phone's reading only.") and the phone's
  result. **📋 Copy details** shows the source of every field, the phone-only values, the Gemini status, model, time,
  what the Worker's checks dropped, and the raw Gemini JSON.

### The Worker (`gemini-worker/`)
* Cloudflare Workers free plan. The Gemini API key is a Worker **secret**; it is never in the APK, the web bundle or a
  `VITE_` variable. The app sends a shared **app key** (`X-App-Key`, from the `GEMINI_APP_KEY` GitHub secret) and a
  random per-install id (`X-Device-Id`). The app key can be pulled out of an APK by someone determined, so the Worker
  bounds the damage: **6 scans / minute per device**, **`DAILY_CAP` scans per day** for all phones (default 150),
  **1.5 MB** per request, **1–5 JPEGs**, and the Google project has **no billing**, so the worst case is "Gemini off until
  midnight Pacific", never a bill.
* Gemini is called with JSON output and a schema; the Worker then checks every field (types, units "38gm" → "38 g",
  MRP ₹1–₹10,000 from "10/-", "Rs.10", "₹10", real dates, barcode checksum, confidence 0–1, unknown keys dropped).
* Model: `GEMINI_MODEL` in `gemini-worker/wrangler.toml` (default `gemini-3.5-flash-lite`). Free daily limits are only
  shown in AI Studio (third-party measurements in 2026: about 500/day for 3.5 Flash-Lite, only about 20/day for 3.6 Flash).
  **To change the model:** edit `GEMINI_MODEL`, then `npx wrangler deploy` in `gemini-worker` (no app rebuild).
* CPU: the free plan allows 10 ms CPU per request (waiting for Gemini does not count). The photos are not JSON-parsed in
  the Worker; `npm run measure` (after `npx wrangler deploy --dry-run --outdir dist`) measured about 3 ms median for a
  maximum 5-photo request on a PC. The real figure is shown in the Cloudflare dashboard (Workers → nexuspos-gemini → Metrics).
* Never logged: the app key, the API key, photos. Logs contain only error codes.

### Deploy (one time, about 20 minutes)
You need: a Google account, a Cloudflare account (free, no card), Node.js 22+, and the repository on your PC.

1. **Gemini API key (no billing).** Open https://aistudio.google.com → **Get API key** → **Create API key** →
   choose **Create API key in new project**. Do not link a billing account to that project. Copy the key.
2. **Check the real free quota.** In AI Studio open the usage / **Rate limits** page from the left menu (the exact
   menu name changes from time to time), select the new project and look at `gemini-3.5-flash-lite`: requests per day
   (RPD) and per minute. Google no longer publishes these numbers anywhere else. Keep
   `DAILY_CAP` in `gemini-worker/wrangler.toml` well under the RPD (e.g. 150 when RPD is 500).
3. **Install and log in** (in a terminal):
   ```
   cd gemini-worker
   npm i
   npx wrangler login
   ```
   (`npm i` uses `legacy-peer-deps` from `.npmrc`; `wrangler login` opens the browser to allow access.)
4. **Daily counter storage:**
   ```
   npx wrangler kv namespace create USAGE
   ```
   Copy the printed `id` into `wrangler.toml` in place of `REPLACE_WITH_KV_NAMESPACE_ID`.
5. **Secrets.** Make a random app key (keep it; it goes into GitHub in step 8):
   ```
   node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
   npx wrangler secret put GEMINI_API_KEY      (paste the AI Studio key)
   npx wrangler secret put APP_KEY             (paste the random app key)
   ```
6. **Deploy:**
   ```
   npx wrangler deploy
   ```
   It prints the Worker URL, e.g. `https://nexuspos-gemini.<your-subdomain>.workers.dev`.
7. **Quick check** (should answer `{"ok":false,"error":"unauthorized"}` — the Worker is up and refuses calls without the key):
   ```
   curl -X POST https://nexuspos-gemini.<your-subdomain>.workers.dev/read
   ```
8. **GitHub secrets.** In the repository on github.com: **Settings → Secrets and variables → Actions →
   New repository secret**, twice:
   * `GEMINI_WORKER_URL` = the Worker URL from step 6 (without `/read`)
   * `GEMINI_APP_KEY` = the random app key from step 5
   GitHub hides secret values in build logs, and the build never prints them.
9. **Build the APK:** push to `main` (or **Actions → Build NexusPOS Android APK → Run workflow**). Install the APK.
   Without the two secrets the APK is built exactly as before, with Gemini off.

### Turn it off
* **Everyone, at once, no rebuild:** in `gemini-worker/wrangler.toml` set `ENABLED = "false"`, then `npx wrangler deploy`
  (or Cloudflare dashboard → Workers → nexuspos-gemini → Settings → Variables → `ENABLED`). Phones show
  "Gemini could not read the photos this time" and use their own reading.
* **One phone:** untick **Use Gemini when online** on the camera screen.
* **Remove it from the app:** delete the `GEMINI_WORKER_URL` GitHub secret and build again (the switch disappears).

### Rotate the app key (if it may have leaked)
1. Make a new key (command in step 5).
2. Keep the old one working while phones update: `npx wrangler secret put APP_KEY_PREVIOUS` (paste the **old** key),
   then `npx wrangler secret put APP_KEY` (paste the **new** key).
3. Update the `GEMINI_APP_KEY` GitHub secret to the new key, build, and install the new APK on every phone.
4. Then stop the old key: `npx wrangler secret delete APP_KEY_PREVIOUS`.

To rotate the Gemini API key: create a new key in AI Studio, `npx wrangler secret put GEMINI_API_KEY`, then delete the
old key in AI Studio. No app change is needed.
