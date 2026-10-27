import { useState } from 'react';
import { GoogleLogin } from '@react-oauth/google';
import { signInWithGoogleIdToken, signInTestUser, usingEmulators } from '../lib/firebase';
import { APP_NAME } from '../lib/appInfo';

const signInError = (err: unknown) => {
  const code = (err as { code?: string })?.code || '';
  if (code === 'auth/network-request-failed') return 'No internet connection. Connect and try again.';
  if (code === 'auth/invalid-credential' || code === 'auth/operation-not-allowed')
    return 'Google sign-in is not set up for this app yet (Firebase → Authentication → Google).';
  return 'Google sign-in failed. Please try again.';
};

export default function LoginPage() {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [testEmail, setTestEmail] = useState('owner@test.com');

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await fn(); }
    catch (err) { console.error('Sign-in failed:', err); setError(signInError(err)); setBusy(false); }
  };

  return (
    <div style={{
      minHeight: '100vh',
      background: 'linear-gradient(135deg, #0a3d62 0%, #145c91 100%)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: "'Segoe UI', sans-serif", padding: '1rem',
    }}>
      <div style={{
        background: 'white', borderRadius: '20px', padding: '2.5rem 2rem', width: '100%', maxWidth: '380px',
        textAlign: 'center', boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
      }}>
        <div style={{ fontSize: '3.5rem', marginBottom: '0.5rem' }}>🛒</div>
        <h1 style={{ color: '#0a3d62', margin: '0 0 0.25rem', fontSize: '1.8rem', fontWeight: 'bold' }}>{APP_NAME}</h1>
        <p style={{ color: '#6b7280', margin: '0 0 2rem', fontSize: '0.9rem' }}>Billing & stock for your kirana shop</p>

        <div style={{ background: '#f8fafc', borderRadius: '12px', padding: '1.5rem 1rem', border: '1px solid #e2e8f0', marginBottom: '1.5rem' }}>
          <p style={{ margin: '0 0 1.25rem', color: '#374151', fontSize: '0.95rem', fontWeight: 500 }}>
            {busy ? 'Signing in…' : 'Sign in to continue'}
          </p>
          {/* Real Google accounts cannot sign in to the local test emulator, so test mode shows only the test box */}
          {!usingEmulators && (
            <div style={{ display: 'flex', justifyContent: 'center', opacity: busy ? 0.5 : 1, pointerEvents: busy ? 'none' : undefined }}>
              <GoogleLogin
                onSuccess={cred => { if (cred.credential) run(() => signInWithGoogleIdToken(cred.credential!)); }}
                onError={() => setError('Google sign-in failed. Please try again.')}
                shape="pill" size="large" text="signin_with" logo_alignment="center"
              />
            </div>
          )}

          {usingEmulators && (
            <div>
              <div style={{ fontSize: '0.75rem', fontWeight: 700, color: '#b45309', marginBottom: 4 }}>TEST MODE (local emulator)</div>
              <div style={{ fontSize: '0.8rem', color: '#6b7280', marginBottom: 8, textAlign: 'left' }}>
                Type any email, e.g. <b>owner@test.com</b> for the owner or <b>cashier@test.com</b> for a cashier, then tap Sign in.
                No password; nothing goes to the real shop.
              </div>
              <input value={testEmail} onChange={e => setTestEmail(e.target.value)} aria-label="Test email"
                style={{ width: '100%', height: 44, borderRadius: 8, border: '1.5px solid #cbd5e1', padding: '0 10px', fontSize: '0.95rem', marginBottom: 8, boxSizing: 'border-box' }} />
              <button disabled={busy} onClick={() => run(() => signInTestUser(testEmail.trim(), testEmail.split('@')[0]))}
                style={{ width: '100%', minHeight: 44, borderRadius: 8, border: 'none', background: '#b45309', color: 'white', fontWeight: 700, cursor: 'pointer' }}>
                Sign in as test user
              </button>
            </div>
          )}
          {error && <p style={{ color: '#DC2626', fontSize: '0.85rem', fontWeight: 600, margin: '1rem 0 0' }}>{error}</p>}
        </div>

        <p style={{ color: '#9ca3af', fontSize: '0.75rem', margin: 0 }}>Secure sign-in powered by Google</p>
      </div>
    </div>
  );
}
