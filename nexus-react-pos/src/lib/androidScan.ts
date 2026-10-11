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
