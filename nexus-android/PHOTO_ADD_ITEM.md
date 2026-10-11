# Add Item from Photos (Android app)

Photograph the **front** (name/brand, optional) and **back** (barcode, MRP, size, dates) of a pack.
The app reads it on the phone, opens a pre-filled review popup, and saves into the normal inventory.
Running cost: **zero**, with no API keys and no billing account.

## How it works

```
Inventory tab → "📷 Photo se item add karo"   (only shown inside the Android app)
  → window.AndroidScan.startProductScan()                 AndroidScanBridge.kt
  → ProductScanActivity (CameraX: front → back, retake, tap-to-focus, torch, guide frame)
  → ScanPipeline (background thread)
       1. ML Kit barcode (bundled)       EAN-13/EAN-8/UPC-A/UPC-E checksum → barcodeVerified
       2. ML Kit OCR Latin + Devanagari  → LabelParser.kt (MRP, net qty, MFG/EXP, brand, name)
       3. Open Food Facts (free, no key) → fills name/brand/size only if OCR left them blank or weak
  → result JSON in filesDir/scan_result.json → MainActivity → window.onProductScanResult(json)
  → PhotoAddItem.tsx review popup → upsertInventoryItem() (same write path as the manual form)
```

* Every layer is best-effort. No barcode, no internet, an Open Food Facts timeout (5 s) or even a pipeline
  crash still opens the review popup with whatever was read. If nothing was read, it says so and the user fills it in by hand.
* Low-memory phones: photos are stored in `cacheDir`, the step is kept across Activity recreation, and the
  result is kept on disk until the web app picks it up (`AndroidScan.takePendingResult()`).
* Yellow fields mean one of: auto-filled names, confidence below 0.6, an unverified barcode, or Open Food Facts suggestions.
  A field the user has typed is never overwritten.
* Open Food Facts: one call per scan, no retries, capped at 14 calls/min in the app (their limit is 15/min/IP).
  User-Agent is `OpenFoodFacts.USER_AGENT`.

## Data mapping

| Scan field | InventoryItem field | Note |
|---|---|---|
| MRP | `purchase_price` | The card already shows `purchase_price` as the struck-through MRP; the "X% सूट" badge = `price < purchase_price`; voice "mrp 50" matches it (`scoreCandidate`). Nothing computes profit from it. |
| Sale rate | `price` | Defaults to MRP |
| Pack size | `net_qty` (new, optional) | `unit` stays the billing unit (`pcs` default; kg/pack selectable) |
| Expiry / MFG | `expiry_date` / `mfg_date` (new, optional ISO) | |
| Names | `name_marathi`, `name_eng`, `name` = Marathi | Shop style: `"red lebal 250g"` / `"रेड लेबल २५० ग्रॅम"` |
| Short code | `search_key` | lowercase(first 4 of `name_eng` + " " + first 4 of `name_marathi`); matches all 163 items in inventory.json |

Bilingual names (`src/lib/itemNames.ts`): Devanagari OCR (Hindi words respelled to Marathi) → the shop's
own inventory word map → the `phonetic.ts` dictionary → brand and loanword lists → Sanscript phonetic
transliteration (flagged). Word pairs the user corrects are remembered in IndexedDB (`photo_name_map`).

## Tests

* `nexus-android`: `gradle testDebugUnitTest` runs `LabelParserTest` (checksums, unit normalizer, OCR digit fixes,
  and an accuracy table over 35 noisy label samples with a minimum per field). It runs in CI before `assembleRelease`.
* `nexus-react-pos`: `npm run test:names` checks bilingual names, short code, size format, learning and duplicates.

## APK size

The bundled models add about 2.4 MB (barcode) plus about 4 MB per script per CPU type (Latin, Devanagari).
`abiFilters 'arm64-v8a', 'armeabi-v7a'` keeps this to about +18–20 MB in total. The CI log prints the final APK size.
Emulators need an ARM system image because of the ABI filter.

## Raw scan details (for tuning)

The review popup has a small **"Show raw scan details"** link at the bottom (collapsed by default). It shows:
- raw OCR text per photo (Latin and Devanagari, with box heights);
- the parser's own values and confidence;
- the final value, source and confidence for each field;
- the ML Kit barcode result and the OCR-digit fallback;
- the Open Food Facts response and timings.

**"📋 Copy details"** copies it as plain text, without photos. Nothing is sent anywhere.

## Testing safely: test items go to the live shop data

The APK is built in CI with the **production** Firebase config (`VITE_FIREBASE_PROJECT_ID: nexus-pos-817c3` in
`.github/workflows/build-apk.yml`). A Save from the photo flow calls `upsertInventoryItem`, which does this:

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
   Photo-added documents have ids `INV-<timestamp>` and a `net_qty` field; delete the test documents there.
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
