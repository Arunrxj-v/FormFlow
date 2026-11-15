import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Briefcase, Building2, CheckCircle2, FileText, MapPin, Pencil, Plus, Sparkles, Trash2 } from 'lucide-react';
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
import type { EmploymentRecord } from '@/services/types';

const blank: EmploymentRecord = {
  id: '',
  role: '',
  company: '',
  period: '',
  location: '',
  status: 'Current',
  skills: [],
};

export function EmploymentPage() {
  const { documents } = useApp();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [records, setRecords] = useState<EmploymentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<EmploymentRecord | null>(null);
  const [skillText, setSkillText] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<EmploymentRecord | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    recordService.listEmployment().then((next) => {
      setRecords(next);
      setSelectedId(next[0]?.id ?? null);
      setLoading(false);
    });
  }, []);

  const selected = records.find((record) => record.id === selectedId) ?? records[0] ?? null;
  const selectedDoc = documents.find((doc) => doc.id === selected?.documentId);

  const openCreate = () => { setForm({ ...blank }); setSkillText(''); };
  const openEdit = (record: EmploymentRecord) => { setForm({ ...record }); setSkillText(record.skills.join(', ')); };

  const save = async () => {
    if (!form || !form.role.trim() || !form.company.trim()) {
      toast({ tone: 'error', title: 'Role and company are required' });
      return;
    }
    setBusy(true);
    const isNew = !form.id;
    const next: EmploymentRecord = {
      ...form,
      id: form.id || `work_${Date.now()}`,
      skills: skillText.split(',').map((skill) => skill.trim()).filter(Boolean),
    };
    const saved = await recordService.saveEmployment(next);
    setRecords((current) => (isNew ? [saved, ...current] : current.map((item) => (item.id === saved.id ? saved : item))));
    setSelectedId(saved.id);
    setBusy(false);
    setForm(null);
    toast({ tone: 'success', title: isNew ? 'Employment record added' : 'Employment record updated' });
  };

  const remove = async () => {
    if (!deleteTarget) return;
    setBusy(true);
    await recordService.removeEmployment(deleteTarget.id);
    setRecords((current) => current.filter((item) => item.id !== deleteTarget.id));
    setSelectedId(records.find((item) => item.id !== deleteTarget.id)?.id ?? null);
    setBusy(false);
    setDeleteTarget(null);
    toast({ tone: 'success', title: 'Employment record removed' });
  };

  return (
    <div>
      <PageHeader
        eyebrow={<>My information <span>›</span> Employment</>}
        title="Employment History"
        description="Professional experience available to the extension when a form asks for work history."
        actions={<Button variant="primary" icon={Plus} onClick={openCreate}>Add employment</Button>}
      />

      <div className="ff-record-layout">
        <div className="ff-record-stack">
          {loading ? <Card><Skeleton height={130} /></Card> : records.length ? records.map((record, index) => {
            const doc = documents.find((item) => item.id === record.documentId);
            return (
              <Card key={record.id} className="ff-record-card" data-active={selected?.id === record.id} style={{ cursor: 'pointer' }} onClick={() => setSelectedId(record.id)}>
                <div className="ff-record-card__top">
                  <div className="ff-record-card__identity">
                    <span className="ff-record-icon"><Briefcase size={19} /></span>
                    <div style={{ minWidth: 0 }}>
                      <div className="ff-row ff-gap-4 ff-mb-4" style={{ flexWrap: 'wrap' }}>
                        <span className="ff-tag ff-uppercase" style={{ fontSize: 9 }}>Professional experience</span>
                        <Badge tone={record.status === 'Current' ? 'success' : 'neutral'}>{record.status}</Badge>
                        <span className="ff-code ff-muted">{record.period}</span>
                      </div>
                      <div className="ff-h3 ff-truncate">{record.role}</div>
                      <div className="ff-body-sm ff-muted ff-row ff-gap-4"><Building2 size={12} /> {record.company}<span className="ff-sep">·</span><MapPin size={12} /> {record.location}</div>
                    </div>
                  </div>
                  <div className="ff-row ff-gap-4" onClick={(event) => event.stopPropagation()}>
                    <IconButton icon={Pencil} label="Edit employment record" onClick={() => openEdit(record)} />
                    <IconButton icon={Trash2} label="Remove employment record" onClick={() => setDeleteTarget(record)} />
                  </div>
                </div>
                <div className="ff-row ff-gap-4 ff-mt-12" style={{ flexWrap: 'wrap' }}>
                  {record.skills.map((skill) => <span className="ff-tag" key={skill}>{skill}</span>)}
                </div>
                {doc ? (
                  <div className="ff-attachment">
                    <div className="ff-row ff-gap-8"><span className="ff-file-icon"><FileText size={15} /></span><div><div className="ff-label ff-truncate">{doc.name}</div><div className="ff-body-sm ff-muted">Source offer letter</div></div></div>
                    <IconButton icon={ArrowRight} label="Open document" size="sm" onClick={() => navigate(`/documents?doc=${doc.id}`)} />
                  </div>
                ) : null}
                <div className="ff-row ff-between ff-mt-12 ff-body-sm ff-muted" style={{ fontSize: 10 }}>
                  <span className="ff-row ff-gap-4"><CheckCircle2 size={12} style={{ color: 'var(--ff-success)' }} /> Confirmed by you</span>
                  <span className="ff-code">Row #{String(index + 1).padStart(2, '0')}</span>
                </div>
              </Card>
            );
          }) : <Card><EmptyState icon={Briefcase} title="No employment records" description="Add a role to make work-history fields available." action={<Button variant="primary" icon={Plus} onClick={openCreate}>Add employment</Button>} /></Card>}
        </div>

        <div className="ff-dashboard-col" style={{ position: 'sticky', top: 72 }}>
          {selected ? (
            <Card className="ff-inspector-panel">
              <div className="ff-row ff-gap-6 ff-mb-12"><Sparkles size={16} className="ff-primary" /><span className="ff-h3">Employment inspector</span></div>
              <div className="ff-meta-block ff-mb-12">
                <div className="ff-label">{selected.role}</div>
                <div className="ff-body-sm ff-muted">{selected.company} · {selected.location}</div>
              </div>
              <div className="ff-kv-row"><span className="ff-kv-row__key">Period</span><span className="ff-kv-row__value">{selected.period}</span></div>
              <div className="ff-kv-row"><span className="ff-kv-row__key">Status</span><span className="ff-kv-row__value">{selected.status}</span></div>
              <div className="ff-kv-row"><span className="ff-kv-row__key">Source document</span><span className="ff-kv-row__value ff-truncate">{selectedDoc?.name ?? 'Manual entry'}</span></div>
              <div className="ff-kv-row"><span className="ff-kv-row__key">Autofill tag</span><span className="ff-code ff-tag">work.experience.current</span></div>
              <div className="ff-mt-16">
                <div className="ff-uppercase ff-mb-8" style={{ fontSize: 9 }}>Skills from this role</div>
                <div className="ff-row ff-gap-4" style={{ flexWrap: 'wrap' }}>{selected.skills.map((skill) => <span className="ff-tag" key={skill}>{skill}</span>)}</div>
              </div>
              <div className="ff-note ff-mt-16">Work-history values are marked as user-confirmed and are never submitted automatically.</div>
              <Button fullWidth className="ff-mt-12" variant="danger" icon={Trash2} onClick={() => setDeleteTarget(selected)}>Remove this record</Button>
            </Card>
          ) : null}
        </div>
      </div>

      <Modal
        open={Boolean(form)}
        onClose={() => setForm(null)}
        title={form?.id ? 'Edit employment record' : 'Add employment record'}
        description="Stored in your personal vault."
        footer={<><Button onClick={() => setForm(null)} disabled={busy}>Cancel</Button><Button variant="primary" onClick={save} loading={busy}>Save record</Button></>}
      >
        {form ? (
          <div className="ff-settings-grid">
            <Input label="Role / title" value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value })} placeholder="Software Engineer" />
            <Input label="Company" value={form.company} onChange={(event) => setForm({ ...form, company: event.target.value })} placeholder="Northstar Labs" />
            <Input label="Period" value={form.period} onChange={(event) => setForm({ ...form, period: event.target.value })} placeholder="Jul 2025 – present" />
            <Input label="Location" value={form.location} onChange={(event) => setForm({ ...form, location: event.target.value })} placeholder="Bengaluru, India" />
            <Input label="Skills (comma separated)" value={skillText} onChange={(event) => setSkillText(event.target.value)} placeholder="TypeScript, React, PostgreSQL" />
          </div>
        ) : null}
      </Modal>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="Remove this employment record?"
        description="This removes the role from your vault. Linked documents remain available."
        confirmLabel="Remove record"
        destructive
        loading={busy}
        onConfirm={remove}
        onClose={() => setDeleteTarget(null)}
      />
    </div>
  );
}
