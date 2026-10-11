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

/** "250 g" → "250g", "1 kg" → "1kg", "500 ml" → "500ml", "1 L" → "1l" */
export const qtyEng = (netQty: string | undefined | null): string => {
  const q = parseQty(netQty);
  if (!q) return '';
  return q.n + q.u;   // shop style: 250g, 1kg, 500ml, 1l
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
  'nivea': 'निव्हिया', "pond's": 'पॉन्ड्स', 'ponds': 'पॉन्ड्स', 'vaseline': 'व्हॅसलीन', 'boroline': 'बोरोलीन',
  'vicks': 'व्हिक्स', 'zandu': 'झंडू', 'iodex': 'आयोडेक्स', 'moov': 'मूव्ह', 'dabur amla': 'डाबर आवळा',
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
  // medicines and cosmetics
  'tablet': 'टॅबलेट', 'capsule': 'कॅप्सूल', 'syrup': 'सिरप', 'ointment': 'मलम', 'lotion': 'लोशन', 'balm': 'बाम',
  'gel': 'जेल', 'drops': 'ड्रॉप्स', 'spray': 'स्प्रे', 'care': 'केअर', 'body': 'बॉडी', 'face': 'फेस',
  'facewash': 'फेसवॉश', 'strength': 'स्ट्रेंथ', 'intensive': 'इंटेन्सिव्ह',
};

/**
 * Product names that must be transliterated as a whole, not translated word by word
 * ("aloo bhujia" is आलू भुजिया on the shelf, not बटाटा भुजिया; "dairy milk" is not दूध).
 * Checked before the word dictionary.
 */
export const PRODUCT_PHRASES: WordMap = {
  'aloo bhujia': 'आलू भुजिया', 'gokul': 'गोकुळ', 'bhujia sev': 'भुजिया शेव', 'navratan mix': 'नवरत्न मिक्स',
  'khatta meetha': 'खट्टा मीठा', 'soan papdi': 'सोनपापडी', 'aloo lachha': 'आलू लच्छा', 'chakli': 'चकली',
  'farsan': 'फरसाण', 'chivda': 'चिवडा', 'bakarwadi': 'बाकरवडी', 'shrikhand': 'श्रीखंड',
  'gulab jamun': 'गुलाबजाम', 'rasgulla': 'रसगुल्ला', 'kaju katli': 'काजू कतली', 'dairy milk': 'डेअरी मिल्क',
  'milk bikis': 'मिल्क बिकीस', 'hide & seek': 'हाइड अँड सीक', 'pav bhaji masala': 'पावभाजी मसाला',
  'chole masala': 'छोले मसाला', 'amul butter': 'अमूल बटर', 'moong dal namkeen': 'मूग डाळ नमकीन',
  // shop spellings that beat the dictionary meaning (inventory.json writes आटा, not गव्हाचे)
  'atta': 'आटा', 'chakki atta': 'चक्की आटा', 'dolo': 'डोलो',
  // medicines / OTC
  'neomycin': 'निओमायसिन', 'betadine': 'बीटाडीन', 'soframycin': 'सोफ्रामायसिन', 'vicks': 'व्हिक्स',
  'vaporub': 'व्हेपोरब', 'vicks vaporub': 'व्हिक्स व्हेपोरब', 'diclofenac': 'डायक्लोफेनॅक', 'crocin': 'क्रोसिन',
  'volini': 'व्होलिनी', 'iodex': 'आयोडेक्स', 'moov': 'मूव्ह', 'zandu balm': 'झंडू बाम', 'eno': 'इनो',
  'paracetamol': 'पॅरासिटामॉल', 'disprin': 'डिस्प्रिन', 'saridon': 'सॅरिडॉन', 'savlon': 'सॅव्हलॉन',
  'boroplus': 'बोरोप्लस', 'burnol': 'बर्नॉल', 'digene': 'डायजीन', 'hajmola': 'हाजमोला', 'pudin hara': 'पुदीन हरा',
  'strepsils': 'स्ट्रेप्सिल्स', 'electral': 'इलेक्ट्रॉल', 'chyawanprash': 'च्यवनप्राश', 'glucon-d': 'ग्लुकॉन-डी',
  // brands / variants
  'rajwadi': 'राजवाडी', 'kesh kanti': 'केश कांती', 'intensive care': 'इंटेन्सिव्ह केअर', 'easy wash': 'ईझी वॉश',
  'natural care': 'नॅचरल केअर', 'dark fantasy': 'डार्क फँटसी', 'tiger glucose': 'टायगर ग्लुकोज',
  'nutri choice': 'न्यूट्री चॉइस', 'little hearts': 'लिटल हार्ट्स', 'magic masala': 'मॅजिक मसाला',
  'fair & lovely': 'फेअर अँड लव्हली', 'glow & lovely': 'ग्लो अँड लव्हली', 'five star': 'फाइव्ह स्टार',
  'jim jam': 'जिम जॅम', 'tea premium': 'टी प्रीमियम', 'tea gold': 'टी गोल्ड', 'premium': 'प्रीमियम', 'natural': 'नॅचरल',
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
  if (PRODUCT_PHRASES[phrase]) return [PRODUCT_PHRASES[phrase], 'brand'];
  if (BRAND_MARATHI[phrase]) return [BRAND_MARATHI[phrase], 'brand'];
  if (HINGLISH_TO_MARATHI[phrase]) return [HINGLISH_TO_MARATHI[phrase], 'dictionary'];
  if (LOANWORDS[phrase]) return [LOANWORDS[phrase], 'loanword'];
  return null;
};

const singular = (w: string) =>
  w.endsWith('ies') ? w.slice(0, -3) + 'y' : w.endsWith('es') && w.length > 4 ? w.slice(0, -2) : w.endsWith('s') ? w.slice(0, -1) : w;

/**
 * English-spelled words (medicine and brand names: "neomycin", "diclofenac", "betadine") are respelled
 * the way they sound before transliteration. Romanized Marathi ("kesh", "rajwadi") is left alone.
 */
const respellEnglish = (w: string) => {
  if (!/c|x|q|ph/.test(w) && !/ine$/.test(w)) return w;
  return w
    .replace(/ph/g, 'f').replace(/ck/g, 'k').replace(/c(?=[eiy])/g, 's').replace(/c/g, 'k')
    .replace(/x/g, 'ks').replace(/q/g, 'k').replace(/(?<=.)y/g, 'i').replace(/ine$/, 'in');
};

// Marathi words ending in a consonant are written without a trailing halant ("गोकुल्" → "गोकुल")
const phonetic = (word: string) =>
  translateHinglishToMarathi(respellEnglish(word.replace(/[^a-z]/gi, '').toLowerCase())).replace(/्$/, '');

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
  add(maps.learned); add(maps.inventory); add(PRODUCT_PHRASES); add(BRAND_MARATHI); add(HINGLISH_TO_MARATHI);
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
    const unitEng: Record<string, string> = { 'ग्रॅम': 'g', 'ग्राम': 'g', 'किलो': 'kg', 'मिली': 'ml', 'लिटर': 'l' };
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
  return m[1] + (u === 'gm' ? 'g' : u === 'ltr' ? 'l' : u);
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

// ── Saved item (shop style) ──────────────────────────────────────────────────

const UNIT_CANON: Record<string, string> = { gm: 'g', g: 'g', kg: 'kg', ml: 'ml', ltr: 'l', l: 'l' };

/** "Parle-G Biscuits 250 G" → "parle-g biscuits 250g" (lowercase, size glued, like inventory.json). */
export const normalizeEngName = (s: string): string =>
  s.toLowerCase().replace(/\s+/g, ' ').trim()
    .replace(/(\d+(?:\.\d+)?)\s*(gm|g|kg|ml|ltr|l)(?![a-z])/g, (_, n: string, u: string) => qtyEng(`${n} ${UNIT_CANON[u]}`));

/** "पारले 250 g" → "पारले २५० ग्रॅम" (Devanagari digits and unit words, like inventory.json). */
export const normalizeMarathiName = (s: string): string =>
  toDevanagariDigits(
    s.replace(/\s+/g, ' ').trim()
      .replace(/(\d+(?:\.\d+)?)\s*(gm|g|kg|ml|ltr|l)(?![a-z])/gi, (_, n: string, u: string) => qtyMarathi(`${n} ${UNIT_CANON[u.toLowerCase()]}`)),
  );

export interface PhotoItemForm {
  name_marathi: string; name_eng: string; brand: string; unit: string; net_qty: string;
  mrp: string; price: string; stock: string; barcode: string; search_key?: string;
  expiry_date: string; mfg_date: string;
}

export interface SavedPhotoItem {
  id: string; name: string; name_marathi: string; name_eng: string; search_key: string;
  unit: string; price: number; purchase_price: number; stock_quantity: number; stock_qty: number;
  barcode: string; brand?: string; net_qty?: string; expiry_date?: string; mfg_date?: string;
}

/**
 * The object the photo flow saves. MRP → purchase_price (what the card and "X% सूट" badge read).
 * No undefined values: Firestore rejects them.
 */
export const buildPhotoItem = (form: PhotoItemForm, id: string): SavedPhotoItem => {
  const nameMr = normalizeMarathiName(form.name_marathi);
  const nameEn = normalizeEngName(form.name_eng);
  const stock = Number(form.stock) || 0;
  return {
    id,
    name: nameMr || nameEn,
    name_marathi: nameMr,
    name_eng: nameEn,
    search_key: form.search_key?.trim() || makeSearchKey(nameEn, nameMr),
    unit: form.unit || 'pcs',
    price: Number(form.price) || 0,
    purchase_price: Number(form.mrp) || 0,
    stock_quantity: stock,
    stock_qty: stock,
    barcode: form.barcode.trim(),
    ...(form.brand.trim() ? { brand: form.brand.trim() } : {}),
    ...(form.net_qty.trim() ? { net_qty: form.net_qty.trim() } : {}),
    ...(form.expiry_date ? { expiry_date: form.expiry_date } : {}),
    ...(form.mfg_date ? { mfg_date: form.mfg_date } : {}),
  };
};

// ── Short names for the receipt ──────────────────────────────────────────────
//
// Pack text is long ("Neomycin Sulphate Cream USP"); the receipt prints names as bitmap rows on a
// 58/80 mm printer, so items are saved under a short name ("neomycin cream 10g").
// The full text is kept in full_name_eng (searchable, low weight).

/** Change these to tune the receipt width. English: characters incl. size. Marathi: printed letters incl. size. */
export const SHORT_NAME_LIMITS = { eng: 28, marathi: 24 };

/** Always dropped. */
export const FILLER_WORDS = new Set([
  // marketing
  'original', 'premium', 'classic', 'new', 'special', 'pure', 'natural', 'fresh', 'best', 'quality', 'superior',
  'finest', 'rich', 'tasty', 'delicious', 'healthy', 'improved', 'perfect', 'genuine', 'authentic', 'traditional',
  'homestyle', 'real', 'true', 'nutritious', 'wholesome', 'goodness', 'trusted', 'favourite', 'favorite',
  'vacuum', 'evaporated', 'iodised', 'iodized', 'free-flowing', 'flowing', 'grade', 'export', 'imported', 'compounded',
  'germ', 'protection',   // tagline words ("germ protection")
  // packs and labels
  'family', 'value', 'pack', 'combo', 'approx', 'net', 'wt', 'weight', 'qty', 'quantity', 'contents', 'content',
  // glue words
  'the', 'of', 'a', 'an', 'for', 'and', 'in', 'with',
  // Hinglish
  'asli', 'naya', 'shuddh', 'shudh', 'khaas', 'khas',
]);

/** Marathi / Hindi filler words dropped from Devanagari-only names. */
export const FILLER_WORDS_MARATHI = new Set([
  'नवीन', 'नया', 'शुद्ध', 'प्रीमियम', 'ओरिजिनल', 'स्पेशल', 'फ्रेश', 'नॅचरल', 'असली', 'खास', 'सह', 'आणि', 'और', 'वाला',
]);

/** Medicine/cosmetic salt forms and pharmacopeia marks: "Neomycin Sulphate Cream USP" → "neomycin cream". */
export const PHARMA_SUFFIXES = new Set([
  'usp', 'u.s.p', 'ip', 'i.p', 'bp', 'b.p', 'nf', 'sulphate', 'sulfate', 'hydrochloride', 'hcl',
  'sodium', 'potassium', 'phosphate', 'acetate', 'maleate', 'citrate', 'dipropionate', 'propionate', 'monohydrate',
  'trihydrate', 'besylate', 'mesylate', 'succinate', 'tartrate',
]);

/** Company words: "Parle Products Pvt. Ltd." never belongs in an item name. */
export const COMPANY_WORDS = new Set([
  'pvt', 'private', 'ltd', 'limited', 'industries', 'foods', 'products', 'consumer', 'company', 'co',
  'corporation', 'corp', 'inc', 'llp', 'marketed', 'manufactured', 'by', 'mfd', 'mfg',
]);

/** Dropped only when the name is too long (first to go). */
export const SOFT_WORDS = new Set([
  'refined', 'anticavity', 'anti-cavity', 'herbal', 'ayurvedic', 'advanced', 'active', 'extra', 'super', 'ultra',
  'double', 'triple', 'crunchy', 'crispy', 'instant', 'dental', 'fortified', 'enriched', 'multipurpose', 'regular',
]);

/** Product-type words: the core of a name ("oil", "soap", "cream"…). Plurals are saved singular. */
export const TYPE_WORDS = new Set([
  'biscuit', 'cookie', 'cracker', 'wafer', 'rusk', 'cake', 'oil', 'soap', 'shampoo', 'conditioner', 'tea', 'coffee', 'salt',
  'sugar', 'toothpaste', 'paste', 'toothbrush', 'cream', 'ointment', 'gel', 'lotion', 'tablet', 'capsule', 'syrup', 'drops',
  'suspension', 'powder', 'masala', 'noodles', 'chips', 'atta', 'flour', 'besan', 'rava', 'dal', 'rice', 'poha', 'ghee',
  'butter', 'jam', 'sauce', 'ketchup', 'pickle', 'papad', 'namkeen', 'bhujia', 'handwash', 'facewash', 'detergent', 'bar',
  'liquid', 'cleaner', 'honey', 'juice', 'drink', 'milk', 'agarbatti', 'deodorant', 'talc', 'balm', 'spray', 'mix', 'sev',
  'chivda', 'vermicelli', 'shevaya', 'oats', 'cornflakes', 'chocolate',
]);
const SINGULAR: Record<string, string> = {
  biscuits: 'biscuit', cookies: 'cookie', crackers: 'cracker', wafers: 'wafer', tablets: 'tablet', capsules: 'capsule',
  soaps: 'soap', rusks: 'rusk', cakes: 'cake',
};

/** Medicine forms: the manufacturer is not part of the name. */
export const MEDICINE_FORMS = new Set(['cream', 'ointment', 'gel', 'tablet', 'capsule', 'syrup', 'drops', 'suspension', 'lotion', 'balm', 'spray']);

/** Parent companies / pharma makers: printed on packs but not the product's identity. */
export const NON_IDENTITY_BRANDS = new Set([
  'itc', 'hul', 'hindustan unilever', 'nestle', 'p&g', 'procter & gamble', 'reckitt', 'reckitt benckiser', 'marico',
  'adani wilmar', 'tata consumer', 'cipla', 'sun pharma', 'mankind', 'glenmark', 'gsk', 'glaxosmithkline', 'abbott',
  'pfizer', 'dr reddys', 'lupin', 'zydus', 'alkem', 'torrent', 'micro labs', 'intas', 'mylan',
]);

/** Sub-brands that carry the identity on their own: the parent brand is dropped ("britannia good day" → "good day"). */
export const SUB_BRANDS = [
  'good day', 'marie gold', 'milk bikis', 'bourbon', 'hide & seek', 'dairy milk', 'red label', 'dolo', 'dark fantasy',
  'tiger glucose', 'nutri choice', 'little hearts', 'five star', 'fair & lovely', 'glow & lovely', 'jim jam',
];

/**
 * Variant names that stay WITH the brand and are never split ("patanjali kesh kanti", "surf excel easy wash").
 * If brand + variant + size fits, the brand and variant are the identity and the type word may go.
 */
export const VARIANT_PHRASES = [
  'kesh kanti', 'intensive care', 'easy wash', 'quick wash', 'natural care', 'magic masala', 'masala munch',
  'strong teeth', 'active salt', 'max fresh', 'total 10', 'tea premium', 'tea gold',
];

/** Normally fillers, but kept (as soft words) right after the brand: "Tata Tea Premium", "Wagh Bakri Premium". */
const KEEP_AFTER_BRAND = new Set(['natural', 'premium']);

/** The brand already says what the product is, so the type word may go when space is short. */
export const BRAND_IMPLIES: Record<string, string> = {
  colgate: 'toothpaste', pepsodent: 'toothpaste', 'close up': 'toothpaste', sensodyne: 'toothpaste', meswak: 'toothpaste',
  lux: 'soap', lifebuoy: 'soap', santoor: 'soap', medimix: 'soap', cinthol: 'soap', pears: 'soap', hamam: 'soap',
  maggi: 'noodles', yippee: 'noodles', 'parle-g': 'biscuit', 'surf excel': 'detergent', nirma: 'detergent',
  ghadi: 'detergent', tide: 'detergent', ariel: 'detergent', 'clinic plus': 'shampoo', sunsilk: 'shampoo',
  'head & shoulders': 'shampoo', parachute: 'oil', kurkure: 'namkeen',
};

const DEV_MARKS = new Set([
  ...Array.from({ length: 4 }, (_, i) => 0x0900 + i),          // candrabindu, anusvara, visarga
  ...Array.from({ length: 3 }, (_, i) => 0x093a + i),          // vowel signs, nukta
  ...Array.from({ length: 0x094f - 0x093e + 1 }, (_, i) => 0x093e + i),   // matras, virama
  ...Array.from({ length: 7 }, (_, i) => 0x0951 + i), 0x0962, 0x0963,
]);

/** Printed width of Devanagari text: matras, virama, nukta and anusvara share the base letter's column. */
export const printedLength = (s: string): number => [...s].filter(c => !DEV_MARKS.has(c.codePointAt(0)!)).length;

const SIZE_TOKEN = /^(\d+(?:\.\d+)?)(g|gm|gms|gram|grams|kg|kgs|ml|l|ltr|litre|liter)$/;
const SIZE_UNIT: Record<string, string> = { gm: 'g', gms: 'g', gram: 'g', grams: 'g', kgs: 'kg', ltr: 'l', litre: 'l', liter: 'l' };

export interface ShortName {
  /** final short English name, shop style: "neomycin cream 10g" */
  eng: string;
  /** kept product words without brand/size: ["neomycin", "cream"] */
  words: string[];
  brand: string | null;
  size: string;            // shop style "10g", "" when unknown
  core: string | null;     // the word that must never be dropped
  full: string;            // cleaned long name, lowercase, size glued
  dropped: string[];
  unsure: boolean;
}

interface Tok { w: string; kind: 'sub' | 'variant' | 'type' | 'soft' | 'num' | 'word' }

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Shorten a product name read from a pack (may span several OCR lines).
 * Deterministic: same input → same output. `learnedDrops` holds words the user removed before.
 */
export const shortenProductName = (
  parsedName: string | null | undefined,
  brand: string | null | undefined,
  netQty: string | null | undefined,
  learnedDrops: ReadonlySet<string> = new Set(),
  limit = SHORT_NAME_LIMITS.eng,
): ShortName => {
  const brandLc = (brand || '').toLowerCase().trim();
  const raw = (parsedName || '').toLowerCase().replace(/[®™©]/g, ' ').replace(/\b\d+\s*%/g, ' ');   // "100% pure"
  const lines = raw.split(/\n+/).map(l => l.replace(/[^a-z0-9&'.\- ]/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);

  let size = qtyEng(netQty);
  const dropped: string[] = [];
  const tokens: string[] = [];
  for (const line of lines) {
    let ws = line.split(' ').map(w => w.replace(/^[.'-]+|[.'-]+$/g, '')).filter(Boolean);
    // "… enriched with iron" / "… with goodness of milk" after the product type is a tagline: drop the rest
    const withAt = ws.findIndex(w => w === 'with' || w === 'enriched' || w === 'fortified');
    if (withAt > 0 && ws.slice(0, withAt).some(w => TYPE_WORDS.has(SINGULAR[w] ?? w))) {
      dropped.push(...ws.slice(withAt));
      ws = ws.slice(0, withAt);
    }
    // join "10 g" → "10g"
    for (let i = 0; i < ws.length - 1; i++) {
      if (/^\d+(\.\d+)?$/.test(ws[i]) && SIZE_TOKEN.test('1' + ws[i + 1])) { ws[i] += ws[i + 1]; ws.splice(i + 1, 1); }
    }
    tokens.push(...ws);
  }
  const sizeOf = (w: string) => {
    const m = SIZE_TOKEN.exec(w);
    return m ? qtyEng(`${m[1]} ${SIZE_UNIT[m[2]] ?? m[2]}`) : '';
  };
  if (!size) size = tokens.map(sizeOf).find(Boolean) ?? '';

  // Remove the brand wherever it appears (it is placed once, in front)
  let text = ' ' + tokens.filter(t => !SIZE_TOKEN.test(t)).join(' ') + ' ';
  const fullBody = text.trim();
  if (brandLc) {
    for (const v of new Set([brandLc, brandLc.replace(/-/g, ' '), brandLc.replace(/'/g, ''), brandLc.replace(/ /g, '')])) {
      text = text.replace(new RegExp(` ${escRe(v)}(?= )`, 'g'), ' ');
    }
  }
  const full = [brandLc, brandLc ? text.trim() : fullBody, size].filter(Boolean).join(' ').replace(/\s+/g, ' ');

  const toks: Tok[] = [];
  const seen = new Set<string>();
  const words = text.trim().split(' ').filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    const two = `${words[i]} ${words[i + 1] ?? ''}`.trim();
    const three = `${two} ${words[i + 2] ?? ''}`.trim();
    const match = (list: string[]) => list.find(x => x === words[i] || x === two || x === three);
    const sub = match(SUB_BRANDS);
    const variant = sub ? undefined : match(VARIANT_PHRASES);
    if (sub || variant) {
      const phrase = (sub || variant)!;
      if (!seen.has(phrase)) { toks.push({ w: phrase, kind: sub ? 'sub' : 'variant' }); seen.add(phrase); }
      i += phrase.split(' ').length - 1;
      continue;
    }
    const w = SINGULAR[words[i]] ?? words[i];
    const firstIsType = TYPE_WORDS.has(SINGULAR[words[0]] ?? words[0]);
    if (KEEP_AFTER_BRAND.has(w) && brandLc && (i === 0 || (i === 1 && firstIsType)) && !seen.has(w)) {
      seen.add(w);
      toks.push({ w, kind: 'soft' });   // kept, but the first to go when the name is too long
      continue;
    }
    if (FILLER_WORDS.has(w) || PHARMA_SUFFIXES.has(w) || COMPANY_WORDS.has(w) || learnedDrops.has(w)) { dropped.push(w); continue; }
    if (seen.has(w)) { dropped.push(w); continue; }   // repeated word ("salt … salt")
    seen.add(w);
    toks.push({ w, kind: TYPE_WORDS.has(w) ? 'type' : SOFT_WORDS.has(w) ? 'soft' : /\d/.test(w) ? 'num' : 'word' });
  }

  // Brand: kept when it is the product's identity
  const hasSub = toks.some(t => t.kind === 'sub');
  const isMedicine = toks.some(t => MEDICINE_FORMS.has(t.w));
  let keepBrand: string | null = brandLc || null;
  if (keepBrand && (NON_IDENTITY_BRANDS.has(keepBrand) || hasSub)) { dropped.push(keepBrand); keepBrand = null; }
  // A medicine named by its active ingredient does not need an unknown maker's name
  if (keepBrand && isMedicine && !BRAND_MARATHI[keepBrand] && toks.some(t => t.kind === 'word')) {
    dropped.push(keepBrand); keepBrand = null;
  }

  // Brand (or sub-brand) + variant is the identity when it fits; otherwise the variant is ordinary words
  const variantToks = toks.filter(t => t.kind === 'variant');
  const identityLen = [keepBrand, ...toks.filter(t => t.kind === 'sub' || t.kind === 'variant').map(t => t.w), size]
    .filter(Boolean).join(' ').length;
  const identityVariant = variantToks.length > 0 && (!!keepBrand || hasSub) && identityLen <= limit;
  if (!identityVariant) variantToks.forEach(t => { t.kind = 'word'; });

  // Core word: the product type, unless the brand already implies it; else the first name word
  const implied = keepBrand ? BRAND_IMPLIES[keepBrand] : undefined;
  const typeTok = toks.find(t => t.kind === 'type' && t.w !== implied);
  // When the brand alone says what the product is (Colgate, Head & Shoulders), the brand is the core
  // A fitting brand + variant ("surf excel easy wash") is the core itself
  const core = identityVariant ? null : typeTok?.w
    ?? (implied ? null : toks.find(t => t.kind === 'sub' || t.kind === 'word' || t.kind === 'num')?.w)
    ?? (implied ? null : toks.find(t => t.kind === 'type')?.w) ?? null;

  const build = (ts: Tok[], b: string | null) => [b, ...ts.map(t => t.w), size].filter(Boolean).join(' ');
  let kept = [...toks];
  let unsure = !toks.some(t => t.kind === 'type') && !keepBrand && !hasSub;   // nothing says what this is
  const tooLong = () => build(kept, keepBrand).length > limit;
  const drop = (pred: (t: Tok) => boolean, fromEnd = true) => {
    const order = fromEnd ? [...kept].reverse() : kept;
    const t = order.find(x => x.w !== core && pred(x));
    if (!t) return false;
    kept = kept.filter(x => x !== t);
    dropped.push(t.w);
    return true;
  };
  // 1) soft adjectives  2) the type word the brand implies  3) other words from the end (marks unsure)
  while (tooLong() && drop(t => t.kind === 'soft', false)) { /* keep dropping */ }
  if (tooLong() && implied) drop(t => t.w === implied);
  while (tooLong() && drop(t => t.kind === 'word' || t.kind === 'type')) unsure = unsure || !identityVariant;
  if (tooLong() && keepBrand) { dropped.push(keepBrand); keepBrand = null; unsure = true; }
  while (tooLong() && drop(() => true)) unsure = true;

  // A connector left at either end after dropping ("strength & 6ml") goes too
  const isGlue = (t: Tok) => t.w === '&' || t.w === 'and' || t.w === '+';
  while (kept.length && isGlue(kept[kept.length - 1])) dropped.push(kept.pop()!.w);
  while (kept.length && isGlue(kept[0])) dropped.push(kept.shift()!.w);

  // Unsure: brand + the 2 most prominent words (core included) + size
  if (unsure && kept.length > 2) {
    const coreTok = kept.find(t => t.w === core);
    const others = kept.filter(t => t !== coreTok).slice(0, coreTok ? 1 : 2);
    const two = [...others, ...(coreTok ? [coreTok] : [])].sort((a, b) => kept.indexOf(a) - kept.indexOf(b));
    dropped.push(...kept.filter(t => !two.includes(t)).map(t => t.w));
    kept = two;
  }

  return { eng: build(kept, keepBrand), words: kept.map(t => t.w), brand: keepBrand, size, core, full, dropped, unsure };
};

export interface ShortBilingual {
  name_eng: string;
  name_marathi: string;
  /** the long cleaned name, '' when it equals the short one */
  full_name_eng: string;
  unsure: boolean;
  dropped: string[];
  mrPhonetic: string[];
}

/** Words the user removed from suggested names before (stored in the learned map as "!drop:<word>"). */
export const learnedDropWords = (learned: WordMap): Set<string> =>
  new Set(Object.keys(learned).filter(k => k.startsWith('!drop:')).map(k => k.slice(6)));

/**
 * Short English name first, then the Marathi name built word by word from it (never a cut long string).
 * If the Marathi is still too wide, one more English word is dropped and both are rebuilt.
 */
export const shortBilingualName = (
  input: { brand?: string | null; productEng?: string | null; productDev?: string | null; netQty?: string | null },
  maps: NameMaps,
): ShortBilingual => {
  const drops = learnedDropWords(maps.learned);
  const qtyMr = qtyMarathi(input.netQty);

  if (!input.productEng?.trim() && input.productDev?.trim()) {
    // Only Devanagari was read: drop filler words, then whole words from the end
    const brandMr = input.brand ? englishToMarathi(input.brand.toLowerCase(), maps).text : '';
    const brandWords = new Set(brandMr.split(' '));
    let ws = hindiToMarathi(input.productDev.trim()).text.split(/\s+/)
      .filter(w => w && !FILLER_WORDS_MARATHI.has(w) && !brandWords.has(w));
    const mk = (xs: string[]) => [brandMr, ...xs, qtyMr].filter(Boolean).join(' ');
    let unsure = false;
    while (ws.length > 1 && printedLength(mk(ws)) > SHORT_NAME_LIMITS.marathi) { ws = ws.slice(0, -1); unsure = true; }
    const mr = mk(ws);
    const en = marathiToEnglish(mr, maps);
    return {
      name_eng: normalizeEngName(en.text), name_marathi: normalizeMarathiName(mr), full_name_eng: '',
      unsure: unsure || en.phoneticWords.length > 0, dropped: [], mrPhonetic: [],
    };
  }

  // Synonyms that become the same Marathi word ("hing asafoetida" → हिंग हिंग): keep the first only
  const synonymDrops = new Set(drops);
  for (let guard = 0; guard < 5; guard++) {
    const s = shortenProductName(input.productEng, input.brand, input.netQty, synonymDrops);
    const seenMr = new Map<string, string>();
    let found = false;
    for (const w of s.words) {
      const mr = englishToMarathi(w, maps).text;
      if (seenMr.has(mr) && seenMr.get(mr) !== w) { synonymDrops.add(w); found = true; } else seenMr.set(mr, w);
    }
    if (!found) break;
  }

  let last: ShortBilingual | null = null;
  for (let limit = SHORT_NAME_LIMITS.eng; limit >= 8; limit--) {
    const s = shortenProductName(input.productEng, input.brand, input.netQty, synonymDrops, limit);
    const brandMr = s.brand ? englishToMarathi(s.brand, maps) : null;
    const body = s.words.length ? englishToMarathi(s.words.join(' '), maps) : null;
    const mr = [brandMr?.text, body?.text, qtyMr].filter(Boolean).join(' ');
    last = {
      name_eng: s.eng,
      name_marathi: normalizeMarathiName(mr),
      full_name_eng: s.full !== s.eng ? s.full : '',
      unsure: s.unsure || limit < SHORT_NAME_LIMITS.eng,
      dropped: s.dropped,
      mrPhonetic: [...(brandMr?.phoneticWords ?? []), ...(body?.phoneticWords ?? [])],
    };
    if (printedLength(last.name_marathi) <= SHORT_NAME_LIMITS.marathi || s.words.length <= 1) return last;
  }
  return last!;
};

/**
 * The user removed words from a suggested name before saving: remember them as "!drop:<word>" so the same
 * filler is dropped next time. Uses the word-by-word pairing of the suggested names.
 */
export const learnDroppedWords = (
  map: WordMap,
  suggested: { name_eng: string; name_marathi: string },
  final: { name_marathi: string },
): WordMap => {
  const en = stripTokens(suggested.name_eng, false);
  const mr = stripTokens(suggested.name_marathi, true).filter(t => /[ऀ-ॿ]/.test(t));
  const finalMr = new Set(stripTokens(final.name_marathi, true));
  if (!en.length || en.length !== mr.length || !finalMr.size) return map;
  let next = map;
  en.forEach((w, i) => {
    if (!finalMr.has(mr[i]) && /^[a-z][a-z'-]+$/.test(w) && !TYPE_WORDS.has(w) && !BRAND_MARATHI[w]) {
      if (next === map) next = { ...map };
      next[`!drop:${w}`] = '1';
    }
  });
  return next;
};
