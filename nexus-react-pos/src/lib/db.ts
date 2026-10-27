import localforage from 'localforage';
import { uploadSales, downloadSales, saleDocId, claimDeviceLetter, getActiveShopId } from './firebase';

export interface CartItem {
  id: string;
  name: string;
  name_marathi?: string;
  unit: string;
  qty: number;
  rate: number;
  total: number;
  cartUnit?: string;
  multiplier?: number;
}

export interface Receipt {
  receipt_no: string;
  date: string;
  items: CartItem[];
  total: number;
  customerName?: string;
  customerPhone?: string;
  isShortBill?: boolean;
}

// Initialize LocalForage instances safely 
if (typeof window !== 'undefined') {
  localforage.config({
    name: 'NexusPOS_PWA',
    storeName: 'sales_store',
  });
}

// Save a sale locally
export const saveSale = async (items: CartItem[], total: number, customerName?: string, customerPhone?: string, receipt_no?: string, isShortBill?: boolean): Promise<Receipt> => {
  const final_receipt_no = receipt_no || `AA-${new Date().toISOString().replace(/\D/g, '').slice(0, 8)}`;

  const receipt: Receipt = { receipt_no: final_receipt_no, date: new Date().toLocaleString(), items, total, customerName, customerPhone, isShortBill };
  
  try {
    const existingSales: Receipt[] = await localforage.getItem('sales') || [];
    existingSales.push(receipt);
    await localforage.setItem('sales', existingSales);
    void backupSalesToCloud();   // never makes the counter wait; offline it goes later
    return receipt;
  } catch (error) {
    console.error("Failed to save sale locally:", error);
    throw error;
  }
};

// Data kept on this phone for one shop. When the phone signs in to a different shop, the previous shop's copy is
// set aside under "<key>__<shopId>" (never deleted) so the two shops' items and bills do not mix.
const SHOP_LOCAL_KEYS = [
  'custom_inventory', 'sales', 'bill_counter', 'favorite_ids', 'held_bills', 'sb_held_bills', 'sales_backed_up', 'device_letter',
];

export const scopeLocalDataToShop = async (shopId: string) => {
  const current = await localforage.getItem<string>('local_shop_id');
  if (current === shopId) return;
  if (current) {
    for (const key of SHOP_LOCAL_KEYS) {
      const value = await localforage.getItem(key);
      if (value !== null) await localforage.setItem(`${key}__${current}`, value);
      await localforage.removeItem(key);
      // Coming back to a shop used before on this phone: put its copy back
      const previous = await localforage.getItem(`${key}__${shopId}`);
      if (previous !== null) { await localforage.setItem(key, previous); await localforage.removeItem(`${key}__${shopId}`); }
    }
  }
  // First sign-in after the update (no shop yet): the data already on the phone belongs to this shop
  await localforage.setItem('local_shop_id', shopId);
};

// Fetch sales history
export const getSalesHistory = async (): Promise<Receipt[]> => {
  if (typeof window === 'undefined') return [];
  return await localforage.getItem('sales') || [];
};

// ── Cloud copy of the bills ──────────────────────────────────────────────────

const BACKED_UP_KEY = 'sales_backed_up';   // ids (saleDocId) of the bills already in the cloud
let backingUp: Promise<void> | null = null;

/** Copies every bill not yet in the cloud. One run at a time; failures are retried on the next bill or app start. */
export const backupSalesToCloud = (): Promise<void> => {
  if (!getActiveShopId()) return Promise.resolve();
  if (backingUp) return backingUp;
  backingUp = (async () => {
    try {
      const sales = await getSalesHistory();
      const done = new Set(await localforage.getItem<string[]>(BACKED_UP_KEY) || []);
      const todo = sales.filter(r => !done.has(saleDocId(r)));
      if (todo.length === 0) return;
      await uploadSales(todo);
      todo.forEach(r => done.add(saleDocId(r)));
      await localforage.setItem(BACKED_UP_KEY, [...done]);
    } catch (err) {
      console.error('Bill backup failed:', err);
    } finally {
      backingUp = null;
    }
  })();
  return backingUp;
};

/** How many of this phone's bills are safely in the cloud. */
export const salesBackupStatus = async () => {
  const sales = await getSalesHistory();
  const done = new Set(await localforage.getItem<string[]>(BACKED_UP_KEY) || []);
  return { total: sales.length, backedUp: sales.filter(r => done.has(saleDocId(r))).length };
};

/** Adds the shop's bills from the cloud that this phone does not have. Returns how many were added. */
export const restoreSalesFromCloud = async (): Promise<number> => {
  const cloud = await downloadSales();
  const local = await getSalesHistory();
  const have = new Set(local.map(saleDocId));
  const added = cloud.filter(r => !have.has(saleDocId(r)));
  await localforage.setItem('sales', [...local, ...added]);
  const done = new Set(await localforage.getItem<string[]>(BACKED_UP_KEY) || []);
  cloud.forEach(r => done.add(saleDocId(r)));
  await localforage.setItem(BACKED_UP_KEY, [...done]);
  return added.length;
};

// ── This phone's letter in bill numbers (TK-2810-A001, TK-2810-B001 …) ──────

let claimingLetter: Promise<string> | null = null;

/** The letter this phone uses in bill numbers, so two phones never make the same number. */
export const getDeviceLetter = (): Promise<string> => {
  // One claim at a time: app start and the first bill must not each take a letter
  if (claimingLetter) return claimingLetter;
  claimingLetter = (async () => {
    try {
      const saved = await localforage.getItem<string>('device_letter');
      if (saved) return saved;
      const claimed = await claimDeviceLetter();
      if (claimed) { await localforage.setItem('device_letter', claimed); return claimed; }
      // Offline on the very first bill: a stand-in letter (not saved, so the real one is claimed once online)
      return 'Z';
    } finally {
      claimingLetter = null;
    }
  })();
  return claimingLetter;
};
