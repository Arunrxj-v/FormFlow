import { useState, useEffect, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { AlertCircle, ArrowRight, RefreshCw } from 'lucide-react';
import { AuthLayout } from './AuthLayout';
import { Input, PasswordInput } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { useApp } from '@/context/AppContext';
import { authService } from '@/services/authService';

export function LoginPage() {
  const { user, login, authLoading, authState, serviceStatus, checkHealth } = useApp();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string }>({});
  const [googleLoading, setGoogleLoading] = useState(false);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const err = params.get('error');
    if (err) {
      setError(decodeURIComponent(err));
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  if (user) return <Navigate to="/dashboard" replace />;

  const handleRetryHealth = async () => {
    setRetrying(true);
    setError('');
    try {
      await checkHealth();
    } finally {
      setRetrying(false);
    }
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    const newFieldErrors: { email?: string; password?: string } = {};

    const cleanEmail = email.trim();
    if (!cleanEmail) {
      newFieldErrors.email = 'Email address is required.';
    } else if (!cleanEmail.includes('@') || !cleanEmail.includes('.')) {
      newFieldErrors.email = 'Enter a valid email address.';
    }

    if (!password) {
      newFieldErrors.password = 'Password is required.';
    } else if (password.length < 6) {
      newFieldErrors.password = 'Password must be at least 6 characters.';
    }

    if (Object.keys(newFieldErrors).length > 0) {
      setFieldErrors(newFieldErrors);
      return;
    }

    setFieldErrors({});
    try {
      await login(cleanEmail, password);
      navigate('/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to sign in.');
    }
  };

  const onGoogle = async () => {
    setGoogleLoading(true);
    setError('');
    try {
      await authService.signInWithGoogle();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Google authentication is currently unavailable.');
      setGoogleLoading(false);
    }
  };

  return (
    <AuthLayout
      title="Welcome back"
      subtitle="Sign in to review your vault, documents, and autofill activity."
      footer={<>New to FormFlow? <Link className="ff-auth-link" to="/signup">Create an account</Link></>}
    >
      {serviceStatus === 'offline' ? (
        <div
          role="alert"
          style={{
            marginBottom: 16,
            padding: '10px 14px',
            borderRadius: 8,
            background: 'var(--ff-danger-bg, #fef2f2)',
            border: '1px solid var(--ff-danger-border, #fecaca)',
            color: 'var(--ff-danger, #b91c1c)',
            fontSize: 12,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <AlertCircle size={15} style={{ flexShrink: 0 }} />
            <span>FormFlow backend is unavailable on port 8787.</span>
          </div>
          <button
            type="button"
            onClick={handleRetryHealth}
            disabled={retrying}
            style={{
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              color: 'inherit',
              fontWeight: 600,
              fontSize: 11,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            <RefreshCw size={12} className={retrying ? 'ff-spin' : ''} /> Retry
          </button>
        </div>
      ) : null}

      {authState === 'session_expired' && !error ? (
        <div
          role="status"
          style={{
            marginBottom: 16,
            padding: '10px 14px',
            borderRadius: 8,
            background: '#fefce8',
            border: '1px solid #fef08a',
            color: '#854d0e',
            fontSize: 12,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <AlertCircle size={15} style={{ flexShrink: 0 }} />
          <span>Your session has expired. Please sign in again.</span>
        </div>
      ) : null}

      <form className="ff-auth-form" onSubmit={onSubmit} noValidate>
        <Input
          label="Email address"
          name="email"
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
            if (fieldErrors.email) setFieldErrors((prev) => ({ ...prev, email: undefined }));
          }}
          error={fieldErrors.email}
          required
        />
        <PasswordInput
          label="Password"
          name="password"
          autoComplete="current-password"
          placeholder="Enter your password"
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
            if (fieldErrors.password) setFieldErrors((prev) => ({ ...prev, password: undefined }));
          }}
          error={fieldErrors.password}
          required
        />
        <div className="ff-auth-row">
          <Checkbox label="Remember me" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
          <Link className="ff-auth-link" to="/forgot-password">Forgot password?</Link>
        </div>
        {error ? (
          <div className="ff-field__error" role="alert" style={{ marginBottom: 12 }}>
            {error}
          </div>
        ) : null}
        <Button type="submit" variant="primary" size="lg" fullWidth loading={authLoading} trailingIcon={ArrowRight}>
          Sign in
        </Button>
      </form>

      <div className="ff-auth-divider" style={{ marginTop: 18 }}>or</div>

      <div style={{ marginTop: 12 }}>
        <button type="button" className="ff-google-button" onClick={onGoogle} disabled={googleLoading}>
          {googleLoading ? <span className="ff-spinner" /> : <span className="ff-google-mark">G</span>}
          Continue with Google
        </button>
      </div>
    </AuthLayout>
  );
}
