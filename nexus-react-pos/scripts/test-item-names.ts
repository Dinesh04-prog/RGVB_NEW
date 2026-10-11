// Plain assertion checks for src/lib/itemNames.ts — no test framework.
// Run: npm run test:names   (bundles with rolldown, then runs on Node)
import { readFileSync } from 'node:fs';
import {
  makeSearchKey, qtyEng, qtyMarathi, buildInventoryWordMap, composeNames,
  learnFromCorrection, findDuplicate, marathiToEnglish, englishToMarathi, buildPhotoItem,
  normalizeEngName, normalizeMarathiName, type NameMaps,
} from '../src/lib/itemNames';
import { formatScanDetails } from '../src/lib/androidScan';

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
eq('qtyEng L', qtyEng('1 L'), '1ltr');
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
  check(`saved ${o.id} name_eng lowercase + size glued`, o.name_eng === o.name_eng.toLowerCase() && /\d(g|kg|ml|ltr)$/.test(o.name_eng), o.name_eng);
  check(`saved ${o.id} name = name_marathi, Devanagari size`, o.name === o.name_marathi && /[०-९]+ (ग्रॅम|किलो|मिली|लिटर)$/.test(o.name_marathi), o.name_marathi);
  check(`saved ${o.id} brand kept`, !!o.brand && o.name_eng.startsWith(o.brand.toLowerCase()), String(o.brand));
  check(`saved ${o.id} search_key convention`, o.search_key === makeSearchKey(o.name_eng, o.name_marathi), o.search_key);
  check(`saved ${o.id} no undefined`, !Object.values(o).some(v => v === undefined));
}
// User-typed names are normalized on save
eq('normalize eng', normalizeEngName('Parle-G  Biscuits 250 G'), 'parle-g biscuits 250g');
eq('normalize eng litre', normalizeEngName('Fortune Oil 1 L'), 'fortune oil 1ltr');
eq('normalize marathi', normalizeMarathiName('पारले बिस्किट 250 g'), 'पारले बिस्किट २५० ग्रॅम');
eq('normalize marathi kg', normalizeMarathiName('टाटा मीठ 1kg'), 'टाटा मीठ १ किलो');

// ── "Copy details" text ──────────────────────────────────────────────────────
const scanBase = {
  name_eng: 'Original Gluco Biscuits', name_marathi: null, brand: 'Parle-G', unit: 'pcs', net_qty: '250 g', mrp: 10,
  barcode: '8901719101038', barcodeVerified: true, mfg_date: '2026-01-12', expiry_date: null,
  confidence: { mrp: 0.95, brand: 0.75 }, source: { mrp: 'mlkit-ocr' as const, brand: 'mlkit-ocr' as const },
  offStatus: 'skipped' as const, frontPhotoDataUrl: 'data:image/jpeg;base64,AAAA', backPhotoDataUrl: null,
};
const details = formatScanDetails({ ...scanBase, debug: {
  ocrBackLatin: '[h22] M.R.P Rs. 1O.OO', ocrFrontDevanagari: '[h30] पारले-जी',
  barcodeMlkit: { value: '8901719101038', format: 'EAN_13', checksumOk: true, photo: 'back' },
  parser: { mrp: { value: 10, confidence: 0.95 } }, timingsMs: { total: 1800 },
} });
check('details has raw OCR', details.includes('M.R.P Rs. 1O.OO') && details.includes('पारले-जी'));
check('details has barcode + source/conf', details.includes('EAN_13') && details.includes('mrp: 10 · mlkit-ocr · 0.95'));
check('details excludes photos', !details.includes('base64'));
check('details works without debug', formatScanDetails(scanBase).includes('ML Kit: not found'));

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('All item-name checks passed');
