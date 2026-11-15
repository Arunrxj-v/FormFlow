import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { Database, LockKeyhole, ShieldCheck, Sparkles } from 'lucide-react';
import { AuthLayout } from '@/pages/auth/AuthLayout';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { useApp } from '@/context/AppContext';

export function VaultSetupPage() {
  const { vaultState, createVault, migratePlaintextVault } = useApp();
  const navigate = useNavigate();
  const [name, setName] = useState('My FormFlow vault');
  const [passphrase, setPassphrase] = useState('');
  const [confirmPassphrase, setConfirmPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (vaultState === 'unlocked') return <Navigate to="/dashboard" replace />;
  if (vaultState === 'locked') return <Navigate to="/unlock" replace />;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    if (!name.trim()) {
      setError('Give the vault a name.');
      return;
    }
    if (passphrase.length < 10) {
      setError('Use at least 10 characters for the vault passphrase.');
      return;
    }
    if (passphrase !== confirmPassphrase) {
      setError('The passphrase confirmation does not match.');
      return;
    }
    setBusy(true);
    try {
      if (vaultState === 'migration_required') await migratePlaintextVault(passphrase);
      else await createVault({ name: name.trim(), passphrase });
      navigate('/dashboard', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not initialize the vault.');
    } finally {
      setBusy(false);
    }
  };

  const migrating = vaultState === 'migration_required';

  return (
    <AuthLayout
      title={migrating ? 'Protect your existing vault' : 'Create your encrypted vault'}
      subtitle={
        migrating
          ? 'Your Phase 2 vault is not encrypted yet. Set a passphrase to encrypt its documents and records in place.'
          : 'FormFlow stores your documents and personal information in this browser. The vault is encrypted with a passphrase that never leaves your device.'
      }
    >
      <form onSubmit={submit} className="ff-stack ff-gap-12">
        <div className="ff-note" style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <Database size={16} style={{ flex: '0 0 auto', color: 'var(--ff-primary)' }} />
          <span>
            <strong>Local-first storage.</strong> Documents and personal information stay on this device.
            No FormFlow account or backend is required.
          </span>
        </div>
        {!migrating ? (
          <Input label="Vault name" value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Personal applications" autoFocus />
        ) : null}
        <Input
          label="Vault passphrase"
          type="password"
          value={passphrase}
          onChange={(event) => setPassphrase(event.target.value)}
          placeholder="At least 10 characters"
          autoFocus={migrating}
        />
        <Input
          label="Confirm passphrase"
          type="password"
          value={confirmPassphrase}
          onChange={(event) => setConfirmPassphrase(event.target.value)}
          placeholder="Repeat the passphrase"
        />
        <Button type="submit" variant="primary" icon={migrating ? ShieldCheck : Sparkles} loading={busy} disabled={busy}>
          {migrating ? 'Encrypt existing vault' : 'Create encrypted vault'}
        </Button>
        {error ? (
          <div className="ff-note" style={{ color: 'var(--ff-danger)', borderColor: 'var(--ff-danger)' }}>{error}</div>
        ) : null}
        <div className="ff-note" style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <LockKeyhole size={15} style={{ flex: '0 0 auto', color: 'var(--ff-success)' }} />
          <span>
            If you lose the passphrase, the vault cannot be unlocked. There is no automatic password recovery in this phase.
          </span>
        </div>
      </form>
    </AuthLayout>
  );
}
