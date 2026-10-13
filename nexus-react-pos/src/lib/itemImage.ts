// Small product thumbnails stored inside the inventory item itself (item.image, a JPEG data URL).
// No Firebase Storage: the picture travels with the Firestore document and the IndexedDB cache, so it
// must stay tiny. Same limits as the Android scan thumbnail (ScanThumbnail.kt).

/** Long edge of a thumbnail in px. */
export const IMAGE_EDGE = 240;
/** Hard cap on the whole data URL ("data:image/jpeg;base64,…"), in characters = bytes. */
export const IMAGE_MAX_CHARS = 25 * 1024;

/** Size of a data URL as stored (characters; base64 is ASCII). */
export const imageBytes = (dataUrl: string | undefined | null) => (dataUrl ? dataUrl.length : 0);
export const formatKb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;
export const isOverCap = (dataUrl: string | undefined | null) => imageBytes(dataUrl) > IMAGE_MAX_CHARS;

const loadImage = (src: string) => new Promise<HTMLImageElement>((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = () => reject(new Error('This file could not be read as an image.'));
  img.src = src;
});

// Smaller and softer until it fits; the first step is the normal case (a 240 px JPEG at 70 is about 8–15 KB)
const STEPS: [number, number][] = [[IMAGE_EDGE, 0.7], [IMAGE_EDGE, 0.55], [200, 0.5], [160, 0.45], [120, 0.4]];

/** Any image source (object URL or data URL) → JPEG data URL, long edge ≤ 240 px, ≤ 25 KB. */
const shrink = async (src: string): Promise<string> => {
  const img = await loadImage(src);   // browsers apply the photo's EXIF rotation when drawing an <img>
  const w0 = img.naturalWidth;
  const h0 = img.naturalHeight;
  if (!w0 || !h0) throw new Error('This file could not be read as an image.');
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Images are not supported on this device.');
  for (const [edge, quality] of STEPS) {
    const scale = Math.min(1, edge / Math.max(w0, h0));
    canvas.width = Math.max(1, Math.round(w0 * scale));
    canvas.height = Math.max(1, Math.round(h0 * scale));
    ctx.fillStyle = '#ffffff';   // transparent PNGs would turn black in a JPEG
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL('image/jpeg', quality);
    if (url.length <= IMAGE_MAX_CHARS) return url;
  }
  throw new Error('This image is too detailed to fit in 25 KB. Please try another photo.');
};

/** A picked or captured file → thumbnail data URL. */
export const imageFileToThumbnail = async (file: File): Promise<string> => {
  const url = URL.createObjectURL(file);
  try { return await shrink(url); } finally { URL.revokeObjectURL(url); }
};

/** An existing image that is over the cap → recompressed under it. */
export const recompressImage = (dataUrl: string): Promise<string> => shrink(dataUrl);

/** Item without the image key (Firestore rejects undefined values, so the key is removed, never set to undefined). */
export const withImage = <T extends { image?: string }>(item: T, image: string | null): T => {
  if (image) return { ...item, image };
  const rest = { ...item };
  delete rest.image;
  return rest;
};
