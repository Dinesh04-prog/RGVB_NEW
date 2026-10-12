import { describe, expect, it } from 'vitest';
import {
  MAX_BODY_BYTES, imagesBody, isValidGtin, normalizeDate, normalizeMrp, normalizeQty, parseImagesBody, quotaDay, safeEqual,
  validateRead,
} from '../src/validate';

const jpeg = '/9j/4AAQSkZJRgABAQAAAQABAAD';

describe('request checks', () => {
  it('accepts 1–5 JPEGs and returns them unchanged', () => {
    expect(parseImagesBody(imagesBody([jpeg]))).toEqual({ ok: true, images: [jpeg] });
    expect(parseImagesBody(imagesBody(Array(5).fill(jpeg)))).toEqual({ ok: true, images: Array(5).fill(jpeg) });
    expect(imagesBody([jpeg, jpeg])).toBe(JSON.stringify({ images: [jpeg, jpeg] }));   // same as JSON for plain base64
  });
  it('rejects bad shapes, counts, types and sizes', () => {
    expect(parseImagesBody('{}')).toEqual({ ok: false, error: 'bad_request' });
    expect(parseImagesBody('{"images":[]}')).toEqual({ ok: false, error: 'bad_request' });
    expect(parseImagesBody(imagesBody(Array(6).fill(jpeg)))).toEqual({ ok: false, error: 'bad_image_count' });
    expect(parseImagesBody(imagesBody(['iVBORw0KGgo']))).toEqual({ ok: false, error: 'not_jpeg' });
    expect(parseImagesBody(imagesBody([jpeg + 'A'.repeat(MAX_BODY_BYTES)]))).toEqual({ ok: false, error: 'too_large' });
  });
  it('rejects anything that could break out of the JSON string it is spliced into', () => {
    expect(parseImagesBody(imagesBody([jpeg + '\\"}']))).toEqual({ ok: false, error: 'bad_request' });
    expect(parseImagesBody(imagesBody([jpeg + '"},{"x":"' + jpeg]))).toEqual({ ok: false, error: 'bad_request' });
    expect(parseImagesBody(imagesBody([jpeg + '","' + jpeg + '"]}']))).not.toMatchObject({ ok: true });
  });
});

describe('value normalisation', () => {
  it('sizes', () => {
    expect(normalizeQty('38gm')).toBe('38 g');
    expect(normalizeQty('38 g')).toBe('38 g');
    expect(normalizeQty('1 Ltr')).toBe('1 L');
    expect(normalizeQty('500ML')).toBe('500 ml');
    expect(normalizeQty('1.5 kg')).toBe('1.5 kg');
    expect(normalizeQty('500 kg')).toBeNull();
    expect(normalizeQty('20 g extra')).toBeNull();
    expect(normalizeQty('abc')).toBeNull();
  });
  it('MRP in the ways Indian packs print it', () => {
    for (const v of [10, '10', '10/-', 'Rs.10', 'Rs.10/-', '₹10', '₹ 10.00', 'MRP Rs. 10 (incl. of all taxes)']) {
      expect(normalizeMrp(v)).toBe(10);
    }
    expect(normalizeMrp('₹1,099.00')).toBe(1099);
    expect(normalizeMrp(0.5)).toBeNull();
    expect(normalizeMrp(12500)).toBeNull();
    expect(normalizeMrp('free')).toBeNull();
  });
  it('dates', () => {
    expect(normalizeDate('2026-08-01')).toBe('2026-08-01');
    expect(normalizeDate('2026-02-30')).toBeNull();
    expect(normalizeDate('08/2026')).toBeNull();
    expect(normalizeDate('1999-01-01')).toBeNull();
  });
  it('barcode checksum', () => {
    expect(isValidGtin('8901719101038')).toBe(true);
    expect(isValidGtin('8901719101039')).toBe(false);
  });
});

describe('model answer validation', () => {
  const good = {
    name_eng: 'Tasty Nuts Shing Bhujia', name_marathi: null, brand: 'Tasty Nuts', net_qty: '38gm', mrp: '10/-',
    mfg_date: '2026-08-01', expiry_date: '2026-11-30', barcode: null,
    confidence: { name_eng: 0.93, name_marathi: 0, brand: 0.9, net_qty: 0.88, mrp: 0.95, mfg_date: 0.7, expiry_date: 0.7, barcode: 0 },
  };
  it('cleans a good answer', () => {
    const { read, problems } = validateRead(good);
    expect(read).toMatchObject({ name_eng: 'Tasty Nuts Shing Bhujia', brand: 'Tasty Nuts', net_qty: '38 g', mrp: 10, barcode: null });
    expect(read.confidence.mrp).toBe(0.95);
    expect(read.confidence.barcode).toBe(0);
    expect(problems).toEqual([]);
  });
  it('drops wrong types, unknown keys and bad values; clamps confidence', () => {
    const { read, problems } = validateRead({
      ...good, name_eng: 42, name_marathi: 'Shing Bhujia', mrp: 99999, barcode: '8901719101039', extra: 'x',
      confidence: { ...good.confidence, brand: 7, net_qty: 'high' },
    });
    expect(read.name_eng).toBeNull();
    expect(read.name_marathi).toBeNull();          // Latin text is not a Marathi name
    expect(read.mrp).toBeNull();
    expect(read.barcode).toBeNull();               // bad checksum
    expect(read.confidence.brand).toBe(1);
    expect(read.confidence.net_qty).toBe(0);
    expect(read.confidence.mrp).toBe(0);           // null field → 0
    expect(problems).toContain('unknown key dropped: extra');
    expect(problems.some(p => p.startsWith('mrp dropped'))).toBe(true);
  });
  it('keeps a Devanagari name and checksum-valid barcode', () => {
    const { read } = validateRead({ ...good, name_marathi: 'शिंग भुजिया', barcode: '8901719 101038' });
    expect(read.name_marathi).toBe('शिंग भुजिया');
    expect(read.barcode).toBe('8901719101038');
  });
  it('flags expiry not after mfg', () => {
    const { read, problems } = validateRead({ ...good, expiry_date: '2026-07-01' });
    expect(read.confidence.expiry_date).toBeLessThanOrEqual(0.3);
    expect(problems).toContain('expiry_date not after mfg_date');
  });
  it('non-objects become all-null', () => {
    for (const bad of [null, 'text', [1, 2], 3]) {
      const { read, problems } = validateRead(bad);
      expect(read.name_eng).toBeNull();
      expect(read.mrp).toBeNull();
      expect(problems.length).toBeGreaterThan(0);
    }
  });
});

describe('helpers', () => {
  it('quota day is Pacific time', () => {
    expect(quotaDay(new Date('2026-10-12T05:00:00Z'))).toBe('2026-10-11');
    expect(quotaDay(new Date('2026-10-12T09:00:00Z'))).toBe('2026-10-12');
  });
  it('safeEqual', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('', '')).toBe(false);
  });
});
