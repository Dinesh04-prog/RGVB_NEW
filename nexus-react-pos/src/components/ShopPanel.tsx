import { useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import {
  changeJoinCode, removeMember, subscribeToMembers, legacyInventoryCount, importLegacyInventory,
  type ShopMember,
} from '../lib/firebase';
import { openExternalUrl } from '../lib/androidApp';
import { APP_NAME } from '../lib/appInfo';

// Owner → ☰ → Shop: the join code for cashiers, who is in the shop, and the one-time import of the old shared inventory.

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
`;

export default function ShopPanel({ shopItemCount }: { shopItemCount: number }) {
  const { user, shop } = useAuth();
  const [members, setMembers] = useState<ShopMember[]>([]);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [legacyCount, setLegacyCount] = useState(0);
  const [importStatus, setImportStatus] = useState('');

  useEffect(() => subscribeToMembers(setMembers), []);
  useEffect(() => { legacyInventoryCount().then(setLegacyCount); }, []);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  if (!shop || !user) return null;

  const inviteText =
    `Join ${shop.name} on ${APP_NAME}.\n1. Open the app and sign in with Google\n2. Tap "Join a shop"\n3. Enter code: ${shop.joinCode}`;

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
        <div className="sp-title">🏪 {shop.name}</div>
        {shop.address && <div className="sp-note">📍 {shop.address}</div>}
        {shop.phone && <div className="sp-note">📞 {shop.phone}</div>}
        {shop.whatsapp && <div className="sp-note">💬 WhatsApp for bill approvals: {shop.whatsapp}</div>}
      </div>

      <div className="sp-card">
        <div className="sp-title">🔑 Code for cashiers</div>
        <div className="sp-note">A cashier signs in, taps <b>Join a shop</b> and types this code.</div>
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
        {members.length <= 1 && <div className="sp-note" style={{ marginTop: 6 }}>No cashiers yet. Share the code above.</div>}
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
