import { GoogleLogin } from '@react-oauth/google';
import { useAuth } from '../contexts/AuthContext';

function decodeJwtPayload(token: string) {
  const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(
    decodeURIComponent(
      atob(base64).split('').map(c =>
        '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)
      ).join('')
    )
  );
}

export default function LoginPage() {
  const { login } = useAuth();

  return (
    <div style={{
      minHeight: '100vh',
      background: 'linear-gradient(135deg, #0a3d62 0%, #145c91 100%)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: "'Segoe UI', sans-serif",
      padding: '1rem',
    }}>
      <div style={{
        background: 'white',
        borderRadius: '20px',
        padding: '2.5rem 2rem',
        width: '100%',
        maxWidth: '380px',
        textAlign: 'center',
        boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
      }}>
        <div style={{ fontSize: '3.5rem', marginBottom: '0.5rem' }}>🛒</div>
        <h1 style={{
          color: '#0a3d62',
          margin: '0 0 0.25rem',
          fontSize: '1.8rem',
          fontWeight: 'bold',
        }}>
          Rajendra GVB
        </h1>
        <p style={{ color: '#6b7280', margin: '0 0 2rem', fontSize: '0.9rem' }}>
          Kirana POS System
        </p>

        <div style={{
          background: '#f8fafc',
          borderRadius: '12px',
          padding: '1.5rem 1rem',
          border: '1px solid #e2e8f0',
          marginBottom: '1.5rem',
        }}>
          <p style={{ margin: '0 0 1.25rem', color: '#374151', fontSize: '0.95rem', fontWeight: 500 }}>
            Sign in to continue
          </p>
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <GoogleLogin
              onSuccess={(cred) => {
                const payload = decodeJwtPayload(cred.credential!);
                login({
                  name: payload.name,
                  email: payload.email,
                  picture: payload.picture,
                });
              }}
              onError={() => alert('Google sign-in failed. Please try again.')}
              shape="pill"
              size="large"
              text="signin_with"
              logo_alignment="center"
            />
          </div>
        </div>

        <p style={{ color: '#9ca3af', fontSize: '0.75rem', margin: 0 }}>
          Secure sign-in powered by Google
        </p>
      </div>
    </div>
  );
}
