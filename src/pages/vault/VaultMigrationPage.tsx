import { useEffect, useState } from 'react';
import { Database, Download, FileInput, RefreshCw, ShieldCheck } from 'lucide-react';
import { PageHeader } from '@/components/ui/PageHeader';
import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/context/ToastContext';
import { legacyMigrationService, type MigrationSummary } from '../../../core/migration/legacy-migration-service';
import { vaultExportService } from '../../../core/storage/vault-export';
import { useApp } from '@/context/AppContext';

export function VaultMigrationPage() {
  const { user, refreshData } = useApp();
  const { toast } = useToast();
  const [legacyEmail, setLegacyEmail] = useState('');
  const [legacyPassword, setLegacyPassword] = useState('');
  const isExtension = typeof window !== 'undefined' && window.location.protocol === 'chrome-extension:';
  const [backupPassword, setBackupPassword] = useState('');
  const [importPassword, setImportPassword] = useState('');
  const [summary, setSummary] = useState<MigrationSummary | null>(null);
  const [legacyBusy, setLegacyBusy] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [importResult, setImportResult] = useState<{ documents: number; values: number; collections: number } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    // If a legacy session already exists, show what can be migrated without re-authenticating.
    void legacyMigrationService.probe().then((snapshot) => {
      setLegacyEmail(snapshot.user?.email ?? '');
    }).catch(() => undefined);
  }, []);

  const runLegacyMigration = async () => {
    setError('');
    setLegacyBusy(true);
    try {
      if (legacyEmail.trim() && legacyPassword) {
        await legacyMigrationService.login(legacyEmail, legacyPassword);
      }
      const result = await legacyMigrationService.migrate();
      setSummary(result);
      await refreshData();
      toast({
        tone: 'success',
        title: 'Legacy migration complete',
        message: `${result.documents.imported} documents and ${result.values.imported} values imported.`,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Legacy migration failed.');
    } finally {
      setLegacyBusy(false);
    }
  };

  const runLocalImport = async (file: File) => {
    setImportBusy(true);
    setError('');
    try {
      const result = await vaultExportService.importEncrypted(file, importPassword);
      setImportResult(result);
      await refreshData();
      toast({ tone: 'success', title: 'Local vault imported', message: `${result.documents} documents restored.` });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed.');
    } finally {
      setImportBusy(false);
    }
  };

  const exportLocalVault = async () => {
    try {
      const blob = await vaultExportService.exportEncrypted(backupPassword);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `formflow-local-vault-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast({ tone: 'error', title: 'Export failed', message: err instanceof Error ? err.message : 'Could not export vault.' });
    }
  };

  return (
    <div>
      <PageHeader
        eyebrow={<>Vault <span>›</span> Migration</>}
        title="Vault migration"
        description="Move an existing FormFlow vault into local IndexedDB, or transfer local data to another browser origin."
      />
      <div className="ff-dashboard-grid">
        {isExtension ? (
          <Card>
            <CardHeader title="Legacy backend migration" subtitle="The production extension does not contact the legacy backend." />
            <div className="ff-settings-section">
              <div className="ff-note">
                Export an encrypted archive from the localhost development dashboard, then import it here. This keeps the extension origin free of an unauthenticated localhost bridge.
              </div>
            </div>
          </Card>
        ) : (
          <Card>
            <CardHeader
              title="Migrate legacy backend data"
              subtitle="One-time import from the existing FormFlow backend. The backend is not used for normal app operation."
            />
            <div className="ff-settings-section">
              <div className="ff-settings-grid">
                <Input label="Legacy email" value={legacyEmail} onChange={(event) => setLegacyEmail(event.target.value)} />
                <Input label="Legacy password" type="password" value={legacyPassword} onChange={(event) => setLegacyPassword(event.target.value)} />
              </div>
              <Button className="ff-mt-12" variant="primary" icon={Database} loading={legacyBusy} onClick={runLegacyMigration} disabled={!user}>
                Migrate legacy data
              </Button>
              {summary ? (
                <div className="ff-stack ff-gap-8 ff-mt-12">
                  <div className="ff-info-pair"><span>Documents</span><span>{summary.documents.imported} imported / {summary.documents.skipped} duplicates / {summary.documents.failed} failed</span></div>
                  <div className="ff-info-pair"><span>Vault values</span><span>{summary.values.imported} imported / {summary.values.conflictsCreated} conflicts</span></div>
                  <div className="ff-info-pair"><span>Collections</span><span>{summary.collections.imported} imported</span></div>
                  <div className="ff-info-pair"><span>History</span><span>{summary.history.imported} imported</span></div>
                </div>
              ) : null}
              <div className="ff-note ff-mt-12">
                Migration is idempotent: identical documents and duplicate values are skipped. The legacy database is not modified.
              </div>
            </div>
          </Card>
        )}

        <Card>
          <CardHeader title="Encrypted vault transfer" subtitle="Export or import an encrypted vault archive between browser origins." />
          <div className="ff-settings-section">
            <div className="ff-settings-grid">
              <Input label="Backup passphrase" type="password" value={backupPassword} onChange={(event) => setBackupPassword(event.target.value)} placeholder="At least 8 characters" />
              <Input label="Import passphrase" type="password" value={importPassword} onChange={(event) => setImportPassword(event.target.value)} placeholder="Passphrase for the archive" />
            </div>
            <div className="ff-row ff-gap-8 ff-mt-12" style={{ flexWrap: 'wrap' }}>
              <Button icon={Download} onClick={exportLocalVault} disabled={backupPassword.length < 8}>Export encrypted vault</Button>
              <label className="ff-btn ff-btn--secondary" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <FileInput size={14} />
                Import encrypted vault
                <input
                  type="file"
                  accept="application/json"
                  hidden
                  disabled={importBusy || importPassword.length < 8}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void runLocalImport(file);
                  }}
                />
              </label>
            </div>
            {importResult ? (
              <div className="ff-stack ff-gap-8 ff-mt-12">
                <div className="ff-info-pair"><span>Documents</span><span>{importResult.documents}</span></div>
                <div className="ff-info-pair"><span>Values</span><span>{importResult.values}</span></div>
                <div className="ff-info-pair"><span>Collections</span><span>{importResult.collections}</span></div>
              </div>
            ) : null}
            <div className="ff-note ff-mt-12" style={{ display: 'flex', gap: 8 }}>
              <ShieldCheck size={14} style={{ color: 'var(--ff-success)' }} />
              <span>Archives are encrypted with the backup passphrase. Import validates document checksums and refuses to overwrite a non-empty vault.</span>
            </div>
          </div>
        </Card>
      </div>
      {error ? (
        <Card className="ff-section-card" style={{ borderColor: 'var(--ff-danger)' }}>
          <div className="ff-row ff-gap-6">
            <RefreshCw size={15} className="ff-primary" />
            <span>{error}</span>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
