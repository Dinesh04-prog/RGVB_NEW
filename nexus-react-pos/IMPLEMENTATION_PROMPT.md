# Nexus POS — Mobile UI Redesign: Claude Code Implementation Prompt

## HOW TO USE
Paste this entire file as a prompt to **Claude Code**, **Cursor**, or your AI coding assistant.
All changes are **mobile-only (max-width: 992px)**. Desktop UI is completely unchanged.

---

## PROMPT START

You are working on a React + TypeScript Vite POS app (`nexus-react-pos`).
The app is called **Rajendra GVB Kirana POS** — `src/App.tsx` contains the entire UI.

**RULE: Do NOT change any desktop layout or logic. Only modify mobile styles and add the mobile-specific components below.**

---

## CHANGE 1 — Replace the entire `@media (max-width: 992px)` CSS block

Inside the `<style>` tag in `App.tsx`, find and **replace** the full `@media (max-width: 992px) { ... }` block with:

```css
@media (max-width: 992px) {

  /* ── Hide hamburger + sidebar completely on mobile ── */
  .sidebar           { display: none !important; }
  .hamburger-btn     { display: none !important; }
  .sidebar-overlay   { display: none !important; }

  /* ── Main content: full width, top + bottom padding for bars ── */
  .main-content {
    margin-left: 0 !important;
    padding: 0 0 72px !important;   /* 66px bottom-nav + 6px breathing room */
    width: 100%;
  }

  /* ── Fixed mobile top bar (new element, see Change 2) ── */
  .mobile-topbar {
    position: fixed;
    top: 0; left: 0; right: 0;
    height: 54px;
    background: #0a3d62;
    display: flex;
    align-items: center;
    padding: 0 10px 0 16px;
    gap: 4px;
    z-index: 900;
    box-shadow: 0 2px 8px rgba(0,0,0,.2);
  }
  .mobile-topbar-title {
    flex: 1;
    color: #fff;
    font-size: 17px;
    font-weight: 700;
  }
  .mobile-topbar-sub {
    color: rgba(255,255,255,.55);
    font-size: 11px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 190px;
  }

  /* ── Push content down below fixed top bar ── */
  .billing-header { margin-top: 54px; }

  /* ── Hide desktop billing header actions text, show icons only ── */
  .billing-header h2    { display: none; }
  .billing-header       { margin-bottom: 0; padding: 8px 0 0; }
  .billing-action-btn .btn-text { display: none; }
  .billing-action-btn   { padding: 10px 11px !important; font-size: 1.1rem !important; }
  .customer-btn         { max-width: unset; font-size: 0.8rem; padding: 10px 11px !important; }

  /* ── Hide the billing-header action row entirely (moved to topbar) ── */
  .billing-header > div:last-child { display: none !important; }

  /* ── Search bar ── */
  .search-container     { margin-top: 4px; }
  .search-inner-row     { gap: 6px; }
  #itemNameSearch       { height: 48px; font-size: 0.95rem; border-radius: 14px; }
  .scan-btn             { height: 48px; width: 48px; border-radius: 14px; font-size: 1.2rem; padding: 0; justify-content: center; }
  .ime-btn              { height: 48px; min-width: 48px; padding: 0; border-radius: 14px; font-size: 0.9rem; }
  .mic-btn              { height: 48px; padding: 0 14px; border-radius: 14px; font-size: 0.9rem; }
  .suggestions-container { top: 54px; border-radius: 16px; box-shadow: 0 8px 28px rgba(0,0,0,.14); }
  .suggestion-item      { padding: 13px 14px; min-height: 54px; }

  /* ── Total bar ── */
  .total-bar {
    border-radius: 0 !important;
    padding: 12px 16px !important;
    background: #18243a !important;
  }
  .total-bar h3 { font-size: 1.2rem !important; font-weight: 900; }
  .checkout-btn { padding: 13px 20px !important; font-size: 0.95rem !important; border-radius: 12px !important; }

  /* ── Desktop table hidden, mobile cards shown ── */
  .mobile-cart-card   { display: block; }
  .desktop-cart-table { display: none; }

  /* ── Mobile cart card redesign ── */
  .mobile-cart-card .card {
    border-radius: 18px !important;
    padding: 14px !important;
    margin-bottom: 10px !important;
    border: 1.5px solid #eceff5 !important;
    box-shadow: 0 2px 10px rgba(10,30,60,.07) !important;
  }

  /* ── Inventory cards ── */
  .kirana-vals        { grid-template-columns: 60px 65px 54px; }
  .kirana-col-header  { grid-template-columns: 60px 65px 54px; }
  .kirana-card        { border-radius: 16px; padding: 10px 12px; }

  /* ── Modals as bottom sheets ── */
  .modal-overlay {
    padding: 0 !important;
    align-items: flex-end !important;
  }
  .modal-content {
    border-radius: 26px 26px 0 0 !important;
    max-width: 100% !important;
    width: 100% !important;
    padding: 8px 20px 32px !important;
    max-height: 90vh !important;
    animation: slideUpSheet .22s ease;
  }
  .modal-content::before {
    content: '';
    display: block;
    width: 36px; height: 4px;
    background: #dde4ed;
    border-radius: 2px;
    margin: 10px auto 16px;
  }

  /* ── Bigger modal inputs ── */
  .modal-input  { font-size: 1.6rem !important; padding: 14px !important; border-radius: 14px !important; }
  .modal-btn    { padding: 17px !important; font-size: 1rem !important; border-radius: 14px !important; }

  /* ── Reports ── */
  .reports-profit { font-size: 2.8rem !important; }

  @keyframes slideUpSheet {
    from { transform: translateY(60px); opacity: 0; }
    to   { transform: translateY(0);    opacity: 1; }
  }
}
```

---

## CHANGE 2 — Add `MobileBottomNav` component

Add this new React component **before** the `return (` in `App.tsx` (outside the `App` function, near the top of the file, after the helper functions):

```tsx
// ── Mobile Bottom Navigation ──────────────────────────────────────────
const MobileBottomNav: React.FC<{
  activeTab: string;
  setActiveTab: (t: string) => void;
  cartCount: number;
  heldCount: number;
}> = ({ activeTab, setActiveTab, cartCount, heldCount }) => {
  const tabs = [
    { id: 'billing',   icon: '🧾', label: 'Billing'   },
    { id: 'inventory', icon: '📦', label: 'Stock'     },
    { id: 'reports',   icon: '📊', label: 'Reports'   },
    { id: 'receipts',  icon: '🗒️', label: 'Bills'     },
    { id: 'customers', icon: '👥', label: 'People'    },
  ];
  return (
    <div style={{
      position: 'fixed', bottom: 0, left: 0, right: 0,
      height: 66, background: '#fff',
      borderTop: '1.5px solid #eaecf2',
      display: 'flex', alignItems: 'center',
      padding: '4px 4px 0', zIndex: 950,
    }}>
      {tabs.map(t => (
        <div
          key={t.id}
          onClick={() => { setActiveTab(t.id); setSidebarOpen(false); }}
          style={{
            flex: 1, display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center',
            gap: 2, cursor: 'pointer', padding: '4px 2px 6px',
            borderRadius: 12, position: 'relative',
            WebkitTapHighlightColor: 'transparent',
          }}
        >
          {activeTab === t.id && (
            <div style={{
              position: 'absolute', top: 0, left: '50%',
              transform: 'translateX(-50%)',
              width: 22, height: 3,
              background: '#0a3d62',
              borderRadius: '0 0 3px 3px',
            }} />
          )}
          <div style={{ fontSize: 21, lineHeight: 1 }}>{t.icon}</div>
          <div style={{
            fontSize: 10, fontWeight: activeTab === t.id ? 700 : 600,
            color: activeTab === t.id ? '#0a3d62' : '#94a3b8',
            lineHeight: 1,
          }}>{t.label}</div>
          {t.id === 'billing' && cartCount > 0 && (
            <span style={{
              position: 'absolute', top: 5, right: '15%',
              background: '#0a3d62', color: '#fff',
              fontSize: 8, fontWeight: 800,
              borderRadius: 999, minWidth: 15, height: 15,
              display: 'flex', alignItems: 'center',
              justifyContent: 'center', padding: '0 3px',
              border: '1.5px solid #f0f2f7',
            }}>{cartCount}</span>
          )}
          {t.id === 'billing' && heldCount > 0 && cartCount === 0 && (
            <span style={{
              position: 'absolute', top: 5, right: '15%',
              background: '#f59e0b', color: '#fff',
              fontSize: 8, fontWeight: 800,
              borderRadius: 999, minWidth: 15, height: 15,
              display: 'flex', alignItems: 'center',
              justifyContent: 'center', padding: '0 3px',
              border: '1.5px solid #f0f2f7',
            }}>{heldCount}</span>
          )}
        </div>
      ))}
    </div>
  );
};
```

> **Note:** The `setSidebarOpen` call inside `onClick` references the parent scope. Either pass it as a prop, or replace with just `setActiveTab(t.id)` if sidebar state doesn't matter on mobile.

---

## CHANGE 3 — Render `MobileBottomNav` in the JSX

Inside the main `return (...)`, just before the closing `</>`, add:

```tsx
{/* Mobile bottom navigation — only on small screens */}
{typeof window !== 'undefined' && (
  <style>{`
    @media (min-width: 993px) { .mobile-bottom-nav { display: none !important; } }
  `}</style>
)}
<div className="mobile-bottom-nav">
  <MobileBottomNav
    activeTab={activeTab}
    setActiveTab={(t) => { setActiveTab(t); setSidebarOpen(false); }}
    cartCount={cart.length}
    heldCount={heldBills.length}
  />
</div>
```

---

## CHANGE 4 — Improve mobile cart card layout

In the **mobile cart card** JSX block (look for `className="mobile-cart-card"`), replace the inner card structure with:

```tsx
{cart.map((c, i) => (
  <div key={i} className="card" style={{ padding: '14px', marginBottom: '10px', borderRadius: 18, border: '1.5px solid #eceff5' }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
      <div style={{ flex: 1, cursor: 'pointer', minWidth: 0 }} onClick={() => editCartItem(i)}>
        <div style={{ fontWeight: 700, fontSize: '1rem', color: '#1a2535', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontFamily: '"Noto Sans Devanagari", sans-serif' }}>
          {c.name.toUpperCase()}
          <small style={{ color: '#94a3b8', fontWeight: 400, marginLeft: 5 }}>({c.unit})</small>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
          <span style={{ background: '#f3f6fa', border: '1px solid #e5eaf3', borderRadius: 8, padding: '4px 10px', fontSize: '0.78rem', color: '#455060', fontWeight: 500 }}>
            ×{c.qty} {c.cartUnit && c.cartUnit !== c.unit ? c.cartUnit : c.unit}
          </span>
          <span style={{ background: '#f3f6fa', border: '1px solid #e5eaf3', borderRadius: 8, padding: '4px 10px', fontSize: '0.78rem', color: '#455060', fontWeight: 500 }}>
            ₹{(c.rate * (c.multiplier || 1)).toFixed(2)}/{c.unit}
          </span>
        </div>
        <div style={{ fontSize: '0.68rem', color: '#c5ced8', marginTop: 4 }}>✏ tap to edit</div>
      </div>
      <div style={{ textAlign: 'right', flexShrink: 0 }}>
        <div style={{ fontWeight: 800, color: '#0a3d62', fontSize: '1.2rem', marginBottom: 8, lineHeight: 1 }}>₹{c.total.toFixed(2)}</div>
        <button className="btn-action danger" onClick={() => removeCartItem(i)} style={{ padding: '8px 14px', fontSize: '0.9rem', borderRadius: 8 }}>✕</button>
      </div>
    </div>
  </div>
))}
```

---

## CHANGE 5 — Add `@keyframes slideUpSheet` globally

In the `<style>` block (outside any media query, near the bottom), add:

```css
@keyframes slideUpSheet {
  from { transform: translateY(60px); opacity: 0; }
  to   { transform: translateY(0); opacity: 1; }
}
```

---

## CHANGE 6 — Inventory page: add top margin on mobile

In the inventory tab JSX, wrap the `<h2>` heading with a conditional top margin:

```tsx
<h2 style={{ fontWeight: 'bold', marginBottom: '1rem', marginTop: window.innerWidth < 992 ? 54 : 0 }}>Inventory</h2>
```

Do the same for Reports, Receipts, and Customers `<h2>` headings.

---

## SUMMARY OF WHAT CHANGES

| Area | Change |
|------|--------|
| **Navigation** | Hamburger + sidebar hidden → fixed bottom tab bar (5 tabs) |
| **Top bar** | New fixed top bar shows current section title + action icons |
| **Billing header** | Action buttons compressed to icon-only in top bar |
| **Cart cards** | Redesigned: name + chips row + right-aligned total + × button |
| **Search** | Larger touch targets, 48px height, 14px border-radius |
| **Modals** | Slide up from bottom as sheets (border-radius top only) |
| **Total bar** | Slightly taller, dark navy, above bottom nav |
| **Inventory** | Chips layout maintained, better tap targets |

---

## FILES TO MODIFY
- `src/App.tsx` — all changes above

## FILES TO ADD
- None required (all new code goes into App.tsx)

## DO NOT CHANGE
- Any desktop styles (min-width: 993px breakpoints)
- Any business logic (cart, inventory, Firebase, search, voice)
- Login page (`src/components/LoginPage.tsx`)
- Owner app (`src/components/OwnerApp.tsx`)
- Any files in `src/lib/` or `src/contexts/`
