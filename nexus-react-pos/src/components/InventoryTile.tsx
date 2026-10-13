// Inventory product tile (cashier Inventory tab and Owner app inventory), 3 per row like a shop catalogue.
// Picture or letter placeholder, one name, pack size, SR (sale rate) / PR (purchase rate) and a stock block.
// Tap the tile → edit popup. Star and delete sit on the picture's corners.
import { useState } from 'react';
import { itemNameFields } from '../lib/itemNames';

export interface TileItem {
  id: string;
  name: string;
  name_marathi?: string;
  name_eng?: string;
  unit: string;
  price: number;
  purchase_price?: number;
  stock_quantity?: number;
  stock_qty?: number;
  net_qty?: string;
  image?: string;
}

export const LOW_STOCK = 10;

/** 20 → "20", 18.5 → "18.5", 66.15 → "66.15"; empty / 0 → "-" */
const num = (v: number | undefined | null) => {
  const n = Number(v);
  if (v == null || !Number.isFinite(n) || n === 0) return '-';
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
};

/** First grapheme (Devanagari letters with their vowel signs stay together). */
const firstGrapheme = (s: string) => {
  const Seg = (Intl as unknown as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  if (Seg) for (const { segment } of new Seg(undefined, { granularity: 'grapheme' }).segment(s)) return segment;
  return Array.from(s)[0] || '';
};

/** "Maggie masala" → "MM", "Supreme" → "SU", Marathi only → "मॅ" */
const placeholderText = (eng: string, marathi: string) => {
  const words = eng.split(/\s+/).filter(w => /[A-Za-z0-9]/.test(w));
  if (words.length > 1) return (words[0][0] + words[1][0]).toUpperCase();
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return firstGrapheme(marathi.trim()) || '?';
};

/** Same item → same tint (soft blue or soft green). */
const tint = (id: string) => {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return h & 1 ? 'green' : 'blue';
};

interface Props {
  item: TileItem;
  isFav: boolean;
  onOpen: () => void;
  onToggleFav: () => void;
  onDelete: () => void;
}

export function InventoryTile({ item, isFav, onOpen, onToggleFav, onDelete }: Props) {
  const [broken, setBroken] = useState<string | null>(null);   // the image that failed to load
  const names = itemNameFields(item);
  const name = names.marathi || names.eng || item.name || '—';
  const pack = (item.net_qty || item.unit || '').trim();
  const stockRaw = item.stock_quantity ?? item.stock_qty;
  const hasStock = stockRaw != null && Number.isFinite(Number(stockRaw));
  const stock = hasStock ? Number(stockRaw) : null;
  const low = stock != null && stock < LOW_STOCK;
  const showImage = !!item.image && broken !== item.image;

  return (
    <div className="inv-tile" onClick={onOpen}>
      <div className={`inv-tile-img ${showImage ? '' : `ph-${tint(item.id)}`}`}>
        {showImage
          ? <img src={item.image} alt="" loading="lazy" decoding="async" onError={() => setBroken(item.image!)} />
          : <span className="inv-tile-ph" lang={names.eng ? 'en' : 'mr'}>{placeholderText(names.eng, names.marathi)}</span>}
        <button type="button" className="inv-tile-corner left" aria-label="Delete item"
          onClick={e => { e.stopPropagation(); onDelete(); }}>
          <span className="dot danger">🗑</span>
        </button>
        <button type="button" className="inv-tile-corner right" aria-label={isFav ? 'Remove from favourites' : 'Add to favourites'}
          onClick={e => { e.stopPropagation(); onToggleFav(); }}>
          <span className={`dot star${isFav ? ' on' : ''}`}>{isFav ? '★' : '☆'}</span>
        </button>
      </div>
      <div className="inv-tile-name">{name}</div>
      {pack && <div><span className="inv-tile-pack">{pack}</span></div>}
      <div className="inv-tile-rates">
        <span className="sr">SR = {num(item.price)}</span>
        <span className="pr">PR = {num(item.purchase_price)}</span>
      </div>
      <div className={`inv-tile-stock${low ? ' low' : ''}`}>Stock {stock ?? '-'}</div>
    </div>
  );
}

/** Tile styles, injected by both App.tsx and OwnerApp.tsx. */
export const INVENTORY_TILE_CSS = `
  .inv-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; max-width: 760px; margin-bottom: 8px; }
  .inv-tile { background: #fff; border: 1px solid #E5E7EB; border-radius: 10px; padding: 5px 5px 6px; display: flex; flex-direction: column; gap: 4px; min-width: 0; cursor: pointer; box-shadow: 0 1px 4px rgba(10,61,98,0.06); }
  .inv-tile-img { position: relative; aspect-ratio: 1 / 1; border-radius: 8px; overflow: hidden; background: #F1F5F9; display: flex; align-items: center; justify-content: center; }
  .inv-tile-img img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .inv-tile-img.ph-blue { background: linear-gradient(135deg, #E0EDFF, #C7DCFB); color: #0a3d62; }
  .inv-tile-img.ph-green { background: linear-gradient(135deg, #E3F7EA, #C4EBD2); color: #15803D; }
  .inv-tile-ph { font-size: 1.9rem; font-weight: 800; letter-spacing: 0.02em; font-family: "Noto Sans Devanagari", 'Segoe UI', sans-serif; line-height: 1; user-select: none; }
  .inv-tile-corner { position: absolute; top: 0; width: 36px; height: 36px; padding: 3px; border: none; background: transparent; cursor: pointer; display: flex; align-items: flex-start; }
  .inv-tile-corner.left { left: 0; justify-content: flex-start; }
  .inv-tile-corner.right { right: 0; justify-content: flex-end; }
  .inv-tile-corner .dot { width: 24px; height: 24px; border-radius: 999px; background: rgba(255,255,255,0.92); box-shadow: 0 1px 3px rgba(0,0,0,0.18); display: flex; align-items: center; justify-content: center; font-size: 0.72rem; line-height: 1; }
  .inv-tile-corner .dot.star { font-size: 0.95rem; color: #94A3B8; }
  .inv-tile-corner .dot.star.on { color: #0d6efd; }
  .inv-tile-name { font-weight: 700; font-size: 0.8rem; line-height: 1.3; color: #1C1917; font-family: "Noto Sans Devanagari", 'Segoe UI', sans-serif; overflow-wrap: anywhere; word-break: break-word; }
  .inv-tile-pack { display: inline-block; max-width: 100%; background: #F1F5F9; color: #475569; border-radius: 6px; padding: 1px 6px; font-size: 0.68rem; font-weight: 600; overflow-wrap: anywhere; }
  .inv-tile-rates { display: flex; flex-wrap: wrap; column-gap: 6px; row-gap: 0; font-size: 0.72rem; font-weight: 700; line-height: 1.35; margin-top: auto; }
  .inv-tile-rates .sr { color: #15803D; white-space: nowrap; }
  .inv-tile-rates .pr { color: #DC2626; white-space: nowrap; }
  .inv-tile-stock { border: 1.5px solid #16A34A; background: #fff; color: #16A34A; border-radius: 8px; text-align: center; font-weight: 800; font-size: 0.74rem; padding: 4px 2px; line-height: 1.2; overflow-wrap: anywhere; cursor: inherit; }
  .inv-tile-stock.low { border-color: #DC2626; color: #DC2626; }
  @media (min-width: 600px) {
    .inv-grid { gap: 10px; }
    .inv-tile { padding: 8px 8px 9px; gap: 6px; border-radius: 12px; }
    .inv-tile-ph { font-size: 2.8rem; }
    .inv-tile-corner { width: 44px; height: 44px; padding: 6px; }
    .inv-tile-corner .dot { width: 30px; height: 30px; font-size: 0.9rem; }
    .inv-tile-corner .dot.star { font-size: 1.15rem; }
    .inv-tile-name { font-size: 0.98rem; }
    .inv-tile-pack { font-size: 0.78rem; padding: 2px 8px; }
    .inv-tile-rates { font-size: 0.9rem; column-gap: 10px; }
    .inv-tile-stock { font-size: 0.9rem; padding: 6px 4px; }
  }
`;
