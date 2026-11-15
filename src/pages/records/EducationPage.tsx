import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  CheckCircle2,
  Clipboard,
  Cloud,
  Download,
  FileText,
  GraduationCap,
  History,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  Zap,
} from 'lucide-react';
import { PageHeader } from '@/components/ui/PageHeader';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Modal, ConfirmDialog } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { EmptyState, Skeleton } from '@/components/ui/States';
import { useApp } from '@/context/AppContext';
import { useToast } from '@/context/ToastContext';
import { recordService } from '@/services/recordService';
import type { EducationRecord } from '@/services/types';
import { cn } from '@/utils/cn';

const blank: EducationRecord = {
  id: '',
  level: 'Tertiary / Degree',
  degree: '',
  institution: '',
  university: '',
  period: '',
  status: 'Completed',
  metrics: [],
  registrationNo: '',
  gpa: '',
  specialization: '',
  autofillTag: 'edu.degree',
  createdAt: '',
  lastSynced: '',
  sourceNote: 'Profile value entered by you. Not officially verified by an institution.',
};

export function EducationPage() {
  const { documents } = useApp();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [records, setRecords] = useState<EducationRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<EducationRecord | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<EducationRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    recordService.listEducation().then((next) => {
      setRecords(next);
      setSelectedId(next[0]?.id ?? null);
      setLoading(false);
    });
  }, []);

  const selected = records.find((record) => record.id === selectedId) ?? records[0] ?? null;
  const selectedDoc = documents.find((doc) => doc.id === selected?.documentId);

  const openCreate = () => setForm({ ...blank });
  const openEdit = (record: EducationRecord) => setForm({ ...record });

  const save = async () => {
    if (!form || !form.degree.trim() || !form.institution.trim()) {
      toast({ tone: 'error', title: 'Add a degree and institution', message: 'Degree and institution are required.' });
      return;
    }
    setBusy(true);
    const isNew = !form.id;
    const next: EducationRecord = {
      ...form,
      id: form.id || `edu_${Date.now()}`,
      createdAt: form.createdAt || new Date().toISOString().slice(0, 16).replace('T', ' '),
      lastSynced: 'Just now',
      metrics: [
        { label: 'CGPA score', value: form.gpa || '—' },
        { label: 'Registration no.', value: form.registrationNo || '—' },
        { label: 'Specialization', value: form.specialization || '—' },
      ],
    };
    const saved = await recordService.saveEducation(next);
    setRecords((current) => (isNew ? [saved, ...current] : current.map((item) => (item.id === saved.id ? saved : item))));
    setSelectedId(saved.id);
    setBusy(false);
    setForm(null);
    toast({ tone: 'success', title: isNew ? 'Education record added' : 'Education record updated', message: 'Saved to your personal vault.' });
  };

  const remove = async () => {
    if (!deleteTarget) return;
    setBusy(true);
    await recordService.removeEducation(deleteTarget.id);
    setRecords((current) => current.filter((item) => item.id !== deleteTarget.id));
    if (selectedId === deleteTarget.id) setSelectedId(records.find((item) => item.id !== deleteTarget.id)?.id ?? null);
    setBusy(false);
    setDeleteTarget(null);
    toast({ tone: 'success', title: 'Education record removed', message: 'Linked documents remain in the vault.' });
  };

  const copyRegistration = async () => {
    if (!selected) return;
    await navigator.clipboard?.writeText(selected.registrationNo);
    setCopied(true);
    toast({ tone: 'success', title: 'Registration number copied' });
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div>
      <PageHeader
        eyebrow={<>My information <span>›</span> Education</>}
        title="Education Records"
        description="Manage your academic history, degree credentials, and linked verification documents."
        actions={
          <>
            <span className="ff-pill"><CheckCircle2 size={12} style={{ color: 'var(--ff-success)' }} /> Auto-sync with extension</span>
            <Button variant="primary" icon={Plus} onClick={openCreate}>Add education record</Button>
          </>
        }
      />

      <div className="ff-record-layout">
        <div className="ff-record-stack">
          {loading ? (
            Array.from({ length: 2 }).map((_, index) => (
              <Card key={index} className="ff-section-card"><Skeleton width={150} /><Skeleton height={20} width="60%" /><div className="ff-mt-12"><Skeleton height={62} /></div></Card>
            ))
          ) : records.length ? (
            records.map((record) => {
              const doc = documents.find((item) => item.id === record.documentId);
              return (
                <Card key={record.id} className="ff-record-card" data-active={selected?.id === record.id} onClick={() => setSelectedId(record.id)} style={{ cursor: 'pointer' }}>
                  <div className="ff-record-card__top">
                    <div className="ff-record-card__identity">
                      <span className="ff-record-icon"><GraduationCap size={19} /></span>
                      <div style={{ minWidth: 0 }}>
                        <div className="ff-row ff-gap-4" style={{ flexWrap: 'wrap', marginBottom: 3 }}>
                          <span className="ff-tag ff-uppercase" style={{ fontSize: 9 }}>{record.level}</span>
                          <Badge tone={record.status === 'Completed' ? 'success' : 'primary'}>{record.status}</Badge>
                          <span className="ff-code ff-muted">{record.period}</span>
                        </div>
                        <div className="ff-h3 ff-truncate">{record.degree}</div>
                        <div className="ff-body-sm ff-muted" style={{ marginTop: 1 }}>{record.institution}{record.university ? ` (${record.university})` : ''}</div>
                      </div>
                    </div>
                    <div className="ff-row ff-gap-4" onClick={(event) => event.stopPropagation()}>
                      <IconButton icon={Pencil} label="Edit education record" onClick={() => openEdit(record)} />
                      <IconButton icon={Trash2} label="Remove education record" onClick={() => setDeleteTarget(record)} />
                    </div>
                  </div>
                  <div className="ff-record-metrics">
                    {record.metrics.slice(0, 3).map((metric) => (
                      <div key={metric.label}>
                        <div className="ff-record-metric__label">{metric.label}</div>
                        <div className="ff-record-metric__value">{metric.value}</div>
                      </div>
                    ))}
                  </div>
                  {doc ? (
                    <div className="ff-attachment">
                      <div className="ff-row ff-gap-8" style={{ minWidth: 0 }}>
                        <span className="ff-file-icon"><FileText size={15} /></span>
                        <div style={{ minWidth: 0 }}>
                          <div className="ff-label ff-truncate">{doc.name}</div>
                          <div className="ff-row ff-gap-4 ff-body-sm ff-muted"><Cloud size={11} className="ff-primary" /> Google Drive sync <span className="ff-sep">·</span> {doc.sizeLabel}</div>
                        </div>
                      </div>
                      <IconButton icon={Download} label="Download document" size="sm" onClick={() => toast({ tone: 'info', title: 'Download unavailable', message: 'Original file remains in Google Drive or local storage.' })} />
                    </div>
                  ) : null}
                  <div className="ff-row ff-between ff-mt-12 ff-body-sm ff-muted" style={{ fontSize: 10 }}>
                    <span className="ff-row ff-gap-4"><CheckCircle2 size={12} style={{ color: 'var(--ff-success)' }} /> User confirmed &amp; metadata linked</span>
                    <span className="ff-code">Row #{String(records.indexOf(record) + 1).padStart(2, '0')}</span>
                  </div>
                </Card>
              );
            })
          ) : (
            <Card><EmptyState icon={GraduationCap} title="No education records" description="Add your first academic record to make it available for form autofill." action={<Button variant="primary" icon={Plus} onClick={openCreate}>Add record</Button>} /></Card>
          )}
        </div>

        <div className="ff-dashboard-col" style={{ position: 'sticky', top: 72 }}>
          {selected ? (
            <Card className="ff-inspector-panel">
              <div className="ff-row ff-between ff-mb-12">
                <div className="ff-row ff-gap-6"><Sparkles size={16} className="ff-primary" /><span className="ff-h3">Record inspector</span></div>
                <span className="ff-tag ff-row ff-gap-4"><span style={{ width: 5, height: 5, borderRadius: 99, background: 'var(--ff-success)' }} /> Personal record</span>
              </div>
              <div className="ff-meta-block ff-mb-12">
                <div className="ff-row ff-gap-8">
                  <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30, borderRadius: 6, background: 'var(--ff-primary)', color: '#fff', fontSize: 10, fontWeight: 700 }}>CS</span>
                  <div style={{ minWidth: 0 }}>
                    <div className="ff-label ff-truncate">{selected.degree}</div>
                    <div className="ff-body-sm ff-muted ff-truncate">{selected.institution}</div>
                  </div>
                </div>
              </div>
              <div>
                <div className="ff-kv-row"><span className="ff-kv-row__key">Awarding university</span><span className="ff-kv-row__value ff-truncate">{selected.university}</span></div>
                <div className="ff-kv-row"><span className="ff-kv-row__key">Registration no.</span><span className="ff-row ff-gap-4"><span className="ff-code ff-tag">{selected.registrationNo}</span><IconButton icon={copied ? CheckCircle2 : Clipboard} label="Copy registration number" size="sm" onClick={copyRegistration} /></span></div>
                <div className="ff-kv-row"><span className="ff-kv-row__key">Degree level</span><span className="ff-kv-row__value">{selected.level}</span></div>
                <div className="ff-kv-row"><span className="ff-kv-row__key">Tenure period</span><span className="ff-kv-row__value">{selected.period}</span></div>
                <div className="ff-kv-row"><span className="ff-kv-row__key">Cumulative GPA</span><span className="ff-kv-row__value" style={{ color: 'var(--ff-primary)' }}>{selected.gpa}</span></div>
                <div className="ff-kv-row"><span className="ff-kv-row__key">Specialization</span><span className="ff-kv-row__value ff-truncate">{selected.specialization}</span></div>
                <div className="ff-kv-row"><span className="ff-kv-row__key">Autofill field tag</span><span className="ff-code ff-tag">{selected.autofillTag}</span></div>
              </div>
              <div className="ff-mt-16">
                <div className="ff-uppercase ff-mb-8" style={{ fontSize: 9 }}>Attached document</div>
                {selectedDoc ? (
                  <div className="ff-attachment" style={{ marginTop: 0 }}>
                    <div className="ff-row ff-gap-8" style={{ minWidth: 0 }}>
                      <span className="ff-file-icon"><FileText size={15} /></span>
                      <div style={{ minWidth: 0 }}>
                        <div className="ff-label ff-truncate">{selectedDoc.name}</div>
                        <div className="ff-body-sm ff-muted">{selectedDoc.sizeLabel} · source linked</div>
                      </div>
                    </div>
                    <div className="ff-row ff-gap-2">
                      <IconButton icon={Download} label="Download" size="sm" onClick={() => toast({ tone: 'info', title: 'Download unavailable' })} />
                      <IconButton icon={ArrowRight} label="Open in vault" size="sm" onClick={() => navigate(`/documents?doc=${selectedDoc.id}`)} />
                    </div>
                  </div>
                ) : <div className="ff-note">No document linked. You can attach one from the Document Vault.</div>}
              </div>
              <div className="ff-mt-16">
                <div className="ff-uppercase ff-mb-8" style={{ fontSize: 9 }}>Provenance &amp; audit</div>
                <div className="ff-audit-grid">
                  <div className="ff-audit-cell"><span>Created date</span><strong>{selected.createdAt}</strong></div>
                  <div className="ff-audit-cell"><span>Last synchronized</span><strong>{selected.lastSynced}</strong></div>
                </div>
                <div className="ff-note ff-mt-8" style={{ fontSize: 10 }}><strong>Source:</strong> {selected.sourceNote}</div>
              </div>
              <div className="ff-row ff-gap-6 ff-mt-16">
                <Button fullWidth icon={History} onClick={() => toast({ tone: 'info', title: 'Aliases mapped', message: 'Aliases mapped successfully.' })}>Map autofill aliases</Button>
                <Button variant="danger" icon={Trash2} onClick={() => setDeleteTarget(selected)} aria-label="Delete record" />
              </div>
            </Card>
          ) : null}

          <Card className="ff-section-card" style={{ background: 'var(--ff-surface-low)' }}>
            <div className="ff-row ff-between">
              <div className="ff-row ff-gap-8">
                <Zap size={18} className="ff-primary" />
                <div><div className="ff-h3">Chrome extension ready</div><div className="ff-body-sm ff-muted">{records.length} of {records.length} education nodes ready for form population.</div></div>
              </div>
              <span className="ff-kbd">Alt+E</span>
            </div>
          </Card>
        </div>
      </div>

      <Modal
        open={Boolean(form)}
        onClose={() => setForm(null)}
        title={form?.id ? 'Edit education record' : 'Add education record'}
        description="These values are stored in your personal vault."
        wide
        footer={
          <>
            <Button onClick={() => setForm(null)} disabled={busy}>Cancel</Button>
            <Button variant="primary" onClick={save} loading={busy}>Save record</Button>
          </>
        }
      >
        {form ? (
          <div className="ff-settings-grid">
            <Input label="Degree / qualification" value={form.degree} onChange={(event) => setForm({ ...form, degree: event.target.value })} placeholder="B.Tech in Computer Science" />
            <Input label="Level" value={form.level} onChange={(event) => setForm({ ...form, level: event.target.value })} placeholder="Tertiary / Degree" />
            <Input label="Institution" value={form.institution} onChange={(event) => setForm({ ...form, institution: event.target.value })} placeholder="College of Engineering Trivandrum" />
            <Input label="University / board" value={form.university} onChange={(event) => setForm({ ...form, university: event.target.value })} placeholder="APJ Abdul Kalam Technological University" />
            <Input label="Tenure period" value={form.period} onChange={(event) => setForm({ ...form, period: event.target.value })} placeholder="2021 – 2025" />
            <Input label="CGPA / percentage" value={form.gpa} onChange={(event) => setForm({ ...form, gpa: event.target.value })} placeholder="8.92 / 10.0" />
            <Input label="Registration number" value={form.registrationNo} onChange={(event) => setForm({ ...form, registrationNo: event.target.value })} placeholder="KTU21CS0482" />
            <Input label="Specialization" value={form.specialization} onChange={(event) => setForm({ ...form, specialization: event.target.value })} placeholder="Distributed Systems" />
            <Input label="Autofill field tag" value={form.autofillTag} onChange={(event) => setForm({ ...form, autofillTag: event.target.value })} placeholder="edu.degree.ug" />
          </div>
        ) : null}
      </Modal>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="Remove this education record?"
        description="This removes the record from your vault. Any linked document remains available in the Document Vault."
        confirmLabel="Remove record"
        destructive
        loading={busy}
        onConfirm={remove}
        onClose={() => setDeleteTarget(null)}
      />
    </div>
  );
}
