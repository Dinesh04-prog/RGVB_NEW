// Excel export → import round trip: every item detail and the picture must come back unchanged.
// Run: npm run test:excel
import * as XLSX from 'xlsx';
import { inventoryToXlsx, rowToItem } from '../src/lib/inventoryExcel';
import { IMAGE_MAX_CHARS } from '../src/lib/itemImage';
import type { InventoryItem } from '../src/lib/firebase';

let failures = 0;
const check = (label: string, ok: boolean, detail = '') => {
  if (!ok) { failures++; console.error(`FAIL ${label}${detail ? `: ${detail}` : ''}`); }
  else console.log(`ok   ${label}`);
};

// Largest picture allowed (25 KB data URL), base64 characters only
const prefix = 'data:image/jpeg;base64,';
const b64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
let body = '';
while (prefix.length + body.length < IMAGE_MAX_CHARS) body += b64[body.length % 64];
const bigImage = prefix + body;

const full: InventoryItem = {
  id: 'GVB-001', name: 'पारले-जी बिस्किट २५० ग्रॅम', name_marathi: 'पारले-जी बिस्किट २५० ग्रॅम', name_eng: 'parle-g biscuit 250g',
  search_key: 'parlपारले', unit: 'pcs', price: 20, purchase_price: 18.5, stock_quantity: 12,
  brand: 'Parle-G', barcode: '0890171910103', net_qty: '250 g', expiry_date: '2026-12-31', mfg_date: '2026-06-01',
  full_name_eng: 'parle-g original gluco biscuits 250g', unit_rates: { '250g': 20, box: 450 }, image: bigImage,
};
const plain: InventoryItem = { id: 'GVB-002', name: 'साखर', name_marathi: 'साखर', name_eng: 'sugar', unit: 'kg', price: 44, purchase_price: 40, stock_quantity: 0 };

const bytes = inventoryToXlsx(XLSX, [full, plain]);
const wb = XLSX.read(new Uint8Array(bytes), { type: 'array' });
const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[wb.SheetNames[0]]);
const back = rows.map((r, i) => rowToItem(r, i));

check('two rows', back.length === 2);
const a = back[0];
for (const k of Object.keys(full) as (keyof InventoryItem)[]) {
  if (k === 'image') continue;
  check(`full item: ${k}`, JSON.stringify(a[k]) === JSON.stringify(full[k]), `${JSON.stringify(a[k])} != ${JSON.stringify(full[k])}`);
}
check('picture of 25 KB comes back exactly', a.image === bigImage, `length ${a.image?.length} vs ${bigImage.length}`);
check('barcode keeps its leading zero', a.barcode === '0890171910103');

const p = back[1];
check('item without details: no empty keys (Firestore rejects undefined)',
  !['brand', 'barcode', 'net_qty', 'expiry_date', 'mfg_date', 'full_name_eng', 'unit_rates', 'image'].some(k => k in p),
  Object.keys(p).join(','));
check('item without details: basics', p.name_marathi === 'साखर' && p.price === 44 && p.purchase_price === 40 && p.stock_quantity === 0);

// An old file (original columns only) still loads
const old = rowToItem({ SKU_ID: 'X1', Marathi_Name: 'तांदूळ', English_Name: 'rice', Weight_Volume: 'kg', Selling_Price_INR: 60, Purchase_Price_INR: 55, Stock_Quantity: 5 }, 0);
check('old file columns', old.id === 'X1' && old.name === 'तांदूळ' && old.price === 60 && !('image' in old));
// A cell that is not a picture is ignored
check('non-picture text in Image column ignored', !('image' in rowToItem({ SKU_ID: 'X2', Marathi_Name: 'a', Image: 'hello' }, 0)));

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('All Excel round-trip checks passed');
