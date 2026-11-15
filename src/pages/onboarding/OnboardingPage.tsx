import { useEffect, useRef, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  Chrome,
  Cloud,
  Download,
  FileCheck2,
  FolderOpen,
  LockKeyhole,
  ShieldCheck,
  Sparkles,
  UploadCloud,
} from 'lucide-react';
import { Logo } from '@/components/brand/Logo';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Checkbox } from '@/components/ui/Checkbox';
import { ProgressBar, Skeleton } from '@/components/ui/States';
import { useApp } from '@/context/AppContext';
import { googleDriveService } from '@/services/googleDriveService';
import type { DriveFile } from '@/services/types';
import { cn } from '@/utils/cn';

const STEPS = ['Welcome', 'Google Drive', 'Documents', 'Processing', 'Review', 'Extension', 'Ready'];

export function OnboardingPage() {
  const { user, driveConnection, addDriveDocuments, extensionConnection, fields, updateField, documents } = useApp();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [accessGranted, setAccessGranted] = useState(false);
  const [files, setFiles] = useState<DriveFile[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [progress, setProgress] = useState(0);
  const [processed, setProcessed] = useState(false);
  const imported = useRef(false);
  const [reviewValues, setReviewValues] = useState<Record<string, string>>({});

  useEffect(() => {
    if (step !== 2 || files.length) return;
    setFilesLoading(true);
    googleDriveService.listFiles().then((next) => {
      setFiles(next);
      setFilesLoading(false);
    });
  }, [step, files.length]);

  useEffect(() => {
    if (step !== 3 || imported.current) return;
    imported.current = true;
    const chosen = files.filter((file) => selected.includes(file.id));
    void addDriveDocuments(chosen);
    setProgress(8);
    const timer = window.setInterval(() => {
      setProgress((current) => {
        if (current >= 92) {
          window.clearInterval(timer);
          window.setTimeout(() => setProcessed(true), 500);
          return 100;
        }
        return Math.min(96, current + 11);
      });
    }, 220);
    return () => window.clearInterval(timer);
  }, [step, files, selected, addDriveDocuments]);

  useEffect(() => {
    if (step === 4) {
      setReviewValues(Object.fromEntries(fields.map((field) => [field.id, field.value])));
    }
  }, [step, fields]);

  if (!user) return <Navigate to="/login" replace />;

  const selectedFiles = files.filter((file) => selected.includes(file.id));
  const canContinue = step === 1 ? accessGranted : step === 2 ? selected.length > 0 : step === 3 ? processed : true;

  const next = async () => {
    if (step === 6) {
      navigate('/dashboard');
      return;
    }
    if (step === 4) {
      const changed = fields.filter((field) => reviewValues[field.id] !== undefined && reviewValues[field.id] !== field.value);
      for (const field of changed) await updateField(field.id, reviewValues[field.id]);
    }
    setStep((current) => Math.min(6, current + 1));
  };

  return (
    <div className="ff-onboarding-page">
      <header className="ff-onboarding-topbar">
        <Logo />
        <div className="ff-onboarding-progress">
          <span>Step {step + 1} of {STEPS.length}</span>
          <div className="ff-onboarding-progress__track"><span style={{ width: `${((step + 1) / STEPS.length) * 100}%` }} /></div>
          <span className="ff-muted">{STEPS[step]}</span>
        </div>
        <button type="button" className="ff-link-button" onClick={() => navigate('/dashboard')}>Skip for now</button>
      </header>

      <div className="ff-onboarding-body">
        <div className={cn('ff-onboarding-card', step !== 0 && step !== 3 && step !== 4 ? 'ff-onboarding-card--narrow' : '')}>
          {step === 0 ? (
            <>
              <div className="ff-onboarding-heading">
                <div className="ff-pill" style={{ marginBottom: 10 }}><Sparkles size={12} /> Welcome to FormFlow</div>
                <h1>Stop retyping what your documents already know.</h1>
                <p>FormFlow turns the documents you choose into a private, reviewable set of form-ready information.</p>
              </div>
              <div className="ff-welcome-visual">
                <div className="ff-welcome-copy">
                  <h2>One vault.<br />Every form.</h2>
                  <p>Detect fields, review suggested values, and fill with confidence. You stay in control of every value.</p>
                  <div className="ff-welcome-list">
                    <div><Check size={14} /> Documents stay in your Google Drive</div>
                    <div><Check size={14} /> You approve every matched field</div>
                    <div><Check size={14} /> FormFlow never submits forms</div>
                  </div>
                </div>
                <div className="ff-welcome-mock">
                  <div className="ff-welcome-mock__head">
                    <span className="ff-label">Application form</span>
                    <Badge tone="success">4 matched</Badge>
                  </div>
                  <div style={{ marginTop: 5 }}>
                    <div className="ff-mock-field"><span className="ff-mock-field__label">Full name</span><span className="ff-mock-field__value">{user?.name ?? 'Alex Morgan'}</span></div>
                    <div className="ff-mock-field"><span className="ff-mock-field__label">Email</span><span className="ff-mock-field__value">{user?.email ?? 'alex@example.com'}</span></div>
                    <div className="ff-mock-field"><span className="ff-mock-field__label">Degree</span><span className="ff-mock-field__value">B.Tech in CSE</span></div>
                    <div className="ff-mock-field"><span className="ff-mock-field__label">Institution</span><span className="ff-mock-field__value">State University</span></div>
                  </div>
                  <div className="ff-note" style={{ marginTop: 12, fontSize: 10 }}>Preview data only. Nothing has been read from Drive.</div>
                </div>
              </div>
              <div className="ff-onboarding-actions">
                <span className="ff-body-sm ff-muted">Takes about 2 minutes</span>
                <Button variant="primary" icon={ArrowRight} onClick={next}>Get started</Button>
              </div>
            </>
          ) : null}

          {step === 1 ? (
            <>
              <div className="ff-onboarding-heading">
                <div className="ff-onboarding-heading__icon"><Cloud size={22} /></div>
                <h1>Connect Google Drive</h1>
                <p>FormFlow needs access to the files you explicitly select. It does not browse your entire Drive.</p>
              </div>
              <div className="ff-onboarding-panel ff-card">
                <div className="ff-connection-card">
                  <div className="ff-connection-card__identity">
                    <span className="ff-connection-icon"><span className="ff-google-mark">G</span></span>
                    <div>
                      <div className="ff-label">Google Drive</div>
                      <div className="ff-body-sm ff-muted">{driveConnection.connected ? driveConnection.accountEmail : 'No account linked'}</div>
                    </div>
                  </div>
                  <Badge tone={driveConnection.connected ? 'success' : 'neutral'}>{driveConnection.connected ? 'Connected' : 'Not authorized'}</Badge>
                </div>
                <div className="ff-drive-permissions">
                  <div className="ff-permission"><CheckCircle2 size={15} /><div><div className="ff-label">View only the files you select</div><div className="ff-body-sm ff-muted">FormFlow receives a per-file permission, not full Drive access.</div></div></div>
                  <div className="ff-permission"><CheckCircle2 size={15} /><div><div className="ff-label">Read selected file contents for extraction</div><div className="ff-body-sm ff-muted">Processing happens to produce the values you review.</div></div></div>
                  <div className="ff-permission"><CheckCircle2 size={15} /><div><div className="ff-label">Revoke access at any time</div><div className="ff-body-sm ff-muted">Disconnecting in Settings removes FormFlow's authorization.</div></div></div>
                </div>
                <div className="ff-note ff-mt-16">
                  <strong>Granular permissions.</strong> FormFlow requests access only for the specific documents
                  you select. FormFlow never asks for your Google account password.
                </div>
                <div className="ff-onboarding-actions">
                  <Button variant="ghost" icon={ArrowLeft} onClick={() => setStep(0)}>Back</Button>
                  <Button
                    variant={accessGranted || driveConnection.connected ? 'secondary' : 'primary'}
                    icon={accessGranted || driveConnection.connected ? Check : Cloud}
                    onClick={() => {
                      if (!driveConnection.connected) {
                        void googleDriveService.connect();
                      } else {
                        setAccessGranted(true);
                      }
                    }}
                  >
                    {driveConnection.connected ? 'Google Drive connected' : 'Connect Google Drive'}
                  </Button>
                </div>
              </div>
              <div className="ff-onboarding-actions">
                <Button variant="ghost" onClick={next}>Skip for now</Button>
                <Button variant="primary" icon={ArrowRight} onClick={next} disabled={!canContinue}>Choose documents</Button>
              </div>
            </>
          ) : null}

          {step === 2 ? (
            <>
              <div className="ff-onboarding-heading">
                <div className="ff-onboarding-heading__icon"><FolderOpen size={22} /></div>
                <h1>Select the documents to use</h1>
                <p>Pick only what you want FormFlow to process. You can add or remove documents later.</p>
              </div>
              <div className="ff-onboarding-panel ff-card">
                <div className="ff-row ff-between ff-mb-8">
                  <span className="ff-label">Available in Google Drive</span>
                  <span className="ff-code ff-muted">{selected.length} selected</span>
                </div>
                {filesLoading ? (
                  <div className="ff-stack ff-gap-8">{Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} height={46} />)}</div>
                ) : (
                  <div className="ff-drive-file-list ff-scroll">
                    {files.map((file) => {
                      const isSelected = selected.includes(file.id);
                      return (
                        <label key={file.id} className="ff-drive-file" data-selected={isSelected}>
                          <Checkbox
                            checked={isSelected}
                            onChange={(event) =>
                              setSelected((current) =>
                                event.target.checked ? [...current, file.id] : current.filter((id) => id !== file.id),
                              )
                            }
                          />
                          <span className="ff-file-icon" data-kind={file.fileType}><FileCheck2 size={16} /></span>
                          <span style={{ flex: 1, minWidth: 0 }}>
                            <span className="ff-label ff-truncate" style={{ display: 'block' }}>{file.name}</span>
                            <span className="ff-body-sm ff-muted">{file.sizeLabel} · {file.modifiedAt}</span>
                          </span>
                          <span className="ff-tag">{file.subcategory.split(' / ')[1] ?? file.category}</span>
                        </label>
                      );
                    })}
                  </div>
                )}
                <div className="ff-row ff-between ff-mt-12">
                  <button type="button" className="ff-link-button" onClick={() => setSelected(files.map((file) => file.id))}>Select all</button>
                  <button type="button" className="ff-link-button" onClick={() => setSelected([])}>Clear selection</button>
                </div>
              </div>
              <div className="ff-onboarding-actions">
                <Button variant="ghost" icon={ArrowLeft} onClick={() => setStep(1)}>Back</Button>
                <Button variant="primary" icon={ArrowRight} onClick={next} disabled={!canContinue}>
                  Process {selected.length || ''} {selected.length === 1 ? 'document' : 'documents'}
                </Button>
              </div>
            </>
          ) : null}

          {step === 3 ? (
            <>
              <div className="ff-onboarding-heading">
                <div className="ff-onboarding-heading__icon"><UploadCloud size={22} /></div>
                <h1>{processed ? 'Your vault is ready' : 'Extracting information'}</h1>
                <p>{processed ? 'The selected documents were processed into reviewable vault values.' : 'FormFlow is reading and analyzing the documents you selected.'}</p>
              </div>
              <div className="ff-onboarding-panel ff-card">
                <ProgressBar value={progress} label={processed ? 'Complete' : `Processing ${selectedFiles.length} documents`} />
                <div className="ff-processing-list ff-mt-16">
                  {selectedFiles.map((file, index) => {
                    const rowProgress = Math.max(0, Math.min(100, progress * (1 + index * 0.18)));
                    const done = processed || rowProgress >= 100;
                    return (
                      <div className="ff-processing-row" key={file.id}>
                        <span className="ff-file-icon" data-kind={file.fileType}><FileCheck2 size={16} /></span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div className="ff-label ff-truncate">{file.name}</div>
                          <div className="ff-processing-row__bar ff-mt-4"><span style={{ width: `${rowProgress}%` }} /></div>
                        </div>
                        <Badge tone={done ? 'success' : 'primary'}>{done ? 'Processed' : 'Reading'}</Badge>
                      </div>
                    );
                  })}
                </div>
                <div className="ff-note ff-mt-16">
                  Documents are processed locally into structured facts with source references and confidence scores.
                </div>
              </div>
              <div className="ff-onboarding-actions">
                <Button variant="ghost" icon={ArrowLeft} onClick={() => setStep(2)} disabled={!processed}>Back</Button>
                <Button variant="primary" icon={ArrowRight} onClick={next} disabled={!canContinue}>Continue</Button>
              </div>
            </>
          ) : null}

          {step === 4 ? (
            <>
              <div className="ff-onboarding-heading">
                <div className="ff-onboarding-heading__icon"><FileCheck2 size={22} /></div>
                <h1>Review extracted information</h1>
                <p>Correct anything that looks wrong. Every value keeps a link to its source document.</p>
              </div>
              <div className="ff-onboarding-panel ff-card">
                <div className="ff-row ff-between ff-mb-12">
                  <span className="ff-label">Vault values ready for review</span>
                  <Badge tone="success">{fields.length} extracted</Badge>
                </div>
                <div className="ff-stack ff-gap-8">
                  {fields.slice(0, 8).map((field) => (
                    <div className="ff-review-value" key={field.id}>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div className="ff-label">{field.label}</div>
                        <div className="ff-body-sm ff-muted ff-truncate">{field.source.documentName} · {field.confidence}% confidence{field.conflicts?.length ? ' · needs review' : ''}</div>
                      </div>
                      <input
                        className="ff-input"
                        style={{ maxWidth: 260 }}
                        value={reviewValues[field.id] ?? field.value}
                        onChange={(event) => setReviewValues({ ...reviewValues, [field.id]: event.target.value })}
                      />
                    </div>
                  ))}
                </div>
                <div className="ff-note ff-mt-12">
                  Values extracted from your documents. Editing here marks the value as user-verified.
                </div>
              </div>
              <div className="ff-onboarding-actions">
                <Button variant="ghost" icon={ArrowLeft} onClick={() => setStep(3)}>Back</Button>
                <Button variant="primary" icon={ArrowRight} onClick={() => void next()}>Save &amp; continue</Button>
              </div>
            </>
          ) : null}

          {step === 5 ? (
            <>
              <div className="ff-onboarding-heading">
                <div className="ff-onboarding-heading__icon"><Chrome size={22} /></div>
                <h1>Install the Chrome extension</h1>
                <p>The extension detects forms and lets you review each value before autofill. It never submits a form.</p>
              </div>
              <div className="ff-onboarding-panel ff-card">
                <div className="ff-extension-steps">
                  <div className="ff-extension-step">
                    <span className="ff-extension-step__num">1</span>
                    <h3>Load the extension</h3>
                    <p>Open chrome://extensions, enable Developer mode, and load the unpacked <code>extension/dist</code> folder.</p>
                  </div>
                  <div className="ff-extension-step">
                    <span className="ff-extension-step__num">2</span>
                    <h3>Pin FormFlow</h3>
                    <p>Pin the extension to your toolbar so it is available on any form you choose to fill.</p>
                  </div>
                  <div className="ff-extension-step">
                    <span className="ff-extension-step__num">3</span>
                    <h3>Connect your vault</h3>
                    <p>Open the popup on any tab with a form to inspect detected fields and approve autofill.</p>
                  </div>
                </div>
                <div className="ff-row ff-between ff-mt-16" style={{ padding: 12, borderRadius: 8, background: 'var(--ff-surface-low)' }}>
                  <div className="ff-row ff-gap-8">
                    <span className={`ff-status-dot ${extensionConnection.connected ? 'is-online' : ''}`} />
                    <div>
                      <div className="ff-label">{extensionConnection.connected ? 'Extension detected' : 'Extension not detected'}</div>
                      <div className="ff-body-sm ff-muted">Version {extensionConnection.version} · shortcut {extensionConnection.shortcut}</div>
                    </div>
                  </div>
                  <Badge tone={extensionConnection.connected ? 'success' : 'warning'}>{extensionConnection.connected ? 'Ready' : 'Optional'}</Badge>
                </div>
                <div className="ff-note ff-mt-12">
                  The extension is loaded directly from extension/dist in your browser.
                </div>
              </div>
              <div className="ff-onboarding-actions">
                <Button variant="ghost" icon={ArrowLeft} onClick={() => setStep(4)}>Back</Button>
                <Button variant="primary" icon={ArrowRight} onClick={next}>Continue</Button>
              </div>
            </>
          ) : null}

          {step === 6 ? (
            <>
              <div className="ff-onboarding-panel ff-card ff-complete-hero">
                <div className="ff-complete-hero__icon"><CheckCircle2 size={27} /></div>
                <div className="ff-onboarding-heading" style={{ marginBottom: 16 }}>
                  <h1>You are ready to fill forms</h1>
                  <p>Your vault has {selectedFiles.length || documents.length} documents and a set of reviewable values. Open a form in Chrome and launch FormFlow to fill fields with full control.</p>
                </div>
                <div className="ff-extension-steps" style={{ textAlign: 'left' }}>
                  <div className="ff-extension-step"><ShieldCheck size={18} className="ff-primary" /><h3>Review first</h3><p>Every field is a suggestion until you approve it.</p></div>
                  <div className="ff-extension-step"><LockKeyhole size={18} className="ff-primary" /><h3>Stay in control</h3><p>Sensitive identity fields require an extra review.</p></div>
                  <div className="ff-extension-step"><Download size={18} className="ff-primary" /><h3>Files stay yours</h3><p>FormFlow does not claim ownership of your originals.</p></div>
                </div>
                <div className="ff-onboarding-actions" style={{ justifyContent: 'center', marginTop: 24 }}>
                  <Button variant="primary" size="lg" icon={ArrowRight} onClick={next}>Go to dashboard</Button>
                </div>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
