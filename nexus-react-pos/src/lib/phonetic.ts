import Sanscript from '@sanskrit-coders/sanscript';

// ─────────────────────────────────────────────────────────────────────────────
// Devanagari brand name → lowercase English brand key
// Lets users type "टाटा" and match against English "Tata" in inventory
// ─────────────────────────────────────────────────────────────────────────────
export const BRAND_DEVANAGARI_MAP: Record<string, string> = {
  'टाटा': 'tata',
  'अमूल': 'amul',
  'नेस्ले': 'nestle', 'नेस्ला': 'nestle',
  'कोलगेट': 'colgate',
  'पतंजली': 'patanjali',
  'ब्रिटानिया': 'britannia',
  'गोदरेज': 'godrej',
  'मैगी': 'maggi',
  'लिप्टन': 'lipton',
  'सर्फ': 'surf',
  'एरियल': 'ariel',
  'डेटॉल': 'dettol',
  'हार्पिक': 'harpic',
  'लाइफबॉय': 'lifebuoy',
  'लक्स': 'lux',
  'डव': 'dove',
  'एमडीएच': 'mdh',
  'एव्हरेस्ट': 'everest',
  'बादशाह': 'badshah',
  'फॉर्च्यून': 'fortune',
  'धारा': 'dhara',
  'सफोला': 'saffola',
  'रुची': 'ruchi',
  'आयटीसी': 'itc',
  'हिंदुस्तान': 'hindustan',
  'आनंद': 'anand',
};

// ─────────────────────────────────────────────────────────────────────────────
// Hinglish → Marathi dictionary
// ─────────────────────────────────────────────────────────────────────────────
export const HINGLISH_TO_MARATHI: Record<string, string> = {
  "chaha": "चहा", "chai": "चहा", "cha": "चहा", "tea": "चहा",
  "dudh": "दूध", "doodh": "दूध", "milk": "दूध",
  "sakhar": "साखर", "shakkar": "साखर", "shakhar": "साखर", "sakkar": "साखर",
    "shakar": "साखर", "sugar": "साखर", "suger": "साखर", "chini": "साखर",
  "tandul": "तांदूळ", "tandool": "तांदूळ", "taandul": "तांदूळ", "rice": "तांदूळ",
  "meet": "मीठ", "mith": "मीठ", "namak": "मीठ", "salt": "मीठ",
  "tel": "तेल", "oil": "तेल",
  "tup": "तूप", "ghee": "तूप", "ghi": "तूप", "toop": "तूप",
  "atta": "गव्हाचे", "aata": "गव्हाचे", "wheat": "गहू", "gehu": "गहू", "gahu": "गहू",
  "maida": "मैदा", "flour": "पीठ", "pith": "पीठ", "peet": "पीठ",
  "rava": "रवा", "sooji": "रवा", "suji": "रवा", "semolina": "रवा",
  "besan": "बेसन",
  "pohe": "पोहे", "poha": "पोहे",
  "halad": "हळद", "haldi": "हळद", "haladi": "हळद", "turmeric": "हळद",
  "mirchi": "मिरची", "mirch": "मिरची", "mircha": "मिरची",
    "chilli": "मिरची", "chili": "मिरची",
  "lal": "लाल", "laal": "लाल",
  "jeera": "जिरे", "jira": "जिरे", "zeera": "जिरे", "cumin": "जिरे",
  "mohari": "मोहरी", "mustard": "मोहरी",
  "dhane": "धने", "dhana": "धने", "coriander": "धने",
  "methi": "मेथी", "fenugreek": "मेथी",
  "masala": "मसाला",
  "velchi": "वेलची", "elaichi": "वेलची", "cardamom": "वेलची",
  "lavang": "लवंग", "clove": "लवंग",
  "dalchini": "दालचिनी", "cinnamon": "दालचिनी",
  "dal": "डाळ", "daal": "डाळ", "lentil": "डाळ",
  "moong": "मूग", "mung": "मूग",
  "toor": "तूर", "tur": "तूर", "arhar": "तूर",
  "masoor": "मसूर",
  "udid": "उडीद", "urad": "उडीद",
  "chana": "हरभरा", "harbhara": "हरभरा", "chickpea": "हरभरा",
  "vatana": "वाटाणा", "matar": "वाटाणा", "peas": "वाटाणा",
  "kaju": "काजू", "cashew": "काजू",
  "badam": "बदाम", "almond": "बदाम",
  "shingdana": "शेंगदाणा", "shengdana": "शेंगदाणा",
    "peanut": "शेंगदाणा", "groundnut": "शेंगदाणा",
  "gud": "गूळ", "gul": "गूळ", "jaggery": "गूळ", "gur": "गूळ",
  "sabudana": "साबुदाणा", "sabodana": "साबुदाणा", "sago": "साबुदाणा",
  "naral": "नारळ", "coconut": "नारळ", "nariyal": "नारळ",
  "kanda": "कांदा", "onion": "कांदा", "pyaz": "कांदा",
  "batata": "बटाटा", "aloo": "बटाटा", "potato": "बटाटा",
  "tomato": "टोमॅटो", "tamatar": "टोमॅटो",
  "lasun": "लसूण", "garlic": "लसूण", "lahsun": "लसूण",
  "aale": "आले", "adrak": "आले", "ginger": "आले",
  "palak": "पालक", "spinach": "पालक",
  "kobi": "कोबी", "cabbage": "कोबी",
  "flower": "फ्लॉवर", "cauliflower": "फ्लॉवर",
  "vangi": "वांगी", "brinjal": "वांगी", "eggplant": "वांगी",
  "dahi": "दही", "curd": "दही", "yogurt": "दही",
  "paneer": "पनीर",
  "loni": "लोणी", "butter": "लोणी",
  "shevaya": "शेवया", "vermicelli": "शेवया",
  "biscuit": "बिस्किट", "biskut": "बिस्किट",
  "soap": "साबण", "saban": "साबण", "sabun": "साबण",
  "shampoo": "शॅम्पू",
  "toothpaste": "टूथपेस्ट", "dantmanjan": "दंतमंजन",
  "powder": "पावडर",
};

// ─────────────────────────────────────────────────────────────────────────────
// Unit normalization maps  (Marathi script → canonical, English → canonical)
// ─────────────────────────────────────────────────────────────────────────────
const MR_UNIT_MAP: Record<string, string> = {
  'ग्राम': 'g', 'ग्रॅम': 'g', 'ग्रा': 'g',
  'किलो': 'kg', 'किलोग्राम': 'kg', 'कि': 'kg',
  'मिली': 'ml', 'मिलि': 'ml', 'मिलीलिटर': 'ml', 'मिलिलिटर': 'ml',
  'लिटर': 'l', 'लीटर': 'l', 'ली': 'l',
  'नग': 'pcs', 'पीस': 'pcs', 'पिस': 'pcs',
  'पॅकेट': 'pack', 'पाकीट': 'pack',
};

const EN_UNIT_MAP: Record<string, string> = {
  'g': 'g', 'gm': 'g', 'gram': 'g', 'grams': 'g',
  'kg': 'kg', 'kilo': 'kg', 'kilogram': 'kg', 'kilograms': 'kg', 'kilos': 'kg',
  'ml': 'ml', 'mililitre': 'ml', 'millilitre': 'ml', 'milliliter': 'ml', 'millilit': 'ml',
  'l': 'l', 'ltr': 'l', 'liter': 'l', 'litre': 'l', 'lit': 'l',
  'mg': 'mg',
  'pcs': 'pcs', 'pc': 'pcs', 'piece': 'pcs', 'pieces': 'pcs', 'nos': 'pcs',
  'pack': 'pack', 'packet': 'pack', 'pkt': 'pack',
  'box': 'box', 'bottle': 'bottle', 'btl': 'bottle',
  'tab': 'tab', 'tablet': 'tab',
};

// ─────────────────────────────────────────────────────────────────────────────
// Parsed query type
// ─────────────────────────────────────────────────────────────────────────────
export interface ParsedQuery {
  cleanQuery: string;                                      // product name after stripping signals
  brandHint:  string | null;                              // matched brand (lowercase)
  unitQty:    number | null;                              // e.g. 100
  unitType:   string | null;                              // e.g. "g"
  unitHint:   string | null;                              // combined "100g"
  priceHint:  { value: number; field: 'mrp' | 'sale' } | null;
  isMarathi:  boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// parseUserQuery — extract structured signals from a natural-language query
// Works for English, Hinglish, and Marathi (Devanagari) input
// ─────────────────────────────────────────────────────────────────────────────

// Fractional quantity words → multiplier (applied against kg/l → g/ml)
const FRAC_MAP: Record<string, number> = {
  'pauney': 0.75, 'paune': 0.75, 'paun': 0.75,
  'aadha': 0.5, 'ardha': 0.5, 'adha': 0.5, 'half': 0.5,
  'dedh': 1.5, 'deedh': 1.5, 'dhed': 1.5,
  'paav': 0.25, 'pav': 0.25,
  'पाऊण': 0.75, 'पाऊने': 0.75,
  'अर्धा': 0.5, 'अर्ध': 0.5,
  'दीड': 1.5,
  'पाव': 0.25,
};

// Base units that follow fractional words
const FRAC_BASE: Record<string, 'kg' | 'l'> = {
  'kilograms': 'kg', 'kilogram': 'kg', 'kilos': 'kg', 'kilo': 'kg', 'kg': 'kg',
  'किलोग्राम': 'kg', 'किलो': 'kg',
  'litres': 'l', 'liters': 'l', 'litre': 'l', 'liter': 'l', 'ltr': 'l', 'lit': 'l', 'l': 'l',
  'लिटर': 'l', 'लीटर': 'l',
};

export const parseUserQuery = (query: string, brandIndex: Set<string>): ParsedQuery => {
  let w = query.trim();
  const isMarathi = /[ऀ-ॿ]/.test(w);   // contains Devanagari?

  let priceHint:  ParsedQuery['priceHint']  = null;
  let unitQty:    number | null = null;
  let unitType:   string | null = null;
  let unitHint:   string | null = null;
  let brandHint:  string | null = null;

  // ── 1. Extract price signal ────────────────────────────────────────────────
  const pricePatterns: Array<[RegExp, 'mrp' | 'sale']> = [
    [/(?:एमआरपी|mrp)\s*:?\s*₹?\s*(\d+(?:\.\d+)?)/gi, 'mrp'],
    [/(?:भाव|किंमत|दर|विक्री|rate|price|selling)\s*:?\s*₹?\s*(\d+(?:\.\d+)?)/gi, 'sale'],
    [/₹\s*(\d+(?:\.\d+)?)/g, 'sale'],
    [/(\d+(?:\.\d+)?)\s*(?:रुपये|रु\.?|rs\.?|rupees?)/gi, 'sale'],
  ];
  for (const [re, field] of pricePatterns) {
    const m = re.exec(w);
    if (m) {
      priceHint = { value: parseFloat(m[1]), field };
      w = w.replace(m[0], ' ');
      break;
    }
  }

  // ── 1.5: Fractional quantity words ────────────────────────────────────────
  // "paav kilo" → 250g | "aadha kilo" → 500g | "paun kilo" → 750g | "dedh kilo" → 1500g
  // "पाव किलो" → 250g | "अर्धा किलो" → 500g | "पाऊण किलो" → 750g | "दीड किलो" → 1500g
  const fracKeysSorted = Object.keys(FRAC_MAP).sort((a, b) => b.length - a.length).join('|');
  const fracBasesSorted = Object.keys(FRAC_BASE).sort((a, b) => b.length - a.length).join('|');
  const fracRe = new RegExp(`(${fracKeysSorted})\\s*(${fracBasesSorted})?(?=[\\s,;.।\\u0964]|$)`, 'i');
  const fracM = fracRe.exec(w);
  if (fracM) {
    const frac = FRAC_MAP[fracM[1]] ?? FRAC_MAP[fracM[1].toLowerCase()] ?? 0.25;
    const baseRaw = (fracM[2] || 'kg').toLowerCase();
    const baseType = FRAC_BASE[baseRaw] ?? 'kg';
    unitQty  = Math.round(frac * 1000);
    unitType = baseType === 'l' ? 'ml' : 'g';
    unitHint = `${unitQty}${unitType}`;
    w = w.replace(fracM[0], ' ');
  }

  // ── 2. Extract unit/weight signal (numeric) ────────────────────────────────
  // Matches: "100g", "100 gram", "100 ग्राम", "1.5 kg"
  if (!unitQty) {
    const mrUnitPattern = Object.keys(MR_UNIT_MAP).join('|');
    const enUnitPattern = Object.keys(EN_UNIT_MAP).join('|');
    const unitRe = new RegExp(
      `(\\d+(?:\\.\\d+)?)\\s*(${mrUnitPattern}|${enUnitPattern})(?=[\\s,;.\\u0964]|$)`,
      'gi'
    );
    const um = unitRe.exec(w);
    if (um) {
      unitQty  = parseFloat(um[1]);
      const raw = um[2];
      unitType = MR_UNIT_MAP[raw] ?? EN_UNIT_MAP[raw.toLowerCase()] ?? raw.toLowerCase();
      unitHint = `${unitQty}${unitType}`;
      w = w.replace(um[0], ' ');
    }
  }

  // ── 3. Extract brand signal (Devanagari and Latin tokens both supported) ───
  const tokens = w.trim().split(/\s+/).filter(t => t.length >= 1);
  for (const token of tokens) {
    const isDevToken = /[ऀ-ॿ]/.test(token);

    if (isDevToken) {
      // Direct Devanagari match (brands stored in Marathi)
      if (brandIndex.has(token)) {
        brandHint = token;
        w = w.replace(token, ' ');
        break;
      }
      // Lookup via Devanagari→English map (brands stored in English like "Tata")
      const engKey = BRAND_DEVANAGARI_MAP[token];
      if (engKey && brandIndex.has(engKey)) {
        brandHint = engKey;
        w = w.replace(token, ' ');
        break;
      }
      // Prefix/partial match in brandIndex
      if (token.length >= 2) {
        for (const b of brandIndex) {
          if (b === token || b.startsWith(token) || token.startsWith(b)) {
            brandHint = b;
            w = w.replace(token, ' ');
            break;
          }
        }
        if (brandHint) break;
      }
    } else {
      // Latin token
      const lw = token.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!lw || lw.length < 2) continue;
      if (brandIndex.has(lw)) {
        brandHint = lw;
        w = w.replace(new RegExp(`\\b${token}\\b`, 'gi'), ' ');
        break;
      }
      if (lw.length >= 3) {
        for (const b of brandIndex) {
          if (b.startsWith(lw) || lw.startsWith(b)) {
            brandHint = b;
            w = w.replace(new RegExp(`\\b${token}\\b`, 'gi'), ' ');
            break;
          }
        }
        if (brandHint) break;
      }
    }
  }

  const cleanQuery = w.replace(/\s+/g, ' ').trim();

  return { cleanQuery, brandHint, unitQty, unitType, unitHint, priceHint, isMarathi };
};

// ─────────────────────────────────────────────────────────────────────────────
// scoreCandidate — how well does an inventory item match the parsed signals?
// Higher = better match.  Name fuzzy score is handled separately by Fuse.
// ─────────────────────────────────────────────────────────────────────────────
export const scoreCandidate = (
  item: { price?: number; purchase_price?: number; unit?: string; brand?: string },
  parsed: ParsedQuery
): number => {
  let score = 0;

  // Brand
  if (parsed.brandHint) {
    const ib = (item.brand || '').toLowerCase();
    if (ib === parsed.brandHint)                                            score += 50;
    else if (ib.startsWith(parsed.brandHint) || parsed.brandHint.startsWith(ib)) score += 30;
    else if (ib.includes(parsed.brandHint))                                 score += 15;
  }

  // Unit (qty + type match against item.unit string)
  if (parsed.unitQty && parsed.unitType) {
    const iu = (item.unit || '').toLowerCase().replace(/\s+/g, '');
    const qtyStr = parsed.unitQty.toString();
    const hasQty  = iu.includes(qtyStr);
    const hasType = iu.includes(parsed.unitType);
    if (hasQty && hasType) score += 35;
    else if (hasQty)       score += 20;
    else if (hasType)      score += 8;
  }

  // Price (MRP or sale rate within tolerance bands)
  if (parsed.priceHint) {
    const { value, field } = parsed.priceHint;
    const itemPrice = field === 'mrp' ? (item.purchase_price || 0) : (item.price || 0);
    if (itemPrice > 0) {
      const diff = Math.abs(itemPrice - value) / value;
      if      (diff <= 0.02) score += 45;  // within 2% — nearly exact
      else if (diff <= 0.08) score += 30;  // within 8%
      else if (diff <= 0.20) score += 12;  // within 20%
    }
  }

  return score;
};

// ─────────────────────────────────────────────────────────────────────────────
// normalizeForSearch — collapse spelling variants to a common root
// ─────────────────────────────────────────────────────────────────────────────
export const normalizeForSearch = (text: string): string => {
  if (!text) return '';
  return text
    .toLowerCase()
    .replace(/aa/g, 'a').replace(/ee/g, 'i').replace(/oo/g, 'u')
    .replace(/ii/g, 'i').replace(/uu/g, 'u')
    .replace(/(.)\1+/g, '$1')   // sakkar → sakar
    .replace(/kh/g, 'k').replace(/gh/g, 'g').replace(/ph/g, 'f')
    .replace(/sh/g, 's').replace(/chh/g, 'c').replace(/ch/g, 'c')
    .trim();
};

// ─────────────────────────────────────────────────────────────────────────────
// translateHinglishToMarathi — romanized Hinglish → Devanagari
// ─────────────────────────────────────────────────────────────────────────────
export const translateHinglishToMarathi = (query: string): string => {
  if (!query) return '';
  const words = query.split(/\s+/);
  const translated = words.map(word => {
    if (!/^[a-zA-Z]+$/.test(word)) return word;
    const lower = word.toLowerCase();
    if (HINGLISH_TO_MARATHI[lower]) return HINGLISH_TO_MARATHI[lower];
    let itrans = word
      .replace(/aa/g, 'A').replace(/ee/g, 'I').replace(/oo/g, 'U')
      .replace(/sh/g, 'Sh').replace(/chh/g, 'Ch').replace(/ch/g, 'ch');
    try { return Sanscript.t(itrans, 'itrans', 'devanagari'); }
    catch { return word; }
  });
  return translated.join(' ');
};
