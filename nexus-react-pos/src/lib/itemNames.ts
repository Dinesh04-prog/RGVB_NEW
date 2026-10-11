// Bilingual item naming for inventory items — pure functions, no storage, no network.
//
// Shop convention (public/inventory.json):
//   name_eng     = lowercase romanized name, brand inside the name, size glued: "red lebal 250g"
//   name_marathi = Devanagari name, Devanagari digits, unit word:            "रेड लेबल २५० ग्रॅम"
//   name         = name_marathi
//   search_key   = lowercase(first 4 chars of name_eng + " " + first 4 of name_marathi): "red  रेड "

import {
  HINGLISH_TO_MARATHI, BRAND_DEVANAGARI_MAP,
  translateHinglishToMarathi, transliterateDevanagariToLatin,
} from './phonetic';

/** lowercase English word or phrase → Devanagari */
export type WordMap = Record<string, string>;

export const makeSearchKey = (nameEng: string, nameMarathi: string): string =>
  `${(nameEng || '').slice(0, 4)} ${(nameMarathi || '').slice(0, 4)}`.toLowerCase();

// ── Sizes ────────────────────────────────────────────────────────────────────

const DEV_DIGITS = '०१२३४५६७८९';
export const toDevanagariDigits = (s: string) => s.replace(/[0-9]/g, d => DEV_DIGITS[Number(d)]);

const parseQty = (netQty: string | undefined | null) => {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(kg|g|ml|l)\s*$/i.exec(netQty || '');
  return m ? { n: m[1], u: m[2].toLowerCase() } : null;
};

/** "250 g" → "250g", "1 kg" → "1kg", "500 ml" → "500ml", "1 L" → "1ltr" */
export const qtyEng = (netQty: string | undefined | null): string => {
  const q = parseQty(netQty);
  if (!q) return '';
  return q.n + (q.u === 'l' ? 'ltr' : q.u);
};

/** "250 g" → "२५० ग्रॅम", "1 kg" → "१ किलो", "500 ml" → "५०० मिली", "1 L" → "१ लिटर" */
export const qtyMarathi = (netQty: string | undefined | null): string => {
  const q = parseQty(netQty);
  if (!q) return '';
  const unit = { g: 'ग्रॅम', kg: 'किलो', ml: 'मिली', l: 'लिटर' }[q.u as 'g' | 'kg' | 'ml' | 'l'];
  return `${toDevanagariDigits(q.n)} ${unit}`;
};

// Size / price tokens inside existing names: "250g", "1kg", "5/-", "२५०", "ग्रॅम", "(hotel)" …
const LATIN_QTY_TOKEN = /^(\d+(\.\d+)?(g|gm|kg|ml|l|ltr)?|\d+(\.\d+)?\/-|\d+\/\d+)$/i;
const DEV_QTY_TOKEN = /^([०-९.]+(\/-)?|[०-९]+\/[०-९]+|ग्रॅम|ग्राम|किलो|मिली|लिटर)$/;
const stripTokens = (s: string, isDev: boolean) =>
  s.toLowerCase().replace(/[()]/g, ' ').split(/\s+/)
    .filter(t => t && !(isDev ? DEV_QTY_TOKEN : LATIN_QTY_TOKEN).test(t));

// ── Dictionaries ─────────────────────────────────────────────────────────────

/** Brand spellings in Marathi (English key lowercase). Extends BRAND_DEVANAGARI_MAP from phonetic.ts. */
export const BRAND_MARATHI: WordMap = {
  ...Object.fromEntries(Object.entries(BRAND_DEVANAGARI_MAP).map(([dev, en]) => [en, dev])),
  'parle': 'पारले', 'parle-g': 'पारले-जी', 'britannia': 'ब्रिटानिया', 'sunfeast': 'सनफीस्ट', 'oreo': 'ओरिओ',
  'good day': 'गुड डे', 'marie gold': 'मारी गोल्ड', 'fortune': 'फॉर्च्यून', 'saffola': 'सफोला',
  'parachute': 'पॅराशूट', 'gold winner': 'गोल्ड विनर', 'lux': 'लक्स', 'lifebuoy': 'लाइफबॉय',
  'medimix': 'मेडिमिक्स', 'santoor': 'संतूर', 'cinthol': 'सिंथॉल', 'pears': 'पिअर्स', 'vim': 'विम',
  'clinic plus': 'क्लिनिक प्लस', 'head & shoulders': 'हेड अँड शोल्डर्स', 'sunsilk': 'सनसिल्क',
  'brooke bond': 'ब्रूक बाँड', 'red label': 'रेड लेबल', 'tata': 'टाटा', 'tata sampann': 'टाटा संपन्न',
  'wagh bakri': 'वाघ बकरी', 'society': 'सोसायटी', 'girnar': 'गिरनार', 'everest': 'एव्हरेस्ट',
  'mdh': 'एमडीएच', 'badshah': 'बादशाह', 'catch': 'कॅच', 'amul': 'अमूल', 'surf excel': 'सर्फ एक्सेल',
  'maggi': 'मॅगी', 'kurkure': 'कुरकुरे', "haldiram's": 'हल्दीराम', 'haldiram': 'हल्दीराम',
  'colgate': 'कोलगेट', 'dettol': 'डेटॉल', 'dabur': 'डाबर', 'himalaya': 'हिमालया', 'dove': 'डव',
  'ghadi': 'घडी', 'nirma': 'निरमा', 'rin': 'रिन', 'tide': 'टाइड', 'wheel': 'व्हील', 'ariel': 'एरियल',
  'cadbury': 'कॅडबरी', 'bournvita': 'बोर्नव्हिटा', 'horlicks': 'हॉर्लिक्स', 'nescafe': 'नेस्कॅफे',
  'bru': 'ब्रू', 'kissan': 'किसान', 'patanjali': 'पतंजली', 'aashirvaad': 'आशीर्वाद', 'chitale': 'चितळे',
  'pravin': 'प्रवीण', 'suhana': 'सुहाना', 'ramdev': 'रामदेव', 'bikaji': 'बिकाजी', 'pepsodent': 'पेप्सोडेंट',
  'close up': 'क्लोज अप', 'sensodyne': 'सेन्सोडाइन', 'harpic': 'हार्पिक', 'lizol': 'लायझॉल',
};

/** Common packaged-goods words not in HINGLISH_TO_MARATHI (shop-style spellings). */
export const LOANWORDS: WordMap = {
  'biscuits': 'बिस्किट', 'cookies': 'कुकीज', 'cookie': 'कुकी', 'cream': 'क्रीम', 'gluco': 'ग्लुको',
  'glucose': 'ग्लुकोज', 'original': 'ओरिजिनल', 'refined': 'रिफाइंड', 'sunflower': 'सूर्यफूल',
  'soyabean': 'सोयाबीन', 'mustard oil': 'मोहरी तेल', 'detergent': 'डिटर्जंट', 'noodles': 'नूडल्स',
  'handwash': 'हँडवॉश', 'hand': 'हँड', 'wash': 'वॉश', 'liquid': 'लिक्विड', 'dental': 'डेंटल',
  'chips': 'चिप्स', 'gold': 'गोल्ड', 'premium': 'प्रीमियम', 'label': 'लेबल', 'red': 'रेड', 'pure': 'शुद्ध',
  'garam': 'गरम', 'leaf': 'लीफ', 'bar': 'बार', 'dishwash': 'डिशवॉश', 'lemon': 'लिंबू', 'bhujia': 'भुजिया',
  'marie': 'मारी', 'light': 'लाइट', 'total': 'टोटल', 'soft': 'सॉफ्ट', 'glow': 'ग्लो', 'classic': 'क्लासिक',
  'ayurvedic': 'आयुर्वेदिक', 'strong': 'स्ट्राँग', 'teeth': 'टीथ', 'black': 'ब्लॅक', 'shine': 'शाइन',
  'easy': 'ईझी', 'minute': 'मिनिट', 'instant': 'इन्स्टंट', 'coffee': 'कॉफी', 'chocolate': 'चॉकलेट',
  'jam': 'जॅम', 'sauce': 'सॉस', 'ketchup': 'केचप', 'pickle': 'लोणचे', 'papad': 'पापड', 'namkeen': 'नमकीन',
  'atta': 'आटा', 'chakki': 'चक्की', 'fresh': 'फ्रेश', 'rose': 'रोझ', 'sandal': 'चंदन', 'neem': 'कडुलिंब',
  'anti-dandruff': 'अँटी-डँड्रफ', 'conditioner': 'कंडिशनर', 'hair': 'केसांचे', 'toothbrush': 'टूथब्रश',
  'rusk': 'टोस्ट', 'toast': 'टोस्ट', 'masala munch': 'मसाला मंच', 'munch': 'मंच', 'sandwich': 'सँडविच',
  'chocolatey': 'चॉकलेटी', 'cashew': 'काजू', 'roasted': 'भाजलेले', 'powder': 'पावडर',
};

/** Hindi spellings OCR often reads from packs → Marathi shop spelling. */
export const HINDI_TO_MARATHI: WordMap = {
  'नमक': 'मीठ', 'चाय': 'चहा', 'घी': 'तूप', 'बिस्कुट': 'बिस्किट', 'साबुन': 'साबण', 'हल्दी': 'हळद',
  'मिर्च': 'मिरची', 'मिर्ची': 'मिरची', 'चीनी': 'साखर', 'दाल': 'डाळ', 'जीरा': 'जिरे', 'चावल': 'तांदूळ',
  'पाउडर': 'पावडर', 'तेल': 'तेल', 'आलू': 'बटाटा', 'धनिया': 'धने', 'सरसों': 'मोहरी', 'गुड़': 'गूळ',
  'मूंगफली': 'शेंगदाणा', 'दूध': 'दूध', 'मसाला': 'मसाला', 'चना': 'हरभरा', 'सूजी': 'रवा',
};

// ── Map from existing inventory ──────────────────────────────────────────────

// Loose consonant classes so "shenga" ↔ "कच्चे" (different word order) is rejected,
// but "vatana" ↔ "वाटाणा" is accepted.
const soundClass = (ch: string) => {
  const c = ch.toLowerCase();
  if ('ckq'.includes(c)) return 'k';
  if ('vwb'.includes(c)) return 'v';
  if ('jz'.includes(c)) return 'j';
  if ('fp'.includes(c)) return 'p';
  if ('aeiou'.includes(c)) return 'a';
  return c;
};
const plausiblePair = (eng: string, dev: string) => {
  const latin = transliterateDevanagariToLatin(dev).replace(/[^a-z]/g, '');
  return !!latin && !!eng && soundClass(latin[0]) === soundClass(eng[0]);
};

/**
 * Builds English → Marathi pairs from the shop's own items, so suggestions reuse the shop's spelling
 * ("toor dal" → "तूर डाळ"). Whole names (without sizes) and word-by-word when the word counts match.
 */
export const buildInventoryWordMap = (
  items: { name_eng?: string; name_marathi?: string }[]
): WordMap => {
  const map: WordMap = {};
  for (const it of items) {
    if (!it.name_eng || !it.name_marathi) continue;
    const en = stripTokens(it.name_eng, false);
    const mr = stripTokens(it.name_marathi, true).filter(t => /[ऀ-ॿ]/.test(t));
    if (!en.length || !mr.length) continue;
    const phrase = en.join(' ');
    if (en.length > 1 && !map[phrase]) map[phrase] = mr.join(' ');
    if (en.length === mr.length) {
      en.forEach((w, i) => {
        if (/^[a-z][a-z'-]+$/.test(w) && !map[w] && plausiblePair(w, mr[i])) map[w] = mr[i];
      });
    } else if (en.length === 1 && !map[phrase]) {
      map[phrase] = mr.join(' ');
    }
  }
  return map;
};

// ── English → Marathi ────────────────────────────────────────────────────────

export type WordSource = 'learned' | 'inventory' | 'brand' | 'dictionary' | 'loanword' | 'phonetic' | 'number';

export interface Translation {
  text: string;
  /** words produced by phonetic transliteration — the user should check these */
  phoneticWords: string[];
  sources: WordSource[];
}

export interface NameMaps {
  learned: WordMap;    // user corrections (localforage)
  inventory: WordMap;  // buildInventoryWordMap(inventory)
}

const lookupPhrase = (phrase: string, maps: NameMaps): [string, WordSource] | null => {
  if (maps.learned[phrase]) return [maps.learned[phrase], 'learned'];
  if (maps.inventory[phrase]) return [maps.inventory[phrase], 'inventory'];
  if (BRAND_MARATHI[phrase]) return [BRAND_MARATHI[phrase], 'brand'];
  if (HINGLISH_TO_MARATHI[phrase]) return [HINGLISH_TO_MARATHI[phrase], 'dictionary'];
  if (LOANWORDS[phrase]) return [LOANWORDS[phrase], 'loanword'];
  return null;
};

const singular = (w: string) =>
  w.endsWith('ies') ? w.slice(0, -3) + 'y' : w.endsWith('es') && w.length > 4 ? w.slice(0, -2) : w.endsWith('s') ? w.slice(0, -1) : w;

// Marathi words ending in a consonant are written without a trailing halant ("गोकुल्" → "गोकुल")
const phonetic = (word: string) =>
  translateHinglishToMarathi(word.replace(/[^a-z]/gi, '')).replace(/्$/, '');

/** "fortune refined sunflower oil" → "फॉर्च्यून रिफाइंड सूर्यफूल तेल" (longest phrase first, up to 3 words). */
export const englishToMarathi = (english: string, maps: NameMaps): Translation => {
  const words = english.toLowerCase().replace(/[^a-z0-9&'\-./ ]/g, ' ').split(/\s+/).filter(Boolean);
  const out: string[] = [];
  const phoneticWords: string[] = [];
  const sources: WordSource[] = [];
  let i = 0;
  while (i < words.length) {
    let hit: [string, WordSource] | null = null;
    let len = 0;
    for (let n = Math.min(3, words.length - i); n >= 1 && !hit; n--) {
      const phrase = words.slice(i, i + n).join(' ');
      hit = lookupPhrase(phrase, maps) ?? (n === 1 ? lookupPhrase(singular(phrase), maps) : null);
      if (hit) len = n;
    }
    if (hit) {
      out.push(hit[0]); sources.push(hit[1]); i += len; continue;
    }
    const w = words[i];
    const size = /^(\d+(?:\.\d+)?)(g|gm|kg|ml|l|ltr)$/.exec(w);
    if (size) {
      const u = { gm: 'g', ltr: 'L', l: 'L' }[size[2]] ?? size[2];
      out.push(qtyMarathi(`${size[1]} ${u}`)); sources.push('number'); i++; continue;
    }
    if (w.includes('-') && w.replace(/-/g, '')) {
      // "2-minute" → "२-मिनिट": translate each part, keep the hyphen
      const parts = w.split('-').map(p => (p ? englishToMarathi(p, maps) : null));
      out.push(parts.map(p => p?.text ?? '').join('-'));
      parts.forEach(p => p && phoneticWords.push(...p.phoneticWords));
      sources.push(parts.some(p => p?.phoneticWords.length) ? 'phonetic' : 'dictionary');
    }
    else if (/\d/.test(w)) { out.push(toDevanagariDigits(w)); sources.push('number'); }
    else if (w === '&') { out.push('अँड'); sources.push('loanword'); }
    else {
      const p = phonetic(w);
      out.push(p); phoneticWords.push(p); sources.push('phonetic');
    }
    i++;
  }
  return { text: out.join(' '), phoneticWords, sources };
};

/** Replace Hindi spellings read by OCR with the shop's Marathi spelling. */
export const hindiToMarathi = (dev: string): { text: string; changed: boolean } => {
  let changed = false;
  const text = dev.split(/\s+/).map(w => {
    const r = HINDI_TO_MARATHI[w];
    if (r && r !== w) { changed = true; return r; }
    return w;
  }).join(' ');
  return { text, changed };
};

// ── Marathi → English ────────────────────────────────────────────────────────

/** "तूर डाळ" → "toor dal" using reverse maps, else romanized transliteration (flagged). */
export const marathiToEnglish = (marathi: string, maps: NameMaps): Translation => {
  const reverse: WordMap = {};
  const add = (m: WordMap) => { for (const [en, mr] of Object.entries(m)) if (!reverse[mr]) reverse[mr] = en; };
  add(maps.learned); add(maps.inventory); add(BRAND_MARATHI); add(HINGLISH_TO_MARATHI);
  const words = marathi.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  const phoneticWords: string[] = [];
  const sources: WordSource[] = [];
  let i = 0;
  while (i < words.length) {
    let done = false;
    for (let n = Math.min(3, words.length - i); n >= 1; n--) {
      const phrase = words.slice(i, i + n).join(' ');
      if (reverse[phrase]) { out.push(reverse[phrase]); sources.push('dictionary'); i += n; done = true; break; }
    }
    if (done) continue;
    const w = words[i];
    const unitEng: Record<string, string> = { 'ग्रॅम': 'g', 'ग्राम': 'g', 'किलो': 'kg', 'मिली': 'ml', 'लिटर': 'ltr' };
    if (/^[०-९.]+$/.test(w) && unitEng[words[i + 1]]) {
      out.push(w.replace(/[०-९]/g, d => String(DEV_DIGITS.indexOf(d))) + unitEng[words[i + 1]]);
      sources.push('number'); i += 2; continue;
    }
    if (/[०-९]/.test(w)) { out.push(w.replace(/[०-९]/g, d => String(DEV_DIGITS.indexOf(d)))); sources.push('number'); }
    else { const p = transliterateDevanagariToLatin(w); out.push(p); phoneticWords.push(p); sources.push('phonetic'); }
    i++;
  }
  return { text: out.join(' '), phoneticWords, sources };
};

// ── Compose both names for a scanned product ─────────────────────────────────

export interface ComposeInput {
  brand?: string | null;        // English brand ("Parle-G")
  productEng?: string | null;   // English product words ("Original Gluco Biscuits")
  productDev?: string | null;   // Devanagari text read by OCR, if any
  netQty?: string | null;       // "250 g"
}

export interface ComposedNames {
  name_eng: string;
  name_marathi: string;
  engPhonetic: string[];     // English words romanized from Devanagari (check these)
  mrPhonetic: string[];      // Marathi words transliterated from English (check these)
  mrFromHindi: boolean;      // OCR Devanagari was Hindi and got respelled
}

const stripBrand = (product: string, brand: string) => {
  if (!brand) return product;
  const variants = [brand, brand.replace(/-/g, ' '), brand.replace(/'/g, '')];
  let p = product;
  for (const v of variants) {
    p = p.replace(new RegExp(`(^|\\s)${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`, 'ig'), ' ');
  }
  return p.replace(/\s+/g, ' ').trim();
};

export const composeNames = (input: ComposeInput, maps: NameMaps): ComposedNames => {
  const brand = (input.brand || '').trim();
  const brandLc = brand.toLowerCase();
  let productEng = stripBrand((input.productEng || '').trim(), brand).toLowerCase();
  let productMr = '';
  let mrPhonetic: string[] = [];
  let engPhonetic: string[] = [];
  let mrFromHindi = false;

  const brandMr = brand ? englishToMarathi(brandLc, maps) : null;

  // a) Devanagari read by OCR — use it unless it is only the brand
  const dev = (input.productDev || '').trim();
  if (dev && (!brandMr || dev !== brandMr.text)) {
    const fixed = hindiToMarathi(brandMr ? dev.replace(brandMr.text, '').trim() : dev);
    productMr = fixed.text;
    mrFromHindi = fixed.changed;
  }
  // b+c) Dictionary / inventory / phonetic from English
  if (!productMr && productEng) {
    const t = englishToMarathi(productEng, maps);
    productMr = t.text;
    mrPhonetic = t.phoneticWords;
  }
  // English from Marathi when only Devanagari was read
  if (!productEng && productMr) {
    const t = marathiToEnglish(productMr, maps);
    productEng = t.text;
    engPhonetic = t.phoneticWords;
  }
  if (brandMr) mrPhonetic = [...brandMr.phoneticWords, ...mrPhonetic];

  const join = (...parts: string[]) => parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  return {
    name_eng: join(brandLc, productEng, qtyEng(input.netQty)),
    name_marathi: join(brandMr?.text || '', productMr, qtyMarathi(input.netQty)),
    engPhonetic, mrPhonetic, mrFromHindi,
  };
};

// ── Learning from corrections ────────────────────────────────────────────────

/**
 * When the user edits a suggested name, remember the word pairs of the final names so the same words
 * are filled correctly next time. Returns a new map (input is not mutated).
 */
export const learnFromCorrection = (
  map: WordMap,
  suggested: { name_eng: string; name_marathi: string },
  final: { name_eng: string; name_marathi: string },
): WordMap => {
  const edited = suggested.name_eng.trim() !== final.name_eng.trim() ||
                 suggested.name_marathi.trim() !== final.name_marathi.trim();
  if (!edited) return map;
  const en = stripTokens(final.name_eng, false);
  const mr = stripTokens(final.name_marathi, true).filter(t => /[ऀ-ॿ]/.test(t));
  if (!en.length || !mr.length) return map;
  const next = { ...map };
  if (en.length > 1) next[en.join(' ')] = mr.join(' ');
  if (en.length === mr.length) {
    en.forEach((w, i) => { if (/^[a-z][a-z'&-]*$/.test(w)) next[w] = mr[i]; });
  } else if (en.length === 1) {
    next[en[0]] = mr.join(' ');
  }
  return next;
};

// ── Duplicates ───────────────────────────────────────────────────────────────

export interface DupCandidate {
  id: string; barcode?: string; name_eng?: string; name_marathi?: string; name?: string; net_qty?: string;
}

const normName = (s: string | undefined) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const normQty = (q: string | undefined) => qtyEng(q) || '';

/** Size from an existing name ("parivar 250g" → "250g"), for items saved before net_qty existed. */
const qtyFromName = (nameEng: string | undefined) => {
  const m = /(\d+(?:\.\d+)?)\s*(kg|g|gm|ml|ltr|l)\b/i.exec(nameEng || '');
  if (!m) return '';
  const u = m[2].toLowerCase();
  return m[1] + (u === 'gm' ? 'g' : u === 'l' ? 'ltr' : u);
};

export const findDuplicate = <T extends DupCandidate>(
  item: { barcode?: string; name_eng?: string; name_marathi?: string; net_qty?: string },
  inventory: T[],
): { item: T; reason: 'barcode' | 'name' } | null => {
  const bc = (item.barcode || '').trim();
  if (bc) {
    const hit = inventory.find(i => (i.barcode || '').trim() === bc);
    if (hit) return { item: hit, reason: 'barcode' };
  }
  const en = normName(item.name_eng);
  const mr = normName(item.name_marathi);
  const q = normQty(item.net_qty) || qtyFromName(item.name_eng);
  const hit = inventory.find(i => {
    const sameName = (en && normName(i.name_eng) === en) || (mr && normName(i.name_marathi || i.name) === mr);
    if (!sameName) return false;
    const iq = normQty(i.net_qty) || qtyFromName(i.name_eng);
    return iq === q;
  });
  return hit ? { item: hit, reason: 'name' } : null;
};
