import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { GoogleOAuthProvider } from '@react-oauth/google'
import { AuthProvider, useAuth } from './contexts/AuthContext'
import LoginPage from './components/LoginPage'
import OwnerApp from './components/OwnerApp'

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '';

function AuthGate() {
  const { user, isOwner } = useAuth();
  // Support direct review links: /?review=<id>
  const [reviewId] = useState(() =>
    new URLSearchParams(window.location.search).get('review')
  );

  if (!user) return <LoginPage />;
  // Owner email or anyone with a direct review link → owner interface
  if (isOwner || reviewId) return <OwnerApp initialReviewId={reviewId} />;
  return <App />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <GoogleOAuthProvider clientId={CLIENT_ID}>
      <AuthProvider>
        <AuthGate />
      </AuthProvider>
    </GoogleOAuthProvider>
  </StrictMode>,
)
