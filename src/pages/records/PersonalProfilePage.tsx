import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, ArrowRight, CheckCircle2, FileText, MapPin, Plus, ShieldCheck, Sparkles, UserRound } from 'lucide-react';
import { PageHeader } from '@/components/ui/PageHeader';
import { Card, CardHeader } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { ConfirmDialog, Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { FieldTable } from '@/components/records/FieldTable';
import { FieldEditorDialog } from '@/components/records/FieldEditorDialog';
import { useApp } from '@/context/AppContext';
import type { VaultField } from '@/services/types';

export function PersonalProfilePage() {
  const { user, fields, documents, addField, updateField, deleteField, resolveConflict, dataLoading } = useApp();
  const navigate = useNavigate();
  const [selected, setSelected] = useState<VaultField | null>(null);
  const [mode, setMode] = useState<'edit' | 'resolve'>('edit');
  const [deleteTarget, setDeleteTarget] = useState<VaultField | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [newField, setNewField] = useState({ label: '', key: '', value: '', category: 'personal' as VaultField['category'] });
  const [adding, setAdding] = useState(false);

  const personal = fields.filter((field) => field.category === 'personal');
  const contact = fields.filter((field) => field.category === 'contact');
  const identity = fields.filter((field) => field.category === 'identification');
  const conflicts = fields.filter((field) => field.conflicts?.length);
  const totalFields = personal.length + contact.length;
  const personalComplete = totalFields > 0 ? Math.round((totalFields / Math.max(1, totalFields)) * 100) : 0;
  const sourceDocNames = Array.from(new Set(fields.map((field) => field.source.documentName).filter(Boolean)));

  const openEdit = (field: VaultField) => {
    setSelected(field);
    setMode('edit');
    setEditorOpen(true);
  };
  const openResolve = (field: VaultField) => {
    setSelected(field);
    setMode('resolve');
    setEditorOpen(true);
  };

  const handleAddField = async () => {
    if (!newField.label.trim() || !newField.value.trim()) return;
    setAdding(true);
    try {
      const fieldKey = newField.key.trim() || `${newField.category}.${newField.label.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
      await addField({
        label: newField.label.trim(),
        key: fieldKey,
        value: newField.value.trim(),
        normalizedValue: newField.value.trim(),
        category: newField.category,
        confidence: 100,
        verificationStatus: 'user_verified',
        sensitive: newField.category === 'identification',
        source: { documentId: 'manual', documentName: 'User entered' },
        extractedAt: new Date().toISOString(),
        lastUpdatedAt: new Date().toISOString(),
      });
      setNewField({ label: '', key: '', value: '', category: 'personal' });
      setAddOpen(false);
    } finally {
      setAdding(false);
    }
  };

  return (
    <div>
      <PageHeader
        eyebrow={<>My information <span>›</span> Personal profile</>}
        title="Personal Profile"
        description="Review the identity and contact values FormFlow may suggest when you fill a form."
        actions={
          <>
            <Button icon={Plus} onClick={() => setAddOpen(true)}>Add value</Button>
            <Button icon={MapPin} onClick={() => navigate('/records/addresses')}>View addresses</Button>
          </>
        }
      />

      <div className="ff-record-layout">
        <div className="ff-record-stack">
          <Card className="ff-section-card">
            <div className="ff-profile-editor">
              <div className="ff-avatar">{user?.avatarInitials ?? (user?.name ? user.name[0]?.toUpperCase() : 'U')}</div>
              <div style={{ flex: 1 }}>
                <div className="ff-h2">{user?.name ?? 'Personal Information'}</div>
                <div className="ff-body-sm ff-muted">{user?.email || 'Authenticated vault profile'}</div>
                {user ? (
                  <div className="ff-row ff-gap-4 ff-mt-4">
                    <Badge tone="success">Active workspace</Badge>
                    <span className="ff-code ff-muted">ID: {user.id}</span>
                  </div>
                ) : null}
              </div>
            </div>
          </Card>

          {fields.length === 0 && !dataLoading ? (
            <Card className="ff-section-card" style={{ padding: '40px 24px', textAlign: 'center' }}>
              <div style={{ display: 'inline-flex', padding: 14, borderRadius: '50%', background: 'var(--ff-surface-subtle)', marginBottom: 16 }}>
                <UserRound size={28} className="ff-primary" />
              </div>
              <div className="ff-h3">No extracted personal information</div>
              <p className="ff-body-sm ff-muted" style={{ maxWidth: 440, margin: '8px auto 20px', lineHeight: 1.5 }}>
                Your personal information will appear here once FormFlow processes your documents. Connect your documents or add values manually to enable intelligent form filling.
              </p>
              <div className="ff-row ff-gap-8" style={{ justifyContent: 'center' }}>
                <Button variant="primary" icon={FileText} onClick={() => navigate('/documents?upload=1')}>Connect Documents</Button>
                <Button icon={Plus} onClick={() => setAddOpen(true)}>Add Information</Button>
              </div>
            </Card>
          ) : (
            <>
              <Card>
                <CardHeader title="Personal information" subtitle={`${personal.length} extracted values · source attribution enabled`} action={<span className="ff-code ff-muted">{personalComplete}% complete</span>} />
                <div style={{ padding: '0 16px 16px' }}>
                  {dataLoading ? <div className="ff-spinner" /> : <FieldTable fields={personal} onEdit={openEdit} onDelete={setDeleteTarget} onResolve={openResolve} emptyLabel="No personal values extracted yet. Upload a document or add a value." />}
                </div>
              </Card>

              <Card>
                <CardHeader
                  title="Contact information"
                  subtitle={`${contact.length} values · addresses and phone`}
                  action={<button type="button" className="ff-link-button" style={{ color: 'var(--ff-primary)' }} onClick={() => navigate('/records/addresses')}>Manage addresses <ArrowRight size={12} /></button>}
                />
                <div style={{ padding: '0 16px 16px' }}>
                  {dataLoading ? <div className="ff-spinner" /> : <FieldTable fields={contact} onEdit={openEdit} onDelete={setDeleteTarget} onResolve={openResolve} emptyLabel="No contact values extracted yet." />}
                </div>
              </Card>

              <Card>
                <CardHeader title="Identification" subtitle="Sensitive values are never autofilled without explicit review." action={<Badge tone="warning">Extra review</Badge>} />
                <div style={{ padding: '0 16px 16px' }}>
                  {dataLoading ? <div className="ff-spinner" /> : <FieldTable fields={identity} onEdit={openEdit} onDelete={setDeleteTarget} onResolve={openResolve} emptyLabel="No identification values extracted yet." />}
                </div>
              </Card>
            </>
          )}
        </div>

        <div className="ff-dashboard-col" style={{ position: 'sticky', top: 72 }}>
          <Card className="ff-section-card">
            <div className="ff-row ff-gap-8"><ShieldCheck size={17} className="ff-primary" /><span className="ff-h3">Vault health</span></div>
            <div className="ff-stack ff-gap-8 ff-mt-16">
              <div className="ff-info-pair"><span>Values extracted</span><span>{fields.length}</span></div>
              <div className="ff-info-pair"><span>Source documents</span><span>{documents.filter((doc) => doc.status === 'processed' || doc.status === 'completed').length}</span></div>
              <div className="ff-info-pair"><span>Conflicts to resolve</span><span style={{ color: conflicts.length ? 'var(--ff-warning)' : 'var(--ff-success)' }}>{conflicts.length}</span></div>
              <div className="ff-info-pair"><span>Sensitive fields</span><span>{fields.filter((field) => field.sensitive).length}</span></div>
            </div>
            <div className="ff-mt-16">
              <div className="ff-progress"><div className="ff-progress__bar" style={{ width: `${personalComplete}%` }} /></div>
              <div className="ff-body-sm ff-muted ff-mt-8">
                {totalFields > 0 ? 'Personal and contact values are ready for autofill review.' : 'Upload documents to populate and verify your personal values.'}
              </div>
            </div>
          </Card>

          {conflicts.length ? (
            <Card className="ff-section-card" style={{ borderColor: '#fde68a' }}>
              <div className="ff-row ff-gap-8"><AlertTriangle size={17} style={{ color: 'var(--ff-warning)' }} /><span className="ff-h3">Needs your decision</span></div>
              <p className="ff-body-sm ff-muted ff-mt-8">Two documents disagree on at least one value. FormFlow will not pick one silently.</p>
              <div className="ff-stack ff-gap-8 ff-mt-12">
                {conflicts.map((field) => (
                  <button key={field.id} type="button" className="ff-source-option" onClick={() => openResolve(field)}>
                    <span className="ff-linked-record__icon"><AlertTriangle size={14} /></span>
                    <span style={{ flex: 1, textAlign: 'left' }}>
                      <span className="ff-label">{field.label}</span>
                      <span className="ff-body-sm ff-muted" style={{ display: 'block' }}>{field.conflicts?.length} conflicting source</span>
                    </span>
                    <ArrowRight size={14} className="ff-muted" />
                  </button>
                ))}
              </div>
            </Card>
          ) : (
            <Card className="ff-section-card">
              <div className="ff-row ff-gap-8"><CheckCircle2 size={17} style={{ color: 'var(--ff-success)' }} /><span className="ff-h3">No conflicts</span></div>
              <p className="ff-body-sm ff-muted ff-mt-8">All current values agree across your connected documents.</p>
            </Card>
          )}

          <Card className="ff-section-card">
            <div className="ff-row ff-gap-8"><Sparkles size={17} className="ff-primary" /><span className="ff-h3">How sources work</span></div>
            <p className="ff-body-sm ff-muted ff-mt-8">Each value keeps a link to the document it came from. You can inspect or change the source at any time.</p>
            {sourceDocNames.length > 0 ? (
              <div className="ff-stack ff-gap-6 ff-mt-12">
                {sourceDocNames.slice(0, 3).map((name) => (
                  <div className="ff-row ff-gap-6 ff-body-sm" key={name}><FileText size={13} className="ff-muted" /><span className="ff-truncate">{name}</span></div>
                ))}
              </div>
            ) : (
              <div className="ff-body-sm ff-muted ff-mt-12" style={{ fontStyle: 'italic' }}>
                No source documents linked yet.
              </div>
            )}
          </Card>

          <div className="ff-note" style={{ display: 'flex', gap: 8 }}>
            <UserRound size={15} style={{ flex: '0 0 auto', color: 'var(--ff-primary)' }} />
            <span>FormFlow stores extracted values separately from your original documents. Deleting a value does not change the source file.</span>
          </div>
        </div>
      </div>

      <FieldEditorDialog
        field={selected}
        mode={mode}
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        onSave={async (value) => {
          if (!selected) return;
          if (mode === 'resolve') await resolveConflict(selected.id, value);
          else await updateField(selected.id, value);
        }}
        onDelete={async () => {
          if (selected) await deleteField(selected.id);
        }}
      />

      <Modal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="Add personal information value"
        description="Add a value directly to your vault. Source will be marked as manually entered by you."
        footer={
          <>
            <Button onClick={() => setAddOpen(false)} disabled={adding}>Cancel</Button>
            <Button variant="primary" onClick={handleAddField} loading={adding} disabled={!newField.label.trim() || !newField.value.trim()}>
              Save value
            </Button>
          </>
        }
      >
        <div className="ff-settings-grid">
          <Input label="Field label" value={newField.label} onChange={(e) => setNewField({ ...newField, label: e.target.value })} placeholder="e.g. Full Name, Date of Birth" required />
          <Input label="Value" value={newField.value} onChange={(e) => setNewField({ ...newField, value: e.target.value })} placeholder="e.g. John Doe" required />
          <div>
            <label className="ff-field__label">Category</label>
            <select
              className="ff-input"
              value={newField.category}
              onChange={(e) => setNewField({ ...newField, category: e.target.value as VaultField['category'] })}
            >
              <option value="personal">Personal information</option>
              <option value="contact">Contact information</option>
              <option value="identification">Identification (sensitive)</option>
            </select>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title={`Remove ${deleteTarget?.label ?? 'value'}?`}
        description="This removes the value from your FormFlow vault. Your original document remains unchanged."
        confirmLabel="Remove value"
        destructive
        onConfirm={async () => {
          if (deleteTarget) await deleteField(deleteTarget.id);
          setDeleteTarget(null);
        }}
        onClose={() => setDeleteTarget(null)}
      />
    </div>
  );
}
