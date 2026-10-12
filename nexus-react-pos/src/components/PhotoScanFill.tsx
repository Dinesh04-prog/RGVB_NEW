// Small pieces of the camera fill shown inside the Add / Edit Inventory Item popup (Android app only).
// Colours are the app's own (App.tsx): primary blue #0d6efd, light blue #e7f1ff, dark blue #0a3d62,
// green #16A34A, grey #6c757d; "check this" is a soft yellow (CHECK_YELLOW).
import { useState, type CSSProperties } from 'react';
import type { PhotoScanFill, PickTarget } from '../lib/usePhotoScanFill';

const BLUE = '#0d6efd';
const LIGHT_BLUE = '#e7f1ff';
const DARK_BLUE = '#0a3d62';
const GREY = '#6c757d';
const SOFT_YELLOW = '#FFF9DB';
const YELLOW_TEXT = '#7A5D00';

const chip: CSSProperties = {
  minHeight: 36, padding: '0 12px', borderRadius: 18, border: `1.5px solid ${BLUE}`, background: 'white',
  color: BLUE, fontWeight: 'bold', fontSize: '0.85rem', cursor: 'pointer',
};
const chipActive: CSSProperties = { ...chip, background: BLUE, color: 'white' };

/** "📷 Fill from Photos" — opens the native camera (1–5 photos). */
export function PhotoScanButton({ scan }: { scan: PhotoScanFill }) {
  if (!scan.available) return null;
  return (
    <button
      type="button"
      onClick={scan.start}
      disabled={scan.busy}
      style={{
        display: 'block', width: '100%', minHeight: 48, marginBottom: 10, border: `2px solid ${BLUE}`,
        borderRadius: 10, background: LIGHT_BLUE, color: BLUE, fontWeight: 'bold', fontSize: '0.95rem',
        cursor: scan.busy ? 'default' : 'pointer', opacity: scan.busy ? 0.7 : 1,
      }}
    >
      {scan.busy ? '⏳ Reading photos…' : '📷 Fill from Photos'}
    </button>
  );
}

/** Scan messages, warnings and the duplicate notice. */
export function PhotoScanNotices<T>({ scan, onOpenExisting }: { scan: PhotoScanFill; onOpenExisting: (item: T) => void }) {
  const dup = scan.duplicate;
  return (
    <>
      {scan.notice && (
        <div style={{ background: LIGHT_BLUE, color: DARK_BLUE, padding: '8px 10px', borderRadius: 8, fontSize: '0.82rem', marginBottom: 8 }}>
          {scan.notice}
        </div>
      )}
      {scan.warnings.map(w => (
        <div key={w} style={{ background: SOFT_YELLOW, color: YELLOW_TEXT, border: '1px solid #EBD98A', padding: '8px 10px', borderRadius: 8, fontSize: '0.82rem', marginBottom: 8 }}>
          ⚠ {w}
        </div>
      ))}
      {dup && (
        <div style={{
          background: dup.reason === 'barcode' ? '#FEE2E2' : SOFT_YELLOW, color: dup.reason === 'barcode' ? '#991B1B' : YELLOW_TEXT,
          border: `1px solid ${dup.reason === 'barcode' ? '#FCA5A5' : '#EBD98A'}`,
          padding: '8px 10px', borderRadius: 8, fontSize: '0.85rem', marginBottom: 8,
        }}>
          <b>{dup.reason === 'barcode' ? 'This item already exists' : 'A similar item already exists'}:</b>{' '}
          {dup.item.name_marathi || dup.item.name}{dup.item.name_eng ? ` · ${dup.item.name_eng}` : ''}
          <button
            type="button"
            onClick={() => onOpenExisting(dup.item as T)}
            style={{ display: 'block', marginTop: 6, minHeight: 44, padding: '0 14px', border: 'none', borderRadius: 8, background: BLUE, color: 'white', fontWeight: 'bold' }}
          >
            ✏️ Open existing item
          </button>
        </div>
      )}
    </>
  );
}

/** One-tap chips under a field when different values were read ("₹45 · ₹40", "38 g · 20 g"). */
export function ValueChoices<V extends string | number>({ options, current, label, format, onChoose }: {
  options: V[]; current: V | undefined; label: string; format?: (v: V) => string; onChoose: (v: V) => void;
}) {
  if (options.length < 2) return null;
  return (
    <div style={{ marginTop: 4 }}>
      <div style={{ fontSize: '0.72rem', color: YELLOW_TEXT }}>{label}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
        {options.map(v => (
          <button key={String(v)} type="button" onClick={() => onChoose(v)} style={v === current ? chipActive : chip}>
            {format ? format(v) : String(v)}
          </button>
        ))}
      </div>
    </div>
  );
}

/** "₹45 · ₹40" under the MRP field when the photos gave different prices: one tap switches. */
export function MrpChoices({ scan, current }: { scan: PhotoScanFill; current: number | undefined }) {
  return <ValueChoices options={scan.mrpOptions} current={current} label="Different prices were read. Tap the right MRP:"
    format={v => `₹${v}`} onChoose={scan.chooseMrp} />;
}

/** "38 g · 20 g" under the pack size when two sizes were read equally well. */
export function QtyChoices({ scan, current }: { scan: PhotoScanFill; current: string | undefined }) {
  return <ValueChoices options={scan.qtyOptions} current={current} label="Different sizes were read. Tap the right one:"
    onChoose={scan.chooseQty} />;
}

/** An Open Food Facts value that disagrees with what the photo read: shown, used only on tap. */
export function ScanSuggestion({ scan, field, label }: { scan: PhotoScanFill; field: 'name_eng' | 'brand' | 'net_qty'; label: string }) {
  const value = scan.suggestions[field];
  if (!value) return null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 4, fontSize: '0.75rem', color: GREY }}>
      <span>{label} (Open Food Facts):</span>
      <button type="button" onClick={() => scan.useSuggestion(field, value)} style={chip}>{value}</button>
    </div>
  );
}

const PICK_TARGETS: { target: PickTarget; label: string }[] = [
  { target: 'name_eng', label: 'English name' },
  { target: 'purchase_price', label: 'MRP' },
  { target: 'net_qty', label: 'Weight' },
  { target: 'barcode', label: 'Barcode' },
];

/** Collapsed list of the recognised text lines; tap a line, then the field it belongs to. */
function RecognisedText({ scan }: { scan: PhotoScanFill }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [message, setMessage] = useState('');
  if (!scan.recognised.length) return null;
  const pick = (target: PickTarget, text: string) => {
    const err = scan.pick(target, text);
    setMessage(err || '✓ Filled');
    if (!err) setSelected(null);
  };
  return (
    <div style={{ marginTop: 10 }}>
      <button type="button" onClick={() => { setOpen(v => !v); setSelected(null); setMessage(''); }}
        style={{ border: 'none', background: 'transparent', color: BLUE, fontSize: '0.8rem', fontWeight: 'bold', minHeight: 40, padding: 0, cursor: 'pointer' }}>
        {open ? '▾ Hide recognised text' : '▸ Recognised text (tap a line to use it)'}
      </button>
      {open && (
        <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, maxHeight: 280, overflowY: 'auto' }}>
          {scan.recognised.map((r, i) => (
            <div key={i} style={{ borderBottom: '1px solid #f1f2f6' }}>
              <button type="button" onClick={() => { setSelected(selected === i ? null : i); setMessage(''); }}
                style={{
                  display: 'block', width: '100%', textAlign: 'left', minHeight: 40, padding: '6px 10px', border: 'none',
                  background: selected === i ? LIGHT_BLUE : 'white', color: '#212529', fontSize: '0.85rem', cursor: 'pointer',
                  fontFamily: '"Segoe UI", "Noto Sans Devanagari", sans-serif',
                }}>
                <span style={{ color: GREY, fontSize: '0.7rem', marginRight: 6 }}>P{r.photo}</span>{r.text}
              </button>
              {selected === i && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '6px 10px 10px', background: LIGHT_BLUE }}>
                  {PICK_TARGETS.map(t => (
                    <button key={t.target} type="button" onClick={() => pick(t.target, r.text)} style={chip}>→ {t.label}</button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {open && message && (
        <div style={{ fontSize: '0.75rem', marginTop: 4, color: message.startsWith('✓') ? '#16A34A' : YELLOW_TEXT }}>{message}</div>
      )}
    </div>
  );
}

/** Tap-to-pick list, then the collapsed "Show raw scan details" + "Copy details" (text only, nothing is sent anywhere). */
export function PhotoScanDebug({ scan }: { scan: PhotoScanFill }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  if (!scan.debugText) return null;
  return (
    <div style={{ marginTop: 10 }}>
      <RecognisedText scan={scan} />
      <button type="button" onClick={() => setOpen(v => !v)}
        style={{ border: 'none', background: 'transparent', color: GREY, fontSize: '0.75rem', textDecoration: 'underline', minHeight: 36, padding: 0, cursor: 'pointer' }}>
        {open ? 'Hide raw scan details' : 'Show raw scan details'}
      </button>
      {open && (
        <div>
          <button type="button" onClick={() => copyText(scan.debugText).then(setCopied)}
            style={{ minHeight: 40, padding: '0 12px', border: `1.5px solid ${BLUE}`, borderRadius: 8, background: 'white', color: BLUE, fontWeight: 'bold', fontSize: '0.78rem' }}>
            {copied ? '✓ Copied' : '📋 Copy details'}
          </button>
          <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '0.68rem', background: '#f8f9fa', border: '1px solid #e5e7eb', borderRadius: 6, padding: 8, marginTop: 6, maxHeight: 260, overflowY: 'auto', fontFamily: 'monospace, "Noto Sans Devanagari"' }}>
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
