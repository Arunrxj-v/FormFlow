import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronLeft,
  FileCheck2,
  FileText,
  Globe2,
  LockKeyhole,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  WandSparkles,
} from 'lucide-react';
import { PageHeader } from '@/components/ui/PageHeader';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Switch } from '@/components/ui/Switch';
import { useApp } from '@/context/AppContext';
import { useToast } from '@/context/ToastContext';
import { collectionService } from '@/services/collectionService';
import type { Collection, VaultField } from '@/services/types';
import { cn } from '@/utils/cn';

type FormValues = Record<string, string>;

const fields = [
  { key: 'personal.fullName', formKey: 'fullName', label: 'Full name', type: 'text', required: true, section: 'Personal details' },
  { key: 'personal.firstName', formKey: 'firstName', label: 'First name', type: 'text', required: true, section: 'Personal details' },
  { key: 'personal.lastName', formKey: 'lastName', label: 'Last name', type: 'text', required: true, section: 'Personal details' },
  { key: 'contact.email', formKey: 'email', label: 'Email address', type: 'email', required: true, section: 'Personal details' },
  { key: 'contact.phone', formKey: 'phone', label: 'Phone number', type: 'tel', required: true, section: 'Personal details' },
  { key: 'personal.dateOfBirth', formKey: 'dob', label: 'Date of birth', type: 'text', required: false, section: 'Personal details', sensitive: true },
  { key: 'personal.nationality', formKey: 'nationality', label: 'Nationality', type: 'text', required: false, section: 'Personal details' },
  { key: 'contact.addressLine1', formKey: 'address', label: 'Address line 1', type: 'text', required: true, section: 'Address' },
  { key: 'contact.city', formKey: 'city', label: 'City', type: 'text', required: true, section: 'Address' },
  { key: 'contact.state', formKey: 'state', label: 'State', type: 'text', required: false, section: 'Address' },
  { key: 'contact.postalCode', formKey: 'postal', label: 'Postal code', type: 'text', required: true, section: 'Address' },
  { key: 'contact.country', formKey: 'country', label: 'Country', type: 'text', required: true, section: 'Address' },
  { key: 'education.degree', formKey: 'degree', label: 'Degree / qualification', type: 'text', required: true, section: 'Academic background' },
  { key: 'education.university', formKey: 'university', label: 'University / board', type: 'text', required: true, section: 'Academic background' },
  { key: 'education.registrationNumber', formKey: 'registration', label: 'Registration number', type: 'text', required: false, section: 'Academic background', sensitive: true },
  { key: 'education.graduationYear', formKey: 'graduationYear', label: 'Graduation year', type: 'text', required: false, section: 'Academic background' },
  { key: 'education.cgpa', formKey: 'cgpa', label: 'CGPA / percentage', type: 'text', required: false, section: 'Academic background' },
  { key: 'employment.employer', formKey: 'employer', label: 'Current employer', type: 'text', required: false, section: 'Professional experience' },
  { key: 'employment.jobTitle', formKey: 'jobTitle', label: 'Job title', type: 'text', required: false, section: 'Professional experience' },
  { key: 'other.skills', formKey: 'skills', label: 'Professional skills', type: 'text', required: false, section: 'Professional experience' },
];

const sections = ['Personal details', 'Address', 'Academic background', 'Professional experience'];

export function DemoFormPage() {
  const { fields: vaultFields, documents } = useApp();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [values, setValues] = useState<FormValues>({});
  const [collections, setCollections] = useState<Collection[]>([]);
  const [collectionId, setCollectionId] = useState('');
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [sensitiveApproved, setSensitiveApproved] = useState(false);
  const [filled, setFilled] = useState<string[]>([]);
  const [submitted, setSubmitted] = useState(false);
  const [panelState, setPanelState] = useState<'detected' | 'review' | 'complete'>('detected');
  const [draft, setDraft] = useState('');

  useEffect(() => {
    collectionService.list().then((next) => {
      setCollections(next);
      setCollectionId(next[0]?.id ?? '');
    });
  }, []);

  const collection = collections.find((item) => item.id === collectionId);
  const scopedFields = useMemo(() => {
    if (!collection) return vaultFields;
    return vaultFields.filter((field) => collection.documentIds.includes(field.source.documentId));
  }, [collection, vaultFields]);

  const matches = useMemo(() => fields.map((definition) => {
    const field = scopedFields.find((item) => item.key === definition.key);
    return field ? { definition, field } : null;
  }).filter((match): match is { definition: typeof fields[number]; field: VaultField } => Boolean(match)), [scopedFields]);

  useEffect(() => {
    setSelectedKeys(matches.filter((match) => !match.field.conflicts?.length).map((match) => match.definition.formKey));
    setPanelState(matches.length ? 'detected' : 'detected');
    setFilled([]);
  }, [collectionId, matches]);

  const selectedMatches = matches.filter((match) => selectedKeys.includes(match.definition.formKey));
  const sensitiveSelected = selectedMatches.some((match) => match.definition.sensitive || match.field.sensitive);
  const conflictCount = matches.filter((match) => match.field.conflicts?.length).length;

  const toggle = (formKey: string) => {
    setSelectedKeys((current) => current.includes(formKey) ? current.filter((key) => key !== formKey) : [...current, formKey]);
  };

  const fill = () => {
    if (sensitiveSelected && !sensitiveApproved) {
      toast({ tone: 'error', title: 'Review sensitive fields first', message: 'Confirm that you reviewed sensitive values before filling.' });
      return;
    }
    const next = { ...values };
    selectedMatches.forEach((match) => { next[match.definition.formKey] = match.field.value; });
    setValues(next);
    setFilled(selectedMatches.map((match) => match.definition.formKey));
    setPanelState('complete');
    toast({ tone: 'success', title: `${selectedMatches.length} fields filled`, message: 'Nothing was submitted. Review the form and submit yourself.' });
  };

  const generateDraft = () => {
    const value = (key: string) => scopedFields.find((field) => field.key === key)?.value;
    const degree = value('education.degree');
    const university = value('education.university');
    const year = value('education.graduationYear');
    const cgpa = value('education.cgpa');
    const employer = value('employment.employer');
    const title = value('employment.jobTitle');
    const skills = value('other.skills');
    if (!degree) {
      toast({ tone: 'error', title: 'Not enough source information', message: 'Add education details to your vault before generating a draft.' });
      return;
    }
    const parts = [
      `I hold a ${degree}${university ? ` from ${university}` : ''}${year ? `, completed in ${year}` : ''}${cgpa ? ` with a CGPA of ${cgpa}` : ''}.`,
      employer && title ? `I currently work as a ${title} at ${employer}.` : '',
      skills ? `My technical toolkit includes ${skills}.` : '',
      'I am interested in applying this background to a role where I can keep learning and contribute to practical, reliable systems.',
    ].filter(Boolean);
    setDraft(parts.join(' '));
    setValues((current) => ({ ...current, motivation: parts.join(' ') }));
    toast({ tone: 'success', title: 'Grounded draft generated', message: 'Built only from values in the selected collection. Edit before submitting.' });
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const missing = fields.filter((field) => field.required && !values[field.formKey]);
    if (missing.length) {
      toast({ tone: 'error', title: 'Complete required fields', message: missing.map((field) => field.label).join(', ') });
      return;
    }
    setSubmitted(true);
    toast({ tone: 'success', title: 'Demo form submitted locally', message: 'No data left this browser and no real application was filed.' });
  };

  const reset = () => {
    setValues({});
    setFilled([]);
    setDraft('');
    setSubmitted(false);
    setPanelState('detected');
    setSensitiveApproved(false);
  };

  return (
    <div>
      <PageHeader
        eyebrow={<button type="button" className="ff-link-button" onClick={() => navigate('/extension')}><ChevronLeft size={12} /> Extension</button>}
        title="Form Autofill Sandbox"
        description="A local sandbox form for testing detection, review, conflict handling, and autofill. FormFlow never submits it."
        actions={<Badge tone="primary">Sandbox</Badge>}
      />

      <div className="ff-demo-layout">
        <Card className="ff-demo-form">
          <div className="ff-demo-form__head">
            <span className="ff-company-mark">U</span>
            <div><div className="ff-h3">University Admission Portal</div><div className="ff-body-sm ff-muted">admissions.example.edu/apply · postgraduate intake</div></div>
            <Badge tone="primary">Application</Badge>
          </div>
          <div className="ff-demo-form__url"><Globe2 size={12} /> admissions.example.edu/apply</div>

          {submitted ? (
            <div className="ff-demo-success">
              <span className="ff-popup-preview__icon is-success"><CheckCircle2 size={26} /></span>
              <div className="ff-h2">Application captured locally</div>
              <p className="ff-body-sm ff-muted">Form filled and captured locally in sandbox mode. No real university application was created.</p>
              <div className="ff-row ff-gap-8"><Button onClick={reset} icon={RotateCcw}>Reset form</Button><Button variant="primary" onClick={() => navigate('/history')}>View form history</Button></div>
            </div>
          ) : (
            <form onSubmit={submit}>
              {sections.map((section) => (
                <fieldset className="ff-demo-fieldset" key={section}>
                  <legend>{section}</legend>
                  <div className="ff-demo-form__grid">
                    {fields.filter((field) => field.section === section).map((definition) => (
                      <div className={cn('ff-field', definition.type === 'text' && definition.formKey === 'skills' && 'ff-span-2')} key={definition.formKey}>
                        <label className="ff-field__label" htmlFor={`demo-${definition.formKey}`}>{definition.label}{definition.required ? ' *' : ''}{definition.sensitive ? <span className="ff-code ff-muted" style={{ marginLeft: 5 }}>sensitive</span> : null}</label>
                        <input
                          id={`demo-${definition.formKey}`}
                          className={cn('ff-input', filled.includes(definition.formKey) && 'is-autofilled')}
                          type={definition.type}
                          required={definition.required}
                          value={values[definition.formKey] ?? ''}
                          onChange={(event) => setValues({ ...values, [definition.formKey]: event.target.value })}
                          placeholder={`Enter ${definition.label.toLowerCase()}`}
                        />
                        {filled.includes(definition.formKey) ? <span className="ff-autofill-tag"><Check size={10} /> Filled from vault</span> : null}
                      </div>
                    ))}
                  </div>
                  {section === 'Professional experience' ? (
                    <>
                      <div className="ff-field ff-mt-12">
                        <div className="ff-row ff-between">
                          <label className="ff-field__label" htmlFor="demo-motivation">Why are you interested in this programme?</label>
                          <button type="button" className="ff-link-button" style={{ color: 'var(--ff-primary)' }} onClick={generateDraft}><WandSparkles size={12} /> Generate grounded draft</button>
                        </div>
                        <textarea id="demo-motivation" className={cn('ff-textarea', values.motivation && 'is-autofilled')} rows={4} value={values.motivation ?? draft} onChange={(event) => { setValues({ ...values, motivation: event.target.value }); setDraft(event.target.value); }} placeholder="Write your answer, or generate a draft from vault values." />
                        <span className="ff-field__hint">Drafting uses only stored education, employment, and skills values. Always edit before submitting.</span>
                      </div>
                    </>
                  ) : null}
                </fieldset>
              ))}

              <fieldset className="ff-section ff-mt-16">
                <legend className="ff-section__title">Required Document Uploads</legend>
                <p className="ff-body-sm ff-muted" style={{ marginBottom: 12 }}>
                  The FormFlow Chrome extension detects these upload targets and recommends matching verified documents from your vault.
                </p>
                <div className="ff-form-grid">
                  <div className="ff-field">
                    <label className="ff-field__label" htmlFor="degree_certificate">
                      Degree Certificate <span style={{ color: 'var(--ff-danger)' }}>*</span>
                    </label>
                    <input
                      type="file"
                      id="degree_certificate"
                      name="degree_certificate"
                      accept=".pdf"
                      className="ff-input"
                      style={{ padding: '6px 8px' }}
                    />
                    <span className="ff-field__hint">Matches academic certificates in your vault</span>
                  </div>
                  <div className="ff-field">
                    <label className="ff-field__label" htmlFor="marksheet">
                      Secondary / 10th Certificate <span style={{ color: 'var(--ff-danger)' }}>*</span>
                    </label>
                    <input
                      type="file"
                      id="marksheet"
                      name="marksheet"
                      accept=".pdf"
                      className="ff-input"
                      style={{ padding: '6px 8px' }}
                    />
                    <span className="ff-field__hint">Matches Secondary_School_CBSE_X.pdf</span>
                  </div>
                  <div className="ff-field">
                    <label className="ff-field__label" htmlFor="photo">
                      Passport Size Photograph
                    </label>
                    <input
                      type="file"
                      id="photo"
                      name="photo"
                      accept=".jpg,.jpeg,.png"
                      className="ff-input"
                      style={{ padding: '6px 8px' }}
                    />
                    <span className="ff-field__hint">Optional photograph attachment</span>
                  </div>
                </div>
              </fieldset>
              <div className="ff-row ff-between ff-mt-16" style={{ paddingTop: 16, borderTop: '1px solid var(--ff-border)' }}>
                <span className="ff-body-sm ff-muted"><LockKeyhole size={12} style={{ verticalAlign: -2 }} /> Sandbox mode · no network submission</span>
                <div className="ff-row ff-gap-8"><Button type="button" onClick={reset} icon={RotateCcw}>Reset</Button><Button type="submit" variant="primary">Submit demo form</Button></div>
              </div>
            </form>
          )}
        </Card>

        <aside className="ff-extension-panel" aria-label="FormFlow extension preview">
          <div className="ff-extension-panel__head">
            <span className="ff-popup-preview__logo">F</span>
            <div><div className="ff-label">FormFlow</div><div className="ff-body-sm ff-muted">Extension preview · local</div></div>
            <span className="ff-status-dot is-online" />
          </div>

          <div className="ff-extension-panel__scope">
            <label className="ff-field__label" htmlFor="collection-scope">Collection context</label>
            <select id="collection-scope" className="ff-select" value={collectionId} onChange={(event) => setCollectionId(event.target.value)}>
              <option value="">All vault documents</option>
              {collections.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </div>

          {panelState === 'detected' ? (
            <div className="ff-extension-panel__body">
              <div className="ff-extension-detect">
                <FileCheck2 size={22} className="ff-primary" />
                <div><div className="ff-label">Form detected</div><div className="ff-body-sm ff-muted">{matches.length} of {fields.length} fields matched · {conflictCount} conflicts</div></div>
              </div>
              <div className="ff-extension-source">
                <ShieldCheck size={14} className="ff-primary" />
                <span>Using <strong>{collection?.name ?? 'all vault documents'}</strong>. Detection only read this tab.</span>
              </div>
              <Button fullWidth variant="primary" icon={Sparkles} onClick={() => setPanelState('review')} disabled={!matches.length}>Review suggestions</Button>
              {!matches.length ? <div className="ff-note">No matching values in this collection. Choose another collection or add documents.</div> : null}
            </div>
          ) : panelState === 'review' ? (
            <div className="ff-extension-panel__body">
              <div className="ff-row ff-between ff-mb-8"><span className="ff-label">Review before filling</span><span className="ff-code ff-muted">{selectedKeys.length}/{matches.length}</span></div>
              <div className="ff-extension-review">
                {matches.map(({ definition, field }) => {
                  const conflict = Boolean(field.conflicts?.length);
                  const checked = selectedKeys.includes(definition.formKey);
                  return (
                    <button type="button" key={definition.formKey} className="ff-extension-review__row" data-selected={checked} data-disabled={conflict} aria-disabled={conflict} onClick={() => { if (!conflict) toggle(definition.formKey); }}>
                      <span className="ff-check-box">{checked ? <Check size={11} /> : null}</span>
                      <span style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                        <span className="ff-body-sm ff-muted">{definition.label}</span>
                        <strong className={cn('ff-truncate', conflict && 'ff-warning-text')}>{conflict ? 'Multiple values · needs review' : field.value}</strong>
                        <span className="ff-code ff-muted ff-truncate">{field.source.documentName} · {field.confidence}%</span>
                      </span>
                      {conflict ? <AlertTriangle size={13} style={{ color: 'var(--ff-warning)' }} /> : definition.sensitive || field.sensitive ? <LockKeyhole size={12} className="ff-muted" /> : null}
                    </button>
                  );
                })}
              </div>
              {conflictCount ? <div className="ff-note ff-mt-8" style={{ fontSize: 10 }}>Conflicts are skipped until you choose a preferred value in the vault.</div> : null}
              {sensitiveSelected ? (
                <div className="ff-extension-approval">
                  <div><div className="ff-label">Sensitive values selected</div><div className="ff-body-sm ff-muted">Confirm you reviewed date of birth or registration number.</div></div>
                  <Switch checked={sensitiveApproved} onChange={setSensitiveApproved} label="Approve sensitive fields" />
                </div>
              ) : null}
              <div className="ff-row ff-gap-6 ff-mt-12">
                <Button fullWidth onClick={() => setPanelState('detected')}>Back</Button>
                <Button fullWidth variant="primary" icon={FileCheck2} onClick={fill} disabled={!selectedKeys.length}>Fill {selectedKeys.length}</Button>
              </div>
              <div className="ff-note" style={{ fontSize: 10 }}>Autofill inserts approved values only. It never clicks submit.</div>
            </div>
          ) : (
            <div className="ff-extension-panel__body">
              <div className="ff-extension-detect">
                <CheckCircle2 size={22} style={{ color: 'var(--ff-success)' }} />
                <div><div className="ff-label">{filled.length} fields filled</div><div className="ff-body-sm ff-muted">{matches.length - filled.length} skipped · nothing submitted</div></div>
              </div>
              <div className="ff-note">Review the highlighted fields, edit anything that needs correction, then submit the demo form yourself.</div>
              <Button fullWidth icon={RotateCcw} onClick={() => setPanelState('review')}>Review again</Button>
              <div className="ff-extension-panel__foot"><FileText size={12} /> Source: {collection?.name ?? 'All documents'} · {documents.length} documents in vault</div>
            </div>
          )}

          <div className="ff-extension-panel__footer">
            <LockKeyhole size={11} /> Active tab only · no auto-submit
          </div>
        </aside>
      </div>
    </div>
  );
}
