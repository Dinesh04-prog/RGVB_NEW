import { initializeApp, getApps } from 'firebase/app';
import {
  initializeAuth, indexedDBLocalPersistence, browserLocalPersistence, connectAuthEmulator,
  GoogleAuthProvider, signInWithCredential, signOut, onAuthStateChanged, type User,
} from 'firebase/auth';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, connectFirestoreEmulator, CACHE_SIZE_UNLIMITED,
  doc, getDoc, getDocs, getDocsFromCache, setDoc, updateDoc, deleteDoc, writeBatch,
  onSnapshot, collection, query, where, orderBy, limit, getCountFromServer, serverTimestamp, Timestamp,
  type QueryDocumentSnapshot,
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
  unit_rates?: Record<string, number>;
  net_qty?: string;      // pack size, e.g. "250 g"
  expiry_date?: string;  // ISO yyyy-MM-dd
  mfg_date?: string;     // ISO yyyy-MM-dd
  full_name_eng?: string; // long name read from the pack (search only; name/name_eng hold the short name)
  image?: string;        // small JPEG data URL (≤ 25 KB), never undefined in Firestore (see lib/itemImage.ts)
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

export type ShopRole = 'owner' | 'cashier';

/** shops/{shopId} — the shop's profile. Readable by its members only. */
export interface Shop {
  id: string;
  name: string;
  address: string;
  phone: string;
  whatsapp: string;      // owner's WhatsApp for "Send to Owner" (country code, no +)
  ownerUid: string;
  joinCode: string;      // 6 digits a cashier types to join
  createdAt: number;
  // Receipt settings (owner → Shop & Cashiers → Edit); see lib/shopBrand.ts for the defaults
  tagline?: string;
  receiptFooter?: string;
  billPrefix?: string;
  upiId?: string;
  logo?: string;         // small JPEG data URL (≤ 25 KB, same limits as item pictures)
}

/** shops/{shopId}/members/{uid} — who may use the shop, and as what. */
export interface ShopMember {
  uid: string;
  role: ShopRole;
  name: string;
  email: string;
  joinedAt: number;
  joinCode?: string;     // the code a cashier joined with (checked by the security rules)
}

export interface AppUser {
  uid: string;
  name: string;
  email: string;
  picture: string;
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
/** Local testing against the Firebase emulators (`npm run emulators`); never set in a real build. */
export const usingEmulators = import.meta.env.VITE_USE_EMULATORS === '1';

const firebaseApp = isFirebaseReady
  ? (getApps().length ? getApps()[0] : initializeApp(cfg))
  : null;

// No popup/redirect resolver: sign-in uses the Google ID token from the sign-in button (works inside the Android WebView)
const auth = firebaseApp
  ? initializeAuth(firebaseApp, { persistence: [indexedDBLocalPersistence, browserLocalPersistence] })
  : null;

// Offline cache on the phone: billing keeps working without internet, writes sync later. Never trimmed, because the
// inventory sync below reads the cached items instead of downloading them again (see subscribeToInventory).
export const db = firebaseApp
  ? initializeFirestore(firebaseApp, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager(), cacheSizeBytes: CACHE_SIZE_UNLIMITED }),
  })
  : null;

if (usingEmulators && auth && db) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
}

// ── Sign-in ──────────────────────────────────────────────────────────────────

const toAppUser = (u: User): AppUser => ({
  uid: u.uid, name: u.displayName || u.email || 'User', email: u.email || '', picture: u.photoURL || '',
});

export const onUserChanged = (cb: (u: AppUser | null) => void) => {
  if (!auth) { cb(null); return () => {}; }
  return onAuthStateChanged(auth, u => cb(u ? toAppUser(u) : null));
};

/** Signs in to Firebase with the ID token from the Google sign-in button. */
export const signInWithGoogleIdToken = async (idToken: string) => {
  if (!auth) throw new Error('Firebase not configured');
  await signInWithCredential(auth, GoogleAuthProvider.credential(idToken));
};

/** Emulator only: a fake Google account, so sign-in can be tested without a real one. */
export const signInTestUser = async (email: string, name: string) => {
  if (!auth || !usingEmulators) throw new Error('Test sign-in only works with the emulators');
  const fakeToken = JSON.stringify({ sub: `test-${email}`, email, name, email_verified: true });
  await signInWithCredential(auth, GoogleAuthProvider.credential(fakeToken));
};

export const signOutUser = async () => { if (auth) await signOut(auth); };

// ── The active shop: every data path below is shops/{activeShopId}/… ────────

let activeShopId: string | null = null;
export const setActiveShop = (shopId: string | null) => { activeShopId = shopId; };
export const getActiveShopId = () => activeShopId;

const shopCol = (name: 'inventory' | 'reviews' | 'members') => {
  if (!db || !activeShopId) throw new Error('No shop selected');
  return collection(db, 'shops', activeShopId, name);
};
const shopDoc = (name: 'inventory' | 'reviews' | 'members', id: string) => doc(shopCol(name), id);
const ready = () => !!(db && activeShopId);

// ── Shops, members and join codes ────────────────────────────────────────────

const randomJoinCode = () => String(Math.floor(100000 + Math.random() * 900000));

/** A 6-digit code not used by any other shop. */
const freeJoinCode = async (): Promise<string> => {
  for (let i = 0; i < 8; i++) {
    const code = randomJoinCode();
    if (!(await getDoc(doc(db!, 'joinCodes', code))).exists()) return code;
  }
  throw new Error('Could not make a join code, try again');
};

/** The shop this user belongs to (users/{uid}.shopId), only if they are still a member. */
export const loadMyShop = async (uid: string): Promise<{ shop: Shop; role: ShopRole } | null> => {
  if (!db) return null;
  const me = await getDoc(doc(db, 'users', uid));
  const shopId = me.exists() ? (me.data().shopId as string | undefined) : undefined;
  if (!shopId) return null;
  const member = await getDoc(doc(db, 'shops', shopId, 'members', uid));
  if (!member.exists()) return null;   // removed by the owner
  const shop = await getDoc(doc(db, 'shops', shopId));
  if (!shop.exists()) return null;
  return { shop: { ...(shop.data() as Shop), id: shop.id }, role: (member.data() as ShopMember).role };
};

export interface NewShopInfo { name: string; address: string; phone: string; whatsapp: string }

/** Creates a shop with this user as its owner. */
export const createShop = async (user: AppUser, info: NewShopInfo): Promise<Shop> => {
  if (!db) throw new Error('Firebase not configured');
  const shopRef = doc(collection(db, 'shops'));
  const joinCode = await freeJoinCode();
  const shop: Shop = { id: shopRef.id, ...info, ownerUid: user.uid, joinCode, createdAt: Date.now() };
  const owner: ShopMember = { uid: user.uid, role: 'owner', name: user.name, email: user.email, joinedAt: Date.now() };
  const batch = writeBatch(db);
  batch.set(shopRef, shop);
  batch.set(doc(db, 'shops', shopRef.id, 'members', user.uid), owner);
  batch.set(doc(db, 'joinCodes', joinCode), { shopId: shopRef.id });
  batch.set(doc(db, 'users', user.uid), { shopId: shopRef.id, updatedAt: Date.now() });
  await batch.commit();
  return shop;
};

/** Joins a shop as a cashier with the owner's 6-digit code. */
export const joinShopWithCode = async (user: AppUser, rawCode: string): Promise<void> => {
  if (!db) throw new Error('Firebase not configured');
  const code = rawCode.replace(/\D/g, '');
  if (code.length !== 6) throw new Error('Enter the 6-digit code');
  const found = await getDoc(doc(db, 'joinCodes', code));
  if (!found.exists()) throw new Error('No shop has this code. Check it with the owner.');
  const shopId = found.data().shopId as string;
  const me: ShopMember = { uid: user.uid, role: 'cashier', name: user.name, email: user.email, joinedAt: Date.now(), joinCode: code };
  await setDoc(doc(db, 'shops', shopId, 'members', user.uid), me);
  await setDoc(doc(db, 'users', user.uid), { shopId, updatedAt: Date.now() });
};

// ── Cashier invites by Gmail: invites/{email} → the shop that person joins when they sign in ─

export interface ShopInvite { email: string; shopId: string; shopName: string; invitedBy: string; createdAt: number }

const emailKey = (email: string) => email.trim().toLowerCase();

/** Owner: lets this Gmail join the shop as a cashier just by signing in. */
export const inviteCashier = async (shop: Shop, invitedByUid: string, rawEmail: string) => {
  if (!db) throw new Error('Firebase not configured');
  const email = emailKey(rawEmail);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid email address');
  const invite: ShopInvite = { email, shopId: shop.id, shopName: shop.name, invitedBy: invitedByUid, createdAt: Date.now() };
  try { await setDoc(doc(db, 'invites', email), invite); }
  catch (err) {
    // The rules refuse to overwrite another shop's invite for the same address
    if ((err as { code?: string }).code === 'permission-denied') throw new Error('This email was already added by another shop.', { cause: err });
    throw err;
  }
};

export const cancelInvite = async (email: string) => {
  if (!db) return;
  await deleteDoc(doc(db, 'invites', emailKey(email)));
};

/** Owner: cashiers added by email who have not signed in yet. */
export const subscribeToInvites = (shopId: string, cb: (invites: ShopInvite[]) => void) => {
  if (!db) return () => {};
  return onSnapshot(query(collection(db, 'invites'), where('shopId', '==', shopId)),
    snap => cb(snap.docs.map(d => d.data() as ShopInvite).sort((a, b) => a.createdAt - b.createdAt)),
    () => cb([]));
};

/** Signed-in user without a shop: joins the shop that added their email, if any. True when joined. */
export const acceptInvite = async (user: AppUser): Promise<boolean> => {
  if (!db || !user.email) return false;
  const ref = doc(db, 'invites', emailKey(user.email));
  const snap = await getDoc(ref).catch(() => null);
  if (!snap?.exists()) return false;
  const { shopId } = snap.data() as ShopInvite;
  const me: ShopMember = { uid: user.uid, role: 'cashier', name: user.name, email: user.email, joinedAt: Date.now() };
  await setDoc(doc(db, 'shops', shopId, 'members', user.uid), me);
  await setDoc(doc(db, 'users', user.uid), { shopId, updatedAt: Date.now() });
  await deleteDoc(ref).catch(() => { /* used once; the owner can tidy it up */ });
  return true;
};

/** Owner: a new join code (the old one stops working). */
export const changeJoinCode = async (shop: Shop): Promise<string> => {
  if (!db) throw new Error('Firebase not configured');
  const code = await freeJoinCode();
  const batch = writeBatch(db);
  batch.set(doc(db, 'joinCodes', code), { shopId: shop.id });
  batch.delete(doc(db, 'joinCodes', shop.joinCode));
  batch.update(doc(db, 'shops', shop.id), { joinCode: code });
  await batch.commit();
  return code;
};

export const subscribeToShop = (shopId: string, cb: (s: Shop | null) => void) => {
  if (!db) return () => {};
  return onSnapshot(doc(db, 'shops', shopId), snap => cb(snap.exists() ? { ...(snap.data() as Shop), id: snap.id } : null));
};

export const updateShop = async (shopId: string, changes: Partial<Omit<Shop, 'id' | 'ownerUid' | 'joinCode' | 'createdAt'>>) => {
  if (!db) throw new Error('Firebase not configured');
  await updateDoc(doc(db, 'shops', shopId), changes);
};

export const subscribeToMembers = (cb: (m: ShopMember[]) => void) => {
  if (!ready()) return () => {};
  return onSnapshot(shopCol('members'), snap =>
    cb(snap.docs.map(d => d.data() as ShopMember).sort((a, b) => a.joinedAt - b.joinedAt)));
};

/** Owner: removes a cashier from the shop. */
export const removeMember = async (uid: string) => {
  if (!ready()) return;
  await deleteDoc(shopDoc('members', uid));
};

/** Cashier: leaves the shop (can join another one after). */
export const leaveShop = async (uid: string) => {
  if (!db || !activeShopId) return;
  await deleteDoc(doc(db, 'shops', activeShopId, 'members', uid));
  await deleteDoc(doc(db, 'users', uid));
};

// ── Old single-shop data (root `inventory` collection, before shops existed) ─

/** How many items the old shared inventory has (0 when there is none). */
export const legacyInventoryCount = async (): Promise<number> => {
  if (!db) return 0;
  try { return (await getCountFromServer(collection(db, 'inventory'))).data().count; }
  catch { return 0; }   // no access / offline
};

/** Copies the old shared inventory into the active shop. */
export const importLegacyInventory = async (onProgress?: (done: number, total: number) => void): Promise<number> => {
  if (!db || !activeShopId) throw new Error('No shop selected');
  const snap = await getDocs(collection(db, 'inventory'));
  const items = snap.docs.filter(d => !d.get('deleted')).map(d => ({ ...toItem(d), id: d.id }));
  await bulkSaveInventoryToFirestore(items, onProgress);
  return items.length;
};

// ── Bill reviews (cashier → owner) ───────────────────────────────────────────

export const createReview = async (session: ReviewSession) => {
  if (!ready()) throw new Error('Firebase not configured — add keys to .env');
  await setDoc(shopDoc('reviews', session.id), session);
};

export const approveReview = async (
  id: string, updatedCart: CartItem[], notes: string
) => {
  if (!ready()) throw new Error('Firebase not configured');
  await updateDoc(shopDoc('reviews', id), {
    status: 'approved', updatedCart, ownerNotes: notes, approvedAt: Date.now(),
  });
};

export const rejectReview = async (id: string, notes: string) => {
  if (!ready()) throw new Error('Firebase not configured');
  await updateDoc(shopDoc('reviews', id), {
    status: 'rejected', ownerNotes: notes, rejectedAt: Date.now(),
  });
};

export const subscribeToReview = (
  id: string, cb: (s: ReviewSession | null) => void
) => {
  if (!ready()) return () => {};
  return onSnapshot(shopDoc('reviews', id), snap =>
    cb(snap.exists() ? (snap.data() as ReviewSession) : null)
  );
};

export const subscribeToPendingReviews = (
  cb: (sessions: ReviewSession[]) => void
) => {
  if (!ready()) return () => {};
  // Sorted here, not in the query: where(status) + orderBy(createdAt) needs a composite index the project does not have
  const q = query(shopCol('reviews'), where('status', '==', 'pending'));
  return onSnapshot(q, snap =>
    cb(snap.docs.map(d => d.data() as ReviewSession).sort((a, b) => b.createdAt - a.createdAt))
  );
};

// Newest bills first, at most `max` of them (reviews are never deleted, so the full list only grows).
export const subscribeToRecentReviews = (
  max: number, cb: (sessions: ReviewSession[]) => void
) => {
  if (!ready()) return () => {};
  const q = query(shopCol('reviews'), orderBy('createdAt', 'desc'), limit(max));
  return onSnapshot(q, snap =>
    cb(snap.docs.map(d => d.data() as ReviewSession))
  );
};

// Every bill sent since `since` (ms), e.g. the start of today, for the owner's day summary.
export const subscribeToReviewsSince = (
  since: number, cb: (sessions: ReviewSession[]) => void
) => {
  if (!ready()) return () => {};
  const q = query(shopCol('reviews'), where('createdAt', '>=', since), orderBy('createdAt', 'desc'));
  return onSnapshot(q, snap =>
    cb(snap.docs.map(d => d.data() as ReviewSession))
  );
};

// ── Inventory cloud sync ─────────────────────────────────────────────────────
//
// Kept cheap for the free plan: every item carries `_updatedAt` (the server's clock, so a phone with a wrong clock
// cannot hide its changes), deleting leaves a small `{ deleted: true }` marker instead of removing the document,
// and a phone reads its cached items for free and then asks the server only for items changed since the newest one
// it has. A phone downloads the whole list once, the first time it opens the shop.

const toItem = (d: QueryDocumentSnapshot): InventoryItem => {
  const data = { ...d.data() };
  delete data._updatedAt;
  delete data.deleted;
  return data as InventoryItem;
};

// Save (add or edit) a single inventory item to Firestore.
export const saveInventoryItemToCloud = async (item: InventoryItem) => {
  if (!ready()) return;
  await setDoc(shopDoc('inventory', item.id), { ...item, _updatedAt: serverTimestamp() });
};

// Delete an item: a marker every phone picks up on its next sync.
export const removeInventoryItemFromCloud = async (id: string) => {
  if (!ready()) return;
  await setDoc(shopDoc('inventory', id), { id, deleted: true, _updatedAt: serverTimestamp() });
};

/** Live inventory of the active shop: cached items first, then only the changes from the server. */
export const subscribeToInventory = (
  cb: (items: InventoryItem[]) => void
) => {
  if (!ready()) return () => {};
  const col = shopCol('inventory');
  const items = new Map<string, InventoryItem>();
  const apply = (d: QueryDocumentSnapshot) => {
    if (d.get('deleted')) items.delete(d.id); else items.set(d.id, toItem(d));
  };
  let stopped = false;
  let stopListening = () => {};

  (async () => {
    // 1. Items already on this phone (no server reads)
    let newest: Timestamp | null = null;
    try {
      const cached = await getDocsFromCache(col);
      cached.docs.forEach(d => {
        apply(d);
        const t = d.get('_updatedAt');
        if (t instanceof Timestamp && (!newest || t.toMillis() > newest.toMillis())) newest = t;
      });
      if (items.size > 0) cb([...items.values()]);
    } catch { /* nothing cached yet */ }
    const fromPhone = items.size;
    if (stopped) return;

    // 2. Only what changed since then (everything, the first time), and every later change live
    const changes = newest ? query(col, where('_updatedAt', '>', newest)) : col;
    stopListening = onSnapshot(changes, snap => {
      // 'removed' = the document itself was deleted (older app versions deleted instead of marking)
      snap.docChanges().forEach(c => { if (c.type === 'removed') items.delete(c.doc.id); else apply(c.doc); });
      console.debug(`[sync] inventory: ${fromPhone} on this phone, ${snap.docChanges().length} downloaded`);
      cb([...items.values()]);
    }, err => console.error('Inventory sync failed:', err));
  })();

  return () => { stopped = true; stopListening(); };
};

// Batch-write all inventory items to Firestore (chunks of 500 to respect Firestore limits).
export const bulkSaveInventoryToFirestore = async (
  items: InventoryItem[], onProgress?: (done: number, total: number) => void,
) => {
  if (!ready()) return;
  const CHUNK = 500;
  for (let i = 0; i < items.length; i += CHUNK) {
    const batch = writeBatch(db!);
    items.slice(i, i + CHUNK).forEach(item => {
      batch.set(shopDoc('inventory', item.id), { ...item, _updatedAt: serverTimestamp() });
    });
    await batch.commit();
    onProgress?.(Math.min(i + CHUNK, items.length), items.length);
  }
};
