import { useState } from 'react';
import {
  CheckCircle2,
  Cpu,
  Download,
  HardDrive,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trash2,
  XCircle,
} from 'lucide-react';
import { Card, CardHeader } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/Modal';
import { ProgressBar } from '@/components/ui/States';
import { Switch } from '@/components/ui/Switch';
import { useApp } from '@/context/AppContext';
import type { ModelSelfTestResult } from '@/services/types';

const BYTES_PER_MB = 1024 * 1024;

function mb(bytes: number): string {
  return `${(bytes / BYTES_PER_MB).toFixed(bytes >= 100 * BYTES_PER_MB ? 0 : 1)} MB`;
}

function statusTone(status: string): 'success' | 'warning' | 'danger' | 'primary' | 'neutral' {
  if (status === 'ready' || status === 'installed') return 'success';
  if (status === 'downloading' || status === 'verifying' || status === 'initializing') return 'primary';
  if (status === 'failed' || status === 'corrupt') return 'danger';
  return 'warning';
}

function statusLabel(status: string): string {
  switch (status) {
    case 'ready':
      return 'Ready';
    case 'installed':
      return 'Installed';
    case 'downloading':
      return 'Downloading';
    case 'verifying':
      return 'Verifying';
    case 'initializing':
      return 'Initializing';
    case 'failed':
      return 'Failed';
    case 'corrupt':
      return 'Corrupt';
    default:
      return 'Not installed';
  }
}

export function ModelSettingsCard() {
  const {
    modelStatus,
    preferences,
    updatePreferences,
    installModel,
    cancelModelInstall,
    removeModel,
    selfTestModel,
    upgradeModel,
    cancelModelUpgrade,
    rollbackModel,
    cancelInference,
  } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [test, setTest] = useState<ModelSelfTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const status = modelStatus?.status ?? 'not_installed';
  const record = modelStatus?.record ?? null;
  const installed = status === 'installed' || status === 'ready';
  const active = status === 'downloading' || status === 'verifying' || status === 'initializing';
  const expected = record?.expectedBytes ?? 769_882_900;
  const downloaded = record?.downloadedBytes ?? 0;
  const percent = modelStatus?.progress?.percent
    ?? (expected > 0 ? Math.min(100, (downloaded / expected) * 100) : 0);

  const run = async (kind: string, action: () => Promise<unknown>) => {
    setBusy(kind);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The local model operation failed.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <Card>
        <CardHeader
          title={<span className="ff-row ff-gap-8"><Sparkles size={16} className="ff-primary" /> Local AI model</span>}
          subtitle="Qwen3-0.6B Instruct, quantized for local browser inference. Your documents and profile never leave this device."
          action={<Badge tone={statusTone(status)}>{statusLabel(status)}</Badge>}
        />
        <div className="ff-settings-section">
          <div className="ff-stack ff-gap-8">
            <div className="ff-info-pair"><span>Model</span><span>{record?.modelId ?? 'Qwen3-0.6B-Instruct-ONNX'}</span></div>
            <div className="ff-info-pair"><span>Quantization</span><span>{record?.dtype === 'q8' ? 'INT8 / Q8' : (record?.dtype ?? 'INT8 / Q8')}</span></div>
            <div className="ff-info-pair"><span>Runtime</span><span>WASM (CPU) · local only</span></div>
            <div className="ff-info-pair"><span>Download size</span><span>{mb(expected)}</span></div>
            <div className="ff-info-pair"><span>Free space recommended</span><span>{mb(expected * 2 + 128 * BYTES_PER_MB)}</span></div>
            <div className="ff-info-pair"><span>Downloaded</span><span>{mb(downloaded)} · {Math.round(percent)}%</span></div>
            <div className="ff-info-pair"><span>Revision</span><span className="ff-code">{record?.revision?.slice(0, 12) ?? '54250909aca2'}</span></div>
            <div className="ff-info-pair"><span>Installed</span><span>{record?.installedAt ? new Date(record.installedAt).toLocaleString() : 'Not installed'}</span></div>
            <div className="ff-info-pair"><span>Last verified</span><span>{record?.lastVerifiedAt ? new Date(record.lastVerifiedAt).toLocaleString() : '—'}</span></div>
            <div className="ff-info-pair"><span>Last initialized</span><span>{record?.lastInitializedAt ? new Date(record.lastInitializedAt).toLocaleString() : 'Loads on first use'}</span></div>
            <div className="ff-info-pair"><span>Version</span><span>{record?.version ?? '0.6.0-int8-r1'}</span></div>
            <div className="ff-info-pair"><span>Release</span><span className="ff-code">{record?.releaseId ?? 'qwen3-0.6b-int8-2026-11'}</span></div>
            <div className="ff-info-pair"><span>Manifest version</span><span>{record?.manifestVersion ?? 1}</span></div>
            <div className="ff-info-pair"><span>Verification</span><span>{record?.lastVerifiedAt ? 'SHA-256 verified' : 'Pending'}</span></div>
            <div className="ff-info-pair"><span>Active release</span><span className="ff-code">{modelStatus?.lifecycle?.activeReleaseId ?? '—'}</span></div>
            <div className="ff-info-pair"><span>Rollback available</span><span>{modelStatus?.rollback?.available ? `Yes · ${modelStatus.rollback.previousReleaseId ?? 'previous verified model'}` : 'No'}</span></div>
            <div className="ff-info-pair"><span>Upgrade</span><span>{modelStatus?.availableUpgrade?.available ? `Available · ${modelStatus.availableUpgrade.version ?? ''}` : (modelStatus?.availableUpgrade?.reason ?? 'Checking…')}</span></div>
          </div>

          {active || (record && !installed) ? (
            <div className="ff-mt-16">
              <ProgressBar value={percent} label={`${modelStatus?.progress?.filePath ?? 'Model files'} · ${Math.round(percent)}%`} />
            </div>
          ) : null}

          {modelStatus?.inference?.active ? (
            <div className="ff-note ff-mt-16">
              Local inference is generating tokens ({modelStatus.inference.generatedTokens} produced).{' '}
              <button type="button" className="ff-link-button" style={{ color: 'var(--ff-primary)' }} onClick={() => void cancelInference()}>
                Cancel inference
              </button>
            </div>
          ) : null}
          {modelStatus?.message ? <div className="ff-note ff-mt-16">{modelStatus.message}</div> : null}
          {record?.error ? <div className="ff-note ff-mt-12" style={{ color: 'var(--ff-danger)', borderColor: 'var(--ff-danger)' }}>{record.error}</div> : null}
          {modelStatus?.failureDetails ? <div className="ff-note ff-mt-12" style={{ color: 'var(--ff-danger)', borderColor: 'var(--ff-danger)' }}>{modelStatus.failureDetails}</div> : null}
          {modelStatus?.lifecycle && ['checking', 'downloading', 'verifying', 'self_testing', 'switching'].includes(modelStatus.lifecycle.phase) ? (
            <div className="ff-note ff-mt-12" role="status">Model upgrade in progress · {modelStatus.lifecycle.phase.replace('_', ' ')}.</div>
          ) : null}
          {error ? <div className="ff-note ff-mt-12" style={{ color: 'var(--ff-danger)', borderColor: 'var(--ff-danger)' }} role="alert">{error}</div> : null}

          <div className="ff-setting-row ff-mt-16">
            <div>
              <div className="ff-label">Automatic first-run download</div>
              <div className="ff-body-sm ff-muted">Start the model download after your first successful document upload.</div>
            </div>
            <Switch
              checked={preferences.autoDownloadModel !== false}
              onChange={(checked) => void updatePreferences({ ...preferences, autoDownloadModel: checked })}
              label="Download model automatically after the first document upload"
            />
          </div>

          <div className="ff-row ff-gap-8 ff-mt-16" style={{ flexWrap: 'wrap' }}>
            {!installed && !active ? (
              <Button variant="primary" icon={Download} loading={busy === 'install'} onClick={() => void run('install', installModel)}>
                {status === 'failed' || status === 'corrupt' ? 'Retry download' : 'Download model'}
              </Button>
            ) : null}
            {active ? (
              <Button icon={XCircle} loading={busy === 'cancel'} onClick={() => void run('cancel', cancelModelInstall)}>
                Cancel download
              </Button>
            ) : null}
            {installed ? (
              <>
                <Button
                  variant="primary"
                  icon={CheckCircle2}
                  loading={busy === 'test'}
                  onClick={() => void run('test', async () => {
                    const result = await selfTestModel();
                    setTest(result);
                  })}
                >
                  Run local self-test
                </Button>
                <Button icon={RefreshCw} loading={busy === 'reinstall'} onClick={() => void run('reinstall', installModel)}>
                  Verify &amp; repair
                </Button>
                <Button icon={Trash2} loading={busy === 'remove'} onClick={() => setRemoveOpen(true)}>
                  Remove model
                </Button>
              </>
            ) : null}
          </div>

          {installed ? (
            <div className="ff-row ff-gap-8 ff-mt-8" style={{ flexWrap: 'wrap' }}>
              <Button
                icon={RefreshCw}
                loading={busy === 'upgrade'}
                onClick={() => void run('upgrade', async () => {
                  const result = await upgradeModel();
                  setError(result.ok ? null : result.message);
                })}
              >
                Check for upgrade
              </Button>
              {modelStatus?.lifecycle && ['checking', 'downloading', 'verifying', 'self_testing', 'switching'].includes(modelStatus.lifecycle.phase) ? (
                <Button icon={XCircle} onClick={() => void run('upgrade-cancel', cancelModelUpgrade)}>Cancel upgrade</Button>
              ) : null}
              {modelStatus?.rollback?.available ? (
                <Button
                  icon={RefreshCw}
                  loading={busy === 'rollback'}
                  onClick={() => void run('rollback', async () => {
                    const result = await rollbackModel();
                    setError(result.ok ? null : result.message);
                  })}
                >
                  Roll back to previous model
                </Button>
              ) : null}
            </div>
          ) : null}

          {test ? (
            <div className="ff-note ff-mt-16" style={{ borderColor: test.ok ? 'var(--ff-success)' : 'var(--ff-danger)' }}>
              <strong>{test.ok ? 'Local inference verified' : 'Self-test failed'}.</strong>{' '}
              {test.message}
              {test.ok && test.latencyMs !== undefined ? ` Inference ${test.latencyMs} ms · load ${test.loadMs ?? 0} ms.` : ''}
            </div>
          ) : null}
        </div>
      </Card>

      <Card>
        <CardHeader title="Model storage & diagnostics" subtitle="Local extension-origin storage. No vault keys or personal information are used for inference diagnostics." />
        <div className="ff-settings-section">
          <div className="ff-stack ff-gap-8">
            <div className="ff-info-pair"><span>Model storage</span><span>{modelStatus?.storage ? mb(modelStatus.storage.modelBytes) : 'Measuring…'}</span></div>
            <div className="ff-info-pair"><span>Browser usage</span><span>{modelStatus?.storage ? mb(modelStatus.storage.usageBytes) : 'Unknown'}</span></div>
            <div className="ff-info-pair"><span>Available quota</span><span>{modelStatus?.storage ? mb(modelStatus.storage.availableBytes) : 'Unknown'}</span></div>
            <div className="ff-info-pair"><span>Persistent storage</span><span>{modelStatus?.storage?.persisted ? 'Granted' : 'Best effort'}</span></div>
            <div className="ff-info-pair"><span>WebGPU detected</span><span>{modelStatus?.capabilities.webgpu ? 'Yes (not used in this build)' : 'No'}</span></div>
            <div className="ff-info-pair"><span>CPU threads</span><span>{modelStatus?.capabilities.hardwareConcurrency ?? 'Unknown'}</span></div>
          </div>
          <div className="ff-row ff-gap-8 ff-mt-12" style={{ alignItems: 'flex-start' }}>
            <Cpu size={15} className="ff-muted" style={{ marginTop: 2 }} />
            <span className="ff-body-sm ff-muted">
              Inference runs in a dedicated extension worker. Model files are verified with SHA-256 before use,
              loaded only from the local cache, and unloaded when idle. The verified Q8 artifact is used on CPU/WASM.
              WebGPU is detected for diagnostics only; the Q4F16 WebGPU path is not enabled in this build.
            </span>
          </div>
          <div className="ff-row ff-gap-8 ff-mt-8" style={{ alignItems: 'flex-start' }}>
            <HardDrive size={15} className="ff-muted" style={{ marginTop: 2 }} />
            <span className="ff-body-sm ff-muted">
              Basic dashboard, document ingestion, deterministic extraction and autofill remain available while the
              model is absent, downloading, or failed.
            </span>
          </div>
          <div className="ff-row ff-gap-8 ff-mt-8" style={{ alignItems: 'flex-start' }}>
            <ShieldCheck size={15} className="ff-muted" style={{ marginTop: 2 }} />
            <span className="ff-body-sm ff-muted">
              The only network request made by the local AI feature is the configured public model-asset download.
              Inference has no remote fallback.
            </span>
          </div>
        </div>
      </Card>

      <ConfirmDialog
        open={removeOpen}
        title="Remove the local AI model?"
        description="The downloaded model files will be deleted from browser storage. Your encrypted vault, documents and profile values are not affected. You can download the model again later."
        confirmLabel="Remove model"
        destructive
        onConfirm={() => {
          setRemoveOpen(false);
          void run('remove', removeModel);
        }}
        onClose={() => setRemoveOpen(false)}
      />
    </>
  );
}
