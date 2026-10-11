// Camera fill for the Add / Edit Inventory Item popup (Android app only).
// The popup keeps its own state and save path; this hook only fills empty fields, tracks which ones are
// auto-filled (yellow), checks duplicates and remembers name corrections after a save.
import { useEffect, useMemo, useRef, useState, type CSSProperties, type Dispatch, type SetStateAction } from 'react';
import localforage from 'localforage';
import {
  formatScanDetails, isAndroidScanAvailable, onProductScan, startProductScan, takePendingScanResult,
  type ProductScanResult,
} from './androidScan';
import { buildInventoryWordMap, findDuplicate, learnFromCorrection, type NameMaps, type WordMap } from './itemNames';
import { fillItemFromScan, scanReadNothing, type FillableItem, type FillField } from './photoFill';

const LEARNED_KEY = 'photo_name_map';
const YELLOW: CSSProperties = { background: '#FEF9C3' };

interface Session {
  forId: string | null;          // popup item this scan belongs to
  busy: boolean;
  filled: ReadonlySet<string>;   // auto-filled, still unedited → yellow
  touched: ReadonlySet<string>;  // edited by the user in this popup → never filled
  result: ProductScanResult | null;
  autoNames: { name_eng: string; name_marathi: string } | null;
  notice: string;
}
const EMPTY: Session = { forId: null, busy: false, filled: new Set(), touched: new Set(), result: null, autoNames: null, notice: '' };

interface Options<T extends FillableItem> {
  item: T | null;
  setItem: Dispatch<SetStateAction<T | null>>;
  inventory: T[];
  /** a blank new item, used when a scan result arrives with the popup closed (app restarted) */
  newItem: () => T;
}

export function usePhotoScanFill<T extends FillableItem>({ item, setItem, inventory, newItem }: Options<T>) {
  const [session, setSession] = useState<Session>(EMPTY);
  const [learned, setLearned] = useState<WordMap>({});
  const inventoryMap = useMemo(() => buildInventoryWordMap(inventory), [inventory]);

  // Session state belongs to one popup item; a different item starts clean (no effect needed).
  // Popup closed without saving → forget the scan, so reopening the same item is not yellow.
  if (!item && session.forId !== null && !session.busy) setSession(EMPTY);
  const s = item && session.forId === item.id ? session : EMPTY;
  const isNew = !!item && !inventory.some(i => i.id === item.id);

  // Latest values for the native callback, which arrives outside React's render cycle
  const latest = useRef({ item, inventory, newItem, session, maps: { learned, inventory: inventoryMap } as NameMaps });
  useEffect(() => {
    latest.current = { item, inventory, newItem, session, maps: { learned, inventory: inventoryMap } };
  });

  useEffect(() => {
    localforage.getItem<WordMap>(LEARNED_KEY).then(m => { if (m) setLearned(m); }).catch(() => {});
  }, []);

  useEffect(() => {
    const apply = (result: ProductScanResult | null) => {
      const L = latest.current;
      if (!result) { setSession(p => ({ ...p, busy: false })); return; }   // camera cancelled
      const cur = L.item ?? L.newItem();
      const curIsNew = !L.inventory.some(i => i.id === cur.id);
      const prev = L.session.forId === cur.id ? L.session : EMPTY;
      const out = fillItemFromScan(cur, { isNew: curIsNew, touched: prev.touched }, result, L.maps);
      setItem(out.item);
      const notice = result.debug?.error ? 'स्कॅन अयशस्वी — रकाने हाताने भरा.'
        : scanReadNothing(result) ? 'फोटोवरून काही वाचता आले नाही — रकाने हाताने भरा.'
        : out.filled.length === 0 ? 'रिकामे रकाने नव्हते — काहीही बदलले नाही.'
        : result.offStatus === 'error' ? 'इंटरनेट / Open Food Facts उपलब्ध नाही — फक्त फोटोवरून भरले.'
        : '';
      setSession({
        forId: cur.id, busy: false, notice, result,
        filled: new Set([...prev.filled, ...out.filled]),
        touched: prev.touched,
        autoNames: out.filled.includes('name') ? out.autoNames : prev.autoNames,
      });
    };
    const unsubscribe = onProductScan(apply);
    // A scan that finished while Android restarted the app (low memory)
    const pending = takePendingScanResult();
    const t = pending ? setTimeout(() => apply(pending)) : undefined;
    return () => { unsubscribe(); if (t) clearTimeout(t); };
  }, [setItem]);

  const duplicate = useMemo(() => {
    if (!item || !s.result) return null;   // only after a scan in this popup
    return findDuplicate(item, inventory.filter(i => i.id !== item.id));
  }, [item, inventory, s.result]);

  return {
    available: isAndroidScanAvailable(),
    busy: s.busy,
    notice: s.notice,
    duplicate,
    /** new item whose scanned barcode already belongs to another item */
    blockSave: isNew && duplicate?.reason === 'barcode',
    debugText: s.result ? formatScanDetails(s.result) : '',

    start: () => {
      if (!item) return;
      setSession({ ...s, forId: item.id, busy: true, notice: '' });
      if (!startProductScan()) setSession(p => ({ ...p, busy: false }));
    },

    /** call from the field's onChange: stops yellow and protects the value from later scans */
    edited: (field: FillField) => {
      if (!item) return;
      setSession(p => {
        const base = p.forId === item.id ? p : { ...EMPTY, forId: item.id };
        if (base.touched.has(field) && !base.filled.has(field)) return base;
        const filled = new Set(base.filled); filled.delete(field);
        if (field === 'name') filled.delete('name_eng');
        return { ...base, filled, touched: new Set(base.touched).add(field) };
      });
    },

    /** yellow background for an auto-filled field (merge into the input's style) */
    hl: (field: FillField): CSSProperties => (s.filled.has(field) ? YELLOW : {}),

    /** after a successful save: remember corrected word pairs (local only) */
    onSaved: (saved: { name_eng?: string; name_marathi?: string; name: string }) => {
      if (s.autoNames) {
        const next = learnFromCorrection(learned, s.autoNames,
          { name_eng: saved.name_eng || '', name_marathi: saved.name_marathi || saved.name || '' });
        if (next !== learned) {
          setLearned(next);
          localforage.setItem(LEARNED_KEY, next).catch(() => {});
        }
      }
      setSession(EMPTY);
    },
  };
}

export type PhotoScanFill = ReturnType<typeof usePhotoScanFill>;
