// Inventory ⇄ Excel, shared by the cashier app and the Owner app (export, auto-sync and import).
// The file holds every item detail, including the picture, so a lost inventory can be restored from it:
// Inventory → LOAD EXCEL → choose the exported file.
//
// The picture goes in the "Image" column as text (the same JPEG data URL stored in Firestore, ≤ 25 KB,
// under Excel's 32,767-character cell limit). Excel shows it as a long text, not as a picture.
// Older files without the new columns still load: missing columns simply leave those details empty.
import type { InventoryItem } from './firebase';
import { IMAGE_MAX_CHARS, isOverCap, recompressImage } from './itemImage';

type XLSXModule = typeof import('xlsx');
type Row = Record<string, unknown>;

/** Excel's hard limit for one cell. */
const EXCEL_CELL_MAX = 32767;

/** One item → one Excel row. Column names before Search_key are the original ones (unchanged). */
export const itemToRow = (i: InventoryItem): Row => ({
  SKU_ID: i.id,
  Item_Name: i.name,
  Marathi_Name: i.name_marathi || '',
  English_Name: i.name_eng || '',
  Weight_Volume: i.unit,
  Selling_Price_INR: i.price,
  Purchase_Price_INR: i.purchase_price || 0,
  Stock_Quantity: i.stock_quantity ?? i.stock_qty ?? 0,
  Search_key: i.search_key || '',
  Brand: i.brand || '',
  Barcode: i.barcode || '',
  Pack_Size: i.net_qty || '',
  Expiry_Date: i.expiry_date || '',
  Mfg_Date: i.mfg_date || '',
  Full_Name_Eng: i.full_name_eng || '',
  Unit_Rates: i.unit_rates && Object.keys(i.unit_rates).length ? JSON.stringify(i.unit_rates) : '',
  // Last column: long text, kept out of the way
  Image: i.image && i.image.length <= EXCEL_CELL_MAX ? i.image : '',
});

/** Inventory → .xlsx bytes. */
export const inventoryToXlsx = (XLSX: XLSXModule, items: InventoryItem[]): ArrayBuffer => {
  const ws = XLSX.utils.json_to_sheet(items.map(itemToRow));
  // Readable widths; the Image column stays narrow so the sheet is not one long picture text
  ws['!cols'] = [12, 24, 24, 24, 10, 10, 10, 10, 12, 14, 16, 10, 12, 12, 30, 16, 12].map(wch => ({ wch }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Inventory');
  return XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
};

const text = (v: unknown) => (v == null ? '' : String(v).trim());
const first = (row: Row, keys: string[]) => {
  for (const k of keys) { const v = text(row[k]); if (v) return v; }
  return '';
};

/** One Excel row → item. Optional details are only set when the cell has a value (Firestore rejects undefined). */
export const rowToItem = (row: Row, i: number): InventoryItem => {
  const item: InventoryItem = {
    id: first(row, ['SKU_ID', 'Item_ID', 'id']) || `UPLOAD-${i}`,
    name: first(row, ['Marathi_Name', 'Item_Name', 'name', 'English_Name', 'Name']) || `Item ${i}`,
    name_marathi: first(row, ['Marathi_Name', 'Item_Name_Marathi', 'name_marathi']),
    name_eng: first(row, ['English_Name', 'Item_Name_Eng', 'name_eng']),
    search_key: first(row, ['Search_key', 'search_key', 'SearchKey']),
    unit: first(row, ['Weight_Volume', 'Unit', 'unit']) || 'unit',
    price: Number(first(row, ['Selling_Price_INR', 'Selling_Price', 'price', 'Price', 'Sale_Rate']) || 0),
    purchase_price: Number(first(row, ['Purchase_Price_INR', 'Purchase_Price', 'purchase_price', 'Purchase_Rate', 'Purchase Rate']) || 0),
    stock_quantity: Number(first(row, ['Stock_Quantity', 'stock_qty', 'Quantity']) || 0),
  };
  const opt: [keyof InventoryItem, string[]][] = [
    ['brand', ['Brand', 'brand']],
    ['barcode', ['Barcode', 'barcode']],
    ['net_qty', ['Pack_Size', 'net_qty']],
    ['expiry_date', ['Expiry_Date', 'expiry_date']],
    ['mfg_date', ['Mfg_Date', 'mfg_date']],
    ['full_name_eng', ['Full_Name_Eng', 'full_name_eng']],
  ];
  for (const [key, cols] of opt) {
    const v = first(row, cols);
    if (v) (item as unknown as Row)[key] = v;
  }
  const rates = first(row, ['Unit_Rates', 'unit_rates']);
  if (rates) {
    try {
      const parsed = JSON.parse(rates) as Record<string, unknown>;
      const clean = Object.fromEntries(Object.entries(parsed).filter(([, n]) => Number.isFinite(Number(n))).map(([u, n]) => [u, Number(n)]));
      if (Object.keys(clean).length) item.unit_rates = clean;
    } catch { /* not JSON: ignored */ }
  }
  const image = first(row, ['Image', 'image']);
  if (image.startsWith('data:image/')) item.image = image;
  return item;
};

/**
 * Pictures from a file that are over the 25 KB cap (edited elsewhere) are recompressed; unreadable ones dropped.
 * Returns how many pictures the items now have.
 */
export const fixImportedImages = async (items: InventoryItem[]): Promise<number> => {
  let count = 0;
  for (const item of items) {
    if (!item.image) continue;
    if (isOverCap(item.image)) {
      try { item.image = await recompressImage(item.image); }
      catch { delete item.image; continue; }
    }
    if (item.image.length <= IMAGE_MAX_CHARS) count++;
    else delete item.image;
  }
  return count;
};
