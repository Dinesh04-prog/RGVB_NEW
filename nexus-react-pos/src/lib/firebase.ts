import { initializeApp, getApps } from 'firebase/app';
import {
  getFirestore, doc, setDoc, updateDoc,
  onSnapshot, collection, query, where, orderBy, deleteDoc, writeBatch,
} from 'firebase/firestore';
import { getStorage, ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import type { CartItem } from './db';

export interface InventoryItem {
  id: string;
  name: string;
  name_marathi?: string;
  name_eng?: string;
  brand?: string;
  search_key?: string;
  unit: string;
  price: number;
  purchase_price?: number;
  stock_quantity?: number;
  stock_qty?: number;
  barcode?: string;
  unit_rates?: Record<string, number>;
}

export interface ReviewSession {
  id: string;
  cashierName: string;
  cashierEmail: string;
  customerName: string;
  customerPhone: string;
  cart: CartItem[];
  status: 'pending' | 'approved' | 'rejected';
  updatedCart?: CartItem[];
  ownerNotes?: string;
  createdAt: number;
  approvedAt?: number;
  rejectedAt?: number;
}

const cfg = {
  apiKey:            import.meta.env.VITE_FIREBASE_API_KEY            ?? '',
  authDomain:        import.meta.env.VITE_FIREBASE_AUTH_DOMAIN        ?? '',
  projectId:         import.meta.env.VITE_FIREBASE_PROJECT_ID         ?? '',
  storageBucket:     import.meta.env.VITE_FIREBASE_STORAGE_BUCKET     ?? '',
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID ?? '',
  appId:             import.meta.env.VITE_FIREBASE_APP_ID             ?? '',
};

export const isFirebaseReady = !!(cfg.apiKey && cfg.projectId);

const firebaseApp = isFirebaseReady
  ? (getApps().length ? getApps()[0] : initializeApp(cfg))
  : null;

export const db = firebaseApp ? getFirestore(firebaseApp) : null;
export const storage = firebaseApp ? getStorage(firebaseApp) : null;

export const createReview = async (session: ReviewSession) => {
  if (!db) throw new Error('Firebase not configured — add keys to .env');
  await setDoc(doc(db, 'reviews', session.id), session);
};

export const approveReview = async (
  id: string, updatedCart: CartItem[], notes: string
) => {
  if (!db) throw new Error('Firebase not configured');
  await updateDoc(doc(db, 'reviews', id), {
    status: 'approved', updatedCart, ownerNotes: notes, approvedAt: Date.now(),
  });
};

export const rejectReview = async (id: string, notes: string) => {
  if (!db) throw new Error('Firebase not configured');
  await updateDoc(doc(db, 'reviews', id), {
    status: 'rejected', ownerNotes: notes, rejectedAt: Date.now(),
  });
};

export const deleteReview = async (id: string) => {
  if (!db) return;
  await deleteDoc(doc(db, 'reviews', id));
};

export const subscribeToReview = (
  id: string, cb: (s: ReviewSession | null) => void
) => {
  if (!db) return () => {};
  return onSnapshot(doc(db, 'reviews', id), snap =>
    cb(snap.exists() ? (snap.data() as ReviewSession) : null)
  );
};

export const subscribeToPendingReviews = (
  cb: (sessions: ReviewSession[]) => void
) => {
  if (!db) return () => {};
  const q = query(
    collection(db, 'reviews'),
    where('status', '==', 'pending'),
    orderBy('createdAt', 'desc')
  );
  return onSnapshot(q, snap =>
    cb(snap.docs.map(d => d.data() as ReviewSession))
  );
};

export const subscribeToAllReviews = (
  cb: (sessions: ReviewSession[]) => void
) => {
  if (!db) return () => {};
  const q = query(collection(db, 'reviews'), orderBy('createdAt', 'desc'));
  return onSnapshot(q, snap =>
    cb(snap.docs.map(d => d.data() as ReviewSession))
  );
};

// ── Inventory cloud sync ─────────────────────────────────────────────────────

// Save (add or edit) a single inventory item to Firestore.
export const saveInventoryItemToCloud = async (item: InventoryItem) => {
  if (!db) return;
  await setDoc(doc(db, 'inventory', item.id), { ...item, _updatedAt: Date.now() });
};

// Delete an item from Firestore.
export const removeInventoryItemFromCloud = async (id: string) => {
  if (!db) return;
  await deleteDoc(doc(db, 'inventory', id));
};

// Real-time listener for the full inventory collection.
export const subscribeToInventory = (
  cb: (items: InventoryItem[]) => void
) => {
  if (!db) return () => {};
  return onSnapshot(collection(db, 'inventory'), snap => {
    const items = snap.docs.map(d => {
      const { _updatedAt, ...item } = d.data();
      return item as InventoryItem;
    });
    cb(items);
  });
};

// Batch-write all inventory items to Firestore (chunks of 500 to respect Firestore limits).
export const bulkSaveInventoryToFirestore = async (items: InventoryItem[]) => {
  if (!db) return;
  const CHUNK = 500;
  for (let i = 0; i < items.length; i += CHUNK) {
    const batch = writeBatch(db);
    items.slice(i, i + CHUNK).forEach(item => {
      batch.set(doc(db!, 'inventory', item.id), { ...item, _updatedAt: Date.now() });
    });
    await batch.commit();
  }
};

// Upload the raw xlsx file to Firebase Storage at inventory/latest.xlsx.
export const uploadInventoryXlsx = async (file: File): Promise<string> => {
  if (!storage) throw new Error('Firebase Storage not configured');
  const storageRef = ref(storage, 'inventory/latest.xlsx');
  const snapshot = await uploadBytes(storageRef, file);
  return getDownloadURL(snapshot.ref);
};
