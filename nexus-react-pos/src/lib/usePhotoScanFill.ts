// Camera fill for the Add / Edit Inventory Item popup (Android app only).
// The popup keeps its own state and save path; this hook only fills empty fields, tracks which ones are
// auto-filled (yellow), offers alternates (MRP chips, Open Food Facts suggestions, tap-to-pick lines),
// checks duplicates and remembers name corrections after a save.
import { useEffect, useMemo, useRef, useState, type CSSProperties, type Dispatch, type SetStateAction } from 'react';
import localforage from 'localforage';
import {
  formatScanDetails, isAndroidScanAvailable, onProductScan, startProductScan, takePendingScanResult,
  type ProductScanResult,
} from './androidScan';
import {
  buildInventoryWordMap, buildSpellVocab, findDuplicate, itemNameFields, learnDroppedWords, learnFromCorrection,
  learnSpellingFixes, withItemNames, type NameMaps, type WordMap,
} from './itemNames';
import {
  fillItemFromScan, parsePickedBarcode, parsePickedName, parsePickedPrice, parsePickedQty, scanReadNothing,
  type FillableItem, type FillField,
} from './photoFill';

const LEARNED_KEY = 'photo_name_map';
/** Auto-filled, please check: a soft yellow that sits well next to the app's blue and white. */
export const CHECK_YELLOW: CSSProperties = { background: '#FFF9DB', borderColor: '#EBD98A' };

/** Fields a recognised-text line can be sent to. */
export type PickTarget = 'name_eng' | 'purchase_price' | 'net_qty' | 'barcode';

interface Session {
  forId: string | null;          // popup item this scan belongs to
  busy: boolean;
  filled: ReadonlySet<string>;   // auto-filled, still unedited → yellow
  touched: ReadonlySet<string>;  // edited by the user in this popup → never filled
  result: ProductScanResult | null;
  autoNames: { name_eng: string; name_marathi: string } | null;
  notice: string;
  spellChanges: [string, string][];
}
const EMPTY: Session = {
  forId: null, busy: false, filled: new Set(), touched: new Set(), result: null, autoNames: null, notice: '', spellChanges: [],
};

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
  const vocab = useMemo(() => buildSpellVocab(inventory), [inventory]);

  // Session state belongs to one popup item; a different item starts clean (no effect needed).
  // Popup closed without saving → forget the scan, so reopening the same item is not yellow.
  if (!item && session.forId !== null && !session.busy) setSession(EMPTY);
  const s = item && session.forId === item.id ? session : EMPTY;
  const isNew = !!item && !inventory.some(i => i.id === item.id);

  // Latest values for the native callback, which arrives outside React's render cycle
  const maps: NameMaps = { learned, inventory: inventoryMap, vocab };
  const latest = useRef({ item, inventory, newItem, session, maps });
  useEffect(() => {
    latest.current = { item, inventory, newItem, session, maps: { learned, inventory: inventoryMap, vocab } };
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
      const notice = result.debug?.error ? 'The scan failed. Please fill the fields by hand.'
        : scanReadNothing(result) ? 'Nothing could be read from the photos. Please fill the fields by hand.'
        : out.filled.length === 0 ? 'No empty fields to fill, so nothing was changed.'
        : result.offStatus === 'error' ? 'No internet or Open Food Facts is down: filled from the photos only.'
        : out.nameUnsure ? 'Check the name: some words were hard to read or had to be shortened.'
        : '';
      const nameFilled = out.filled.includes('name_eng') || out.filled.includes('name_marathi');
      setSession({
        forId: cur.id, busy: false, notice, result,
        filled: new Set([...prev.filled, ...out.filled]),
        touched: prev.touched,
        autoNames: nameFilled ? out.autoNames : prev.autoNames,
        spellChanges: out.spellChanges,
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
    const names = itemNameFields(item);
    return findDuplicate({ ...item, name_eng: names.eng, name_marathi: names.marathi }, inventory.filter(i => i.id !== item.id));
  }, [item, inventory, s.result]);

  /** Marks a field as the user's choice: no yellow, never filled by a later scan. */
  const markTouched = (fields: FillField[]) => {
    if (!item) return;
    setSession(p => {
      const base = p.forId === item.id ? p : { ...EMPTY, forId: item.id };
      const filled = new Set(base.filled);
      const touched = new Set(base.touched);
      fields.forEach(f => { filled.delete(f); touched.add(f); });
      return { ...base, filled, touched };
    });
  };

  /** Sets MRP; the sale rate follows while it is still the auto-filled MRP. */
  const setMrp = (value: number) => {
    if (!item) return;
    const rateFollows = s.filled.has('price') && !s.touched.has('price');
    setItem({ ...item, purchase_price: value, ...(rateFollows ? { price: value } : {}) });
    markTouched(['purchase_price']);
  };

  const result = s.result;
  const mrpOptions = result && result.mrp != null && result.mrp_alternates?.length
    ? [result.mrp, ...result.mrp_alternates.filter(v => v !== result.mrp)] : [];

  return {
    available: isAndroidScanAvailable(),
    busy: s.busy,
    notice: s.notice,
    warnings: result?.warnings ?? [],
    duplicate,
    /** new item whose scanned barcode already belongs to another item */
    blockSave: isNew && duplicate?.reason === 'barcode',
    debugText: result
      ? formatScanDetails(result) + (s.spellChanges.length
        ? `\n\n--- SPELLING FIXED WITH SHOP WORDS ---\n${s.spellChanges.map(([a, b]) => `${a} → ${b}`).join('\n')}` : '')
      : '',
    /** MRP values read (chosen first) when the photos disagreed; empty when there was only one */
    mrpOptions,
    /** Open Food Facts values that disagree with a weak read: offered, never filled */
    suggestions: result?.suggestions ?? {},
    /** merged OCR lines, for the tap-to-pick list */
    recognised: result?.recognised ?? [],

    start: () => {
      if (!item) return;
      setSession({ ...s, forId: item.id, busy: true, notice: '' });
      if (!startProductScan()) setSession(p => ({ ...p, busy: false }));
    },

    /** call from the field's onChange: stops yellow and protects the value from later scans */
    edited: (field: FillField) => {
      if (!item) return;
      if (s.touched.has(field) && !s.filled.has(field)) return;
      markTouched([field]);
    },

    /** yellow background for an auto-filled field (merge into the input's style) */
    hl: (field: FillField): CSSProperties => (s.filled.has(field) ? CHECK_YELLOW : {}),

    chooseMrp: setMrp,

    /** Use an Open Food Facts suggestion. */
    useSuggestion: (field: 'name_eng' | 'brand' | 'net_qty', value: string) => {
      if (!item) return;
      if (field === 'name_eng') setItem(withItemNames(item, { eng: parsePickedName(value) ?? value }));
      else setItem({ ...item, [field]: value });
      markTouched([field]);
    },

    /** Tap-to-pick: put a recognised line into a field. Returns an English message when the line has no such value. */
    pick: (target: PickTarget, line: string): string => {
      if (!item) return '';
      if (target === 'purchase_price') {
        const v = parsePickedPrice(line);
        if (v == null) return 'No price between ₹1 and ₹10,000 in that line.';
        setMrp(v);
        return '';
      }
      if (target === 'name_eng') {
        const v = parsePickedName(line);
        if (!v) return 'No English words in that line.';
        setItem(withItemNames(item, { eng: v }));
      } else if (target === 'net_qty') {
        const v = parsePickedQty(line);
        if (!v) return 'No weight or volume (g, kg, ml, L) in that line.';
        setItem({ ...item, net_qty: v });
      } else {
        const v = parsePickedBarcode(line);
        if (!v) return 'No 8, 12 or 13 digit barcode in that line.';
        setItem({ ...item, barcode: v });
      }
      markTouched([target]);
      return '';
    },

    /** after a successful save: remember corrected word pairs and spellings (local only) */
    onSaved: (saved: { name_eng?: string; name_marathi?: string; name: string }) => {
      if (s.autoNames) {
        const names = itemNameFields(saved);
        const finalNames = { name_eng: names.eng, name_marathi: names.marathi };
        // word pairs the user corrected, words the user removed (dropped next time), English spellings fixed
        let next = learnFromCorrection(learned, s.autoNames, finalNames);
        next = learnDroppedWords(next, s.autoNames, finalNames);
        next = learnSpellingFixes(next, s.autoNames.name_eng, finalNames.name_eng);
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
