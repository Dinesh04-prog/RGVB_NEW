// Plain assertion checks for src/lib/itemNames.ts — no test framework.
// Run: npm run test:names   (bundles with rolldown, then runs on Node)
import { readFileSync } from 'node:fs';
import {
  makeSearchKey, qtyEng, qtyMarathi, buildInventoryWordMap, composeNames,
  learnFromCorrection, findDuplicate, marathiToEnglish, englishToMarathi, buildPhotoItem,
  normalizeEngName, normalizeMarathiName, shortBilingualName, printedLength, learnDroppedWords, SHORT_NAME_LIMITS,
  itemNameFields, withItemNames, buildSpellVocab, spellFixEnglish, spellFixWord, osaDistance, learnSpellingFixes,
  type NameMaps,
} from '../src/lib/itemNames';
import { formatScanDetails, type ProductScanResult } from '../src/lib/androidScan';
import {
  fillItemFromScan, scanReadNothing, parsePickedPrice, parsePickedQty, parsePickedBarcode, parsePickedName, fixDigits,
} from '../src/lib/photoFill';

let failures = 0;
const check = (label: string, cond: boolean, detail = '') => {
  if (!cond) { failures++; console.error(`FAIL ${label} ${detail}`); }
};
const eq = (label: string, got: unknown, want: unknown) =>
  check(label, JSON.stringify(got) === JSON.stringify(want), `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);

const inventory = JSON.parse(readFileSync('public/inventory.json', 'utf8')) as
  { id: string; name: string; name_eng: string; name_marathi: string; search_key: string; barcode?: string }[];

// ── search_key convention matches every existing item ───────────────────────
const keyMismatch = inventory.filter(i => makeSearchKey(i.name_eng, i.name_marathi) !== i.search_key);
eq('search_key matches inventory.json', keyMismatch.map(i => i.id), []);
eq('search_key parle-g', makeSearchKey('parle-g original gluco biscuits 250g', 'पारले-जी ओरिजिनल'), 'parl पारल');

// ── Size formatting (shop style) ─────────────────────────────────────────────
eq('qtyEng g', qtyEng('250 g'), '250g');
eq('qtyEng kg', qtyEng('1 kg'), '1kg');
eq('qtyEng L', qtyEng('1 L'), '1l');
eq('qtyMr g', qtyMarathi('250 g'), '२५० ग्रॅम');
eq('qtyMr kg', qtyMarathi('1 kg'), '१ किलो');
eq('qtyMr ml', qtyMarathi('500 ml'), '५०० मिली');
eq('qtyMr bad', qtyMarathi('abc'), '');

// ── Bilingual names: Marathi from English ────────────────────────────────────
const maps: NameMaps = { learned: {}, inventory: buildInventoryWordMap(inventory) };

type Case = { brand: string; product: string; qty: string; ok: string[] };   // ok = acceptable Marathi names
const cases: Case[] = [
  { brand: 'Parle-G', product: 'Original Gluco Biscuits', qty: '250 g', ok: ['पारले-जी ओरिजिनल ग्लुको बिस्किट २५० ग्रॅम'] },
  { brand: 'Tata', product: 'Salt', qty: '1 kg', ok: ['टाटा मीठ १ किलो'] },
  { brand: 'Fortune', product: 'Refined Sunflower Oil', qty: '1 L', ok: ['फॉर्च्यून रिफाइंड सूर्यफूल तेल १ लिटर'] },
  { brand: 'Colgate', product: 'Toothpaste', qty: '200 g', ok: ['कोलगेट टूथपेस्ट २०० ग्रॅम'] },
  { brand: 'Lux', product: 'Soap', qty: '100 g', ok: ['लक्स साबण १०० ग्रॅम'] },
  { brand: 'Red Label', product: 'Tea', qty: '250 g', ok: ['रेड लेबल चहा २५० ग्रॅम'] },
  { brand: '', product: 'Haldi Powder', qty: '100 g', ok: ['हळद पावडर १०० ग्रॅम'] },
  { brand: 'Everest', product: 'Turmeric Powder', qty: '100 g', ok: ['एव्हरेस्ट हळद पावडर १०० ग्रॅम'] },
  { brand: 'MDH', product: 'Garam Masala', qty: '100 g', ok: ['एमडीएच गरम मसाला १०० ग्रॅम'] },
  { brand: 'Amul', product: 'Pure Ghee', qty: '1 L', ok: ['अमूल शुद्ध तूप १ लिटर'] },
  { brand: 'Tata Sampann', product: 'Toor Dal', qty: '1 kg', ok: ['टाटा संपन्न तूर डाळ १ किलो'] },
  { brand: 'Britannia', product: 'Good Day Cashew Cookies', qty: '75 g', ok: ['ब्रिटानिया गुड डे काजू कुकीज ७५ ग्रॅम'] },
  { brand: 'Maggi', product: '2-Minute Noodles', qty: '70 g', ok: ['मॅगी २-मिनिट नूडल्स ७० ग्रॅम', 'मॅगी २ मिनिट नूडल्स ७० ग्रॅम'] },
  { brand: 'Society', product: 'Tea', qty: '250 g', ok: ['सोसायटी चहा २५० ग्रॅम', 'सोसायटी २५० ग्रॅम'] },
  { brand: 'Wagh Bakri', product: 'Premium Leaf Tea', qty: '500 g', ok: ['वाघ बकरी प्रीमियम लीफ चहा ५०० ग्रॅम'] },
  { brand: 'Vim', product: 'Lemon Dishwash Bar', qty: '155 g', ok: ['विम लिंबू डिशवॉश बार १५५ ग्रॅम'] },
  { brand: 'Haldiram\'s', product: 'Aloo Bhujia', qty: '150 g', ok: ['हल्दीराम आलू भुजिया १५० ग्रॅम'] },
  { brand: 'Clinic Plus', product: 'Strength & Shine Shampoo', qty: '6 ml', ok: ['क्लिनिक प्लस स्ट्रेंथ अँड शाइन शॅम्पू ६ मिली'] },
  { brand: 'Sunfeast', product: 'Marie Light', qty: '150 g', ok: ['सनफीस्ट मारी लाइट १५० ग्रॅम'] },
  { brand: 'Gokul', product: 'Jeera Powder', qty: '100 g', ok: ['गोकुळ जिरे पावडर १०० ग्रॅम'] },
  { brand: 'Kurkure', product: 'Masala Munch', qty: '30 g', ok: ['कुरकुरे मसाला मंच ३० ग्रॅम'] },
  { brand: 'Medimix', product: 'Classic Ayurvedic Soap', qty: '125 g', ok: ['मेडिमिक्स क्लासिक आयुर्वेदिक साबण १२५ ग्रॅम'] },
];

let correct = 0;
console.log('\nBilingual names (Marathi from English)');
console.log('result  | name_eng | name_marathi | words to check');
for (const c of cases) {
  const r = composeNames({ brand: c.brand, productEng: c.product, netQty: c.qty }, maps);
  const good = c.ok.includes(r.name_marathi);
  if (good) correct++;
  console.log(`${good ? 'ok     ' : 'FIX    '} | ${r.name_eng} | ${r.name_marathi} | ${r.mrPhonetic.join(', ')}${good ? '' : `   (want ${c.ok[0]})`}`);
}
console.log(`Marathi correct/acceptable: ${correct}/${cases.length}\n`);
check('bilingual accuracy floor', correct >= 20, `${correct}/${cases.length}`);

// Name_eng follows shop style: lowercase, brand inside, size glued
eq('name_eng style', composeNames({ brand: 'Parle-G', productEng: 'Parle-G Original Gluco Biscuits', netQty: '250 g' }, maps).name_eng,
  'parle-g original gluco biscuits 250g');

// ── OCR Devanagari: Hindi respelled to Marathi, English from reverse lookup ──
const hi = composeNames({ brand: 'Tata', productDev: 'नमक', netQty: '1 kg' }, maps);
eq('hindi → marathi', hi.name_marathi, 'टाटा मीठ १ किलो');
eq('hindi flagged', hi.mrFromHindi, true);
eq('english from marathi', hi.name_eng, 'tata meet 1kg');
const devOnly = marathiToEnglish('तूर डाळ', maps);
check('english from marathi (inventory/dictionary)', /^(toor|tur) (dal|daal)$/.test(devOnly.text), devOnly.text);
eq('brand-only OCR ignored', composeNames({ brand: 'Amul', productEng: 'Pure Ghee', productDev: 'अमूल' }, maps).name_marathi, 'अमूल शुद्ध तूप');

// Re-translating a full edited name keeps the size in shop style both ways
eq('eng name → marathi with size', englishToMarathi('parle-g biscuits 250g', maps).text, 'पारले-जी बिस्किट २५० ग्रॅम');
const back = marathiToEnglish('रेड लेबल २५० ग्रॅम', maps).text;
check('marathi name → english with size', /^red (label|lebal) 250g$/.test(back), back);

// ── Learning from corrections ────────────────────────────────────────────────
const learned = learnFromCorrection({},
  { name_eng: 'parle-g biscuits 250g', name_marathi: 'परले-ग बिस्किट २५० ग्रॅम' },
  { name_eng: 'parle-g biscuits 250g', name_marathi: 'पारले-जी बिस्किट २५० ग्रॅम' });
eq('learned word', learned['parle-g'], 'पारले-जी');
eq('learned phrase', learned['parle-g biscuits'], 'पारले-जी बिस्किट');
const maps2: NameMaps = { learned: { sunlite: 'सनलाइट' }, inventory: maps.inventory };
eq('learned word reused', composeNames({ brand: 'Fortune', productEng: 'Sunlite Oil', netQty: '1 L' }, maps2).name_marathi,
  'फॉर्च्यून सनलाइट तेल १ लिटर');
eq('no edit → map unchanged', learnFromCorrection({ a: 'b' }, { name_eng: 'x', name_marathi: 'य' }, { name_eng: 'x', name_marathi: 'य' }), { a: 'b' });

// ── Duplicates ───────────────────────────────────────────────────────────────
const inv = [
  { id: 'A', barcode: '8901719101038', name_eng: 'parle-g biscuits 250g', name_marathi: 'पारले-जी बिस्किट २५० ग्रॅम' },
  { id: 'B', name_eng: 'society 250g', name_marathi: 'सोसायटी २५० ग्रॅम' },
  { id: 'C', name_eng: 'tata salt 1kg', name_marathi: 'टाटा मीठ १ किलो', net_qty: '1 kg' },
];
eq('dup by barcode', findDuplicate({ barcode: '8901719101038' }, inv)?.item.id, 'A');
eq('dup by name + size (old item without net_qty)', findDuplicate({ name_eng: 'society 250g', net_qty: '250 g' }, inv)?.item.id, 'B');
eq('dup by marathi name + size', findDuplicate({ name_marathi: 'टाटा मीठ १ किलो', net_qty: '1 kg' }, inv)?.item.id, 'C');
eq('different size is not dup', findDuplicate({ name_eng: 'tata salt 1kg', net_qty: '500 g' }, inv), null);

// ── Product-name phrases win over literal word translation ──────────────────
eq('phrase aloo bhujia', englishToMarathi('aloo bhujia', maps).text, 'आलू भुजिया');
eq('phrase dairy milk', englishToMarathi('cadbury dairy milk', maps).text, 'कॅडबरी डेअरी मिल्क');
eq('phrase milk bikis', englishToMarathi('britannia milk bikis', maps).text, 'ब्रिटानिया मिल्क बिकीस');
eq('phrase pav bhaji masala', englishToMarathi('everest pav bhaji masala', maps).text, 'एव्हरेस्ट पावभाजी मसाला');
eq('plain milk still translated', englishToMarathi('milk', maps).text, 'दूध');

// ── Saved objects use the shop style ─────────────────────────────────────────
const formFor = (brand: string, product: string, qty: string, mrp: string, barcode = '') => {
  const n = composeNames({ brand, productEng: product, netQty: qty }, maps);
  return {
    name_marathi: n.name_marathi, name_eng: n.name_eng, brand, unit: 'pcs', net_qty: qty,
    mrp, price: mrp, stock: '12', barcode, expiry_date: '2026-07-12', mfg_date: '2026-01-12',
  };
};
const samplesSaved = [
  buildPhotoItem(formFor('Parle-G', 'Original Gluco Biscuits', '250 g', '10', '8901719101038'), 'INV-1760000000001'),
  buildPhotoItem(formFor('Tata', 'Salt', '1 kg', '28'), 'INV-1760000000002'),
  buildPhotoItem(formFor('Fortune', 'Refined Sunflower Oil', '1 L', '185'), 'INV-1760000000003'),
];
console.log('Sample saved objects:\n' + samplesSaved.map(o => JSON.stringify(o, null, 2)).join('\n'));
for (const o of samplesSaved) {
  check(`saved ${o.id} name_eng lowercase + size glued`, o.name_eng === o.name_eng.toLowerCase() && /\d(g|kg|ml|l)$/.test(o.name_eng), o.name_eng);
  check(`saved ${o.id} name = name_marathi, Devanagari size`, o.name === o.name_marathi && /[०-९]+ (ग्रॅम|किलो|मिली|लिटर)$/.test(o.name_marathi), o.name_marathi);
  check(`saved ${o.id} brand kept`, !!o.brand && o.name_eng.startsWith(o.brand.toLowerCase()), String(o.brand));
  check(`saved ${o.id} search_key convention`, o.search_key === makeSearchKey(o.name_eng, o.name_marathi), o.search_key);
  check(`saved ${o.id} no undefined`, !Object.values(o).some(v => v === undefined));
}
// ── Strict saved-name checks: exact strings, no lost characters or glued words ──
const DEV_BRAND: Record<string, string[]> = {
  'parle-g': ['पारले-जी'], tata: ['टाटा'], fortune: ['फॉर्च्यून', 'फर्च्यून'], 'red label': ['रेड लेबल'], colgate: ['कोलगेट'],
};
const strict: { brand: string; product: string; qty: string; eng: string; mr: string }[] = [
  { brand: 'Parle-G', product: 'Original Gluco Biscuits', qty: '250 g', eng: 'parle-g original gluco biscuits 250g', mr: 'पारले-जी ओरिजिनल ग्लुको बिस्किट २५० ग्रॅम' },
  { brand: 'Tata', product: 'Salt', qty: '1 kg', eng: 'tata salt 1kg', mr: 'टाटा मीठ १ किलो' },
  { brand: 'Fortune', product: 'Refined Sunflower Oil', qty: '1 L', eng: 'fortune refined sunflower oil 1l', mr: 'फॉर्च्यून रिफाइंड सूर्यफूल तेल १ लिटर' },
  { brand: 'Red Label', product: 'Tea', qty: '250 g', eng: 'red label tea 250g', mr: 'रेड लेबल चहा २५० ग्रॅम' },
  { brand: 'Colgate', product: 'Strong Teeth Toothpaste', qty: '200 g', eng: 'colgate strong teeth toothpaste 200g', mr: 'कोलगेट स्ट्राँग टीथ टूथपेस्ट २०० ग्रॅम' },
  // brand already inside the product name, and brand twice → still exactly one brand
  { brand: 'Tata', product: 'Tata Salt', qty: '1 kg', eng: 'tata salt 1kg', mr: 'टाटा मीठ १ किलो' },
  { brand: 'Parle-G', product: 'Parle-G Original Gluco Biscuits Parle-G', qty: '250 g', eng: 'parle-g original gluco biscuits 250g', mr: 'पारले-जी ओरिजिनल ग्लुको बिस्किट २५० ग्रॅम' },
  { brand: 'Fortune', product: 'FORTUNE refined sunflower oil', qty: '1 L', eng: 'fortune refined sunflower oil 1l', mr: 'फॉर्च्यून रिफाइंड सूर्यफूल तेल १ लिटर' },
];
for (const c of strict) {
  const o = buildPhotoItem(formFor(c.brand, c.product, c.qty, '10'), 'INV-strict');
  const tag = `strict [${c.brand} + ${c.product}]`;
  eq(`${tag} name_eng exact`, o.name_eng, c.eng);
  eq(`${tag} name_marathi exact`, o.name_marathi, c.mr);
  eq(`${tag} name === name_marathi`, o.name, o.name_marathi);
  for (const [field, s] of [['name_eng', o.name_eng], ['name_marathi', o.name_marathi]] as const) {
    check(`${tag} ${field} single spaces, trimmed`, !/\s{2,}|^\s|\s$/.test(s) && !/[\t\u00a0\u200b-\u200d]/.test(s), JSON.stringify(s));
  }
  const brandMr = DEV_BRAND[c.brand.toLowerCase()];
  check(`${tag} whole Marathi brand word`, brandMr.some(b => o.name_marathi.split(' ').slice(0, b.split(' ').length).join(' ') === b), o.name_marathi);
  check(`${tag} brand appears once`, o.name_eng.split(c.brand.toLowerCase()).length === 2, o.name_eng);
  // Generic guard: every word of the cleaned English input is a whole word of name_eng
  const words = `${c.brand} ${c.product}`.toLowerCase().split(/\s+/).filter(Boolean);
  const engWords = new Set(o.name_eng.split(' '));
  for (const w of words) check(`${tag} keeps word "${w}"`, engWords.has(w), o.name_eng);
}

// User-typed names are normalized on save
eq('normalize eng', normalizeEngName('Parle-G  Biscuits 250 G'), 'parle-g biscuits 250g');
eq('normalize eng litre', normalizeEngName('Fortune Oil 1 L'), 'fortune oil 1l');
eq('normalize marathi', normalizeMarathiName('पारले बिस्किट 250 g'), 'पारले बिस्किट २५० ग्रॅम');
eq('normalize marathi kg', normalizeMarathiName('टाटा मीठ 1kg'), 'टाटा मीठ १ किलो');

// ── "Copy details" text (multi-photo result) ─────────────────────────────────
const scanBase: ProductScanResult = {
  name_eng: 'Original Gluco Biscuits', name_marathi: null, brand: 'Parle-G', unit: 'pcs', net_qty: '250 g', mrp: 10,
  barcode: '8901719101038', barcodeVerified: true, mfg_date: '2026-01-12', expiry_date: null,
  confidence: { mrp: 0.95, brand: 0.75 }, source: { mrp: 'mlkit-ocr', brand: 'mlkit-ocr', barcode: 'mlkit-barcode' },
  offStatus: 'skipped', photoCount: 3,
};
const details = formatScanDetails({ ...scanBase, debug: {
  photos: [
    { photo: 1, size: '2048x1536', barcodeMlkit: null, ocrLatin: '[h60] Parle-G', ocrDevanagari: '[h40] पारले-जी' },
    { photo: 2, size: '2048x1536', barcodeMlkit: { value: '8901719101038', format: 'EAN_13', checksumOk: true }, ocrLatin: '[h14] Net Wt. 250g' },
    { photo: 3, size: '2048x1536', barcodeMlkit: null, ocrLatin: '[h22] M.R.P Rs. 1O.OO' },
  ],
  pickedFrom: { mrp: 3, barcode: 2, brand: 1, mfg_date: 0 }, timingsMs: { total: 4200 },
} });
check('details has raw OCR per photo', details.includes('PHOTO 3 · OCR Latin') && details.includes('M.R.P Rs. 1O.OO') && details.includes('पारले-जी'));
check('details has barcode per photo', details.includes('PHOTO 2 (2048x1536) · barcode') && details.includes('EAN_13, checksum ok'));
check('details shows source/conf/photo', details.includes('mrp: 10 · mlkit-ocr · 0.95 · photo 3') && details.includes('mfg_date: 2026-01-12 · - · - · all photos'));
check('details has no image data', !details.includes('base64') && !details.includes('data:image'));
check('details works without debug', formatScanDetails(scanBase).includes('BARCODE USED'));

// ── Filling the Add / Edit popup from a scan ─────────────────────────────────
const blankNew = { id: 'INV-new', name: '', unit: 'kg', price: 0, purchase_price: 0, stock_quantity: 0, barcode: '' };
const scanFull: ProductScanResult = { ...scanBase, expiry_date: '2026-07-12' };
const f1 = fillItemFromScan(blankNew, { isNew: true, touched: new Set() }, scanFull, maps);
eq('new: Marathi name filled (short, shop style)', f1.item.name_marathi, 'पारले-जी ग्लुको बिस्किट २५० ग्रॅम');
eq('new: name = name_marathi', f1.item.name, f1.item.name_marathi);
eq('new: English name filled, short', f1.item.name_eng, 'parle-g gluco biscuit 250g');
eq('new: full pack name kept', f1.item.full_name_eng, 'parle-g original gluco biscuits 250g');
eq('new: brand / barcode / net_qty', [f1.item.brand, f1.item.barcode, f1.item.net_qty], ['Parle-G', '8901719101038', '250 g']);
eq('new: MRP → purchase_price, sale rate defaults to MRP', [f1.item.purchase_price, f1.item.price], [10, 10]);
eq('new: default unit kg → pcs', f1.item.unit, 'pcs');
eq('new: dates', [f1.item.mfg_date, f1.item.expiry_date], ['2026-01-12', '2026-07-12']);
eq('new: stock never filled', f1.item.stock_quantity, 0);
check('new: search_key left to the normal save', !('search_key' in f1.item) || !f1.item.search_key);
check('new: filled list', ['name_marathi', 'name_eng', 'barcode', 'purchase_price', 'price', 'unit'].every(k => f1.filled.includes(k as never)));

// Two separate name fields: each is filled only when it is empty; a saved name is never changed
const existing = { id: 'GVB-099', name: 'पारले बिस्किट', name_marathi: 'पारले बिस्किट', name_eng: '', unit: 'pcs', price: 9, purchase_price: 0, barcode: '', search_key: '' };
const f2 = fillItemFromScan(existing, { isNew: false, touched: new Set() }, scanFull, maps);
eq('edit: saved Marathi name kept', [f2.item.name, f2.item.name_marathi], ['पारले बिस्किट', 'पारले बिस्किट']);
eq('edit: empty English field filled on its own', f2.item.name_eng, 'parle-g gluco biscuit 250g');
eq('edit: saved sale rate kept', f2.item.price, 9);
eq('edit: empty MRP / barcode filled', [f2.item.purchase_price, f2.item.barcode], [10, '8901719101038']);
eq('edit: unit kept', f2.item.unit, 'pcs');
check('edit: Marathi name / price not in filled', !f2.filled.includes('name_marathi') && !f2.filled.includes('price') && f2.filled.includes('name_eng'));
const bothSaved = { ...existing, name_eng: 'parle biscuit' };
const f2b = fillItemFromScan(bothSaved, { isNew: false, touched: new Set() }, scanFull, maps);
eq('edit: both saved names kept', [f2b.item.name_eng, f2b.item.name_marathi, f2b.item.name], ['parle biscuit', 'पारले बिस्किट', 'पारले बिस्किट']);
const engOnly = { ...blankNew, id: 'GVB-100', name: 'sugar', name_eng: 'sugar' };
const f2c = fillItemFromScan(engOnly, { isNew: false, touched: new Set() }, scanFull, maps);
eq('edit: English-only item keeps English, gets Marathi, name becomes Marathi',
  [f2c.item.name_eng, f2c.item.name_marathi, f2c.item.name], ['sugar', 'पारले-जी ग्लुको बिस्किट २५० ग्रॅम', 'पारले-जी ग्लुको बिस्किट २५० ग्रॅम']);

const typed = { ...blankNew, name: 'साखर', name_marathi: 'साखर', barcode: '123' };
const f3 = fillItemFromScan(typed, { isNew: true, touched: new Set(['name_marathi', 'barcode', 'unit']) }, scanFull, maps);
eq('typed values never overwritten', [f3.item.name, f3.item.name_marathi, f3.item.barcode, f3.item.unit], ['साखर', 'साखर', '123', 'kg']);
const typedEng = fillItemFromScan({ ...blankNew, name: '', name_eng: '' }, { isNew: true, touched: new Set(['name_eng']) }, scanFull, maps);
eq('typed (even cleared) English is not filled; Marathi still is', [typedEng.item.name_eng, typedEng.item.name_marathi], ['', 'पारले-जी ग्लुको बिस्किट २५० ग्रॅम']);
const f4 = fillItemFromScan({ ...blankNew, purchase_price: 0 }, { isNew: true, touched: new Set(['purchase_price']) }, scanFull, maps);
eq('touched MRP (even 0) is not filled', f4.item.purchase_price, 0);
const nothing = fillItemFromScan(blankNew, { isNew: true, touched: new Set() },
  { ...scanBase, name_eng: null, brand: null, mrp: null, barcode: null, net_qty: null, mfg_date: null, unit: 'pcs' }, maps);
check('empty scan: popup unchanged except unit', nothing.item.name === '' && nothing.item.barcode === '' && nothing.item.price === 0);
check('scanReadNothing', scanReadNothing({ ...scanBase, name_eng: null, brand: null, mrp: null, barcode: null, net_qty: null, mfg_date: null }));

// ── Short receipt names ──────────────────────────────────────────────────────
// Each row: brand, pack text (may span OCR lines), size, and the name I consider GOOD in English and Marathi.
// Rows where the code gives something else are reported as FIX (need a manual edit), not hidden.
type ShortCase = { brand: string; pack: string; qty: string; eng: string; mr: string; core: string };
const shortCases: ShortCase[] = [
  { brand: '', pack: 'Neomycin Sulphate Cream USP', qty: '10 g', eng: 'neomycin cream 10g', mr: 'निओमायसिन क्रीम १० ग्रॅम', core: 'cream' },
  { brand: 'Parle-G', pack: 'Original Gluco Biscuits', qty: '250 g', eng: 'parle-g gluco biscuit 250g', mr: 'पारले-जी ग्लुको बिस्किट २५० ग्रॅम', core: 'biscuit' },
  { brand: 'Fortune', pack: 'Refined Sunflower Oil', qty: '1 L', eng: 'fortune sunflower oil 1l', mr: 'फॉर्च्यून सूर्यफूल तेल १ लिटर', core: 'oil' },
  { brand: 'Colgate', pack: 'Strong Teeth Anticavity Toothpaste', qty: '200 g', eng: 'colgate strong teeth 200g', mr: 'कोलगेट स्ट्राँग टीथ २०० ग्रॅम', core: 'colgate' },
  { brand: 'Tata', pack: 'Salt Vacuum Evaporated Iodised Salt', qty: '1 kg', eng: 'tata salt 1kg', mr: 'टाटा मीठ १ किलो', core: 'salt' },
  { brand: 'Britannia', pack: 'BRITANNIA\nGood Day\nCashew Cookies', qty: '75 g', eng: 'good day cashew cookie 75g', mr: 'गुड डे काजू कुकी ७५ ग्रॅम', core: 'cookie' },
  { brand: 'Sunfeast', pack: 'Marie Light Oats', qty: '150 g', eng: 'sunfeast marie oats 150g', mr: 'सनफीस्ट मारी ओट्स १५० ग्रॅम', core: 'oats' },
  { brand: 'Saffola', pack: 'Gold Pro Healthy Lifestyle Edible Oil', qty: '5 L', eng: 'saffola gold oil 5l', mr: 'सफोला गोल्ड तेल ५ लिटर', core: 'oil' },
  { brand: 'Lux', pack: 'Soft Glow Rose & Vitamin E Soap', qty: '100 g', eng: 'lux soft glow 100g', mr: 'लक्स सॉफ्ट ग्लो १०० ग्रॅम', core: 'lux' },
  { brand: 'Lifebuoy', pack: 'Total 10 Germ Protection Soap', qty: '125 g', eng: 'lifebuoy total 10 soap 125g', mr: 'लाइफबॉय टोटल १० साबण १२५ ग्रॅम', core: 'lifebuoy' },
  { brand: 'Dettol', pack: 'Original Liquid Handwash', qty: '200 ml', eng: 'dettol liquid handwash 200ml', mr: 'डेटॉल लिक्विड हँड वॉश २०० मिली', core: 'liquid' },
  { brand: 'Clinic Plus', pack: 'Strength & Shine Shampoo', qty: '6 ml', eng: 'clinic plus strength 6ml', mr: 'क्लिनिक प्लस स्ट्रेंथ ६ मिली', core: 'clinic plus' },
  { brand: 'Head & Shoulders', pack: 'Anti-Dandruff Shampoo Smooth & Silky', qty: '340 ml', eng: 'head & shoulders 340ml', mr: 'हेड अँड शोल्डर्स ३४० मिली', core: 'head & shoulders' },
  { brand: 'Brooke Bond', pack: 'Red Label Natural Care Tea', qty: '250 g', eng: 'red label natural care 250g', mr: 'रेड लेबल नॅचरल केअर २५० ग्रॅम', core: 'red label' },
  { brand: 'Tata', pack: 'Tea Premium', qty: '500 g', eng: 'tata tea premium 500g', mr: 'टाटा टी प्रीमियम ५०० ग्रॅम', core: 'tata' },
  { brand: 'Wagh Bakri', pack: 'Premium Leaf Tea', qty: '500 g', eng: 'wagh bakri leaf tea 500g', mr: 'वाघ बकरी लीफ चहा ५०० ग्रॅम', core: 'tea' },
  { brand: 'Everest', pack: 'Turmeric Powder', qty: '100 g', eng: 'everest turmeric powder 100g', mr: 'एव्हरेस्ट हळद पावडर १०० ग्रॅम', core: 'powder' },
  { brand: 'MDH', pack: 'Garam Masala', qty: '100 g', eng: 'mdh garam masala 100g', mr: 'एमडीएच गरम मसाला १०० ग्रॅम', core: 'masala' },
  { brand: 'Badshah', pack: 'Rajwadi Garam Masala', qty: '100 g', eng: 'badshah rajwadi masala 100g', mr: 'बादशाह राजवाडी मसाला १०० ग्रॅम', core: 'masala' },
  { brand: 'Catch', pack: 'Hing Asafoetida Compounded', qty: '10 g', eng: 'catch hing 10g', mr: 'कॅच हिंग १० ग्रॅम', core: 'hing' },
  { brand: 'Amul', pack: 'Pure Ghee', qty: '1 L', eng: 'amul ghee 1l', mr: 'अमूल तूप १ लिटर', core: 'ghee' },
  { brand: 'Maggi', pack: '2-Minute Noodles Masala', qty: '70 g', eng: 'maggi 2-minute masala 70g', mr: 'मॅगी २-मिनिट मसाला ७० ग्रॅम', core: 'masala' },
  { brand: "Haldiram's", pack: 'Aloo Bhujia', qty: '150 g', eng: "haldiram's aloo bhujia 150g", mr: 'हल्दीराम आलू भुजिया १५० ग्रॅम', core: 'bhujia' },
  { brand: 'Kurkure', pack: 'Masala Munch', qty: '30 g', eng: 'kurkure masala munch 30g', mr: 'कुरकुरे मसाला मंच ३० ग्रॅम', core: 'masala' },
  { brand: 'Micro Labs', pack: 'Dolo 650 Tablets', qty: '', eng: 'dolo 650 tablet', mr: 'डोलो ६५० टॅबलेट', core: 'tablet' },
  { brand: '', pack: 'Betadine Povidone-Iodine Ointment USP', qty: '20 g', eng: 'betadine ointment 20g', mr: 'बीटाडीन मलम २० ग्रॅम', core: 'ointment' },
  { brand: '', pack: 'Soframycin Framycetin Sulphate Cream', qty: '30 g', eng: 'soframycin cream 30g', mr: 'सोफ्रामायसिन क्रीम ३० ग्रॅम', core: 'cream' },
  { brand: 'Vicks', pack: 'VapoRub Balm', qty: '25 ml', eng: 'vicks vaporub balm 25ml', mr: 'व्हिक्स व्हेपोरब बाम २५ मिली', core: 'balm' },
  { brand: 'Nivea', pack: 'Soft Light Moisturising Cream', qty: '100 ml', eng: 'nivea soft cream 100ml', mr: 'निव्हिया सॉफ्ट क्रीम १०० मिली', core: 'cream' },
  { brand: 'Vaseline', pack: 'Intensive Care Deep Restore Body Lotion', qty: '400 ml', eng: 'vaseline intensive care 400ml', mr: 'व्हॅसलीन इंटेन्सिव्ह केअर ४०० मिली', core: 'vaseline' },
  { brand: 'Surf Excel', pack: 'Easy Wash Detergent Powder', qty: '1 kg', eng: 'surf excel easy wash 1kg', mr: 'सर्फ एक्सेल ईझी वॉश १ किलो', core: 'surf excel' },
  { brand: 'Patanjali', pack: 'Kesh Kanti Natural Hair Cleanser Shampoo', qty: '200 ml', eng: 'patanjali kesh kanti 200ml', mr: 'पतंजली केश कांती २०० मिली', core: 'patanjali' },
  { brand: 'Aashirvaad', pack: 'Shudh Chakki Atta', qty: '5 kg', eng: 'aashirvaad chakki atta 5kg', mr: 'आशीर्वाद चक्की आटा ५ किलो', core: 'atta' },
  { brand: 'Parachute', pack: '100% Pure Coconut Oil', qty: '100 ml', eng: 'parachute coconut oil 100ml', mr: 'पॅराशूट खोबरेल तेल १०० मिली', core: 'oil' },
  { brand: 'Vim', pack: 'Lemon Dishwash Bar', qty: '155 g', eng: 'vim lemon dishwash bar 155g', mr: 'विम लिंबू डिशवॉश बार १५५ ग्रॅम', core: 'bar' },
  { brand: 'Cipla', pack: 'Diclofenac Sodium Gel', qty: '30 g', eng: 'diclofenac gel 30g', mr: 'डायक्लोफेनॅक जेल ३० ग्रॅम', core: 'gel' },
  { brand: 'Britannia', pack: 'Milk Bikis Biscuits Family Pack', qty: '500 g', eng: 'milk bikis biscuit 500g', mr: 'मिल्क बिकीस बिस्किट ५०० ग्रॅम', core: 'biscuit' },
];
const REQUIRED = new Set(['Neomycin Sulphate Cream USP', 'Original Gluco Biscuits', 'Refined Sunflower Oil',
  'Strong Teeth Anticavity Toothpaste', 'Salt Vacuum Evaporated Iodised Salt']);
const DEV_MARK = /^[ऀ-ःऺ-़ा-ॏ॑-ॗॢॣ]/;
let engGood = 0, mrGood = 0, bothGood = 0;
const fixes: string[] = [];
console.log('\nShort names (limits: English', SHORT_NAME_LIMITS.eng, 'chars, Marathi', SHORT_NAME_LIMITS.marathi, 'printed letters)');
console.log('eng | mr | pack text → name_eng | name_marathi');
for (const c of shortCases) {
  const r = shortBilingualName({ brand: c.brand, productEng: c.pack, netQty: c.qty }, maps);
  const tag = `short [${c.pack.replace(/\n/g, ' / ')}]`;
  const eOk = r.name_eng === c.eng, mOk = r.name_marathi === c.mr;
  if (eOk) engGood++;
  if (mOk) mrGood++;
  if (eOk && mOk) bothGood++; else fixes.push(`${c.pack.replace(/\n/g, ' / ')}: got "${r.name_eng}" / "${r.name_marathi}", want "${c.eng}" / "${c.mr}"`);
  console.log(`${eOk ? 'ok ' : 'FIX'} | ${mOk ? 'ok ' : 'FIX'} | ${c.pack.replace(/\n/g, ' / ')} → ${r.name_eng} | ${r.name_marathi}${r.unsure ? '  (unsure → yellow)' : ''}`);
  if (REQUIRED.has(c.pack)) eq(`${tag} required exact English`, r.name_eng, c.eng);
  // Hard rules for every row
  check(`${tag} English ≤ limit`, r.name_eng.length <= SHORT_NAME_LIMITS.eng, `${r.name_eng.length}`);
  check(`${tag} Marathi ≤ limit`, printedLength(r.name_marathi) <= SHORT_NAME_LIMITS.marathi, `${printedLength(r.name_marathi)}`);
  if (c.qty) {
    check(`${tag} size in English`, r.name_eng.endsWith(' ' + qtyEng(c.qty)), r.name_eng);
    check(`${tag} size in Marathi`, r.name_marathi.endsWith(' ' + qtyMarathi(c.qty)), r.name_marathi);
  }
  check(`${tag} core word kept`, (' ' + r.name_eng + ' ').includes(' ' + c.core + ' '), `${c.core} in ${r.name_eng}`);
  const fullWords = new Set(r.full_name_eng ? r.full_name_eng.split(' ') : r.name_eng.split(' '));
  const brandWords = (c.brand || '').toLowerCase().split(' ');
  for (const w of r.name_eng.split(' ')) {
    check(`${tag} English word "${w}" is whole (from the pack)`, fullWords.has(w) || brandWords.includes(w) || /^\d/.test(w) || w === 'biscuit' || w === 'cookie' || w === 'tablet', r.full_name_eng);
  }
  for (const w of r.name_marathi.split(' ')) {
    check(`${tag} Marathi word not cut ("${w}")`, !!w && !DEV_MARK.test(w) && !w.endsWith('्'), [...w].map(ch => ch.codePointAt(0)!.toString(16)).join(' '));
  }
  check(`${tag} single spaces`, !/\s{2,}|^\s|\s$/.test(r.name_eng) && !/\s{2,}|^\s|\s$/.test(r.name_marathi));
  const b = (c.brand || '').toLowerCase();
  if (b) check(`${tag} brand at most once`, r.name_eng.split(b).length <= 2, r.name_eng);
  // Through the popup fill: name === name_marathi, shop style
  const filledShort = fillItemFromScan({ id: 'x', name: '', unit: 'kg', price: 0 }, { isNew: true, touched: new Set() },
    { ...scanBase, brand: c.brand || null, name_eng: c.pack, net_qty: c.qty || null }, maps).item;
  eq(`${tag} popup: name === name_marathi`, filledShort.name, filledShort.name_marathi);
  eq(`${tag} popup: short name_eng`, filledShort.name_eng, r.name_eng);
}
console.log(`English good: ${engGood}/${shortCases.length}   Marathi good: ${mrGood}/${shortCases.length}   both good: ${bothGood}/${shortCases.length}`);
console.log('Need a manual fix:\n  ' + fixes.join('\n  '));
check('short names: English floor', engGood >= 36, `${engGood}`);
check('short names: Marathi floor', mrGood >= 36, `${mrGood}`);

// Variant phrases stay with the brand; natural / premium only kept right after the brand
const sb = (brand: string, pack: string, qty: string) => shortBilingualName({ brand, productEng: pack, netQty: qty }, maps);
eq('variant kept with brand (Tata Tea Gold)', sb('Tata', 'Tea Gold', '250 g').name_eng, 'tata tea gold 250g');
eq('variant kept with brand (Surf Excel Quick Wash)', sb('Surf Excel', 'Quick Wash Detergent Powder', '500 g').name_eng, 'surf excel quick wash 500g');
eq('sub-brand replaces parent (Dark Fantasy)', sb('Sunfeast', 'Dark Fantasy Choco Fills', '75 g').name_eng, 'dark fantasy choco fills 75g');
check('natural kept right after brand', sb('Saffola', 'Natural Honey', '250 g').name_eng.includes('natural'), sb('Saffola', 'Natural Honey', '250 g').name_eng);
check('natural dropped elsewhere', !sb('Himalaya', 'Neem Natural Face Wash', '100 ml').name_eng.includes('natural'), sb('Himalaya', 'Neem Natural Face Wash', '100 ml').name_eng);
check('premium dropped when not after brand', !sb('Parle-G', 'Gluco Premium Biscuits', '250 g').name_eng.includes('premium'));
eq('variant too long for the limit is not protected (Vaseline Intensive Care = 29 chars)', sb('Vaseline', 'Intensive Care Deep Restore Body Lotion', '400 ml').name_eng, 'vaseline lotion 400ml');

// Built-in medicine / brand Marathi spellings
eq('medicine spellings', ['crocin', 'eno', 'volini', 'iodex', 'zandu balm', 'paracetamol'].map(w => englishToMarathi(w, maps).text),
  ['क्रोसिन', 'इनो', 'व्होलिनी', 'आयोडेक्स', 'झंडू बाम', 'पॅरासिटामॉल']);
eq('short medicine name in Marathi', sb('', 'Crocin Tablets', '').name_marathi, 'क्रोसिन टॅबलेट');
eq('medicine variant kept (Crocin Advance)', sb('', 'Crocin Advance Tablets', '').name_eng, 'crocin advance tablet');

// Full long name is kept and searchable
const neo = shortBilingualName({ productEng: 'Neomycin Sulphate Cream USP', netQty: '10 g' }, maps);
eq('full_name_eng kept', neo.full_name_eng, 'neomycin sulphate cream usp 10g');
eq('no full name when nothing was shortened', shortBilingualName({ brand: 'MDH', productEng: 'Garam Masala', netQty: '100 g' }, maps).full_name_eng, '');

// Devanagari-only pack text: filler dropped, whole words only
const devOnly2 = shortBilingualName({ productDev: 'नवीन शुद्ध गाईचे तूप', netQty: '1 L' }, maps);
check('Devanagari-only: filler dropped', !devOnly2.name_marathi.includes('नवीन') && !devOnly2.name_marathi.includes('शुद्ध'), devOnly2.name_marathi);

// Learning a dropped word: the user removes "gluco" → next time it is dropped automatically
const sug = shortBilingualName({ brand: 'Parle-G', productEng: 'Original Gluco Biscuits', netQty: '250 g' }, maps);
const learnedDrop = learnDroppedWords({}, sug, { name_marathi: 'पारले-जी बिस्किट २५० ग्रॅम' });
eq('learned drop stored', learnedDrop['!drop:gluco'], '1');
eq('learned drop never stores type words or brands', [learnedDrop['!drop:biscuit'], learnedDrop['!drop:parle-g']], [undefined, undefined]);
eq('learned drop applied next time',
  shortBilingualName({ brand: 'Parle-G', productEng: 'Original Gluco Biscuits', netQty: '250 g' }, { ...maps, learned: learnedDrop }).name_eng,
  'parle-g biscuit 250g');
check('unsure flag on an unusual product', shortBilingualName({ productEng: 'Zentrix Alpha Omega Delta Ultra Pro Max', netQty: '50 g' }, maps).unsure);
const unusual = shortBilingualName({ productEng: 'Zentrix Alpha Omega Delta Ultra Pro Max', netQty: '50 g' }, maps);
check('unsure: at most 2 words + size', unusual.name_eng.split(' ').length <= 3, unusual.name_eng);
check('printedLength ignores matras/virama', printedLength('क्रीम') === 3, String(printedLength('क्रीम')));

// ── Two name fields (popup) ──────────────────────────────────────────────────
const both = { id: 'x', name: 'साखर', name_marathi: 'साखर', name_eng: 'sugar' };
eq('editing English never touches Marathi', withItemNames(both, { eng: 'sugar 1kg' }), { ...both, name_eng: 'sugar 1kg', name: 'साखर' });
eq('editing Marathi never touches English', withItemNames(both, { marathi: 'साखर १ किलो' }),
  { ...both, name_marathi: 'साखर १ किलो', name: 'साखर १ किलो' });
eq('Marathi cleared → name falls back to English', withItemNames(both, { marathi: '' }).name, 'sugar');
eq('both cleared → empty name', withItemNames(both, { marathi: '', eng: '' }).name, '');
eq('legacy item with only a Latin name shows it as English', itemNameFields({ name: 'sugar' }), { eng: 'sugar', marathi: '' });
eq('legacy item with only a Devanagari name shows it as Marathi', itemNameFields({ name: 'साखर' }), { eng: '', marathi: 'साखर' });
check('every inventory.json item keeps name = Marathi', inventory.every(i => withItemNames(i, {}).name === (i.name_marathi || i.name_eng)));

// ── OCR spelling with the shop's own words ───────────────────────────────────
const vocab = buildSpellVocab(inventory);
check('vocab has shop words and brands', vocab.has('masurdal') && vocab.has('britannia') && vocab.has('biscuit'));
eq('rn read for m (shop word)', spellFixEnglish('Rnasurdal', vocab).text, 'Masurdal');
eq('one letter lost (brand)', spellFixEnglish('BRITANIA Biscuit', vocab).text, 'BRITANNIA Biscuit');
eq('swapped letters', spellFixEnglish('turdla', vocab).text, 'turdal');
eq('known words untouched', spellFixEnglish('Sugar Tea Masala 250g', vocab).text, 'Sugar Tea Masala 250g');
eq('unknown word with nothing close is kept', spellFixEnglish('Rajwadi', vocab).text, 'Rajwadi');
eq('sizes and codes untouched', spellFixEnglish('200g B12 A2B114', vocab).text, '200g B12 A2B114');
check('a word still looking misread is reported unsure', spellFixEnglish('Zx1kq Tea', vocab).unsure.includes('Zx1kq'));
eq('osa: swap = 1', osaDistance('noodels', 'noodles'), 1);
check('a tie is never fixed', spellFixWord('pasle', new Set(['paste', 'parle'])) === null);
// learned corrections: the user fixed a word once → fixed next time
const learnedFix = learnSpellingFixes({}, 'parle-g glcuo biscuit 250g', 'parle-g gluco biscuit 250g');
eq('spelling fix learned', learnedFix['!fix:glcuo'], 'gluco');
eq('spelling fix applied next time', spellFixEnglish('Glcuo Biscuit', vocab, learnedFix).text, 'Gluco Biscuit');
eq('a different word is not learned as a misspelling', learnSpellingFixes({}, 'lux soap 100g', 'lux shampoo 100g'), {});
const spelled = fillItemFromScan(blankNew, { isNew: true, touched: new Set() },
  { ...scanFull, brand: 'Britannia', name_eng: 'Good Day Cashevv Cookies', net_qty: '75 g' }, { ...maps, vocab });
eq('fill uses the shop vocabulary', spelled.item.name_eng, 'good day cashew cookie 75g');
eq('fill reports spelling changes', spelled.spellChanges, [['Cashevv', 'cashew']]);

// ── Tap-to-pick: recognised line → field ─────────────────────────────────────
eq('pick MRP: digit look-alikes', parsePickedPrice('M.R.P. ₹ 4S.OO incl. of all taxes'), 45);
eq('pick MRP: Rs.45/-', parsePickedPrice('MRP Rs.45/-'), 45);
eq('pick MRP: (incl. of all taxes) before the value', parsePickedPrice('MRP (Incl. of all taxes) ₹ 105.00'), 105);
eq('pick MRP: print gap', parsePickedPrice('MRP ₹ 1 08.00'), 108);
eq('pick MRP: lone number', parsePickedPrice('45.00'), 45);
eq('pick MRP: a weight is not a price', parsePickedPrice('Net Wt 200 g'), null);
eq('pick MRP: a phone number is not a price', parsePickedPrice('Customer care 1800 102 2552'), null);
eq('pick MRP: out of range', parsePickedPrice('MRP ₹ 12500'), null);
eq('pick weight', [parsePickedQty('Net Wt. 2OO g'), parsePickedQty('Net Qty 1 Ltr'), parsePickedQty('MRP 45')], ['200 g', '1 L', null]);
eq('pick weight: impossible size', parsePickedQty('Net Wt 500 kg'), null);
eq('pick barcode', [parsePickedBarcode('89O1O3O 8O5431'), parsePickedBarcode('B.No. 1234')], ['8901030805431', null]);
eq('pick English name', parsePickedName('Good Day Cashew Cookies 75 G'), 'good day cashew cookies 75g');
eq('fixDigits keeps words', [fixDigits('Rs.45'), fixDigits('1ltr'), fixDigits('2OOg'), fixDigits('4S.OO')], ['Rs.45', '1ltr', '200g', '45.00']);

// ── "Copy details": MRP readings, alternates, warnings ───────────────────────
const details2 = formatScanDetails({ ...scanBase, mrp: 45, mrp_alternates: [40], warnings: ['Check both dates.'],
  suggestions: { brand: 'Parle' },
  debug: { mrpReadings: ['₹45: score 1.01 (MRP, read 2×, photo 2)', '₹40: score 0.90 (MRP, read 1×, photo 3)'],
    photos: [{ photo: 1, size: '4000x3000', passes: 'plain, contrast', exifRotation: 90, turned: 270, ocrLatin: '[h14 c91] MRP ₹ 45.00' }] } });
check('details: MRP readings and alternates', details2.includes('MRP READINGS') && details2.includes('alternates offered: ₹40'));
check('details: passes, rotation, warnings, suggestions', details2.includes('OCR passes plain, contrast; EXIF 90°; turned 270°')
  && details2.includes('Check both dates.') && details2.includes('suggested brand: Parle'));

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('All item-name checks passed');
