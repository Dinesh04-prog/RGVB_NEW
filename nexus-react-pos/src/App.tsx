import React, { useState, useEffect, useRef } from "react";
import { useAuth } from "./contexts/AuthContext";
import {
  createReview, subscribeToReview, isFirebaseReady,
  saveInventoryItemToCloud, removeInventoryItemFromCloud,
  subscribeToInventory, bulkSaveInventoryToFirestore,
} from "./lib/firebase";
import type { ReviewSession } from "./lib/firebase";
import { Html5Qrcode, Html5QrcodeSupportedFormats } from "html5-qrcode";
import Fuse from "fuse.js";
import localforage from 'localforage';
import html2canvas from 'html2canvas';
import { saveSale, getSalesHistory } from "./lib/db";
import type { CartItem, Receipt } from "./lib/db";
import { translateHinglishToMarathi, transliterateDevanagariToLatin, normalizeForSearch, HINGLISH_TO_MARATHI, parseUserQuery, scoreCandidate } from "./lib/phonetic";

interface InventoryItem {
  id: string;
  name: string;
  name_marathi?: string;
  name_eng?: string;
  brand?: string;
  search_key?: string;
  unit: string;
  price: number;
  stock_quantity?: number;
  stock_qty?: number;
  purchase_price?: number;
  barcode?: string;
  unit_rates?: Record<string, number>; // per-unit custom rates e.g. { bag: 550, kg: 120, "250g": 15 }
}

const getUnitMultiplier = (targetUnit: string, baseUnit: string) => {
  const t = targetUnit.trim().toLowerCase();
  const b = baseUnit.trim().toLowerCase();
  if (t === b) return 1;

  const isKg = (u: string) => /^(kg|kilo|kilograms?|kilos?)$/.test(u);
  const isG = (u: string) => /^(g|gm|grams?)$/.test(u);
  const isL = (u: string) => /^(l|lit|liters?|litres?)$/.test(u);
  const isMl = (u: string) => /^(ml|mili|mililiters?|milliliters?|mal)$/.test(u);
  const isPcs = (u: string) => /^(pc|pcs|pieces?|units?|nos?|numbers?|pack|packet|box)$/.test(u);
  const isDozen = (u: string) => /^(dz|dozens?|dzn)$/.test(u);

  if (isG(t) && isKg(b)) return 1 / 1000;
  if (isKg(t) && isG(b)) return 1000;
  if (isMl(t) && isL(b)) return 1 / 1000;
  if (isL(t) && isMl(b)) return 1000;
  if (isDozen(t) && isPcs(b)) return 12;
  if (isPcs(t) && isDozen(b)) return 1 / 12;

  return 1;
};

export default function App() {
  const { user, logout } = useAuth();
  const [activeTab, setActiveTab] = useState("billing");
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [fuse, setFuse] = useState<Fuse<InventoryItem> | null>(null);

  // Billing state
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<InventoryItem[]>([]);
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(-1);
  const [cart, setCart] = useState<CartItem[]>([]);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const rateInputRef = useRef<HTMLInputElement>(null);
  const totalInputRef = useRef<HTMLInputElement>(null);
  const [isDictating, setIsDictating] = useState(false);

  // Inventory state
  const [stockQuery, setStockQuery] = useState("");
  const [imeEnabled, setImeEnabled] = useState(true);
  const [stockPage, setStockPage] = useState(1);
  const ITEMS_PER_PAGE = 10;
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());
  const [brandIndex, setBrandIndex] = useState<Set<string>>(new Set());
  const xlsxFileHandleRef = useRef<any>(null);
  const [xlsxFileName, setXlsxFileName] = useState<string>("");
  const [uploadStatus, setUploadStatus] = useState<string>("");
  const [isEditVoiceActive, setIsEditVoiceActive] = useState(false);
  const [newRateUnit, setNewRateUnit] = useState("");
  const [newRateValue, setNewRateValue] = useState("");

  // Hold & Resume
  const [heldBills, setHeldBills] = useState<{ id: string; cart: CartItem[]; customerName: string; customerPhone: string; heldAt: number }[]>([]);
  const [showHeldBills, setShowHeldBills] = useState(false);

  // Reports state
  const [totalProfit, setTotalProfit] = useState(0);
  const [allSales, setAllSales] = useState<Receipt[]>([]);

  // Customer state
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [lastReceipt, setLastReceipt] = useState<Receipt | null>(null);
  const [isCustomerModalOpen, setIsCustomerModalOpen] = useState(false);
  const [receiptShareOpen, setReceiptShareOpen] = useState(false);
  const [viewingReceipt, setViewingReceipt] = useState<Receipt | null>(null);
  const [receiptFromDate, setReceiptFromDate] = useState("");
  const [receiptToDate, setReceiptToDate] = useState("");
  const [receiptSearch, setReceiptSearch] = useState("");
  const receiptCardRef = useRef<HTMLDivElement>(null);

  const formatName = (name: string) => {
    return (name || "").replace(/\s*\([\d\.\s]*(kg|g|gm|ml|l|L|Piece|Pack|Pack of \d+|unit|liter|litre)\)\s*$/i, "").trim();
  };

  const fuseOptions = {
    keys: [
      { name: "search_key",   weight: 3   },
      { name: "name_marathi", weight: 1.5 },
      { name: "name",         weight: 1   },
      { name: "name_eng",     weight: 1   },
      { name: "brand",        weight: 1   },
      { name: "id",           weight: 0.5 },
      { name: "barcode",      weight: 0.5 },
    ],
    threshold: 0.45, ignoreLocation: true, distance: 300,
    minMatchCharLength: 2, shouldSort: true, includeScore: true,
  };

  // Load Inventory
  useEffect(() => {
    if (invOverridesUnsubRef.current) invOverridesUnsubRef.current();

    if (isFirebaseReady) {
      // Firebase mode: Firestore is the source of truth.
      // Show cached data instantly while Firestore loads.
      localforage.getItem('custom_inventory').then((cached) => {
        if (cached && Array.isArray(cached) && (cached as InventoryItem[]).length > 0) {
          setInventory(cached as InventoryItem[]);
          setFuse(new Fuse(cached as InventoryItem[], fuseOptions));
        }
      });
      // Subscribe to full inventory — fires on every add/edit/delete.
      invOverridesUnsubRef.current = subscribeToInventory(items => {
        if (items.length > 0) {
          localforage.setItem('custom_inventory', items);
          setInventory(items);
          setFuse(new Fuse(items, fuseOptions));
        }
      });
    } else {
      // Offline-only mode: load from LocalForage or inventory.json fallback.
      const loadLocal = async () => {
        let items: InventoryItem[] = [];
        const cached = await localforage.getItem('custom_inventory') as InventoryItem[];
        if (cached && Array.isArray(cached) && cached.length > 0) {
          items = cached;
        } else {
          try {
            const res = await fetch("/inventory.json");
            if (res.ok) {
              const json = await res.json();
              if (Array.isArray(json) && json.length > 0) {
                items = json;
                await localforage.setItem('custom_inventory', json);
              }
            }
          } catch (_) {}
        }
        setInventory(items);
        setFuse(new Fuse(items, fuseOptions));
      };
      loadLocal();
    }

    return () => { if (invOverridesUnsubRef.current) invOverridesUnsubRef.current(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    localforage.getItem('favorite_ids').then((ids) => {
      if (ids && Array.isArray(ids)) setFavoriteIds(new Set(ids as string[]));
    });
    localforage.getItem('held_bills').then((bills) => {
      if (bills && Array.isArray(bills)) setHeldBills(bills as any);
    });
  }, []);

  // Rebuild brand index whenever inventory changes
  useEffect(() => {
    if (inventory.length > 0) {
      setBrandIndex(new Set(
        inventory.map(i => (i.brand || '').toLowerCase().trim()).filter(Boolean)
      ));
    }
  }, [inventory]);

  // Update reports on tab change
  useEffect(() => {
    if (activeTab === "reports" || activeTab === "customers" || activeTab === "receipts") {
      getSalesHistory().then((sales: Receipt[]) => {
        setAllSales(sales);
        const total = sales.reduce((acc: number, sale: Receipt) => acc + sale.total, 0);
        setTotalProfit(total);
      });
    }
  }, [activeTab]);

  useEffect(() => {
    setSelectedSuggestionIndex(-1);
    if (!query || !fuse) { setSuggestions([]); return; }

    const q = query.trim().toLowerCase();

    // ── Step 1: Fast path — exact/prefix search_key ────────────────────────
    const normQ0 = normalizeForSearch(q);
    const skMatches = inventory.filter(item => {
      const key = String(item.search_key || '').trim().toLowerCase();
      if (!key) return false;
      return key === q || key.startsWith(q) ||
             (normQ0 && normQ0 !== q && (key === normQ0 || key.startsWith(normQ0)));
    });
    if (skMatches.length > 0) {
      setSuggestions(
        [...skMatches]
          .sort((a, b) => String(a.search_key||'').length - String(b.search_key||'').length)
          .slice(0, 15)
      );
      return;
    }

    // ── Step 2: Structured intent parsing ─────────────────────────────────
    // Extracts brand, unit, and price signals from the query in both
    // English and Marathi, leaving the clean product name for fuzzy search.
    const parsed = parseUserQuery(query, brandIndex);
    // Store unit signals so selectItemForModal can pre-fill qty/unit in the cart modal
    lastParsedRef.current = (parsed.unitQty && parsed.unitType)
      ? { qty: parsed.unitQty, cartUnit: parsed.unitType }
      : null;
    const hasSignals = !!(parsed.brandHint || parsed.unitHint || parsed.priceHint);

    if (hasSignals) {
      // Build the name query variants (clean product name after signal extraction)
      const nameQ = parsed.cleanQuery || '';
      const buildVariants = (text: string): Set<string> => {
        const v = new Set<string>();
        if (!text) return v;
        v.add(text);
        const mr = translateHinglishToMarathi(text);
        if (mr && mr !== text) v.add(mr);
        const nr = normalizeForSearch(text);
        if (nr && nr !== text) v.add(nr);
        for (const word of text.split(/\s+/).filter(w => w.length >= 2)) {
          const d = HINGLISH_TO_MARATHI[word.toLowerCase()];
          if (d) { v.add(d); v.add(text.replace(word, d)); }
        }
        return v;
      };

      // Determine candidate pool: brand-filtered or full inventory
      let pool: InventoryItem[] = [];

      if (parsed.brandHint) {
        pool = inventory.filter(item => {
          const ib = (item.brand || '').toLowerCase();
          return ib === parsed.brandHint ||
                 ib.startsWith(parsed.brandHint!) ||
                 parsed.brandHint!.startsWith(ib);
        });
        // Fuzzy name search within brand pool
        if (nameQ && pool.length > 0) {
          const bFuse = new Fuse(pool, {
            keys: [{ name: 'search_key', weight: 3 }, { name: 'name_marathi', weight: 2 },
                   { name: 'name', weight: 2 }, { name: 'name_eng', weight: 1.5 }],
            threshold: 0.5, ignoreLocation: true, shouldSort: true, includeScore: true,
          });
          const bSeen = new Set<string>();
          const bResults: InventoryItem[] = [];
          for (const v of buildVariants(nameQ)) {
            for (const r of bFuse.search(v, { limit: 20 })) {
              if (!bSeen.has(r.item.id)) { bSeen.add(r.item.id); bResults.push(r.item); }
            }
          }
          pool = bResults.length > 0 ? bResults : pool;
        }
      } else if (nameQ) {
        // No brand detected — search full inventory by name
        const seen = new Set<string>();
        for (const v of buildVariants(nameQ)) {
          for (const r of fuse.search(v, { limit: 25 })) {
            if (!seen.has(r.item.id)) { seen.add(r.item.id); pool.push(r.item); }
          }
        }
      } else {
        // Only price/unit signals, no name — score all inventory items
        pool = inventory;
      }

      // Score each candidate by how well it satisfies the extracted signals.
      // Items matching all signals rank first; name-only matches appear below.
      const scored = pool
        .map(item => ({ item, bonus: scoreCandidate(item, parsed) }))
        .sort((a, b) => b.bonus - a.bonus);

      const results = scored.map(s => s.item).slice(0, 15);
      if (results.length > 0) { setSuggestions(results); return; }
      // Fall through to fuzzy pipeline if structured search found nothing
    }

    // ── Step 3: Multi-variant fuzzy pipeline (plain name queries) ──────────
    const words = q.split(/\s+/).filter(w => w.length >= 2);
    // Plain brand-scoped check (for queries without price/unit signals)
    if (!hasSignals) {
      for (const word of words) {
        const bItems = inventory.filter(item => {
          const b = (item.brand || '').toLowerCase();
          return b && (b === word || b.startsWith(word) || (word.length >= 4 && b.includes(word)));
        });
        if (bItems.length > 0 && bItems.length < inventory.length * 0.25) {
          const nameQ2 = words.filter(w => w !== word).join(' ').trim();
          if (nameQ2) {
            const bFuse2 = new Fuse(bItems, {
              keys: [{ name: 'search_key', weight: 3 }, { name: 'name', weight: 2 },
                     { name: 'name_marathi', weight: 2 }, { name: 'name_eng', weight: 2 }],
              threshold: 0.45, ignoreLocation: true, shouldSort: true, includeScore: true,
            });
            const br = bFuse2.search(nameQ2, { limit: 15 });
            if (br.length > 0) { setSuggestions(br.map(r => r.item)); return; }
          } else {
            setSuggestions(bItems.slice(0, 15)); return;
          }
        }
      }
    }

    // Multi-variant Fuse search (typo tolerance + Marathi translation + normalization)
    const marathiQ = translateHinglishToMarathi(query);
    const normQ    = normalizeForSearch(q);
    const variants = new Set<string>([query]);
    if (marathiQ && marathiQ !== query) variants.add(marathiQ);
    if (normQ    && normQ    !== q    ) variants.add(normQ);
    for (const w of words) {
      const d = HINGLISH_TO_MARATHI[w];
      if (d) { variants.add(d); variants.add(q.replace(w, d)); }
      const nw = normalizeForSearch(w); if (nw && nw !== w) variants.add(nw);
      const mw = translateHinglishToMarathi(w); if (mw && mw !== w) variants.add(mw);
    }
    const seen2  = new Set<string>();
    const merged: InventoryItem[] = [];
    for (const v of variants) {
      for (const r of fuse.search(v, { limit: 15 })) {
        if (!seen2.has(r.item.id)) { seen2.add(r.item.id); merged.push(r.item); }
      }
      if (merged.length >= 15) break;
    }
    // Token-level fallback for sparse multi-word results
    if (merged.length < 3 && words.length > 1) {
      for (const token of words) {
        for (const tv of [token, translateHinglishToMarathi(token), HINGLISH_TO_MARATHI[token]].filter(Boolean) as string[]) {
          for (const r of fuse.search(tv, { limit: 8 })) {
            if (!seen2.has(r.item.id)) { seen2.add(r.item.id); merged.push(r.item); }
          }
        }
      }
    }
    setSuggestions(merged.slice(0, 15));
  }, [query, fuse, inventory, brandIndex]);


  // Modals simulation state
  const [modalItem, setModalItem] = useState<{ item: InventoryItem | CartItem, qty: number, rate: number, isEdit: boolean, index: number | null, cartUnit: string, multiplier: number } | null>(null);
  const [voiceContext, setVoiceContext] = useState<{ qty: number, cartUnit: string } | null>(null);
  const lastParsedRef = useRef<{ qty: number; cartUnit: string } | null>(null);
  const voiceConfidentRef = useRef(false);

  // Owner review state
  const [reviewStatus, setReviewStatus] = useState<'idle' | 'pending' | 'approved' | 'rejected'>('idle');
  const [approvedSession, setApprovedSession] = useState<ReviewSession | null>(null);
  const reviewUnsubRef = useRef<(() => void) | null>(null);
  const invOverridesUnsubRef = useRef<(() => void) | null>(null);
  const [inventoryEditItem, setInventoryEditItem] = useState<InventoryItem | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [torchSupported, setTorchSupported] = useState(false);
  const [scanFeedback, setScanFeedback] = useState("");
  const [scannedBarcode, setScannedBarcode] = useState<string | null>(null);
  const scannerRef = useRef<any>(null);
  // Stable refs so the scanner success callback always sees latest inventory/fuse
  const inventoryRef = useRef<InventoryItem[]>([]);
  const fuseRef = useRef<Fuse<InventoryItem> | null>(null);
  useEffect(() => { inventoryRef.current = inventory; }, [inventory]);
  useEffect(() => { fuseRef.current = fuse; }, [fuse]);

  const stopScanner = () => {
    if (scannerRef.current) {
      try { scannerRef.current.stop().catch(() => {}); } catch (_) {}
      scannerRef.current = null;
    }
  };

  // Process barcode after scanner has fully stopped
  useEffect(() => {
    if (!scannedBarcode || isScanning) return;
    const clean = scannedBarcode;
    setScannedBarcode(null);
    const inv = inventoryRef.current;
    const f   = fuseRef.current;
    const match = inv.find(i =>
      i.id.toLowerCase() === clean.toLowerCase() ||
      (i.barcode && i.barcode.toLowerCase() === clean.toLowerCase())
    );
    if (match) {
      selectItemForModal(match);
    } else {
      const results = f?.search(clean);
      if (results && results.length > 0) {
        selectItemForModal(results[0].item);
      } else {
        setQuery(clean);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scannedBarcode, isScanning]);

  useEffect(() => {
    if (!isScanning) {
      stopScanner();
      setTorchOn(false);
      setTorchSupported(false);
      setScanFeedback("");
      return;
    }

    // Wait one tick so React has committed the #reader div to the DOM
    const tid = setTimeout(() => {
      if (!document.getElementById("reader")) { setIsScanning(false); return; }

      let scanner: any;
      try {
        scanner = new Html5Qrcode("reader", {
          formatsToSupport: [
            Html5QrcodeSupportedFormats.EAN_13,
            Html5QrcodeSupportedFormats.EAN_8,
            Html5QrcodeSupportedFormats.UPC_A,
            Html5QrcodeSupportedFormats.UPC_E,
            Html5QrcodeSupportedFormats.CODE_128,
            Html5QrcodeSupportedFormats.CODE_39,
            Html5QrcodeSupportedFormats.QR_CODE,
          ],
          verbose: false,
        });
      } catch (_) { setIsScanning(false); return; }

      scannerRef.current = scanner;

      scanner.start(
        { facingMode: "environment" },
        {
          fps: 10,
          qrbox: { width: 250, height: 100 },  // narrow strip — best for EAN-13 / Code-128
          aspectRatio: 1.7778,
        },
        (decodedText: string) => {
          const clean = decodedText.trim();
          setScanFeedback(`✓ ${clean}`);
          scanner.stop()
            .then(() => { setIsScanning(false); setScannedBarcode(clean); })
            .catch(() =>  { setIsScanning(false); setScannedBarcode(clean); });
        },
        () => {}   // per-frame error — ignore
      ).then(() => {
        try {
          const caps = scanner.getRunningTrackCapabilities?.() as any;
          if (caps?.torch) setTorchSupported(true);
        } catch (_) {}
      }).catch((err: any) => {
        console.error("Camera error:", err);
        setIsScanning(false);
        alert("Could not access camera. Please allow camera permission in your browser and reload.");
      });
    }, 100);

    return () => { clearTimeout(tid); stopScanner(); };
  }, [isScanning]); // only isScanning — inventory/fuse accessed via refs

  const toggleTorch = async () => {
    if (!scannerRef.current || !torchSupported) return;
    try {
      await scannerRef.current.applyVideoConstraints({ advanced: [{ torch: !torchOn }] });
      setTorchOn(t => !t);
    } catch (_) {}
  };

  const saveInventoryEdit = async () => {
    if (!inventoryEditItem) return;
    const exists = inventory.find(i => i.id === inventoryEditItem.id);
    const newInv = exists
      ? inventory.map(i => i.id === inventoryEditItem.id ? inventoryEditItem : i)
      : [...inventory, inventoryEditItem];
    // Always update local state immediately so the UI reflects the change
    setInventory(newInv);
    await localforage.setItem('custom_inventory', newInv);
    setFuse(new Fuse(newInv, { keys: [{ name: "search_key", weight: 3 }, { name: "name_marathi", weight: 1.5 }, { name: "name", weight: 1 }, { name: "name_eng", weight: 1 }, { name: "brand", weight: 1 }], threshold: 0.45, ignoreLocation: true, distance: 300, minMatchCharLength: 2, shouldSort: true, includeScore: true }));
    // Best-effort Firebase sync — never block the save on network
    try { await saveInventoryItemToCloud(inventoryEditItem); } catch (err) { console.error("Firebase sync failed:", err); }
    await syncInventoryToXlsx(newInv);
    setInventoryEditItem(null);
  };

  const toggleFavorite = (id: string) => {
    setFavoriteIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      localforage.setItem('favorite_ids', Array.from(next));
      return next;
    });
  };

  const deleteInventoryItem = async () => {
    if (!inventoryEditItem) return;
    const itemName = inventoryEditItem.name_marathi || inventoryEditItem.name || "this item";
    if (!confirm(`Delete "${itemName}" from inventory? This cannot be undone.`)) return;
    const newInv = inventory.filter(i => i.id !== inventoryEditItem.id);
    // Always update local state immediately
    setInventory(newInv);
    await localforage.setItem('custom_inventory', newInv);
    setFuse(new Fuse(newInv, { keys: [{ name: "search_key", weight: 3 }, { name: "name_marathi", weight: 1.5 }, { name: "name", weight: 1 }, { name: "name_eng", weight: 1 }, { name: "brand", weight: 1 }], threshold: 0.45, ignoreLocation: true, distance: 300, minMatchCharLength: 2, shouldSort: true, includeScore: true }));
    // Best-effort Firebase sync
    try { await removeInventoryItemFromCloud(inventoryEditItem.id); } catch (err) { console.error("Firebase sync failed:", err); }
    await syncInventoryToXlsx(newInv);
    setInventoryEditItem(null);
  };

  const editModalKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const modal = (e.currentTarget as HTMLElement).closest('.modal-content');
    if (!modal) return;
    const inputs = Array.from(modal.querySelectorAll('input[type="text"], input[type="number"]')) as HTMLInputElement[];
    const idx = inputs.indexOf(e.currentTarget);
    if (idx >= 0 && idx < inputs.length - 1) {
      inputs[idx + 1].focus();
      inputs[idx + 1].select();
    } else {
      saveInventoryEdit();
    }
  };

  const parseInventoryVoice = (raw: string): { name: string; unit: string } => {
    let t = raw.toLowerCase().trim();
    // Normalize spoken numbers
    t = t.replace(/एक/g,'1').replace(/दोन/g,'2').replace(/तीन/g,'3').replace(/चार/g,'4')
         .replace(/पाच/g,'5').replace(/सहा/g,'6').replace(/सात/g,'7').replace(/आठ/g,'8')
         .replace(/नऊ/g,'9').replace(/दहा/g,'10').replace(/पन्नास/g,'50').replace(/शंभर/g,'100');

    let unit = '';
    // Traditional Indian units first
    if (/(छटाक|चटाक|chatak|chatk|chhatak)/.test(t)) {
      unit = '50g';
      t = t.replace(/(छटाक|चटाक|chatak|chatk|chhatak)/g, '');
    } else if (/(पावशेर|pavsher|pav sher)/.test(t)) {
      unit = '250g';
      t = t.replace(/(पावशेर|pavsher|pav sher)/g, '');
    } else if (/(पाव किलो|paav kilo|pav kilo|quarter kg)/.test(t)) {
      unit = '250g';
      t = t.replace(/(पाव किलो|paav kilo|pav kilo|quarter kg)/g, '');
    } else if (/(पाऊण किलो|तीन चतुर्थ|paun|pahun|three quarter)/.test(t)) {
      unit = '750g';
      t = t.replace(/(पाऊण किलो|तीन चतुर्थ|paun|pahun|three quarter)/g, '');
    } else if (/(अर्धा किलो|अर्धा|ardha|half kg)/.test(t)) {
      unit = '500g';
      t = t.replace(/(अर्धा किलो|अर्धा|ardha|half kg)/g, '');
    } else if (/(पाव|paav|pav\b)/.test(t)) {
      unit = '250g';
      t = t.replace(/(पाव|paav|pav\b)/g, '');
    } else {
      // Number + unit (e.g. "250 gram", "5 kilo", "500 ml")
      const m = t.match(/([\d.]+)\s*(किलो|kilo\b|kg\b|ग्राम|gram\b|gm\b|g\b|ml\b|मिली|liter\b|litre\b|l\b|pcs\b|piece\b|pack\b|packet\b)/i);
      if (m) {
        const qty = parseFloat(m[1]);
        const u = m[2].toLowerCase();
        t = t.replace(m[0], '');
        if (/किलो|kilo|kg/.test(u))       unit = qty >= 100 ? `${qty}g`  : `${qty}kg`;
        else if (/ग्राम|gram|gm/.test(u) || u === 'g') unit = `${qty}g`;
        else if (/ml|मिली/.test(u))        unit = `${qty}ml`;
        else if (/liter|litre/.test(u) || u === 'l') unit = qty >= 100 ? `${qty}ml` : `${qty}L`;
        else                               unit = `${qty} ${u}`;
      }
    }
    return { name: t.replace(/\s+/g, ' ').trim(), unit };
  };

  const startEditVoice = () => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) { alert("Voice recognition is not supported in this browser."); return; }
    const recognition = new SpeechRecognition();
    recognition.lang = 'mr-IN';
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.onstart = () => setIsEditVoiceActive(true);
    recognition.onend = () => setIsEditVoiceActive(false);
    recognition.onerror = (err: any) => {
      setIsEditVoiceActive(false);
      if (err.error === 'network') alert("Voice requires internet connection.");
      else if (err.error !== 'no-speech' && err.error !== 'aborted') console.warn("Voice error:", err.error);
    };
    recognition.onresult = (event: any) => {
      const result = event.results[event.results.length - 1];
      const text = result[0].transcript;
      if (!result.isFinal) {
        // Show interim text live in name field
        setInventoryEditItem(prev => prev ? { ...prev, name_marathi: text, name: text } : prev);
        return;
      }
      const { name, unit } = parseInventoryVoice(text);
      const marathiName = name ? (translateHinglishToMarathi(name) || name) : text;
      setInventoryEditItem(prev => {
        if (!prev) return prev;
        return {
          ...prev,
          name_marathi: marathiName,
          name: marathiName,
          ...(unit ? { unit } : {}),
        };
      });
    };
    recognition.start();
  };

  const toggleEditNameLanguage = () => {
    if (!inventoryEditItem) return;
    const current = inventoryEditItem.name_marathi || inventoryEditItem.name || '';
    const hasDevanagari = /[ऀ-ॿ]/.test(current);
    if (hasDevanagari) {
      const latin = transliterateDevanagariToLatin(current);
      setInventoryEditItem({ ...inventoryEditItem, name_marathi: latin, name: latin });
    } else {
      const marathi = translateHinglishToMarathi(current);
      setInventoryEditItem({ ...inventoryEditItem, name_marathi: marathi, name: marathi });
    }
  };

  const loadReceiptToCart = (receipt: Receipt) => {
    setCart(receipt.items.map(item => ({ ...item })));
    setCustomerName(receipt.customerName || "");
    setCustomerPhone(receipt.customerPhone || "");
    setViewingReceipt(null);
    setActiveTab('billing');
  };

  const exportInventoryToExcel = async () => {
    try {
      const XLSX = await import("xlsx");
      const mappedData = inventory.map(i => ({
        SKU_ID: i.id,
        Item_Name: i.name,
        Marathi_Name: i.name_marathi,
        English_Name: i.name_eng,
        Weight_Volume: i.unit,
        Selling_Price_INR: i.price,
        Purchase_Price_INR: i.purchase_price || 0,
        Stock_Quantity: i.stock_quantity ?? i.stock_qty ?? 0
      }));
      const ws = XLSX.utils.json_to_sheet(mappedData);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Inventory");
      XLSX.writeFile(wb, "Updated_Inventory.xlsx");
    } catch (err) {
      console.error(err);
      alert("Error exporting Excel file.");
    }
  };

  const sendToOwner = async () => {
    if (cart.length === 0) return;
    if (!isFirebaseReady) { alert('Firebase is not configured. Add your keys to .env first.'); return; }
    const id = crypto.randomUUID();
    const session: ReviewSession = {
      id,
      cashierName: user?.name ?? 'Cashier',
      cashierEmail: user?.email ?? '',
      customerName: customerName || 'Walk-in',
      customerPhone: customerPhone || '',
      cart: JSON.parse(JSON.stringify(cart)),
      status: 'pending',
      createdAt: Date.now(),
    };
    try {
      await createReview(session);
      setReviewStatus('pending');
      // Listen for owner's response
      if (reviewUnsubRef.current) reviewUnsubRef.current();
      reviewUnsubRef.current = subscribeToReview(id, (updated) => {
        if (!updated) return;
        if (updated.status === 'approved') {
          setReviewStatus('approved');
          setApprovedSession(updated);
          if (reviewUnsubRef.current) { reviewUnsubRef.current(); reviewUnsubRef.current = null; }
        } else if (updated.status === 'rejected') {
          setReviewStatus('rejected');
          setApprovedSession(updated);
          if (reviewUnsubRef.current) { reviewUnsubRef.current(); reviewUnsubRef.current = null; }
        }
      });
      // Open WhatsApp with review link
      const appUrl = import.meta.env.VITE_APP_URL || 'http://localhost:5173';
      const ownerPhone = import.meta.env.VITE_OWNER_PHONE || '';
      const link = `${appUrl}/?review=${id}`;
      const total = cart.reduce((s, i) => s + i.total, 0);
      const msg = `📋 *Bill Review Request*\n\nFrom: ${user?.name ?? 'Cashier'}\nCustomer: ${session.customerName}\nItems: ${cart.length} | Total: ₹${total.toFixed(0)}\n\nPlease review & update rates:\n${link}`;
      window.open(`https://wa.me/${ownerPhone}?text=${encodeURIComponent(msg)}`, '_blank');
    } catch (e) {
      alert('Could not send to owner. Check Firebase connection.');
      console.error(e);
    }
  };

  const applyOwnerRates = () => {
    if (!approvedSession?.updatedCart) return;
    setCart(approvedSession.updatedCart);
    setReviewStatus('idle');
    setApprovedSession(null);
  };

  const cancelReview = () => {
    if (reviewUnsubRef.current) { reviewUnsubRef.current(); reviewUnsubRef.current = null; }
    setReviewStatus('idle');
    setApprovedSession(null);
  };

  const selectItemForModal = (item: InventoryItem) => {
    let finalQty = 1;
    let finalCartUnit = item.unit || "unit";
    let finalMult = 1;

    if (voiceContext) {
      const rawUnit = item.unit || "unit";
      const baseUnit = rawUnit.toLowerCase();
      // Decide whether the voice qty is a purchase quantity or a variant spec.
      // A packaged item (unit contains a digit like "200g", or is "pcs/pack/bottle")
      // means the weight was spoken only to identify the SKU → buy 1 piece.
      // A loose/bulk item (unit is plain "kg", "g", "l", "ml") → buy voiceQty of that unit.
      const unitHasNumber = /\d/.test(rawUnit);
      const isPieceUnit = unitHasNumber ||
        /^(pcs?|pieces?|pack|packet|box|bottle|btl|nos?|tabs?|tablets?)$/i.test(baseUnit.replace(/[\d\s]/g, ''));
      const isSmallWeightVoice = /^(g|gm|ml)$/.test(voiceContext.cartUnit || '');

      if (voiceContext.cartUnit) {
        if (isPieceUnit && isSmallWeightVoice) {
          // e.g., "colgate 200 gram" — 200g identifies the SKU, cart gets 1 piece
          finalQty = 1;
          finalCartUnit = rawUnit;
          finalMult = 1;
        } else {
          // e.g., "sakkhar 5 kilo" — 5kg IS the purchase quantity
          finalQty = voiceContext.qty;
          finalCartUnit = voiceContext.cartUnit;
          finalMult = getUnitMultiplier(voiceContext.cartUnit, baseUnit);
        }
      } else {
        // No unit spoken — qty from voice, unit from item
        finalQty = voiceContext.qty;
        finalCartUnit = rawUnit;
      }
      setVoiceContext(null);
    } else if (lastParsedRef.current) {
      finalQty = lastParsedRef.current.qty;
      const baseUnit = (item.unit || "unit").toLowerCase();
      finalCartUnit = lastParsedRef.current.cartUnit;
      finalMult = getUnitMultiplier(lastParsedRef.current.cartUnit, baseUnit);
      lastParsedRef.current = null;
    }

    // Use per-unit custom rate if defined, otherwise fall back to base price + multiplier
    const customRate = item.unit_rates?.[finalCartUnit];
    const finalRate = customRate !== undefined ? customRate : (item.price || 0);
    const finalMultiplier = customRate !== undefined ? 1 : finalMult;

    setModalItem({
      item,
      qty: finalQty,
      rate: finalRate,
      isEdit: false,
      index: null,
      cartUnit: finalCartUnit,
      multiplier: finalMultiplier
    });
    setSuggestions([]);
    setQuery("");
  };

  // Auto-open the modal when voice confidence is high and exactly 1 product matches
  useEffect(() => {
    if (!voiceConfidentRef.current) return;
    voiceConfidentRef.current = false;
    if (suggestions.length === 1) selectItemForModal(suggestions[0]);
  }, [suggestions]);

  const speakText = (text: string) => {
    if (!("speechSynthesis" in window)) return;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "hi-IN"; // Best for Indian item names
    utterance.rate = 1.1;
    window.speechSynthesis.speak(utterance);
  };

  const handleModalSubmit = () => {
    if (!modalItem) return;
    const { item, qty, rate, isEdit, index, cartUnit, multiplier } = modalItem;
    const name = formatName((item as any).name_marathi || (item as any).name);
    const calcTotal = qty * rate * multiplier;

    if (isEdit && index !== null) {
      const newCart = [...cart];
      newCart[index] = { ...newCart[index], qty, rate, total: calcTotal, cartUnit, multiplier };
      setCart(newCart);
      speakText(`${name} updated to ${qty} ${cartUnit || "unit"}`);
    } else {
      setCart([...cart, {
        id: item.id,
        name: name,
        unit: item.unit || "unit",
        qty,
        rate,
        total: calcTotal,
        cartUnit,
        multiplier
      }]);
      speakText(`${name}, ${qty} ${cartUnit || "unit"} added`);
    }
    setModalItem(null);
    searchInputRef.current?.focus();
  };

  const editCartItem = (index: number) => {
    const item = cart[index];
    setModalItem({ item, qty: item.qty, rate: item.rate, isEdit: true, index, cartUnit: item.cartUnit || item.unit || "unit", multiplier: item.multiplier || 1 });
  };

  const removeCartItem = (index: number) => {
    setCart(cart.filter((_, i) => i !== index));
  };

  const holdBill = async () => {
    if (cart.length === 0) return;
    const entry = { id: Date.now().toString(), cart, customerName, customerPhone, heldAt: Date.now() };
    const updated = [...heldBills, entry];
    setHeldBills(updated);
    await localforage.setItem('held_bills', updated);
    setCart([]); setCustomerName(''); setCustomerPhone('');
  };

  const resumeBill = async (id: string) => {
    const held = heldBills.find(h => h.id === id);
    if (!held) return;
    let updated = heldBills.filter(h => h.id !== id);
    if (cart.length > 0) {
      updated = [...updated, { id: Date.now().toString(), cart, customerName, customerPhone, heldAt: Date.now() }];
    }
    setHeldBills(updated);
    await localforage.setItem('held_bills', updated);
    setCart(held.cart); setCustomerName(held.customerName); setCustomerPhone(held.customerPhone);
    setShowHeldBills(false);
  };

  const discardHeldBill = async (id: string) => {
    const updated = heldBills.filter(h => h.id !== id);
    setHeldBills(updated);
    await localforage.setItem('held_bills', updated);
  };

  const getNextBillNumber = async () => {
    const today = new Date();
    const day = today.getDate().toString().padStart(2, '0');
    const month = (today.getMonth() + 1).toString().padStart(2, '0');
    const dateKey = `${day}${month}`;
    const stored = await localforage.getItem('bill_counter') as { date: string, count: number } | null;
    
    let count = 1;
    if (stored && stored.date === dateKey) {
      count = stored.count + 1;
    }
    
    await localforage.setItem('bill_counter', { date: dateKey, count });
    return `AA-${day}${month}-${count.toString().padStart(3, '0')}`;
  };

  const checkout = async () => {
    if (cart.length === 0) return;
    try {
      const billNo = await getNextBillNumber();
      const receipt = await saveSale(cart, cartTotal, customerName, customerPhone, billNo);
      setLastReceipt(receipt);
      setCart([]);
      setCustomerName("");
      setCustomerPhone("");
      setReceiptShareOpen(true);
    } catch (error) {
      console.error(error);
      alert("Checkout failed. Check console.");
    }
  };

  const generateReceiptText = (r: Receipt) => {
    let text = `*RAJENDRA GVB*\nFresh Groceries & More\n`;
    text += `Bill: ${r.receipt_no}\nDate: ${r.date}\n`;
    if (r.customerName) text += `Cust: ${r.customerName}\n`;
    if (r.customerPhone) text += `Ph: ${r.customerPhone}\n`;
    text += `─────────────────\n`;
    r.items.forEach(item => {
      const unitInfo = item.cartUnit && item.cartUnit !== item.unit ? item.cartUnit : '';
      text += `${item.name} x${item.qty}${unitInfo} = ₹${item.total.toFixed(2)}\n`;
    });
    text += `─────────────────\n`;
    text += `*TOTAL: ₹${r.total.toFixed(2)}*\n`;
    text += `Thank You! Visit Again.`;
    return text;
  };

  const shareWhatsApp = () => {
    if (!lastReceipt) return;
    const text = generateReceiptText(lastReceipt);
    const phone = lastReceipt.customerPhone ? lastReceipt.customerPhone.replace(/\D/g, '') : '';
    const url = phone
      ? `https://wa.me/91${phone}?text=${encodeURIComponent(text)}`
      : `https://wa.me/?text=${encodeURIComponent(text)}`;
    window.open(url, '_blank');
  };

  const downloadReceiptImage = async () => {
    if (!receiptCardRef.current) return;
    try {
      const canvas = await html2canvas(receiptCardRef.current, { backgroundColor: '#ffffff', scale: 2 });
      const link = document.createElement('a');
      link.download = `receipt_${lastReceipt?.receipt_no || 'bill'}.png`;
      link.href = canvas.toDataURL('image/png');
      link.click();
    } catch (err) {
      console.error('Image download failed', err);
      alert('Could not generate image.');
    }
  };

  const shareReceiptNative = async () => {
    if (!receiptCardRef.current || !navigator.share) {
      shareWhatsApp();
      return;
    }
    try {
      const canvas = await html2canvas(receiptCardRef.current, { backgroundColor: '#ffffff', scale: 2 });
      canvas.toBlob(async (blob) => {
        if (!blob) return;
        const file = new File([blob], `receipt_${lastReceipt?.receipt_no || 'bill'}.png`, { type: 'image/png' });
        await navigator.share({ title: 'Receipt', text: generateReceiptText(lastReceipt!), files: [file] });
      }, 'image/png');
    } catch (err) {
      shareWhatsApp();
    }
  };

  const handleBackup = async () => {
    try {
      const backupData = {
        inventory: await localforage.getItem('custom_inventory'),
        sales: await localforage.getItem('sales'),
        bill_counter: await localforage.getItem('bill_counter'),
        timestamp: new Date().toISOString()
      };
      const blob = new Blob([JSON.stringify(backupData, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `nexus_pos_backup_${new Date().toISOString().split('T')[0]}.json`;
      link.click();
      URL.revokeObjectURL(url);
      alert("Backup downloaded successfully! Keep this file safe.");
    } catch (err) {
      console.error(err);
      alert("Backup failed.");
    }
  };

  const handleRestore = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!confirm("RESTORE DATA? This will overwrite your current inventory and sales history. Continue?")) return;
    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const data = JSON.parse(evt.target?.result as string);
        if (data.inventory) await localforage.setItem('custom_inventory', data.inventory);
        if (data.sales) await localforage.setItem('sales', data.sales);
        if (data.bill_counter) await localforage.setItem('bill_counter', data.bill_counter);
        alert("System restored successfully! Reloading...");
        window.location.reload();
      } catch (err) {
        console.error(err);
        alert("Restore failed. Invalid file.");
      }
    };
    reader.readAsText(file);
  };

  const handleVoiceSearch = () => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      alert("Your browser does not support Voice Recognition.");
      return;
    }
    const recognition = new SpeechRecognition();
    recognition.lang = imeEnabled ? 'mr-IN' : 'en-IN';
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 3;

    recognition.onstart = () => setIsDictating(true);
    recognition.onend = () => setIsDictating(false);
    recognition.onerror = (err: any) => {
      if (err.error === 'network') {
        alert("Voice search requires an active internet connection. Please check your network and try again.");
      } else if (err.error !== 'no-speech' && err.error !== 'aborted') {
        console.warn("Voice input issue:", err.error);
      }
      setIsDictating(false);
    };

    recognition.onresult = (event: any) => {
      const result = event.results[event.results.length - 1];

      // Show live interim text in the search box while still speaking
      if (!result.isFinal) {
        setQuery(result[0].transcript.toLowerCase());
        return;
      }

      // Pick the best alternative: the one that yields the most Fuse matches
      let transcript = result[0].transcript;
      const confidence: number = result[0].confidence ?? 0;
      if (fuse && result.length > 1) {
        let bestHits = -1;
        for (let i = 0; i < result.length; i++) {
          const alt = result[i].transcript.toLowerCase();
          const translated = translateHinglishToMarathi(alt) || alt;
          const hits = fuse.search(translated, { limit: 3 }).length;
          if (hits > bestHits) { bestHits = hits; transcript = result[i].transcript; }
        }
      }

      let text = transcript.toLowerCase();
      // Parse numbers (Marathi/Hindi/Hinglish)
      text = text.replace(/एक/g, '1').replace(/दोन/g, '2').replace(/तीन/g, '3')
        .replace(/चार/g, '4').replace(/पाच/g, '5').replace(/सहा/g, '6')
        .replace(/सात/g, '7').replace(/आठ/g, '8').replace(/नऊ/g, '9')
        .replace(/दहा/g, '10').replace(/पन्नास/g, '50').replace(/शंभर/g, '100');
      text = text.replace(/\bek\b/g, '1').replace(/\bdon\b|do\b/g, '2').replace(/\bteen\b/g, '3')
        .replace(/\bchar\b/g, '4').replace(/\bpaach\b/g, '5');

      let voiceQty = 1;
      let voiceUnit = "";

      // Handle specific grocery fractions/multipliers FIRST (with robust spelling corrections)
      if (/(छटाक|चटाक|चटक|chatak|chatk|chhatak|catak|shatak)/.test(text)) {
        voiceQty = 50; voiceUnit = 'g';
      } else if (/(पावशेर|पवशेर|पाव शेर|pavsher|pav sher|paavsher|pausher|powser|pavser)/.test(text)) {
        voiceQty = 250; voiceUnit = 'g';
      } else if (/(पाव किलो|पाव|paav|pav|paw|pao)/.test(text)) {
        voiceQty = 250; voiceUnit = 'g';
      } else if (/(पाऊण|पावुन|paun|pahun|pawun)/.test(text)) {
        voiceQty = 750; voiceUnit = 'g';
      } else if (/(अर्धा|अर्ध|अरधा|ardha|ardh|aradha)/.test(text)) {
        voiceQty = 500; voiceUnit = 'g';
      } else if (/(सव्वा|सवा|savva|sawa|sava|savwa)/.test(text)) {
        voiceQty = 1.25;
      } else if (/(दीड|दिड|did|deed|dedh)/.test(text)) {
        voiceQty = 1.5;
      } else if (/(अडीच|अडिच|adich|adhich|adeech)/.test(text)) {
        voiceQty = 2.5;
      } else {
        // Find explicit numbers
        const match = text.match(/([\d\.]+)/);
        if (match) {
          voiceQty = parseFloat(match[1]);
        }
      }

      // Handle unit modifiers
      // Heuristic: if qty >= 100 and unit is "kilo/kg", treat as grams
      // (speech recognition commonly mishears "gram" as "kilo" for small quantities)
      if (/(ग्राम|ग्रॅम|गरम|\bgram\b|\bgrams\b|\bgm\b|\bgrm\b)/.test(text)) {
        voiceUnit = 'g';
      } else if (/(किलो|किलोग्राम|\bkilo\b|\bkilogram\b|\bkg\b)/.test(text)) {
        voiceUnit = voiceQty >= 100 ? 'g' : 'kg';
      } else if (/(मिली|मिलीलिटर|मिलिलिटर|\bml\b|\bmilli\b)/.test(text)) {
        voiceUnit = 'ml';
      } else if (/(लिटर|लीटर|\bliter\b|\blitre\b|\bltr\b|\blit\b)/.test(text)) {
        voiceUnit = voiceQty >= 100 ? 'ml' : 'l';
      } else if (/(पॅकेट|\bpacket\b|\bpack\b|\bpkt\b)/.test(text)) {
        voiceUnit = 'packet';
      } else if (/(बॅग|थैला|थैली|\bbag\b|\bsack\b)/.test(text)) {
        voiceUnit = 'bag';
      } else if (/(माल|मल|\bmal\b|\bpouch\b)/.test(text)) {
        voiceUnit = 'mal';
      } else if (/(बॉक्स|\bbox\b|\bboxes\b)/.test(text)) {
        voiceUnit = 'box';
      } else if (/(नग|\bpcs\b|\bpiece\b|\bpieces\b)/.test(text)) {
        voiceUnit = 'pcs';
      } else if (/(डझन|डजन|\bdozen\b|\bdzn\b)/.test(text)) {
        voiceUnit = 'dozen';
      }

      // Detect MRP / price signal and preserve it for the search ranking pipeline
      let priceSuffix = '';
      const mrpM = text.match(/(?:mrp|एमआरपी)\s*([\d]+)/i);
      const rateM = !mrpM && text.match(/([\d]+)\s*(?:rupees?|rs\.?|रुपये|रु\.?)/i);
      if (mrpM) priceSuffix = ` mrp ${mrpM[1]}`;
      else if (rateM) priceSuffix = ` ${rateM[1]} rupees`;

      // Clean the item name: remove numbers, unit words, price words, fraction words
      let cleanName = text.replace(/([\d\.]+)/g, '')
        .replace(/(kilo|kilogram|\bkg\b|ग्राम|ग्रॅम|गरम|\bgram\b|\bgm\b|\bgrm\b|मिली|\bml\b|लिटर|लीटर|\bliter\b|\blitre\b|\bltr\b|packet|\bpack\b|\bpkt\b|किलो|लिटर|पॅकेट|\bpcs\b|\bpiece\b|\bbag\b|\bsack\b|बॅग|थैला|थैली|\bmal\b|माल|मल|\bbox\b|\bboxes\b|बॉक्स|\bdozen\b|\bdzn\b|डझन|डजन)/gi, '')
        .replace(/(rupees?|rs\.?|रुपये|रु\.?|\bmrp\b|एमआरपी|rate|price)/gi, '')
        .replace(/(छटाक|चटाक|चटक|chatak|chatk|chhatak|catak|shatak|पावशेर|पवशेर|पाव शेर|pavsher|pav sher|paavsher|pausher|powser|pavser|पाव किलो|पाव|paav|pav|paw|pao|पाऊण|पावुन|paun|pahun|pawun|अर्धा|अर्ध|अरधा|ardha|ardh|aradha|सव्वा|सवा|savva|sawa|sava|savwa|दीड|दिड|did|deed|dedh|अडीच|अडिच|adich|adhich|adeech|डझन|डजन|dozen|dzn)/g, '')
        .replace(/\s+/g, ' ').trim();

      // Save qty/unit for the cart modal and for search ranking
      setVoiceContext({ qty: voiceQty, cartUnit: voiceUnit });

      // Build the search query: product name + unit signal + price signal
      // Including unit/price lets parseUserQuery rank the correct variant (e.g., 200g tube vs 100g)
      const productName = cleanName
        ? (imeEnabled ? (translateHinglishToMarathi(cleanName) || cleanName) : cleanName)
        : transcript.toLowerCase();
      const unitSuffix = voiceUnit ? ` ${voiceQty}${voiceUnit}` : '';
      setQuery((productName + unitSuffix + priceSuffix).trim());

      // Auto-confirm: if confidence is high, let the suggestions watcher pick the single result
      if (confidence > 0.75) voiceConfidentRef.current = true;
    };

    recognition.start();
  };

  const cartTotal = cart.reduce((sum, item) => sum + item.total, 0);

  // Stock filtering — substring first, Fuse fuzzy fallback on miss
  const filteredStock = (() => {
    if (!stockQuery) return inventory;
    const sq  = stockQuery.toLowerCase();
    const mq  = translateHinglishToMarathi(stockQuery);
    const nq  = normalizeForSearch(sq);
    const exact = inventory.filter(i =>
      (i.search_key   || "").toLowerCase().includes(sq) ||
      (i.name         || "").toLowerCase().includes(sq) ||
      (i.name_marathi || "").toLowerCase().includes(sq) ||
      (i.name_eng     || "").toLowerCase().includes(sq) ||
      (mq  && mq  !== sq && (i.name_marathi || "").toLowerCase().includes(mq)) ||
      (nq  && nq  !== sq && (i.name_eng     || "").toLowerCase().includes(nq))
    );
    if (exact.length > 0) return exact;
    // Nothing found via substring — fall back to Fuse for typo tolerance
    if (!fuse) return [];
    const stockVariants = new Set<string>([stockQuery]);
    if (mq && mq !== stockQuery) stockVariants.add(mq);
    if (nq && nq !== sq)         stockVariants.add(nq);
    const dictHit = HINGLISH_TO_MARATHI[sq];
    if (dictHit) stockVariants.add(dictHit);
    const seen = new Set<string>();
    const results: InventoryItem[] = [];
    for (const v of stockVariants) {
      for (const r of fuse.search(v, { limit: 20 })) {
        if (!seen.has(r.item.id)) { seen.add(r.item.id); results.push(r.item); }
      }
    }
    return results;
  })();
  const favFilteredStock = filteredStock.filter(s => favoriteIds.has(s.id));
  const nonFavFilteredStock = filteredStock.filter(s => !favoriteIds.has(s.id));
  const totalStockPages = Math.max(1, Math.ceil(nonFavFilteredStock.length / ITEMS_PER_PAGE));
  const pagedStock = nonFavFilteredStock.slice((stockPage - 1) * ITEMS_PER_PAGE, stockPage * ITEMS_PER_PAGE);

  const parseAndLoadXlsx = async (file: File) => {
    const XLSX = await import("xlsx");
    const reader = new FileReader();
    reader.onload = async (evt) => {
      const bstr = evt.target?.result;
      const wb = XLSX.read(bstr, { type: "binary" });
      const wsname = wb.SheetNames[0];
      const ws = wb.Sheets[wsname];
      const data = XLSX.utils.sheet_to_json(ws);

      const mappedItems: InventoryItem[] = data.map((row: any, i) => ({
        id: row["SKU_ID"] || row["Item_ID"] || row["id"] || `UPLOAD-${i}`,
        name: row["Marathi_Name"] || row["Item_Name"] || row["name"] || row["English_Name"] || row["Name"] || `Item ${i}`,
        name_marathi: row["Marathi_Name"] || row["Item_Name_Marathi"] || row["name_marathi"] || "",
        name_eng: row["English_Name"] || row["Item_Name_Eng"] || row["name_eng"] || "",
        search_key: String(row["Search_key"] || row["search_key"] || row["SearchKey"] || "").trim(),
        unit: row["Weight_Volume"] || row["Unit"] || row["unit"] || "unit",
        price: Number(row["Selling_Price_INR"] || row["Selling_Price"] || row["price"] || row["Price"] || row["Sale_Rate"] || 0),
        purchase_price: Number(row["Purchase_Price_INR"] || row["Purchase_Price"] || row["purchase_price"] || row["Purchase_Rate"] || row["Purchase Rate"] || 0),
        stock_quantity: Number(row["Stock_Quantity"] || row["stock_qty"] || row["Quantity"] || 0),
      }));

      const uniqueMap = new Map<string, InventoryItem>();
      mappedItems.forEach(item => {
        const cleanName = formatName(item.name_marathi || item.name_eng || item.name).toLowerCase();
        if (!uniqueMap.has(cleanName) && cleanName) {
          uniqueMap.set(cleanName, item);
        }
      });
      const dedupedData = Array.from(uniqueMap.values());

      // Always update local state immediately for instant UI feedback
      await localforage.setItem('custom_inventory', dedupedData);
      setInventory(dedupedData);
      setFuse(new Fuse(dedupedData, fuseOptions));

      if (isFirebaseReady) {
        setUploadStatus(`⏳ Syncing ${dedupedData.length} items to Firestore...`);
        try {
          await bulkSaveInventoryToFirestore(dedupedData);
          setUploadStatus(`✅ ${dedupedData.length} items synced! All devices updated in real-time.`);
          setTimeout(() => setUploadStatus(""), 5000);
        } catch (err) {
          console.error("Firestore sync failed:", err);
          setUploadStatus("⚠️ Firestore sync failed. Inventory saved locally only.");
          setTimeout(() => setUploadStatus(""), 5000);
        }
      } else {
        setUploadStatus(`✅ ${dedupedData.length} items loaded (offline mode).`);
        setTimeout(() => setUploadStatus(""), 4000);
      }
    };
    reader.readAsBinaryString(file);
  };

  const syncInventoryToXlsx = async (inv: InventoryItem[]) => {
    if (!xlsxFileHandleRef.current) return;
    try {
      const XLSX = await import("xlsx");
      const mappedData = inv.map(i => ({
        SKU_ID: i.id,
        Marathi_Name: i.name_marathi || i.name,
        English_Name: i.name_eng || "",
        Weight_Volume: i.unit,
        Selling_Price_INR: i.price,
        Purchase_Price_INR: i.purchase_price || 0,
        Stock_Quantity: i.stock_quantity ?? i.stock_qty ?? 0,
      }));
      const ws = XLSX.utils.json_to_sheet(mappedData);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Inventory");
      const wbout: ArrayBuffer = XLSX.write(wb, { bookType: "xlsx", type: "array" });
      const writable = await xlsxFileHandleRef.current.createWritable();
      await writable.write(new Blob([wbout], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
      await writable.close();
    } catch (err) {
      console.error("Failed to sync xlsx:", err);
    }
  };

  const handleOpenXlsxWithHandle = async () => {
    if (!("showOpenFilePicker" in window)) {
      document.getElementById("xlsxFileInput")?.click();
      return;
    }
    try {
      const [handle] = await (window as any).showOpenFilePicker({
        types: [{ description: "Excel Files", accept: { "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"], "application/vnd.ms-excel": [".xls"], "text/csv": [".csv"] } }],
        multiple: false,
      });
      xlsxFileHandleRef.current = handle;
      setXlsxFileName(handle.name);
      const file = await handle.getFile();
      await parseAndLoadXlsx(file);
    } catch (err: any) {
      if (err.name !== "AbortError") {
        console.error(err);
        alert("Error opening Excel file.");
      }
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    xlsxFileHandleRef.current = null;
    setXlsxFileName("");
    try {
      await parseAndLoadXlsx(file);
    } catch (err) {
      console.error(err);
      alert("Error parsing Excel file.");
    }
  };

  const renderInventoryCard = (s: InventoryItem) => {
    const mrp = s.purchase_price || 0;
    const price = s.price || 0;
    const stock = s.stock_quantity ?? s.stock_qty ?? 0;
    const hasDiscount = price > 0 && mrp > 0 && price < mrp;
    const isLowStock = stock < 10;
    const marathiName = s.name_marathi || s.name;
    const engName = formatName(s.name_eng || "");
    const isFav = favoriteIds.has(s.id);
    return (
      <div key={s.id} className="kirana-card" onClick={() => setInventoryEditItem(s)}>
        <div
          onClick={(e) => { e.stopPropagation(); toggleFavorite(s.id); }}
          style={{ fontSize: '1.3rem', cursor: 'pointer', color: isFav ? '#F59E0B' : '#D1D5DB', alignSelf: 'flex-start', lineHeight: 1, flexShrink: 0, userSelect: 'none' }}
        >
          {isFav ? '★' : '☆'}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 'bold', fontSize: '1.12rem', fontFamily: '"Noto Sans Devanagari", sans-serif', lineHeight: 1.3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: '#1C1917' }}>{marathiName}</div>
          {engName && <div style={{ fontSize: '0.82rem', color: '#57534E', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{engName}</div>}
          {s.brand && <div style={{ color: '#0a3d62', fontWeight: 'bold', fontSize: '0.88rem' }}>{s.brand}</div>}
          <div style={{ color: '#9ca3af', fontSize: '0.68rem', marginTop: '1px' }}>({s.unit}) · {s.id}</div>
        </div>
        <div className="kirana-vals">
          <div style={{ fontWeight: 'bold', color: '#DC2626', fontSize: '0.88rem', textDecoration: hasDiscount ? 'line-through' : 'none' }}>
            {mrp ? `₹${mrp}` : '—'}
          </div>
          <div style={{ fontWeight: 'bold', color: '#16A34A', fontSize: '0.9rem' }}>
            ₹{price}
          </div>
          <div style={{ fontWeight: 'bold', color: isLowStock ? '#DC2626' : '#9CA3AF', fontSize: '0.88rem' }}>
            {stock}
            {isLowStock && <div style={{ fontSize: '0.6rem', color: '#DC2626' }}>⚠ कमी</div>}
          </div>
        </div>
      </div>
    );
  };

  return (
    <>
      <style dangerouslySetInnerHTML={{
        __html: `
        :root { --sidebar-bg: #0a3d62; --active-nav: #145c91; --body-bg: #f1f2f6; }
        body { background-color: var(--body-bg); font-family: 'Segoe UI', sans-serif; margin: 0; padding: 0; overflow-x: hidden; }
        *, *::before, *::after { box-sizing: border-box; }

        .sidebar { width: 250px; background: var(--sidebar-bg); height: 100vh; position: fixed; color: white; z-index: 1000; display: block; }
        .nav-link { color: white; padding: 15px 20px; font-weight: 600; cursor: pointer; border-left: 4px solid transparent; text-decoration: none; display: block; }
        .nav-link:hover, .nav-link.active { background: var(--active-nav); border-left: 4px solid #3498db; }
        .mobile-nav { display: none; position: fixed; bottom: 0; left: 0; width: 100%; background: var(--sidebar-bg); color: white; z-index: 2000; justify-content: space-around; padding: 8px 0 10px; box-shadow: 0 -2px 8px rgba(0,0,0,0.25); }
        .mobile-nav-item { text-align: center; color: white; text-decoration: none; font-size: 0.72rem; opacity: 0.7; cursor: pointer; flex: 1; padding: 3px 0; }
        .mobile-nav-item.active { opacity: 1; font-weight: bold; }

        .main-content { margin-left: 250px; padding: 25px; transition: 0.3s; }
        .card { border-radius: 15px; border: none; box-shadow: 0 4px 12px rgba(0,0,0,0.05); background: white; margin-bottom: 15px; padding: 1rem; }

        .billing-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem; gap: 10px; flex-wrap: wrap; }
        .customer-btn { background: #0d6efd; color: white; border: none; padding: 10px 15px; border-radius: 8px; font-weight: bold; cursor: pointer; display: flex; align-items: center; gap: 5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 220px; }

        .search-container { position: relative; }
        .search-inner-row { display: flex; width: 100%; gap: 10px; align-items: center; }
        #itemNameSearch { height: 52px; border-radius: 12px; border: 2px solid #e1e8ed; padding-left: 15px; font-size: 1.1rem; flex: 1; min-width: 0; outline: none; width: 100%; }
        .scan-btn { font-size: 1.5rem; color: #0d6efd; cursor: pointer; background: #e7f1ff; padding: 8px 10px; border-radius: 8px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; height: 52px; }
        .ime-btn { height: 52px; border-radius: 8px; border: none; font-weight: bold; cursor: pointer; min-width: 58px; padding: 0 14px; flex-shrink: 0; font-size: 1rem; color: white; }
        .suggestions-container { position: absolute; width: 100%; left: 0; background: white; z-index: 1050; top: 58px; border-radius: 12px; box-shadow: 0 10px 25px rgba(0,0,0,0.15); max-height: 250px; overflow-y: auto; border: 1px solid #ddd; }
        .suggestion-item { padding: 12px 15px; cursor: pointer; border-bottom: 1px solid #eee; display: flex; justify-content: space-between; align-items: center; transition: all 0.2s; box-sizing: border-box; }
        .suggestion-item.active { background: #e7f1ff; border-left: 4px solid #0d6efd; padding-left: 11px; }
        .suggestion-item:last-child { border-bottom: none; }
        .suggestion-item:hover { background: #f8f9fa; color: var(--sidebar-bg); }

        .mic-btn { height: 52px; border-radius: 12px; background: var(--sidebar-bg); color: white; border: none; padding: 0 20px; font-weight: bold; cursor: pointer; flex-shrink: 0; }
        .mic-active { background: #e74c3c !important; animation: pulse 1.5s infinite; }

        .total-bar { position: sticky; top: 0; z-index: 100; background: #333; color: white; padding: 15px; border-radius: 12px; margin-bottom: 20px; display: flex; justify-content: space-between; align-items: center; gap: 10px; }
        .checkout-btn { background: #28a745; color: white; border: none; padding: 10px 24px; font-size: 1.1rem; font-weight: bold; border-radius: 8px; cursor: pointer; white-space: nowrap; }

        .table { width: 100%; text-align: left; border-collapse: collapse; min-width: 600px; }
        .table th, .table td { padding: 12px; border-bottom: 1px solid #dee2e6; }
        .table-container { overflow-x: auto; }
        .btn-action { margin-right: 5px; padding: 5px 10px; cursor: pointer; border-radius: 4px; border: 1px solid #007bff; color: #007bff; background: transparent; }
        .btn-action.danger { border-color: #dc3545; color: #dc3545; }

        .mobile-cart-card { display: none; }
        .desktop-cart-table { display: block; }

        .modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); display: flex; justify-content: center; align-items: center; z-index: 3000; padding: 16px; }
        .modal-content { background: white; padding: 20px; border-radius: 15px; width: 100%; max-width: 400px; max-height: 92vh; overflow-y: auto; }
        .modal-header { display: flex; justify-content: space-between; align-items: center; font-size: 1.25rem; font-weight: bold; margin-bottom: 15px; }
        .modal-input { width: 100%; padding: 10px; margin-bottom: 15px; border: 1px solid #ccc; border-radius: 8px; font-size: 1.5rem; text-align: center; font-weight: bold; }
        .edit-input { width: 100%; padding: 6px; border: 1px solid #ccc; border-radius: 6px; font-size: 1.1rem; text-align: center; font-weight: bold; box-sizing: border-box; }
        .modal-btn { width: 100%; padding: 15px; background: #0d6efd; color: white; font-weight: bold; border: none; border-radius: 8px; cursor: pointer; }
        .reports-profit { font-size: 4rem; }

        @media (max-width: 992px) {
            .sidebar { display: none; }
            .main-content { margin-left: 0; width: 100%; padding: 12px 10px 90px; }
            .mobile-nav { display: flex; }

            .billing-header { margin-bottom: 1rem; }
            .billing-header h2 { font-size: 1.2rem; }
            .customer-btn { font-size: 0.8rem; padding: 8px 10px; max-width: 160px; }

            .search-inner-row { gap: 6px; }
            #itemNameSearch { height: 46px; font-size: 0.95rem; }
            .scan-btn { height: 46px; font-size: 1.2rem; padding: 6px 8px; }
            .ime-btn { height: 46px; min-width: 42px; padding: 0 8px; font-size: 0.85rem; }
            .mic-btn { height: 46px; padding: 0 12px; font-size: 0.85rem; }
            .suggestions-container { top: 52px; }

            .total-bar { border-radius: 8px; padding: 10px 12px; }
            .total-bar h3 { font-size: 1rem; }
            .checkout-btn { padding: 8px 14px; font-size: 0.9rem; }

            .mobile-cart-card { display: block; }
            .desktop-cart-table { display: none; }

            .reports-profit { font-size: 2.5rem; }

            .modal-overlay { padding: 10px; }
        }

        .kirana-card { background: white; border-radius: 12px; border: 1px solid #E7E5E4; box-shadow: 0 2px 8px rgba(0,0,0,0.04); margin-bottom: 8px; display: flex; align-items: center; padding: 10px 14px; gap: 10px; cursor: pointer; }
        .kirana-card:hover { background: #fafafa; }
        .kirana-col-header { display: grid; grid-template-columns: 75px 75px 75px; text-align: center; flex-shrink: 0; }
        .kirana-vals { display: grid; grid-template-columns: 75px 75px 75px; text-align: center; flex-shrink: 0; }
        .kirana-discount-badge { background: #16A34A; color: white; font-size: 0.6rem; font-weight: bold; padding: 1px 5px; border-radius: 999px; }
        .kirana-empty { text-align: center; margin-top: 3rem; font-family: "Noto Sans Devanagari", sans-serif; color: #78716C; }

        #printReceiptArea { display: none; }
        @media print {
            * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
            html, body { margin: 0; padding: 0; }
            .sidebar, .main-content, .mobile-nav, .modal-overlay { display: none !important; }
            #printReceiptArea {
                display: block !important;
                visibility: visible !important;
                position: fixed; left: 0; top: 0;
                width: 72mm;
                padding: 3mm 4mm 8mm 4mm;
                font-family: 'Courier New', Courier, monospace;
                font-size: 9pt;
                color: #000;
                background: white;
                line-height: 1.35;
            }
            #printReceiptArea * { visibility: visible !important; }
            .rp-store-name { font-size: 14pt; font-weight: bold; text-align: center; letter-spacing: 1px; }
            .rp-sub { font-size: 8pt; text-align: center; }
            .rp-center { text-align: center; }
            .rp-meta { font-size: 8.5pt; margin: 1mm 0; }
            .rp-divider { width: 100%; border: none; border-top: 1px dashed #000; margin: 2mm 0; }
            .rp-divider-solid { width: 100%; border: none; border-top: 1.5px solid #000; margin: 2mm 0; }
            .receipt-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
            .receipt-table thead tr { border-bottom: 1px solid #000; }
            .receipt-table th { font-size: 8pt; font-weight: bold; padding: 1.5mm 1mm; text-transform: uppercase; }
            .receipt-table td { font-size: 8.5pt; padding: 1.5mm 1mm; border-bottom: 1px dashed #bbb; vertical-align: top; word-break: break-word; }
            .receipt-table .col-item  { width: 44%; text-align: left; }
            .receipt-table .col-qty   { width: 14%; text-align: center; }
            .receipt-table .col-rate  { width: 20%; text-align: right; }
            .receipt-table .col-amt   { width: 22%; text-align: right; }
            .rp-total-row { display: flex; justify-content: space-between; font-size: 11pt; font-weight: bold; padding: 1.5mm 0; letter-spacing: 0.5px; }
            .rp-items-count { font-size: 7.5pt; text-align: right; color: #333; }
            .rp-footer { font-size: 7.5pt; text-align: center; margin-top: 3mm; }
            @page { size: 80mm auto; margin: 0; }
        }
        @keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0.5; } 100% { opacity: 1; } }
      `}} />

      {/* Sidebar */}
      <div className="sidebar" style={{ position: 'fixed', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '1.5rem', textAlign: 'center' }}><h3 style={{ fontWeight: 'bold', margin: 0 }}>Rajendra GVB</h3></div>
        <div style={{ marginTop: '1rem', display: 'flex', flexDirection: 'column', flex: 1 }}>
          <a className={`nav-link ${activeTab === 'billing' ? 'active' : ''}`} onClick={() => setActiveTab('billing')}>📝 BILLING</a>
          <a className={`nav-link ${activeTab === 'inventory' ? 'active' : ''}`} onClick={() => setActiveTab('inventory')} style={{ opacity: activeTab === 'inventory' ? 1 : 0.75 }}>📦 INVENTORY</a>
          <a className={`nav-link ${activeTab === 'reports' ? 'active' : ''}`} onClick={() => setActiveTab('reports')} style={{ opacity: activeTab === 'reports' ? 1 : 0.75 }}>📊 REPORTS</a>
          <a className={`nav-link ${activeTab === 'customers' ? 'active' : ''}`} onClick={() => setActiveTab('customers')} style={{ opacity: activeTab === 'customers' ? 1 : 0.75 }}>👥 CUSTOMERS</a>
          <a className={`nav-link ${activeTab === 'receipts' ? 'active' : ''}`} onClick={() => setActiveTab('receipts')} style={{ opacity: activeTab === 'receipts' ? 1 : 0.75 }}>🧾 RECEIPTS</a>
        </div>
        {cart.length > 0 && (
          <div style={{ padding: '12px 16px', borderTop: '1px solid rgba(255,255,255,0.15)', borderBottom: '1px solid rgba(255,255,255,0.15)' }}>
            <div style={{ fontSize: '0.68rem', opacity: 0.65, letterSpacing: '0.06em', marginBottom: 3 }}>CURRENT BILL</div>
            <div style={{ fontSize: '1.6rem', fontWeight: 900, lineHeight: 1.1 }}>₹{cartTotal.toFixed(2)}</div>
            <div style={{ fontSize: '0.75rem', opacity: 0.7, marginTop: 2 }}>{cart.length} item{cart.length !== 1 ? 's' : ''}</div>
          </div>
        )}
        {user && (
          <div style={{ padding: '1rem', borderTop: '1px solid rgba(255,255,255,0.15)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
              <img src={user.picture} alt="" style={{ width: 34, height: 34, borderRadius: '50%', flexShrink: 0 }} />
              <div style={{ overflow: 'hidden' }}>
                <div style={{ fontSize: '0.85rem', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{user.name}</div>
                <div style={{ fontSize: '0.7rem', opacity: 0.65, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{user.email}</div>
              </div>
            </div>
            <button
              onClick={logout}
              style={{ width: '100%', background: 'rgba(255,255,255,0.12)', color: 'white', border: '1px solid rgba(255,255,255,0.25)', borderRadius: '8px', padding: '8px', fontSize: '0.85rem', cursor: 'pointer', fontWeight: 600 }}
            >
              Sign Out
            </button>
          </div>
        )}
      </div>

      {/* Mobile Nav */}
      <div className="mobile-nav">
        <div className={`mobile-nav-item ${activeTab === 'billing' ? 'active' : ''}`} onClick={() => setActiveTab('billing')}><span>📝</span><br />बिल</div>
        <div className={`mobile-nav-item ${activeTab === 'inventory' ? 'active' : ''}`} onClick={() => setActiveTab('inventory')}><span>📦</span><br />यादी</div>
        <div className={`mobile-nav-item ${activeTab === 'reports' ? 'active' : ''}`} onClick={() => setActiveTab('reports')}><span>📊</span><br />अहवाल</div>
        <div className={`mobile-nav-item ${activeTab === 'customers' ? 'active' : ''}`} onClick={() => setActiveTab('customers')}><span>👥</span><br />ग्राहक</div>
        <div className={`mobile-nav-item ${activeTab === 'receipts' ? 'active' : ''}`} onClick={() => setActiveTab('receipts')}><span>🧾</span><br />पावती</div>
      </div>

      <div className="main-content">
        {activeTab === 'billing' && (
          <div>
            <div className="billing-header">
              <h2 style={{ fontWeight: 'bold', margin: 0 }}>Point of Sale</h2>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                {/* Hold bill button */}
                <button
                  onClick={holdBill}
                  disabled={cart.length === 0}
                  style={{ background: cart.length === 0 ? '#ccc' : '#f59e0b', color: 'white', border: 'none', padding: '10px 14px', borderRadius: 8, fontWeight: 700, cursor: cart.length === 0 ? 'not-allowed' : 'pointer', fontSize: '0.9rem', whiteSpace: 'nowrap' }}
                >
                  ⏸ HOLD
                </button>
                {/* Resume held bills */}
                {heldBills.length > 0 && (
                  <button
                    onClick={() => setShowHeldBills(true)}
                    style={{ background: '#6366f1', color: 'white', border: 'none', padding: '10px 14px', borderRadius: 8, fontWeight: 700, cursor: 'pointer', fontSize: '0.9rem', whiteSpace: 'nowrap', position: 'relative' }}
                  >
                    ▶ RESUME
                    <span style={{ background: '#ef4444', color: 'white', borderRadius: '999px', fontSize: '0.7rem', padding: '1px 6px', marginLeft: 6, fontWeight: 900 }}>{heldBills.length}</span>
                  </button>
                )}
                <button
                  onClick={() => setIsCustomerModalOpen(true)}
                  className="customer-btn"
                >
                  👤 CUSTOMER {customerName ? `(${customerName})` : ''}
                </button>
                <button
                  onClick={sendToOwner}
                  disabled={cart.length === 0 || reviewStatus === 'pending'}
                  style={{
                    background: cart.length === 0 || reviewStatus === 'pending' ? '#ccc' : '#25D366',
                    color: 'white', border: 'none', padding: '10px 14px',
                    borderRadius: 8, fontWeight: 700, cursor: cart.length === 0 || reviewStatus === 'pending' ? 'not-allowed' : 'pointer',
                    display: 'flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap', fontSize: '0.9rem',
                  }}
                >
                  📤 Send to Owner
                </button>
              </div>
            </div>

            {/* Owner review status banner */}
            {reviewStatus === 'pending' && (
              <div style={{ background: '#FFF9C4', border: '1px solid #F59E0B', borderRadius: 10, padding: '10px 15px', marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <strong style={{ color: '#92400E' }}>⏳ Waiting for owner approval...</strong>
                  <div style={{ fontSize: '0.78rem', color: '#92400E', marginTop: 2 }}>WhatsApp sent — owner will review and update rates.</div>
                </div>
                <button onClick={cancelReview} style={{ background: 'none', border: '1px solid #92400E', color: '#92400E', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontSize: '0.78rem', whiteSpace: 'nowrap', marginLeft: 8 }}>Cancel</button>
              </div>
            )}
            {reviewStatus === 'approved' && approvedSession && (
              <div style={{ background: '#DCFCE7', border: '1px solid #16A34A', borderRadius: 10, padding: '10px 15px', marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <strong style={{ color: '#15803D' }}>✅ Owner approved the rates!</strong>
                  {approvedSession.ownerNotes && <div style={{ fontSize: '0.78rem', color: '#15803D', marginTop: 2 }}>Note: {approvedSession.ownerNotes}</div>}
                </div>
                <button onClick={applyOwnerRates} style={{ background: '#16A34A', color: 'white', border: 'none', borderRadius: 8, padding: '8px 16px', cursor: 'pointer', fontWeight: 700, marginLeft: 8, whiteSpace: 'nowrap' }}>Apply Rates</button>
              </div>
            )}
            {reviewStatus === 'rejected' && approvedSession && (
              <div style={{ background: '#FEE2E2', border: '1px solid #DC2626', borderRadius: 10, padding: '10px 15px', marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <strong style={{ color: '#991B1B' }}>❌ Owner rejected the bill</strong>
                  {approvedSession.ownerNotes && <div style={{ fontSize: '0.78rem', color: '#991B1B', marginTop: 2 }}>Reason: {approvedSession.ownerNotes}</div>}
                </div>
                <button onClick={cancelReview} style={{ background: 'none', border: '1px solid #DC2626', color: '#DC2626', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontSize: '0.78rem', whiteSpace: 'nowrap', marginLeft: 8 }}>Dismiss</button>
              </div>
            )}
            <div className="card">
              <div className="search-container">
                <div className="search-inner-row">
                  <div
                    onClick={() => setIsScanning(true)}
                    title="Open Camera Scanner"
                    className="scan-btn"
                  >
                    📷
                  </div>
                  <input
                    type="text"
                    id="itemNameSearch"
                    ref={searchInputRef}
                    placeholder="Search Name or Scan Barcode..."
                    value={query}
                    onKeyDown={(e) => {
                      if (e.key === 'ArrowDown') {
                        e.preventDefault();
                        setSelectedSuggestionIndex(prev => 
                          prev < suggestions.length - 1 ? prev + 1 : prev
                        );
                      } else if (e.key === 'ArrowUp') {
                        e.preventDefault();
                        setSelectedSuggestionIndex(prev => prev > 0 ? prev - 1 : 0);
                      } else if (e.key === 'Enter') {
                        if (selectedSuggestionIndex >= 0 && selectedSuggestionIndex < suggestions.length) {
                          selectItemForModal(suggestions[selectedSuggestionIndex]);
                          setQuery("");
                        } else if (suggestions.length > 0) {
                          const q = query.trim().toLowerCase();
                          const match = suggestions.find(s => 
                            s.id.toLowerCase() === q || 
                            s.name.toLowerCase() === q ||
                            (s.search_key && s.search_key.toLowerCase() === q)
                          );
                          if (match) {
                            selectItemForModal(match);
                            setQuery("");
                          } else if (suggestions.length === 1) {
                            selectItemForModal(suggestions[0]);
                            setQuery("");
                          }
                        }
                      }
                    }}
                    onChange={(e) => {
                      const val = e.target.value;
                      if (!imeEnabled) { setQuery(val); return; }

                      // Identify if the user pressed Space (ending a word)
                      if (val.endsWith(" ")) {
                        const translated = translateHinglishToMarathi(val.trim());
                        setQuery(translated + " ");
                      } else {
                        setQuery(val);
                      }
                    }}
                    autoComplete="off"
                  />
                  <button
                    onClick={() => setImeEnabled(!imeEnabled)}
                    className="ime-btn"
                    style={{ background: imeEnabled ? '#28a745' : '#ccc' }}>
                    {imeEnabled ? "अ" : "A"}
                  </button>
                  <button className={`mic-btn ${isDictating ? 'mic-active' : ''}`} onClick={handleVoiceSearch}>🎙️</button>
                </div>
                {suggestions.length > 0 && (
                  <div className="suggestions-container">
                    {suggestions.map((s, idx) => (
                      <div 
                        key={s.id} 
                        className={`suggestion-item ${idx === selectedSuggestionIndex ? 'active' : ''}`} 
                        onClick={() => selectItemForModal(s)}
                        onMouseEnter={() => setSelectedSuggestionIndex(idx)}
                      >
                        <span><b>{formatName(s.name_marathi || s.name_eng || s.name).toUpperCase()}</b> <small style={{ color: '#6c757d' }}>({s.unit || 'unit'})</small>{s.brand && <small style={{ color: '#0a3d62', fontWeight: 600, marginLeft: '5px' }}>({s.brand})</small>}</span>
                        <span>₹{Number(s.price || 0).toFixed(3)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="total-bar shadow-lg">
              <h3 style={{ margin: 0, fontWeight: 'bold' }}>TOTAL: ₹{cartTotal.toFixed(3)}</h3>
              <button className="checkout-btn" onClick={checkout}>CHECKOUT ➤</button>
            </div>

            {/* Desktop: Table view */}
            <div className="card desktop-cart-table">
              <div className="table-container">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Product (Unit)</th>
                      <th style={{ textAlign: 'center' }}>Qty</th>
                      <th style={{ textAlign: 'center' }}>Rate</th>
                      <th style={{ textAlign: 'center' }}>Total</th>
                      <th style={{ textAlign: 'center' }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cart.map((c, i) => (
                      <tr key={i}>
                        <td style={{ fontWeight: 'bold', cursor: 'pointer', color: '#0a3d62' }} onClick={() => editCartItem(i)}>{c.name.toUpperCase()} <small style={{ color: '#6c757d' }}>({c.unit})</small></td>
                        <td style={{ textAlign: 'center' }}>{c.qty} {c.cartUnit && c.cartUnit !== c.unit ? c.cartUnit : ""}</td>
                        <td style={{ textAlign: 'center' }}>₹{(c.rate * (c.multiplier || 1)).toFixed(3)}</td>
                        <td style={{ textAlign: 'center', fontWeight: 'bold', color: '#0d6efd' }}>₹{c.total.toFixed(3)}</td>
                        <td style={{ textAlign: 'center' }}>
                          <button className="btn-action danger" onClick={() => removeCartItem(i)}>✕</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Mobile: Card view */}
            <div className="mobile-cart-card">
              {cart.map((c, i) => (
                <div key={i} className="card" style={{ padding: '12px', marginBottom: '8px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div style={{ flex: 1, cursor: 'pointer' }} onClick={() => editCartItem(i)}>
                      <div style={{ fontWeight: 'bold', fontSize: '0.95rem', color: '#0a3d62' }}>{c.name.toUpperCase()} <small style={{ color: '#6c757d' }}>({c.unit})</small></div>
                      <div style={{ display: 'flex', gap: '15px', marginTop: '6px', fontSize: '0.85rem', color: '#555' }}>
                        <span>Qty: <b>{c.qty} {c.cartUnit && c.cartUnit !== c.unit ? c.cartUnit : ""}</b></span>
                        <span>Rate: <b>₹{(c.rate * (c.multiplier || 1)).toFixed(2)}</b></span>
                      </div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontWeight: 'bold', color: '#0d6efd', fontSize: '1.1rem' }}>₹{c.total.toFixed(2)}</div>
                      <div style={{ marginTop: '6px' }}>
                        <button className="btn-action danger" onClick={() => removeCartItem(i)} style={{ padding: '4px 10px', fontSize: '0.8rem' }}>✕</button>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {activeTab === 'inventory' && (
          <div>
            <h2 style={{ fontWeight: 'bold', marginBottom: '1rem' }}>Inventory</h2>
            <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: '10px', flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: '200px' }}>
                  <label style={{ fontSize: '0.85rem', fontWeight: 'bold', color: '#6c757d', marginBottom: '6px', display: 'block' }}>
                    📤 LOAD EXCEL INVENTORY
                  </label>
                  <button
                    onClick={handleOpenXlsxWithHandle}
                    style={{ width: '100%', padding: '8px 12px', background: xlsxFileName ? '#e8f5e9' : '#f8f9fa', borderRadius: '5px', border: `1px dashed ${xlsxFileName ? '#16A34A' : '#ccc'}`, cursor: 'pointer', textAlign: 'left', fontSize: '0.85rem', color: xlsxFileName ? '#16A34A' : '#6c757d', fontWeight: xlsxFileName ? 'bold' : 'normal' }}
                  >
                    {xlsxFileName ? `✅ ${xlsxFileName} (Auto-sync ON)` : 'Choose Excel File...'}
                  </button>
                  <input
                    id="xlsxFileInput"
                    type="file"
                    accept=".xlsx, .xls, .csv"
                    onChange={handleFileUpload}
                    style={{ display: 'none' }}
                  />
                </div>
                <button
                  onClick={exportInventoryToExcel}
                  style={{ background: '#198754', color: 'white', border: 'none', padding: '10px 16px', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer', whiteSpace: 'nowrap', fontSize: '0.9rem', boxShadow: '0 2px 6px rgba(25,135,84,0.3)' }}
                >
                  ⬇️ EXPORT EXCEL
                </button>
                <button
                  onClick={() => setInventoryEditItem({ id: `INV-${Date.now()}`, name: '', unit: 'kg', price: 0, purchase_price: 0, stock_quantity: 0, barcode: '' })}
                  style={{ background: '#0d6efd', color: 'white', border: 'none', padding: '10px 16px', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer', whiteSpace: 'nowrap', fontSize: '0.9rem' }}
                >
                  ➕ ADD NEW ITEM
                </button>
              </div>
              {uploadStatus && (
                <div style={{
                  padding: '10px 14px', borderRadius: '8px', fontWeight: 'bold', fontSize: '0.88rem',
                  background: uploadStatus.startsWith('✅') ? '#dcfce7' : uploadStatus.startsWith('⚠️') ? '#fef3c7' : '#eff6ff',
                  color: uploadStatus.startsWith('✅') ? '#15803d' : uploadStatus.startsWith('⚠️') ? '#92400e' : '#1d4ed8',
                  border: `1px solid ${uploadStatus.startsWith('✅') ? '#bbf7d0' : uploadStatus.startsWith('⚠️') ? '#fde68a' : '#bfdbfe'}`,
                }}>
                  {uploadStatus}
                </div>
              )}
              <div style={{ display: 'flex', gap: '10px' }}>
                <input
                  type="text"
                  style={{ flexGrow: 1, padding: '10px', borderRadius: '5px', border: '1px solid #ccc' }}
                  placeholder="Eng -> मराठी Stock Search..."
                  value={stockQuery}
                  onChange={(e) => {
                    const val = e.target.value;
                    setStockPage(1);
                    if (!imeEnabled) { setStockQuery(val); return; }
                    if (val.endsWith(" ")) {
                      setStockQuery(translateHinglishToMarathi(val.trim()) + " ");
                    } else {
                      setStockQuery(val);
                    }
                  }}
                />
                <button
                  onClick={() => setImeEnabled(!imeEnabled)}
                  style={{ background: imeEnabled ? '#28a745' : '#ccc', color: 'white', padding: '0 15px', borderRadius: '5px', border: 'none', fontWeight: 'bold', cursor: 'pointer', minWidth: '50px' }}>
                  {imeEnabled ? "अ" : "A"}
                </button>
              </div>
            </div>
            <div>
              {/* Column header */}
              <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '2px 14px 6px 0' }}>
                <div className="kirana-col-header">
                  <span style={{ color: '#DC2626', fontWeight: 'bold', fontSize: '0.68rem', textTransform: 'uppercase', letterSpacing: '0.03em' }}>Purchase</span>
                  <span style={{ color: '#16A34A', fontWeight: 'bold', fontSize: '0.68rem', textTransform: 'uppercase', letterSpacing: '0.03em' }}>Sale</span>
                  <span style={{ color: '#9CA3AF', fontWeight: 'bold', fontSize: '0.68rem', textTransform: 'uppercase', letterSpacing: '0.03em' }}>Stock</span>
                </div>
              </div>

              {/* Favourites section */}
              {favFilteredStock.length > 0 && (
                <div>
                  <div style={{ fontSize: '0.72rem', fontWeight: 'bold', color: '#F59E0B', padding: '2px 4px 6px', display: 'flex', alignItems: 'center', gap: '4px', letterSpacing: '0.04em' }}>
                    ★ FAVOURITES
                  </div>
                  {favFilteredStock.map(s => renderInventoryCard(s))}
                  <div style={{ borderBottom: '2px dashed #E7E5E4', margin: '4px 0 12px' }} />
                </div>
              )}

              {/* Regular items */}
              {pagedStock.map(s => renderInventoryCard(s))}
            </div>

            {/* Pagination Controls */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 4px', marginTop: '4px' }}>
              <button
                disabled={stockPage <= 1}
                onClick={() => setStockPage(p => p - 1)}
                style={{ background: stockPage <= 1 ? '#e9ecef' : '#0a3d62', color: stockPage <= 1 ? '#adb5bd' : 'white', border: 'none', padding: '10px 20px', borderRadius: '8px', fontWeight: 'bold', cursor: stockPage <= 1 ? 'default' : 'pointer', fontSize: '0.95rem' }}
              >
                ← मागे
              </button>
              <span style={{ fontWeight: 'bold', color: '#0a3d62', fontSize: '0.9rem', textAlign: 'center' }}>
                पृष्ठ {stockPage} / {totalStockPages}<br />
                <span style={{ fontWeight: 'normal', color: '#6c757d', fontSize: '0.78rem' }}>{filteredStock.length} वस्तू</span>
              </span>
              <button
                disabled={stockPage >= totalStockPages}
                onClick={() => setStockPage(p => p + 1)}
                style={{ background: stockPage >= totalStockPages ? '#e9ecef' : '#0a3d62', color: stockPage >= totalStockPages ? '#adb5bd' : 'white', border: 'none', padding: '10px 20px', borderRadius: '8px', fontWeight: 'bold', cursor: stockPage >= totalStockPages ? 'default' : 'pointer', fontSize: '0.95rem' }}
              >
                पुढे →
              </button>
            </div>
          </div>
        )}

        {activeTab === 'customers' && (
          <div>
            <h2 style={{ fontWeight: 'bold', marginBottom: '1rem' }}>Customer Directory</h2>
            <div className="card">
              <div style={{ maxHeight: '70vh', overflowY: 'auto' }}>
                {Array.from(new Set(allSales.filter(s => s.customerPhone || s.customerName).map(s => s.customerPhone || s.customerName))).map(custKey => {
                  const custSales = allSales.filter(s => (s.customerPhone || s.customerName) === custKey);
                  const latestSale = custSales[custSales.length - 1];
                  return (
                    <details key={custKey} style={{ borderBottom: '1px solid #eee', padding: '10px 0' }}>
                      <summary style={{ cursor: 'pointer', outline: 'none', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div>
                          <b style={{ fontSize: '1.1rem' }}>{latestSale.customerName || "N/A"}</b>
                          <div style={{ fontSize: '0.85rem', color: '#6c757d' }}>📞 {latestSale.customerPhone || "N/A"}</div>
                        </div>
                        <div style={{ textAlign: 'right' }}>
                          <div style={{ fontSize: '0.85rem', fontWeight: 'bold' }}>{custSales.length} Bills</div>
                          <div style={{ color: '#198754', fontWeight: 'bold' }}>₹{custSales.reduce((a, b) => a + b.total, 0).toFixed(2)} Total</div>
                        </div>
                      </summary>
                      <div style={{ padding: '10px', background: '#f8f9fa', marginTop: '10px', borderRadius: '8px' }}>
                        <h6 style={{ fontWeight: 'bold', fontSize: '0.75rem', color: '#6c757d' }}>PURCHASE HISTORY</h6>
                        {custSales.reverse().map(sale => (
                          <div key={sale.receipt_no} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', padding: '5px 0', borderBottom: '1px dashed #ccc' }}>
                            <span>#{sale.receipt_no} ({sale.date.split(',')[0]})</span>
                            <b style={{ color: '#0d6efd' }}>₹{sale.total.toFixed(2)}</b>
                          </div>
                        ))}
                      </div>
                    </details>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {activeTab === 'receipts' && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem', flexWrap: 'wrap', gap: '8px' }}>
              {viewingReceipt ? (
                <button onClick={() => setViewingReceipt(null)} style={{ background: 'transparent', border: '1px solid #ccc', borderRadius: '8px', padding: '6px 14px', cursor: 'pointer', fontWeight: 'bold', color: '#0a3d62', fontSize: '0.9rem' }}>
                  ← Back
                </button>
              ) : (
                <h2 style={{ fontWeight: 'bold', margin: 0 }}>🧾 Receipts</h2>
              )}
              {viewingReceipt && (
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  <button
                    onClick={() => { setLastReceipt(viewingReceipt); setViewingReceipt(null); setReceiptShareOpen(true); }}
                    style={{ background: '#25D366', color: 'white', border: 'none', borderRadius: '8px', padding: '8px 14px', fontWeight: 'bold', cursor: 'pointer', fontSize: '0.85rem' }}
                  >
                    📲 Share Again
                  </button>
                  <button
                    onClick={() => loadReceiptToCart(viewingReceipt)}
                    style={{ background: '#0d6efd', color: 'white', border: 'none', borderRadius: '8px', padding: '8px 14px', fontWeight: 'bold', cursor: 'pointer', fontSize: '0.85rem' }}
                  >
                    ✏️ Load to Cart & Edit
                  </button>
                </div>
              )}
            </div>

            {viewingReceipt ? (
              /* ── Receipt detail view ── */
              <div className="card" style={{ padding: '16px' }}>
                <div style={{ textAlign: 'center', borderBottom: '2px solid #000', paddingBottom: '10px', marginBottom: '10px' }}>
                  <div style={{ fontWeight: 'bold', fontSize: '1.15rem' }}>RAJENDRA GVB</div>
                  <div style={{ fontSize: '0.75rem', color: '#555' }}>Fresh Groceries & More</div>
                  <div style={{ fontWeight: 'bold', marginTop: '6px' }}>BILL: {viewingReceipt.receipt_no}</div>
                  <div style={{ fontSize: '0.78rem', color: '#666' }}>{viewingReceipt.date}</div>
                  {(viewingReceipt.customerName || viewingReceipt.customerPhone) && (
                    <div style={{ marginTop: '4px', fontSize: '0.78rem', borderTop: '1px dashed #ccc', paddingTop: '4px' }}>
                      {viewingReceipt.customerName && <span>👤 {viewingReceipt.customerName} </span>}
                      {viewingReceipt.customerPhone && <span>📞 {viewingReceipt.customerPhone}</span>}
                    </div>
                  )}
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid #ccc', color: '#6c757d' }}>
                      <th style={{ textAlign: 'left', padding: '6px 4px', fontWeight: '600' }}>Item</th>
                      <th style={{ textAlign: 'center', padding: '6px 4px', fontWeight: '600' }}>Qty</th>
                      <th style={{ textAlign: 'right', padding: '6px 4px', fontWeight: '600' }}>Rate</th>
                      <th style={{ textAlign: 'right', padding: '6px 4px', fontWeight: '600' }}>Amt</th>
                    </tr>
                  </thead>
                  <tbody>
                    {viewingReceipt.items.map((item, idx) => (
                      <tr key={idx} style={{ borderBottom: '1px solid #f0f0f0' }}>
                        <td style={{ padding: '6px 4px', fontWeight: '500' }}>{item.name}</td>
                        <td style={{ textAlign: 'center', padding: '6px 4px' }}>{item.qty}{item.cartUnit && item.cartUnit !== item.unit ? item.cartUnit : ''}</td>
                        <td style={{ textAlign: 'right', padding: '6px 4px', color: '#555' }}>₹{(item.rate * (item.multiplier || 1)).toFixed(2)}</td>
                        <td style={{ textAlign: 'right', padding: '6px 4px', fontWeight: 'bold', color: '#0d6efd' }}>₹{item.total.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '2px solid #000', marginTop: '10px', paddingTop: '10px', fontWeight: 'bold', fontSize: '1.05rem' }}>
                  <span>TOTAL</span>
                  <span style={{ color: '#198754' }}>₹{viewingReceipt.total.toFixed(2)}</span>
                </div>
              </div>
            ) : (
              /* ── Receipt list ── */
              <div>
                {/* Filter bar */}
                <div className="card" style={{ padding: '12px 14px', marginBottom: '12px' }}>
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
                    <div style={{ flex: 1, minWidth: '130px' }}>
                      <label style={{ fontSize: '0.7rem', fontWeight: 'bold', color: '#6c757d', display: 'block', marginBottom: '3px' }}>FROM DATE</label>
                      <input
                        type="date"
                        value={receiptFromDate}
                        onChange={e => setReceiptFromDate(e.target.value)}
                        style={{ width: '100%', padding: '7px 8px', borderRadius: '7px', border: '1px solid #ccc', fontSize: '0.88rem', boxSizing: 'border-box' }}
                      />
                    </div>
                    <div style={{ flex: 1, minWidth: '130px' }}>
                      <label style={{ fontSize: '0.7rem', fontWeight: 'bold', color: '#6c757d', display: 'block', marginBottom: '3px' }}>TO DATE</label>
                      <input
                        type="date"
                        value={receiptToDate}
                        onChange={e => setReceiptToDate(e.target.value)}
                        style={{ width: '100%', padding: '7px 8px', borderRadius: '7px', border: '1px solid #ccc', fontSize: '0.88rem', boxSizing: 'border-box' }}
                      />
                    </div>
                    <div style={{ flex: 2, minWidth: '160px' }}>
                      <label style={{ fontSize: '0.7rem', fontWeight: 'bold', color: '#6c757d', display: 'block', marginBottom: '3px' }}>SEARCH BILL / CUSTOMER</label>
                      <input
                        type="text"
                        placeholder="Bill no or name..."
                        value={receiptSearch}
                        onChange={e => setReceiptSearch(e.target.value)}
                        style={{ width: '100%', padding: '7px 8px', borderRadius: '7px', border: '1px solid #ccc', fontSize: '0.88rem', boxSizing: 'border-box' }}
                      />
                    </div>
                    {(receiptFromDate || receiptToDate || receiptSearch) && (
                      <button
                        onClick={() => { setReceiptFromDate(''); setReceiptToDate(''); setReceiptSearch(''); }}
                        style={{ padding: '7px 12px', background: '#f1f5f9', border: '1px solid #ccc', borderRadius: '7px', cursor: 'pointer', fontWeight: 'bold', fontSize: '0.82rem', color: '#555', whiteSpace: 'nowrap', alignSelf: 'flex-end' }}
                      >✕ Clear</button>
                    )}
                  </div>
                  {/* Summary row */}
                  {(() => {
                    const from = receiptFromDate ? new Date(receiptFromDate + 'T00:00:00') : null;
                    const to   = receiptToDate   ? new Date(receiptToDate   + 'T23:59:59') : null;
                    const q    = receiptSearch.trim().toLowerCase();
                    const filtered = [...allSales].reverse().filter(r => {
                      const d = new Date(r.date);
                      if (from && d < from) return false;
                      if (to   && d > to)   return false;
                      if (q && !r.receipt_no.toLowerCase().includes(q) && !(r.customerName || '').toLowerCase().includes(q) && !(r.customerPhone || '').toLowerCase().includes(q)) return false;
                      return true;
                    });
                    if (!from && !to && !q) return null;
                    const total = filtered.reduce((s, r) => s + r.total, 0);
                    return (
                      <div style={{ marginTop: '8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.82rem', color: '#555' }}>
                        <span>{filtered.length} bill{filtered.length !== 1 ? 's' : ''} found</span>
                        <span style={{ fontWeight: 'bold', color: '#16a34a', fontSize: '0.95rem' }}>Total: ₹{total.toFixed(2)}</span>
                      </div>
                    );
                  })()}
                </div>

                {allSales.length === 0 ? (
                  <div style={{ textAlign: 'center', marginTop: '3rem', color: '#6c757d' }}>No receipts yet. Complete a checkout to see bills here.</div>
                ) : (() => {
                  const from = receiptFromDate ? new Date(receiptFromDate + 'T00:00:00') : null;
                  const to   = receiptToDate   ? new Date(receiptToDate   + 'T23:59:59') : null;
                  const q    = receiptSearch.trim().toLowerCase();
                  const filtered = [...allSales].reverse().filter(r => {
                    const d = new Date(r.date);
                    if (from && d < from) return false;
                    if (to   && d > to)   return false;
                    if (q && !r.receipt_no.toLowerCase().includes(q) && !(r.customerName || '').toLowerCase().includes(q) && !(r.customerPhone || '').toLowerCase().includes(q)) return false;
                    return true;
                  });
                  if (filtered.length === 0) return (
                    <div style={{ textAlign: 'center', marginTop: '2rem', color: '#6c757d' }}>No receipts match this filter.</div>
                  );
                  return filtered.map(receipt => (
                    <div
                      key={receipt.receipt_no}
                      onClick={() => setViewingReceipt(receipt)}
                      className="card"
                      style={{ padding: '12px 16px', marginBottom: '8px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px' }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 'bold', fontSize: '1rem', color: '#0a3d62' }}>#{receipt.receipt_no}</div>
                        <div style={{ fontSize: '0.78rem', color: '#6c757d', marginTop: '2px' }}>{receipt.date}</div>
                        {receipt.customerName && <div style={{ fontSize: '0.8rem', color: '#444', marginTop: '2px' }}>👤 {receipt.customerName}{receipt.customerPhone ? ` · ${receipt.customerPhone}` : ''}</div>}
                        <div style={{ fontSize: '0.75rem', color: '#9ca3af', marginTop: '2px' }}>{receipt.items.length} item{receipt.items.length !== 1 ? 's' : ''}</div>
                      </div>
                      <div style={{ textAlign: 'right', flexShrink: 0 }}>
                        <div style={{ fontWeight: 'bold', fontSize: '1.1rem', color: '#198754' }}>₹{receipt.total.toFixed(2)}</div>
                        <div style={{ fontSize: '0.72rem', color: '#adb5bd', marginTop: '2px' }}>tap to view →</div>
                      </div>
                    </div>
                  ));
                })()}
              </div>
            )}
          </div>
        )}

        {activeTab === 'reports' && (
          <div style={{ textAlign: 'center' }}>
            <h2 style={{ fontWeight: 'bold', marginBottom: '1rem' }}>Reports</h2>
            <div className="card" style={{ padding: '3rem' }}>
              <h6 style={{ color: '#6c757d', fontSize: '0.875rem', fontWeight: 'bold' }}>TOTAL NET PROFIT (OFFLINE SALES)</h6>
              <h1 className="reports-profit" style={{ color: '#198754', fontWeight: 'bold', margin: '1rem 0' }}>₹{totalProfit.toFixed(2)}</h1>
              <button
                onClick={() => {
                  getSalesHistory().then((sales: Receipt[]) => setTotalProfit(sales.reduce((a: number, b: Receipt) => a + b.total, 0)));
                }}
                style={{ background: 'transparent', border: '1px solid #0d6efd', color: '#0d6efd', padding: '5px 15px', borderRadius: '5px', cursor: 'pointer' }}
              >
                Refresh
              </button>
            </div>

            <div className="card" style={{ marginTop: '20px', padding: '20px', background: '#f8f9fa', border: '1px dashed #6c757d' }}>
              <h4 style={{ margin: 0, color: '#333', fontWeight: 'bold' }}>💾 SYSTEM BACKUP & RESTORE</h4>
              <p style={{ fontSize: '0.85rem', color: '#6c757d', marginBottom: '15px' }}>Backup all inventory, sales, and customer data to a JSON file.</p>
              
              <div style={{ display: 'flex', gap: '10px', justifyContent: 'center', flexWrap: 'wrap' }}>
                <button 
                  onClick={handleBackup}
                  style={{ background: '#0d6efd', color: 'white', border: 'none', padding: '10px 20px', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer' }}
                >
                  📥 DOWNLOAD BACKUP
                </button>
                
                <label style={{ background: '#6c757d', color: 'white', padding: '10px 20px', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer' }}>
                  📤 RESTORE DATA
                  <input type="file" accept=".json" onChange={handleRestore} style={{ display: 'none' }} />
                </label>
              </div>
            </div>
          </div>
        )}
      </div>

      {modalItem && (
        <div className="modal-overlay">
          <div className="modal-content">
            <div className="modal-header">
              <span>{modalItem.isEdit ? "EDIT ITEM" : "CONFIRM ITEM"}</span>
              <button style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: '1.2rem' }} onClick={() => setModalItem(null)}>✕</button>
            </div>
            <div style={{ textAlign: 'center', marginBottom: '10px', fontSize: '0.875rem', color: '#6c757d', fontWeight: 'bold' }}>
              QUANTITY
            </div>
            <div style={{ display: 'flex', gap: '10px', marginBottom: '15px' }}>
              <input
                autoFocus
                type="number"
                inputMode="decimal"
                className="modal-input"
                style={{ marginBottom: 0, flexGrow: 1 }}
                value={isNaN(modalItem.qty) ? "" : modalItem.qty}
                onFocus={(e) => e.target.select()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    rateInputRef.current?.focus();
                    rateInputRef.current?.select();
                  }
                }}
                onChange={(e) => setModalItem({ ...modalItem, qty: Number(e.target.value) })}
              />
              <select
                value={modalItem.cartUnit}
                onChange={(e) => {
                  const u = e.target.value;
                  const customRate = (modalItem.item as InventoryItem).unit_rates?.[u];
                  if (customRate !== undefined) {
                    setModalItem({ ...modalItem, cartUnit: u, rate: customRate, multiplier: 1 });
                  } else {
                    const bu = (modalItem.item.unit || "unit").toLowerCase();
                    const m = getUnitMultiplier(u, bu);
                    setModalItem({ ...modalItem, cartUnit: u, rate: (modalItem.item as InventoryItem).price || 0, multiplier: m });
                  }
                }}
                style={{ padding: '10px', borderRadius: '8px', border: '1px solid #ccc', fontWeight: 'bold' }}
              >
                {(() => {
                  const baseUnit = modalItem.item.unit || "unit";
                  const customUnits = Object.keys((modalItem.item as InventoryItem).unit_rates || {});
                  const standardUnits = ['g', 'kg', 'l', 'box', 'mal', 'ml', 'dozen', 'pcs', 'bag', 'packet'];
                  const allUnits = [baseUnit, ...new Set([...customUnits, ...standardUnits].filter(u => u !== baseUnit))];
                  return allUnits.map(opt => (
                    <option key={opt} value={opt}>
                      {opt}{(modalItem.item as InventoryItem).unit_rates?.[opt] !== undefined ? ` ₹${(modalItem.item as InventoryItem).unit_rates![opt]}` : ''}
                    </option>
                  ));
                })()}
              </select>
            </div>
            <div style={{ textAlign: 'center', marginBottom: '10px', fontSize: '0.875rem', color: '#6c757d', fontWeight: 'bold', marginTop: '15px' }}>
              RATE (per {modalItem.cartUnit})
            </div>
            <input
              type="number"
              inputMode="decimal"
              className="modal-input"
              ref={rateInputRef}
              value={isNaN(modalItem.rate * modalItem.multiplier) ? "" : Number((modalItem.rate * modalItem.multiplier).toFixed(3))}
              step="0.01"
              onFocus={(e) => e.target.select()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  totalInputRef.current?.focus();
                  totalInputRef.current?.select();
                }
              }}
              onChange={(e) => {
                const newScaledRate = Number(e.target.value);
                const baseRate = newScaledRate / modalItem.multiplier;
                setModalItem({ ...modalItem, rate: baseRate });
              }}
            />
            <div style={{ textAlign: 'center', marginBottom: '10px', fontSize: '0.875rem', color: '#6c757d', fontWeight: 'bold', marginTop: '15px' }}>
              TOTAL AMOUNT
            </div>
            <input
              type="number"
              inputMode="decimal"
              className="modal-input"
              ref={totalInputRef}
              value={isNaN(modalItem.qty * modalItem.rate * modalItem.multiplier) ? "" : Number((modalItem.qty * modalItem.rate * modalItem.multiplier).toFixed(2))}
              step="0.01"
              onFocus={(e) => e.target.select()}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleModalSubmit(); } }}
              onChange={(e) => {
                const newTotal = Number(e.target.value);
                if (modalItem.qty > 0 && modalItem.multiplier > 0) {
                  const baseRate = newTotal / (modalItem.qty * modalItem.multiplier);
                  setModalItem({ ...modalItem, rate: baseRate });
                }
              }}
            />
            <div style={{ textAlign: 'center', fontSize: '0.78rem', color: '#16A34A', fontWeight: 'bold', marginBottom: '15px', marginTop: '-8px' }}>
              Rate per {modalItem.cartUnit}: ₹{(modalItem.rate * modalItem.multiplier).toFixed(2)}
            </div>
            <button className="modal-btn" onClick={handleModalSubmit}>
              {modalItem.isEdit ? "UPDATE ITEM" : "ADD TO BILL"}
            </button>
          </div>
        </div>
      )}

      {inventoryEditItem && (
        <div className="modal-overlay">
          <div className="modal-content" style={{ padding: '15px' }}>
            <div className="modal-header" style={{ marginBottom: '10px', fontSize: '1.1rem' }}>
              <span>EDIT INVENTORY ITEM</span>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '6px' }}>
                <button style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: '1.2rem', lineHeight: 1 }} onClick={() => setInventoryEditItem(null)}>✕</button>
                {inventory.find(i => i.id === inventoryEditItem.id) && (
                  <button
                    onClick={deleteInventoryItem}
                    style={{ border: 'none', background: '#dc3545', color: 'white', cursor: 'pointer', fontSize: '0.7rem', fontWeight: 'bold', borderRadius: '4px', padding: '3px 8px', lineHeight: 1.4 }}
                  >
                    DELETE
                  </button>
                )}
              </div>
            </div>
            
            <label style={{ fontSize: '0.75rem', fontWeight: 'bold', color: '#6c757d', marginBottom: '4px', display: 'block' }}>NAME (MARATHI / ENG)</label>
            <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
              <input
                type="text"
                className="edit-input"
                style={{ flex: 1 }}
                value={inventoryEditItem.name_marathi || inventoryEditItem.name}
                onChange={(e) => setInventoryEditItem({ ...inventoryEditItem, name_marathi: e.target.value, name: e.target.value })}
                onKeyDown={editModalKeyDown}
              />
              <button
                type="button"
                onClick={startEditVoice}
                title="Speak item name"
                style={{
                  flexShrink: 0, width: 40, height: 40, borderRadius: 8, border: 'none',
                  background: isEditVoiceActive ? '#DC2626' : '#0a3d62',
                  color: 'white', fontSize: '1.1rem', cursor: 'pointer',
                  animation: isEditVoiceActive ? 'pulse 1.5s infinite' : 'none',
                }}
              >🎙</button>
              <button
                type="button"
                onClick={toggleEditNameLanguage}
                title={/[ऀ-ॿ]/.test(inventoryEditItem.name_marathi || inventoryEditItem.name || '') ? 'Convert to English' : 'Convert to Marathi'}
                style={{
                  flexShrink: 0, width: 40, height: 40, borderRadius: 8, border: '1px solid #ccc',
                  background: '#f8f9fa', color: '#0a3d62', fontSize: '1rem',
                  fontWeight: 'bold', cursor: 'pointer', fontFamily: '"Noto Sans Devanagari", sans-serif',
                }}
              >
                {/[ऀ-ॿ]/.test(inventoryEditItem.name_marathi || inventoryEditItem.name || '') ? 'A' : 'अ'}
              </button>
            </div>

            <label style={{ fontSize: '0.75rem', fontWeight: 'bold', color: '#6c757d', marginBottom: '2px', marginTop: '10px', display: 'block' }}>BARCODE (Optional)</label>
            <div style={{ display: 'flex', gap: '5px' }}>
              <input
                type="text"
                className="edit-input"
                style={{ flex: 1 }}
                placeholder="Scan or type barcode"
                value={inventoryEditItem.barcode || ''}
                onChange={(e) => setInventoryEditItem({ ...inventoryEditItem, barcode: e.target.value })}
                onKeyDown={editModalKeyDown}
              />
              <button
                onClick={() => {
                  const html5Qrcode = new Html5Qrcode("reader-edit", {
                    formatsToSupport: [
                      Html5QrcodeSupportedFormats.EAN_13,
                      Html5QrcodeSupportedFormats.EAN_8,
                      Html5QrcodeSupportedFormats.UPC_A,
                      Html5QrcodeSupportedFormats.UPC_E,
                      Html5QrcodeSupportedFormats.CODE_128,
                      Html5QrcodeSupportedFormats.CODE_39,
                      Html5QrcodeSupportedFormats.QR_CODE,
                    ],
                    verbose: false,
                    experimentalFeatures: { useBarCodeDetectorIfSupported: true },
                  } as any);
                  const modal = document.getElementById("edit-barcode-scanner");
                  if (modal) modal.style.display = "flex";
                  html5Qrcode.start(
                    { facingMode: "environment" },
                    { fps: 10, qrbox: { width: 250, height: 100 }, aspectRatio: 1.7778 },
                    (text: string) => {
                      setInventoryEditItem({ ...inventoryEditItem, barcode: text.trim() });
                      html5Qrcode.stop().catch(() => {});
                      if (modal) modal.style.display = "none";
                    },
                    () => {}
                  ).catch((err: any) => {
                    console.error(err);
                    if (modal) modal.style.display = "none";
                    alert("Could not access camera. Please allow camera permission.");
                  });
                }}
                style={{ background: '#6c757d', color: 'white', border: 'none', padding: '0 10px', borderRadius: '5px', cursor: 'pointer' }}
              >
                📷 Scan
              </button>
            </div>

            <div id="edit-barcode-scanner" style={{ display: 'none', position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.8)', zIndex: 5000, justifyContent: 'center', alignItems: 'center', flexDirection: 'column' }}>
               <div style={{ background: 'white', padding: '16px', borderRadius: '10px', width: '90%', maxWidth: '400px' }}>
                 <p style={{ textAlign: 'center', fontSize: '0.8rem', color: '#555', margin: '0 0 8px' }}>Align barcode with the scan area</p>
                 <div id="reader-edit" style={{ width: '100%' }} />
                 <button onClick={() => { document.getElementById("edit-barcode-scanner")!.style.display = "none"; }} style={{ width: '100%', marginTop: '10px', padding: '10px', background: '#dc3545', color: 'white', border: 'none', borderRadius: '5px', fontWeight: 'bold', cursor: 'pointer' }}>Cancel</button>
               </div>
            </div>

            <div style={{ display: 'flex', gap: '10px', marginTop: '10px' }}>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: '0.75rem', fontWeight: 'bold', color: '#6c757d', marginBottom: '2px', display: 'block' }}>PURCHASE RATE</label>
                <input
                  type="number"
                  inputMode="decimal"
                  className="edit-input"
                  value={isNaN(inventoryEditItem.purchase_price as number) ? "" : inventoryEditItem.purchase_price}
                  onChange={(e) => setInventoryEditItem({ ...inventoryEditItem, purchase_price: Number(e.target.value) })}
                  onKeyDown={editModalKeyDown}
                />
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: '0.75rem', fontWeight: 'bold', color: '#6c757d', marginBottom: '2px', display: 'block' }}>SALE RATE</label>
                <input
                  type="number"
                  inputMode="decimal"
                  className="edit-input"
                  value={isNaN(inventoryEditItem.price as number) ? "" : inventoryEditItem.price}
                  onChange={(e) => setInventoryEditItem({ ...inventoryEditItem, price: Number(e.target.value) })}
                  onKeyDown={editModalKeyDown}
                />
              </div>
            </div>

            <div style={{ display: 'flex', gap: '10px', marginTop: '10px' }}>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: '0.75rem', fontWeight: 'bold', color: '#6c757d', marginBottom: '2px', display: 'block' }}>STOCK QTY</label>
                <input
                  type="number"
                  inputMode="decimal"
                  className="edit-input"
                  value={isNaN(inventoryEditItem.stock_quantity as number) ? "" : inventoryEditItem.stock_quantity}
                  onChange={(e) => setInventoryEditItem({ ...inventoryEditItem, stock_quantity: Number(e.target.value), stock_qty: Number(e.target.value) })}
                  onKeyDown={editModalKeyDown}
                />
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: '0.75rem', fontWeight: 'bold', color: '#6c757d', marginBottom: '2px', display: 'block' }}>UNIT (e.g. kg, L, pcs)</label>
                <input
                  type="text"
                  className="edit-input"
                  value={inventoryEditItem.unit || ''}
                  onChange={(e) => setInventoryEditItem({ ...inventoryEditItem, unit: e.target.value })}
                  onKeyDown={editModalKeyDown}
                />
              </div>
            </div>

            {/* Unit Rates */}
            <div style={{ marginTop: '14px' }}>
              <label style={{ fontSize: '0.75rem', fontWeight: 'bold', color: '#6c757d', marginBottom: '6px', display: 'block' }}>
                UNIT RATES (optional — e.g. bag ₹550, 250g ₹35)
              </label>
              {Object.entries(inventoryEditItem.unit_rates || {}).map(([u, r]) => (
                <div key={u} style={{ display: 'flex', gap: '8px', marginBottom: '6px', alignItems: 'center' }}>
                  <input
                    type="text"
                    className="edit-input"
                    style={{ flex: 1 }}
                    value={u}
                    readOnly
                  />
                  <input
                    type="number"
                    inputMode="decimal"
                    className="edit-input"
                    style={{ flex: 1 }}
                    value={r}
                    onChange={(e) => {
                      const updated = { ...(inventoryEditItem.unit_rates || {}), [u]: Number(e.target.value) };
                      setInventoryEditItem({ ...inventoryEditItem, unit_rates: updated });
                    }}
                  />
                  <button
                    onClick={() => {
                      const updated = { ...(inventoryEditItem.unit_rates || {}) };
                      delete updated[u];
                      setInventoryEditItem({ ...inventoryEditItem, unit_rates: updated });
                    }}
                    style={{ padding: '6px 10px', background: '#dc3545', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold', flexShrink: 0 }}
                  >✕</button>
                </div>
              ))}
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <input
                  type="text"
                  className="edit-input"
                  style={{ flex: 1 }}
                  placeholder="unit (e.g. bag)"
                  value={newRateUnit}
                  onChange={(e) => setNewRateUnit(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); (e.currentTarget.nextSibling as HTMLInputElement)?.focus(); } }}
                />
                <input
                  type="number"
                  inputMode="decimal"
                  className="edit-input"
                  style={{ flex: 1 }}
                  placeholder="rate ₹"
                  value={newRateValue}
                  onChange={(e) => setNewRateValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      const u = newRateUnit.trim().toLowerCase();
                      const r = parseFloat(newRateValue);
                      if (u && !isNaN(r) && r > 0) {
                        setInventoryEditItem({ ...inventoryEditItem, unit_rates: { ...(inventoryEditItem.unit_rates || {}), [u]: r } });
                        setNewRateUnit(''); setNewRateValue('');
                      }
                    }
                  }}
                />
                <button
                  onClick={() => {
                    const u = newRateUnit.trim().toLowerCase();
                    const r = parseFloat(newRateValue);
                    if (!u || isNaN(r) || r <= 0) return;
                    setInventoryEditItem({ ...inventoryEditItem, unit_rates: { ...(inventoryEditItem.unit_rates || {}), [u]: r } });
                    setNewRateUnit(''); setNewRateValue('');
                  }}
                  style={{ padding: '6px 12px', background: '#198754', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold', flexShrink: 0 }}
                >+ ADD</button>
              </div>
            </div>

            <button className="modal-btn" onClick={saveInventoryEdit} style={{ marginTop: '20px' }}>
              SAVE CHANGES
            </button>
          </div>
        </div>
      )}

      {showHeldBills && (
        <div className="modal-overlay" style={{ zIndex: 4000 }}>
          <div className="modal-content" style={{ maxWidth: '420px', width: '95%' }}>
            <div className="modal-header">
              <span>⏸ HELD BILLS</span>
              <button style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: '1.5rem' }} onClick={() => setShowHeldBills(false)}>✕</button>
            </div>
            {heldBills.length === 0 ? (
              <p style={{ textAlign: 'center', color: '#6c757d' }}>No held bills.</p>
            ) : (
              heldBills.map(h => {
                const total = h.cart.reduce((s, c) => s + c.total, 0);
                const mins = Math.floor((Date.now() - h.heldAt) / 60000);
                return (
                  <div key={h.id} style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: '12px 14px', marginBottom: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <div>
                        {h.customerName && <div style={{ fontWeight: 700, color: '#0a3d62' }}>👤 {h.customerName}</div>}
                        <div style={{ fontSize: '0.82rem', color: '#6c757d' }}>{h.cart.length} item{h.cart.length !== 1 ? 's' : ''} · {mins < 1 ? 'just now' : `${mins}m ago`}</div>
                        <div style={{ fontWeight: 700, fontSize: '1.1rem', color: '#16a34a', marginTop: 2 }}>₹{total.toFixed(2)}</div>
                        <div style={{ fontSize: '0.78rem', color: '#555', marginTop: 3 }}>
                          {h.cart.slice(0, 3).map(c => c.name).join(', ')}{h.cart.length > 3 ? '...' : ''}
                        </div>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginLeft: 10 }}>
                        <button onClick={() => resumeBill(h.id)} style={{ background: '#6366f1', color: 'white', border: 'none', borderRadius: 7, padding: '7px 14px', fontWeight: 700, cursor: 'pointer', fontSize: '0.85rem' }}>▶ Resume</button>
                        <button onClick={() => discardHeldBill(h.id)} style={{ background: 'transparent', color: '#dc3545', border: '1px solid #dc3545', borderRadius: 7, padding: '5px 14px', fontWeight: 700, cursor: 'pointer', fontSize: '0.85rem' }}>✕ Discard</button>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {isScanning && (
        <div className="modal-overlay" style={{ zIndex: 4000 }}>
          <div className="modal-content" style={{ maxWidth: '480px', width: '95%', padding: '14px' }}>
            <div className="modal-header" style={{ marginBottom: '8px' }}>
              <span>📷 BARCODE SCANNER</span>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                {torchSupported && (
                  <button onClick={toggleTorch} title="Toggle flashlight"
                    style={{ background: torchOn ? '#f59e0b' : '#e5e7eb', border: 'none', borderRadius: 8, padding: '6px 10px', cursor: 'pointer', fontSize: '1.1rem' }}>
                    🔦
                  </button>
                )}
                <button style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: '1.5rem' }} onClick={() => setIsScanning(false)}>✕</button>
              </div>
            </div>

            {/* The library injects <video> directly into this div — no overflow:hidden here */}
            <div id="reader" style={{ width: '100%' }} />

            <div style={{ marginTop: 8, minHeight: 24, textAlign: 'center' }}>
              {scanFeedback
                ? <span style={{ fontWeight: 'bold', color: '#16a34a', fontSize: '0.9rem' }}>{scanFeedback}</span>
                : <span style={{ color: '#6c757d', fontSize: '0.8rem' }}>Point camera at barcode — keep it inside the box</span>
              }
            </div>
          </div>
        </div>
      )}

      {isCustomerModalOpen && (
        <div className="modal-overlay" style={{ zIndex: 4000 }}>
          <div className="modal-content" style={{ maxWidth: '400px', width: '90%' }}>
            <div className="modal-header">
              <span>CUSTOMER DETAILS</span>
              <button style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: '1.5rem' }} onClick={() => setIsCustomerModalOpen(false)}>✕</button>
            </div>
            
            <div style={{ padding: '10px 0' }}>
              <label style={{ fontSize: '0.75rem', fontWeight: 'bold', color: '#6c757d', marginBottom: '5px', display: 'block' }}>CUSTOMER NAME</label>
              <input
                type="text"
                className="edit-input"
                placeholder="Enter customer name"
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
                autoFocus
              />

              <label style={{ fontSize: '0.75rem', fontWeight: 'bold', color: '#6c757d', marginBottom: '5px', marginTop: '15px', display: 'block' }}>MOBILE NUMBER</label>
              <input
                type="text"
                className="edit-input"
                placeholder="Enter mobile number"
                value={customerPhone}
                onChange={(e) => setCustomerPhone(e.target.value)}
              />

              <button 
                onClick={() => setIsCustomerModalOpen(false)}
                style={{ width: '100%', marginTop: '20px', padding: '12px', background: '#0d6efd', color: 'white', border: 'none', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer' }}
              >
                SAVE DETAILS
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Receipt Share Modal */}
      {receiptShareOpen && lastReceipt && (
        <div className="modal-overlay" style={{ zIndex: 5000 }}>
          <div className="modal-content" style={{ maxWidth: '420px', width: '95%', maxHeight: '90vh', overflowY: 'auto', padding: '15px' }}>
            <div className="modal-header" style={{ marginBottom: '10px' }}>
              <span>✅ BILL SAVED</span>
              <button style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: '1.5rem' }} onClick={() => setReceiptShareOpen(false)}>✕</button>
            </div>

            {/* Visible receipt card — mimics 80mm thermal output */}
            <div ref={receiptCardRef} style={{ background: '#fff', padding: '12px 14px', borderRadius: '8px', border: '1px solid #ddd', marginBottom: '12px', fontFamily: "'Courier New', Courier, monospace", fontSize: '11px', lineHeight: 1.4 }}>
              <div style={{ fontWeight: 'bold', fontSize: '15px', textAlign: 'center', letterSpacing: 1 }}>RAJENDRA GVB</div>
              <div style={{ fontSize: '9px', textAlign: 'center', color: '#555', marginBottom: '6px' }}>Fresh Groceries &amp; More</div>
              <div style={{ borderTop: '2px solid #000', borderBottom: '1px dashed #aaa', padding: '5px 0', margin: '0 0 6px 0', fontSize: '10px' }}>
                <div>Bill No : <b>{lastReceipt.receipt_no}</b></div>
                <div>Date    : {lastReceipt.date}</div>
                {lastReceipt.customerName  && <div>Customer: {lastReceipt.customerName}</div>}
                {lastReceipt.customerPhone && <div>Mobile  : {lastReceipt.customerPhone}</div>}
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid #000', fontSize: '9px' }}>
                    <th style={{ textAlign: 'left', padding: '2px 1px', width: '44%' }}>ITEM</th>
                    <th style={{ textAlign: 'center', padding: '2px 1px', width: '14%' }}>QTY</th>
                    <th style={{ textAlign: 'right', padding: '2px 1px', width: '20%' }}>RATE</th>
                    <th style={{ textAlign: 'right', padding: '2px 1px', width: '22%' }}>AMT</th>
                  </tr>
                </thead>
                <tbody>
                  {lastReceipt.items.map((item, idx) => (
                    <tr key={idx} style={{ borderBottom: '1px dashed #ccc', fontSize: '10px' }}>
                      <td style={{ padding: '3px 1px', wordBreak: 'break-word' }}>{item.name}</td>
                      <td style={{ textAlign: 'center', padding: '3px 1px' }}>{item.qty}{item.cartUnit && item.cartUnit !== item.unit ? item.cartUnit : ''}</td>
                      <td style={{ textAlign: 'right', padding: '3px 1px' }}>{(item.rate * (item.multiplier || 1)).toFixed(2)}</td>
                      <td style={{ textAlign: 'right', padding: '3px 1px' }}>{item.total.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ textAlign: 'right', fontSize: '8px', color: '#666', marginTop: '2px' }}>{lastReceipt.items.length} item{lastReceipt.items.length !== 1 ? 's' : ''}</div>
              <div style={{ borderTop: '2px solid #000', marginTop: '5px', paddingTop: '5px', display: 'flex', justifyContent: 'space-between', fontWeight: 'bold', fontSize: '13px' }}>
                <span>TOTAL</span>
                <span>Rs.{lastReceipt.total.toFixed(2)}</span>
              </div>
              <div style={{ textAlign: 'center', marginTop: '8px', fontSize: '8px', color: '#888' }}>*** Thank You — Visit Again! ***</div>
            </div>

            {/* Share action buttons */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <button
                onClick={shareWhatsApp}
                style={{ width: '100%', padding: '14px', background: '#25D366', color: 'white', border: 'none', borderRadius: '10px', fontWeight: 'bold', fontSize: '1rem', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}
              >
                📲 Share on WhatsApp
              </button>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  onClick={downloadReceiptImage}
                  style={{ flex: 1, padding: '12px', background: '#0d6efd', color: 'white', border: 'none', borderRadius: '10px', fontWeight: 'bold', fontSize: '0.9rem', cursor: 'pointer' }}
                >
                  🖼️ Download Image
                </button>
                <button
                  onClick={() => { setReceiptShareOpen(false); setTimeout(() => window.print(), 300); }}
                  style={{ flex: 1, padding: '12px', background: '#333', color: 'white', border: 'none', borderRadius: '10px', fontWeight: 'bold', fontSize: '0.9rem', cursor: 'pointer' }}
                >
                  🖨️ Print
                </button>
              </div>
              {'share' in navigator && (
                <button
                  onClick={shareReceiptNative}
                  style={{ width: '100%', padding: '12px', background: '#6c757d', color: 'white', border: 'none', borderRadius: '10px', fontWeight: 'bold', fontSize: '0.9rem', cursor: 'pointer' }}
                >
                  🔗 Share via Other Apps
                </button>
              )}
              <button
                onClick={() => setReceiptShareOpen(false)}
                style={{ width: '100%', padding: '10px', background: 'transparent', border: '1px solid #ccc', borderRadius: '10px', fontWeight: 'bold', color: '#666', cursor: 'pointer' }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Hidden Print Wrapper — optimised for 80mm thermal (PosBox / similar) */}
      <div id="printReceiptArea">
        {lastReceipt && (
          <>
            {/* Store header */}
            <div className="rp-store-name">RAJENDRA GVB</div>
            <div className="rp-sub">Fresh Groceries &amp; More</div>
            <hr className="rp-divider-solid" />

            {/* Bill meta */}
            <div className="rp-meta">Bill No : <b>{lastReceipt.receipt_no}</b></div>
            <div className="rp-meta">Date    : {lastReceipt.date}</div>
            {lastReceipt.customerName  && <div className="rp-meta">Customer: {lastReceipt.customerName}</div>}
            {lastReceipt.customerPhone && <div className="rp-meta">Mobile  : {lastReceipt.customerPhone}</div>}
            <hr className="rp-divider" />

            {/* Items table */}
            <table className="receipt-table">
              <thead>
                <tr>
                  <th className="col-item">Item</th>
                  <th className="col-qty">Qty</th>
                  <th className="col-rate">Rate</th>
                  <th className="col-amt">Amt</th>
                </tr>
              </thead>
              <tbody>
                {lastReceipt.items.map((item, idx) => (
                  <tr key={idx}>
                    <td className="col-item">{item.name}</td>
                    <td className="col-qty">{item.qty}{item.cartUnit && item.cartUnit !== item.unit ? item.cartUnit : ''}</td>
                    <td className="col-rate">{(item.rate * (item.multiplier || 1)).toFixed(2)}</td>
                    <td className="col-amt">{item.total.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="rp-items-count">{lastReceipt.items.length} item{lastReceipt.items.length !== 1 ? 's' : ''}</div>

            <hr className="rp-divider-solid" />
            <div className="rp-total-row">
              <span>TOTAL</span>
              <span>Rs.{lastReceipt.total.toFixed(2)}</span>
            </div>
            <hr className="rp-divider" />

            <div className="rp-footer">
              *** Thank You — Visit Again! ***
            </div>
          </>
        )}
      </div>
    </>
  );
}
