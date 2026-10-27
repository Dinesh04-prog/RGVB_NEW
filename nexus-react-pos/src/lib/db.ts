import localforage from 'localforage';

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
    return receipt;
  } catch (error) {
    console.error("Failed to save sale locally:", error);
    throw error;
  }
};

// Data kept on this phone for one shop. When the phone signs in to a different shop, the previous shop's copy is
// set aside under "<key>__<shopId>" (never deleted) so the two shops' items and bills do not mix.
const SHOP_LOCAL_KEYS = ['custom_inventory', 'sales', 'bill_counter', 'favorite_ids', 'held_bills', 'sb_held_bills'];

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
