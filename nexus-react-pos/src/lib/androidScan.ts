// Bridge to the native "Add item from photos" scanner (ProductScanActivity in nexus-android).
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
  frontPhotoDataUrl: string | null;
  backPhotoDataUrl: string | null;
  debug?: ScanDebug;
}

/** Raw details for "Show raw scan details". Lines are "[h<box height>] text". Never sent anywhere. */
export interface ScanDebug {
  error?: string;
  frontSize?: string;
  backSize?: string;
  barcodeMlkit?: { value: string; format: string; checksumOk: boolean; photo: string };
  ocrFrontLatin?: string;
  ocrFrontDevanagari?: string;
  ocrBackLatin?: string;
  ocrBackDevanagari?: string;
  parser?: Record<string, { value: string | number | null; confidence: number }>;
  openFoodFacts?: { name: string | null; brand: string | null; quantity: string | null };
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

/** Plain-text dump of a scan for copy/paste when tuning the parser. Photos are not included. */
export const formatScanDetails = (r: ProductScanResult): string => {
  const d = r.debug || {};
  const block = (title: string, text?: string) => `--- ${title} ---${NL}${text?.trim() ? text : '(none)'}`;
  const out: string[] = ['NexusPOS scan details'];
  if (d.error) out.push(`ERROR: ${d.error}`);
  out.push(`photos: front=${d.frontSize ?? '?'} back=${d.backSize ?? '?'}`);
  out.push(block('FRONT · OCR Latin', d.ocrFrontLatin));
  out.push(block('FRONT · OCR Devanagari', d.ocrFrontDevanagari));
  out.push(block('BACK · OCR Latin', d.ocrBackLatin));
  out.push(block('BACK · OCR Devanagari', d.ocrBackDevanagari));
  const bc = d.barcodeMlkit;
  out.push(block('BARCODE', [
    bc ? `ML Kit: ${bc.value} (${bc.format}, ${bc.photo} photo, checksum ${bc.checksumOk ? 'ok' : 'FAILED'})` : 'ML Kit: not found',
    `from OCR digits: ${d.parser?.barcodeFromText?.value ?? 'none'}`,
    `used: ${r.barcode ?? 'none'} (verified=${r.barcodeVerified})`,
  ].join(NL)));
  out.push(block('PARSER (OCR only)', Object.entries(d.parser || {})
    .map(([k, v]) => `${k}: ${v.value ?? 'null'}  conf=${v.confidence.toFixed(2)}`).join(NL)));
  out.push(block('FINAL FIELDS (value · source · confidence)', FIELDS.map(k => {
    const v = (r as unknown as Record<string, unknown>)[k];
    return `${k}: ${v ?? 'null'} · ${r.source[k] ?? '-'} · ${r.confidence[k]?.toFixed(2) ?? '-'}`;
  }).join(NL)));
  const off = d.openFoodFacts;
  out.push(block('OPEN FOOD FACTS', [`status: ${r.offStatus}`,
    ...(off ? [`name: ${off.name}`, `brand: ${off.brand}`, `quantity: ${off.quantity}`] : [])].join(NL)));
  if (d.timingsMs) out.push(`timings ms: ${Object.entries(d.timingsMs).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  return out.join(NL + NL);
};

