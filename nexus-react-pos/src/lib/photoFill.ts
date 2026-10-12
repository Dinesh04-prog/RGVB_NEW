// Fill the Add / Edit Inventory Item popup from a photo scan — pure function, no React, no storage.
//
// Rules:
//  - Only fills fields that are empty and that the user has not typed in this popup.
//    Edit mode: an existing saved value is never overwritten.
//  - The two names are separate fields: English and Marathi are each filled only when that field is empty.
//    `name` follows (Marathi if present, otherwise English).
//  - Names are written in the shop style (lowercase name_eng with size glued, Devanagari units in Marathi).
//  - Stock quantity is never filled (it is not printed on a pack).
//  - Search key is left to the normal save (new items get one generated from the final names);
//    for an existing item without one, it is filled here.

import type { ProductScanResult } from './androidScan';
import {
  itemNameFields, makeSearchKey, normalizeEngName, shortBilingualName, spellFixEnglish, withItemNames, type NameMaps,
} from './itemNames';

export interface FillableItem {
  id: string;
  name: string;
  name_marathi?: string;
  name_eng?: string;
  brand?: string;
  search_key?: string;
  unit: string;
  price: number;
  purchase_price?: number;
  barcode?: string;
  net_qty?: string;
  expiry_date?: string;
  mfg_date?: string;
  full_name_eng?: string;
}

/** Fields the popup shows (yellow when auto-filled) plus hidden item fields. */
export type FillField =
  | 'name_eng' | 'name_marathi' | 'barcode' | 'purchase_price' | 'price' | 'unit'
  | 'full_name_eng' | 'brand' | 'net_qty' | 'expiry_date' | 'mfg_date' | 'search_key';

export interface FillOutcome<T> {
  item: T;
  filled: FillField[];
  /** names as suggested, for learnFromCorrection() after the user edits and saves */
  autoNames: { name_eng: string; name_marathi: string };
  /** the name was a guess (unusual product, or a word that still looks misread): ask the user to check it */
  nameUnsure: boolean;
  /** OCR spelling fixes made with the shop's vocabulary, for the raw details */
  spellChanges: [string, string][];
}

/** The popup's default unit for a new item. */
export const NEW_ITEM_DEFAULT_UNIT = 'kg';

const emptyStr = (v: string | undefined | null) => !v || !v.trim();
const emptyNum = (v: number | undefined | null) => v == null || Number.isNaN(v) || v === 0;

export const fillItemFromScan = <T extends FillableItem>(
  item: T,
  opts: { isNew: boolean; touched: ReadonlySet<string> },
  scan: ProductScanResult,
  maps: NameMaps,
): FillOutcome<T> => {
  let next: T = { ...item };
  const filled: FillField[] = [];
  const free = (f: FillField, isEmpty: boolean) => isEmpty && !opts.touched.has(f);

  // OCR spelling with the shop's own words and the user's past corrections (brand words are fixed on the phone)
  const spell = scan.name_eng && maps.vocab ? spellFixEnglish(scan.name_eng, maps.vocab, maps.learned) : null;
  const productEng = spell ? spell.text : scan.name_eng;

  // Short receipt names (SHORT_NAME_LIMITS), Marathi built word by word from the short English name
  const names = shortBilingualName(
    { brand: scan.brand, productEng, productDev: scan.name_marathi, netQty: scan.net_qty },
    maps,
  );

  // Two separate name fields: each is filled only when it is empty; neither is derived from what the user typed
  const cur = itemNameFields(item);
  const set: { eng?: string; marathi?: string } = {};
  if (names.name_marathi && free('name_marathi', emptyStr(cur.marathi))) { set.marathi = names.name_marathi; filled.push('name_marathi'); }
  if (names.name_eng && free('name_eng', emptyStr(cur.eng))) {
    set.eng = names.name_eng;
    filled.push('name_eng');
    // the long pack name is kept for search and reference
    if (names.full_name_eng && free('full_name_eng', emptyStr(item.full_name_eng))) {
      next.full_name_eng = names.full_name_eng;
      filled.push('full_name_eng');
    }
  }
  if (set.eng !== undefined || set.marathi !== undefined) next = withItemNames(next, set);

  if (scan.brand && free('brand', emptyStr(item.brand))) { next.brand = scan.brand.trim(); filled.push('brand'); }
  if (scan.barcode && free('barcode', emptyStr(item.barcode))) { next.barcode = scan.barcode; filled.push('barcode'); }
  if (scan.mrp != null && scan.mrp > 0 && free('purchase_price', emptyNum(item.purchase_price))) {
    next.purchase_price = scan.mrp;
    filled.push('purchase_price');
  }
  // Selling rate defaults to MRP
  const mrp = next.purchase_price;
  if (mrp && mrp > 0 && free('price', emptyNum(item.price))) { next.price = mrp; filled.push('price'); }

  // Unit: packaged goods are "pcs". A new item still on the popup's default counts as empty.
  const unitEmpty = emptyStr(item.unit) || (opts.isNew && item.unit === NEW_ITEM_DEFAULT_UNIT);
  if (free('unit', unitEmpty) && (scan.unit || 'pcs') !== item.unit) { next.unit = scan.unit || 'pcs'; filled.push('unit'); }

  if (scan.net_qty && free('net_qty', emptyStr(item.net_qty))) { next.net_qty = scan.net_qty; filled.push('net_qty'); }
  if (scan.expiry_date && free('expiry_date', emptyStr(item.expiry_date))) { next.expiry_date = scan.expiry_date; filled.push('expiry_date'); }
  if (scan.mfg_date && free('mfg_date', emptyStr(item.mfg_date))) { next.mfg_date = scan.mfg_date; filled.push('mfg_date'); }

  const final = itemNameFields(next);
  if (!opts.isNew && free('search_key', emptyStr(item.search_key)) && final.eng && (final.marathi || next.name)) {
    next.search_key = makeSearchKey(final.eng, final.marathi || next.name);
    filled.push('search_key');
  }

  const nameFilled = filled.includes('name_eng') || filled.includes('name_marathi');
  return {
    item: next,
    filled,
    autoNames: { name_eng: final.eng, name_marathi: final.marathi },
    nameUnsure: nameFilled && (names.unsure || (scan.confidence?.name_eng ?? 1) < 0.35 || !!spell?.unsure.length),
    spellChanges: spell?.changes ?? [],
  };
};

/** True when the scan produced nothing usable at all. */
export const scanReadNothing = (s: ProductScanResult) =>
  !s.name_eng && !s.name_marathi && !s.brand && s.mrp == null && !s.barcode && !s.net_qty && !s.expiry_date && !s.mfg_date;

// ── Tap-to-pick: one line of recognised text → one field ────────────────────

/**
 * Digit look-alikes inside numbers only: "4S.OO" → "45.00", "2OO g" → "200 g".
 * Words keep their letters: "Rs.45" keeps its s, "1ltr" keeps its l (a look-alike right before a letter starts a word).
 */
export const fixDigits = (s: string) =>
  s.replace(/(?<![A-Za-z])[0-9OoSsIl|]+(?:[.,][0-9OoSsIl|]+)?/g, (m: string, offset: number) => {
    if (!/\d/.test(m)) return m;
    let keep = '';
    let body = m;
    if (/[A-Za-z]/.test(s[offset + m.length] || '')) {
      const tail = /[SsIl|]+$/.exec(body);
      if (tail) { keep = tail[0]; body = body.slice(0, -keep.length); }
    }
    return body.replace(/[Oo]/g, '0').replace(/[Ss]/g, '5').replace(/[Il|]/g, '1') + keep;
  });

/**
 * A price from a tapped line: the number after MRP / ₹ / Rs. Without such a word, only a line holding one lone
 * number counts ("45.00"), never a weight ("200 g") or a phone number. Null when none or outside ₹1–₹10,000.
 */
export const parsePickedPrice = (line: string): number | null => {
  const s = fixDigits(line).replace(/(\d)\s+(?=\d{2,3}\.\d{2}\b)/g, '$1');
  const anchored = /(?:m\.?\s?r\.?\s?p\.?|₹|\brs\.?|\binr)\s*[:.-]?\s*(?:\(?incl[^)]*\)?\s*)?(\d{1,2},\d{3}(?:\.\d{1,2})?|\d{1,5}(?:\.\d{1,2})?)/i.exec(s);
  const numbers = s.match(/\d+(?:[.,]\d+)?/g) || [];
  const lone = numbers.length === 1 && !/\d\s*(?:g|gm|gms|kg|ml|l|ltr)\b/i.test(s)
    ? /(\d{1,5}(?:\.\d{1,2})?)/.exec(s) : null;
  const m = anchored ?? lone;
  if (!m) return null;
  const v = Number(m[1].replace(',', ''));
  return v >= 1 && v <= 10000 ? v : null;
};

/** A pack size from a tapped line ("Net Wt. 2OO g" → "200 g", "1 Ltr" → "1 L"). */
export const parsePickedQty = (line: string): string | null => {
  const m = /(\d+(?:[.,]\d+)?)\s*(kgs?|kilograms?|gms?|grams?|g|mls?|millilitres?|ltrs?|litres?|liters?|lt|l)(?![a-z])/i.exec(fixDigits(line));
  if (!m) return null;
  const n = Number(m[1].replace(',', '.'));
  const u = m[2].toLowerCase();
  const unit = u.startsWith('k') ? 'kg' : u.startsWith('m') ? 'ml' : u.startsWith('g') ? 'g' : 'L';
  if (!(n > 0) || ((unit === 'kg' || unit === 'L') ? n > 50 : n > 50000 || n < 1)) return null;
  return `${n} ${unit}`;
};

/** A barcode from a tapped line: 8, 12 or 13 digits (spaces and O/0 confusions ignored). */
export const parsePickedBarcode = (line: string): string | null => {
  const digits = fixDigits(line).replace(/[^0-9]/g, '');
  return [8, 12, 13].includes(digits.length) ? digits : null;
};

/** An English name from a tapped line, in the shop style. */
export const parsePickedName = (line: string): string | null => {
  const s = normalizeEngName(line.replace(/[®™©]/g, '').replace(/[^\p{L}\p{N}&'\-./ ]/gu, ' '));
  return /[a-z]{2}/.test(s) ? s : null;
};
