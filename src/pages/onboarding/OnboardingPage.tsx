import { useEffect, useMemo, useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  FileText,
  LockKeyhole,
  ShieldCheck,
  Sparkles,
  UploadCloud,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { ProgressBar } from '@/components/ui/States';
import { useApp } from '@/context/AppContext';
import { vaultClient } from '@/services/vaultClient';
import type { SetupState } from '@/services/vaultClientTypes';

const STEPS = ['Welcome', 'Local AI', 'Documents', 'Review', 'Ready'] as const;

export function OnboardingPage() {
  const {
    documents,
    fields,
    dataLoading,
    modelStatus,
    installModel,
    selfTestModel,
    refreshModelStatus,
  } = useApp();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const restart = searchParams.get('restart') === '1';
  const [step, setStep] = useState(0);
  const [setup, setSetup] = useState<SetupState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [selfTest, setSelfTest] = useState<string>('');

  useEffect(() => {
    let cancelled = false;
    void vaultClient.getSetupState()
      .then((state) => {
        if (cancelled) return;
        setSetup(state);
        if (restart) {
          setStep(0);
        } else if (!state.completed) {
          setStep(Math.max(0, Math.min(STEPS.length - 1, state.currentStep || 0)));
        }
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Could not load setup state.');
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [restart]);

  useEffect(() => {
    if (step === 1) void refreshModelStatus();
  }, [step, refreshModelStatus]);

  const modelReady = modelStatus?.status === 'ready' || modelStatus?.status === 'installed';
  const modelBusy = modelStatus?.status === 'downloading' || modelStatus?.status === 'verifying' || modelStatus?.status === 'initializing';
  const progress = useMemo(() => ((step + 1) / STEPS.length) * 100, [step]);

  if (loading) return <div className="ff-empty"><span className="ff-spinner" /></div>;
  if (setup?.completed && !restart) return <Navigate to="/dashboard" replace />;

  const persist = async (patch: Partial<SetupState>) => {
    const next = await vaultClient.updateSetupState(patch);
    setSetup(next);
    return next;
  };

  const go = async (nextStep: number) => {
    setError('');
    setBusy(true);
    try {
      await persist({ currentStep: nextStep, completed: false });
      setStep(nextStep);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save setup progress.');
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    setBusy(true);
    setError('');
    try {
      await persist({ completed: true, currentStep: STEPS.length - 1 });
      navigate('/dashboard', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not complete setup.');
    } finally {
      setBusy(false);
    }
  };

  const skip = async () => {
    await finish();
  };

  return (
    <div className="ff-onboarding-page">
      <header className="ff-onboarding-topbar">
        <div>
          <div className="ff-pill"><Sparkles size={12} /> First-run setup</div>
          <div className="ff-body-sm ff-muted ff-mt-4">You can leave and resume this guide at any time.</div>
        </div>
        <div className="ff-onboarding-progress" aria-label={`Setup step ${step + 1} of ${STEPS.length}: ${STEPS[step]}`}>
          <span>Step {step + 1} of {STEPS.length}</span>
          <div className="ff-onboarding-progress__track"><span style={{ width: `${progress}%` }} /></div>
          <span className="ff-muted">{STEPS[step]}</span>
        </div>
        <button type="button" className="ff-link-button" onClick={() => void skip()} disabled={busy}>Skip setup</button>
      </header>

      <div className="ff-onboarding-body">
        <div className="ff-onboarding-card">
          {step === 0 ? (
            <>
              <div className="ff-onboarding-heading">
                <div className="ff-onboarding-heading__icon"><ShieldCheck size={22} /></div>
                <h1>Your vault is ready</h1>
                <p>FormFlow keeps documents and personal values in this browser, encrypted with your passphrase. This short guide connects the optional local AI model and shows you the review workflow.</p>
              </div>
              <div className="ff-onboarding-panel ff-card">
                <div className="ff-stack ff-gap-12">
                  <div className="ff-row ff-gap-8"><LockKeyhole size={16} className="ff-primary" /><span><strong>Local-first.</strong> No FormFlow account or cloud backend is required.</span></div>
                  <div className="ff-row ff-gap-8"><CheckCircle2 size={16} className="ff-success" /><span><strong>Review before fill.</strong> Values never reach a website without your explicit approval.</span></div>
                  <div className="ff-row ff-gap-8"><FileText size={16} className="ff-primary" /><span><strong>Evidence-backed.</strong> Each extracted value keeps its source document and page reference.</span></div>
                </div>
              </div>
              <div className="ff-onboarding-actions">
                <span className="ff-body-sm ff-muted">Takes about a minute</span>
                <Button variant="primary" icon={ArrowRight} onClick={() => void go(1)} loading={busy}>Continue</Button>
              </div>
            </>
          ) : null}

          {step === 1 ? (
            <>
              <div className="ff-onboarding-heading">
                <div className="ff-onboarding-heading__icon"><Sparkles size={22} /></div>
                <h1>Optional: install the local AI model</h1>
                <p>Deterministic extraction works without AI. The Qwen3-0.6B model adds grounded suggestions for ambiguous document text and form fields. It runs locally in an isolated worker.</p>
              </div>
              <div className="ff-onboarding-panel ff-card">
                <div className="ff-row ff-between ff-gap-8">
                  <div>
                    <div className="ff-label">Local model</div>
                    <div className="ff-body-sm ff-muted">
                      {modelStatus?.message ?? 'Checking local model status…'}
                    </div>
                  </div>
                  <Badge tone={modelReady ? 'success' : modelBusy ? 'primary' : 'neutral'}>
                    {modelReady ? 'Ready' : modelBusy ? 'Working' : 'Not installed'}
                  </Badge>
                </div>
                {modelStatus?.progress ? (
                  <ProgressBar value={modelStatus.progress.percent} label={`${modelStatus.progress.phase} · ${Math.round(modelStatus.progress.percent)}%`} />
                ) : null}
                <div className="ff-note ff-mt-12">
                  The verified INT8 model is about 734 MiB. Installation temporarily needs roughly twice that space while chunks are assembled and verified. You can remove it later in Settings → Local AI.
                </div>
                <div className="ff-row ff-gap-8 ff-mt-16" style={{ flexWrap: 'wrap' }}>
                  <Button icon={Sparkles} onClick={() => void installModel()} disabled={modelBusy || modelReady}>
                    {modelReady ? 'Model installed' : modelBusy ? 'Installation in progress' : 'Install local model'}
                  </Button>
                  <Button
                    icon={CheckCircle2}
                    disabled={!modelReady || modelBusy}
                    onClick={async () => {
                      setError('');
                      const result = await selfTestModel();
                      setSelfTest(result.ok ? `Self-test passed in ${result.latencyMs} ms.` : result.message);
                      if (!result.ok) setError(result.message);
                    }}
                  >
                    Run self-test
                  </Button>
                </div>
                {selfTest ? <div className="ff-body-sm ff-mt-8" style={{ color: 'var(--ff-success)' }}>{selfTest}</div> : null}
                {modelStatus?.status === 'failed' || modelStatus?.status === 'corrupt' ? (
                  <div className="ff-note ff-mt-12" style={{ color: 'var(--ff-danger)', borderColor: 'var(--ff-danger)' }}>
                    {modelStatus.record?.error ?? 'The model installation failed. Retry, or continue without AI.'}
                  </div>
                ) : null}
              </div>
              <div className="ff-onboarding-actions">
                <Button variant="ghost" icon={ArrowLeft} onClick={() => void go(0)}>Back</Button>
                <div className="ff-row ff-gap-8">
                  <Button variant="ghost" onClick={() => void go(2)}>Skip AI for now</Button>
                  <Button variant="primary" icon={ArrowRight} onClick={() => void go(2)} loading={busy}>Continue</Button>
                </div>
              </div>
            </>
          ) : null}

          {step === 2 ? (
            <>
              <div className="ff-onboarding-heading">
                <div className="ff-onboarding-heading__icon"><UploadCloud size={22} /></div>
                <h1>Add documents when you are ready</h1>
                <p>Upload PDF, DOCX or TXT files from your device. FormFlow extracts text and evidence locally; scanned pages can use bundled OCR. You do not have to upload anything during setup.</p>
              </div>
              <div className="ff-onboarding-panel ff-card">
                <div className="ff-info-pair"><span>Documents in this vault</span><span>{documents.length}</span></div>
                <div className="ff-info-pair"><span>Profile values available</span><span>{fields.length}</span></div>
                <div className="ff-note ff-mt-12">
                  Everything is stored in the encrypted local vault. Original files are never sent to a FormFlow server or an external AI provider.
                </div>
              </div>
              <div className="ff-onboarding-actions">
                <Button variant="ghost" icon={ArrowLeft} onClick={() => void go(1)}>Back</Button>
                <div className="ff-row ff-gap-8">
                  <Button variant="ghost" onClick={() => void go(3)}>Continue without documents</Button>
                  <Button variant="primary" icon={UploadCloud} onClick={() => navigate('/documents?upload=1')}>Open document vault</Button>
                </div>
              </div>
            </>
          ) : null}

          {step === 3 ? (
            <>
              <div className="ff-onboarding-heading">
                <div className="ff-onboarding-heading__icon"><FileText size={22} /></div>
                <h1>Review what FormFlow found</h1>
                <p>Values are suggestions, not verified facts. Check the source and edit anything that is wrong before using it in a form.</p>
              </div>
              <div className="ff-onboarding-panel ff-card">
                {dataLoading ? <div className="ff-spinner" /> : fields.length ? (
                  <div className="ff-stack ff-gap-8">
                    {fields.slice(0, 6).map((field) => (
                      <div className="ff-row ff-between ff-gap-8" key={field.id}>
                        <span className="ff-truncate"><span className="ff-label">{field.label}</span><span className="ff-body-sm ff-muted" style={{ display: 'block' }}>{field.source.documentName || 'Manual entry'}</span></span>
                        <Badge tone={field.verificationStatus === 'user_verified' ? 'success' : 'neutral'}>
                          {field.verificationStatus === 'user_verified' ? 'Verified' : `${field.confidence}%`}
                        </Badge>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="ff-body-sm ff-muted">No values yet. You can add documents later and return to this guide.</div>
                )}
              </div>
              <div className="ff-onboarding-actions">
                <Button variant="ghost" icon={ArrowLeft} onClick={() => void go(2)}>Back</Button>
                <div className="ff-row ff-gap-8">
                  <Button variant="ghost" onClick={() => navigate('/records/personal')}>Open profile</Button>
                  <Button variant="primary" icon={ArrowRight} onClick={() => void go(4)} loading={busy}>Continue</Button>
                </div>
              </div>
            </>
          ) : null}

          {step === 4 ? (
            <>
              <div className="ff-onboarding-heading">
                <div className="ff-onboarding-heading__icon"><CheckCircle2 size={22} /></div>
                <h1>Setup complete</h1>
                <p>Load the extension, open a supported form, scan it, review every suggested value, and approve the fields you want to fill. FormFlow never submits a form for you.</p>
              </div>
              <div className="ff-onboarding-panel ff-card">
                <div className="ff-row ff-between"><span>Encrypted vault</span><Badge tone="success">Ready</Badge></div>
                <div className="ff-row ff-between ff-mt-8"><span>Local AI model</span><Badge tone={modelReady ? 'success' : 'neutral'}>{modelReady ? 'Ready' : 'Optional / not installed'}</Badge></div>
                <div className="ff-row ff-between ff-mt-8"><span>Documents</span><Badge tone={documents.length ? 'success' : 'neutral'}>{documents.length || 'None yet'}</Badge></div>
                <div className="ff-row ff-between ff-mt-8"><span>Profile values</span><Badge tone={fields.length ? 'success' : 'neutral'}>{fields.length || 'None yet'}</Badge></div>
                <div className="ff-note ff-mt-12">
                  You can reopen this guide from Settings → Help &amp; setup. Nothing is locked in; documents and the model can be added or removed later.
                </div>
              </div>
              <div className="ff-onboarding-actions">
                <Button variant="ghost" icon={ArrowLeft} onClick={() => void go(3)}>Back</Button>
                <Button variant="primary" icon={ArrowRight} onClick={() => void finish()} loading={busy}>Go to dashboard</Button>
              </div>
            </>
          ) : null}

          {error ? <div className="ff-note ff-mt-12" role="alert" style={{ color: 'var(--ff-danger)', borderColor: 'var(--ff-danger)' }}>{error}</div> : null}
        </div>
      </div>
    </div>
  );
}
