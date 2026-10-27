import { StrictMode, useState, Component } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { GoogleOAuthProvider } from '@react-oauth/google'
import { AuthProvider, useAuth } from './contexts/AuthContext'
import LoginPage from './components/LoginPage'
import OwnerApp from './components/OwnerApp'
import ShopSetup from './components/ShopSetup'

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '';

// Catches any React render crash — shows error message instead of blank white screen
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: '2rem', fontFamily: 'sans-serif', maxWidth: 480, margin: '0 auto' }}>
          <h2 style={{ color: '#c0392b' }}>Something went wrong</h2>
          <p style={{ color: '#555', fontSize: '0.9rem' }}>{this.state.error.message}</p>
          <button
            onClick={() => window.location.reload()}
            style={{ marginTop: '1rem', padding: '10px 24px', background: '#0a3d62', color: 'white', border: 'none', borderRadius: 8, fontSize: '1rem', cursor: 'pointer' }}
          >
            Reload App
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function AuthGate() {
  const { user, shop, isOwner, ready } = useAuth();
  // Support direct review links: /?review=<id>
  const [reviewId] = useState(() =>
    new URLSearchParams(window.location.search).get('review')
  );

  if (!ready) return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'sans-serif', color: '#0a3d62' }}>
      <div style={{ textAlign: 'center' }}><div style={{ fontSize: '2.5rem' }}>🛒</div>Loading…</div>
    </div>
  );
  if (!user) return <LoginPage />;
  if (!shop) return <ShopSetup />;
  // The shop's owner → owner panel (a review link opens that bill). Cashiers → billing app.
  if (isOwner) return <OwnerApp initialReviewId={reviewId} />;
  return <App />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <GoogleOAuthProvider clientId={CLIENT_ID}>
        <AuthProvider>
          <ErrorBoundary>
            <AuthGate />
          </ErrorBoundary>
        </AuthProvider>
      </GoogleOAuthProvider>
    </ErrorBoundary>
  </StrictMode>,
)
