// Pure checks for the Gemini pack reader: the app's request and the model's answer.
// No Workers APIs here, so everything is unit-tested in plain Node (test/validate.test.ts).

export const MAX_BODY_BYTES = 1_500_000;
export const MAX_IMAGES = 5;

export type ReadField = 'name_eng' | 'name_marathi' | 'brand' | 'net_qty' | 'mrp' | 'mfg_date' | 'expiry_date' | 'barcode';
export const FIELDS: ReadField[] = ['name_eng', 'name_marathi', 'brand', 'net_qty', 'mrp', 'mfg_date', 'expiry_date', 'barcode'];

export interface PackRead {
  name_eng: string | null;
  name_marathi: string | null;
  brand: string | null;
  net_qty: string | null;    // "38 g", "1 kg", "500 ml", "1 L"
  mrp: number | null;
  mfg_date: string | null;   // yyyy-MM-dd
  expiry_date: string | null;
  barcode: string | null;    // checksum-valid digits only; the app treats it as an unverified suggestion
  confidence: Record<ReadField, number>;
}

// ── Request from the app ─────────────────────────────────────────────────────

const BODY_START = '{"images":["';
const BODY_END = '"]}';
const SEP = '","';

/**
 * The app sends exactly {"images":["<base64 JPEG>", ...]} (1–5). The photos are NOT JSON-parsed: JSON.parse and
 * JSON.stringify of ~1.5 MB of base64 take several ms, and the Workers free plan allows 10 ms CPU per request.
 * Native string scans instead: the body must contain no backslash and exactly the structural quotes, so each image
 * string is plain base64 and can be spliced into the Gemini request as it is.
 */
export const parseImagesBody = (body: string): { ok: true; images: string[] } | { ok: false; error: string } => {
  if (body.length > MAX_BODY_BYTES) return { ok: false, error: 'too_large' };
  if (!body.startsWith(BODY_START) || !body.endsWith(BODY_END) || body.indexOf('\\') >= 0) return { ok: false, error: 'bad_request' };
  const inner = body.slice(BODY_START.length, body.length - BODY_END.length);
  // Count quotes without scanning more than needed: a valid body has 2 per extra image
  let quotes = 0;
  for (let i = inner.indexOf('"'); i >= 0; i = inner.indexOf('"', i + 1)) if (++quotes > 2 * (MAX_IMAGES - 1)) return { ok: false, error: 'bad_image_count' };
  const images = inner.split(SEP);
  if (quotes !== 2 * (images.length - 1)) return { ok: false, error: 'bad_request' };
  if (images.length < 1 || images.length > MAX_IMAGES) return { ok: false, error: 'bad_image_count' };
  for (const im of images) {
    if (!im.startsWith('/9j/')) return { ok: false, error: 'not_jpeg' };   // base64 of the JPEG start bytes FF D8 FF
    if (/[^A-Za-z0-9+/=]/.test(im.slice(0, 64)) || /[^A-Za-z0-9+/=]/.test(im.slice(-64))) return { ok: false, error: 'not_jpeg' };
  }
  return { ok: true, images };
};

/** The app's request body for these photos (used by tests and by the app's Kotlin builder as the reference). */
export const imagesBody = (images: string[]) => BODY_START + images.join(SEP) + BODY_END;

// ── Model answer ─────────────────────────────────────────────────────────────

const clamp01 = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

const cleanText = (v: unknown, max = 120): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.replace(/\s+/g, ' ').trim();
  if (!s || s.length > max || /^(null|none|n\/a|unknown|-)$/i.test(s)) return null;
  return s;
};

/** "38gm" → "38 g", "1 Ltr" → "1 L", "500ML" → "500 ml". Null when it is not a believable pack size. */
export const normalizeQty = (v: unknown): string | null => {
  const s = cleanText(v, 40);
  if (!s) return null;
  const m = /^(\d+(?:[.,]\d+)?)\s*(kgs?|kilo(?:gram)?s?|gms?|grams?|gr|g|mls?|millilit(?:re|er)s?|ltrs?|lit(?:re|er)s?|lt|l)\.?$/i.exec(s);
  if (!m) return null;
  const n = Number(m[1].replace(',', '.'));
  const u = m[2].toLowerCase();
  const unit = u.startsWith('k') ? 'kg' : u.startsWith('m') ? 'ml' : u.startsWith('g') ? 'g' : 'L';
  const big = unit === 'kg' || unit === 'L';
  if (!(n > 0) || n > (big ? 50 : 50000) || (!big && n < 1)) return null;
  return `${n} ${unit}`;
};

/** 10, "10", "10/-", "Rs.10", "₹ 10.00", "MRP Rs. 10 (incl. of all taxes)" → 10. Null outside ₹1–₹10,000. */
export const normalizeMrp = (v: unknown): number | null => {
  let n: number | null = null;
  if (typeof v === 'number' && Number.isFinite(v)) n = v;
  else if (typeof v === 'string') {
    const m = /(\d{1,2},\d{3}(?:\.\d{1,2})?|\d{1,5}(?:\.\d{1,2})?)\s*(?:\/\s*-)?/.exec(v.replace(/(?:m\.?\s?r\.?\s?p\.?|rs\.?|₹|inr)/gi, ' '));
    if (m) n = Number(m[1].replace(',', ''));
  }
  if (n == null || !(n >= 1 && n <= 10000)) return null;
  return Math.round(n * 100) / 100;
};

/** yyyy-MM-dd of a real calendar date between 2015 and 2045, else null. */
export const normalizeDate = (v: unknown): string | null => {
  const s = cleanText(v, 10);
  const m = s && /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (y < 2015 || y > 2045 || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return s;
};

/** GTIN mod-10 check (EAN-8, UPC-A, EAN-13). */
export const isValidGtin = (code: string): boolean => {
  if (!/^\d+$/.test(code) || ![8, 12, 13].includes(code.length)) return false;
  const digits = [...code].map(Number);
  const body = digits.slice(0, -1).reverse();
  const sum = body.reduce((acc, d, i) => acc + (i % 2 === 0 ? d * 3 : d), 0);
  return (10 - (sum % 10)) % 10 === digits[digits.length - 1];
};

/**
 * Strict check of the model's JSON. Unknown keys are dropped, wrong types and implausible values become null,
 * a field that is null gets confidence 0. `problems` lists what was dropped (for the raw scan details).
 */
export const validateRead = (raw: unknown): { read: PackRead; problems: string[] } => {
  const problems: string[] = [];
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  if (o !== raw) problems.push('answer is not a JSON object');
  const conf = o.confidence && typeof o.confidence === 'object' ? (o.confidence as Record<string, unknown>) : {};

  const nameEng = cleanText(o.name_eng);
  const nameMr = cleanText(o.name_marathi);
  const barcodeDigits = typeof o.barcode === 'string' ? o.barcode.replace(/\D/g, '') : '';
  const read: PackRead = {
    name_eng: nameEng && /[A-Za-z]{2}/.test(nameEng) ? nameEng : null,
    name_marathi: nameMr && /[ऀ-ॿ]/.test(nameMr) && !/[A-Za-z]/.test(nameMr) ? nameMr : null,
    brand: cleanText(o.brand, 60),
    net_qty: normalizeQty(o.net_qty),
    mrp: normalizeMrp(o.mrp),
    mfg_date: normalizeDate(o.mfg_date),
    expiry_date: normalizeDate(o.expiry_date),
    barcode: barcodeDigits && isValidGtin(barcodeDigits) ? barcodeDigits : null,
    confidence: {} as Record<ReadField, number>,
  };
  for (const f of FIELDS) {
    const given = o[f];
    if (given != null && given !== '' && read[f] == null) problems.push(`${f} dropped: ${JSON.stringify(given).slice(0, 60)}`);
    read.confidence[f] = read[f] == null ? 0 : clamp01(conf[f]);
  }
  if (read.mfg_date && read.expiry_date && read.expiry_date <= read.mfg_date) {
    problems.push('expiry_date not after mfg_date');
    read.confidence.expiry_date = Math.min(read.confidence.expiry_date, 0.3);
  }
  for (const k of Object.keys(o)) if (![...FIELDS, 'confidence'].includes(k)) problems.push(`unknown key dropped: ${k}`);
  return { read, problems };
};

// ── Prompt and output schema ─────────────────────────────────────────────────

export const SYSTEM_PROMPT = `You read photos of ONE packaged product sold in an Indian grocery shop (1 to 5 photos of the same pack).
Answer with JSON only, matching the schema. Never guess: use null for anything that is not clearly visible.
- name_eng: the full product name as printed in English, including the brand and variant, without the size
  (e.g. "Tasty Nuts Shing Bhujia"). Not ingredients, slogans or company names.
- name_marathi: the product name in Devanagari ONLY if it is printed on the pack and you can read it confidently; else null.
- brand: the brand as printed (e.g. "Tasty Nuts", "Parle-G").
- net_qty: the net weight or volume with a normalised unit: "38 g", "1 kg", "500 ml", "1 L" ("38gm" -> "38 g").
  Ignore offer claims such as "20 g extra" or "free".
- mrp: the printed MRP as a number. Prices may be written "10/-", "Rs.10", "₹10", "MRP Rs. 10 (incl. of all taxes)":
  all mean 10. Prefer the printed MRP over offer, discount or per-unit prices. Never return a phone or batch number.
- mfg_date / expiry_date: yyyy-MM-dd. If only month and year are printed, use the 1st for mfg and the last day for expiry.
  If only "best before N months" is printed, return null for expiry_date.
- barcode: the digits printed under the barcode, only if all are clearly readable; else null.
- confidence: 0 to 1 for each field (how sure you are it is printed exactly so). 0 when the field is null.`;

const nullableString = { type: 'STRING', nullable: true };
export const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    name_eng: nullableString, name_marathi: nullableString, brand: nullableString, net_qty: nullableString,
    mrp: { type: 'NUMBER', nullable: true }, mfg_date: nullableString, expiry_date: nullableString, barcode: nullableString,
    confidence: {
      type: 'OBJECT',
      properties: Object.fromEntries(FIELDS.map(f => [f, { type: 'NUMBER' }])),
      required: FIELDS,
    },
  },
  required: [...FIELDS, 'confidence'],
};

/** The JSON text of the first candidate of a generateContent answer, or null. */
export const answerText = (resp: unknown): string | null => {
  const parts = (resp as { candidates?: { content?: { parts?: { text?: unknown }[] } }[] })?.candidates?.[0]?.content?.parts;
  const text = parts?.map(p => (typeof p.text === 'string' ? p.text : '')).join('').trim();
  return text || null;
};

/** Pacific-time date: the free quota resets at midnight Pacific. */
export const quotaDay = (now: Date): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

/** Constant-time string compare (keys are short; length difference returns early, which reveals only the length). */
export const safeEqual = (a: string, b: string): boolean => {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};
