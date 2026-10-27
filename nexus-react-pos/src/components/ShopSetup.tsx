import { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { createShop, joinShopWithCode } from '../lib/firebase';
import { APP_NAME } from '../lib/appInfo';

// First screen after sign-in for someone without a shop: create one (becomes its owner) or join one with a code (cashier).

const CSS = `
  .ss-wrap { min-height: 100vh; background: linear-gradient(135deg, #0a3d62 0%, #145c91 100%); display: flex; align-items: flex-start; justify-content: center; padding: 24px 16px; font-family: 'Segoe UI', sans-serif; box-sizing: border-box; }
  .ss-wrap *, .ss-wrap *::before, .ss-wrap *::after { box-sizing: border-box; }
  .ss-card { background: white; border-radius: 18px; padding: 22px 18px; width: 100%; max-width: 440px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); }
  .ss-choice { width: 100%; text-align: left; border: 2px solid #e2e8f0; border-radius: 14px; background: white; padding: 14px 16px; cursor: pointer; display: flex; gap: 14px; align-items: center; margin-bottom: 12px; min-height: 72px; }
  .ss-choice:hover { border-color: #0a3d62; background: #f8fbff; }
  .ss-label { display: block; font-size: 0.78rem; font-weight: 700; color: #6c757d; margin: 12px 0 4px; }
  .ss-input { width: 100%; height: 48px; border: 1.5px solid #cbd5e1; border-radius: 10px; padding: 0 12px; font-size: 1rem; }
  .ss-input:focus { outline: none; border-color: #0a3d62; }
  .ss-code { text-align: center; font-size: 1.8rem; letter-spacing: 0.4em; font-weight: 800; height: 60px; }
  .ss-btn { width: 100%; min-height: 50px; border: none; border-radius: 12px; background: #16A34A; color: white; font-weight: 800; font-size: 1rem; cursor: pointer; margin-top: 18px; }
  .ss-btn:disabled { opacity: 0.6; cursor: default; }
  .ss-link { background: none; border: none; color: #0a3d62; font-weight: 700; cursor: pointer; min-height: 44px; padding: 0 6px; font-size: 0.9rem; }
  .ss-error { color: #DC2626; font-size: 0.85rem; font-weight: 600; margin-top: 10px; }
`;

type Mode = 'choose' | 'create' | 'join';

export default function ShopSetup() {
  const { user, refreshShop, logout } = useAuth();
  const [mode, setMode] = useState<Mode>('choose');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [phone, setPhone] = useState('');
  const [whatsapp, setWhatsapp] = useState('');
  const [code, setCode] = useState('');

  if (!user) return null;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await fn(); await refreshShop(); }
    catch (err) {
      console.error(err);
      const msg = err instanceof Error ? err.message : '';
      setError(/permission|insufficient/i.test(msg) ? 'Not allowed. Check the code with the shop owner.' : (msg || 'Something went wrong. Try again.'));
      setBusy(false);
    }
  };

  const digits = (s: string) => s.replace(/\D/g, '');
  // WhatsApp number with country code, no +: a 10-digit Indian number gets 91 in front
  const waNumber = (s: string) => { const d = digits(s); return d.length === 10 ? `91${d}` : d; };

  const submitCreate = () => {
    if (!name.trim()) { setError('Enter the shop name'); return; }
    run(async () => {
      await createShop(user, { name: name.trim(), address: address.trim(), phone: digits(phone), whatsapp: waNumber(whatsapp || phone) });
    });
  };

  const submitJoin = () => run(() => joinShopWithCode(user, code));

  return (
    <div className="ss-wrap">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <div className="ss-card">
        <div style={{ textAlign: 'center', marginBottom: 16 }}>
          <div style={{ fontSize: '2.4rem' }}>🛒</div>
          <div style={{ fontWeight: 800, fontSize: '1.3rem', color: '#0a3d62' }}>{APP_NAME}</div>
          <div style={{ fontSize: '0.85rem', color: '#6b7280', marginTop: 4 }}>Signed in as <b>{user.email || user.name}</b></div>
        </div>

        {mode === 'choose' && (
          <>
            <button className="ss-choice" onClick={() => { setMode('create'); setError(''); }}>
              <span style={{ fontSize: '2rem' }}>🏪</span>
              <span><b style={{ fontSize: '1.05rem', color: '#0a3d62' }}>Create my shop</b><br />
                <span style={{ fontSize: '0.85rem', color: '#6b7280' }}>I own the shop. I will add items and cashiers.</span></span>
            </button>
            <button className="ss-choice" onClick={() => { setMode('join'); setError(''); }}>
              <span style={{ fontSize: '2rem' }}>🔑</span>
              <span><b style={{ fontSize: '1.05rem', color: '#0a3d62' }}>Join a shop</b><br />
                <span style={{ fontSize: '0.85rem', color: '#6b7280' }}>I work at a shop. The owner gave me a 6-digit code.</span></span>
            </button>
          </>
        )}

        {mode === 'create' && (
          <>
            <div style={{ fontWeight: 800, fontSize: '1.1rem', color: '#0a3d62' }}>🏪 Create my shop</div>
            <label className="ss-label">SHOP NAME *</label>
            <input className="ss-input" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Rajendra General Stores" autoFocus />
            <label className="ss-label">ADDRESS</label>
            <input className="ss-input" value={address} onChange={e => setAddress(e.target.value)} placeholder="Street, area, city" />
            <label className="ss-label">SHOP PHONE</label>
            <input className="ss-input" value={phone} onChange={e => setPhone(e.target.value)} inputMode="tel" placeholder="10-digit mobile" />
            <label className="ss-label">OWNER WHATSAPP (for bill approvals)</label>
            <input className="ss-input" value={whatsapp} onChange={e => setWhatsapp(e.target.value)} inputMode="tel" placeholder="Same as shop phone if empty" />
            {error && <div className="ss-error">{error}</div>}
            <button className="ss-btn" disabled={busy} onClick={submitCreate}>{busy ? 'Creating…' : 'Create shop'}</button>
          </>
        )}

        {mode === 'join' && (
          <>
            <div style={{ fontWeight: 800, fontSize: '1.1rem', color: '#0a3d62' }}>🔑 Join a shop</div>
            <p style={{ fontSize: '0.85rem', color: '#6b7280', margin: '6px 0 0' }}>Ask the owner for the code. It is in their app under ☰ → Shop.</p>
            <label className="ss-label">6-DIGIT CODE</label>
            <input className="ss-input ss-code" value={code} inputMode="numeric" maxLength={6} autoFocus
              onChange={e => setCode(digits(e.target.value).slice(0, 6))}
              onKeyDown={e => { if (e.key === 'Enter' && code.length === 6) submitJoin(); }} />
            {error && <div className="ss-error">{error}</div>}
            <button className="ss-btn" disabled={busy || code.length !== 6} onClick={submitJoin}>{busy ? 'Joining…' : 'Join shop'}</button>
          </>
        )}

        <div style={{ display: 'flex', justifyContent: mode === 'choose' ? 'center' : 'space-between', marginTop: 14 }}>
          {mode !== 'choose' && <button className="ss-link" onClick={() => { setMode('choose'); setError(''); }}>← Back</button>}
          <button className="ss-link" style={{ color: '#6b7280' }} onClick={logout}>Sign out</button>
        </div>
      </div>
    </div>
  );
}
