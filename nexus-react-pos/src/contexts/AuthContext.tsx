import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { googleLogout } from '@react-oauth/google';
import { doc, onSnapshot } from 'firebase/firestore';
import {
  db, onUserChanged, signOutUser, loadMyShop, setActiveShop, subscribeToShop,
  type AppUser, type Shop, type ShopRole,
} from '../lib/firebase';
import { scopeLocalDataToShop } from '../lib/db';

export type AuthUser = AppUser;

interface AuthContextType {
  /** Firebase user, null when signed out. */
  user: AuthUser | null;
  /** The shop this user belongs to, null until they create or join one. */
  shop: Shop | null;
  role: ShopRole | null;
  isOwner: boolean;
  /** False while sign-in or the shop is still loading. */
  ready: boolean;
  /** Re-reads the user's shop (after creating or joining one). */
  refreshShop: () => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [shop, setShop] = useState<Shop | null>(null);
  const [role, setRole] = useState<ShopRole | null>(null);
  const [ready, setReady] = useState(false);

  const applyShop = useCallback(async (u: AuthUser | null) => {
    const mine = u ? await loadMyShop(u.uid).catch(err => { console.error('Shop load failed:', err); return null; }) : null;
    if (mine) await scopeLocalDataToShop(mine.shop.id);
    setActiveShop(mine?.shop.id ?? null);
    setShop(mine?.shop ?? null);
    setRole(mine?.role ?? null);
  }, []);

  useEffect(() => onUserChanged(async u => {
    setReady(false);
    setUser(u);
    await applyShop(u);
    setReady(true);
  }), [applyShop]);

  // Live shop profile (name, join code…) and membership: removed by the owner → back to the shop setup screen
  const shopId = shop?.id ?? null;
  const uid = user?.uid ?? null;
  useEffect(() => {
    if (!shopId || !uid || !db) return;
    const stopShop = subscribeToShop(shopId, s => { if (s) setShop(s); });
    const removed = () => { setActiveShop(null); setShop(null); setRole(null); };
    const stopMember = onSnapshot(doc(db, 'shops', shopId, 'members', uid), snap => {
      if (!snap.exists()) removed();
    }, err => {
      // A removed member may no longer read their own record; offline errors keep the shop
      if ((err as { code?: string }).code === 'permission-denied') removed();
    });
    return () => { stopShop(); stopMember(); };
  }, [shopId, uid]);

  const refreshShop = useCallback(async () => { await applyShop(user); }, [applyShop, user]);

  const logout = useCallback(() => {
    try { googleLogout(); } catch { /* not loaded */ }
    signOutUser().catch(err => console.error('Sign-out failed:', err));
  }, []);

  return (
    <AuthContext.Provider value={{ user, shop, role, isOwner: role === 'owner', ready, refreshShop, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
