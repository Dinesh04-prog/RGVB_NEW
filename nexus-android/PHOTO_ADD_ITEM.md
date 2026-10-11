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
