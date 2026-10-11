// Small pieces of the camera fill shown inside the Add / Edit Inventory Item popup (Android app only).
import { useState } from 'react';
import type { PhotoScanFill } from '../lib/usePhotoScanFill';

/** "📷 फोटोवरून भरा" — opens the native camera (1–5 photos). */
export function PhotoScanButton({ scan }: { scan: PhotoScanFill }) {
  if (!scan.available) return null;
  return (
    <button
      type="button"
      onClick={scan.start}
      disabled={scan.busy}
      style={{
        display: 'block', width: '100%', minHeight: 44, marginBottom: 10, border: '1px solid #F97316',
        borderRadius: 8, background: '#FFF7ED', color: '#C2410C', fontWeight: 'bold', fontSize: '0.95rem', cursor: 'pointer',
      }}
    >
      {scan.busy ? '⏳ फोटो वाचत आहे…' : '📷 फोटोवरून भरा'}
    </button>
  );
}

/** Scan messages and the duplicate notice. */
export function PhotoScanNotices<T>({ scan, onOpenExisting }: { scan: PhotoScanFill; onOpenExisting: (item: T) => void }) {
  const dup = scan.duplicate;
  return (
    <>
      {scan.notice && (
        <div style={{ background: '#F3F4F6', color: '#374151', padding: '6px 10px', borderRadius: 6, fontSize: '0.8rem', marginBottom: 8 }}>
          {scan.notice}
        </div>
      )}
      {dup && (
        <div style={{
          background: dup.reason === 'barcode' ? '#FEE2E2' : '#FEF3C7', color: dup.reason === 'barcode' ? '#991B1B' : '#92400E',
          padding: '8px 10px', borderRadius: 8, fontSize: '0.85rem', marginBottom: 8,
        }}>
          <b>{dup.reason === 'barcode' ? 'Item already exists' : 'Similar item already exists'}:</b>{' '}
          {dup.item.name_marathi || dup.item.name}{dup.item.name_eng ? ` · ${dup.item.name_eng}` : ''}
          <button
            type="button"
            onClick={() => onOpenExisting(dup.item as T)}
            style={{ display: 'block', marginTop: 6, minHeight: 40, padding: '0 14px', border: 'none', borderRadius: 8, background: '#0a3d62', color: 'white', fontWeight: 'bold' }}
          >
            ✏️ Open existing item
          </button>
        </div>
      )}
    </>
  );
}

/** Collapsed "Show raw scan details" + "Copy details" (text only, nothing is sent anywhere). */
export function PhotoScanDebug({ scan }: { scan: PhotoScanFill }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  if (!scan.debugText) return null;
  return (
    <div style={{ marginTop: 10 }}>
      <button type="button" onClick={() => setOpen(v => !v)}
        style={{ border: 'none', background: 'transparent', color: '#6c757d', fontSize: '0.75rem', textDecoration: 'underline', minHeight: 32, padding: 0, cursor: 'pointer' }}>
        {open ? 'Hide raw scan details' : 'Show raw scan details'}
      </button>
      {open && (
        <div>
          <button type="button" onClick={() => copyText(scan.debugText).then(setCopied)}
            style={{ minHeight: 36, padding: '0 12px', border: '1px solid #ccc', borderRadius: 8, background: '#f8f9fa', fontWeight: 'bold', fontSize: '0.78rem' }}>
            {copied ? '✓ Copied' : '📋 Copy details'}
          </button>
          <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '0.68rem', background: '#f8f9fa', border: '1px solid #eee', borderRadius: 6, padding: 8, marginTop: 6, maxHeight: 260, overflowY: 'auto', fontFamily: 'monospace, "Noto Sans Devanagari"' }}>
            {scan.debugText}
          </pre>
        </div>
      )}
    </div>
  );
}

/** Clipboard API first; textarea fallback for older Android WebViews. */
async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch { return false; }
}
