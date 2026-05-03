# Nexus React POS — Complete Project Documentation

> **Store:** Rajendra GVB — Kirana (Indian Grocery) Store
> **App Type:** Offline-first Progressive Web App (PWA) — works on mobile and desktop
> **Last Updated:** May 2026

---

## Table of Contents

1. [What This App Is](#1-what-this-app-is)
2. [Tech Stack and Dependencies](#2-tech-stack-and-dependencies)
3. [Project File Structure](#3-project-file-structure)
4. [Overall Workflow — How the Entire App Works](#4-overall-workflow--how-the-entire-app-works)
5. [Features — Detailed Descriptions](#5-features--detailed-descriptions)
6. [Cashier App — All Features](#6-cashier-app--all-features)
7. [Owner App — All Features](#7-owner-app--all-features)
8. [Real-Time Sync — How Owner and Cashier Stay in Sync](#8-real-time-sync--how-owner-and-cashier-stay-in-sync)
9. [Authentication Flow](#9-authentication-flow)
10. [Data Storage — What is Stored Where](#10-data-storage--what-is-stored-where)
11. [Voice Search — How It Works](#11-voice-search--how-it-works)
12. [Inventory System — How It Works](#12-inventory-system--how-it-works)
13. [Bill Review Workflow — Step by Step](#13-bill-review-workflow--step-by-step)
14. [Environment Variables](#14-environment-variables)
15. [Commands to Run the App](#15-commands-to-run-the-app)

---

## 1. What This App Is

**Nexus React POS** is a complete Point-of-Sale system built for a small Indian grocery (kirana) store. It runs entirely in the browser — no server needed. Everything is stored on the device using the browser's IndexedDB storage, with optional real-time cloud sync via Firebase Firestore.

It has **two separate interfaces** running from the same URL:

- **Cashier App** — for the shop counter staff to bill customers
- **Owner App** — for the shop owner to review bills, approve rates, and manage inventory

The system identifies who gets which interface by their Google account email. The owner email is configured in `.env`. Anyone else who logs in gets the Cashier interface.

---

## 2. Tech Stack and Dependencies

| Package | Version | Purpose |
|---|---|---|
| React 19 | ^19.2.5 | UI framework |
| TypeScript | ~6.0.2 | Type safety across entire codebase |
| Vite | ^8.0.10 | Build tool and dev server |
| Firebase | ^12.12.1 | Real-time cloud sync via Firestore |
| @react-oauth/google | ^0.13.4 | Google Sign-In button |
| Fuse.js | ^7.3.0 | Fuzzy search for product lookup |
| localforage | ^1.10.0 | Offline storage using IndexedDB |
| @sanskrit-coders/sanscript | ^1.2.8 | Hinglish to Devanagari transliteration |
| html5-qrcode | ^2.3.8 | Camera barcode and QR scanning |
| html2canvas | ^1.4.1 | DOM screenshot for receipt image sharing |
| xlsx | ^0.18.5 | Excel import and export for inventory |

No backend server is used. All data lives in the browser's IndexedDB via localforage. Real-time cross-device sync for inventory and bill reviews is handled by Firebase Firestore.

---

## 3. Project File Structure

```
nexus-react-pos/
|
|-- public/
|   |-- inventory.json          <- Compiled product catalog (9,999 items from Excel)
|   `-- sw.js                   <- Service worker for PWA offline caching
|
|-- src/
|   |-- main.tsx                <- App entry point; role-based routing (Owner/Cashier/Login)
|   |-- App.tsx                 <- Cashier POS interface (billing, inventory, reports, etc.)
|   |-- index.css               <- Global base styles
|   |
|   |-- components/
|   |   |-- OwnerApp.tsx        <- Owner interface (bill reviews + inventory management)
|   |   `-- LoginPage.tsx       <- Google Sign-In screen
|   |
|   |-- contexts/
|   |   `-- AuthContext.tsx     <- Google auth state (user, isOwner, login, logout)
|   |
|   `-- lib/
|       |-- firebase.ts         <- Firebase/Firestore functions (reviews + inventory sync)
|       |-- db.ts               <- LocalForage wrappers (CartItem, Receipt, saveSale)
|       `-- phonetic.ts         <- Hinglish->Marathi dictionary + query parser + scoring
|
|-- inventory_data.xlsx         <- Source Excel file (edit this, then run converter)
|-- convert_inventory.py        <- Converts Excel -> public/inventory.json
|-- firestore.rules             <- Firebase security rules
|-- .env                        <- API keys and config (never commit to git)
|-- vite.config.ts              <- Vite + PWA configuration
|-- package.json                <- Dependencies and scripts
`-- changes.md                  <- This file
```

---

## 4. Overall Workflow — How the Entire App Works

### Entry Point — Who Sees What

```
User opens the app URL
        |
        v
   LoginPage shown
   (Google Sign-In button)
        |
        v
  Google OAuth returns a JWT token
  App decodes it -> gets name, email, picture
        |
        |--- email == VITE_OWNER_EMAIL --------> Owner App
        |                                         (Bills tab + Inventory tab)
        |
        |--- URL has ?review=<id> -------------> Owner Review Page
        |                                         (direct WhatsApp link, works for anyone)
        |
        `--- any other email ------------------> Cashier App
                                                  (Billing + Inventory + Reports + Customers + Receipts)
```

### Data Flow at a Glance

```
inventory.json (base 9,999 items, loaded once on startup)
       +
Firestore: inventory_overrides (only changed, added, or deleted items)
       |
       v
  merged inventory (held in RAM + cached in IndexedDB for offline use)
       |
       |-- Cashier searches products and adds to cart
       |-- Owner edits prices and stock quantities
       `-- Both see each other's changes in approximately 1 second (real-time)


Cashier builds a bill -> clicks "Send to Owner"
       |
       v
Firestore: reviews/{uuid}  (status set to 'pending')
       |
       v
WhatsApp message sent to owner with a direct review link
       |
       v
Owner opens link -> OwnerReviewPage loads from Firestore
Owner edits rates -> clicks "Approve & Send"
       |
       v
Firestore updates: status='approved', updatedCart=[edited items]
       |
       v
Cashier screen shows green banner: "Owner approved the rates!"
Cashier clicks "Apply Rates" -> cart updates with owner's prices
Cashier checks out -> receipt saved to IndexedDB
```

---

## 5. Features — Detailed Descriptions

### Complete Feature List

| No | Feature | Available In |
|---|---|---|
| 1 | Google Sign-In Authentication | Both |
| 2 | Role-Based Routing (Owner vs Cashier) | main.tsx |
| 3 | Offline-First Storage | Both |
| 4 | Real-Time Inventory Sync (cross-device via Firestore) | Both |
| 5 | Voice Search in Marathi and Hinglish | Cashier |
| 6 | Barcode and QR Camera Scanner | Cashier |
| 7 | Fuzzy Product Search (multi-language) | Cashier |
| 8 | Smart Quantity Detection from Voice | Cashier |
| 9 | Cart Management with Edit and Delete | Cashier |
| 10 | Bill Review and Rate Approval via WhatsApp + Firestore | Both |
| 11 | Checkout and Receipt Generation | Cashier |
| 12 | WhatsApp Receipt Sharing | Cashier |
| 13 | Screenshot Receipt via html2canvas | Cashier |
| 14 | Print Receipt for 80mm Thermal Printer | Cashier |
| 15 | Inventory Management with Full CRUD | Both |
| 16 | Excel Import (upload .xlsx file) | Both |
| 17 | Excel Export of Current Inventory | Both |
| 18 | Barcode Scan for Inventory Item Edit | Both |
| 19 | Favourite Items with Star Pin | Both |
| 20 | Pagination in Inventory List | Both |
| 21 | Sales Reports and Profit Tracking | Cashier |
| 22 | Customer Directory from Sales History | Cashier |
| 23 | Receipt History with Detail View | Cashier |
| 24 | Full Backup and Restore (JSON file) | Cashier |
| 25 | Hinglish to Marathi IME Toggle | Both |
| 26 | PWA — Installable as a Home Screen App | Both |

---

## 6. Cashier App — All Features

### Tab 1 — Billing (बिल)

This is the main POS screen used for building bills and checking out customers.

#### Product Search

Type a product name in the search box. Results appear instantly as a dropdown suggestion list.

Search works across: Marathi name, English name, brand, search key, item ID, barcode.

**IME Toggle (अ / A button):** When ON (green), typing English words auto-converts to Marathi as you type space after a word. Example: typing "chai " converts to "चहा ". Useful on devices that do not have a Marathi keyboard.

**Keyboard navigation:** Arrow keys move through suggestions. Enter selects the highlighted item.

Search uses a three-stage pipeline:

Stage 1 — Exact or prefix match on the `search_key` field. This is the fastest path and used for known short codes.

Stage 2 — Structured intent parsing. The `parseUserQuery()` function extracts brand, weight or unit, and price signals from the query (in both English and Marathi), leaving a clean product name for fuzzy search. Candidates are then scored by `scoreCandidate()` which ranks items that match all signals higher than those matching only the name.

Stage 3 — Multi-variant Fuse.js fuzzy search. The query is expanded into multiple variants: the original text, its Marathi translation, its normalized form, and individual words translated via the Hinglish dictionary. All variants are searched and results are merged and deduplicated.

#### Barcode and QR Scanner

The camera icon (📷) opens the device camera using html5-qrcode. Supported formats: EAN-13, EAN-8, UPC-A, UPC-E, CODE-128, CODE-39, QR codes.

When a barcode is scanned, the app looks for a matching item in inventory by `barcode` field or `id` field. If found, the add-to-cart modal opens directly. If not found, Fuse.js fuzzy search is run on the scanned code.

#### Voice Search

The microphone button (🎙️) activates the Web Speech API. This requires an internet connection. It works best on Chrome and Edge browsers.

Language used: Marathi (mr-IN) when IME is ON, English-Indian (en-IN) when IME is OFF.

**Multi-alternative selection:** The API returns up to 3 alternative transcripts. The app runs a Fuse.js search on each and picks the one that produces the most matches.

**Live interim results:** Text appears in the search box while you are still speaking.

**Marathi number words recognized:** एक, दोन, तीन, चार, पाच, सहा, सात, आठ, नऊ, दहा, पन्नास, शंभर

**Hinglish numbers recognized:** ek, don, teen, char, paach

**Grocery fractions recognized:**

| Spoken Word | Quantity |
|---|---|
| छटाक / chatak | 50g |
| पावशेर / pavsher | 250g |
| पाव किलो / pav | 250g |
| पाऊण / paun | 750g |
| अर्धा / ardha | 500g |
| सव्वा / savva | 1.25 (of item unit) |
| दीड / deedh | 1.5 (of item unit) |
| अडीच / adich | 2.5 (of item unit) |

**Unit detection:** Recognizes g, gram, kg, kilo, ml, liter, l, packet, pcs after the quantity.

**Price detection:** Recognizes patterns like "mrp 50", "rupees 80", "₹100" to help rank the correct SKU variant from multiple options with the same name.

**Auto-confirm:** If the speech confidence score is above 0.75 and exactly one product matches, the add-to-cart modal opens automatically without any tap.

**Smart quantity logic:**
- If the item unit contains a digit (like "200g", "500ml") or is a piece-type unit (pcs, pack, bottle, box) AND the voice specified a small weight unit (g or ml) — then the weight was spoken to identify which variant to buy, not how much to buy. Cart quantity is set to 1.
- If the item unit is a bulk unit (kg, g, l, ml as the full unit) — the voice quantity IS the purchase amount. Cart quantity is set to what was spoken.
- Example: "colgate 200 gram" finds the Colgate 200g tube and adds 1 piece to cart.
- Example: "sakkhar 5 kilo" finds Sugar and adds 5 kg to cart.

#### Add-to-Cart Modal

After selecting a product (from search, voice, or barcode scan), this modal appears.

Shows a large QUANTITY input and a RATE (price) input. A unit selector dropdown lets you switch between the item's native unit and g, kg, l, ml, box, dozen, pcs. When the unit changes, the multiplier is recalculated so the total remains correct (e.g. buying 500g of a 1 kg item at Rs 80/kg gives a total of Rs 40).

Enter key moves focus from quantity to rate to submit.

When an item is added, the app speaks the item name aloud via the browser's Text-to-Speech (speechSynthesis).

#### Cart

Desktop view: Table with columns — Product, Qty, Rate, Total, Edit, Delete.

Mobile view: Cards per item with the same data. Automatically switches when screen width is below 992px.

The Edit button reopens the modal pre-filled with the item's current quantity and rate.

#### Customer Button

Opens a modal to enter the customer's name and mobile number. These are attached to the generated receipt and searchable in the Customer Directory tab.

#### Send to Owner

This button is shown in the billing header (green). When clicked:
1. A new review session document is created in Firestore (`reviews/{uuid}`).
2. The app subscribes to that document for real-time status updates.
3. WhatsApp opens with a pre-written message containing the total, item count, and a direct link to the review page.

While waiting, a yellow banner shows "Waiting for owner approval". When the owner approves, the banner turns green with an "Apply Rates" button. When rejected, the banner turns red with the owner's reason.

"Apply Rates" replaces the cart with the owner's updated cart and removes the banner.

#### Checkout

Finalizes the bill. A bill number is generated in format `AA-DDMM-###` (for example AA-0305-007, meaning 3rd May, bill number 7 for that day). The receipt is saved to IndexedDB. The Receipt Share modal opens.

#### Receipt Share Modal

Shows a receipt card preview. Share options:

- WhatsApp — sends a text-formatted bill
- Share Image — uses the native device share sheet with a PNG image (html2canvas screenshot)
- Download Image — saves the receipt PNG to the device
- Print — triggers the browser print dialog, formatted for 80mm thermal printer paper

---

### Tab 2 — Inventory (यादी)

**Excel Upload:** Accepts .xlsx, .xls, .csv files. Column mapping: SKU_ID, Marathi_Name, English_Name, Selling_Price_INR, Purchase_Price_INR, Stock_Quantity, Weight_Volume. Duplicate items are removed before saving.

**Excel Export:** Downloads current inventory (including all cloud-synced edits) as `Updated_Inventory.xlsx`.

**Add New Item:** Opens the edit modal with blank fields and an auto-generated SKU ID.

**Search bar:** Hinglish-aware. Tries substring match first, falls back to Fuse.js fuzzy search. IME toggle applies.

**Kirana-style cards:** Each item shows Marathi name, English name, brand name (blue), unit, purchase price (red, with strikethrough if there is a discount), sale price (green), stock count.

A red "⚠ कमी" warning appears when stock is below 10. A discount percentage badge appears when sale price is lower than purchase price.

**Star Favourites:** Tap the star to pin an item to the top of the list. Favourite status is saved in IndexedDB and persists between sessions.

**Pagination:** 10 items per page. Favourites always appear above the paged list regardless of the page number.

**Edit Modal:** Tap any card to open. Fields: name, barcode (with camera scan button), purchase rate, sale rate, stock quantity, unit. Save writes to Firestore (syncs to all devices). Delete marks the item as removed in Firestore (disappears from all devices).

---

### Tab 3 — Reports (अहवाल)

Shows the total net profit from all sales stored in IndexedDB. A Refresh button recalculates it.

**Backup:** Downloads a JSON file containing full inventory, all sales receipts, and the bill counter. Used to transfer data between devices or as a safety backup.

**Restore:** Upload a previously downloaded backup JSON to replace all local data.

---

### Tab 4 — Customers (ग्राहक)

Lists all unique customers from completed bills, identified by their phone number or name.

For each customer: name, phone, number of bills, total amount spent. Expandable to see each individual bill number and amount.

---

### Tab 5 — Receipts (पावती)

Full list of all completed bills, newest first. Tap any entry to see the full itemized receipt.

From the receipt detail view: "Share Again" reopens the WhatsApp share. "Load to Cart and Edit" puts the receipt items back into the billing cart for re-billing or correction.

---

## 7. Owner App — All Features

The owner sees a two-tab app that uses the same CSS and visual style as the cashier's app.

### Tab 1 — Bills (📋)

Lists all bill review requests sent by cashiers.

Two sub-tabs: Pending (showing count badge) and All Bills (full history).

Each session card shows customer name, cashier name, item count, total amount, and time since creation.

Tap a pending card to open the full review page.

#### Owner Review Page

This screen looks identical to the cashier's billing UI.

**Add Item from Inventory:** A full search bar at the top with Fuse.js autocomplete against the same inventory. Hinglish IME toggle included. Tap a suggestion to open an add-item modal with quantity and rate inputs showing a live total preview. Confirm to add the item to the bill.

**Cart editing:** Each item in the cart has inline quantity and rate input fields.

Desktop: Table format with inputs per row.
Mobile: Card format with labeled inputs stacked vertically.

Delete button removes any item from the bill.

**Total bar:** Sticky bar showing running total and item count.

**Note to Cashier:** Free-text field. The cashier sees this text in the approval banner.

**Fixed action bar at bottom:**
- Reject button: marks the review as rejected. Cashier is notified immediately.
- Approve and Send button: saves the edited cart and notes to Firestore. Cashier's screen updates within one second.

After approving or rejecting, the screen returns to the dashboard.

---

### Tab 2 — Inventory (📦)

Completely identical to the cashier's Inventory tab. Same UI, same features, same Firestore sync. Any edit made by the owner is immediately visible to the cashier and vice versa.

---

## 8. Real-Time Sync — How Owner and Cashier Stay in Sync

### Inventory Sync Architecture

```
inventory.json  (9,999 base items — static file, loaded once on startup)
        |
        + merged with
        |
Firestore: inventory_overrides/{item.id}
        |   Each document = one item that was edited, added, or deleted
        |   _deleted: true means the item was removed
        |   _updatedAt: timestamp of the last change
        |
        v
applyInventoryOverrides(base, overrides)
        |   Overwritten items replace the base version
        |   _deleted items are excluded from the result
        |   New items are appended
        v
merged inventory  ->  React state + cached in IndexedDB
```

An `onSnapshot` listener on the `inventory_overrides` Firestore collection runs continuously on both the owner and cashier device. When the owner edits a price, a Firestore document is written. The cashier's listener fires within one second. The cashier's inventory re-merges, the Fuse.js search index rebuilds, and the new price is immediately searchable.

The same happens in reverse: cashier edits stock, owner sees it instantly.

Excel Export always exports from the merged in-memory inventory, so the downloaded file always reflects all changes from both devices.

### Bill Review Sync Architecture

```
Firestore: reviews/{uuid}
  Fields:
    status: 'pending' | 'approved' | 'rejected'
    cart: CartItem[]          <- original cashier cart
    updatedCart: CartItem[]   <- owner's edited cart (set when approved)
    ownerNotes: string        <- message from owner to cashier
    cashierName, cashierEmail
    customerName, customerPhone
    createdAt, approvedAt, rejectedAt
```

An `onSnapshot` listener on the specific review document runs on the cashier's device while a review is pending. When the owner writes `status: 'approved'`, the cashier's listener fires and the banner updates within one second.

---

## 9. Authentication Flow

```
main.tsx renders <AuthGate>
    |
    |-- No user saved in localStorage -> LoginPage shown
    |       |
    |       `-- Google returns JWT credential token
    |           App decodes JWT payload inline (no extra library):
    |             base64url decode -> JSON.parse -> { name, email, picture }
    |           User object saved to localStorage as 'nexus_auth_user'
    |
    |-- URL contains ?review=<id> -> OwnerApp with that review pre-opened
    |     (anyone with the WhatsApp link can review bills, not just the owner email)
    |
    |-- user.email === VITE_OWNER_EMAIL -> OwnerApp
    |
    `-- any other email -> Cashier App
```

**AuthContext** (src/contexts/AuthContext.tsx):

- `user` — object with name, email, picture. Stored in localStorage for session persistence across page reloads.
- `isOwner` — true only when user.email exactly matches VITE_OWNER_EMAIL.
- `login(user)` — sets user in state and saves to localStorage.
- `logout()` — calls googleLogout(), clears state and localStorage.

---

## 10. Data Storage — What is Stored Where

| Data | Storage | Key | Scope |
|---|---|---|---|
| Auth session | localStorage | nexus_auth_user | Device only |
| Inventory (merged base + overrides) | IndexedDB (localforage) | custom_inventory | Device, synced via Firestore |
| Sales receipts | IndexedDB (localforage) | sales | Device only |
| Daily bill counter | IndexedDB (localforage) | bill_counter | Device only |
| Favourite item IDs | IndexedDB (localforage) | favorite_ids | Device only |
| Inventory edits, additions, deletions | Firestore | inventory_overrides/{id} | Cloud — all devices |
| Bill review sessions | Firestore | reviews/{uuid} | Cloud — all devices |

**Why this split:**

Sales and receipts are local to each cashier device. There is no need to share billing history with every device.

Inventory changes must be shared between owner and cashier, so they go to Firestore.

Review sessions must pass between the cashier device and the owner device, so they go to Firestore.

If Firebase is not configured, the app runs entirely in local mode. Inventory edits and bill reviews require Firebase.

---

## 11. Voice Search — How It Works

```
User taps the microphone button
    |
    v
Web Speech API starts listening  (mr-IN or en-IN depending on IME toggle)
    |
    |-- Interim results -> live text shows in search box while speaking
    |
    `-- Final result -> up to 3 alternative transcripts returned
            |
            v
    For each alternative:
        Run translateHinglishToMarathi() to get Marathi equivalent
        Run fuse.search() and count how many results come back
    Pick the alternative with the most Fuse.js matches
            |
            v
    Parse the chosen transcript:
        - Convert Marathi and Hindi number words to digits
        - Detect grocery fractions (chatak, pavsher, ardha, etc.)
        - Extract explicit numbers
        - Extract unit (g, kg, ml, l, packet, pcs)
        - Extract price signal (mrp 50, rupees 80, Rs 100)
            |
            v
    Build search query: productName + unitSuffix + priceSuffix
    Examples: "colgate 200g", "sakkhar 5kg", "ghee Rs500"
            |
            v
    setQuery() triggers the suggestion useEffect which runs the full search pipeline
            |
            v
    If confidence > 0.75 AND exactly 1 suggestion found:
        Auto-open add-to-cart modal (no tap needed)
```

---

## 12. Inventory System — How It Works

### Loading Sequence on App Start

```
Step 1: fetch('/inventory.json')           <- 9,999 items from static file
        |
        |-- success -> cache to IndexedDB ('custom_inventory')
        `-- fail    -> use IndexedDB cache (offline fallback)
        |
        v
Step 2: baseInventoryRef.current = items   <- store raw base for merging

Step 3: subscribeToInventoryOverrides()    <- Firestore real-time listener starts
        |
        `-- on each snapshot (fires immediately + on every change):
              applyInventoryOverrides(base, overrides)
              -> setInventory(merged)
              -> setFuse(new Fuse(merged, ...))
              -> localforage.setItem('custom_inventory', merged)
```

### Saving an Item Edit

```
Owner or cashier edits an item -> clicks SAVE CHANGES
    |
    v
saveInventoryItemToCloud(item)
    -> setDoc(db, 'inventory_overrides', item.id, { ...item, _updatedAt: Date.now() })
    |
    v
Firestore onSnapshot fires on ALL connected devices within ~1 second
    |
    v
Each device re-merges base + overrides -> updates UI + IndexedDB cache
```

### Deleting an Item

```
removeInventoryItemFromCloud(id)
    -> setDoc(db, 'inventory_overrides', id, { _deleted: true, _updatedAt: Date.now() })
    |
    v
applyInventoryOverrides() sees _deleted: true -> removes from map
    |
    v
Item disappears from inventory on all devices within ~1 second
```

### Excel Bulk Upload

The uploaded Excel file is parsed with the xlsx library. Items are deduplicated by clean formatted name. The result is saved to localforage on the uploading device only.

Note: Bulk uploads do NOT write to Firestore to avoid the cost of writing thousands of documents at once. Only individual add, edit, and delete operations sync to the cloud. If you upload a new Excel on one device, run the upload on both devices for consistency.

---

## 13. Bill Review Workflow — Step by Step

```
CASHIER DEVICE                         OWNER DEVICE
-----------------------------------------------------------------------
1. Build cart (add items by search,
   voice, or barcode)

2. Optionally enter customer name
   and phone number

3. Click "Send to Owner" (green button)
   -> createReview(session) writes to Firestore
   -> WhatsApp opens with message:
      "Bill Review Request - 5 items - Rs 450"
      + direct link: yourapp.com/?review=<uuid>
   -> Yellow banner: "Waiting for owner..."
   -> Firestore onSnapshot listener starts

                                   4. Owner receives WhatsApp message
                                      Owner taps the link

                                   5. OwnerReviewPage loads
                                      (identified by ?review= in URL)
                                      Shows the full bill in POS-style UI

                                   6. Owner can:
                                      - Edit any item's rate or quantity inline
                                      - Delete items from the bill
                                      - Add new items from inventory search
                                      - Add a note for the cashier

                                   7. Owner clicks "Approve and Send"
                                      -> approveReview() writes to Firestore:
                                           status: 'approved'
                                           updatedCart: [edited items]
                                           ownerNotes: "..."
                                           approvedAt: timestamp

8. onSnapshot fires within ~1 second
   Green banner: "Owner approved the rates!"
   Owner's note shown below

9. Cashier clicks "Apply Rates"
   -> cart replaced with owner's updatedCart
   -> banner dismissed

10. Cashier clicks CHECKOUT
    -> saveSale() saves to IndexedDB
    -> Bill number generated: AA-DDMM-###
    -> Receipt Share modal opens

11. Share via WhatsApp, image, or print
```

**Rejection flow:** Owner clicks Reject -> Firestore status becomes 'rejected' -> Cashier sees red banner with reason -> Cashier can dismiss it and proceed with the original cart or make changes.

---

## 14. Environment Variables

File: `.env` in the root of the project. Never commit this file to git.

```
# Google OAuth — get from Google Cloud Console
VITE_GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com

# Owner configuration
VITE_OWNER_EMAIL=rajendragvb2801@gmail.com
VITE_OWNER_PHONE=917385391971
VITE_APP_URL=http://localhost:5173

# Firebase — get from Firebase Console -> Project Settings -> Your Apps
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=nexus-pos-817c3.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=nexus-pos-817c3
VITE_FIREBASE_STORAGE_BUCKET=nexus-pos-817c3.firebasestorage.app
VITE_FIREBASE_MESSAGING_SENDER_ID=...
VITE_FIREBASE_APP_ID=...
VITE_FIREBASE_MEASUREMENT_ID=...
```

If Firebase keys are missing, the app works fully as a local-only POS. Inventory real-time sync and bill reviews are disabled until Firebase is configured.

When deploying to production, change VITE_APP_URL to your live domain so that WhatsApp review links point to the correct address.

---

## 15. Commands to Run the App

```bash
# Install all dependencies (run once after cloning)
npm install

# Start development server at http://localhost:5173
npm run dev

# Expose on local network so phones on the same WiFi can open it
npm run dev -- --host

# Build for production (TypeScript check + Vite bundle)
npm run build

# Preview the production build locally
npm run preview

# Convert inventory Excel to JSON (run whenever inventory_data.xlsx changes)
python convert_inventory.py

# Deploy Firestore security rules to Firebase
firebase deploy --only firestore:rules
```

---

## Firestore Collections Reference

| Collection | Document ID | Fields | Purpose |
|---|---|---|---|
| reviews | UUID (random) | status, cart, updatedCart, ownerNotes, cashierName, customerName, createdAt | Bill review sessions between cashier and owner |
| inventory_overrides | Item SKU ID | All InventoryItem fields + _updatedAt, or _deleted: true | Individual inventory changes synced across all devices |

**Firestore Security Rules:** Any logged-in Google user can read and write both collections. This means any staff member with a Google account can sync inventory and send reviews.

---

## PWA — Installable as a Mobile App

The app is configured as a Progressive Web App.

On Android (Chrome): A banner appears to install. Tap "Add to Home Screen".

On iOS (Safari): Tap the Share button, then "Add to Home Screen".

Once installed, the app looks and feels like a native app with no browser address bar.

The service worker caches all app assets so the UI loads instantly even offline. Firestore sync and voice search require an internet connection. Text search, billing, and receipt viewing all work fully offline.

---

*Documentation — Nexus React POS — Rajendra GVB Kirana Store — May 2026*
