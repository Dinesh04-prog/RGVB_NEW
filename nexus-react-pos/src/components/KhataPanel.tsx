import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import {
  addKhataEntry, subscribeToKhata, subscribeToKhataEntries, writeOrQueue, khataKey,
  type KhataAccount, type KhataEntry,
} from '../lib/firebase';
import { brandOf } from '../lib/shopBrand';
import { openExternalUrl } from '../lib/androidApp';

// Udhaar / khata: who owes the shop how much. Shared by the cashier app and the Owner app.

const CSS = `
  .kh-card { background: white; border-radius: 15px; box-shadow: 0 4px 12px rgba(0,0,0,0.05); padding: 14px; margin-bottom: 12px; }
  .kh-total { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; }
  .kh-input { width: 100%; height: 46px; border: 1.5px solid #cbd5e1; border-radius: 10px; padding: 0 12px; font-size: 1rem; box-sizing: border-box; }
  .kh-input:focus { outline: none; border-color: #0a3d62; }
  .kh-btn { min-height: 46px; border: none; border-radius: 10px; color: white; font-weight: 800; cursor: pointer; padding: 0 14px; font-size: 0.92rem; }
  .kh-btn.outline { background: white; color: #0a3d62; border: 1.5px solid #0a3d62; }
  .kh-btn:disabled { opacity: 0.6; cursor: default; }
  .kh-row { display: flex; align-items: center; gap: 10px; padding: 12px 4px; border-top: 1px solid #f1f1f1; cursor: pointer; min-height: 56px; }
  .kh-row:first-child { border-top: none; }
  .kh-row:hover { background: #f8fbff; }
  .kh-amt { font-weight: 800; font-size: 1.05rem; flex-shrink: 0; }
  .kh-label { display: block; font-size: 0.75rem; font-weight: 700; color: #6c757d; margin: 10px 0 4px; }
  .kh-two { display: flex; gap: 10px; }
  .kh-two > * { flex: 1; min-width: 0; }
  .kh-entry { display: flex; justify-content: space-between; gap: 10px; padding: 9px 2px; border-top: 1px dashed #e5e7eb; font-size: 0.88rem; }
`;

const rupees = (n: number) => `₹${Math.abs(n).toFixed(2)}`;
const when = (ms: number) => new Date(ms).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

type Form = { mode: 'udhaar' | 'payment'; name: string; phone: string; amount: string; note: string } | null;

export default function KhataPanel() {
  const { shop } = useAuth();
  const brand = brandOf(shop);
  const [accounts, setAccounts] = useState<KhataAccount[]>([]);
  const [search, setSearch] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [entries, setEntries] = useState<KhataEntry[]>([]);
  const [form, setForm] = useState<Form>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => subscribeToKhata(setAccounts), []);
  useEffect(() => (openId ? subscribeToKhataEntries(openId, setEntries) : undefined), [openId]);

  const open = accounts.find(a => a.id === openId) || null;
  const outstanding = accounts.reduce((sum, a) => sum + Math.max(0, a.balance), 0);
  const owing = accounts.filter(a => a.balance > 0.005).length;
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? accounts.filter(a => a.name.toLowerCase().includes(q) || a.phone.includes(q)) : accounts;
  }, [accounts, search]);

  const startForm = (mode: 'udhaar' | 'payment', who?: KhataAccount) =>
    { setError(''); setForm({ mode, name: who?.name || '', phone: who?.phone || '', amount: '', note: '' }); };

  const save = async () => {
    if (!form) return;
    const amount = Math.round(parseFloat(form.amount) * 100) / 100;
    if (!form.name.trim() && form.phone.replace(/\D/g, '').length !== 10) { setError('Enter the customer name or 10-digit mobile'); return; }
    if (!(amount > 0)) { setError('Enter the amount'); return; }
    setBusy(true); setError('');
    try {
      // Offline: kept on this phone and added when the internet is back
      await writeOrQueue(addKhataEntry({ name: form.name, phone: form.phone }, { type: form.mode, amount, note: form.note }));
      setOpenId(khataKey(form.name.trim() || form.phone, form.phone));
      setForm(null);
    } catch (err) {
      console.error(err); setError('Could not save. Try again.');
    } finally { setBusy(false); }
  };

  const remind = (a: KhataAccount) => {
    const msg = `Namaste ${a.name},\nYour pending amount at ${brand.name} is ${rupees(a.balance)}.` +
      (brand.upiId ? `\nPay by UPI: ${brand.upiId}` : '') + `\nThank you.`;
    openExternalUrl(`https://wa.me/91${a.phone}?text=${encodeURIComponent(msg)}`);
  };

  // ── Add udhaar / payment form ──
  if (form) return (
    <div>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <div className="kh-card">
        <div style={{ fontWeight: 800, color: '#0a3d62', fontSize: '1.05rem' }}>
          {form.mode === 'udhaar' ? '➕ Add udhaar (customer takes on credit)' : '💰 Payment received'}
        </div>
        <div className="kh-two">
          <div>
            <label className="kh-label">CUSTOMER NAME</label>
            <input className="kh-input" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} autoFocus={!form.name} />
          </div>
          <div>
            <label className="kh-label">MOBILE</label>
            <input className="kh-input" value={form.phone} inputMode="tel" onChange={e => setForm({ ...form, phone: e.target.value })} />
          </div>
        </div>
        <label className="kh-label">AMOUNT (₹)</label>
        <input className="kh-input" value={form.amount} inputMode="decimal" style={{ fontSize: '1.3rem', fontWeight: 800 }}
          autoFocus={!!form.name} onChange={e => setForm({ ...form, amount: e.target.value.replace(/[^\d.]/g, '') })}
          onKeyDown={e => { if (e.key === 'Enter') save(); }} />
        <label className="kh-label">NOTE (optional)</label>
        <input className="kh-input" value={form.note} onChange={e => setForm({ ...form, note: e.target.value })} />
        {error && <div style={{ color: '#DC2626', fontWeight: 600, fontSize: '0.85rem', marginTop: 8 }}>{error}</div>}
        <div className="kh-two" style={{ marginTop: 14 }}>
          <button className="kh-btn outline" onClick={() => setForm(null)} disabled={busy}>Cancel</button>
          <button className="kh-btn" style={{ background: form.mode === 'udhaar' ? '#DC2626' : '#16A34A' }} onClick={save} disabled={busy}>
            {busy ? 'Saving…' : form.mode === 'udhaar' ? 'Add udhaar' : 'Save payment'}
          </button>
        </div>
      </div>
    </div>
  );

  // ── One customer ──
  if (open) return (
    <div>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <button className="kh-btn outline" style={{ marginBottom: 10 }} onClick={() => setOpenId(null)}>← All customers</button>
      <div className="kh-card">
        <div className="kh-total">
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 800, fontSize: '1.15rem', color: '#0a3d62', overflowWrap: 'anywhere' }}>{open.name}</div>
            {open.phone && <div style={{ color: '#6b7280', fontSize: '0.88rem' }}>📞 {open.phone}</div>}
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: '0.75rem', color: '#6b7280', fontWeight: 700 }}>{open.balance > 0.005 ? 'OWES' : 'SETTLED'}</div>
            <div className="kh-amt" style={{ fontSize: '1.5rem', color: open.balance > 0.005 ? '#DC2626' : '#16A34A' }}>{rupees(open.balance)}</div>
            {open.balance < -0.005 && <div style={{ fontSize: '0.75rem', color: '#16A34A' }}>(paid in advance)</div>}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
          <button className="kh-btn" style={{ background: '#16A34A', flex: 1 }} onClick={() => startForm('payment', open)}>💰 Payment received</button>
          <button className="kh-btn" style={{ background: '#DC2626', flex: 1 }} onClick={() => startForm('udhaar', open)}>➕ Add udhaar</button>
          {open.phone && open.balance > 0.005 && (
            <button className="kh-btn" style={{ background: '#25D366', flex: 1 }} onClick={() => remind(open)}>💬 WhatsApp reminder</button>
          )}
        </div>
      </div>
      <div className="kh-card">
        <div style={{ fontWeight: 800, color: '#0a3d62', marginBottom: 4 }}>History</div>
        {entries.length === 0 && <div style={{ color: '#9ca3af', fontSize: '0.9rem' }}>No entries yet.</div>}
        {entries.map(e => (
          <div key={e.id} className="kh-entry">
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 700 }}>{e.type === 'udhaar' ? '➕ Udhaar' : '💰 Paid'}{e.billNo ? ` · Bill ${e.billNo}` : ''}</div>
              <div style={{ color: '#6b7280', fontSize: '0.78rem', overflowWrap: 'anywhere' }}>{when(e.at)}{e.by ? ` · ${e.by}` : ''}{e.note ? ` · ${e.note}` : ''}</div>
            </div>
            <div className="kh-amt" style={{ color: e.type === 'udhaar' ? '#DC2626' : '#16A34A' }}>{e.type === 'udhaar' ? '+' : '−'}{rupees(e.amount)}</div>
          </div>
        ))}
      </div>
    </div>
  );

  // ── All customers ──
  return (
    <div>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <div className="kh-card">
        <div className="kh-total">
          <div>
            <div style={{ fontSize: '0.75rem', color: '#6b7280', fontWeight: 700 }}>TOTAL UDHAAR TO COLLECT</div>
            <div style={{ fontSize: '1.6rem', fontWeight: 900, color: '#DC2626' }}>{rupees(outstanding)}</div>
            <div style={{ fontSize: '0.8rem', color: '#6b7280' }}>{owing === 1 ? '1 customer owes' : `${owing} customers owe`} money</div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="kh-btn" style={{ background: '#DC2626' }} onClick={() => startForm('udhaar')}>➕ Add udhaar</button>
            <button className="kh-btn" style={{ background: '#16A34A' }} onClick={() => startForm('payment')}>💰 Payment</button>
          </div>
        </div>
      </div>
      <div className="kh-card">
        <input className="kh-input" placeholder="Search name or mobile…" value={search} onChange={e => setSearch(e.target.value)} />
        <div style={{ marginTop: 6 }}>
          {shown.length === 0 && <div style={{ color: '#9ca3af', textAlign: 'center', padding: '1.5rem 0' }}>{accounts.length ? 'No match' : 'No udhaar yet'}</div>}
          {shown.map(a => (
            <div key={a.id} className="kh-row" onClick={() => setOpenId(a.id)}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, overflowWrap: 'anywhere' }}>{a.name}</div>
                <div style={{ color: '#6b7280', fontSize: '0.8rem' }}>{a.phone || 'no mobile'} · {when(a.updatedAt)}</div>
              </div>
              <div className="kh-amt" style={{ color: a.balance > 0.005 ? '#DC2626' : '#16A34A' }}>
                {a.balance > 0.005 ? rupees(a.balance) : 'Settled'}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
