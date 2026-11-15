import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Cloud,
  Download,
  ExternalLink,
  KeyRound,
  Laptop,
  PlugZap,
  Save,
  Settings,
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
import { googleDriveService } from '@/services/googleDriveService';
import { clearAuthStorage } from '@/services/apiClient';
import type { Preferences } from '@/services/types';

const tabs = [
  { id: 'profile', label: 'Profile', icon: <UserRound size={14} /> },
  { id: 'connections', label: 'Connections', icon: <PlugZap size={14} /> },
  { id: 'preferences', label: 'Autofill', icon: <SlidersHorizontal size={14} /> },
  { id: 'privacy', label: 'Privacy & data', icon: <ShieldCheck size={14} /> },
];

export function SettingsPage() {
  const { user, updateProfile, logout, preferences, updatePreferences, driveConnection, extensionConnection, documents, fields, activity, refreshData, refreshDrive } = useApp();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const initialTab = searchParams.get('tab');
  const [tab, setTab] = useState(['profile', 'connections', 'preferences', 'privacy'].includes(initialTab ?? '') ? initialTab! : 'profile');
  const [name, setName] = useState(user?.name ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [prefs, setPrefs] = useState<Preferences>(preferences);
  const [saving, setSaving] = useState(false);
  const [driveBusy, setDriveBusy] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [clearing, setClearing] = useState(false);

  useEffect(() => { setPrefs(preferences); }, [preferences]);
  useEffect(() => { if (initialTab && ['profile', 'connections', 'preferences', 'privacy'].includes(initialTab)) setTab(initialTab); }, [initialTab]);
  useEffect(() => { setName(user?.name ?? ''); setEmail(user?.email ?? ''); }, [user]);

  useEffect(() => {
    const driveStatus = searchParams.get('drive');
    const driveError = searchParams.get('drive_error');

    if (driveStatus === 'connected') {
      setTab('connections');
      void refreshDrive();
      toast({ tone: 'success', title: 'Google Drive connected', message: 'Your Google Drive account has been linked successfully.' });
      navigate('/settings?tab=connections', { replace: true });
    } else if (driveError) {
      setTab('connections');
      toast({ tone: 'error', title: 'Google Drive error', message: decodeURIComponent(driveError) });
      navigate('/settings?tab=connections', { replace: true });
    }
  }, [searchParams, refreshDrive, toast, navigate]);

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
    toast({ tone: 'success', title: 'Profile updated', message: 'Your profile details have been saved.' });
  };

  const savePrefs = async () => {
    setSaving(true);
    await updatePreferences(prefs);
    setSaving(false);
  };

  const toggleDrive = async () => {
    setDriveBusy(true);
    try {
      if (driveConnection.connected) {
        await googleDriveService.disconnect();
        toast({ tone: 'info', title: 'Drive disconnected', message: 'Vault documents already imported remain in FormFlow.' });
      } else {
        await googleDriveService.connect();
      }
      await refreshData();
    } catch (err: any) {
      toast({ tone: 'error', title: 'Google Drive error', message: err?.message || 'Failed to update connection.' });
    } finally {
      setDriveBusy(false);
    }
  };

  const exportData = () => {
    const payload = { exportedAt: new Date().toISOString(), profile: user, preferences, documents, fields, activity };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'formflow-vault-export.json';
    anchor.click();
    URL.revokeObjectURL(url);
    toast({ tone: 'success', title: 'Vault data exported', message: 'A JSON backup copy was downloaded.' });
  };

  return (
    <div>
      <PageHeader
        eyebrow={<>Workspace <span>›</span> Settings</>}
        title="Settings"
        description="Manage your account profile, connected services, autofill safeguards, and vault data."
        actions={<Badge tone="neutral">{user?.accountType || 'Personal'}</Badge>}
      />

      <div className="ff-settings-layout">
        <aside className="ff-settings-nav">
          <Tabs items={tabs} value={tab} onChange={setTab} ariaLabel="Settings sections" />
          <div className="ff-note" style={{ marginTop: 16 }}>
            <ShieldCheck size={14} style={{ verticalAlign: -2, marginRight: 4, color: 'var(--ff-success)' }} />
            FormFlow stores your vault documents and extracted fields in a local SQLite database.
          </div>
        </aside>

        <div className="ff-settings-content">
          {tab === 'profile' ? (
            <>
              <Card>
                <CardHeader title="Your profile" subtitle="Shown in the workspace and used for form autofill." action={<Badge tone="primary">{user?.accountType || 'Personal'}</Badge>} />
                <div className="ff-settings-section">
                  <div className="ff-profile-editor ff-mb-16">
                    <div className="ff-avatar">{user?.avatarInitials ?? (user?.name ? user.name.slice(0, 2).toUpperCase() : 'FF')}</div>
                    <div><div className="ff-h3">{user?.name}</div><div className="ff-body-sm ff-muted">{user?.accountType || 'Personal'}</div></div>
                  </div>
                  <div className="ff-settings-grid">
                    <Input label="Full name" value={name} onChange={(event) => setName(event.target.value)} />
                    <Input label="Email address" type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
                  </div>
                  <div className="ff-row ff-between ff-mt-16">
                    <span className="ff-body-sm ff-muted">Account ID: <span className="ff-code">{user?.id}</span></span>
                    <Button variant="primary" icon={Save} onClick={saveProfile}>Save profile</Button>
                  </div>
                </div>
              </Card>
              <Card>
                <CardHeader title="Session" subtitle="Your active FormFlow authentication session." />
                <div className="ff-settings-section ff-row ff-between">
                  <div className="ff-row ff-gap-8"><Laptop size={16} className="ff-muted" /><div><div className="ff-label">This browser</div><div className="ff-body-sm ff-muted">Active session</div></div></div>
                  <Badge tone="success">Current</Badge>
                </div>
              </Card>
            </>
          ) : null}

          {tab === 'connections' ? (
            <>
              <Card>
                <CardHeader title="Google Drive" subtitle="Source for selecting and importing documents into the vault." action={<Badge tone={driveConnection.connected ? 'success' : 'neutral'}>{driveConnection.connected ? 'Connected' : 'Not connected'}</Badge>} />
                <div className="ff-settings-section">
                  <div className="ff-connection-card">
                    <div className="ff-connection-card__identity">
                      <span className="ff-connection-icon"><Cloud size={17} /></span>
                      <div><div className="ff-label">{driveConnection.connected ? (driveConnection.accountName || 'Google Account') : 'Google Drive'}</div><div className="ff-body-sm ff-muted">{driveConnection.accountEmail || 'No account linked'}</div></div>
                    </div>
                    <Button variant={driveConnection.connected ? 'danger' : 'primary'} onClick={toggleDrive} loading={driveBusy}>{driveConnection.connected ? 'Disconnect' : 'Connect Google Drive'}</Button>
                  </div>
                  {driveConnection.connected ? (
                    <div className="ff-stack ff-gap-8 ff-mt-16">
                      <div className="ff-info-pair"><span>Target folder</span><span className="ff-code">{driveConnection.targetFolder}</span></div>
                      <div className="ff-info-pair"><span>Last sync</span><span>{driveConnection.lastSync}</span></div>
                    </div>
                  ) : null}
                  <div className="ff-note ff-mt-12">FormFlow uses Google OAuth with file-scoped permissions. It only accesses documents you explicitly select.</div>
                </div>
              </Card>
              <Card>
                <CardHeader title="Chrome extension" subtitle="The extension reads only the current page after you invoke it." action={<Badge tone={extensionConnection.connected ? 'success' : 'warning'}>{extensionConnection.connected ? 'Connected' : 'Not connected'}</Badge>} />
                <div className="ff-settings-section">
                  <div className="ff-connection-card">
                    <div className="ff-connection-card__identity">
                      <span className="ff-connection-icon"><PlugZap size={17} /></span>
                      <div><div className="ff-label">FormFlow for {extensionConnection.browser}</div><div className="ff-body-sm ff-muted">v{extensionConnection.version} · {extensionConnection.shortcut}</div></div>
                    </div>
                    <Button onClick={() => navigate('/extension')} icon={ExternalLink}>Open setup</Button>
                  </div>
                  <div className="ff-info-pair ff-mt-12"><span>Last handshake</span><span>{extensionConnection.lastSync}</span></div>
                  <div className="ff-note ff-mt-12">Load the unpacked extension from this repository. Detection is user-triggered and never runs across all tabs automatically.</div>
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
                  { key: 'requireSensitiveReview' as const, label: 'Require extra review for sensitive fields', desc: 'Identity, address, and financial values need explicit approval.' },
                  { key: 'autoDownloadFiles' as const, label: 'Allow document downloads', desc: 'Permit the extension to offer original file downloads.' },
                  { key: 'activityNotifications' as const, label: 'Autofill activity notifications', desc: 'Show in-app confirmations when a form is filled.' },
                  { key: 'productNotifications' as const, label: 'Product updates', desc: 'Occasional demo product messages.' },
                  { key: 'compactMode' as const, label: 'Compact density', desc: 'Reduce spacing in dense tables and lists.' },
                ].map((item) => (
                  <div className="ff-setting-row" key={item.key}>
                    <div><div className="ff-label">{item.label}</div><div className="ff-body-sm ff-muted">{item.desc}</div></div>
                    <Switch checked={prefs[item.key]} onChange={(checked) => setPrefs({ ...prefs, [item.key]: checked })} label={item.label} />
                  </div>
                ))}
                <div className="ff-row ff-between ff-mt-16">
                  <span className="ff-body-sm ff-muted"><KeyRound size={13} style={{ verticalAlign: -2, marginRight: 4 }} /> Autofill never submits a form.</span>
                  <Button variant="primary" icon={Save} onClick={savePrefs} loading={saving}>Save preferences</Button>
                </div>
              </div>
            </Card>
          ) : null}

          {tab === 'privacy' ? (
            <>
              <Card>
                <CardHeader title="Your vault data" subtitle="Overview of your stored documents and extracted fields." action={<Badge tone="success">Local storage</Badge>} />
                <div className="ff-settings-section">
                  <div className="ff-stack ff-gap-8">
                    <div className="ff-info-pair"><span>Vault documents</span><span>{documents.length}</span></div>
                    <div className="ff-info-pair"><span>Extracted values</span><span>{fields.length}</span></div>
                    <div className="ff-info-pair"><span>Activity entries</span><span>{activity.length}</span></div>
                  </div>
                  <div className="ff-row ff-gap-8 ff-mt-16">
                    <Button icon={Download} onClick={exportData}>Export vault data</Button>
                  </div>
                </div>
              </Card>
              <Card className="ff-danger-zone">
                <CardHeader title="Account controls" subtitle="Permanent account actions." />
                <div className="ff-settings-section">
                  <div className="ff-setting-row">
                    <div><div className="ff-label ff-row ff-gap-4"><Trash2 size={13} style={{ color: 'var(--ff-danger)' }} /> Delete account</div><div className="ff-body-sm ff-muted">Sign out and delete your account and stored vault data.</div></div>
                    <Button variant="danger" icon={Trash2} onClick={() => setDeleteOpen(true)}>Delete account</Button>
                  </div>
                </div>
              </Card>
            </>
          ) : null}
        </div>
      </div>

      <ConfirmDialog
        open={deleteOpen}
        title="Delete this account?"
        description="This signs you out and clears your account session cache in this browser."
        confirmLabel="Sign out & clear"
        destructive
        loading={clearing}
        onConfirm={async () => {
          setClearing(true);
          clearAuthStorage();
          logout();
          setClearing(false);
          setDeleteOpen(false);
          toast({ tone: 'success', title: 'Account deleted', message: 'Your session and local cache were cleared.' });
          navigate('/login');
        }}
        onClose={() => setDeleteOpen(false)}
      />
    </div>
  );
}
