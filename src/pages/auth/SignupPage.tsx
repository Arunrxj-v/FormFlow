import { useState, useEffect, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { AlertCircle, ArrowRight, RefreshCw } from 'lucide-react';
import { AuthLayout } from './AuthLayout';
import { Input, PasswordInput } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { useApp } from '@/context/AppContext';
import { authService } from '@/services/authService';

export function SignupPage() {
  const { user, signup, authLoading, serviceStatus, checkHealth } = useApp();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [terms, setTerms] = useState(false);
  const [error, setError] = useState('');
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
    if (name.trim().length < 2) return setError('Enter your full name.');
    const cleanEmail = email.trim();
    if (!cleanEmail.includes('@') || !cleanEmail.includes('.')) return setError('Enter a valid email address.');
    if (password.length < 8) return setError('Use at least 8 characters for your password.');
    if (password !== confirm) return setError('Passwords do not match.');
    if (!terms) return setError('Accept the terms and privacy policy to continue.');
    try {
      await signup(name.trim(), cleanEmail, password);
      navigate('/onboarding');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to create account.');
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
      title="Create your FormFlow account"
      subtitle="Start with your documents. You choose what FormFlow can see."
      footer={<>Already have an account? <Link className="ff-auth-link" to="/login">Sign in</Link></>}
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
      <form className="ff-auth-form" onSubmit={onSubmit} noValidate>
        <Input
          label="Full name"
          name="name"
          autoComplete="name"
          placeholder="Alex Morgan"
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
        />
        <Input
          label="Email address"
          name="email"
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
        />
        <PasswordInput
          label="Password"
          name="password"
          autoComplete="new-password"
          placeholder="At least 8 characters"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          hint="Use a unique password you do not use for Google."
          required
        />
        <PasswordInput
          label="Confirm password"
          name="confirmPassword"
          autoComplete="new-password"
          placeholder="Repeat your password"
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          required
        />
        <Checkbox
          checked={terms}
          onChange={(event) => setTerms(event.target.checked)}
          label={
            <span>
              I agree to the <a className="ff-auth-link" href="#terms" onClick={(event) => event.preventDefault()}>Terms</a> and{' '}
              <a className="ff-auth-link" href="#privacy" onClick={(event) => event.preventDefault()}>Privacy Policy</a>.
            </span>
          }
        />
        {error ? <div className="ff-field__error" role="alert">{error}</div> : null}
        <Button type="submit" variant="primary" size="lg" fullWidth loading={authLoading} trailingIcon={ArrowRight}>
          Create account
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
