import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, ArrowRight, MailCheck } from 'lucide-react';
import { AuthLayout } from './AuthLayout';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { authService } from '@/services/authService';

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    if (!email.includes('@')) {
      setError('Enter a valid email address.');
      return;
    }
    setLoading(true);
    try {
      await authService.requestPasswordReset(email);
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to request a reset link.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthLayout
      title={sent ? 'Check your inbox' : 'Reset your password'}
      subtitle={
        sent
          ? 'If an account exists for that address, a reset link is on its way.'
          : 'Enter the email associated with your FormFlow account.'
      }
      footer={<Link className="ff-auth-link" to="/login">Back to sign in</Link>}
    >
      {sent ? (
        <div className="ff-success-panel" style={{ marginTop: 24 }}>
          <div className="ff-success-panel__icon"><MailCheck size={21} /></div>
          <div className="ff-h3">Reset request received</div>
          <p className="ff-body-sm ff-muted" style={{ marginTop: 4 }}>
            Demo only: no email was sent. In production this would use a time-limited reset token.
          </p>
          <Button variant="primary" fullWidth style={{ marginTop: 16 }} onClick={() => setSent(false)} icon={ArrowLeft}>
            Use a different email
          </Button>
        </div>
      ) : (
        <form className="ff-auth-form" onSubmit={onSubmit} noValidate>
          <Input
            label="Email address"
            name="email"
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            error={error || undefined}
            required
          />
          <Button type="submit" variant="primary" size="lg" fullWidth loading={loading} trailingIcon={ArrowRight}>
            Send reset link
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
