import React, { useState, useEffect, useRef } from "react";
import { useAuth } from "./contexts/AuthContext";
import { Html5Qrcode, Html5QrcodeSupportedFormats } from "html5-qrcode";
import Fuse from "fuse.js";
import localforage from 'localforage';
import html2canvas from 'html2canvas';
import { saveSale, getSalesHistory } from "./lib/db";
import type { CartItem, Receipt } from "./lib/db";
import { translateHinglishToMarathi, normalizeForSearch, HINGLISH_TO_MARATHI, parseUserQuery, scoreCandidate } from "./lib/phonetic";

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
  const [isDictating, setIsDictating] = useState(false);

  // Inventory state
  const [stockQuery, setStockQuery] = useState("");
  const [imeEnabled, setImeEnabled] = useState(true);
  const [stockPage, setStockPage] = useState(1);
  const ITEMS_PER_PAGE = 10;
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());
  const [brandIndex, setBrandIndex] = useState<Set<string>>(new Set());

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
  const receiptCardRef = useRef<HTMLDivElement>(null);

  const formatName = (name: string) => {
    return (name || "").replace(/\s*\([\d\.\s]*(kg|g|gm|ml|l|L|Piece|Pack|Pack of \d+|unit|liter|litre)\)\s*$/i, "").trim();
  };

  // Load Inventory Offline
  useEffect(() => {
    const loadInventory = async () => {
      try {
        let loadedItems: InventoryItem[] = [];

        // Always fetch inventory.json first — it is the canonical source of truth.
        // This ensures the app reflects the latest Excel-converted data on every load.
        try {
          const response = await fetch("/inventory.json");
          if (response.ok) {
            const json = await response.json();
            if (Array.isArray(json) && json.length > 0) {
              loadedItems = json;
              await localforage.setItem('custom_inventory', json); // cache for offline
            }
          }
        } catch (_) {}

        // Offline fallback: use whatever is cached in LocalForage
        if (loadedItems.length === 0) {
          const cached = await localforage.getItem('custom_inventory') as InventoryItem[];
          if (cached && Array.isArray(cached) && cached.length > 0) {
            loadedItems = cached;
          }
        }

        if (loadedItems.length > 0) {
          // Deduplicate items based on parsed cleanly formatted names
          setInventory(loadedItems);
          setFuse(new Fuse(loadedItems, {
            keys: [
              { name: "search_key",   weight: 3   },
              { name: "name_marathi", weight: 1.5 },
              { name: "name",         weight: 1   },
              { name: "name_eng",     weight: 1   },
              { name: "brand",        weight: 1   },
              { name: "id",           weight: 0.5 },
              { name: "barcode",      weight: 0.5 },
            ],
            threshold: 0.45,
            ignoreLocation: true,
            distance: 300,
            minMatchCharLength: 2,
            shouldSort: true,
            includeScore: true
          }));
        } else {
          setInventory([]);
        }
      } catch (err) {
        console.error("Failed to fetch inventory", err);
      }
    };
    loadInventory();
  }, []);

  useEffect(() => {
    localforage.getItem('favorite_ids').then((ids) => {
      if (ids && Array.isArray(ids)) setFavoriteIds(new Set(ids as string[]));
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
    const skMatches = inventory.filter(item => {
      const key = String(item.search_key || '').trim().toLowerCase();
      return key && (key === q || key.startsWith(q));
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
  const [inventoryEditItem, setInventoryEditItem] = useState<InventoryItem | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const scannerRef = useRef<any>(null);

  useEffect(() => {
    if (isScanning) {
      const html5Qrcode = new Html5Qrcode("reader", {
        formatsToSupport: [
          Html5QrcodeSupportedFormats.EAN_13,
          Html5QrcodeSupportedFormats.EAN_8,
          Html5QrcodeSupportedFormats.UPC_A,
          Html5QrcodeSupportedFormats.UPC_E,
          Html5QrcodeSupportedFormats.CODE_128,
          Html5QrcodeSupportedFormats.CODE_39,
          Html5QrcodeSupportedFormats.ITF,
          Html5QrcodeSupportedFormats.QR_CODE,
        ],
        verbose: false,
      });
      scannerRef.current = html5Qrcode;

      html5Qrcode.start(
        { facingMode: "environment" },
        { fps: 30, qrbox: { width: 300, height: 150 }, aspectRatio: 1.0, disableFlip: false },
        (decodedText) => {
          const match = inventory.find(i =>
            i.id.toLowerCase() === decodedText.toLowerCase() ||
            (i.barcode && i.barcode.toLowerCase() === decodedText.toLowerCase())
          );
          html5Qrcode.stop().then(() => {
            setIsScanning(false);
            if (match) {
              selectItemForModal(match);
            } else {
              const results = fuse?.search(decodedText);
              if (results && results.length > 0) {
                selectItemForModal(results[0].item);
              } else {
                alert(`Barcode "${decodedText}" not found in inventory.`);
              }
            }
          }).catch(() => {});
        },
        () => {}
      ).catch((err) => {
        console.error("Camera error:", err);
        setIsScanning(false);
        alert("Could not access camera. Please allow camera permission.");
      });
    } else {
      if (scannerRef.current) {
        try { scannerRef.current.stop(); } catch(e) {}
      }
    }
    return () => {
      if (scannerRef.current) {
        try { scannerRef.current.stop(); } catch(e) {}
      }
    };
  }, [isScanning, inventory, fuse]);

  const saveInventoryEdit = async () => {
    if (!inventoryEditItem) return;
    let newInv;
    const exists = inventory.find(i => i.id === inventoryEditItem.id);
    if (exists) {
      newInv = inventory.map(i => i.id === inventoryEditItem.id ? inventoryEditItem : i);
    } else {
      newInv = [...inventory, inventoryEditItem];
    }
    setInventory(newInv);
    await localforage.setItem('custom_inventory', newInv);
    setFuse(new Fuse(newInv, { keys: [{ name: "search_key", weight: 3 }, { name: "name_marathi", weight: 1.5 }, { name: "name", weight: 1 }, { name: "name_eng", weight: 1 }, { name: "brand", weight: 1 }], threshold: 0.45, ignoreLocation: true, distance: 300, minMatchCharLength: 2, shouldSort: true, includeScore: true }));
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
    setInventory(newInv);
    await localforage.setItem('custom_inventory', newInv);
    setFuse(new Fuse(newInv, { keys: [{ name: "search_key", weight: 3 }, { name: "name_marathi", weight: 1.5 }, { name: "name", weight: 1 }, { name: "name_eng", weight: 1 }, { name: "brand", weight: 1 }], threshold: 0.45, ignoreLocation: true, distance: 300, minMatchCharLength: 2, shouldSort: true, includeScore: true }));
    setInventoryEditItem(null);
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

  const selectItemForModal = (item: InventoryItem) => {
    let finalQty = 1;
    let finalCartUnit = item.unit || "unit";
    let finalMult = 1;

    if (voiceContext) {
      finalQty = voiceContext.qty;
      const baseUnit = (item.unit || "unit").toLowerCase();
      if (voiceContext.cartUnit) {
        finalCartUnit = voiceContext.cartUnit;
        finalMult = getUnitMultiplier(voiceContext.cartUnit, baseUnit);
      } else {
        finalCartUnit = baseUnit;
      }
      setVoiceContext(null);
    } else if (lastParsedRef.current) {
      finalQty = lastParsedRef.current.qty;
      const baseUnit = (item.unit || "unit").toLowerCase();
      finalCartUnit = lastParsedRef.current.cartUnit;
      finalMult = getUnitMultiplier(lastParsedRef.current.cartUnit, baseUnit);
      lastParsedRef.current = null;
    }

    setModalItem({
      item,
      qty: finalQty,
      rate: item.price || 0,
      isEdit: false,
      index: null,
      cartUnit: finalCartUnit,
      multiplier: finalMult
    });
    setSuggestions([]);
    setQuery("");
  };

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
    recognition.interimResults = false;

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
      const transcript = event.results[0][0].transcript;

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

      // Handle unit modifiers after a number is found
      if (/(ग्राम|ग्रॅम|गरम|gram|gm|grm)/.test(text)) {
        voiceUnit = 'g';
      } else if (/(डझन|डजन|dozen|dzn)/.test(text)) {
        voiceUnit = 'dozen';
      }

      // Clean the item name by removing all numbers and measurement words
      let cleanName = text.replace(/([\d\.]+)/g, '')
        .replace(/(kilo|kg|ग्राम|ग्रॅम|गरम|gram|gm|grm|packet|litre|liter|ltr|किलो|लिटर|पॅकेट)/g, '')
        .replace(/(छटाक|चटाक|चटक|chatak|chatk|chhatak|catak|shatak|पावशेर|पवशेर|पाव शेर|pavsher|pav sher|paavsher|pausher|powser|pavser|पाव किलो|पाव|paav|pav|paw|pao|पाऊण|पावुन|paun|pahun|pawun|अर्धा|अर्ध|अरधा|ardha|ardh|aradha|सव्वा|सवा|savva|sawa|sava|savwa|दीड|दिड|did|deed|dedh|अडीच|अडिच|adich|adhich|adeech|डझन|डजन|dozen|dzn)/g, '')
        .trim();

      // Always save qty/unit context and show the suggestion list so the user can pick.
      setVoiceContext({ qty: voiceQty, cartUnit: voiceUnit });
      // In Marathi mode apply Hinglish→Devanagari transliteration; in English mode use as-is.
      const searchQuery = cleanName
        ? (imeEnabled ? (translateHinglishToMarathi(cleanName) || cleanName) : cleanName)
        : transcript;
      setQuery(searchQuery);
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

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
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

        await localforage.setItem('custom_inventory', dedupedData);
        setInventory(dedupedData);
        setFuse(new Fuse(dedupedData, { keys: [{ name: "search_key", weight: 3 }, { name: "name_marathi", weight: 1.5 }, { name: "name", weight: 1 }, { name: "name_eng", weight: 1 }, { name: "brand", weight: 1 }, { name: "id", weight: 0.5 }, { name: "barcode", weight: 0.5 }], threshold: 0.45, ignoreLocation: true, distance: 300, minMatchCharLength: 2, shouldSort: true, includeScore: true }));
        alert(`Successfully loaded ${dedupedData.length} unique items (deduplicated from ${mappedItems.length}) to offline storage!`);
      };
      reader.readAsBinaryString(file);
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
            .sidebar, .main-content, .mobile-nav, .modal-overlay { display: none !important; }
            #printReceiptArea, #printReceiptArea * { visibility: visible; }
            #printReceiptArea { 
                display: block; position: absolute; left: 0; top: 0; width: 80mm; max-width: 100%; 
                padding: 10mm; font-family: 'Segoe UI', Arial, sans-serif; font-size: 11px; color: #000; 
                background: white; line-height: 1.3;
            }
            .receipt-header { text-align: center; border-bottom: 2px solid #000; margin-bottom: 8px; padding-bottom: 8px; }
            .receipt-header h2 { margin: 0; font-size: 14px; font-weight: bold; }
            .receipt-table { width: 100%; border-collapse: collapse; margin: 8px 0; }
            .receipt-table th, .receipt-table td { padding: 4px; font-size: 10px; border-bottom: 1px solid #eee; text-align: left; }
            .receipt-table td:nth-child(2), .receipt-table th:nth-child(2) { text-align: right; }
            .receipt-table td:nth-child(3), .receipt-table th:nth-child(3) { text-align: center; }
            .receipt-table td:nth-child(4), .receipt-table th:nth-child(4) { text-align: right; }
            .total-row td { font-weight: bold; border-top: 1px solid #000; }
            @page { size: 80mm auto; margin: 2mm; }
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
              <button
                onClick={() => setIsCustomerModalOpen(true)}
                className="customer-btn"
              >
                👤 CUSTOMER {customerName ? `(${customerName})` : ''}
              </button>
            </div>
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
                        <td style={{ fontWeight: 'bold' }}>{c.name.toUpperCase()} <small style={{ color: '#6c757d' }}>({c.unit})</small></td>
                        <td style={{ textAlign: 'center' }}>{c.qty} {c.cartUnit && c.cartUnit !== c.unit ? c.cartUnit : ""}</td>
                        <td style={{ textAlign: 'center' }}>₹{(c.rate * (c.multiplier || 1)).toFixed(3)}</td>
                        <td style={{ textAlign: 'center', fontWeight: 'bold', color: '#0d6efd' }}>₹{c.total.toFixed(3)}</td>
                        <td style={{ textAlign: 'center' }}>
                          <button className="btn-action" onClick={() => editCartItem(i)}>Edit</button>
                          <button className="btn-action danger" onClick={() => removeCartItem(i)}>X</button>
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
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 'bold', fontSize: '0.95rem' }}>{c.name.toUpperCase()} <small style={{ color: '#6c757d' }}>({c.unit})</small></div>
                      <div style={{ display: 'flex', gap: '15px', marginTop: '6px', fontSize: '0.85rem', color: '#555' }}>
                        <span>Qty: <b>{c.qty} {c.cartUnit && c.cartUnit !== c.unit ? c.cartUnit : ""}</b></span>
                        <span>Rate: <b>₹{(c.rate * (c.multiplier || 1)).toFixed(2)}</b></span>
                      </div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontWeight: 'bold', color: '#0d6efd', fontSize: '1.1rem' }}>₹{c.total.toFixed(2)}</div>
                      <div style={{ marginTop: '6px', display: 'flex', gap: '5px' }}>
                        <button className="btn-action" onClick={() => editCartItem(i)} style={{ padding: '4px 10px', fontSize: '0.8rem' }}>Edit</button>
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
                    📤 UPLOAD NEW EXCEL INVENTORY
                  </label>
                  <input
                    type="file"
                    accept=".xlsx, .xls, .csv"
                    onChange={handleFileUpload}
                    style={{ width: '100%', padding: '8px', background: '#f8f9fa', borderRadius: '5px', border: '1px dashed #ccc' }}
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
                {allSales.length === 0 ? (
                  <div style={{ textAlign: 'center', marginTop: '3rem', color: '#6c757d' }}>No receipts yet. Complete a checkout to see bills here.</div>
                ) : (
                  [...allSales].reverse().map(receipt => (
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
                  ))
                )}
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
                  let m = 1;
                  const bu = (modalItem.item.unit || "unit").toLowerCase();
                  m = getUnitMultiplier(u, bu);
                  setModalItem({ ...modalItem, cartUnit: u, multiplier: m });
                }}
                style={{ padding: '10px', borderRadius: '8px', border: '1px solid #ccc', fontWeight: 'bold' }}
              >
                <option value={modalItem.item.unit || "unit"}>{modalItem.item.unit || "unit"}</option>
                {['g', 'kg', 'l', 'box', 'mal', 'ml', 'dozen', 'pcs'].filter(opt => opt !== (modalItem.item.unit || "unit").toLowerCase()).map(opt => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>
            </div>
            <div style={{ textAlign: 'center', marginBottom: '10px', fontSize: '0.875rem', color: '#6c757d', fontWeight: 'bold', marginTop: '15px' }}>
              RATE (per {modalItem.cartUnit})
            </div>
            <input
              type="number"
              className="modal-input"
              ref={rateInputRef}
              value={isNaN(modalItem.rate * modalItem.multiplier) ? "" : Number((modalItem.rate * modalItem.multiplier).toFixed(3))}
              step="0.01"
              onFocus={(e) => e.target.select()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleModalSubmit();
                }
              }}
              onChange={(e) => {
                const newScaledRate = Number(e.target.value);
                const baseRate = newScaledRate / modalItem.multiplier;
                setModalItem({ ...modalItem, rate: baseRate });
              }}
            />
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
            
            <label style={{ fontSize: '0.75rem', fontWeight: 'bold', color: '#6c757d', marginBottom: '2px', display: 'block' }}>NAME (MARATHI / ENG)</label>
            <input
              type="text"
              className="edit-input"
              value={inventoryEditItem.name_marathi || inventoryEditItem.name}
              onChange={(e) => setInventoryEditItem({ ...inventoryEditItem, name_marathi: e.target.value, name: e.target.value })}
            />

            <label style={{ fontSize: '0.75rem', fontWeight: 'bold', color: '#6c757d', marginBottom: '2px', marginTop: '10px', display: 'block' }}>BARCODE (Optional)</label>
            <div style={{ display: 'flex', gap: '5px' }}>
              <input
                type="text"
                className="edit-input"
                style={{ flex: 1 }}
                placeholder="Scan or type barcode"
                value={inventoryEditItem.barcode || ''}
                onChange={(e) => setInventoryEditItem({ ...inventoryEditItem, barcode: e.target.value })}
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
                  });
                  const modal = document.getElementById("edit-barcode-scanner");
                  if (modal) modal.style.display = "flex";
                  html5Qrcode.start(
                    { facingMode: "environment" },
                    { fps: 30, qrbox: { width: 300, height: 150 }, disableFlip: false },
                    (text) => {
                      setInventoryEditItem({ ...inventoryEditItem, barcode: text });
                      html5Qrcode.stop().catch(() => {});
                      if (modal) modal.style.display = "none";
                    },
                    () => {}
                  ).catch(() => {});
                }}
                style={{ background: '#6c757d', color: 'white', border: 'none', padding: '0 10px', borderRadius: '5px', cursor: 'pointer' }}
              >
                📷 Scan
              </button>
            </div>

            <div id="edit-barcode-scanner" style={{ display: 'none', position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.8)', zIndex: 5000, justifyContent: 'center', alignItems: 'center', flexDirection: 'column' }}>
               <div style={{ background: 'white', padding: '20px', borderRadius: '10px', width: '90%', maxWidth: '400px' }}>
                 <div id="reader-edit" style={{ width: '100%' }}></div>
                 <button onClick={() => { document.getElementById("edit-barcode-scanner")!.style.display = "none"; }} style={{ width: '100%', marginTop: '10px', padding: '10px', background: '#dc3545', color: 'white', border: 'none', borderRadius: '5px' }}>Cancel</button>
               </div>
            </div>

            <div style={{ display: 'flex', gap: '10px', marginTop: '10px' }}>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: '0.75rem', fontWeight: 'bold', color: '#6c757d', marginBottom: '2px', display: 'block' }}>PURCHASE RATE</label>
                <input
                  type="number"
                  className="edit-input"
                  value={isNaN(inventoryEditItem.purchase_price as number) ? "" : inventoryEditItem.purchase_price}
                  onChange={(e) => setInventoryEditItem({ ...inventoryEditItem, purchase_price: Number(e.target.value) })}
                />
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: '0.75rem', fontWeight: 'bold', color: '#6c757d', marginBottom: '2px', display: 'block' }}>SALE RATE</label>
                <input
                  type="number"
                  className="edit-input"
                  value={isNaN(inventoryEditItem.price as number) ? "" : inventoryEditItem.price}
                  onChange={(e) => setInventoryEditItem({ ...inventoryEditItem, price: Number(e.target.value) })}
                />
              </div>
            </div>

            <div style={{ display: 'flex', gap: '10px', marginTop: '10px' }}>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: '0.75rem', fontWeight: 'bold', color: '#6c757d', marginBottom: '2px', display: 'block' }}>STOCK QTY</label>
                <input
                  type="number"
                  className="edit-input"
                  value={isNaN(inventoryEditItem.stock_quantity as number) ? "" : inventoryEditItem.stock_quantity}
                  onChange={(e) => setInventoryEditItem({ ...inventoryEditItem, stock_quantity: Number(e.target.value), stock_qty: Number(e.target.value) })}
                />
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: '0.75rem', fontWeight: 'bold', color: '#6c757d', marginBottom: '2px', display: 'block' }}>UNIT (e.g. kg, L, pcs)</label>
                <input
                  type="text"
                  className="edit-input"
                  value={inventoryEditItem.unit || ''}
                  onChange={(e) => setInventoryEditItem({ ...inventoryEditItem, unit: e.target.value })}
                />
              </div>
            </div>

            <button className="modal-btn" onClick={saveInventoryEdit} style={{ marginTop: '20px' }}>
              SAVE CHANGES
            </button>
          </div>
        </div>
      )}

      {isScanning && (
        <div className="modal-overlay" style={{ zIndex: 4000 }}>
          <div className="modal-content" style={{ maxWidth: '500px', width: '95%' }}>
            <div className="modal-header">
              <span>LIVE BARCODE SCANNER</span>
              <button style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: '1.5rem' }} onClick={() => setIsScanning(false)}>✕</button>
            </div>
            <div id="reader" style={{ width: '100%' }}></div>
            <p style={{ textAlign: 'center', color: '#6c757d', fontSize: '0.8rem', marginTop: '10px' }}>
              Point your camera at a product barcode
            </p>
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

            {/* Visible receipt card for screenshot */}
            <div ref={receiptCardRef} style={{ background: '#fff', padding: '15px', borderRadius: '10px', border: '1px solid #eee', marginBottom: '12px' }}>
              <div style={{ textAlign: 'center', borderBottom: '2px solid #000', paddingBottom: '8px', marginBottom: '8px' }}>
                <h3 style={{ margin: 0, fontSize: '1.1rem' }}>RAJENDRA GVB</h3>
                <div style={{ fontSize: '0.75rem', color: '#555' }}>Fresh Groceries & More</div>
                <div style={{ marginTop: '6px', fontSize: '0.8rem', fontWeight: 'bold' }}>BILL: {lastReceipt.receipt_no}</div>
                <div style={{ fontSize: '0.7rem', color: '#666' }}>{lastReceipt.date}</div>
                {(lastReceipt.customerName || lastReceipt.customerPhone) && (
                  <div style={{ marginTop: '4px', fontSize: '0.75rem', borderTop: '1px dashed #999', paddingTop: '4px' }}>
                    {lastReceipt.customerName && <span>Cust: {lastReceipt.customerName} </span>}
                    {lastReceipt.customerPhone && <span>| Ph: {lastReceipt.customerPhone}</span>}
                  </div>
                )}
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid #ccc' }}>
                    <th style={{ textAlign: 'left', padding: '4px 2px' }}>Item</th>
                    <th style={{ textAlign: 'center', padding: '4px 2px' }}>Qty</th>
                    <th style={{ textAlign: 'right', padding: '4px 2px' }}>Amt</th>
                  </tr>
                </thead>
                <tbody>
                  {lastReceipt.items.map((item, idx) => (
                    <tr key={idx} style={{ borderBottom: '1px solid #f0f0f0' }}>
                      <td style={{ padding: '3px 2px', fontSize: '0.75rem' }}>{item.name}</td>
                      <td style={{ textAlign: 'center', padding: '3px 2px' }}>{item.qty}{item.cartUnit && item.cartUnit !== item.unit ? item.cartUnit : ''}</td>
                      <td style={{ textAlign: 'right', padding: '3px 2px', fontWeight: 'bold' }}>₹{item.total.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '2px solid #000', marginTop: '6px', paddingTop: '6px', fontWeight: 'bold', fontSize: '1rem' }}>
                <span>TOTAL</span>
                <span>₹{lastReceipt.total.toFixed(2)}</span>
              </div>
              <div style={{ textAlign: 'center', marginTop: '8px', fontSize: '0.7rem', color: '#888' }}>Thank You! Visit Again.</div>
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

      {/* Hidden Print Wrapper */}
      <div id="printReceiptArea">
        {lastReceipt && (
          <>
            <div className="receipt-header">
              <h2>RAJENDRA GVB</h2>
              <p>Fresh Groceries & More</p>
              <div style={{ marginTop: '10px', fontSize: '12px', fontWeight: 'bold' }}>
                BILL NO: {lastReceipt.receipt_no}
              </div>
              <div style={{ fontSize: '10px' }}>
                Date: {lastReceipt.date}
              </div>
              {(lastReceipt.customerName || lastReceipt.customerPhone) && (
                <div style={{ marginTop: '5px', borderTop: '1px dashed #000', paddingTop: '5px' }}>
                  {lastReceipt.customerName && <div>Cust: {lastReceipt.customerName}</div>}
                  {lastReceipt.customerPhone && <div>Ph: {lastReceipt.customerPhone}</div>}
                </div>
              )}
            </div>
            <table className="receipt-table">
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }}>Item</th>
                  <th style={{ textAlign: 'center' }}>Qty</th>
                  <th style={{ textAlign: 'right' }}>Rate</th>
                  <th style={{ textAlign: 'right' }}>Amt</th>
                </tr>
              </thead>
              <tbody>
                {lastReceipt.items.map((item, idx) => (
                  <tr key={idx}>
                    <td>{item.name}</td>
                    <td style={{ textAlign: 'center' }}>{item.qty}{item.cartUnit && item.cartUnit !== item.unit ? item.cartUnit : ""}</td>
                    <td style={{ textAlign: 'right' }}>{(item.rate * (item.multiplier || 1)).toFixed(2)}</td>
                    <td style={{ textAlign: 'right' }}>{item.total.toFixed(2)}</td>
                  </tr>
                ))}
                <tr className="total-row">
                  <td colSpan={3} style={{ textAlign: 'right' }}>TOTAL</td>
                  <td style={{ textAlign: 'right' }}>₹{lastReceipt.total.toFixed(2)}</td>
                </tr>
              </tbody>
            </table>
            <div style={{ textAlign: 'center', marginTop: '10px', fontSize: '10px' }}>
              Thank You! Visit Again.
            </div>
          </>
        )}
      </div>
    </>
  );
}
