import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { KeyRound, LockKeyhole, ShieldCheck } from 'lucide-react';
import { AuthLayout } from '@/pages/auth/AuthLayout';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { useApp } from '@/context/AppContext';

export function VaultUnlockPage() {
  const { vaultState, vaultStatus, unlockVault, authLoading } = useApp();
  const navigate = useNavigate();
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (vaultState === 'unlocked') return <Navigate to="/dashboard" replace />;
  if (vaultState === 'no_vault' || vaultState === 'migration_required') return <Navigate to="/setup" replace />;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    if (!passphrase) {
      setError('Enter your vault passphrase.');
      return;
    }
    setBusy(true);
    try {
      await unlockVault(passphrase);
      navigate('/dashboard', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to unlock the vault.');
      setPassphrase('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout
      title="Unlock your vault"
      subtitle="Your documents and personal information are encrypted at rest. Enter the passphrase to open this browser session."
    >
      <form onSubmit={submit} className="ff-stack ff-gap-12">
        <div className="ff-note" style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <LockKeyhole size={16} style={{ flex: '0 0 auto', color: 'var(--ff-primary)' }} />
          <span>
            {vaultStatus?.createdAt
              ? `Vault created ${new Date(vaultStatus.createdAt).toLocaleDateString()}.`
              : 'This vault is stored only in this browser.'}
          </span>
        </div>
        <Input
          label="Vault passphrase"
          type="password"
          value={passphrase}
          onChange={(event) => setPassphrase(event.target.value)}
          placeholder="Enter your passphrase"
          autoFocus
        />
        <Button type="submit" variant="primary" icon={KeyRound} loading={busy || authLoading} disabled={busy || authLoading}>
          Unlock vault
        </Button>
        {error ? (
          <div className="ff-note" style={{ color: 'var(--ff-danger)', borderColor: 'var(--ff-danger)' }}>{error}</div>
        ) : null}
        <div className="ff-note" style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <ShieldCheck size={15} style={{ flex: '0 0 auto', color: 'var(--ff-success)' }} />
          <span>Passphrase attempts are throttled after failures. The vault key is kept only for this browser session.</span>
        </div>
      </form>
    </AuthLayout>
  );
}
