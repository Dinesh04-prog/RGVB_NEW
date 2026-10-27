import { useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import {
  changeJoinCode, removeMember, subscribeToMembers, legacyInventoryCount, importLegacyInventory,
  inviteCashier, cancelInvite, subscribeToInvites, writeOrQueue,
  type ShopMember, type ShopInvite,
} from '../lib/firebase';
import { openExternalUrl } from '../lib/androidApp';
import { APP_NAME } from '../lib/appInfo';
import { brandOf } from '../lib/shopBrand';
import ShopDetailsForm from './ShopDetailsForm';

// Owner → ☰ → Shop: add cashiers by Gmail (or a join code), who is in the shop, and the one-time import of the old
// shared inventory.

const CSS = `
  .sp-card { background: white; border-radius: 15px; box-shadow: 0 4px 12px rgba(0,0,0,0.05); padding: 16px; margin-bottom: 14px; }
  .sp-title { font-weight: 800; color: #0a3d62; font-size: 1rem; margin-bottom: 8px; }
  .sp-code { font-size: 2.2rem; font-weight: 900; letter-spacing: 0.35em; color: #0a3d62; text-align: center; padding: 10px 0 4px; font-variant-numeric: tabular-nums; }
  .sp-row { display: flex; gap: 8px; flex-wrap: wrap; }
  .sp-btn { flex: 1; min-width: 120px; min-height: 46px; border: none; border-radius: 10px; color: white; font-weight: 700; cursor: pointer; font-size: 0.9rem; padding: 0 10px; }
  .sp-btn.outline { background: white; color: #0a3d62; border: 1.5px solid #0a3d62; }
  .sp-btn:disabled { opacity: 0.6; cursor: default; }
  .sp-member { display: flex; align-items: center; gap: 10px; padding: 10px 0; border-top: 1px solid #f1f1f1; }
  .sp-member:first-of-type { border-top: none; }
  .sp-role { font-size: 0.7rem; font-weight: 800; border-radius: 6px; padding: 2px 8px; }
  .sp-remove { min-height: 40px; border-radius: 8px; border: 1.5px solid #dc3545; color: #dc3545; background: white; font-weight: 700; cursor: pointer; padding: 0 12px; font-size: 0.8rem; flex-shrink: 0; }
  .sp-note { font-size: 0.82rem; color: #6b7280; }
  .sp-status { font-size: 0.85rem; font-weight: 600; color: #0a3d62; background: #e7f1ff; border-radius: 8px; padding: 8px 12px; margin-top: 10px; }
  .sp-input { flex: 1; min-width: 0; height: 48px; border: 1.5px solid #cbd5e1; border-radius: 10px; padding: 0 12px; font-size: 1rem; }
  .sp-input:focus { outline: none; border-color: #0a3d62; }
  .sp-error { color: #DC2626; font-size: 0.82rem; font-weight: 600; margin-top: 6px; }
`;

export default function ShopPanel({ shopItemCount }: { shopItemCount: number }) {
  const { user, shop } = useAuth();
  const [members, setMembers] = useState<ShopMember[]>([]);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [legacyCount, setLegacyCount] = useState(0);
  const [importStatus, setImportStatus] = useState('');
  const [editing, setEditing] = useState(false);
  const [invites, setInvites] = useState<ShopInvite[]>([]);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteError, setInviteError] = useState('');

  const shopId = shop?.id;
  useEffect(() => subscribeToMembers(setMembers), []);
  useEffect(() => (shopId ? subscribeToInvites(shopId, setInvites) : undefined), [shopId]);
  useEffect(() => { legacyInventoryCount().then(setLegacyCount); }, []);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  if (!shop || !user) return null;
  const brand = brandOf(shop);

  const inviteText =
    `Join ${shop.name} on ${APP_NAME}.\n1. Open the app and sign in with Google\n2. Tap "Join with a code"\n3. Enter code: ${shop.joinCode}`;

  const copyCode = async () => {
    try { await navigator.clipboard.writeText(shop.joinCode); setCopied(true); } catch { /* clipboard blocked */ }
  };

  const newCode = async () => {
    if (!confirm('Make a new code? The old code will stop working (cashiers already in the shop stay).')) return;
    setBusy(true);
    try { await changeJoinCode(shop); } catch (err) { console.error(err); alert('Could not change the code. Check the internet connection.'); }
    finally { setBusy(false); }
  };

  const remove = async (m: ShopMember) => {
    if (!confirm(`Remove ${m.name || m.email} from the shop? They will no longer be able to open it.`)) return;
    try { await removeMember(m.uid); } catch (err) { console.error(err); alert('Could not remove. Check the internet connection.'); }
  };

  const addCashier = async () => {
    const email = inviteEmail.trim().toLowerCase();
    if (!email) return;
    if (members.some(m => m.email.toLowerCase() === email)) { setInviteError('This person is already in the shop.'); return; }
    setBusy(true); setInviteError('');
    try { await writeOrQueue(inviteCashier(shop, user.uid, email)); setInviteEmail(''); }
    catch (err) { console.error(err); setInviteError(err instanceof Error ? err.message : 'Could not add. Check the internet connection.'); }
    finally { setBusy(false); }
  };

  const runImport = async () => {
    if (!confirm(`Copy ${legacyCount} items from the old inventory into ${shop.name}?`)) return;
    setBusy(true); setImportStatus('⏳ Reading old inventory…');
    try {
      const n = await importLegacyInventory((done, total) => setImportStatus(`⏳ Copying ${done} / ${total} items…`));
      setImportStatus(`✅ ${n} items copied into ${shop.name}.`);
    } catch (err) {
      console.error(err);
      setImportStatus('⚠️ Import failed. Check the internet connection and try again.');
    } finally { setBusy(false); }
  };

  return (
    <div>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />

      <div className="sp-card">
        {editing ? (
          <>
            <div className="sp-title">✏️ Shop details (printed on every bill)</div>
            <ShopDetailsForm shop={shop} onDone={() => setEditing(false)} />
          </>
        ) : (
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
            {brand.logo && <img src={brand.logo} alt="" style={{ width: 56, height: 56, objectFit: 'contain', borderRadius: 8, flexShrink: 0 }} />}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="sp-title" style={{ marginBottom: 2 }}>🏪 {brand.name}</div>
              {brand.tagline && <div className="sp-note">{brand.tagline}</div>}
              {brand.address && <div className="sp-note">📍 {brand.address}</div>}
              {brand.phone && <div className="sp-note">📞 {brand.phone}</div>}
              {brand.whatsapp && <div className="sp-note">💬 WhatsApp for bill approvals: {brand.whatsapp}</div>}
              <div className="sp-note">🧾 Bills: {brand.billPrefix}-DDMM-001 · {brand.upiId ? `UPI: ${brand.upiId}` : 'No UPI ID yet'}</div>
            </div>
            <button className="sp-btn outline" style={{ flex: '0 0 auto', minWidth: 0 }} onClick={() => setEditing(true)}>✏️ Edit</button>
          </div>
        )}
      </div>

      <div className="sp-card">
        <div className="sp-title">➕ Add a cashier</div>
        <div className="sp-note">Type the cashier's Gmail. When they sign in to {APP_NAME} with that Google account, they go straight to billing.</div>
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <input className="sp-input" type="email" inputMode="email" autoComplete="off" placeholder="cashier@gmail.com"
            value={inviteEmail} onChange={e => { setInviteEmail(e.target.value); setInviteError(''); }}
            onKeyDown={e => { if (e.key === 'Enter') addCashier(); }} />
          <button className="sp-btn" style={{ background: '#16A34A', flex: '0 0 auto', minWidth: 90 }} disabled={busy || !inviteEmail.trim()} onClick={addCashier}>Add</button>
        </div>
        {inviteError && <div className="sp-error">{inviteError}</div>}
        {invites.map(inv => (
          <div key={inv.email} className="sp-member">
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, overflowWrap: 'anywhere' }}>{inv.email}</div>
              <div className="sp-note">⏳ Added — joins when they first sign in</div>
            </div>
            <button className="sp-remove" onClick={() => cancelInvite(inv.email).catch(err => console.error(err))}>Cancel</button>
          </div>
        ))}
      </div>

      <div className="sp-card">
        <div className="sp-title">🔑 Or share a code</div>
        <div className="sp-note">For a cashier you did not add above: they sign in, tap <b>Join with a code</b> and type this.</div>
        <div className="sp-code" aria-label="Join code">{shop.joinCode}</div>
        <div className="sp-row">
          <button className="sp-btn" style={{ background: '#25D366' }}
            onClick={() => openExternalUrl(`https://wa.me/?text=${encodeURIComponent(inviteText)}`)}>💬 Send on WhatsApp</button>
          <button className="sp-btn outline" onClick={copyCode}>{copied ? '✓ Copied' : '📋 Copy code'}</button>
          <button className="sp-btn outline" disabled={busy} onClick={newCode}>🔄 New code</button>
        </div>
      </div>

      <div className="sp-card">
        <div className="sp-title">👥 People in this shop ({members.length})</div>
        {members.map(m => (
          <div key={m.uid} className="sp-member">
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, overflowWrap: 'anywhere' }}>{m.name || m.email}{m.uid === user.uid && ' (you)'}</div>
              <div className="sp-note" style={{ overflowWrap: 'anywhere' }}>{m.email}</div>
            </div>
            <span className="sp-role" style={m.role === 'owner' ? { background: '#FEF3C7', color: '#92400E' } : { background: '#DBEAFE', color: '#1D4ED8' }}>
              {m.role === 'owner' ? '👑 OWNER' : 'CASHIER'}
            </span>
            {m.role !== 'owner' && <button className="sp-remove" onClick={() => remove(m)}>Remove</button>}
          </div>
        ))}
        {members.length <= 1 && <div className="sp-note" style={{ marginTop: 6 }}>No cashiers yet. Add one above.</div>}
      </div>

      {legacyCount > 0 && (
        <div className="sp-card">
          <div className="sp-title">📦 Old inventory found ({legacyCount} items)</div>
          <div className="sp-note">
            Items saved before shops existed. Copy them into {shop.name} once{shopItemCount > 0 ? ` (the shop already has ${shopItemCount} items; same items are updated, nothing is deleted)` : ''}.
          </div>
          <button className="sp-btn" style={{ background: '#0a3d62', width: '100%', marginTop: 10 }} disabled={busy} onClick={runImport}>
            ⬇️ Import old inventory
          </button>
          {importStatus && <div className="sp-status">{importStatus}</div>}
        </div>
      )}
    </div>
  );
}
