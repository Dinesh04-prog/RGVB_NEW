// Picture box in the Add / Edit Inventory Item popup: take a photo or choose one, or remove it.
// Pictures are shrunk to a 240 px JPEG of at most 25 KB (see lib/itemImage.ts) before they reach the item.
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { IMAGE_MAX_CHARS, formatKb, imageBytes, imageFileToThumbnail, isOverCap, recompressImage } from '../lib/itemImage';

interface Props {
  image: string | undefined;
  onChange: (image: string | null) => void;
  /** yellow "auto-filled, please check" background from the photo scan */
  highlight?: CSSProperties;
  /** Heading above the buttons (default "PICTURE (Optional)") */
  label?: string;
}

const btn: CSSProperties = {
  minHeight: 36, padding: '6px 10px', borderRadius: 8, fontWeight: 700, fontSize: '0.78rem', cursor: 'pointer',
  border: '1.5px solid #0d6efd', background: '#fff', color: '#0d6efd', display: 'inline-flex', alignItems: 'center', gap: 4,
};

export function ItemImageField({ image, onChange, highlight, label = 'PICTURE (Optional)' }: Props) {
  const cameraRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState('');
  const [shrunkFrom, setShrunkFrom] = useState(0);   // size before an automatic recompress

  // A picture over the cap (older data, another device) is recompressed as soon as the popup shows it
  const latest = useRef(onChange);
  useEffect(() => { latest.current = onChange; });
  useEffect(() => {
    if (!image || !isOverCap(image)) return;
    let alive = true;
    const before = imageBytes(image);
    recompressImage(image)
      .then(small => { if (alive) { setShrunkFrom(before); latest.current(small); } })
      .catch(err => { if (alive) setError(err instanceof Error ? err.message : String(err)); });
    return () => { alive = false; };
  }, [image]);

  const pick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';   // the same file can be chosen again
    if (!file) return;
    setPicking(true); setError(''); setShrunkFrom(0);
    try { onChange(await imageFileToThumbnail(file)); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setPicking(false); }
  };

  const size = imageBytes(image);
  const busy = picking || (isOverCap(image) && !error);   // over the cap → being recompressed
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'center', border: '1px solid #E5E7EB', borderRadius: 10, padding: 8, marginBottom: 10, background: '#F8FAFC', ...highlight }}>
      <div style={{ width: 64, height: 64, flexShrink: 0, borderRadius: 8, overflow: 'hidden', background: '#E0EDFF', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#0a3d62', fontSize: '1.4rem' }}>
        {image ? <img src={image} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : '🖼'}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: '0.75rem', fontWeight: 'bold', color: '#6c757d', marginBottom: 4 }}>
          {label}{image ? ` · ${formatKb(size)}` : ''}
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button type="button" style={btn} disabled={busy} onClick={() => cameraRef.current?.click()}>📷 Take photo</button>
          <button type="button" style={btn} disabled={busy} onClick={() => fileRef.current?.click()}>🖼 Choose image</button>
          {image && (
            <button type="button" style={{ ...btn, borderColor: '#DC2626', color: '#DC2626' }} disabled={busy}
              onClick={() => { setError(''); setShrunkFrom(0); onChange(null); }}>Remove</button>
          )}
        </div>
        {busy && <div style={{ fontSize: '0.72rem', color: '#0d6efd', marginTop: 4 }}>Making the picture small…</div>}
        {shrunkFrom > 0 && !busy && (
          <div style={{ fontSize: '0.72rem', color: '#15803D', marginTop: 4 }}>
            Was {formatKb(shrunkFrom)} (over the {formatKb(IMAGE_MAX_CHARS)} limit), now {formatKb(size)}.
          </div>
        )}
        {error && <div style={{ fontSize: '0.72rem', color: '#DC2626', marginTop: 4 }}>{error}</div>}
      </div>
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={pick} />
      <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={pick} />
    </div>
  );
}
