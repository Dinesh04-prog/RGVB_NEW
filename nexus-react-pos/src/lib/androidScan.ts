// Bridge to the native photo scanner (ProductScanActivity in nexus-android), used by the camera button
// inside the Add / Edit Inventory Item popup. Up to 5 photos per scan; results are merged natively.
//
// Native → web:  window.onProductScanResult(jsonString)  /  window.onProductScanCancel()
// Web → native:  window.AndroidScan.startProductScan()   /  window.AndroidScan.takePendingResult()
//
// takePendingResult() covers low-memory phones: if Android destroyed the WebView while the camera was
// open, the result is kept on disk and picked up after the app reloads.

export type ScanSource = 'mlkit-ocr' | 'mlkit-barcode' | 'openfoodfacts' | 'gemini';

export interface ProductScanResult {
  name_eng: string | null;        // English product words read from the front ("Original Gluco Biscuits")
  name_marathi: string | null;    // Devanagari text read from the pack, if any
  brand: string | null;
  unit: string;                   // billing unit, "pcs" by default
  net_qty: string | null;         // "250 g"
  mrp: number | null;
  barcode: string | null;
  barcodeVerified: boolean;
  mfg_date: string | null;        // ISO yyyy-MM-dd
  expiry_date: string | null;     // ISO yyyy-MM-dd
  confidence: Partial<Record<ScanField, number>>;
  source: Partial<Record<ScanField, ScanSource>>;
  offStatus: 'found' | 'not_found' | 'error' | 'skipped' | 'rate_limited';
  photoCount?: number;            // 1–5; photos themselves are never sent to the web app
  /** front photo (photo 1) as a JPEG data URL, ≤ 240 px and ≤ 25 KB, for the inventory tile; null when it failed */
  image?: string | null;
  /** other MRP values read (best first): one-tap chips under the MRP field (older results; see `alternates`) */
  mrp_alternates?: number[];
  /** other values read for a field (best first): one-tap chips under that field */
  alternates?: { mrp?: number[]; net_qty?: string[]; name_eng?: string[] };
  /** short English messages for the popup ("check both dates", ignored prices) */
  warnings?: string[];
  /** values offered but never filled: a barcode only Gemini saw (unverified); older results: Open Food Facts values */
  suggestions?: Partial<Record<'name_eng' | 'brand' | 'net_qty' | 'barcode', string>>;
  /** ok | off | not_configured | offline | disabled | daily_cap | quota | rate_limited | timeout | unauthorized | error */
  geminiStatus?: string;
  /** merged OCR lines of all photos, for "Recognised text" (tap a line to use it) */
  recognised?: { photo: number; text: string }[];
  debug?: ScanDebug;
}

/** Raw details for "Show raw scan details". Lines are "[h<box height>] text". Never sent anywhere. */
export interface ScanDebug {
  error?: string;
  photos?: {
    photo: number;                 // 1-based
    size: string;
    barcodeMlkit?: { value: string; format: string; checksumOk: boolean } | null;
    exifRotation?: number;         // degrees, handed to ML Kit
    turned?: number;               // 90 / 270 when the photo read very little text as taken
    passes?: string;               // OCR passes merged, e.g. "plain, contrast, sharpened"
    ocrLatin?: string;             // merged lines, "[h<height> c<confidence %>] text"
    ocrDevanagari?: string;
    ms?: number;
  }[];
  /** field → photo number it was taken from; 0 = all photos' text combined */
  pickedFrom?: Partial<Record<ScanField, number>>;
  /** every MRP value read, with its score and why */
  mrpReadings?: string[];
  /** what the phone alone read, before Gemini / Open Food Facts */
  ocrOnly?: { name_eng: string | null; brand: string | null; net_qty: string | null; mrp: number | null };
  /** Gemini call: status, model, time, the model's JSON as returned, and what the Worker's checks dropped */
  gemini?: { status: string; model: string | null; ms: number; raw: string | null; problems: string[] };
  openFoodFacts?: { name: string | null; brand: string | null; quantity: string | null } | null;
  timingsMs?: Record<string, number>;
}

export type ScanField = 'name_eng' | 'name_marathi' | 'brand' | 'net_qty' | 'mrp' | 'barcode' | 'mfg_date' | 'expiry_date';

interface AndroidScanBridge {
  startProductScan: () => void;
  takePendingResult: () => string;
}

declare global {
  interface Window {
    AndroidScan?: AndroidScanBridge;
    onProductScanResult?: (json: string) => void;
    onProductScanCancel?: () => void;
  }
}

export const isAndroidScanAvailable = (): boolean =>
  typeof window !== 'undefined' && typeof window.AndroidScan?.startProductScan === 'function';

const parse = (json: string): ProductScanResult | null => {
  try {
    const r = JSON.parse(json) as ProductScanResult;
    return { ...r, confidence: r.confidence || {}, source: r.source || {}, unit: r.unit || 'pcs' };
  } catch (err) {
    console.error('[PhotoAdd] bad scan result', err);
    return null;
  }
};

// One listener (the review modal). A result that arrives before it mounts is queued, not lost.
type Listener = (result: ProductScanResult | null) => void;   // null = cancelled
let listener: Listener | null = null;
let queued: ProductScanResult | null = null;

const emit = (result: ProductScanResult | null) => {
  if (listener) listener(result);
  else if (result) queued = result;
};

export const onProductScan = (cb: Listener) => {
  listener = cb;
  if (queued) { const q = queued; queued = null; setTimeout(() => cb(q)); }
  return () => { if (listener === cb) listener = null; };
};

if (typeof window !== 'undefined') {
  window.onProductScanResult = (json: string) => emit(parse(json));
  window.onProductScanCancel = () => emit(null);
}

export const startProductScan = () => {
  if (!isAndroidScanAvailable()) return false;
  window.AndroidScan!.startProductScan();
  return true;
};

/** Result of a scan that finished while the app was being restarted (see top comment). */
export const takePendingScanResult = (): ProductScanResult | null => {
  if (typeof window.AndroidScan?.takePendingResult !== 'function') return null;
  const json = window.AndroidScan.takePendingResult();
  return json ? parse(json) : null;
};

const FIELDS: ScanField[] = ['name_eng', 'name_marathi', 'brand', 'net_qty', 'mrp', 'barcode', 'mfg_date', 'expiry_date'];
const NL = '\n';
const photoLabel = (n: number | undefined) => (n == null ? '-' : n === 0 ? 'all photos' : `photo ${n}`);

/** Plain-text dump of a scan for copy/paste when tuning the parser. Photos (and the thumbnail) are not included. */
export const formatScanDetails = (r: ProductScanResult): string => {
  const d = r.debug || {};
  const block = (title: string, text?: string) => `--- ${title} ---${NL}${text?.trim() ? text : '(none)'}`;
  const out: string[] = [`NexusPOS scan details · ${r.photoCount ?? d.photos?.length ?? '?'} photo(s)`];
  if (d.error) out.push(`ERROR: ${d.error}`);
  for (const p of d.photos || []) {
    const bc = p.barcodeMlkit;
    out.push(block(`PHOTO ${p.photo} (${p.size}) · barcode`,
      bc ? `${bc.value} (${bc.format}, checksum ${bc.checksumOk ? 'ok' : 'FAILED'})` : 'not found'));
    if (p.passes) {
      out.push(`photo ${p.photo}: OCR passes ${p.passes}; EXIF ${p.exifRotation ?? 0}°` +
        (p.turned ? `; turned ${p.turned}° (little text as taken)` : '') + (p.ms != null ? `; ${p.ms} ms` : ''));
    }
    out.push(block(`PHOTO ${p.photo} · OCR Latin`, p.ocrLatin));
    out.push(block(`PHOTO ${p.photo} · OCR Devanagari`, p.ocrDevanagari));
  }
  out.push(block('BARCODE USED', `${r.barcode ?? 'none'} (verified=${r.barcodeVerified}, ${r.source.barcode ?? '-'}, ${photoLabel(d.pickedFrom?.barcode)})`));
  out.push(block('MERGED FIELDS (value · source · confidence · from)', FIELDS.map(k => {
    const v = (r as unknown as Record<string, unknown>)[k];
    return `${k}: ${v ?? 'null'} · ${r.source[k] ?? '-'} · ${r.confidence[k]?.toFixed(2) ?? '-'} · ${photoLabel(d.pickedFrom?.[k])}`;
  }).join(NL)));
  if (d.mrpReadings?.length || r.mrp_alternates?.length) {
    out.push(block('MRP READINGS (best first)', [...(d.mrpReadings || []),
      ...(r.mrp_alternates?.length ? [`alternates offered: ${r.mrp_alternates.map(v => `₹${v}`).join(', ')}`] : [])].join(NL)));
  }
  out.push(`thumbnail: ${r.image ? `${(r.image.length / 1024).toFixed(1)} KB` : 'none'}`);
  if (r.warnings?.length) out.push(block('WARNINGS', r.warnings.join(NL)));
  const alt = r.alternates || {};
  const altLines = (['name_eng', 'net_qty', 'mrp'] as const).filter(k => alt[k]?.length).map(k => `${k}: ${alt[k]!.join(' · ')}`);
  if (altLines.length) out.push(block('ALTERNATES OFFERED AS CHIPS', altLines.join(NL)));
  if (d.ocrOnly) {
    const o = d.ocrOnly;
    out.push(block('PHONE OCR ALONE', `name_eng: ${o.name_eng}${NL}brand: ${o.brand}${NL}net_qty: ${o.net_qty}${NL}mrp: ${o.mrp}`));
  }
  const g = d.gemini;
  out.push(block('GEMINI', [`status: ${r.geminiStatus ?? g?.status ?? '-'}`,
    ...(g ? [`model: ${g.model ?? '-'} · ${g.ms} ms`, ...(g.problems.length ? [`dropped by checks: ${g.problems.join('; ')}`] : []),
      `raw JSON: ${g.raw ?? '(none)'}`] : [])].join(NL)));
  const off = d.openFoodFacts;
  const sug = Object.entries(r.suggestions || {});
  out.push(block('OPEN FOOD FACTS', [`status: ${r.offStatus}`,
    ...(off ? [`name: ${off.name}`, `brand: ${off.brand}`, `quantity: ${off.quantity}`] : []),
    ...sug.map(([k, v]) => `suggested ${k}: ${v}`)].join(NL)));
  if (d.timingsMs) out.push(`timings ms: ${Object.entries(d.timingsMs).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  return out.join(NL + NL);
};

