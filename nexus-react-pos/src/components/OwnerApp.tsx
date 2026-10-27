import { useState, useEffect, useMemo, useRef } from 'react';
import Fuse from 'fuse.js';
import localforage from 'localforage';
import { Html5Qrcode, Html5QrcodeSupportedFormats } from 'html5-qrcode';
import {
  subscribeToPendingReviews, subscribeToRecentReviews, subscribeToReviewsSince,
  approveReview, rejectReview,
  subscribeToReview, isFirebaseReady,
  saveInventoryItemToCloud, removeInventoryItemFromCloud, bulkSaveInventoryToFirestore,
  subscribeToInventory,
} from '../lib/firebase';
import type { ReviewSession, InventoryItem } from '../lib/firebase';
import type { CartItem } from '../lib/db';
import { useAuth } from '../contexts/AuthContext';
import { InventoryTile, ItemThumb, INVENTORY_TILE_CSS } from './InventoryTile';
import { ItemImageField } from './ItemImageField';
import { withImage } from '../lib/itemImage';
import { saveFile, XLSX_MIME } from '../lib/androidApp';
import { inventoryToXlsx, rowToItem, fixImportedImages } from '../lib/inventoryExcel';
import {
  translateHinglishToMarathi, transliterateDevanagariToLatin, normalizeForSearch, HINGLISH_TO_MARATHI,
} from '../lib/phonetic';
import { itemNameFields, makeSearchKey, withItemNames } from '../lib/itemNames';
import { getUnitMultiplier, STANDARD_UNITS } from '../lib/units';
import ShopPanel from './ShopPanel';
import KhataPanel from './KhataPanel';
import { openExternalUrl } from '../lib/androidApp';

// ── helpers ──────────────────────────────────────────────────────────────────
const fmt = (n: number) => `₹${n.toFixed(2)}`;
const timeAgo = (ts: number) => {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${Math.max(s, 0)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  const d = Math.floor(s / 86400);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
};
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
const formatName = (name: string) =>
  (name || '').replace(/\s*\([\d.]*\s*(kg|g|gm|ml|l|L|Piece|Pack|Pack of \d+|unit|liter|litre)\)\s*$/i, '').trim();
const cartTotal = (cart: CartItem[] | undefined) => (cart || []).reduce((sum, i) => sum + (i.total || 0), 0);
/** Final bill of a review: the owner's version once approved, otherwise what the cashier sent. */
const finalCart = (s: ReviewSession) => (s.status === 'approved' && s.updatedCart ? s.updatedCart : s.cart);

const ITEMS_PER_PAGE = 10;
const LOW_STOCK = 10;
const RECENT_PAGE_SIZE = 50;
const BARCODE_FORMATS = [
  Html5QrcodeSupportedFormats.EAN_13, Html5QrcodeSupportedFormats.EAN_8, Html5QrcodeSupportedFormats.UPC_A,
  Html5QrcodeSupportedFormats.UPC_E, Html5QrcodeSupportedFormats.CODE_128, Html5QrcodeSupportedFormats.CODE_39,
  Html5QrcodeSupportedFormats.QR_CODE,
];

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
      { name: 'net_qty', weight: 0.5 },
      { name: 'full_name_eng', weight: 0.3 },
    ],
    threshold: 0.45, ignoreLocation: true, distance: 300,
    minMatchCharLength: 2, shouldSort: true, includeScore: true,
  });

// Exact (substring) matches first, incl. Hinglish → Marathi; fuzzy Fuse search only when nothing matches exactly.
// Same logic as the cashier's inventory search in App.tsx.
const searchInventory = (
  inventory: InventoryItem[], fuse: Fuse<InventoryItem> | null, rawQuery: string, max = Infinity,
): InventoryItem[] => {
  const q = rawQuery.trim();
  if (!q) return inventory;
  const sq = q.toLowerCase();
  const mq = translateHinglishToMarathi(q);
  const nq = normalizeForSearch(sq);
  const exact = inventory.filter(i =>
    (i.search_key || '').toLowerCase().includes(sq) ||
    (i.name || '').toLowerCase().includes(sq) ||
    (i.name_marathi || '').toLowerCase().includes(sq) ||
    (i.name_eng || '').toLowerCase().includes(sq) ||
    (i.barcode || '') === q ||
    (mq && mq !== sq && (i.name_marathi || '').toLowerCase().includes(mq)) ||
    (nq && nq !== sq && (i.name_eng || '').toLowerCase().includes(nq))
  );
  if (exact.length > 0) return exact.slice(0, max);
  if (!fuse) return [];
  const variants = new Set<string>([q]);
  if (mq && mq !== q) variants.add(mq);
  if (nq && nq !== sq) variants.add(nq);
  const dictHit = HINGLISH_TO_MARATHI[sq];
  if (dictHit) variants.add(dictHit);
  const seen = new Set<string>(); const results: InventoryItem[] = [];
  for (const v of variants) {
    for (const r of fuse.search(v, { limit: 20 })) {
      if (!seen.has(r.item.id)) { seen.add(r.item.id); results.push(r.item); }
    }
  }
  return results.slice(0, max);
};

// Hinglish typing: a finished word (space) is turned into Marathi while the अ toggle is on.
const imeValue = (val: string, imeOn: boolean) =>
  imeOn && val.endsWith(' ') ? translateHinglishToMarathi(val.trim()) + ' ' : val;

// Cart lines: rate is per the item's base unit; the bill shows it per the chosen cart unit (rate × multiplier).
const lineUnit = (c: CartItem) => c.cartUnit || c.unit || 'unit';
const lineRate = (c: CartItem) => c.rate * (c.multiplier ?? 1);
const lineTotal = (qty: number, rate: number, multiplier: number) => parseFloat((qty * rate * multiplier).toFixed(2));
const round3 = (n: number) => Number(n.toFixed(3));

/** Units offered for an item: its own unit, its custom unit rates, then the standard ones. */
const unitOptions = (item: InventoryItem) => {
  const base = item.unit || 'unit';
  const custom = Object.keys(item.unit_rates || {});
  return [base, ...new Set([...custom, ...STANDARD_UNITS].filter(u => u !== base))];
};

/** Short beep + vibration when a new bill arrives (may stay silent until the owner has tapped the page once). */
const playNewBillAlert = () => {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const osc = ctx.createOscillator(); const gain = ctx.createGain();
    osc.frequency.value = 880; gain.gain.value = 0.15;
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(); osc.stop(ctx.currentTime + 0.2);
    osc.onended = () => { ctx.close().catch(() => {}); };
  } catch { /* no audio */ }
  try { navigator.vibrate?.([120, 60, 120]); } catch { /* no vibration */ }
};

// ── CSS ───────────────────────────────────────────────────────────────────────
const APP_CSS = `
  :root { --sidebar-bg: #0a3d62; --active-nav: #145c91; --body-bg: #f1f2f6; }
  body { background-color: var(--body-bg); font-family: 'Segoe UI', sans-serif; margin: 0; padding: 0; overflow-x: hidden; }
  *, *::before, *::after { box-sizing: border-box; }

  /* Sidebar slides in/out (☰). Desktop: pushes the page aside, never covers it. Phone: drawer over a dimmed backdrop. */
  .sidebar { width: 220px; background: var(--sidebar-bg); height: 100vh; position: fixed; left: 0; top: 0; color: white; z-index: 2200; display: flex; flex-direction: column; transition: transform 0.25s ease; overflow-y: auto; }
  .o-side-collapsed .sidebar { transform: translateX(-100%); }
  .o-side-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 0.9rem 0.6rem 0.9rem 1rem; }
  .o-side-close { background: transparent; border: none; color: white; font-size: 1.2rem; cursor: pointer; width: 44px; height: 44px; border-radius: 8px; flex-shrink: 0; }
  .o-side-close:hover { background: rgba(255,255,255,0.12); }
  .o-backdrop { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.45); z-index: 2100; }
  .o-topbar { position: sticky; top: 0; z-index: 900; background: var(--sidebar-bg); color: white; min-height: 56px; padding: 6px 12px; display: flex; align-items: center; gap: 10px; box-shadow: 0 2px 8px rgba(0,0,0,0.2); margin-left: 220px; transition: margin-left 0.25s ease; }
  .o-side-collapsed .o-topbar { margin-left: 0; }
  .o-menu-btn { background: rgba(255,255,255,0.12); color: white; border: none; border-radius: 8px; width: 44px; height: 44px; cursor: pointer; display: flex; flex-direction: column; justify-content: center; align-items: center; gap: 5px; flex-shrink: 0; }
  .o-menu-btn span { display: block; width: 22px; height: 2.5px; background: white; border-radius: 2px; }
  .o-menu-btn:hover { background: rgba(255,255,255,0.2); }
  .o-menu-btn { position: relative; }
  .o-menu-badge { position: absolute; top: -5px; right: -5px; }
  .o-topbar-signout { display: none; }
  .nav-link { color: white; padding: 15px 20px; font-weight: 600; cursor: pointer; border-left: 4px solid transparent; text-decoration: none; display: flex; align-items: center; gap: 8px; }
  .nav-link:hover, .nav-link.active { background: var(--active-nav); border-left: 4px solid #3498db; }
  .o-badge { background: #DC2626; color: white; border-radius: 999px; font-size: 0.7rem; font-weight: 700; min-width: 20px; height: 20px; padding: 0 6px; display: inline-flex; align-items: center; justify-content: center; line-height: 1; }
  .main-content { margin-left: 220px; padding: 22px; transition: margin-left 0.25s ease; }
  .o-side-collapsed .main-content { margin-left: 0; }
  .card { border-radius: 15px; border: none; box-shadow: 0 4px 12px rgba(0,0,0,0.05); background: white; margin-bottom: 15px; padding: 1rem; }
  .o-signout-btn { background: rgba(255,255,255,0.12); color: white; border: 1px solid rgba(255,255,255,0.3); border-radius: 8px; padding: 0 12px; min-height: 40px; font-size: 0.82rem; cursor: pointer; font-weight: 600; white-space: nowrap; }
  .o-avatar { width: 32px; height: 32px; border-radius: 50%; flex-shrink: 0; }

  .o-toolbar { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
  .o-tool-btn { min-height: 48px; color: white; border: none; border-radius: 10px; font-weight: 700; font-size: 0.9rem; cursor: pointer; padding: 0 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .o-search-row { display: flex; gap: 8px; align-items: center; }
  .o-search-input { flex: 1; min-width: 0; height: 48px; padding: 0 14px; border-radius: 10px; border: 2px solid #e1e8ed; font-size: 1rem; outline: none; }
  .o-search-input:focus { border-color: #0a3d62; }
  .o-ime-btn { height: 48px; border-radius: 10px; border: none; font-weight: bold; cursor: pointer; min-width: 48px; padding: 0 12px; flex-shrink: 0; font-size: 1rem; color: white; }
  .o-status { font-size: 0.85rem; font-weight: 600; color: #0a3d62; background: #e7f1ff; border-radius: 8px; padding: 8px 12px; }

  .o-pager { display: flex; justify-content: space-between; align-items: center; padding: 12px 4px; margin-top: 4px; gap: 8px; }
  .o-pager-btn { border: none; min-height: 48px; padding: 0 20px; border-radius: 10px; font-weight: bold; font-size: 0.95rem; }

  .o-summary { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-bottom: 12px; }
  .o-summary-tile { background: white; border-radius: 12px; padding: 10px 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.06); min-width: 0; }
  .o-summary-num { font-size: 1.35rem; font-weight: 800; line-height: 1.2; }
  .o-summary-label { font-size: 0.72rem; color: #6c757d; font-weight: 600; }
  .o-summary-sub { font-size: 0.75rem; color: #16A34A; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .o-tabs { display: flex; margin-bottom: 1rem; background: white; border-radius: 10px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
  .o-tab { flex: 1; min-height: 48px; border: none; cursor: pointer; font-weight: 600; font-size: 0.9rem; }

  .o-search-container { position: relative; }
  .o-suggestions { position: absolute; width: 100%; left: 0; background: white; z-index: 1050; top: 54px; border-radius: 12px; box-shadow: 0 10px 25px rgba(0,0,0,0.15); max-height: 300px; overflow-y: auto; border: 1px solid #ddd; }
  .o-suggestion-item { padding: 10px 14px; min-height: 52px; cursor: pointer; border-bottom: 1px solid #eee; display: flex; justify-content: space-between; align-items: center; }
  .o-suggestion-item.active, .o-suggestion-item:hover { background: #e7f1ff; }
  .o-suggestion-item:last-child { border-bottom: none; }

  .o-total-bar { position: sticky; top: 0; z-index: 100; background: #0a3d62; color: white; padding: 12px 16px; border-radius: 12px; margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center; gap: 10px; }

  .o-table { width: 100%; text-align: left; border-collapse: collapse; min-width: 560px; }
  .o-table th, .o-table td { padding: 8px 10px; border-bottom: 1px solid #dee2e6; vertical-align: middle; }
  .o-table-wrap { overflow-x: auto; }
  .o-edit-input { width: 84px; height: 44px; padding: 4px; border: 1.5px solid #0a3d62; border-radius: 8px; font-size: 1rem; text-align: center; font-weight: 600; }
  .o-edit-input.bad { border-color: #DC2626; background: #FEF2F2; }
  .o-line-bad { background: #FEF2F2 !important; }
  .o-was { display: block; font-size: 0.7rem; color: #9ca3af; text-decoration: line-through; margin-top: 2px; }
  .o-new-tag { background: #DBEAFE; color: #1D4ED8; font-size: 0.65rem; font-weight: 800; border-radius: 4px; padding: 1px 5px; margin-left: 6px; vertical-align: middle; }
  .o-del-btn { min-width: 44px; min-height: 44px; border-radius: 8px; border: 1.5px solid #dc3545; color: #dc3545; background: white; font-weight: 700; cursor: pointer; font-size: 0.85rem; }
  .o-restore-btn { min-height: 40px; border-radius: 8px; border: 1.5px solid #0a3d62; color: #0a3d62; background: white; font-weight: 700; cursor: pointer; padding: 0 12px; font-size: 0.8rem; flex-shrink: 0; }

  .o-mobile-cart { display: none; }
  .o-desktop-cart { display: block; }

  .modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); display: flex; justify-content: center; align-items: center; z-index: 3000; padding: 16px; }
  .modal-content { background: white; padding: 16px; border-radius: 15px; width: 100%; max-width: 420px; max-height: 92vh; overflow-y: auto; }
  .modal-header { display: flex; justify-content: space-between; align-items: center; gap: 8px; font-size: 1.05rem; font-weight: bold; margin-bottom: 10px; }
  .o-close-btn { border: none; background: #f1f2f6; border-radius: 10px; cursor: pointer; font-size: 1.1rem; width: 44px; height: 44px; flex-shrink: 0; color: #444; }
  .o-label { font-size: 0.75rem; font-weight: bold; color: #6c757d; margin: 10px 0 3px; display: block; }
  .o-error { color: #DC2626; font-size: 0.78rem; font-weight: 600; margin-top: 2px; }
  .edit-input { width: 100%; height: 46px; padding: 0 10px; border: 1.5px solid #ccc; border-radius: 8px; font-size: 1rem; font-weight: 600; }
  .edit-input.bad { border-color: #DC2626; }
  .o-row { display: flex; gap: 10px; }
  .o-row > * { flex: 1; min-width: 0; }
  .o-side-btn { min-height: 46px; padding: 0 12px; border: none; border-radius: 8px; color: white; font-weight: bold; cursor: pointer; flex-shrink: 0; }
  .modal-btn { width: 100%; min-height: 50px; background: #16A34A; color: white; font-weight: bold; border: none; border-radius: 10px; cursor: pointer; font-size: 1rem; margin-top: 16px; }
  .o-delete-btn { width: 100%; min-height: 46px; background: white; color: #dc3545; font-weight: bold; border: 1.5px solid #dc3545; border-radius: 10px; cursor: pointer; font-size: 0.95rem; margin-top: 10px; }
  .o-modal-input { width: 100%; height: 50px; padding: 0 8px; border: 1.5px solid #cbd5e1; border-radius: 8px; font-size: 1.25rem; text-align: center; font-weight: bold; }

  .o-scan-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.8); z-index: 5000; display: flex; justify-content: center; align-items: center; padding: 16px; }
  .o-scan-box { background: white; padding: 16px; border-radius: 12px; width: 100%; max-width: 420px; }
  .o-cancel-btn { width: 100%; margin-top: 10px; min-height: 48px; background: #dc3545; color: white; border: none; border-radius: 10px; font-weight: bold; font-size: 1rem; cursor: pointer; }

  ${INVENTORY_TILE_CSS}
  .kirana-empty { text-align: center; margin-top: 3rem; color: #78716C; }

  @media (max-width: 992px) {
    .sidebar, .o-side-collapsed .sidebar { transform: translateX(-100%); }
    .sidebar.open, .o-side-collapsed .sidebar.open { transform: translateX(0); box-shadow: 4px 0 16px rgba(0,0,0,0.3); }
    .o-backdrop.open { display: block; }
    .o-topbar, .o-side-collapsed .o-topbar { margin-left: 0; }
    .o-topbar-signout { display: inline-block; }
    .main-content, .o-side-collapsed .main-content { margin-left: 0; width: 100%; padding: 10px 10px 24px; }
    .o-suggestions { top: 54px; }
    .o-mobile-cart { display: block; }
    .o-desktop-cart { display: none; }
  }
  @media (max-width: 380px) {
    .o-tool-btn { font-size: 0.8rem; }
    .o-summary-num { font-size: 1.1rem; }
  }
`;

const REVIEW_CSS = APP_CSS + `
  .rv-header { background: #0a3d62; color: white; padding: 0.6rem 0.8rem; display: flex; align-items: center; gap: 10px; }
  .rv-back-btn { background: rgba(255,255,255,0.15); border: none; color: white; border-radius: 8px; min-height: 40px; padding: 0 12px; cursor: pointer; font-size: 0.85rem; flex-shrink: 0; font-weight: 600; }
  .rv-title { flex: 1; min-width: 0; }
  .rv-title-main { font-weight: 700; font-size: 1rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .rv-title-sub { font-size: 0.72rem; opacity: 0.75; margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .rv-action-bar { position: fixed; bottom: 0; left: 0; right: 0; background: white; border-top: 1px solid #e5e7eb; padding: 10px 14px calc(10px + env(safe-area-inset-bottom)); display: flex; gap: 10px; z-index: 500; }
  .rv-reject-btn { flex: 1; min-height: 50px; background: white; color: #DC2626; border: 2px solid #DC2626; border-radius: 10px; font-weight: 700; font-size: 0.95rem; cursor: pointer; }
  .rv-approve-btn { flex: 2; min-height: 50px; background: #16A34A; color: white; border: none; border-radius: 10px; font-weight: 700; font-size: 0.95rem; cursor: pointer; }
  .rv-approve-btn:disabled, .rv-reject-btn:disabled { opacity: 0.6; cursor: default; }
`;

// ── Barcode scanner popup: one camera session, always stopped when the popup closes ──
function BarcodeScanner({ onResult, onClose }: { onResult: (code: string) => void; onClose: () => void }) {
  const [elId] = useState(() => `owner-scan-${Math.random().toString(36).slice(2)}`);
  const [error, setError] = useState('');
  const onResultRef = useRef(onResult);
  useEffect(() => { onResultRef.current = onResult; });

  useEffect(() => {
    const scanner = new Html5Qrcode(elId, { formatsToSupport: BARCODE_FORMATS, verbose: false });
    let running = false; let closed = false; let done = false;
    const stop = () => { scanner.stop().then(() => scanner.clear()).catch(() => {}); };
    scanner.start(
      { facingMode: 'environment' },
      { fps: 30, qrbox: { width: 280, height: 140 }, disableFlip: false },
      text => { if (done) return; done = true; onResultRef.current(text.trim()); },
      () => {},
    ).then(() => { running = true; if (closed) stop(); })
      .catch(() => { if (!closed) setError('Camera could not start. Allow camera permission and try again.'); });
    return () => { closed = true; if (running) stop(); };
  }, [elId]);

  return (
    <div className="o-scan-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="o-scan-box">
        <div className="modal-header">
          <span>📷 Scan barcode</span>
          <button className="o-close-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div id={elId} style={{ width: '100%' }} />
        {error && <div className="o-error" style={{ marginTop: 8 }}>{error}</div>}
        <button className="o-cancel-btn" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}

// ── OwnerApp: main shell with sidebar + tab routing ──────────────────────────
export default function OwnerApp({ initialReviewId, reviewOnly = false }: { initialReviewId: string | null; reviewOnly?: boolean }) {
  const { user, shop, logout } = useAuth();
  const shopName = shop?.name || '';
  type Tab = 'bills' | 'inventory' | 'khata' | 'shop';
  const [activeTab, setActiveTab] = useState<Tab>('bills');
  const [lowOnly, setLowOnly] = useState(false);
  // ☰ sidebar: on desktop it is shown or collapsed (remembered); on phones it is a drawer, closed by default
  const [sideCollapsed, setSideCollapsed] = useState(() => {
    try { return localStorage.getItem('owner_sidebar_collapsed') === '1'; } catch { return false; }
  });
  const [drawerOpen, setDrawerOpen] = useState(false);
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDrawerOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen]);
  const [currentReviewId, setCurrentReviewId] = useState<string | null>(initialReviewId);

  // ── Shared inventory state (used by Inventory tab + Review page add-item) ──
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const fuse = useMemo(() => buildFuse(inventory), [inventory]);
  const [stockQuery, setStockQuery] = useState('');
  const [imeEnabled, setImeEnabled] = useState(true);
  const [stockPage, setStockPage] = useState(1);
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());
  const [inventoryEditItem, setInventoryEditItem] = useState<InventoryItem | null>(null);
  const [editNameError, setEditNameError] = useState(false);
  const [newRateUnit, setNewRateUnit] = useState('');
  const [newRateValue, setNewRateValue] = useState('');
  const [scanForEdit, setScanForEdit] = useState(false);
  const [uploadStatus, setUploadStatus] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Pending bills: badge on the Bills tab + beep when a new one arrives ──
  const [pending, setPending] = useState<ReviewSession[]>([]);
  const seenPendingRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!isFirebaseReady || reviewOnly) return;
    return subscribeToPendingReviews(list => {
      const seen = seenPendingRef.current;
      if (seen && list.some(s => !seen.has(s.id))) playNewBillAlert();
      seenPendingRef.current = new Set(list.map(s => s.id));
      setPending(list);
    });
  }, [reviewOnly]);

  // Load inventory from Firestore (real-time) or LocalForage (offline fallback)
  useEffect(() => {
    let unsub: (() => void) | null = null;
    let cancelled = false;

    if (isFirebaseReady) {
      localforage.getItem('custom_inventory').then(cached => {
        if (!cancelled && Array.isArray(cached) && cached.length > 0) setInventory(cached as InventoryItem[]);
      });
      // An empty cloud list is only trusted after the cloud has had items (= the last item was deleted);
      // a brand-new project starts empty and must not wipe the offline copy.
      let cloudHadItems = false;
      unsub = subscribeToInventory(items => {
        if (items.length === 0 && !cloudHadItems) return;
        if (items.length > 0) cloudHadItems = true;
        localforage.setItem('custom_inventory', items);
        setInventory(items);
      });
    } else {
      (async () => {
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
        if (!cancelled) setInventory(items);
      })();
    }
    return () => { cancelled = true; if (unsub) unsub(); };
  }, []);

  useEffect(() => {
    localforage.getItem('favorite_ids').then(ids => {
      if (ids && Array.isArray(ids)) setFavoriteIds(new Set(ids as string[]));
    });
  }, []);

  useEffect(() => () => { if (statusTimerRef.current) clearTimeout(statusTimerRef.current); }, []);
  const showStatus = (msg: string, clearAfterMs = 0) => {
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    setUploadStatus(msg);
    if (clearAfterMs) statusTimerRef.current = setTimeout(() => setUploadStatus(''), clearAfterMs);
  };

  const openEditor = (item: InventoryItem) => {
    setInventoryEditItem(item);
    setEditNameError(false);
    setNewRateUnit(''); setNewRateValue('');
  };
  const openNewItem = () =>
    openEditor({ id: `INV-${Date.now()}`, name: '', unit: 'kg', price: 0, purchase_price: 0, stock_quantity: 0, barcode: '' });

  // Inventory CRUD — always update local state immediately, then sync to Firestore
  const saveInventoryEdit = async () => {
    if (!inventoryEditItem) return;
    // Two separate name fields; at least one is needed. `name` = Marathi if present, otherwise English.
    const names = itemNameFields(inventoryEditItem);
    if (!names.eng.trim() && !names.marathi.trim()) { setEditNameError(true); return; }
    let item = withItemNames(inventoryEditItem, { eng: names.eng.trim(), marathi: names.marathi.trim() });
    const exists = inventory.some(i => i.id === item.id);
    // New items get the shop's short code (4 Latin + 4 Devanagari chars) if none was set
    if (!item.search_key && !exists) {
      const mr = item.name_marathi || item.name || '';
      const en = item.name_eng || (/[ऀ-ॿ]/.test(mr) ? transliterateDevanagariToLatin(mr) : mr);
      if (mr.trim()) item = { ...item, search_key: makeSearchKey(en, mr) };
    }
    const newInv = exists ? inventory.map(i => i.id === item.id ? item : i) : [...inventory, item];
    setInventory(newInv);
    setInventoryEditItem(null);
    await localforage.setItem('custom_inventory', newInv);
    try { await saveInventoryItemToCloud(item); } catch (err) { console.error('Firebase sync failed:', err); }
  };

  const deleteInventoryItem = async (target: InventoryItem | null = inventoryEditItem) => {
    if (!target) return;
    const name = target.name_marathi || target.name || 'this item';
    if (!confirm(`Delete "${name}" from inventory? This cannot be undone.`)) return;
    const newInv = inventory.filter(i => i.id !== target.id);
    setInventory(newInv);
    setInventoryEditItem(null);
    await localforage.setItem('custom_inventory', newInv);
    try { await removeInventoryItemFromCloud(target.id); } catch (err) { console.error('Firebase sync failed:', err); }
  };

  const toggleFavorite = (id: string) => {
    setFavoriteIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      localforage.setItem('favorite_ids', Array.from(next));
      return next;
    });
  };

  const addUnitRate = () => {
    if (!inventoryEditItem) return;
    const u = newRateUnit.trim().toLowerCase();
    const r = parseFloat(newRateValue);
    if (!u || isNaN(r) || r <= 0) return;
    setInventoryEditItem({ ...inventoryEditItem, unit_rates: { ...(inventoryEditItem.unit_rates || {}), [u]: r } });
    setNewRateUnit(''); setNewRateValue('');
  };

  // Excel import: parsed on the phone, de-duplicated, saved locally and synced to Firestore for every device
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';   // the same file can be picked again
    if (!file) return;
    showStatus('⏳ Reading Excel file...');
    try {
      const XLSX = await import('xlsx');
      const reader = new FileReader();
      reader.onload = async (evt) => {
        try {
          const wb = XLSX.read(evt.target?.result, { type: 'binary' });
          const ws = wb.Sheets[wb.SheetNames[0]];
          const data = XLSX.utils.sheet_to_json(ws);
          // All columns of an exported file, including the picture (older files: missing columns stay empty)
          const mapped: InventoryItem[] = (data as Record<string, unknown>[]).map((row, i) => rowToItem(row, i));
          const pictures = await fixImportedImages(mapped);
          const unique = new Map<string, InventoryItem>();
          mapped.forEach(item => {
            const k = formatName(item.name_marathi || item.name_eng || item.name).toLowerCase();
            if (!unique.has(k) && k) unique.set(k, item);
          });
          const deduped = Array.from(unique.values());
          if (deduped.length === 0) { showStatus('⚠️ No items found in this file.', 5000); return; }
          setInventory(deduped);
          setStockPage(1);
          await localforage.setItem('custom_inventory', deduped);
          const counts = `${deduped.length} items${pictures ? ` (${pictures} with pictures)` : ''}`;
          if (!isFirebaseReady) { showStatus(`✅ ${counts} loaded (offline mode).`, 5000); return; }
          showStatus(`⏳ Syncing ${counts} to all devices...`);
          try {
            await bulkSaveInventoryToFirestore(deduped);
            showStatus(`✅ ${counts} synced. All devices updated.`, 5000);
          } catch (err) {
            console.error('Firestore sync failed:', err);
            showStatus('⚠️ Cloud sync failed. Inventory saved on this phone only.', 8000);
          }
        } catch (err) { console.error(err); showStatus('⚠️ Could not read this Excel file.', 6000); }
      };
      reader.readAsBinaryString(file);
    } catch (err) { console.error(err); showStatus('⚠️ Could not read this Excel file.', 6000); }
  };

  const exportInventoryToExcel = async () => {
    try {
      const XLSX = await import('xlsx');
      // Every item detail and the picture, so the file can restore a lost inventory
      const out = inventoryToXlsx(XLSX, inventory);
      await saveFile('Updated_Inventory.xlsx', new Blob([out], { type: XLSX_MIME }));
    } catch (err) { console.error(err); alert('Error exporting Excel.'); }
  };

  // Low stock: items whose stock is kept and is under 10 (0 means the shop does not count that item; below 0 = oversold)
  const isLow = (i: InventoryItem) => { const q = i.stock_quantity ?? 0; return q !== 0 && q < LOW_STOCK; };
  const lowStock = useMemo(() => inventory.filter(isLow), [inventory]);
  const filteredStock = useMemo(() => {
    const found = searchInventory(inventory, fuse, stockQuery);
    return lowOnly ? found.filter(isLow) : found;
  }, [inventory, fuse, stockQuery, lowOnly]);
  const shareToBuyList = () => {
    const lines = lowStock.map(i => `• ${formatName(i.name_marathi || i.name_eng || i.name)} (${i.unit || 'unit'}) — left: ${i.stock_quantity ?? 0}`);
    const text = `🛒 *To buy — ${shopName}*\n${new Date().toLocaleDateString('en-IN')}\n\n${lines.join('\n')}`;
    openExternalUrl(`https://wa.me/?text=${encodeURIComponent(text)}`);
  };

  // A new shop can start from the common kirana list that ships with the app (public/inventory.json)
  const loadStarterList = async () => {
    if (!confirm('Load the starter list of common kirana items (about 10,000)? You can edit or delete items later.')) return;
    showStatus('⏳ Loading the starter list…');
    try {
      const r = await fetch('/inventory.json');
      const items = await r.json() as InventoryItem[];
      setInventory(items);
      await localforage.setItem('custom_inventory', items);
      await bulkSaveInventoryToFirestore(items, (done, total) => showStatus(`⏳ Saving ${done} / ${total} items for all phones…`));
      showStatus(`✅ ${items.length} items ready.`, 6000);
    } catch (err) {
      console.error(err);
      showStatus('⚠️ Could not load the starter list. Check the internet and try again.', 8000);
    }
  };
  const favFilteredStock = filteredStock.filter(s => favoriteIds.has(s.id));
  const nonFavFilteredStock = filteredStock.filter(s => !favoriteIds.has(s.id));
  const totalStockPages = Math.max(1, Math.ceil(nonFavFilteredStock.length / ITEMS_PER_PAGE));
  const page = Math.min(stockPage, totalStockPages);
  const pagedStock = nonFavFilteredStock.slice((page - 1) * ITEMS_PER_PAGE, page * ITEMS_PER_PAGE);

  const renderInventoryCard = (s: InventoryItem) => (
    <InventoryTile
      key={s.id}
      item={s}
      isFav={favoriteIds.has(s.id)}
      onOpen={() => openEditor(s)}
      onToggleFav={() => toggleFavorite(s.id)}
      onDelete={() => deleteInventoryItem(s)}
    />
  );

  const closeReview = () => {
    setCurrentReviewId(null);
    // Drop ?review= so a reload does not reopen the bill
    if (new URLSearchParams(window.location.search).has('review')) window.history.replaceState(null, '', window.location.pathname);
  };

  // ── If a review is open, show full-page review ────────────────────────────
  if (currentReviewId) {
    return (
      <OwnerReviewPage
        reviewId={currentReviewId}
        onBack={reviewOnly ? null : closeReview}
        inventory={inventory}
        fuse={fuse}
      />
    );
  }

  const badge = pending.length > 0 ? <span className="o-badge">{pending.length}</span> : null;
  const editItem = inventoryEditItem;
  const editNames = editItem ? itemNameFields(editItem) : null;
  const editIsExisting = !!editItem && inventory.some(i => i.id === editItem.id);
  const numValue = (n: number | undefined) => (n === undefined || isNaN(n) ? '' : n);
  const isPhone = () => window.matchMedia('(max-width: 992px)').matches;
  const toggleSidebar = () => {
    if (isPhone()) { setDrawerOpen(o => !o); return; }
    const next = !sideCollapsed;
    setSideCollapsed(next);
    try { localStorage.setItem('owner_sidebar_collapsed', next ? '1' : '0'); } catch { /* storage blocked */ }
  };
  const closeSidebar = () => { if (isPhone()) setDrawerOpen(false); else if (!sideCollapsed) toggleSidebar(); };
  const goTab = (t: Tab) => { setActiveTab(t); setDrawerOpen(false); };
  const tabTitle = { bills: '📋 Bills', inventory: '📦 Inventory', khata: '📒 Udhaar (Khata)', shop: '🏪 Shop' }[activeTab];

  return (
    <div className={sideCollapsed ? 'o-side-collapsed' : undefined} style={{ minHeight: '100vh', background: '#f1f2f6' }}>
      <style dangerouslySetInnerHTML={{ __html: APP_CSS }} />

      {/* Phone: dimmed backdrop behind the open drawer; tap to close */}
      <div className={`o-backdrop${drawerOpen ? ' open' : ''}`} onClick={() => setDrawerOpen(false)} />

      {/* Sidebar (☰ opens / ✕ closes) */}
      <div className={`sidebar${drawerOpen ? ' open' : ''}`}>
        <div className="o-side-head">
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: '1rem' }}>👑 Owner Panel</div>
            <div style={{ fontSize: '0.72rem', opacity: 0.65, marginTop: 2 }}>{shopName}</div>
          </div>
          <button className="o-side-close" onClick={closeSidebar} aria-label="Close menu">✕</button>
        </div>
        <div style={{ flex: 1 }}>
          <a className={`nav-link ${activeTab === 'bills' ? 'active' : ''}`} onClick={() => goTab('bills')}>📋 BILLS {badge}</a>
          <a className={`nav-link ${activeTab === 'inventory' ? 'active' : ''}`} onClick={() => goTab('inventory')}>📦 INVENTORY</a>
          <a className={`nav-link ${activeTab === 'khata' ? 'active' : ''}`} onClick={() => goTab('khata')}>📒 UDHAAR (KHATA)</a>
          <a className={`nav-link ${activeTab === 'shop' ? 'active' : ''}`} onClick={() => goTab('shop')}>🏪 SHOP & CASHIERS</a>
        </div>
        {user && (
          <div style={{ padding: '1rem', borderTop: '1px solid rgba(255,255,255,0.15)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              {user.picture && <img src={user.picture} alt="" className="o-avatar" />}
              <div style={{ overflow: 'hidden' }}>
                <div style={{ fontSize: '0.82rem', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{user.name}</div>
                <div style={{ fontSize: '0.68rem', opacity: 0.65, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{user.email}</div>
              </div>
            </div>
            <button onClick={logout} className="o-signout-btn" style={{ width: '100%' }}>Sign Out</button>
          </div>
        )}
      </div>

      {/* Top bar on every screen size: ☰ + current page */}
      <div className="o-topbar">
        <button className="o-menu-btn" onClick={toggleSidebar} aria-label="Menu">
          <span /><span /><span />
          {pending.length > 0 && <b className="o-badge o-menu-badge">{pending.length}</b>}
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: '1rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{tabTitle}</div>
          <div style={{ fontSize: '0.7rem', opacity: 0.7, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>👑 Owner · {shopName}</div>
        </div>
        {user && <button onClick={logout} className="o-signout-btn o-topbar-signout">Sign Out</button>}
      </div>

      <div className="main-content">

        {/* ── Bills tab ──────────────────────────────────────────────────────── */}
        {activeTab === 'bills' && (
          <OwnerDashboard pending={pending} onOpen={id => setCurrentReviewId(id)} />
        )}

        {/* ── Shop tab: join code, cashiers, old-inventory import ─────────────── */}
        {activeTab === 'shop' && <ShopPanel shopItemCount={inventory.length} />}

        {/* ── Udhaar / khata ──────────────────────────────────────────────────── */}
        {activeTab === 'khata' && <KhataPanel />}

        {/* ── Inventory tab ─────────────────────────────────────────────────── */}
        {activeTab === 'inventory' && (
          <div>
            <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <input ref={fileInputRef} type="file" accept=".xlsx, .xls, .csv" onChange={handleFileUpload} style={{ display: 'none' }} />
              <div className="o-toolbar">
                <button className="o-tool-btn" style={{ background: '#6c757d' }} onClick={() => fileInputRef.current?.click()}>📤 Import</button>
                <button className="o-tool-btn" style={{ background: '#198754' }} onClick={exportInventoryToExcel}>⬇️ Export</button>
                <button className="o-tool-btn" style={{ background: '#0d6efd' }} onClick={openNewItem}>➕ Add</button>
              </div>
              {uploadStatus && <div className="o-status">{uploadStatus}</div>}
              <div className="o-search-row">
                <input type="text" className="o-search-input"
                  placeholder="Eng -> मराठी Stock Search..."
                  value={stockQuery}
                  onChange={e => { setStockPage(1); setStockQuery(imeValue(e.target.value, imeEnabled)); }} />
                <button className="o-ime-btn" onClick={() => setImeEnabled(v => !v)} style={{ background: imeEnabled ? '#28a745' : '#aaa' }}>
                  {imeEnabled ? 'अ' : 'A'}
                </button>
              </div>
              {lowStock.length > 0 && (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button onClick={() => { setLowOnly(v => !v); setStockPage(1); }}
                    style={{ minHeight: 44, borderRadius: 999, padding: '0 14px', fontWeight: 700, cursor: 'pointer', border: '1.5px solid #DC2626',
                      background: lowOnly ? '#DC2626' : 'white', color: lowOnly ? 'white' : '#DC2626' }}>
                    ⚠️ Low stock ({lowStock.length}){lowOnly ? ' ✓' : ''}
                  </button>
                  {lowOnly && (
                    <button onClick={shareToBuyList}
                      style={{ minHeight: 44, borderRadius: 999, padding: '0 14px', fontWeight: 700, cursor: 'pointer', border: 'none', background: '#25D366', color: 'white' }}>
                      📲 Send to-buy list
                    </button>
                  )}
                </div>
              )}
            </div>

            <div>
              {favFilteredStock.length > 0 && (
                <div>
                  <div style={{ fontSize: '0.72rem', fontWeight: 'bold', color: '#0d6efd', padding: '2px 4px 6px', display: 'flex', alignItems: 'center', gap: '4px', letterSpacing: '0.04em' }}>
                    ★ FAVOURITES
                  </div>
                  <div className="inv-grid">{favFilteredStock.map(s => renderInventoryCard(s))}</div>
                  <div style={{ borderBottom: '2px dashed #E7E5E4', margin: '4px 0 12px' }} />
                </div>
              )}

              {filteredStock.length === 0 ? (
                <div className="kirana-empty">
                  <div style={{ fontSize: '2.5rem' }}>📦</div>
                  <div style={{ fontWeight: 600, marginTop: 6 }}>{stockQuery || lowOnly ? 'No items match' : 'No items yet — tap ➕ Add or 📤 Import'}</div>
                  {inventory.length === 0 && isFirebaseReady && (
                    <button onClick={loadStarterList}
                      style={{ marginTop: 14, minHeight: 48, borderRadius: 10, border: 'none', background: '#0a3d62', color: 'white', fontWeight: 800, padding: '0 18px', cursor: 'pointer' }}>
                      📋 Start with the common kirana list
                    </button>
                  )}
                </div>
              ) : (
                <div className="inv-grid">{pagedStock.map(s => renderInventoryCard(s))}</div>
              )}
            </div>

            <div className="o-pager">
              <button className="o-pager-btn" disabled={page <= 1} onClick={() => setStockPage(page - 1)}
                style={{ background: page <= 1 ? '#e9ecef' : '#0a3d62', color: page <= 1 ? '#adb5bd' : 'white', cursor: page <= 1 ? 'default' : 'pointer' }}>
                ← मागे
              </button>
              <span style={{ fontWeight: 'bold', color: '#0a3d62', fontSize: '0.9rem', textAlign: 'center' }}>
                पृष्ठ {page} / {totalStockPages}<br />
                <span style={{ fontWeight: 'normal', color: '#6c757d', fontSize: '0.78rem' }}>{filteredStock.length} वस्तू</span>
              </span>
              <button className="o-pager-btn" disabled={page >= totalStockPages} onClick={() => setStockPage(page + 1)}
                style={{ background: page >= totalStockPages ? '#e9ecef' : '#0a3d62', color: page >= totalStockPages ? '#adb5bd' : 'white', cursor: page >= totalStockPages ? 'default' : 'pointer' }}>
                पुढे →
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── Inventory add / edit popup (same fields as the cashier's) ──────── */}
      {editItem && editNames && (
        <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setInventoryEditItem(null)}>
          <div className="modal-content">
            <div className="modal-header">
              <span>{editIsExisting ? 'EDIT INVENTORY ITEM' : 'ADD NEW ITEM'}</span>
              <button className="o-close-btn" onClick={() => setInventoryEditItem(null)} aria-label="Close">✕</button>
            </div>

            <ItemImageField
              image={editItem.image}
              onChange={img => setInventoryEditItem(prev => prev && withImage(prev, img))}
            />

            <label className="o-label">ITEM NAME (ENGLISH)</label>
            <input type="text" className={`edit-input${editNameError ? ' bad' : ''}`}
              value={editNames.eng}
              onChange={e => { setEditNameError(false); setInventoryEditItem(withItemNames(editItem, { eng: e.target.value })); }} />

            <label className="o-label">ITEM NAME (MARATHI)</label>
            <input type="text" className={`edit-input${editNameError ? ' bad' : ''}`}
              value={editNames.marathi}
              onChange={e => { setEditNameError(false); setInventoryEditItem(withItemNames(editItem, { marathi: e.target.value })); }} />
            {editNameError && <div className="o-error">Enter the English or the Marathi name.</div>}

            <label className="o-label">BARCODE (Optional)</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <input type="text" className="edit-input" style={{ flex: 1, minWidth: 0 }}
                placeholder="Scan or type barcode"
                value={editItem.barcode || ''}
                onChange={e => setInventoryEditItem({ ...editItem, barcode: e.target.value })} />
              <button className="o-side-btn" style={{ background: '#6c757d' }} onClick={() => setScanForEdit(true)}>📷 Scan</button>
            </div>

            <div className="o-row">
              <div>
                <label className="o-label">MRP</label>
                <input type="number" inputMode="decimal" className="edit-input"
                  value={numValue(editItem.purchase_price)}
                  onChange={e => setInventoryEditItem({ ...editItem, purchase_price: Number(e.target.value) })} />
              </div>
              <div>
                <label className="o-label">SALE RATE</label>
                <input type="number" inputMode="decimal" className="edit-input"
                  value={numValue(editItem.price)}
                  onChange={e => setInventoryEditItem({ ...editItem, price: Number(e.target.value) })} />
              </div>
            </div>

            <div className="o-row">
              <div>
                <label className="o-label">STOCK QTY</label>
                <input type="number" inputMode="decimal" className="edit-input"
                  value={numValue(editItem.stock_quantity)}
                  onChange={e => setInventoryEditItem({ ...editItem, stock_quantity: Number(e.target.value), stock_qty: Number(e.target.value) })} />
              </div>
              <div>
                <label className="o-label">UNIT (kg, L, pcs)</label>
                <input type="text" className="edit-input"
                  value={editItem.unit || ''}
                  onChange={e => setInventoryEditItem({ ...editItem, unit: e.target.value })} />
              </div>
            </div>

            <label className="o-label">PACK SIZE (e.g. 250 g, 1 L)</label>
            <input type="text" className="edit-input"
              value={editItem.net_qty || ''}
              onChange={e => setInventoryEditItem({ ...editItem, net_qty: e.target.value })} />

            <label className="o-label">UNIT RATES (optional — e.g. bag ₹550, 250g ₹35)</label>
            {Object.entries(editItem.unit_rates || {}).map(([u, r]) => (
              <div key={u} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                <input type="text" className="edit-input" style={{ flex: 1, minWidth: 0, background: '#f8f9fa' }} value={u} readOnly />
                <input type="number" inputMode="decimal" className="edit-input" style={{ flex: 1, minWidth: 0 }}
                  value={r}
                  onChange={e => setInventoryEditItem({ ...editItem, unit_rates: { ...(editItem.unit_rates || {}), [u]: Number(e.target.value) } })} />
                <button className="o-del-btn" aria-label={`Remove ${u} rate`}
                  onClick={() => {
                    const updated = { ...(editItem.unit_rates || {}) };
                    delete updated[u];
                    setInventoryEditItem({ ...editItem, unit_rates: updated });
                  }}>✕</button>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 6 }}>
              <input type="text" className="edit-input" style={{ flex: 1, minWidth: 0 }}
                placeholder="unit (e.g. bag)"
                value={newRateUnit}
                onChange={e => setNewRateUnit(e.target.value)} />
              <input type="number" inputMode="decimal" className="edit-input" style={{ flex: 1, minWidth: 0 }}
                placeholder="rate ₹"
                value={newRateValue}
                onChange={e => setNewRateValue(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addUnitRate(); } }} />
              <button className="o-side-btn" style={{ background: '#198754' }} onClick={addUnitRate}>+ ADD</button>
            </div>

            <button className="modal-btn" onClick={saveInventoryEdit}>SAVE CHANGES</button>
            {editIsExisting && (
              <button className="o-delete-btn" onClick={() => deleteInventoryItem()}>🗑 DELETE ITEM</button>
            )}
          </div>
        </div>
      )}

      {scanForEdit && (
        <BarcodeScanner
          onResult={code => { setInventoryEditItem(prev => prev && { ...prev, barcode: code }); setScanForEdit(false); }}
          onClose={() => setScanForEdit(false)}
        />
      )}
    </div>
  );
}

// ── OwnerDashboard: today summary + pending / recent bills ───────────────────
function OwnerDashboard({ pending, onOpen }: { pending: ReviewSession[]; onOpen: (id: string) => void }) {
  const [tab, setTab] = useState<'pending' | 'all'>('pending');
  const [recent, setRecent] = useState<ReviewSession[]>([]);
  const [recentMax, setRecentMax] = useState(RECENT_PAGE_SIZE);
  const [today, setToday] = useState<ReviewSession[]>([]);

  useEffect(() => {
    if (!isFirebaseReady || tab !== 'all') return;
    return subscribeToRecentReviews(recentMax, setRecent);
  }, [tab, recentMax]);

  useEffect(() => {
    if (!isFirebaseReady) return;
    return subscribeToReviewsSince(startOfToday(), setToday);
  }, []);

  const approvedToday = today.filter(s => s.status === 'approved');
  const rejectedToday = today.filter(s => s.status === 'rejected');
  const approvedTotal = approvedToday.reduce((sum, s) => sum + cartTotal(finalCart(s)), 0);
  const list = tab === 'pending' ? pending : recent;
  const canLoadMore = tab === 'all' && recent.length >= recentMax;

  return (
    <div>
      {!isFirebaseReady && (
        <div style={{ background: '#FFF3CD', border: '1px solid #FFC107', borderRadius: 10, marginBottom: '1rem', padding: '12px 16px', fontSize: '0.9rem' }}>
          <strong>⚠️ Firebase not configured.</strong> Add Firebase keys to <code>.env</code> to enable real-time sync.
        </div>
      )}

      <div className="o-summary">
        <div className="o-summary-tile" style={{ borderTop: '3px solid #F97316' }}>
          <div className="o-summary-num" style={{ color: '#F97316' }}>{pending.length}</div>
          <div className="o-summary-label">⏳ Pending</div>
        </div>
        <div className="o-summary-tile" style={{ borderTop: '3px solid #16A34A' }}>
          <div className="o-summary-num" style={{ color: '#16A34A' }}>{approvedToday.length}</div>
          <div className="o-summary-label">✅ Approved today</div>
          {approvedToday.length > 0 && <div className="o-summary-sub">{fmt(approvedTotal)}</div>}
        </div>
        <div className="o-summary-tile" style={{ borderTop: '3px solid #DC2626' }}>
          <div className="o-summary-num" style={{ color: '#DC2626' }}>{rejectedToday.length}</div>
          <div className="o-summary-label">❌ Rejected today</div>
        </div>
      </div>

      <div className="o-tabs">
        {(['pending', 'all'] as const).map(t => (
          <button key={t} className="o-tab" onClick={() => setTab(t)}
            style={{ background: tab === t ? '#0a3d62' : 'white', color: tab === t ? 'white' : '#555' }}>
            {t === 'pending' ? `⏳ Pending${pending.length ? ` (${pending.length})` : ''}` : '📋 Recent Bills'}
          </button>
        ))}
      </div>

      {list.length === 0 ? (
        <div style={{ textAlign: 'center', marginTop: '3rem', color: '#888' }}>
          <div style={{ fontSize: '3rem' }}>✅</div>
          <div style={{ fontWeight: 600, marginTop: 8 }}>{tab === 'pending' ? 'No pending reviews' : 'No bills yet'}</div>
        </div>
      ) : list.map(s => <DashboardCard key={s.id} session={s} onOpen={onOpen} />)}

      {canLoadMore && (
        <button onClick={() => setRecentMax(m => m + RECENT_PAGE_SIZE)}
          style={{ width: '100%', minHeight: 48, background: 'white', color: '#0a3d62', border: '1.5px solid #0a3d62', borderRadius: 10, fontWeight: 700, cursor: 'pointer', marginTop: 4 }}>
          Load older bills
        </button>
      )}
    </div>
  );
}

function DashboardCard({ session: s, onOpen }: { session: ReviewSession; onOpen: (id: string) => void }) {
  const cart = finalCart(s);
  const total = cartTotal(cart);
  const statusColor = s.status === 'approved' ? '#16A34A' : s.status === 'rejected' ? '#DC2626' : '#F97316';
  const statusLabel = s.status === 'approved' ? '✅ Approved' : s.status === 'rejected' ? '❌ Rejected' : '⏳ Pending';

  return (
    <div onClick={() => onOpen(s.id)}
      style={{ background: 'white', borderRadius: 12, padding: '12px 14px', marginBottom: 10, boxShadow: '0 2px 8px rgba(0,0,0,0.06)', cursor: 'pointer', borderLeft: `4px solid ${statusColor}`, opacity: s.status !== 'pending' ? 0.85 : 1 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: '0.95rem', overflowWrap: 'anywhere' }}>
            📋 {s.customerName || 'Walk-in'}
            {s.customerPhone && <span style={{ fontWeight: 400, color: '#666', fontSize: '0.8rem' }}> · {s.customerPhone}</span>}
          </div>
          <div style={{ color: '#555', fontSize: '0.82rem', marginTop: 3 }}>From: <strong>{s.cashierName}</strong> · {cart?.length || 0} item{cart?.length === 1 ? '' : 's'} · {fmt(total)}</div>
          <div style={{ color: '#999', fontSize: '0.75rem', marginTop: 3 }}>{timeAgo(s.createdAt)}</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, flexShrink: 0 }}>
          <span style={{ fontSize: '0.72rem', fontWeight: 600, color: statusColor }}>{statusLabel}</span>
          <span style={{ fontSize: '1.2rem', color: '#9ca3af' }}>→</span>
        </div>
      </div>
      {s.ownerNotes && (
        <div style={{ marginTop: 8, fontSize: '0.8rem', color: '#555', background: '#f8f9fa', borderRadius: 6, padding: '6px 10px' }}>💬 {s.ownerNotes}</div>
      )}
    </div>
  );
}

// ── OwnerReviewPage — POS-style full-page review ─────────────────────────────

// A bill line on the review page. `_key` identifies the line (the cashier's cart can hold the same item id twice);
// `_orig` is the index of the cashier's line it came from (null = added by the owner). Both are dropped on approve.
interface RvLine extends CartItem { _key: string; _orig: number | null }

/** Pairs each current line with the cashier's line of the same item and unit, in order. */
const toLines = (orig: CartItem[], current: CartItem[]): RvLine[] => {
  const used = new Set<number>();
  return current.map((c, i) => {
    const o = orig.findIndex((x, j) => !used.has(j) && x.id === c.id && lineUnit(x) === lineUnit(c));
    if (o >= 0) used.add(o);
    return { ...c, _key: `l${i}-${c.id}`, _orig: o >= 0 ? o : null };
  });
};
const fromLines = (lines: RvLine[]): CartItem[] => lines.map(l => {
  const c: Partial<RvLine> = { ...l };
  delete c._key; delete c._orig;
  return c as CartItem;
});
const isBadLine = (l: CartItem) => !(l.qty > 0) || !(l.rate > 0);

interface AddModalState { item: InventoryItem; qty: number; rate: number; cartUnit: string; multiplier: number }

function OwnerReviewPage({ reviewId, onBack, inventory, fuse }: {
  reviewId: string; onBack: (() => void) | null;
  inventory: InventoryItem[]; fuse: Fuse<InventoryItem> | null;
}) {
  const { user, logout } = useAuth();

  const [session, setSession] = useState<ReviewSession | null>(null);
  const [lines, setLines] = useState<RvLine[]>([]);
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(isFirebaseReady);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<'approved' | 'rejected' | null>(null);

  const [query, setQuery] = useState('');
  const [imeEnabled, setImeEnabled] = useState(true);
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const [scanning, setScanning] = useState(false);
  const [scanMsg, setScanMsg] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [addModal, setAddModal] = useState<AddModalState | null>(null);
  const lineSeq = useRef(0);

  useEffect(() => {
    if (!isFirebaseReady) return;
    let initialised = false;
    return subscribeToReview(reviewId, s => {
      if (s) {
        setSession(s);
        // Lines are taken once; later updates (e.g. status) must not undo the owner's edits
        if (!initialised) { initialised = true; setLines(toLines(s.cart || [], finalCart(s) || [])); }
      }
      setLoading(false);
    });
  }, [reviewId]);

  useEffect(() => {
    if (!scanMsg) return;
    const t = setTimeout(() => setScanMsg(''), 4000);
    return () => clearTimeout(t);
  }, [scanMsg]);

  const suggestions = useMemo(
    () => (query.trim().length < 2 ? [] : searchInventory(inventory, fuse, query, 8)),
    [inventory, fuse, query],
  );

  const setQty = (key: string, qty: number) =>
    setLines(prev => prev.map(l => l._key === key ? { ...l, qty, total: lineTotal(qty, l.rate, l.multiplier ?? 1) } : l));

  // The rate box shows the price per cart unit; the line stores it per base unit
  const setUnitRate = (key: string, perUnit: number) =>
    setLines(prev => prev.map(l => {
      if (l._key !== key) return l;
      const m = l.multiplier ?? 1;
      const rate = m ? perUnit / m : perUnit;
      return { ...l, rate, total: lineTotal(l.qty, rate, m) };
    }));

  const removeLine = (key: string) => setLines(prev => prev.filter(l => l._key !== key));

  const restoreLine = (origIdx: number) => {
    if (!session) return;
    const o = session.cart[origIdx];
    setLines(prev => [...prev, { ...o, _key: `r${origIdx}-${o.id}`, _orig: origIdx }]);
  };

  const openAddModal = (item: InventoryItem) => {
    const cartUnit = item.unit || 'unit';
    const custom = item.unit_rates?.[cartUnit];
    setAddModal({ item, qty: 1, rate: custom ?? (item.price || 0), cartUnit, multiplier: 1 });
    setQuery(''); setSelectedIdx(-1);
  };

  const changeAddUnit = (u: string) => {
    if (!addModal) return;
    const custom = addModal.item.unit_rates?.[u];
    if (custom !== undefined) setAddModal({ ...addModal, cartUnit: u, rate: custom, multiplier: 1 });
    else setAddModal({ ...addModal, cartUnit: u, rate: addModal.item.price || 0, multiplier: getUnitMultiplier(u, (addModal.item.unit || 'unit').toLowerCase()) });
  };

  const confirmAdd = () => {
    if (!addModal) return;
    const { item, qty, rate, cartUnit, multiplier } = addModal;
    if (!(qty > 0)) { alert('Enter a quantity above 0.'); return; }
    lineSeq.current += 1;
    setLines(prev => [...prev, {
      id: item.id, name: formatName(item.name_marathi || item.name), unit: item.unit || 'unit',
      qty, rate, total: lineTotal(qty, rate, multiplier), cartUnit, multiplier,
      _key: `n${lineSeq.current}-${item.id}`, _orig: null,
    }]);
    setAddModal(null);
    setTimeout(() => searchInputRef.current?.focus(), 50);
  };

  const onBarcode = (code: string) => {
    setScanning(false);
    const item = inventory.find(i => (i.barcode || '').trim() === code);
    if (item) openAddModal(item);
    else setScanMsg(`No item with barcode ${code}`);
  };

  const badCount = lines.filter(isBadLine).length;

  const handleApprove = async () => {
    if (lines.length === 0) { alert('Bill is empty — add items or reject.'); return; }
    if (badCount > 0) { alert(`${badCount} line${badCount > 1 ? 's have' : ' has'} quantity or rate 0 (shown in red). Fix or remove ${badCount > 1 ? 'them' : 'it'}.`); return; }
    setSubmitting(true);
    try { await approveReview(reviewId, fromLines(lines), notes); setDone('approved'); }
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

  if (done) return (
    <div style={{ minHeight: '100vh', background: done === 'approved' ? '#f0fff4' : '#fff5f5', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', fontFamily: "'Segoe UI', sans-serif", padding: '2rem' }}>
      <style dangerouslySetInnerHTML={{ __html: REVIEW_CSS }} />
      <div style={{ fontSize: '4rem' }}>{done === 'approved' ? '✅' : '❌'}</div>
      <h2 style={{ color: done === 'approved' ? '#16A34A' : '#DC2626', margin: '1rem 0 0.5rem' }}>{done === 'approved' ? 'Bill Approved!' : 'Bill Rejected'}</h2>
      <p style={{ color: '#555', textAlign: 'center', marginBottom: '1.5rem' }}>{done === 'approved' ? 'Cashier will be notified with updated rates.' : 'Cashier has been notified.'}</p>
      {onBack
        ? <button onClick={onBack} style={{ background: '#0a3d62', color: 'white', border: 'none', borderRadius: 10, minHeight: 48, padding: '0 28px', fontWeight: 700, fontSize: '1rem', cursor: 'pointer' }}>← Back to Dashboard</button>
        : <p style={{ color: '#888', fontSize: '0.9rem' }}>You can close this page now.</p>}
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
        <div style={{ fontSize: '2rem', marginBottom: 8 }}>🔍</div>{isFirebaseReady ? 'Review not found.' : 'Firebase not configured.'}<br />
        {onBack && <button onClick={onBack} style={{ marginTop: 16, background: '#0a3d62', color: 'white', border: 'none', borderRadius: 8, minHeight: 44, padding: '0 20px', cursor: 'pointer' }}>← Back</button>}
      </div>
    </div>
  );

  const isPending = session.status === 'pending';
  const totalAmt = lines.reduce((sum, l) => sum + (l.total || 0), 0);
  const origCart = session.cart || [];
  const usedOrig = new Set(lines.map(l => l._orig).filter((o): o is number => o !== null));
  const removed = origCart.map((c, i) => ({ c, i })).filter(({ i }) => !usedOrig.has(i));

  // "was" hints: the cashier's qty / rate when the owner changed them
  const origOf = (l: RvLine) => (l._orig !== null ? origCart[l._orig] : undefined);
  const wasQty = (l: RvLine) => { const o = origOf(l); return o && Math.abs(o.qty - l.qty) > 1e-9 ? o.qty : null; };
  const wasRate = (l: RvLine) => { const o = origOf(l); return o && Math.abs(lineRate(o) - lineRate(l)) > 0.0005 ? round3(lineRate(o)) : null; };

  const nameCell = (l: RvLine) => (
    <>
      {l.name.toUpperCase()} <small style={{ color: '#6c757d', fontWeight: 400 }}>({lineUnit(l)})</small>
      {l._orig === null && <span className="o-new-tag">NEW</span>}
    </>
  );
  const qtyInput = (l: RvLine, fullWidth = false) => (
    <input type="number" inputMode="decimal" className={`o-edit-input${!(l.qty > 0) ? ' bad' : ''}`} style={fullWidth ? { width: '100%' } : undefined}
      value={isNaN(l.qty) ? '' : l.qty} min={0} step={0.1}
      onFocus={e => e.target.select()}
      onChange={e => setQty(l._key, parseFloat(e.target.value) || 0)} />
  );
  const rateInput = (l: RvLine, fullWidth = false) => (
    <input type="number" inputMode="decimal" className={`o-edit-input${!(l.rate > 0) ? ' bad' : ''}`} style={fullWidth ? { width: '100%' } : undefined}
      value={round3(lineRate(l))} min={0} step={0.5}
      onFocus={e => e.target.select()}
      onChange={e => setUnitRate(l._key, parseFloat(e.target.value) || 0)} />
  );
  const was = (v: number | null, prefix = '') => (v !== null ? <span className="o-was">was {prefix}{v}</span> : null);

  return (
    <div style={{ minHeight: '100vh', background: '#f1f2f6', fontFamily: "'Segoe UI', sans-serif", paddingBottom: isPending ? 90 : 20 }}>
      <style dangerouslySetInnerHTML={{ __html: REVIEW_CSS }} />

      {/* Header */}
      <div className="rv-header">
        {onBack && <button className="rv-back-btn" onClick={onBack}>← Back</button>}
        <div className="rv-title">
          <div className="rv-title-main">Review Bill — {session.customerName || 'Walk-in'}</div>
          <div className="rv-title-sub">Cashier: {session.cashierName} · {timeAgo(session.createdAt)}{session.customerPhone && ` · 📞 ${session.customerPhone}`}</div>
        </div>
        {/* Opened from a link without the owner account: no dashboard, so sign out lives here */}
        {!onBack && user && <button className="o-signout-btn" onClick={logout}>Sign Out</button>}
      </div>

      {!isPending && (
        <div style={{ background: session.status === 'approved' ? '#D4EDDA' : '#F8D7DA', padding: '8px 16px', textAlign: 'center', fontWeight: 600, color: session.status === 'approved' ? '#155724' : '#721C24', fontSize: '0.9rem' }}>
          {session.status === 'approved' ? '✅ Already Approved' : '❌ Already Rejected'}
        </div>
      )}

      <div style={{ padding: '10px 10px 0', maxWidth: 1000, margin: '0 auto' }}>
        {/* Search bar */}
        {isPending && (
          <div className="card" style={{ marginBottom: 10 }}>
            <div style={{ fontWeight: 700, fontSize: '0.8rem', color: '#0a3d62', marginBottom: 8 }}>➕ ADD ITEM FROM INVENTORY</div>
            <div className="o-search-container">
              <div className="o-search-row">
                <input ref={searchInputRef} className="o-search-input" type="text" placeholder="Search item to add..." value={query} autoComplete="off"
                  onKeyDown={e => {
                    if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIdx(i => Math.min(i + 1, suggestions.length - 1)); }
                    else if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIdx(i => Math.max(i - 1, 0)); }
                    else if (e.key === 'Enter') { const t = selectedIdx >= 0 ? suggestions[selectedIdx] : suggestions.length === 1 ? suggestions[0] : null; if (t) openAddModal(t); }
                    else if (e.key === 'Escape') setQuery('');
                  }}
                  onChange={e => { setSelectedIdx(-1); setQuery(imeValue(e.target.value, imeEnabled)); }} />
                <button className="o-ime-btn" onClick={() => setImeEnabled(v => !v)} style={{ background: imeEnabled ? '#28a745' : '#aaa' }}>{imeEnabled ? 'अ' : 'A'}</button>
                <button className="o-ime-btn" onClick={() => setScanning(true)} style={{ background: '#6c757d' }} aria-label="Scan barcode">📷</button>
              </div>
              {suggestions.length > 0 && (
                <div className="o-suggestions">
                  {suggestions.map((s, idx) => (
                    <div key={s.id} className={`o-suggestion-item${idx === selectedIdx ? ' active' : ''}`} onClick={() => openAddModal(s)} onMouseEnter={() => setSelectedIdx(idx)}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                        <ItemThumb item={s} />
                        <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}><b>{formatName(s.name_marathi || s.name_eng || s.name).toUpperCase()}</b> <small style={{ color: '#6c757d' }}>({s.unit || 'unit'})</small>{s.brand && <small style={{ color: '#0a3d62', fontWeight: 600 }}> {s.brand}</small>}</span>
                      </span>
                      <span style={{ color: '#16A34A', fontWeight: 700, flexShrink: 0, marginLeft: 8 }}>{fmt(s.price || 0)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            {scanMsg && <div className="o-error" style={{ marginTop: 6 }}>{scanMsg}</div>}
          </div>
        )}

        {/* Total bar */}
        <div className="o-total-bar">
          <h3 style={{ margin: 0, fontWeight: 700 }}>TOTAL: {fmt(totalAmt)}</h3>
          <span style={{ fontSize: '0.8rem', opacity: 0.75, textAlign: 'right' }}>
            {lines.length} item{lines.length === 1 ? '' : 's'}
            {Math.abs(totalAmt - cartTotal(origCart)) > 0.005 && <><br />sent: {fmt(cartTotal(origCart))}</>}
          </span>
        </div>

        {isPending && badCount > 0 && (
          <div style={{ background: '#FEF2F2', border: '1px solid #FCA5A5', color: '#B91C1C', borderRadius: 10, padding: '8px 12px', marginBottom: 10, fontSize: '0.85rem', fontWeight: 600 }}>
            ⚠️ {badCount} line{badCount > 1 ? 's have' : ' has'} quantity or rate 0 — fix or remove before approving.
          </div>
        )}

        {/* Desktop cart table */}
        <div className="card o-desktop-cart" style={{ padding: '0.75rem' }}>
          {lines.length === 0 ? (
            <div style={{ padding: '1.5rem', textAlign: 'center', color: '#888' }}>No items</div>
          ) : (
            <div className="o-table-wrap">
              <table className="o-table">
                <thead>
                  <tr style={{ background: '#f8f9fa' }}>
                    <th>Product (Unit)</th>
                    <th style={{ textAlign: 'center', width: 100 }}>Qty</th>
                    <th style={{ textAlign: 'center', width: 110 }}>Rate (₹)</th>
                    <th style={{ textAlign: 'right', width: 100 }}>Total</th>
                    {isPending && <th style={{ textAlign: 'center', width: 60 }}>Del</th>}
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, idx) => (
                    <tr key={l._key} className={isPending && isBadLine(l) ? 'o-line-bad' : undefined} style={{ background: idx % 2 === 0 ? 'white' : '#fafafa' }}>
                      <td style={{ fontWeight: 600 }}>{nameCell(l)}</td>
                      <td style={{ textAlign: 'center' }}>{isPending ? qtyInput(l) : l.qty}{was(wasQty(l))}</td>
                      <td style={{ textAlign: 'center' }}>{isPending ? rateInput(l) : `₹${round3(lineRate(l))}`}{was(wasRate(l), '₹')}</td>
                      <td style={{ textAlign: 'right', fontWeight: 700, color: '#16A34A' }}>{fmt(l.total || 0)}</td>
                      {isPending && <td style={{ textAlign: 'center' }}><button className="o-del-btn" onClick={() => removeLine(l._key)} aria-label="Remove line">✕</button></td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Mobile cart cards */}
        <div className="o-mobile-cart">
          {lines.length === 0 && <div style={{ textAlign: 'center', padding: '2rem', color: '#888' }}>No items</div>}
          {lines.map(l => (
            <div key={l._key} className={`card${isPending && isBadLine(l) ? ' o-line-bad' : ''}`} style={{ padding: '10px 12px', marginBottom: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                <div style={{ fontWeight: 700, fontSize: '0.9rem', wordBreak: 'break-word', flex: 1, minWidth: 0 }}>{nameCell(l)}</div>
                <div style={{ fontWeight: 700, color: '#16A34A', fontSize: '1.05rem', flexShrink: 0 }}>{fmt(l.total || 0)}</div>
              </div>
              {isPending ? (
                <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'flex-start' }}>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: '0.72rem', color: '#555', flex: 1, minWidth: 0 }}>
                    Qty ({lineUnit(l)}){qtyInput(l, true)}{was(wasQty(l))}
                  </label>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: '0.72rem', color: '#555', flex: 1, minWidth: 0 }}>
                    Rate ₹/{lineUnit(l)}{rateInput(l, true)}{was(wasRate(l), '₹')}
                  </label>
                  <button className="o-del-btn" onClick={() => removeLine(l._key)} aria-label="Remove line" style={{ marginTop: 18 }}>✕</button>
                </div>
              ) : (
                <div style={{ fontSize: '0.82rem', color: '#555', marginTop: 4 }}>
                  Qty: <b>{l.qty}</b> · Rate: <b>₹{round3(lineRate(l))}</b>
                  {was(wasQty(l))}{was(wasRate(l), '₹')}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Lines the cashier sent that are no longer on the bill */}
        {removed.length > 0 && (
          <div className="card" style={{ padding: '10px 12px' }}>
            <div style={{ fontWeight: 700, fontSize: '0.8rem', color: '#DC2626', marginBottom: 6 }}>🗑 REMOVED FROM CASHIER'S BILL</div>
            {removed.map(({ c, i }) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '6px 0', borderTop: '1px solid #f1f1f1' }}>
                <span style={{ textDecoration: 'line-through', color: '#888', fontSize: '0.88rem', minWidth: 0, overflowWrap: 'anywhere' }}>
                  {c.name.toUpperCase()} · {c.qty} {lineUnit(c)} × ₹{round3(lineRate(c))} = {fmt(c.total || 0)}
                </span>
                {isPending && <button className="o-restore-btn" onClick={() => restoreLine(i)}>↺ Restore</button>}
              </div>
            ))}
          </div>
        )}

        {/* Notes */}
        <div className="card">
          <div style={{ fontWeight: 700, fontSize: '0.8rem', color: '#0a3d62', marginBottom: 6 }}>💬 NOTE TO CASHIER</div>
          <textarea placeholder={isPending ? 'Add a note (optional)...' : 'No notes'}
            value={isPending ? notes : (session.ownerNotes || '')} onChange={e => setNotes(e.target.value)} disabled={!isPending} rows={2}
            style={{ width: '100%', borderRadius: 8, border: '1.5px solid #cbd5e1', padding: '8px 12px', fontSize: '0.9rem', resize: 'none', fontFamily: 'inherit' }} />
        </div>
      </div>

      {/* Fixed approve/reject bar */}
      {isPending && (
        <div className="rv-action-bar">
          <button className="rv-reject-btn" onClick={handleReject} disabled={submitting}>✗ Reject</button>
          <button className="rv-approve-btn" onClick={handleApprove} disabled={submitting}>{submitting ? 'Sending...' : '✓ Approve & Send'}</button>
        </div>
      )}

      {/* Add-item popup with unit picker (same unit / rate rules as the cashier's bill popup) */}
      {addModal && (
        <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setAddModal(null)}>
          <div className="modal-content">
            <div className="modal-header">
              <span style={{ fontSize: '1rem', minWidth: 0, overflowWrap: 'anywhere' }}>{formatName(addModal.item.name_marathi || addModal.item.name_eng || addModal.item.name)}</span>
              <button className="o-close-btn" onClick={() => setAddModal(null)} aria-label="Close">✕</button>
            </div>
            <div style={{ fontSize: '0.78rem', color: '#888', marginBottom: 12 }}>({addModal.item.unit || 'unit'}) · MRP: {fmt(addModal.item.purchase_price || addModal.item.price || 0)}{addModal.item.brand && ` · ${addModal.item.brand}`}</div>
            <label className="o-label">Quantity</label>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <input type="number" inputMode="decimal" className="o-modal-input" style={{ flex: 1, minWidth: 0 }} value={isNaN(addModal.qty) ? '' : addModal.qty} min={0} step={0.1} autoFocus
                onChange={e => setAddModal(m => m ? { ...m, qty: parseFloat(e.target.value) || 0 } : m)}
                onFocus={e => e.target.select()}
                onKeyDown={e => { if (e.key === 'Enter') confirmAdd(); }} />
              <select value={addModal.cartUnit} onChange={e => changeAddUnit(e.target.value)}
                style={{ height: 50, padding: '0 10px', borderRadius: 8, border: '1.5px solid #cbd5e1', fontWeight: 'bold', fontSize: '0.95rem', maxWidth: '45%' }}>
                {unitOptions(addModal.item).map(opt => (
                  <option key={opt} value={opt}>{opt}{addModal.item.unit_rates?.[opt] !== undefined ? ` ₹${addModal.item.unit_rates[opt]}` : ''}</option>
                ))}
              </select>
            </div>
            <label className="o-label">Rate (₹ per {addModal.cartUnit})</label>
            <input type="number" inputMode="decimal" className="o-modal-input" style={{ marginBottom: 12 }}
              value={round3(addModal.rate * addModal.multiplier)} min={0} step={0.5}
              onChange={e => setAddModal(m => m ? { ...m, rate: (parseFloat(e.target.value) || 0) / (m.multiplier || 1) } : m)}
              onFocus={e => e.target.select()}
              onKeyDown={e => { if (e.key === 'Enter') confirmAdd(); }} />
            <div style={{ background: '#f0fff4', border: '1px solid #16A34A', borderRadius: 8, padding: '9px 12px', display: 'flex', justifyContent: 'space-between', fontWeight: 700 }}>
              <span style={{ color: '#555' }}>Total</span>
              <span style={{ color: '#16A34A' }}>{fmt(lineTotal(addModal.qty, addModal.rate, addModal.multiplier))}</span>
            </div>
            <button className="modal-btn" onClick={confirmAdd}>➕ Add to Bill</button>
          </div>
        </div>
      )}

      {scanning && <BarcodeScanner onResult={onBarcode} onClose={() => setScanning(false)} />}
    </div>
  );
}
