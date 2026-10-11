// Fill the Add / Edit Inventory Item popup from a photo scan — pure function, no React, no storage.
//
// Rules:
//  - Only fills fields that are empty and that the user has not typed in this popup.
//    Edit mode: an existing saved value is never overwritten.
//  - Names are written in the shop style (lowercase name_eng with size glued, Devanagari units in Marathi).
//  - Stock quantity is never filled (it is not printed on a pack).
//  - Search key is left to the normal save (new items get one generated from the final names);
//    for an existing item without one, it is filled here.

import type { ProductScanResult } from './androidScan';
import { makeSearchKey, shortBilingualName, type NameMaps } from './itemNames';

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
  | 'name' | 'barcode' | 'purchase_price' | 'price' | 'unit'
  | 'name_eng' | 'full_name_eng' | 'brand' | 'net_qty' | 'expiry_date' | 'mfg_date' | 'search_key';

export interface FillOutcome<T> {
  item: T;
  filled: FillField[];
  /** names as suggested, for learnFromCorrection() after the user edits and saves */
  autoNames: { name_eng: string; name_marathi: string };
  /** the short name was a guess (unusual product): ask the user to check it */
  nameUnsure: boolean;
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
  const next: T = { ...item };
  const filled: FillField[] = [];
  const free = (f: FillField, isEmpty: boolean) => isEmpty && !opts.touched.has(f);

  // Short receipt names (SHORT_NAME_LIMITS), Marathi built word by word from the short English name
  const names = shortBilingualName(
    { brand: scan.brand, productEng: scan.name_eng, productDev: scan.name_marathi, netQty: scan.net_qty },
    maps,
  );
  const nameEng = names.name_eng;
  const nameMr = names.name_marathi;

  // The popup's single name box edits name + name_marathi together
  if (nameMr && free('name', emptyStr(item.name_marathi) && emptyStr(item.name))) {
    next.name_marathi = nameMr;
    next.name = nameMr;
    filled.push('name');
  }
  // English name is hidden in the popup: only add it together with the Marathi name it belongs to,
  // never next to a name the user typed or that was already saved.
  if (nameEng && filled.includes('name') && free('name_eng', emptyStr(item.name_eng))) {
    next.name_eng = nameEng;
    filled.push('name_eng');
    // the long pack name is kept for search and reference
    if (names.full_name_eng && free('full_name_eng', emptyStr(item.full_name_eng))) {
      next.full_name_eng = names.full_name_eng;
      filled.push('full_name_eng');
    }
  }
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

  if (!opts.isNew && free('search_key', emptyStr(item.search_key)) && next.name_eng && (next.name_marathi || next.name)) {
    next.search_key = makeSearchKey(next.name_eng, next.name_marathi || next.name);
    filled.push('search_key');
  }

  return {
    item: next,
    filled,
    autoNames: { name_eng: next.name_eng || '', name_marathi: next.name_marathi || next.name || '' },
    nameUnsure: filled.includes('name') && names.unsure,
  };
};

/** True when the scan produced nothing usable at all. */
export const scanReadNothing = (s: ProductScanResult) =>
  !s.name_eng && !s.name_marathi && !s.brand && s.mrp == null && !s.barcode && !s.net_qty && !s.expiry_date && !s.mfg_date;
