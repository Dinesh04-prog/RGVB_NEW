import { useState } from 'react';
import { updateShop, type Shop } from '../lib/firebase';
import { brandOf, cleanBillPrefix, isValidUpiId, DEFAULT_FOOTER, DEFAULT_BILL_PREFIX } from '../lib/shopBrand';
import { ItemImageField } from './ItemImageField';

// Owner → Shop & Cashiers → Edit: everything printed on receipts. Saved to shops/{id}; every phone updates live.

const CSS = `
  .sd-label { display: block; font-size: 0.75rem; font-weight: 700; color: #6c757d; margin: 12px 0 4px; }
  .sd-hint { font-size: 0.75rem; color: #9ca3af; margin-top: 3px; }
  .sd-input { width: 100%; height: 46px; border: 1.5px solid #cbd5e1; border-radius: 10px; padding: 0 12px; font-size: 1rem; box-sizing: border-box; }
  .sd-input:focus { outline: none; border-color: #0a3d62; }
  .sd-input.bad { border-color: #DC2626; }
  .sd-row { display: flex; gap: 10px; }
  .sd-row > div { flex: 1; min-width: 0; }
  .sd-error { color: #DC2626; font-size: 0.8rem; font-weight: 600; margin-top: 4px; }
`;

interface Props { shop: Shop; onDone: () => void }

export default function ShopDetailsForm({ shop, onDone }: Props) {
  const b = brandOf(shop);
  const [name, setName] = useState(shop.name);
  const [tagline, setTagline] = useState(b.tagline);
  const [address, setAddress] = useState(b.address);
  const [phone, setPhone] = useState(b.phone);
  const [whatsapp, setWhatsapp] = useState(b.whatsapp);
  const [billPrefix, setBillPrefix] = useState(b.billPrefix);
  const [footer, setFooter] = useState(shop.receiptFooter || '');
  const [upiId, setUpiId] = useState(b.upiId);
  const [logo, setLogo] = useState(b.logo);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const digits = (s: string) => s.replace(/\D/g, '');
  const waNumber = (s: string) => { const d = digits(s); return d.length === 10 ? `91${d}` : d; };
  const upiBad = upiId.trim() !== '' && !isValidUpiId(upiId);

  const save = async () => {
    if (!name.trim()) { setError('Enter the shop name'); return; }
    if (upiBad) { setError('The UPI ID looks wrong. It is like shopname@okaxis.'); return; }
    setSaving(true); setError('');
    try {
      await updateShop(shop.id, {
        name: name.trim(), tagline: tagline.trim(), address: address.trim(), phone: digits(phone),
        whatsapp: waNumber(whatsapp || phone), billPrefix: cleanBillPrefix(billPrefix) || DEFAULT_BILL_PREFIX,
        receiptFooter: footer.trim(), upiId: upiId.trim(), logo: logo || '',
      });
      onDone();
    } catch (err) {
      console.error(err);
      setError('Could not save. Check the internet connection.');
      setSaving(false);
    }
  };

  return (
    <div>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <label className="sd-label">SHOP NAME *</label>
      <input className="sd-input" value={name} onChange={e => setName(e.target.value)} />
      <label className="sd-label">LINE UNDER THE NAME</label>
      <input className="sd-input" value={tagline} onChange={e => setTagline(e.target.value)} placeholder="e.g. Fresh Groceries & More" />
      <label className="sd-label">ADDRESS</label>
      <input className="sd-input" value={address} onChange={e => setAddress(e.target.value)} placeholder="Street, area, city" />
      <div className="sd-row">
        <div>
          <label className="sd-label">SHOP PHONE</label>
          <input className="sd-input" value={phone} onChange={e => setPhone(e.target.value)} inputMode="tel" />
        </div>
        <div>
          <label className="sd-label">OWNER WHATSAPP</label>
          <input className="sd-input" value={whatsapp} onChange={e => setWhatsapp(e.target.value)} inputMode="tel" />
        </div>
      </div>
      <div className="sd-row">
        <div>
          <label className="sd-label">BILL NUMBER START</label>
          <input className="sd-input" value={billPrefix} maxLength={4} onChange={e => setBillPrefix(cleanBillPrefix(e.target.value))} />
          <div className="sd-hint">Bills: {cleanBillPrefix(billPrefix) || DEFAULT_BILL_PREFIX}-2710-001</div>
        </div>
        <div>
          <label className="sd-label">UPI ID (for QR on bills)</label>
          <input className={`sd-input${upiBad ? ' bad' : ''}`} value={upiId} onChange={e => setUpiId(e.target.value.trim())}
            placeholder="shopname@okaxis" autoCapitalize="none" autoCorrect="off" />
        </div>
      </div>
      <label className="sd-label">LAST LINE OF THE BILL</label>
      <input className="sd-input" value={footer} onChange={e => setFooter(e.target.value)} placeholder={DEFAULT_FOOTER} />

      <div style={{ marginTop: 12 }}>
        <ItemImageField label="SHOP LOGO (Optional)" image={logo || undefined} onChange={img => setLogo(img || '')} />
      </div>

      {error && <div className="sd-error">{error}</div>}
      <div className="sd-row" style={{ marginTop: 14 }}>
        <button onClick={onDone} disabled={saving}
          style={{ flex: 1, minHeight: 48, borderRadius: 10, border: '1.5px solid #0a3d62', background: 'white', color: '#0a3d62', fontWeight: 700, cursor: 'pointer' }}>
          Cancel
        </button>
        <button onClick={save} disabled={saving}
          style={{ flex: 2, minHeight: 48, borderRadius: 10, border: 'none', background: '#16A34A', color: 'white', fontWeight: 800, cursor: 'pointer', opacity: saving ? 0.6 : 1 }}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}
