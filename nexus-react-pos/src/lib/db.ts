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
}

// Initialize LocalForage instances safely 
if (typeof window !== 'undefined') {
  localforage.config({
    name: 'NexusPOS_PWA',
    storeName: 'sales_store',
  });
}

// Save a sale locally
export const saveSale = async (items: CartItem[], total: number, customerName?: string, customerPhone?: string, receipt_no?: string): Promise<Receipt> => {
  const final_receipt_no = receipt_no || `AA-${new Date().toISOString().replace(/\D/g, '').slice(0, 8)}`;
  
  const receipt: Receipt = { receipt_no: final_receipt_no, date: new Date().toLocaleString(), items, total, customerName, customerPhone };
  
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

// Fetch sales history
export const getSalesHistory = async (): Promise<Receipt[]> => {
  if (typeof window === 'undefined') return [];
  return await localforage.getItem('sales') || [];
};
