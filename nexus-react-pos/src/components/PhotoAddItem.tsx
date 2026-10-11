// Review popup for "Add item from photos" (Android app only).
// The native scanner returns OCR / barcode / Open Food Facts results; this modal shows them pre-filled,
// highlights anything uncertain in yellow, and saves through the same upsert the manual Add form uses.
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import localforage from 'localforage';
import type { InventoryItem } from '../lib/firebase';
import {
  onProductScan, startProductScan, takePendingScanResult, type ProductScanResult,
} from '../lib/androidScan';
import {
  buildInventoryWordMap, composeNames, englishToMarathi, marathiToEnglish, findDuplicate,
  learnFromCorrection, makeSearchKey, type NameMaps, type WordMap,
} from '../lib/itemNames';

const LEARNED_KEY = 'photo_name_map';
const LOW_CONFIDENCE = 0.6;

type FieldKey =
  | 'name_marathi' | 'name_eng' | 'brand' | 'unit' | 'net_qty' | 'mrp' | 'price' | 'stock'
  | 'barcode' | 'search_key' | 'expiry_date' | 'mfg_date';
type Form = Record<FieldKey, string>;

const EMPTY: Form = {
  name_marathi: '', name_eng: '', brand: '', unit: 'pcs', net_qty: '', mrp: '', price: '', stock: '',
  barcode: '', search_key: '', expiry_date: '', mfg_date: '',
};

const SOURCE_LABEL: Record<string, string> = {
  'mlkit-ocr': 'फोटोवरून वाचले', 'mlkit-barcode': 'बारकोड', openfoodfacts: 'Open Food Facts', gemini: 'Smart read',
};

interface Props {
  inventory: InventoryItem[];
  onSave: (item: InventoryItem) => Promise<void>;
  onOpenExisting: (item: InventoryItem) => void;
}

export default function PhotoAddItem({ inventory, onSave, onOpenExisting }: Props) {
  const [scan, setScan] = useState<ProductScanResult | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  const [suggested, setSuggested] = useState<Set<FieldKey>>(new Set());
  const [hints, setHints] = useState<Partial<Record<FieldKey, string>>>({});
  const [autoNames, setAutoNames] = useState({ name_eng: '', name_marathi: '' });
  const [keyTouched, setKeyTouched] = useState(false);
  const [learned, setLearned] = useState<WordMap>({});
  const [saving, setSaving] = useState(false);
  const [batchCount, setBatchCount] = useState(0);
  const [bigPhoto, setBigPhoto] = useState<string | null>(null);

  const inventoryMap = useMemo(() => buildInventoryWordMap(inventory), [inventory]);
  const maps: NameMaps = useMemo(() => ({ learned, inventory: inventoryMap }), [learned, inventoryMap]);
  const mapsRef = useRef(maps);
  useEffect(() => { mapsRef.current = maps; }, [maps]);

  useEffect(() => {
    localforage.getItem<WordMap>(LEARNED_KEY).then(m => { if (m) setLearned(m); }).catch(() => {});
  }, []);

  // ── Fill the form from a scan result ───────────────────────────────────────
  const openResult = (r: ProductScanResult) => {
    const conf = (k: keyof ProductScanResult['confidence']) => r.confidence[k] ?? 0;
    const names = composeNames(
      { brand: r.brand, productEng: r.name_eng, productDev: r.name_marathi, netQty: r.net_qty },
      mapsRef.current,
    );
    const mrp = r.mrp != null ? String(r.mrp) : '';
    const next: Form = {
      ...EMPTY,
      name_marathi: names.name_marathi,
      name_eng: names.name_eng,
      brand: r.brand || '',
      unit: r.unit || 'pcs',
      net_qty: r.net_qty || '',
      mrp,
      price: mrp,
      barcode: r.barcode || '',
      expiry_date: r.expiry_date || '',
      mfg_date: r.mfg_date || '',
    };
    const sug = new Set<FieldKey>();
    const h: Partial<Record<FieldKey, string>> = {};
    const mark = (k: FieldKey, src?: string, low?: boolean) => {
      if (!next[k]) return;
      if (src === 'openfoodfacts' || low) { sug.add(k); h[k] = SOURCE_LABEL[src || ''] || 'तपासा'; }
    };
    // Names are auto-filled → always "suggested" until the user edits them
    if (next.name_marathi) {
      sug.add('name_marathi');
      h.name_marathi = names.mrFromHindi ? 'हिंदी शब्द बदलले — तपासा'
        : names.mrPhonetic.length ? `तपासा: ${names.mrPhonetic.join(', ')}` : 'सुचवलेले';
    }
    if (next.name_eng) {
      sug.add('name_eng');
      h.name_eng = names.engPhonetic.length ? `check: ${names.engPhonetic.join(', ')}` : 'suggested';
    }
    mark('brand', r.source.brand, conf('brand') < LOW_CONFIDENCE);
    mark('net_qty', r.source.net_qty, conf('net_qty') < LOW_CONFIDENCE);
    mark('mrp', r.source.mrp, conf('mrp') < LOW_CONFIDENCE);
    if (sug.has('mrp')) { sug.add('price'); h.price = 'MRP वरून'; }
    mark('expiry_date', r.source.expiry_date, conf('expiry_date') < LOW_CONFIDENCE);
    mark('mfg_date', r.source.mfg_date, conf('mfg_date') < LOW_CONFIDENCE);
    if (next.barcode && !r.barcodeVerified) { sug.add('barcode'); h.barcode = '⚠ बारकोड तपासा (checksum जुळला नाही)'; }
    else mark('barcode', r.source.barcode, conf('barcode') < LOW_CONFIDENCE);

    setForm(next);
    setSuggested(sug);
    setHints(h);
    setAutoNames({ name_eng: names.name_eng, name_marathi: names.name_marathi });
    setKeyTouched(false);
    setBigPhoto(null);
    setScan(r);
  };
  const openResultRef = useRef(openResult);
  useEffect(() => { openResultRef.current = openResult; });

  // Results from the native scanner (see androidScan.ts)
  useEffect(() => {
    const unsubscribe = onProductScan(result => { if (result) openResultRef.current(result); });
    // A scan that finished while Android restarted the app (low memory)
    const pending = takePendingScanResult();
    const t = pending ? setTimeout(() => openResultRef.current(pending)) : undefined;
    return () => { unsubscribe(); if (t) clearTimeout(t); };
  }, []);

  const duplicate = useMemo(
    () => (scan ? findDuplicate(
      { barcode: form.barcode, name_eng: form.name_eng, name_marathi: form.name_marathi, net_qty: form.net_qty },
      inventory,
    ) : null),
    [scan, form.barcode, form.name_eng, form.name_marathi, form.net_qty, inventory],
  );

  if (!scan) return null;

  // ── Editing ────────────────────────────────────────────────────────────────
  const set = (k: FieldKey, v: string) => {
    setForm(f => ({ ...f, [k]: v }));
    if (suggested.has(k)) {
      setSuggested(s => { const n = new Set(s); n.delete(k); return n; });
      setHints(h => ({ ...h, [k]: undefined }));
    }
    if (k === 'mrp' && (!form.price || form.price === form.mrp)) setForm(f => ({ ...f, price: v }));
  };

  // When one name is edited and the other is still an untouched suggestion (or empty), re-fill the other.
  const refillOther = (edited: 'name_eng' | 'name_marathi') => {
    const other = edited === 'name_eng' ? 'name_marathi' : 'name_eng';
    const src = form[edited].trim();
    if (!src || (form[other] && !suggested.has(other))) return;
    const t = edited === 'name_eng' ? englishToMarathi(src, maps) : marathiToEnglish(src, maps);
    setForm(f => ({ ...f, [other]: t.text }));
    setSuggested(s => new Set(s).add(other));
    setHints(h => ({
      ...h,
      [other]: t.phoneticWords.length ? `तपासा: ${t.phoneticWords.join(', ')}` : 'सुचवलेले',
    }));
  };

  const searchKey = keyTouched ? form.search_key : makeSearchKey(form.name_eng, form.name_marathi);
  const price = Number(form.price);
  const barcodeDup = duplicate?.reason === 'barcode';
  const canSave = !!form.name_marathi.trim() && !!form.name_eng.trim() && price > 0 && !barcodeDup && !saving;

  const close = () => { setScan(null); setBatchCount(0); };

  const save = async (addNext: boolean) => {
    if (!canSave) return;
    setSaving(true);
    const stock = Number(form.stock) || 0;
    const nameMr = form.name_marathi.trim();
    const nameEn = form.name_eng.trim();
    // No undefined values: Firestore rejects them.
    const item: InventoryItem = {
      id: `INV-${Date.now()}`,
      name: nameMr || nameEn,
      name_marathi: nameMr,
      name_eng: nameEn,
      search_key: searchKey,
      unit: form.unit || 'pcs',
      price,
      purchase_price: Number(form.mrp) || 0,
      stock_quantity: stock,
      stock_qty: stock,
      barcode: form.barcode.trim(),
      ...(form.brand.trim() ? { brand: form.brand.trim() } : {}),
      ...(form.net_qty.trim() ? { net_qty: form.net_qty.trim() } : {}),
      ...(form.expiry_date ? { expiry_date: form.expiry_date } : {}),
      ...(form.mfg_date ? { mfg_date: form.mfg_date } : {}),
    };
    try {
      await onSave(item);
      const nextLearned = learnFromCorrection(learned, autoNames, { name_eng: nameEn, name_marathi: nameMr });
      if (nextLearned !== learned) {
        setLearned(nextLearned);
        mapsRef.current = { ...mapsRef.current, learned: nextLearned };  // next scan in this batch
        localforage.setItem(LEARNED_KEY, nextLearned).catch(() => {});
      }
      setScan(null);
      if (addNext) { setBatchCount(c => c + 1); startProductScan(); }
      else setBatchCount(0);
    } catch (err) {
      console.error('[PhotoAdd] save failed', err);
      alert('Save failed — please try again.');
    } finally {
      setSaving(false);
    }
  };

  // ── UI ─────────────────────────────────────────────────────────────────────
  const yellow = (k: FieldKey) => suggested.has(k);
  const inputStyle = (k: FieldKey): CSSProperties => ({
    width: '100%', minHeight: 48, fontSize: '1rem',
    ...(yellow(k) ? { background: '#FEF9C3', borderColor: '#EAB308' } : {}),
  });
  const label = (text: string, k?: FieldKey) => (
    <label style={{ fontSize: '0.75rem', fontWeight: 'bold', color: '#6c757d', margin: '10px 0 3px', display: 'block' }}>
      {text}
      {k && hints[k] && <span style={{ color: '#A16207', fontWeight: 'normal', marginLeft: 6 }}>· {hints[k]}</span>}
    </label>
  );
  const nothingRead = !scan.name_eng && !scan.name_marathi && !scan.brand && scan.mrp == null && !scan.barcode;

  return (
    <div className="modal-overlay" style={{ zIndex: 4000 }}>
      <div className="modal-content" style={{ padding: 15, maxHeight: '92vh', overflowY: 'auto' }}>
        <div className="modal-header" style={{ marginBottom: 8, fontSize: '1.05rem' }}>
          <span>📷 फोटोवरून आयटम {batchCount > 0 && <small style={{ color: '#16A34A' }}>({batchCount} सेव्ह)</small>}</span>
          <button style={{ border: 'none', background: 'transparent', fontSize: '1.3rem', minWidth: 48, minHeight: 48, cursor: 'pointer' }}
            onClick={close} aria-label="Close">✕</button>
        </div>

        {(scan.frontPhotoDataUrl || scan.backPhotoDataUrl) && (
          <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
            {[scan.frontPhotoDataUrl, scan.backPhotoDataUrl].map((src, i) => src && (
              <img key={i} src={src} alt={i === 0 ? 'front' : 'back'} onClick={() => setBigPhoto(src)}
                style={{ width: '50%', maxHeight: 120, objectFit: 'cover', borderRadius: 8, border: '1px solid #ddd' }} />
            ))}
          </div>
        )}
        {bigPhoto && (
          <div onClick={() => setBigPhoto(null)}
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.9)', zIndex: 4100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <img src={bigPhoto} alt="" style={{ maxWidth: '100%', maxHeight: '100%' }} />
          </div>
        )}

        {nothingRead && (
          <div style={{ background: '#FEF3C7', color: '#92400E', padding: '8px 10px', borderRadius: 8, fontSize: '0.85rem' }}>
            फोटोवरून काही वाचता आले नाही — कृपया हाताने भरा.
          </div>
        )}
        {scan.offStatus === 'error' && (
          <div style={{ color: '#6c757d', fontSize: '0.75rem', marginTop: 4 }}>Open Food Facts उपलब्ध नाही — फक्त फोटोवरून भरले.</div>
        )}

        {duplicate && (
          <div style={{ background: barcodeDup ? '#FEE2E2' : '#FEF3C7', color: barcodeDup ? '#991B1B' : '#92400E', padding: '8px 10px', borderRadius: 8, marginTop: 8, fontSize: '0.88rem' }}>
            <b>{barcodeDup ? 'Item already exists (same barcode)' : 'Similar item already exists'}:</b>{' '}
            {duplicate.item.name_marathi || duplicate.item.name} {duplicate.item.name_eng ? `· ${duplicate.item.name_eng}` : ''}
            <button onClick={() => { const it = duplicate.item; close(); onOpenExisting(it); }}
              style={{ display: 'block', marginTop: 6, minHeight: 44, padding: '0 14px', border: 'none', borderRadius: 8, background: '#0a3d62', color: 'white', fontWeight: 'bold' }}>
              ✏️ Open existing item
            </button>
          </div>
        )}

        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            {label('मराठी नाव *', 'name_marathi')}
            <input className="edit-input" style={{ ...inputStyle('name_marathi'), fontFamily: '"Noto Sans Devanagari", sans-serif' }}
              value={form.name_marathi} onChange={e => set('name_marathi', e.target.value)} onBlur={() => refillOther('name_marathi')} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            {label('ENGLISH NAME *', 'name_eng')}
            <input className="edit-input" style={inputStyle('name_eng')}
              value={form.name_eng} onChange={e => set('name_eng', e.target.value)} onBlur={() => refillOther('name_eng')} />
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            {label('BRAND', 'brand')}
            <input className="edit-input" style={inputStyle('brand')} value={form.brand} onChange={e => set('brand', e.target.value)} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            {label('NET QTY (250 g)', 'net_qty')}
            <input className="edit-input" style={inputStyle('net_qty')} value={form.net_qty} onChange={e => set('net_qty', e.target.value)} />
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            {label('MRP ₹', 'mrp')}
            <input className="edit-input" type="number" inputMode="decimal" style={inputStyle('mrp')}
              value={form.mrp} onChange={e => set('mrp', e.target.value)} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            {label('SALE RATE ₹ *', 'price')}
            <input className="edit-input" type="number" inputMode="decimal" style={inputStyle('price')}
              value={form.price} onChange={e => set('price', e.target.value)} />
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            {label('STOCK QTY')}
            <input className="edit-input" type="number" inputMode="decimal" style={inputStyle('stock')}
              value={form.stock} onChange={e => set('stock', e.target.value)} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            {label('UNIT')}
            <select className="edit-input" style={inputStyle('unit')} value={form.unit} onChange={e => set('unit', e.target.value)}>
              {['pcs', 'kg', 'pack'].map(u => <option key={u} value={u}>{u}</option>)}
            </select>
          </div>
        </div>

        {label('BARCODE', 'barcode')}
        <input className="edit-input" inputMode="numeric" style={inputStyle('barcode')} value={form.barcode} onChange={e => set('barcode', e.target.value)} />

        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            {label('EXPIRY', 'expiry_date')}
            <input className="edit-input" type="date" style={inputStyle('expiry_date')} value={form.expiry_date} onChange={e => set('expiry_date', e.target.value)} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            {label('MFG / PKD', 'mfg_date')}
            <input className="edit-input" type="date" style={inputStyle('mfg_date')} value={form.mfg_date} onChange={e => set('mfg_date', e.target.value)} />
          </div>
        </div>

        {label('SHORT CODE')}
        <input className="edit-input" style={inputStyle('search_key')} value={searchKey}
          onChange={e => { setKeyTouched(true); setForm(f => ({ ...f, search_key: e.target.value })); }} />

        {!canSave && !saving && (
          <div style={{ color: '#B91C1C', fontSize: '0.78rem', marginTop: 8 }}>
            {barcodeDup ? 'हा बारकोड आधीच आहे — वरील आयटम उघडा.' : 'मराठी नाव, English name आणि Sale rate (> 0) आवश्यक.'}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button disabled={!canSave} onClick={() => save(false)}
            style={{ flex: 1, minHeight: 52, border: 'none', borderRadius: 10, fontWeight: 'bold', fontSize: '1rem', color: 'white', background: canSave ? '#16A34A' : '#9CA3AF' }}>
            {saving ? '...' : '✅ Save'}
          </button>
          <button disabled={!canSave} onClick={() => save(true)}
            style={{ flex: 1, minHeight: 52, border: 'none', borderRadius: 10, fontWeight: 'bold', fontSize: '0.95rem', color: 'white', background: canSave ? '#0a3d62' : '#9CA3AF' }}>
            📷 Save & Add Next
          </button>
        </div>
        <button onClick={close}
          style={{ width: '100%', minHeight: 48, marginTop: 8, border: '1px solid #ccc', borderRadius: 10, background: 'white', fontWeight: 'bold' }}>
          Cancel
        </button>
      </div>
    </div>
  );
}
