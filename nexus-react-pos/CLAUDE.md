# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**Kirana Inventory POS** — an offline-first Progressive Web App (PWA) combining a full point-of-sale system with a Marathi-first voice stock lookup, built for a small Indian grocery store (Rajendra GVB).

---

## Commands

All commands run from this directory:

```bash
npm run dev                # Dev server at http://localhost:5173 (HMR enabled)
npm run dev -- --host      # Expose on LAN — open http://192.168.1.x:5173 on mobile
npm run build              # TypeScript check + Vite production build → /dist
npm run lint               # ESLint with TypeScript + React hooks rules
npm run preview            # Serve the production build locally

python convert_inventory.py   # Convert inventory_data.xlsx → public/inventory.json
```

No test framework is configured.

---

## Architecture

Single-page application with **four tab-based views**. All UI and business logic lives in **`src/App.tsx`** (~1,500+ lines). No backend — all data persists in the browser via LocalForage (IndexedDB).

### Key files

| File | Purpose |
|---|---|
| `src/App.tsx` | Monolithic component: all 4 tabs, all state, all UI |
| `src/lib/db.ts` | LocalForage wrapper; exports `Receipt` and `CartItem` types |
| `src/lib/phonetic.ts` | Hinglish → Marathi transliteration via Sanscript |
| `src/main.tsx` | React entry point |
| `index.html` | HTML shell; loads Noto Sans Devanagari font; registers service worker |
| `inventory_data.xlsx` | Source inventory file (9,999 items) |
| `convert_inventory.py` | Converts `inventory_data.xlsx` → `public/inventory.json` |
| `public/inventory.json` | Compiled inventory loaded at first app boot |

### Data stores (LocalForage keys)

- `custom_inventory` — product catalog (`InventoryItem[]`)
- `sales` — receipt history (`Receipt[]`)
- `bill_counter` — daily bill numbering state

### InventoryItem schema

```typescript
interface InventoryItem {
  id: string;              // SKU (from SKU_ID1001 column)
  name: string;            // primary name (Marathi preferred)
  name_marathi?: string;
  name_eng?: string;
  brand?: string;
  search_key?: string;     // short code for fast lookup
  unit: string;            // kg, L, pcs — auto-extracted from English name
  price: number;           // selling price  ←→  Excel: Selling_Price_INR
  purchase_price?: number; // MRP            ←→  Excel: MRP_INR
  stock_quantity?: number;
  stock_qty?: number;
  barcode?: string;
}
```

---

## Tab Overview

### 1. BILLING (📝 बिल)
Fuzzy product search (Fuse.js), voice input (Web Speech API, Marathi/Hindi), barcode/QR scan (html5-qrcode), cart management, checkout, receipt generation + sharing (WhatsApp, html2canvas, print).

Bill numbers follow format `AA-DDMM-###` (store prefix + date + daily counter).

### 2. INVENTORY (📦 यादी)
Excel import/export (xlsx), manual CRUD, stock tracking, barcode scan for lookup.
Items render as product tiles, 3 per row at every width (`src/components/InventoryTile.tsx`, shared with the Owner app): picture (`image`, a ≤ 25 KB JPEG data URL, or a tinted letter placeholder), one name (Marathi, else English), pack size / unit, `SR` (sale rate = `price`) and `PR` in red (`purchase_price`), and a green outlined "Stock N" block that turns red under 10. Star and delete sit on the picture's corners; tap the tile to open the edit modal, which has the picture box (`ItemImageField.tsx`, no Firebase Storage).

### 3. REPORTS (📊 अहवाल)
Profit summary, full JSON backup/restore.

### 4. CUSTOMERS (👥 ग्राहक)
Customer directory, per-customer purchase history aggregated from sales.

---

## Inventory Data

The master inventory file is `inventory_data.xlsx`. Run the converter whenever it changes:

```bash
python convert_inventory.py
```

This writes to `public/inventory.json`. The app loads `public/inventory.json` on first boot (before any LocalForage data exists). After a user imports via the Inventory tab, LocalForage takes precedence.

### Excel column mapping

| Excel Column | InventoryItem field |
|---|---|
| SKU_ID1001 | `id` |
| Marathi_Name | `name_marathi`, `name` |
| English_Name | `name_eng` |
| Brand | `brand` |
| MRP_INR | `purchase_price` |
| Selling_Price_INR | `price` |
| Stock_Quantity | `stock_quantity`, `stock_qty` |

Unit is auto-extracted from the English name (e.g. `"MDH Ghee (1 L)"` → `"1 L"`).

---

## Notable Patterns

- All React state is local (`useState`/`useEffect`/`useRef`) — no Redux or Context
- Unit conversion at cart time: kg↔g, L↔ml, dozen↔pcs via `multiplier` field on `CartItem`
- Search works across `name_marathi`, `name_eng`, `name`, `brand`, and `search_key`
- Receipt CSS targets 80mm thermal printer width
- Responsive layout: desktop uses sidebar nav, mobile uses bottom navbar (5 tabs, Marathi labels)
- Noto Sans Devanagari loaded from Google Fonts for Marathi text

---

## Search Configuration (Fuse.js)

```typescript
// Billing tab — includes search_key with high weight
keys: [
  { name: "search_key",   weight: 3 },
  { name: "name",         weight: 1 },
  { name: "name_marathi", weight: 1 },
  { name: "name_eng",     weight: 1 },
  { name: "id",           weight: 0.5 },
  { name: "barcode",      weight: 0.5 },
]
threshold: 0.3

// Stock Lookup tab — same Fuse instance, limit 20
fuse.search(kiranaQuery, { limit: 20 })
```

---

## Color Conventions

| Context | Color |
|---|---|
| App chrome / sidebar | `#0a3d62` (dark blue) |
| Kirana selling price | `#16A34A` (green) |
| Kirana discount badge | `#16A34A` (green) |
| Kirana MRP strikethrough | `#DC2626` (red) |
| Kirana low stock | `#DC2626` (red) |
| Voice mic button (Stock Lookup) | `#F97316` (orange) |
| Mic active / listening | `#DC2626` (red, pulsing) |
| Brand name in Stock Lookup | `#0a3d62` (dark blue) |

---

## Dependencies

| Package | Purpose |
|---|---|
| localforage | Offline storage (IndexedDB / localStorage fallback) |
| fuse.js | Fuzzy search across all name fields |
| html5-qrcode | Camera barcode/QR scanning |
| html2canvas | DOM-to-image for receipt sharing |
| xlsx | Excel import/export for inventory |
| @sanskrit-coders/sanscript | Hinglish → Devanagari transliteration |

---

## PWA & Offline

- Service worker registered via `index.html` (`/sw.js`)
- All inventory, sales, and app state survive offline
- Voice search (`mr-IN`) requires internet — Web Speech API sends audio to Google
- Text search always works offline

---

## Key Constraints

1. **No paid APIs** — Web Speech API only; never Google Cloud Speech-to-Text
2. **No backend** — all data in LocalForage (IndexedDB)
3. **Marathi first in Stock Lookup** — all UI labels in Devanagari
4. **Bilingual search** — Fuse.js searches Marathi, English, brand, and search_key simultaneously
5. **Voice fallback** — text search must always work if voice is unavailable
6. **Item pictures stay tiny** — `image` is ≤ 240 px and ≤ 25 KB (`src/lib/itemImage.ts`); remove the key instead of writing undefined to Firestore
7. **Low stock alert** — red "कमी साठा" when `stock_quantity < 10`
8. **Max 20 results** — cap Stock Lookup to keep UI fast
9. **Touch targets** — all interactive elements minimum 48px height
10. **No horizontal scroll** — `overflow-x: hidden` + `box-sizing: border-box` everywhere
