import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  Check,
  CheckCircle2,
  Chrome,
  Clipboard,
  ExternalLink,
  FileCheck2,
  FileText,
  Globe2,
  LockKeyhole,
  MousePointerClick,
  PlugZap,
  ShieldCheck,
  Sparkles,
  ToggleRight,
} from 'lucide-react';
import { PageHeader } from '@/components/ui/PageHeader';
import { Card, CardHeader } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { useApp } from '@/context/AppContext';
import { useToast } from '@/context/ToastContext';
import { cn } from '@/utils/cn';

const steps = [
  {
    icon: Chrome,
    title: 'Load the unpacked extension',
    body: 'Open chrome://extensions, enable Developer mode, choose Load unpacked, and select the generated extension/dist folder.',
    code: 'npm run build:extension',
  },
  {
    icon: PlugZap,
    title: 'Open the extension dashboard',
    body: 'Create or unlock the encrypted vault in the extension-owned dashboard. The popup reads the same vault through controlled extension messaging.',
    code: 'chrome-extension://<extension-id>/dashboard.html',
  },
  {
    icon: MousePointerClick,
    title: 'Review before you fill',
    body: 'Open any supported form, invoke the extension, review every suggested field, and approve the fill. The content script never receives the whole vault.',
    code: 'Toolbar icon',
  },
];

export function ExtensionSetupPage() {
  const { user, documents, fields, vaultStatus } = useApp();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [copied, setCopied] = useState<string | null>(null);
  const [previewState, setPreviewState] = useState<'detected' | 'review' | 'complete'>('detected');

  const copy = async (text: string) => {
    await navigator.clipboard?.writeText(text);
    setCopied(text);
    toast({ tone: 'success', title: 'Copied to clipboard' });
    window.setTimeout(() => setCopied(null), 1600);
  };

  const processed = documents.filter((doc) => doc.status === 'stored' || doc.status === 'completed');

  return (
    <div>
      <PageHeader
        eyebrow={<>Integrations <span>›</span> Chrome extension</>}
        title="Chrome Extension"
        description="FormFlow detects forms only when you invoke it, suggests values from your vault, and waits for approval before filling."
        actions={
          <>
            <Badge tone={vaultStatus?.unlocked ? 'success' : 'warning'}>{vaultStatus?.unlocked ? 'Vault unlocked' : 'Vault locked'}</Badge>
            <Button variant="primary" icon={ArrowRight} onClick={() => navigate('/demo-form')}>Open test form</Button>
          </>
        }
      />

      <div className="ff-extension-layout">
        <div className="ff-extension-main">
          <Card className="ff-extension-hero">
            <div className="ff-extension-hero__copy">
              <div className="ff-row ff-gap-6 ff-mb-8"><span className={`ff-status-dot ${vaultStatus?.unlocked ? 'is-online' : ''}`} /><span className="ff-code">{vaultStatus?.unlocked ? 'EXTENSION VAULT UNLOCKED' : 'EXTENSION VAULT LOCKED'}</span></div>
              <h2 className="ff-h2">Your vault, one click away from any form.</h2>
              <p className="ff-body-sm ff-muted ff-mt-8">The bundled Manifest V3 extension reads field labels on the active tab, matches them against your collection, and shows a review panel. Nothing is submitted automatically.</p>
              <div className="ff-row ff-gap-8 ff-mt-16" style={{ flexWrap: 'wrap' }}>
                <Button variant="primary" icon={ExternalLink} onClick={() => navigate('/demo-form')}>Test autofill review</Button>
                <Button icon={Clipboard} onClick={() => copy('chrome://extensions')}>Copy extensions URL</Button>
              </div>
            </div>
            <div className="ff-extension-hero__art" aria-hidden="true">
              <div className="ff-extension-mini">
                <div className="ff-extension-mini__bar"><span /><span /><span /></div>
                <div className="ff-extension-mini__body">
                  <div className="ff-extension-mini__brand"><span className="ff-mini-logo">F</span> FormFlow <span className="ff-pill ff-pill--tiny">3 matched</span></div>
                  <div className="ff-extension-mini__field"><span>Full name</span><strong>{user?.name ?? 'Alex Morgan'}</strong></div>
                  <div className="ff-extension-mini__field"><span>Email</span><strong>{user?.email ?? 'alex@example.com'}</strong></div>
                  <div className="ff-extension-mini__field"><span>Degree</span><strong>B.Tech / Bachelor's</strong></div>
                  <div className="ff-extension-mini__cta">Review &amp; fill</div>
                </div>
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader title="Install in three steps" subtitle="The extension is built locally from this repository; it is not published to the Chrome Web Store." action={<Badge tone="primary">MV3</Badge>} />
            <div className="ff-extension-steps">
              {steps.map((step, index) => {
                const Icon = step.icon;
                return (
                  <div className="ff-extension-step" key={step.title}>
                    <span className="ff-extension-step__number">0{index + 1}</span>
                    <span className="ff-extension-step__icon"><Icon size={18} /></span>
                    <div className="ff-extension-step__title">{step.title}</div>
                    <p className="ff-body-sm ff-muted">{step.body}</p>
                    <button type="button" className="ff-command" onClick={() => copy(step.code)}>
                      <span>{step.code}</span>
                      {copied === step.code ? <Check size={13} /> : <Clipboard size={13} />}
                    </button>
                  </div>
                );
              })}
            </div>
            <div className="ff-note" style={{ margin: '0 16px 16px' }}>
              <strong>Build output:</strong> <span className="ff-code">extension/dist</span> · Load that folder as an unpacked extension. Reload it after rebuilding.
            </div>
          </Card>

          <Card>
            <CardHeader title="Extension states" subtitle="Every state is represented in the popup and on active forms." action={<span className="ff-code ff-muted">{previewState}</span>} />
            <div style={{ padding: '0 16px 16px' }}>
              <div className="ff-tabs ff-mb-12" role="tablist" aria-label="Extension preview state">
                {(['detected', 'review', 'complete'] as const).map((state) => (
                  <button key={state} type="button" className="ff-tab" data-active={previewState === state} onClick={() => setPreviewState(state)}>
                    {state === 'detected' ? 'Form detected' : state === 'review' ? 'Suggestions' : 'Completed'}
                  </button>
                ))}
              </div>
              <div className="ff-popup-preview">
                <div className="ff-popup-preview__head">
                  <span className="ff-popup-preview__logo">F</span>
                  <div><div className="ff-label">FormFlow</div><div className="ff-body-sm ff-muted">{previewState === 'complete' ? 'Autofill complete' : 'Review suggestions'}</div></div>
                  <Badge tone={previewState === 'complete' ? 'success' : 'primary'}>{previewState === 'complete' ? 'Filled' : 'Needs review'}</Badge>
                </div>
                <div className="ff-popup-preview__url"><Globe2 size={12} /><span>admissions.example.edu/apply</span></div>
                {previewState === 'detected' ? (
                  <div className="ff-popup-preview__body">
                    <div className="ff-popup-preview__icon"><FileCheck2 size={22} /></div>
                    <div className="ff-label">Application form detected</div>
                    <p className="ff-body-sm ff-muted">14 fields · 11 matched from “University applications”. Sensitive fields require review.</p>
                    <Button fullWidth variant="primary" icon={Sparkles} onClick={() => setPreviewState('review')}>Review suggestions</Button>
                  </div>
                ) : previewState === 'review' ? (
                  <div className="ff-popup-preview__body">
                    {[
                      { label: 'Full name', value: user?.name ?? 'Alex Morgan', source: 'Personal vault' },
                      { label: 'Degree', value: 'B.Tech / Bachelor', source: 'Academic record' },
                      { label: 'Phone number', value: 'Verified value', source: 'Contact info' },
                    ].map((row) => (
                      <div className="ff-popup-preview__row" key={row.label}>
                        <span><span className="ff-body-sm ff-muted">{row.label}</span><strong>{row.value}</strong></span>
                        <span className="ff-code ff-muted">{row.source}</span>
                      </div>
                    ))}
                    <Button fullWidth variant="primary" icon={CheckCircle2} onClick={() => setPreviewState('complete')}>Approve selected fields</Button>
                  </div>
                ) : (
                  <div className="ff-popup-preview__body">
                    <div className="ff-popup-preview__icon is-success"><CheckCircle2 size={24} /></div>
                    <div className="ff-label">11 of 14 fields filled</div>
                    <p className="ff-body-sm ff-muted">3 fields skipped for review. The form was not submitted.</p>
                    <Button fullWidth onClick={() => setPreviewState('detected')}>Reset preview</Button>
                  </div>
                )}
              </div>
            </div>
          </Card>
        </div>

        <div className="ff-dashboard-col">
          <Card className="ff-section-card">
            <div className="ff-row ff-between"><div className="ff-row ff-gap-8"><PlugZap size={17} className="ff-primary" /><span className="ff-h3">Extension vault</span></div><span className={cn('ff-status-dot', vaultStatus?.unlocked && 'is-online')} /></div>
            <div className="ff-stack ff-gap-8 ff-mt-12">
              <div className="ff-info-pair"><span>Dashboard origin</span><span>{typeof window !== 'undefined' && window.location.protocol === 'chrome-extension:' ? 'chrome-extension://' : 'localhost (development)'}</span></div>
              <div className="ff-info-pair"><span>Vault</span><span>{vaultStatus?.unlocked ? 'Unlocked' : 'Locked'}</span></div>
              <div className="ff-info-pair"><span>Encryption</span><span>{vaultStatus?.encrypted ? 'AES-256-GCM' : 'Not enabled'}</span></div>
              <div className="ff-info-pair"><span>Open popup</span><span className="ff-code">Toolbar icon</span></div>
            </div>
            <div className="ff-note ff-mt-12">The popup and dashboard use the same extension-owned vault. Content scripts never receive the full vault.</div>
          </Card>

          <Card className="ff-section-card">
            <div className="ff-row ff-gap-8"><FileText size={17} className="ff-primary" /><span className="ff-h3">Vault readiness</span></div>
            <div className="ff-stack ff-gap-8 ff-mt-12">
              <div className="ff-info-pair"><span>Processed documents</span><span>{processed.length}</span></div>
              <div className="ff-info-pair"><span>Extracted values</span><span>{fields.length}</span></div>
              <div className="ff-info-pair"><span>Vault owner</span><span>Extension origin</span></div>
              <div className="ff-info-pair"><span>Conflicts</span><span>{fields.filter((field) => field.conflicts?.length).length}</span></div>
            </div>
            <Button fullWidth className="ff-mt-12" onClick={() => navigate('/collections')}>Manage collections</Button>
          </Card>

          <Card className="ff-section-card">
            <div className="ff-row ff-gap-8"><ShieldCheck size={17} style={{ color: 'var(--ff-success)' }} /><span className="ff-h3">Safety guarantees</span></div>
            <div className="ff-stack ff-gap-8 ff-mt-12">
              {[
                'Detection runs only on the active tab after you click.',
                'Sensitive fields always need explicit approval.',
                'The vault key stays in the browser session.',
                'FormFlow never clicks submit.',
              ].map((item) => (
                <div className="ff-row ff-gap-6 ff-body-sm" key={item}><CheckCircle2 size={13} style={{ flex: '0 0 auto', color: 'var(--ff-success)' }} /><span>{item}</span></div>
              ))}
            </div>
          </Card>

          <div className="ff-note" style={{ display: 'flex', gap: 8 }}>
            <LockKeyhole size={15} style={{ flex: '0 0 auto', color: 'var(--ff-primary)' }} />
            <span>Host access is restricted to the active tab. The extension does not request broad “read all sites” permissions.</span>
          </div>
        </div>
      </div>
    </div>
  );
}
