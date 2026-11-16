import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Database,
  Download,
  HardDrive,
  KeyRound,
  LockKeyhole,
  Save,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  UserRound,
} from 'lucide-react';
import { PageHeader } from '@/components/ui/PageHeader';
import { Card, CardHeader } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Switch } from '@/components/ui/Switch';
import { Tabs } from '@/components/ui/Tabs';
import { ConfirmDialog } from '@/components/ui/Modal';
import { useApp } from '@/context/AppContext';
import { useToast } from '@/context/ToastContext';
import { documentService } from '@/services/documentService';
import { vaultClient } from '@/services/vaultClient';
import type { VaultIntegrityReport } from '@/services/vaultClientTypes';
import type { Preferences } from '@/services/types';

const tabs = [
  { id: 'profile', label: 'Profile', icon: <UserRound size={14} /> },
  { id: 'security', label: 'Vault security', icon: <ShieldCheck size={14} /> },
  { id: 'preferences', label: 'Autofill', icon: <SlidersHorizontal size={14} /> },
];

const AUTO_LOCK_OPTIONS = [
  { value: 0, label: 'Manual only' },
  { value: 1, label: '1 minute' },
  { value: 5, label: '5 minutes' },
  { value: 15, label: '15 minutes' },
  { value: 30, label: '30 minutes' },
];

export function SettingsPage() {
  const {
    user,
    vault,
    vaultStatus,
    updateProfile,
    preferences,
    updatePreferences,
    documents,
    fields,
    activity,
    refreshData,
    lockVault,
    changePassphrase,
  } = useApp();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const initialTab = searchParams.get('tab');
  const [tab, setTab] = useState(['profile', 'security', 'preferences'].includes(initialTab ?? '') ? initialTab! : 'profile');
  const [name, setName] = useState(user?.name ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [prefs, setPrefs] = useState<Preferences>(preferences);
  const [saving, setSaving] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [storage, setStorage] = useState<{ usageBytes: number; quotaBytes: number; availableBytes: number; persisted: boolean } | null>(null);
  const [currentPassphrase, setCurrentPassphrase] = useState('');
  const [newPassphrase, setNewPassphrase] = useState('');
  const [confirmPassphrase, setConfirmPassphrase] = useState('');
  const [passphraseBusy, setPassphraseBusy] = useState(false);
  const [integrity, setIntegrity] = useState<VaultIntegrityReport | null>(null);
  const [integrityBusy, setIntegrityBusy] = useState(false);

  useEffect(() => { setPrefs(preferences); }, [preferences]);
  useEffect(() => { if (initialTab && ['profile', 'security', 'preferences'].includes(initialTab)) setTab(initialTab); }, [initialTab]);
  useEffect(() => { setName(user?.name ?? ''); setEmail(user?.email ?? ''); }, [user]);
  useEffect(() => {
    void documentService.getStorageEstimate().then(setStorage).catch(() => undefined);
  }, [documents.length]);

  const saveProfile = () => {
    if (!user || !name.trim() || !email.includes('@')) {
      toast({ tone: 'error', title: 'Enter a valid name and email' });
      return;
    }
    const parts = name.trim().split(/\s+/);
    updateProfile({
      ...user,
      name: name.trim(),
      firstName: parts[0] ?? 'there',
      email: email.trim().toLowerCase(),
      avatarInitials: ((parts[0]?.[0] ?? 'F') + (parts[1]?.[0] ?? 'F')).toUpperCase(),
    });
  };

  const savePrefs = async () => {
    setSaving(true);
    await updatePreferences(prefs);
    setSaving(false);
  };

  const changeVaultPassphrase = async () => {
    if (newPassphrase.length < 10) {
      toast({ tone: 'error', title: 'Passphrase too short', message: 'Use at least 10 characters.' });
      return;
    }
    if (newPassphrase !== confirmPassphrase) {
      toast({ tone: 'error', title: 'Passphrase confirmation does not match' });
      return;
    }
    setPassphraseBusy(true);
    try {
      await changePassphrase(currentPassphrase, newPassphrase);
      setCurrentPassphrase('');
      setNewPassphrase('');
      setConfirmPassphrase('');
    } catch (error) {
      toast({ tone: 'error', title: 'Passphrase change failed', message: error instanceof Error ? error.message : 'Could not change passphrase.' });
    } finally {
      setPassphraseBusy(false);
    }
  };

  const lockNow = async () => {
    await lockVault();
    navigate('/unlock', { replace: true });
  };

  const runIntegrityCheck = async () => {
    setIntegrityBusy(true);
    try {
      const report = await vaultClient.checkIntegrity();
      setIntegrity(report);
      toast({
        tone: report.ok ? 'success' : 'error',
        title: report.ok ? 'Vault integrity verified' : 'Vault integrity issues found',
        message: report.ok
          ? `${report.counts.documents} documents and ${report.counts.values} values verified.`
          : `${report.issues.length} issue(s) reported. No records were deleted.`,
      });
    } catch (error) {
      toast({ tone: 'error', title: 'Integrity check failed', message: error instanceof Error ? error.message : 'Could not inspect the vault.' });
    } finally {
      setIntegrityBusy(false);
    }
  };

  const deleteVault = async () => {
    setClearing(true);
    try {
      await vaultClient.destroy();
      await refreshData();
      navigate('/setup', { replace: true });
      toast({ tone: 'success', title: 'Local vault deleted', message: 'All local FormFlow data was removed from this browser.' });
    } catch (error) {
      toast({ tone: 'error', title: 'Vault deletion failed', message: error instanceof Error ? error.message : 'Could not delete the vault.' });
    } finally {
      setClearing(false);
      setDeleteOpen(false);
    }
  };

  const usageLabel = storage
    ? storage.usageBytes >= 1024 * 1024
      ? `${(storage.usageBytes / (1024 * 1024)).toFixed(1)} MB used`
      : `${Math.round(storage.usageBytes / 1024)} KB used`
    : 'Measuring…';
  const quotaLabel = storage
    ? storage.quotaBytes >= 1024 * 1024 * 1024
      ? `${(storage.quotaBytes / (1024 * 1024 * 1024)).toFixed(1)} GB available`
      : `${Math.round(storage.quotaBytes / (1024 * 1024))} MB available`
    : 'Unknown';

  return (
    <div>
      <PageHeader
        eyebrow={<>Workspace <span>›</span> Settings</>}
        title="Settings"
        description="Manage your local profile, encrypted vault security, autofill safeguards, and local data."
        actions={<Badge tone={vaultStatus?.encrypted ? 'success' : 'warning'}>{vaultStatus?.encrypted ? 'Encrypted vault' : 'Vault not encrypted'}</Badge>}
      />

      <div className="ff-settings-layout">
        <aside className="ff-settings-nav">
          <Tabs items={tabs} value={tab} onChange={setTab} ariaLabel="Settings sections" />
          <div className="ff-note" style={{ marginTop: 16 }}>
            <ShieldCheck size={14} style={{ verticalAlign: -2, marginRight: 4, color: 'var(--ff-success)' }} />
            FormFlow stores vault data in IndexedDB on this device. No backend is required.
          </div>
        </aside>

        <div className="ff-settings-content">
          {tab === 'profile' ? (
            <>
              <Card>
                <CardHeader title="Your local profile" subtitle="Used for form autofill and display inside the dashboard." action={<Badge tone="primary">{vault?.name ?? 'Local vault'}</Badge>} />
                <div className="ff-settings-section">
                  <div className="ff-profile-editor ff-mb-16">
                    <div className="ff-avatar">{user?.avatarInitials ?? 'FF'}</div>
                    <div><div className="ff-h3">{user?.name || 'Local vault user'}</div><div className="ff-body-sm ff-muted">{vault?.name ?? 'Encrypted local vault'}</div></div>
                  </div>
                  <div className="ff-settings-grid">
                    <Input label="Full name" value={name} onChange={(event) => setName(event.target.value)} />
                    <Input label="Email address" type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
                  </div>
                  <div className="ff-row ff-between ff-mt-16">
                    <span className="ff-body-sm ff-muted">Vault ID: <span className="ff-code">{vault?.id ?? 'Local'}</span></span>
                    <Button variant="primary" icon={Save} onClick={saveProfile}>Save profile</Button>
                  </div>
                </div>
              </Card>
              <Card>
                <CardHeader title="Local session" subtitle="The vault key is held only for this browser session." />
                <div className="ff-settings-section ff-row ff-between">
                  <div className="ff-row ff-gap-8"><Database size={16} className="ff-muted" /><div><div className="ff-label">This browser</div><div className="ff-body-sm ff-muted">{vaultStatus?.unlocked ? 'Unlocked' : 'Locked'}</div></div></div>
                  <Badge tone={vaultStatus?.unlocked ? 'success' : 'neutral'}>{vaultStatus?.unlocked ? 'Active' : 'Locked'}</Badge>
                </div>
              </Card>
            </>
          ) : null}

          {tab === 'security' ? (
            <>
              <Card>
                <CardHeader title="Vault status" subtitle="Encryption and local storage state." action={<Badge tone={vaultStatus?.encrypted ? 'success' : 'warning'}>{vaultStatus?.encrypted ? 'AES-256-GCM' : 'Not encrypted'}</Badge>} />
                <div className="ff-settings-section">
                  <div className="ff-stack ff-gap-8">
                    <div className="ff-info-pair"><span>Lock state</span><span>{vaultStatus?.unlocked ? 'Unlocked' : 'Locked'}</span></div>
                    <div className="ff-info-pair"><span>Encryption</span><span>{vaultStatus?.encrypted ? 'AES-256-GCM' : 'Not enabled'}</span></div>
                    <div className="ff-info-pair"><span>Record format</span><span>{vaultStatus?.encryptionFormat === 2 ? 'v2 · per-record AAD' : 'v1 · upgrade pending'}</span></div>
                    <div className="ff-info-pair"><span>Key derivation</span><span>{vaultStatus?.kdf ?? 'PBKDF2-SHA256'} · {vaultStatus?.iterations?.toLocaleString() ?? '600,000'} iterations</span></div>
                    <div className="ff-info-pair"><span>Created</span><span>{vaultStatus?.createdAt ? new Date(vaultStatus.createdAt).toLocaleString() : 'Unknown'}</span></div>
                    <div className="ff-info-pair"><span>Passphrase updated</span><span>{vaultStatus?.passwordUpdatedAt ? new Date(vaultStatus.passwordUpdatedAt).toLocaleString() : 'Unknown'}</span></div>
                    <div className="ff-info-pair"><span>Storage</span><span>{usageLabel} · {quotaLabel}</span></div>
                    <div className="ff-info-pair"><span>Documents</span><span>{documents.length}</span></div>
                    <div className="ff-info-pair"><span>Vault values</span><span>{fields.length}</span></div>
                    <div className="ff-info-pair"><span>Activity entries</span><span>{activity.length}</span></div>
                  </div>
                  <div className="ff-row ff-gap-8 ff-mt-16" style={{ flexWrap: 'wrap' }}>
                    <Button icon={LockKeyhole} onClick={() => void lockNow()}>Lock now</Button>
                    <Button icon={Download} onClick={() => navigate('/vault/migration')}>Backup &amp; migration</Button>
                    <Button icon={ShieldCheck} loading={integrityBusy} onClick={() => void runIntegrityCheck()}>Run integrity check</Button>
                  </div>
                  {integrity ? (
                    <div className="ff-mt-16">
                      <div className="ff-info-pair"><span>Integrity result</span><span>{integrity.ok ? 'Passed' : 'Issues found'}</span></div>
                      <div className="ff-info-pair"><span>Checked</span><span>{new Date(integrity.checkedAt).toLocaleString()}</span></div>
                      {integrity.issues.length ? (
                        <div className="ff-stack ff-gap-6 ff-mt-12">
                          {integrity.issues.slice(0, 10).map((issue, index) => (
                            <div key={`${issue.code}-${issue.recordId ?? index}`} className="ff-body-sm" style={{ color: issue.severity === 'error' ? 'var(--ff-danger)' : 'var(--ff-warning)' }}>
                              {issue.message} {issue.recordId ? `(${issue.recordId})` : ''}
                            </div>
                          ))}
                          {integrity.issues.length > 10 ? <div className="ff-body-sm ff-muted">…and {integrity.issues.length - 10} more.</div> : null}
                        </div>
                      ) : (
                        <div className="ff-body-sm ff-muted ff-mt-8">All encrypted records, document files, checksums, and collection relationships are valid.</div>
                      )}
                    </div>
                  ) : null}
                </div>
              </Card>

              <Card>
                <CardHeader title="Change passphrase" subtitle="Re-wraps the vault data key. Existing documents remain encrypted under the same data key." />
                <div className="ff-settings-section">
                  <div className="ff-settings-grid">
                    <Input label="Current passphrase" type="password" value={currentPassphrase} onChange={(event) => setCurrentPassphrase(event.target.value)} />
                    <Input label="New passphrase" type="password" value={newPassphrase} onChange={(event) => setNewPassphrase(event.target.value)} />
                    <Input label="Confirm new passphrase" type="password" value={confirmPassphrase} onChange={(event) => setConfirmPassphrase(event.target.value)} />
                  </div>
                  <Button className="ff-mt-12" variant="primary" icon={KeyRound} loading={passphraseBusy} onClick={() => void changeVaultPassphrase()}>Change passphrase</Button>
                </div>
              </Card>

              <Card className="ff-danger-zone">
                <CardHeader title="Delete local vault" subtitle="Permanently removes encrypted documents, values, collections, and settings from this browser." />
                <div className="ff-settings-section">
                  <div className="ff-setting-row">
                    <div><div className="ff-label ff-row ff-gap-4"><Trash2 size={13} style={{ color: 'var(--ff-danger)' }} /> Delete all local data</div><div className="ff-body-sm ff-muted">This cannot be undone. Export an encrypted backup first if you need a copy.</div></div>
                    <Button variant="danger" icon={Trash2} onClick={() => setDeleteOpen(true)}>Delete vault</Button>
                  </div>
                </div>
              </Card>
            </>
          ) : null}

          {tab === 'preferences' ? (
            <Card>
              <CardHeader title="Autofill safeguards" subtitle="These settings control what the extension is allowed to do." action={<Badge tone="primary">Recommended defaults</Badge>} />
              <div className="ff-settings-section">
                {[
                  { key: 'confirmBeforeAutofill' as const, label: 'Confirm before filling', desc: 'Show a review step for every detected form.' },
                  { key: 'requireSensitiveReview' as const, label: 'Require extra review for sensitive fields', desc: 'Identity and address values need explicit approval.' },
                  { key: 'allowLongAnswers' as const, label: 'Allow grounded long answers', desc: 'Compose answers from verified vault values only.' },
                  { key: 'activityNotifications' as const, label: 'Autofill activity notifications', desc: 'Show in-app confirmations when a form is filled.' },
                  { key: 'compactMode' as const, label: 'Compact density', desc: 'Reduce spacing in dense tables and lists.' },
                ].map((item) => (
                  <div className="ff-setting-row" key={item.key}>
                    <div><div className="ff-label">{item.label}</div><div className="ff-body-sm ff-muted">{item.desc}</div></div>
                    <Switch checked={prefs[item.key]} onChange={(checked) => setPrefs({ ...prefs, [item.key]: checked })} label={item.label} />
                  </div>
                ))}
                <div className="ff-setting-row">
                  <div><div className="ff-label">Automatic lock</div><div className="ff-body-sm ff-muted">Lock the vault after a period of inactivity.</div></div>
                  <select
                    className="ff-select"
                    value={prefs.autoLockMinutes}
                    onChange={(event) => setPrefs({ ...prefs, autoLockMinutes: Number(event.target.value) })}
                  >
                    {AUTO_LOCK_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </div>
                <div className="ff-row ff-between ff-mt-16">
                  <span className="ff-body-sm ff-muted"><HardDrive size={13} style={{ verticalAlign: -2, marginRight: 4 }} /> Vault data stays on this device.</span>
                  <Button variant="primary" icon={Save} onClick={() => void savePrefs()} loading={saving}>Save preferences</Button>
                </div>
              </div>
            </Card>
          ) : null}
        </div>
      </div>

      <ConfirmDialog
        open={deleteOpen}
        title="Delete the local vault?"
        description="This permanently deletes all encrypted documents, values, records, collections, and history from this browser. The source files elsewhere on your device are not changed."
        confirmLabel="Delete local vault"
        destructive
        loading={clearing}
        onConfirm={() => void deleteVault()}
        onClose={() => setDeleteOpen(false)}
      />
    </div>
  );
}
