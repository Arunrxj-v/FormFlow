import { useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useApp } from '@/context/AppContext';
import { authService } from '@/services/authService';

export function AuthCallbackPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { handleAuthSuccess } = useApp();
  const processedRef = useRef(false);

  useEffect(() => {
    if (processedRef.current) return;
    processedRef.current = true;

    const token = searchParams.get('token');
    const errorParam = searchParams.get('error');

    if (errorParam) {
      navigate(`/login?error=${encodeURIComponent(errorParam)}`, { replace: true });
      return;
    }

    if (token) {
      void (async () => {
        try {
          await handleAuthSuccess(token);
          navigate('/dashboard', { replace: true });
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Failed to establish authenticated session.';
          navigate(`/login?error=${encodeURIComponent(message)}`, { replace: true });
        }
      })();
      return;
    }

    // Check if session cookie is active
    void (async () => {
      try {
        const verified = await authService.getMe();
        if (verified) {
          navigate('/dashboard', { replace: true });
        } else {
          navigate('/login', { replace: true });
        }
      } catch {
        navigate('/login', { replace: true });
      }
    })();
  }, [searchParams, handleAuthSuccess, navigate]);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        background: '#fafafa',
        fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        color: '#0f172a',
        padding: '24px',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: '380px',
          background: '#ffffff',
          borderRadius: '12px',
          boxShadow: '0 4px 20px rgba(0, 0, 0, 0.08)',
          border: '1px solid #e2e8f0',
          padding: '36px 32px',
          textAlign: 'center',
        }}
      >
        <div
          style={{
            width: '40px',
            height: '40px',
            border: '3px solid #e2e8f0',
            borderTopColor: '#2563eb',
            borderRadius: '50%',
            animation: 'ff-spin 0.8s linear infinite',
            margin: '0 auto 20px',
          }}
        />
        <div style={{ fontSize: '17px', fontWeight: 600, color: '#0f172a', marginBottom: '8px' }}>
          Signing in with Google
        </div>
        <div style={{ fontSize: '13px', color: '#64748b', lineHeight: 1.5 }}>
          Verifying your account and securing your personal vault...
        </div>
      </div>
      <style>{`@keyframes ff-spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

