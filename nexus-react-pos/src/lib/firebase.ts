import { initializeApp, getApps } from 'firebase/app';
import {
  getFirestore, doc, setDoc, updateDoc,
  onSnapshot, collection, query, where, orderBy, deleteDoc,
} from 'firebase/firestore';
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
  await setDoc(doc(db, 'inventory_overrides', item.id), {
    ...item, _updatedAt: Date.now(),
  });
};

// Mark an item as deleted in Firestore so other devices remove it.
export const removeInventoryItemFromCloud = async (id: string) => {
  if (!db) return;
  await setDoc(doc(db, 'inventory_overrides', id), {
    _deleted: true, _updatedAt: Date.now(),
  });
};

// Real-time listener — fires whenever any item is added/edited/deleted.
// Returns an unsubscribe function.
export const subscribeToInventoryOverrides = (
  cb: (overrides: Record<string, (InventoryItem & { _deleted?: boolean; _updatedAt?: number }) | { _deleted: true; _updatedAt: number }>) => void
) => {
  if (!db) return () => {};
  return onSnapshot(collection(db, 'inventory_overrides'), snap => {
    const map: Record<string, any> = {};
    snap.docs.forEach(d => { map[d.id] = d.data(); });
    cb(map);
  });
};

// Merge Firestore overrides on top of a base inventory array.
// Edited/added items replace the base; deleted items are removed.
export const applyInventoryOverrides = (
  base: InventoryItem[],
  overrides: Record<string, any>
): InventoryItem[] => {
  const map = new Map(base.map(i => [i.id, i]));
  for (const [id, data] of Object.entries(overrides)) {
    if (data._deleted) {
      map.delete(id);
    } else {
      const { _deleted: _d, _updatedAt: _t, ...item } = data;
      map.set(id, item as InventoryItem);
    }
  }
  return Array.from(map.values());
};
