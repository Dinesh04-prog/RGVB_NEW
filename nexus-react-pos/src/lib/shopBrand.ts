// What a shop prints and shows: name, tagline, footer, logo, bill prefix, UPI. Every receipt (screen, WhatsApp,
// browser print, Bluetooth, Android printer) reads it from here, so nothing shop-specific is written in the code.
import type { Shop } from './firebase';
import { APP_NAME } from './appInfo';

export const DEFAULT_FOOTER = 'Thank You — Visit Again!';
export const DEFAULT_BILL_PREFIX = 'AA';

export interface ShopBrand {
  name: string;
  tagline: string;     // second line under the name, e.g. "Fresh Groceries & More"
  address: string;
  phone: string;
  whatsapp: string;    // owner's WhatsApp (country code, no +) for "Send to Owner"
  footer: string;
  logo: string;        // small JPEG data URL, '' = no logo
  billPrefix: string;  // bills are numbered PREFIX-DDMM-…
  upiId: string;       // e.g. shopname@okaxis, '' = no UPI QR
}

/** Letters and digits only, upper case, at most 4 (it is part of every bill number). */
export const cleanBillPrefix = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);

/** A UPI ID looks like name@bank. */
export const isValidUpiId = (s: string) => /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z][a-zA-Z0-9]{1,63}$/.test(s.trim());

export const brandOf = (shop: Shop | null | undefined): ShopBrand => ({
  name: shop?.name?.trim() || APP_NAME,
  tagline: shop?.tagline?.trim() || '',
  address: shop?.address?.trim() || '',
  phone: shop?.phone?.trim() || '',
  whatsapp: shop?.whatsapp?.trim() || '',
  footer: shop?.receiptFooter?.trim() || DEFAULT_FOOTER,
  logo: shop?.logo || '',
  billPrefix: cleanBillPrefix(shop?.billPrefix || '') || DEFAULT_BILL_PREFIX,
  upiId: shop?.upiId?.trim() || '',
});

/** True when a thermal printer can print the text in its own font (otherwise it is drawn as an image). */
export const isPrinterText = (s: string) => /^[\x20-\x7E]*$/.test(s);
