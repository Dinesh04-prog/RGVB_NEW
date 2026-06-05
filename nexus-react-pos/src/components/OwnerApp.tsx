import { useState, useEffect, useCallback, useRef } from 'react';
import Fuse from 'fuse.js';
import localforage from 'localforage';
import { Html5Qrcode, Html5QrcodeSupportedFormats } from 'html5-qrcode';
import {
  subscribeToPendingReviews, subscribeToAllReviews,
  approveReview, rejectReview,
  subscribeToReview, isFirebaseReady,
  saveInventoryItemToCloud, removeInventoryItemFromCloud,
  subscribeToInventory,
} from '../lib/firebase';
import type { ReviewSession, InventoryItem } from '../lib/firebase';
import type { CartItem } from '../lib/db';
import { useAuth } from '../contexts/AuthContext';
import {
  translateHinglishToMarathi, normalizeForSearch, HINGLISH_TO_MARATHI,
} from '../lib/phonetic';

// ── helpers ──────────────────────────────────────────────────────────────────
const fmt = (n: number) => `₹${n.toFixed(2)}`;
const timeAgo = (ts: number) => {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
};
const formatName = (name: string) =>
  (name || '').replace(/\s*\([\d.]*\s*(kg|g|gm|ml|l|L|Piece|Pack|Pack of \d+|unit|liter|litre)\)\s*$/i, '').trim();

const ITEMS_PER_PAGE = 10;

// ── CSS ───────────────────────────────────────────────────────────────────────
const APP_CSS = `
  :root { --sidebar-bg: #0a3d62; --active-nav: #145c91; --body-bg: #f1f2f6; }
  body { background-color: var(--body-bg); font-family: 'Segoe UI', sans-serif; margin: 0; padding: 0; overflow-x: hidden; }
  *, *::before, *::after { box-sizing: border-box; }

  .sidebar { width: 220px; background: var(--sidebar-bg); height: 100vh; position: fixed; color: white; z-index: 1000; display: block; }
  .nav-link { color: white; padding: 15px 20px; font-weight: 600; cursor: pointer; border-left: 4px solid transparent; text-decoration: none; display: block; }
  .nav-link:hover, .nav-link.active { background: var(--active-nav); border-left: 4px solid #3498db; }
  .mobile-nav { display: none; position: fixed; bottom: 0; left: 0; width: 100%; background: var(--sidebar-bg); color: white; z-index: 2000; justify-content: space-around; padding: 8px 0 10px; box-shadow: 0 -2px 8px rgba(0,0,0,0.25); }
  .mobile-nav-item { text-align: center; color: white; text-decoration: none; font-size: 0.72rem; opacity: 0.7; cursor: pointer; flex: 1; padding: 3px 0; }
  .mobile-nav-item.active { opacity: 1; font-weight: bold; }
  .main-content { margin-left: 220px; padding: 22px; transition: 0.3s; }
  .card { border-radius: 15px; border: none; box-shadow: 0 4px 12px rgba(0,0,0,0.05); background: white; margin-bottom: 15px; padding: 1rem; }

  .billing-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem; gap: 10px; flex-wrap: wrap; }

  .o-search-container { position: relative; }
  .o-search-inner { display: flex; width: 100%; gap: 8px; align-items: center; }
  #ownerItemSearch { height: 52px; border-radius: 12px; border: 2px solid #e1e8ed; padding-left: 15px; font-size: 1.1rem; flex: 1; min-width: 0; outline: none; }
  .o-ime-btn { height: 52px; border-radius: 8px; border: none; font-weight: bold; cursor: pointer; min-width: 52px; padding: 0 12px; flex-shrink: 0; font-size: 1rem; color: white; }
  .o-suggestions { position: absolute; width: 100%; left: 0; background: white; z-index: 1050; top: 58px; border-radius: 12px; box-shadow: 0 10px 25px rgba(0,0,0,0.15); max-height: 250px; overflow-y: auto; border: 1px solid #ddd; }
  .o-suggestion-item { padding: 12px 15px; cursor: pointer; border-bottom: 1px solid #eee; display: flex; justify-content: space-between; align-items: center; }
  .o-suggestion-item.active, .o-suggestion-item:hover { background: #e7f1ff; }
  .o-suggestion-item:last-child { border-bottom: none; }

  .o-total-bar { position: sticky; top: 0; z-index: 100; background: #0a3d62; color: white; padding: 12px 16px; border-radius: 12px; margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center; gap: 10px; }

  .o-table { width: 100%; text-align: left; border-collapse: collapse; min-width: 500px; }
  .o-table th, .o-table td { padding: 10px 12px; border-bottom: 1px solid #dee2e6; }
  .o-table-wrap { overflow-x: auto; }
  .o-edit-input { width: 78px; padding: 5px; border: 1.5px solid #0a3d62; border-radius: 6px; font-size: 0.95rem; text-align: center; font-weight: 600; }
  .btn-action { margin-right: 4px; padding: 5px 10px; cursor: pointer; border-radius: 4px; border: 1px solid #007bff; color: #007bff; background: transparent; font-size: 0.82rem; }
  .btn-action.danger { border-color: #dc3545; color: #dc3545; }

  .o-mobile-cart { display: none; }
  .o-desktop-cart { display: block; }

  .modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); display: flex; justify-content: center; align-items: center; z-index: 3000; padding: 16px; }
  .modal-content { background: white; padding: 20px; border-radius: 15px; width: 100%; max-width: 400px; max-height: 92vh; overflow-y: auto; }
  .modal-header { display: flex; justify-content: space-between; align-items: center; font-size: 1.1rem; font-weight: bold; margin-bottom: 12px; }
  .edit-input { width: 100%; padding: 8px; border: 1.5px solid #ccc; border-radius: 6px; font-size: 1rem; font-weight: 600; box-sizing: border-box; margin-bottom: 6px; }
  .modal-btn { width: 100%; padding: 13px; background: #16A34A; color: white; font-weight: bold; border: none; border-radius: 8px; cursor: pointer; font-size: 1rem; margin-top: 14px; }

  .kirana-card { background: white; border-radius: 12px; border: 1px solid #E7E5E4; box-shadow: 0 2px 8px rgba(0,0,0,0.04); margin-bottom: 8px; display: flex; align-items: center; padding: 10px 14px; gap: 10px; cursor: pointer; }
  .kirana-card:hover { background: #fafafa; }
  .kirana-col-header { display: grid; grid-template-columns: 75px 75px 75px; text-align: center; flex-shrink: 0; }
  .kirana-vals { display: grid; grid-template-columns: 75px 75px 75px; text-align: center; flex-shrink: 0; }
  .kirana-empty { text-align: center; margin-top: 3rem; color: #78716C; }

  @media (max-width: 992px) {
    .sidebar { display: none; }
    .main-content { margin-left: 0; width: 100%; padding: 10px 10px 80px; }
    .mobile-nav { display: flex; }
    #ownerItemSearch { height: 44px; font-size: 0.9rem; }
    .o-ime-btn { height: 44px; min-width: 40px; font-size: 0.85rem; }
    .o-suggestions { top: 50px; }
    .o-mobile-cart { display: block; }
    .o-desktop-cart { display: none; }
    .kirana-col-header { grid-template-columns: 60px 60px 60px; }
    .kirana-vals { grid-template-columns: 60px 60px 60px; }
  }
  @keyframes pulse { 0%{opacity:1} 50%{opacity:.5} 100%{opacity:1} }
`;

// ── OwnerApp: main shell with sidebar + tab routing ──────────────────────────
export default function OwnerApp({ initialReviewId }: { initialReviewId: string | null }) {
  const { user, logout } = useAuth();
  const [activeTab, setActiveTab] = useState<'bills' | 'inventory'>('bills');
  const [currentReviewId, setCurrentReviewId] = useState<string | null>(initialReviewId);

  // ── Shared inventory state (used by Inventory tab + Review page add-item) ──
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [fuse, setFuse] = useState<Fuse<InventoryItem> | null>(null);
  const [stockQuery, setStockQuery] = useState('');
  const [imeEnabled, setImeEnabled] = useState(true);
  const [stockPage, setStockPage] = useState(1);
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());
  const [inventoryEditItem, setInventoryEditItem] = useState<InventoryItem | null>(null);
  const invOverridesUnsubRef = useRef<(() => void) | null>(null);

  const buildFuse = (items: InventoryItem[]) =>
    new Fuse(items, {
      keys: [
        { name: 'search_key', weight: 3 },
        { name: 'name_marathi', weight: 1.5 },
        { name: 'name', weight: 1 },
        { name: 'name_eng', weight: 1 },
        { name: 'brand', weight: 1 },
        { name: 'id', weight: 0.5 },
        { name: 'barcode', weight: 0.5 },
      ],
      threshold: 0.45, ignoreLocation: true, distance: 300,
      minMatchCharLength: 2, shouldSort: true, includeScore: true,
    });

  // Load inventory from Firestore (real-time) or LocalForage (offline fallback)
  useEffect(() => {
    if (invOverridesUnsubRef.current) invOverridesUnsubRef.current();

    if (isFirebaseReady) {
      localforage.getItem('custom_inventory').then(cached => {
        if (cached && Array.isArray(cached) && (cached as InventoryItem[]).length > 0) {
          setInventory(cached as InventoryItem[]);
          setFuse(buildFuse(cached as InventoryItem[]));
        }
      });
      invOverridesUnsubRef.current = subscribeToInventory(items => {
        if (items.length > 0) {
          localforage.setItem('custom_inventory', items);
          setInventory(items);
          setFuse(buildFuse(items));
        }
      });
    } else {
      const load = async () => {
        let items: InventoryItem[] = [];
        const cached = await localforage.getItem('custom_inventory') as InventoryItem[] | null;
        if (cached && Array.isArray(cached) && cached.length > 0) {
          items = cached;
        } else {
          try {
            const r = await fetch('/inventory.json');
            if (r.ok) {
              const json = await r.json();
              if (Array.isArray(json) && json.length > 0) {
                items = json;
                await localforage.setItem('custom_inventory', json);
              }
            }
          } catch { /* network unavailable */ }
        }
        setInventory(items);
        setFuse(buildFuse(items));
      };
      load();
    }
    return () => { if (invOverridesUnsubRef.current) invOverridesUnsubRef.current(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    localforage.getItem('favorite_ids').then(ids => {
      if (ids && Array.isArray(ids)) setFavoriteIds(new Set(ids as string[]));
    });
  }, []);


  // Inventory CRUD — always update local state immediately, then sync to Firestore
  const saveInventoryEdit = async () => {
    if (!inventoryEditItem) return;
    const exists = inventory.find(i => i.id === inventoryEditItem.id);
    const newInv = exists
      ? inventory.map(i => i.id === inventoryEditItem.id ? inventoryEditItem : i)
      : [...inventory, inventoryEditItem];
    setInventory(newInv); setFuse(buildFuse(newInv));
    await localforage.setItem('custom_inventory', newInv);
    try { await saveInventoryItemToCloud(inventoryEditItem); } catch (err) { console.error('Firebase sync failed:', err); }
    setInventoryEditItem(null);
  };

  const deleteInventoryItem = async () => {
    if (!inventoryEditItem) return;
    const name = inventoryEditItem.name_marathi || inventoryEditItem.name || 'this item';
    if (!confirm(`Delete "${name}" from inventory? This cannot be undone.`)) return;
    const newInv = inventory.filter(i => i.id !== inventoryEditItem.id);
    setInventory(newInv); setFuse(buildFuse(newInv));
    await localforage.setItem('custom_inventory', newInv);
    try { await removeInventoryItemFromCloud(inventoryEditItem.id); } catch (err) { console.error('Firebase sync failed:', err); }
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

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const XLSX = await import('xlsx');
      const reader = new FileReader();
      reader.onload = async (evt) => {
        const wb = XLSX.read(evt.target?.result, { type: 'binary' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const data = XLSX.utils.sheet_to_json(ws);
        const mapped: InventoryItem[] = (data as any[]).map((row, i) => ({
          id: row['SKU_ID'] || row['Item_ID'] || row['id'] || `UPLOAD-${i}`,
          name: row['Marathi_Name'] || row['Item_Name'] || row['name'] || row['English_Name'] || `Item ${i}`,
          name_marathi: row['Marathi_Name'] || row['Item_Name_Marathi'] || row['name_marathi'] || '',
          name_eng: row['English_Name'] || row['Item_Name_Eng'] || row['name_eng'] || '',
          search_key: String(row['Search_key'] || row['search_key'] || row['SearchKey'] || '').trim(),
          unit: row['Weight_Volume'] || row['Unit'] || row['unit'] || 'unit',
          price: Number(row['Selling_Price_INR'] || row['Selling_Price'] || row['price'] || 0),
          purchase_price: Number(row['Purchase_Price_INR'] || row['Purchase_Price'] || row['purchase_price'] || 0),
          stock_quantity: Number(row['Stock_Quantity'] || row['stock_qty'] || row['Quantity'] || 0),
        }));
        const unique = new Map<string, InventoryItem>();
        mapped.forEach(item => {
          const k = formatName(item.name_marathi || item.name_eng || item.name).toLowerCase();
          if (!unique.has(k) && k) unique.set(k, item);
        });
        const deduped = Array.from(unique.values());
        setInventory(deduped); setFuse(buildFuse(deduped));
        await localforage.setItem('custom_inventory', deduped);
        alert(`Loaded ${deduped.length} unique items (from ${mapped.length}).`);
      };
      reader.readAsBinaryString(file);
    } catch (err) { console.error(err); alert('Error parsing Excel file.'); }
  };

  const exportInventoryToExcel = async () => {
    try {
      const XLSX = await import('xlsx');
      const data = inventory.map(i => ({
        SKU_ID: i.id, Item_Name: i.name, Marathi_Name: i.name_marathi,
        English_Name: i.name_eng, Weight_Volume: i.unit,
        Selling_Price_INR: i.price, Purchase_Price_INR: i.purchase_price || 0,
        Stock_Quantity: i.stock_quantity ?? i.stock_qty ?? 0,
      }));
      const ws = XLSX.utils.json_to_sheet(data);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Inventory');
      XLSX.writeFile(wb, 'Updated_Inventory.xlsx');
    } catch (err) { console.error(err); alert('Error exporting Excel.'); }
  };

  // Inventory filtering (same logic as App.tsx)
  const filteredStock = (() => {
    if (!stockQuery) return inventory;
    const sq = stockQuery.toLowerCase();
    const mq = translateHinglishToMarathi(stockQuery);
    const nq = normalizeForSearch(sq);
    const exact = inventory.filter(i =>
      (i.search_key || '').toLowerCase().includes(sq) ||
      (i.name || '').toLowerCase().includes(sq) ||
      (i.name_marathi || '').toLowerCase().includes(sq) ||
      (i.name_eng || '').toLowerCase().includes(sq) ||
      (mq && mq !== sq && (i.name_marathi || '').toLowerCase().includes(mq)) ||
      (nq && nq !== sq && (i.name_eng || '').toLowerCase().includes(nq))
    );
    if (exact.length > 0) return exact;
    if (!fuse) return [];
    const variants = new Set<string>([stockQuery]);
    if (mq && mq !== stockQuery) variants.add(mq);
    if (nq && nq !== sq) variants.add(nq);
    const dictHit = HINGLISH_TO_MARATHI[sq];
    if (dictHit) variants.add(dictHit);
    const seen = new Set<string>(); const results: InventoryItem[] = [];
    for (const v of variants) {
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

  const renderInventoryCard = (s: InventoryItem) => {
    const mrp = s.purchase_price || 0;
    const price = s.price || 0;
    const stock = s.stock_quantity ?? s.stock_qty ?? 0;
    const hasDiscount = price > 0 && mrp > 0 && price < mrp;
    const isLowStock = stock < 10;
    const isFav = favoriteIds.has(s.id);
    return (
      <div key={s.id} className="kirana-card" onClick={() => setInventoryEditItem(s)}>
        <div onClick={e => { e.stopPropagation(); toggleFavorite(s.id); }}
          style={{ fontSize: '1.3rem', cursor: 'pointer', color: isFav ? '#F59E0B' : '#D1D5DB', alignSelf: 'flex-start', lineHeight: 1, flexShrink: 0, userSelect: 'none' }}>
          {isFav ? '★' : '☆'}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 'bold', fontSize: '1.05rem', fontFamily: '"Noto Sans Devanagari", sans-serif', lineHeight: 1.3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: '#1C1917' }}>
            {s.name_marathi || s.name}
          </div>
          {s.name_eng && <div style={{ fontSize: '0.82rem', color: '#57534E', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{formatName(s.name_eng)}</div>}
          {s.brand && <div style={{ color: '#0a3d62', fontWeight: 'bold', fontSize: '0.85rem' }}>{s.brand}</div>}
          <div style={{ color: '#9ca3af', fontSize: '0.68rem', marginTop: '1px' }}>({s.unit}) · {s.id}</div>
        </div>
        <div className="kirana-vals">
          <div style={{ fontWeight: 'bold', color: '#DC2626', fontSize: '0.85rem', textDecoration: hasDiscount ? 'line-through' : 'none' }}>{mrp ? `₹${mrp}` : '—'}</div>
          <div style={{ fontWeight: 'bold', color: '#16A34A', fontSize: '0.88rem' }}>₹{price}</div>
          <div style={{ fontWeight: 'bold', color: isLowStock ? '#DC2626' : '#9CA3AF', fontSize: '0.85rem' }}>
            {stock}
            {isLowStock && <div style={{ fontSize: '0.6rem', color: '#DC2626' }}>⚠ कमी</div>}
          </div>
        </div>
      </div>
    );
  };

  // ── If a review is open, show full-page review ────────────────────────────
  if (currentReviewId) {
    return (
      <OwnerReviewPage
        reviewId={currentReviewId}
        onBack={() => setCurrentReviewId(null)}
        fuse={fuse}
      />
    );
  }

  return (
    <div style={{ minHeight: '100vh', background: '#f1f2f6' }}>
      <style dangerouslySetInnerHTML={{ __html: APP_CSS }} />

      {/* Desktop sidebar */}
      <div className="sidebar" style={{ display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '1.25rem 1rem', textAlign: 'center' }}>
          <div style={{ fontWeight: 700, fontSize: '1rem' }}>👑 Owner Panel</div>
          <div style={{ fontSize: '0.72rem', opacity: 0.65, marginTop: 2 }}>Rajendra GVB</div>
        </div>
        <div style={{ flex: 1 }}>
          <a className={`nav-link ${activeTab === 'bills' ? 'active' : ''}`} onClick={() => setActiveTab('bills')}>📋 BILLS</a>
          <a className={`nav-link ${activeTab === 'inventory' ? 'active' : ''}`} onClick={() => setActiveTab('inventory')}>📦 INVENTORY</a>
        </div>
        {user && (
          <div style={{ padding: '1rem', borderTop: '1px solid rgba(255,255,255,0.15)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <img src={user.picture} alt="" style={{ width: 32, height: 32, borderRadius: '50%', flexShrink: 0 }} />
              <div style={{ overflow: 'hidden' }}>
                <div style={{ fontSize: '0.82rem', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{user.name}</div>
                <div style={{ fontSize: '0.68rem', opacity: 0.65, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{user.email}</div>
              </div>
            </div>
            <button onClick={logout} style={{ width: '100%', background: 'rgba(255,255,255,0.12)', color: 'white', border: '1px solid rgba(255,255,255,0.25)', borderRadius: 8, padding: '7px', fontSize: '0.82rem', cursor: 'pointer', fontWeight: 600 }}>
              Sign Out
            </button>
          </div>
        )}
      </div>

      {/* Mobile bottom nav */}
      <div className="mobile-nav">
        <div className={`mobile-nav-item ${activeTab === 'bills' ? 'active' : ''}`} onClick={() => setActiveTab('bills')}><span>📋</span><br />Bills</div>
        <div className={`mobile-nav-item ${activeTab === 'inventory' ? 'active' : ''}`} onClick={() => setActiveTab('inventory')}><span>📦</span><br />यादी</div>
      </div>

      <div className="main-content">

        {/* ── Bills tab ──────────────────────────────────────────────────────── */}
        {activeTab === 'bills' && (
          <OwnerDashboard onOpen={id => setCurrentReviewId(id)} />
        )}

        {/* ── Inventory tab — identical to App.tsx inventory section ────────── */}
        {activeTab === 'inventory' && (
          <div>
            <h2 style={{ fontWeight: 'bold', marginBottom: '1rem' }}>Inventory</h2>
            <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: '10px', flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: '200px' }}>
                  <label style={{ fontSize: '0.85rem', fontWeight: 'bold', color: '#6c757d', marginBottom: '6px', display: 'block' }}>
                    📤 UPLOAD NEW EXCEL INVENTORY
                  </label>
                  <input type="file" accept=".xlsx, .xls, .csv" onChange={handleFileUpload}
                    style={{ width: '100%', padding: '8px', background: '#f8f9fa', borderRadius: '5px', border: '1px dashed #ccc' }} />
                </div>
                <button onClick={exportInventoryToExcel}
                  style={{ background: '#198754', color: 'white', border: 'none', padding: '10px 16px', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer', whiteSpace: 'nowrap', fontSize: '0.9rem', boxShadow: '0 2px 6px rgba(25,135,84,0.3)' }}>
                  ⬇️ EXPORT EXCEL
                </button>
                <button onClick={() => setInventoryEditItem({ id: `INV-${Date.now()}`, name: '', unit: 'kg', price: 0, purchase_price: 0, stock_quantity: 0, barcode: '' })}
                  style={{ background: '#0d6efd', color: 'white', border: 'none', padding: '10px 16px', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer', whiteSpace: 'nowrap', fontSize: '0.9rem' }}>
                  ➕ ADD NEW ITEM
                </button>
              </div>
              <div style={{ display: 'flex', gap: '10px' }}>
                <input type="text" style={{ flexGrow: 1, padding: '10px', borderRadius: '5px', border: '1px solid #ccc' }}
                  placeholder="Eng -> मराठी Stock Search..."
                  value={stockQuery}
                  onChange={e => {
                    const val = e.target.value;
                    setStockPage(1);
                    if (!imeEnabled) { setStockQuery(val); return; }
                    if (val.endsWith(' ')) setStockQuery(translateHinglishToMarathi(val.trim()) + ' ');
                    else setStockQuery(val);
                  }} />
                <button onClick={() => setImeEnabled(v => !v)}
                  style={{ background: imeEnabled ? '#28a745' : '#ccc', color: 'white', padding: '0 15px', borderRadius: '5px', border: 'none', fontWeight: 'bold', cursor: 'pointer', minWidth: '50px' }}>
                  {imeEnabled ? 'अ' : 'A'}
                </button>
              </div>
            </div>

            <div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '2px 14px 6px 0' }}>
                <div className="kirana-col-header">
                  <span style={{ color: '#DC2626', fontWeight: 'bold', fontSize: '0.68rem', textTransform: 'uppercase', letterSpacing: '0.03em' }}>Purchase</span>
                  <span style={{ color: '#16A34A', fontWeight: 'bold', fontSize: '0.68rem', textTransform: 'uppercase', letterSpacing: '0.03em' }}>Sale</span>
                  <span style={{ color: '#9CA3AF', fontWeight: 'bold', fontSize: '0.68rem', textTransform: 'uppercase', letterSpacing: '0.03em' }}>Stock</span>
                </div>
              </div>

              {favFilteredStock.length > 0 && (
                <div>
                  <div style={{ fontSize: '0.72rem', fontWeight: 'bold', color: '#F59E0B', padding: '2px 4px 6px', display: 'flex', alignItems: 'center', gap: '4px', letterSpacing: '0.04em' }}>
                    ★ FAVOURITES
                  </div>
                  {favFilteredStock.map(s => renderInventoryCard(s))}
                  <div style={{ borderBottom: '2px dashed #E7E5E4', margin: '4px 0 12px' }} />
                </div>
              )}

              {pagedStock.map(s => renderInventoryCard(s))}
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 4px', marginTop: '4px' }}>
              <button disabled={stockPage <= 1} onClick={() => setStockPage(p => p - 1)}
                style={{ background: stockPage <= 1 ? '#e9ecef' : '#0a3d62', color: stockPage <= 1 ? '#adb5bd' : 'white', border: 'none', padding: '10px 20px', borderRadius: '8px', fontWeight: 'bold', cursor: stockPage <= 1 ? 'default' : 'pointer', fontSize: '0.95rem' }}>
                ← मागे
              </button>
              <span style={{ fontWeight: 'bold', color: '#0a3d62', fontSize: '0.9rem', textAlign: 'center' }}>
                पृष्ठ {stockPage} / {totalStockPages}<br />
                <span style={{ fontWeight: 'normal', color: '#6c757d', fontSize: '0.78rem' }}>{filteredStock.length} वस्तू</span>
              </span>
              <button disabled={stockPage >= totalStockPages} onClick={() => setStockPage(p => p + 1)}
                style={{ background: stockPage >= totalStockPages ? '#e9ecef' : '#0a3d62', color: stockPage >= totalStockPages ? '#adb5bd' : 'white', border: 'none', padding: '10px 20px', borderRadius: '8px', fontWeight: 'bold', cursor: stockPage >= totalStockPages ? 'default' : 'pointer', fontSize: '0.95rem' }}>
                पुढे →
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── Inventory edit modal — identical to App.tsx ────────────────────── */}
      {inventoryEditItem && (
        <div className="modal-overlay">
          <div className="modal-content" style={{ padding: '15px' }}>
            <div className="modal-header" style={{ marginBottom: '10px', fontSize: '1.05rem' }}>
              <span>EDIT INVENTORY ITEM</span>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '6px' }}>
                <button style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: '1.2rem', lineHeight: 1 }} onClick={() => setInventoryEditItem(null)}>✕</button>
                {inventory.find(i => i.id === inventoryEditItem.id) && (
                  <button onClick={deleteInventoryItem}
                    style={{ border: 'none', background: '#dc3545', color: 'white', cursor: 'pointer', fontSize: '0.7rem', fontWeight: 'bold', borderRadius: '4px', padding: '3px 8px', lineHeight: 1.4 }}>
                    DELETE
                  </button>
                )}
              </div>
            </div>

            <label style={{ fontSize: '0.75rem', fontWeight: 'bold', color: '#6c757d', marginBottom: '2px', display: 'block' }}>NAME (MARATHI / ENG)</label>
            <input type="text" className="edit-input"
              value={inventoryEditItem.name_marathi || inventoryEditItem.name}
              onChange={e => setInventoryEditItem({ ...inventoryEditItem, name_marathi: e.target.value, name: e.target.value })} />

            <label style={{ fontSize: '0.75rem', fontWeight: 'bold', color: '#6c757d', marginBottom: '2px', marginTop: '8px', display: 'block' }}>BARCODE (Optional)</label>
            <div style={{ display: 'flex', gap: '5px' }}>
              <input type="text" className="edit-input" style={{ flex: 1, marginBottom: 0 }}
                placeholder="Scan or type barcode"
                value={inventoryEditItem.barcode || ''}
                onChange={e => setInventoryEditItem({ ...inventoryEditItem, barcode: e.target.value })} />
              <button onClick={() => {
                const html5Qrcode = new Html5Qrcode('reader-edit-owner', {
                  formatsToSupport: [Html5QrcodeSupportedFormats.EAN_13, Html5QrcodeSupportedFormats.EAN_8, Html5QrcodeSupportedFormats.UPC_A, Html5QrcodeSupportedFormats.UPC_E, Html5QrcodeSupportedFormats.CODE_128, Html5QrcodeSupportedFormats.CODE_39, Html5QrcodeSupportedFormats.QR_CODE], verbose: false,
                });
                const modal = document.getElementById('edit-barcode-scanner-owner');
                if (modal) modal.style.display = 'flex';
                html5Qrcode.start({ facingMode: 'environment' }, { fps: 30, qrbox: { width: 300, height: 150 }, disableFlip: false },
                  (text) => { setInventoryEditItem({ ...inventoryEditItem, barcode: text }); html5Qrcode.stop().catch(() => {}); if (modal) modal.style.display = 'none'; }, () => {}
                ).catch(() => {});
              }}
                style={{ background: '#6c757d', color: 'white', border: 'none', padding: '0 10px', borderRadius: '5px', cursor: 'pointer', flexShrink: 0 }}>
                📷 Scan
              </button>
            </div>
            <div id="edit-barcode-scanner-owner" style={{ display: 'none', position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.8)', zIndex: 5000, justifyContent: 'center', alignItems: 'center', flexDirection: 'column' }}>
              <div style={{ background: 'white', padding: '20px', borderRadius: '10px', width: '90%', maxWidth: '400px' }}>
                <div id="reader-edit-owner" style={{ width: '100%' }}></div>
                <button onClick={() => { const m = document.getElementById('edit-barcode-scanner-owner'); if (m) m.style.display = 'none'; }}
                  style={{ width: '100%', marginTop: '10px', padding: '10px', background: '#dc3545', color: 'white', border: 'none', borderRadius: '5px' }}>Cancel</button>
              </div>
            </div>

            <div style={{ display: 'flex', gap: '10px', marginTop: '10px' }}>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: '0.75rem', fontWeight: 'bold', color: '#6c757d', marginBottom: '2px', display: 'block' }}>PURCHASE RATE</label>
                <input type="number" className="edit-input"
                  value={isNaN(inventoryEditItem.purchase_price as number) ? '' : inventoryEditItem.purchase_price}
                  onChange={e => setInventoryEditItem({ ...inventoryEditItem, purchase_price: Number(e.target.value) })} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: '0.75rem', fontWeight: 'bold', color: '#6c757d', marginBottom: '2px', display: 'block' }}>SALE RATE</label>
                <input type="number" className="edit-input"
                  value={isNaN(inventoryEditItem.price as number) ? '' : inventoryEditItem.price}
                  onChange={e => setInventoryEditItem({ ...inventoryEditItem, price: Number(e.target.value) })} />
              </div>
            </div>

            <div style={{ display: 'flex', gap: '10px', marginTop: '10px' }}>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: '0.75rem', fontWeight: 'bold', color: '#6c757d', marginBottom: '2px', display: 'block' }}>STOCK QTY</label>
                <input type="number" className="edit-input"
                  value={isNaN(inventoryEditItem.stock_quantity as number) ? '' : inventoryEditItem.stock_quantity}
                  onChange={e => setInventoryEditItem({ ...inventoryEditItem, stock_quantity: Number(e.target.value), stock_qty: Number(e.target.value) })} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: '0.75rem', fontWeight: 'bold', color: '#6c757d', marginBottom: '2px', display: 'block' }}>UNIT (e.g. kg, L, pcs)</label>
                <input type="text" className="edit-input"
                  value={inventoryEditItem.unit || ''}
                  onChange={e => setInventoryEditItem({ ...inventoryEditItem, unit: e.target.value })} />
              </div>
            </div>

            <button className="modal-btn" onClick={saveInventoryEdit}>SAVE CHANGES</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── OwnerDashboard: pending/all sessions list ────────────────────────────────
function OwnerDashboard({ onOpen }: { onOpen: (id: string) => void }) {
  const [tab, setTab] = useState<'pending' | 'all'>('pending');
  const [sessions, setSessions] = useState<ReviewSession[]>([]);

  useEffect(() => {
    if (!isFirebaseReady) return;
    const unsub = tab === 'pending' ? subscribeToPendingReviews(setSessions) : subscribeToAllReviews(setSessions);
    return unsub;
  }, [tab]);

  const pendingCount = sessions.filter(s => s.status === 'pending').length;

  return (
    <div>
      {!isFirebaseReady && (
        <div style={{ background: '#FFF3CD', border: '1px solid #FFC107', borderRadius: 10, marginBottom: '1rem', padding: '12px 16px', fontSize: '0.9rem' }}>
          <strong>⚠️ Firebase not configured.</strong> Add Firebase keys to <code>.env</code> to enable real-time sync.
        </div>
      )}

      <div style={{ display: 'flex', marginBottom: '1rem', background: 'white', borderRadius: 10, overflow: 'hidden', boxShadow: '0 2px 8px rgba(0,0,0,0.06)' }}>
        {(['pending', 'all'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            flex: 1, padding: '11px', border: 'none', cursor: 'pointer', fontWeight: 600,
            fontSize: '0.9rem', background: tab === t ? '#0a3d62' : 'white', color: tab === t ? 'white' : '#555',
          }}>
            {t === 'pending' ? `⏳ Pending${pendingCount ? ` (${pendingCount})` : ''}` : '📋 All Bills'}
          </button>
        ))}
      </div>

      {sessions.length === 0 ? (
        <div style={{ textAlign: 'center', marginTop: '3rem', color: '#888' }}>
          <div style={{ fontSize: '3rem' }}>✅</div>
          <div style={{ fontWeight: 600, marginTop: 8 }}>{tab === 'pending' ? 'No pending reviews' : 'No bills yet'}</div>
        </div>
      ) : sessions.map(s => <DashboardCard key={s.id} session={s} onOpen={onOpen} />)}
    </div>
  );
}

function DashboardCard({ session: s, onOpen }: { session: ReviewSession; onOpen: (id: string) => void }) {
  const total = (s.cart || []).reduce((sum, i) => sum + (i.total || 0), 0);
  const statusColor = s.status === 'approved' ? '#16A34A' : s.status === 'rejected' ? '#DC2626' : '#F97316';
  const statusLabel = s.status === 'approved' ? '✅ Approved' : s.status === 'rejected' ? '❌ Rejected' : '⏳ Pending';

  return (
    <div onClick={() => s.status === 'pending' && onOpen(s.id)}
      style={{ background: 'white', borderRadius: 12, padding: '14px 16px', marginBottom: 10, boxShadow: '0 2px 8px rgba(0,0,0,0.06)', cursor: s.status === 'pending' ? 'pointer' : 'default', borderLeft: `4px solid ${statusColor}`, opacity: s.status !== 'pending' ? 0.75 : 1 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: '0.95rem' }}>
            📋 {s.customerName || 'Walk-in'}
            {s.customerPhone && <span style={{ fontWeight: 400, color: '#666', fontSize: '0.8rem' }}> · {s.customerPhone}</span>}
          </div>
          <div style={{ color: '#555', fontSize: '0.82rem', marginTop: 3 }}>From: <strong>{s.cashierName}</strong> · {s.cart?.length || 0} items · {fmt(total)}</div>
          <div style={{ color: '#999', fontSize: '0.75rem', marginTop: 3 }}>{timeAgo(s.createdAt)}</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
          <span style={{ fontSize: '0.72rem', fontWeight: 600, color: statusColor }}>{statusLabel}</span>
          {s.status === 'pending' && <span style={{ fontSize: '1.2rem' }}>→</span>}
        </div>
      </div>
      {s.ownerNotes && (
        <div style={{ marginTop: 8, fontSize: '0.8rem', color: '#555', background: '#f8f9fa', borderRadius: 6, padding: '6px 10px' }}>💬 {s.ownerNotes}</div>
      )}
    </div>
  );
}

// ── OwnerReviewPage — POS-style full-page review ─────────────────────────────
function OwnerReviewPage({ reviewId, onBack, fuse: invFuse }: {
  reviewId: string; onBack: () => void;
  fuse: Fuse<InventoryItem> | null;
}) {
  const { user, logout } = useAuth();

  const [session, setSession] = useState<ReviewSession | null>(null);
  const [editableCart, setEditableCart] = useState<CartItem[]>([]);
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<'approved' | 'rejected' | null>(null);

  const [query, setQuery] = useState('');
  const [imeEnabled, setImeEnabled] = useState(true);
  const [suggestions, setSuggestions] = useState<InventoryItem[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [addModal, setAddModal] = useState<{ item: InventoryItem; qty: number; rate: number } | null>(null);

  useEffect(() => {
    if (!isFirebaseReady) { setLoading(false); return; }
    const unsub = subscribeToReview(reviewId, s => {
      if (s) { setSession(s); setEditableCart(prev => prev.length === 0 ? JSON.parse(JSON.stringify(s.cart)) : prev); }
      setLoading(false);
    });
    return unsub;
  }, [reviewId]);

  useEffect(() => {
    if (!invFuse || query.trim().length < 2) { setSuggestions([]); setSelectedIdx(-1); return; }
    setSuggestions(invFuse.search(query.trim(), { limit: 8 }).map(r => r.item));
    setSelectedIdx(-1);
  }, [query, invFuse]);

  const updateRate = useCallback((id: string, val: number) => {
    setEditableCart(prev => prev.map(i => i.id === id ? { ...i, rate: val, total: parseFloat((i.qty * val * (i.multiplier ?? 1)).toFixed(2)) } : i));
  }, []);

  const updateQty = useCallback((id: string, val: number) => {
    setEditableCart(prev => prev.map(i => i.id === id ? { ...i, qty: val, total: parseFloat((val * i.rate * (i.multiplier ?? 1)).toFixed(2)) } : i));
  }, []);

  const removeItem = useCallback((id: string) => {
    setEditableCart(prev => prev.filter(i => i.id !== id));
  }, []);

  const openAddModal = (item: InventoryItem) => {
    setAddModal({ item, qty: 1, rate: item.price || 0 });
    setSuggestions([]); setQuery('');
  };

  const confirmAdd = () => {
    if (!addModal) return;
    const { item, qty, rate } = addModal;
    const name = formatName(item.name_marathi || item.name_eng || item.name);
    setEditableCart(prev => [...prev, {
      id: `${item.id}-${Date.now()}`, name, unit: item.unit || 'unit',
      qty, rate, total: parseFloat((qty * rate).toFixed(2)),
      cartUnit: item.unit || 'unit', multiplier: 1,
    }]);
    setAddModal(null);
    setTimeout(() => searchInputRef.current?.focus(), 50);
  };

  const handleApprove = async () => {
    if (editableCart.length === 0) { alert('Cart is empty — add items or reject.'); return; }
    setSubmitting(true);
    try { await approveReview(reviewId, editableCart, notes); setDone('approved'); }
    catch (e) { alert('Failed to approve. Check connection.'); console.error(e); }
    finally { setSubmitting(false); }
  };

  const handleReject = async () => {
    if (!notes.trim() && !confirm('Reject without a reason note?')) return;
    setSubmitting(true);
    try { await rejectReview(reviewId, notes); setDone('rejected'); }
    catch (e) { alert('Failed to reject. Check connection.'); console.error(e); }
    finally { setSubmitting(false); }
  };

  const totalAmt = editableCart.reduce((sum, i) => sum + (i.total || 0), 0);
  const isPending = session?.status === 'pending';

  const REVIEW_CSS = APP_CSS + `
    .rv-action-bar { position: fixed; bottom: 0; left: 0; right: 0; background: white; border-top: 1px solid #e5e7eb; padding: 10px 14px; display: flex; gap: 10px; z-index: 500; }
    .rv-reject-btn { flex: 1; background: white; color: #DC2626; border: 2px solid #DC2626; border-radius: 10px; padding: 12px 8px; font-weight: 700; font-size: 0.95rem; cursor: pointer; }
    .rv-approve-btn { flex: 2; background: #16A34A; color: white; border: none; border-radius: 10px; padding: 12px 8px; font-weight: 700; font-size: 0.95rem; cursor: pointer; }
    .rv-modal-input { width: 100%; padding: 8px; margin-bottom: 12px; border: 1.5px solid #cbd5e1; border-radius: 8px; font-size: 1.3rem; text-align: center; font-weight: bold; }
    @media (max-width: 768px) {
      .rv-reject-btn, .rv-approve-btn { font-size: 0.85rem; padding: 10px 6px; }
      .rv-modal-input { font-size: 1.1rem; }
    }
  `;

  if (done) return (
    <div style={{ minHeight: '100vh', background: done === 'approved' ? '#f0fff4' : '#fff5f5', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', fontFamily: "'Segoe UI', sans-serif", padding: '2rem' }}>
      <style dangerouslySetInnerHTML={{ __html: REVIEW_CSS }} />
      <div style={{ fontSize: '4rem' }}>{done === 'approved' ? '✅' : '❌'}</div>
      <h2 style={{ color: done === 'approved' ? '#16A34A' : '#DC2626', margin: '1rem 0 0.5rem' }}>{done === 'approved' ? 'Bill Approved!' : 'Bill Rejected'}</h2>
      <p style={{ color: '#555', textAlign: 'center', marginBottom: '1.5rem' }}>{done === 'approved' ? 'Cashier will be notified with updated rates.' : 'Cashier has been notified.'}</p>
      <button onClick={onBack} style={{ background: '#0a3d62', color: 'white', border: 'none', borderRadius: 10, padding: '12px 28px', fontWeight: 700, fontSize: '1rem', cursor: 'pointer' }}>← Back to Dashboard</button>
    </div>
  );

  if (loading) return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: "'Segoe UI', sans-serif" }}>
      <div style={{ textAlign: 'center', color: '#888' }}><div style={{ fontSize: '2rem', marginBottom: 8 }}>⏳</div>Loading bill...</div>
    </div>
  );

  if (!session) return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: "'Segoe UI', sans-serif" }}>
      <style dangerouslySetInnerHTML={{ __html: REVIEW_CSS }} />
      <div style={{ textAlign: 'center', color: '#888' }}>
        <div style={{ fontSize: '2rem', marginBottom: 8 }}>🔍</div>Review not found.<br />
        <button onClick={onBack} style={{ marginTop: 16, background: '#0a3d62', color: 'white', border: 'none', borderRadius: 8, padding: '10px 20px', cursor: 'pointer' }}>← Back</button>
      </div>
    </div>
  );

  return (
    <div style={{ minHeight: '100vh', background: '#f1f2f6', fontFamily: "'Segoe UI', sans-serif", paddingBottom: 80 }}>
      <style dangerouslySetInnerHTML={{ __html: REVIEW_CSS }} />

      {/* Header */}
      <div style={{ background: '#0a3d62', color: 'white', padding: '0.8rem 1rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button onClick={onBack} style={{ background: 'rgba(255,255,255,0.15)', border: 'none', color: 'white', borderRadius: 8, padding: '6px 12px', cursor: 'pointer', fontSize: '0.85rem', flexShrink: 0 }}>← Back</button>
            <div>
              <div style={{ fontWeight: 700, fontSize: '1rem' }}>Review Bill{session.customerName ? ` — ${session.customerName}` : ' — Walk-in'}</div>
              <div style={{ fontSize: '0.72rem', opacity: 0.75, marginTop: 1 }}>Cashier: {session.cashierName} · {timeAgo(session.createdAt)}{session.customerPhone && ` · 📞 ${session.customerPhone}`}</div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {user && <img src={user.picture} alt="" style={{ width: 30, height: 30, borderRadius: '50%' }} />}
            <button onClick={logout} style={{ background: 'rgba(255,255,255,0.15)', color: 'white', border: '1px solid rgba(255,255,255,0.3)', borderRadius: 8, padding: '5px 10px', cursor: 'pointer', fontSize: '0.78rem', fontWeight: 600 }}>Sign Out</button>
          </div>
        </div>
      </div>

      {!isPending && (
        <div style={{ background: session.status === 'approved' ? '#D4EDDA' : '#F8D7DA', padding: '8px 16px', textAlign: 'center', fontWeight: 600, color: session.status === 'approved' ? '#155724' : '#721C24', fontSize: '0.9rem' }}>
          {session.status === 'approved' ? '✅ Already Approved' : '❌ Already Rejected'}
        </div>
      )}

      <div style={{ padding: '10px 10px 0' }}>
        {/* Search bar */}
        {isPending && (
          <div className="card" style={{ marginBottom: 10 }}>
            <div style={{ fontWeight: 700, fontSize: '0.8rem', color: '#0a3d62', marginBottom: 8 }}>➕ ADD ITEM FROM INVENTORY</div>
            <div className="o-search-container">
              <div className="o-search-inner">
                <input id="ownerItemSearch" ref={searchInputRef} type="text" placeholder="Search item to add..." value={query} autoComplete="off"
                  onKeyDown={e => {
                    if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIdx(i => Math.min(i + 1, suggestions.length - 1)); }
                    else if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIdx(i => Math.max(i - 1, 0)); }
                    else if (e.key === 'Enter') { const t = selectedIdx >= 0 ? suggestions[selectedIdx] : suggestions.length === 1 ? suggestions[0] : null; if (t) openAddModal(t); }
                  }}
                  onChange={e => {
                    const val = e.target.value;
                    if (!imeEnabled) { setQuery(val); return; }
                    if (val.endsWith(' ')) setQuery(translateHinglishToMarathi(val.trim()) + ' ');
                    else setQuery(val);
                  }} />
                <button className="o-ime-btn" onClick={() => setImeEnabled(v => !v)} style={{ background: imeEnabled ? '#28a745' : '#aaa' }}>{imeEnabled ? 'अ' : 'A'}</button>
              </div>
              {suggestions.length > 0 && (
                <div className="o-suggestions">
                  {suggestions.map((s, idx) => (
                    <div key={s.id} className={`o-suggestion-item${idx === selectedIdx ? ' active' : ''}`} onClick={() => openAddModal(s)} onMouseEnter={() => setSelectedIdx(idx)}>
                      <span><b>{formatName(s.name_marathi || s.name_eng || s.name).toUpperCase()}</b> <small style={{ color: '#6c757d' }}>({s.unit || 'unit'})</small>{s.brand && <small style={{ color: '#0a3d62', fontWeight: 600 }}> {s.brand}</small>}</span>
                      <span style={{ color: '#16A34A', fontWeight: 700, flexShrink: 0 }}>{fmt(s.price || 0)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Total bar */}
        <div className="o-total-bar">
          <h3 style={{ margin: 0, fontWeight: 700 }}>TOTAL: {fmt(totalAmt)}</h3>
          <span style={{ fontSize: '0.8rem', opacity: 0.75 }}>{editableCart.length} items</span>
        </div>

        {/* Desktop cart table */}
        <div className="card o-desktop-cart" style={{ padding: '0.75rem' }}>
          {editableCart.length === 0 ? (
            <div style={{ padding: '1.5rem', textAlign: 'center', color: '#888' }}>No items</div>
          ) : (
            <div className="o-table-wrap">
              <table className="o-table">
                <thead>
                  <tr style={{ background: '#f8f9fa' }}>
                    <th>Product (Unit)</th>
                    <th style={{ textAlign: 'center', width: 90 }}>Qty</th>
                    <th style={{ textAlign: 'center', width: 100 }}>Rate (₹)</th>
                    <th style={{ textAlign: 'center', width: 85 }}>Total</th>
                    {isPending && <th style={{ textAlign: 'center', width: 50 }}>Del</th>}
                  </tr>
                </thead>
                <tbody>
                  {editableCart.map((c, idx) => (
                    <tr key={c.id} style={{ background: idx % 2 === 0 ? 'white' : '#fafafa' }}>
                      <td style={{ fontWeight: 600 }}>{c.name.toUpperCase()} <small style={{ color: '#6c757d', fontWeight: 400 }}>({c.unit})</small></td>
                      <td style={{ textAlign: 'center' }}>{isPending ? <input type="number" className="o-edit-input" value={c.qty} min={0.1} step={0.1} onChange={e => updateQty(c.id, parseFloat(e.target.value) || 0)} /> : c.qty}</td>
                      <td style={{ textAlign: 'center' }}>{isPending ? <input type="number" className="o-edit-input" value={c.rate} min={0} step={0.5} onChange={e => updateRate(c.id, parseFloat(e.target.value) || 0)} style={{ borderColor: '#0a3d62', color: '#0a3d62' }} /> : `₹${c.rate}`}</td>
                      <td style={{ textAlign: 'center', fontWeight: 700, color: '#16A34A' }}>{fmt(c.total)}</td>
                      {isPending && <td style={{ textAlign: 'center' }}><button className="btn-action danger" onClick={() => removeItem(c.id)}>✕</button></td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Mobile cart cards */}
        <div className="o-mobile-cart">
          {editableCart.length === 0 && <div style={{ textAlign: 'center', padding: '2rem', color: '#888' }}>No items</div>}
          {editableCart.map(c => (
            <div key={c.id} className="card" style={{ padding: '10px 12px', marginBottom: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: '0.9rem', wordBreak: 'break-word' }}>{c.name.toUpperCase()} <small style={{ color: '#6c757d', fontWeight: 400 }}>({c.unit})</small></div>
                  {isPending ? (
                    <div style={{ display: 'flex', gap: 8, marginTop: 7, flexWrap: 'wrap' }}>
                      <label style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: '0.72rem', color: '#555' }}>
                        Qty<input type="number" className="o-edit-input" value={c.qty} min={0.1} step={0.1} style={{ width: 65 }} onChange={e => updateQty(c.id, parseFloat(e.target.value) || 0)} />
                      </label>
                      <label style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: '0.72rem', color: '#555' }}>
                        Rate ₹<input type="number" className="o-edit-input" value={c.rate} min={0} step={0.5} style={{ width: 75, borderColor: '#0a3d62', color: '#0a3d62' }} onChange={e => updateRate(c.id, parseFloat(e.target.value) || 0)} />
                      </label>
                    </div>
                  ) : (
                    <div style={{ fontSize: '0.82rem', color: '#555', marginTop: 4 }}>Qty: <b>{c.qty}</b> · Rate: <b>₹{c.rate}</b></div>
                  )}
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div style={{ fontWeight: 700, color: '#16A34A', fontSize: '1.05rem' }}>{fmt(c.total)}</div>
                  {isPending && <button className="btn-action danger" onClick={() => removeItem(c.id)} style={{ marginTop: 5, fontSize: '0.78rem', padding: '4px 8px' }}>✕ Del</button>}
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Notes */}
        <div className="card">
          <div style={{ fontWeight: 700, fontSize: '0.8rem', color: '#0a3d62', marginBottom: 6 }}>💬 NOTE TO CASHIER</div>
          <textarea placeholder={isPending ? 'Add a note (optional)...' : (session.ownerNotes || 'No notes')}
            value={notes} onChange={e => setNotes(e.target.value)} disabled={!isPending} rows={2}
            style={{ width: '100%', borderRadius: 8, border: '1.5px solid #cbd5e1', padding: '8px 12px', fontSize: '0.88rem', resize: 'none', fontFamily: 'inherit' }} />
        </div>
      </div>

      {/* Fixed approve/reject bar */}
      {isPending && (
        <div className="rv-action-bar">
          <button className="rv-reject-btn" onClick={handleReject} disabled={submitting}>✗ Reject</button>
          <button className="rv-approve-btn" onClick={handleApprove} disabled={submitting}>{submitting ? 'Sending...' : '✓ Approve & Send'}</button>
        </div>
      )}

      {/* Add-item modal */}
      {addModal && (
        <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setAddModal(null)}>
          <div className="modal-content">
            <div className="modal-header">
              <span style={{ fontSize: '1rem' }}>{formatName(addModal.item.name_marathi || addModal.item.name_eng || addModal.item.name)}</span>
              <button onClick={() => setAddModal(null)} style={{ background: 'none', border: 'none', fontSize: '1.3rem', cursor: 'pointer', color: '#888' }}>×</button>
            </div>
            <div style={{ fontSize: '0.78rem', color: '#888', marginBottom: 12 }}>({addModal.item.unit || 'unit'}) · MRP: {fmt(addModal.item.purchase_price || addModal.item.price || 0)}{addModal.item.brand && ` · ${addModal.item.brand}`}</div>
            <label style={{ display: 'block', fontWeight: 600, marginBottom: 3, fontSize: '0.85rem' }}>Quantity</label>
            <input type="number" className="rv-modal-input" value={addModal.qty} min={0.1} step={0.1} autoFocus
              onChange={e => setAddModal(m => m ? { ...m, qty: parseFloat(e.target.value) || 0 } : m)}
              onFocus={e => e.target.select()} />
            <label style={{ display: 'block', fontWeight: 600, marginBottom: 3, fontSize: '0.85rem' }}>Rate (₹)</label>
            <input type="number" className="rv-modal-input" value={addModal.rate} min={0} step={0.5}
              onChange={e => setAddModal(m => m ? { ...m, rate: parseFloat(e.target.value) || 0 } : m)}
              onFocus={e => e.target.select()} />
            <div style={{ background: '#f0fff4', border: '1px solid #16A34A', borderRadius: 8, padding: '7px 12px', marginBottom: 12, display: 'flex', justifyContent: 'space-between', fontWeight: 700 }}>
              <span style={{ color: '#555' }}>Total</span>
              <span style={{ color: '#16A34A' }}>{fmt(addModal.qty * addModal.rate)}</span>
            </div>
            <button className="modal-btn" onClick={confirmAdd}>➕ Add to Bill</button>
          </div>
        </div>
      )}
    </div>
  );
}
