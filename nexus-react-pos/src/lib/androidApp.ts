// Links and file downloads that also work inside the Android app (nexus-android, AndroidAppBridge.kt).
// In the app's WebView, window.open('https://wa.me/…') and <a download> do nothing useful, so the native
// side opens WhatsApp and saves files to Downloads. In a normal browser these fall back to the usual way.

interface AndroidAppBridge {
  openExternal: (url: string) => boolean;
  saveFile: (fileName: string, mimeType: string, base64: string) => string;
}

declare global {
  interface Window { AndroidApp?: AndroidAppBridge }
}

export const isAndroidApp = (): boolean =>
  typeof window !== 'undefined' && typeof window.AndroidApp?.saveFile === 'function';

/** Opens a link in another app (WhatsApp for wa.me links) or a new browser tab. */
export const openExternalUrl = (url: string) => {
  if (window.AndroidApp?.openExternal?.(url)) return;
  const win = window.open(url, '_blank');
  if (!win) window.location.href = url;   // popup blocked (window.open after an await)
};

const toBase64 = (bytes: Uint8Array) => {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

/**
 * Saves a file: Downloads + share sheet in the app, a normal download in a browser.
 * Returns where it was saved in the app ("Downloads/…"), "" in a browser. Throws when the app could not save it.
 */
export const saveFile = async (fileName: string, data: Blob): Promise<string> => {
  if (isAndroidApp()) {
    const base64 = toBase64(new Uint8Array(await data.arrayBuffer()));
    const where = window.AndroidApp!.saveFile(fileName, data.type || 'application/octet-stream', base64);
    if (!where) throw new Error('Could not save the file on this phone.');
    return where;
  }
  const url = URL.createObjectURL(data);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return '';
};

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
