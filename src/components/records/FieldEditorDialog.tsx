import { useEffect, useState } from 'react';
import { AlertTriangle, Check, FileText, LockKeyhole, Trash2 } from 'lucide-react';
import { Modal, ConfirmDialog } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import type { VaultField } from '@/services/types';

interface FieldEditorDialogProps {
  field: VaultField | null;
  mode: 'edit' | 'resolve';
  open: boolean;
  onClose: () => void;
  onSave: (value: string) => Promise<void>;
  onDelete: () => Promise<void>;
}

export function FieldEditorDialog({ field, mode, open, onClose, onSave, onDelete }: FieldEditorDialogProps) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (field) setValue(field.value);
  }, [field]);

  if (!field) return null;

  const save = async (nextValue = value) => {
    if (!nextValue.trim()) return;
    setBusy(true);
    await onSave(nextValue.trim());
    setBusy(false);
    onClose();
  };

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title={mode === 'resolve' ? 'Resolve conflicting value' : `Edit ${field.label.toLowerCase()}`}
        description={
          mode === 'resolve'
            ? 'Choose which source should be used for autofill. FormFlow will not decide for you.'
            : 'Editing a vault value does not alter the source document.'
        }
        footer={
          <>
            <Button onClick={onClose} disabled={busy}>Cancel</Button>
            <Button variant="primary" onClick={() => save()} loading={busy} disabled={!value.trim()} icon={Check}>Save value</Button>
          </>
        }
      >
        <div className="ff-field">
          <label className="ff-field__label" htmlFor="field-value">Value</label>
          <Input id="field-value" value={value} onChange={(event) => setValue(event.target.value)} autoFocus />
          <span className="ff-field__hint">Source: {field.source.documentName}</span>
        </div>

        {mode === 'resolve' && field.conflicts?.length ? (
          <div className="ff-mt-16">
            <div className="ff-label ff-mb-8">Choose a conflicting source</div>
            <div className="ff-stack ff-gap-8">
              <button type="button" className="ff-source-option" data-selected={value === field.value} onClick={() => setValue(field.value)}>
                <span className="ff-file-icon"><FileText size={15} /></span>
                <span style={{ flex: 1, textAlign: 'left' }}>
                  <span className="ff-label">{field.value}</span>
                  <span className="ff-body-sm ff-muted" style={{ display: 'block' }}>{field.source.documentName} · {field.confidence}% confidence</span>
                </span>
                {value === field.value ? <Check size={15} className="ff-primary" /> : null}
              </button>
              {field.conflicts.map((conflict) => (
                <button key={`${conflict.source.documentId}-${conflict.value}`} type="button" className="ff-source-option" data-selected={value === conflict.value} onClick={() => setValue(conflict.value)}>
                  <span className="ff-file-icon"><FileText size={15} /></span>
                  <span style={{ flex: 1, textAlign: 'left' }}>
                    <span className="ff-label">{conflict.value}</span>
                    <span className="ff-body-sm ff-muted" style={{ display: 'block' }}>{conflict.source.documentName} · {conflict.confidence}% confidence</span>
                  </span>
                  {value === conflict.value ? <Check size={15} className="ff-primary" /> : null}
                </button>
              ))}
            </div>
            <div className="ff-note ff-mt-12">
              <AlertTriangle size={13} style={{ verticalAlign: -2, marginRight: 4, color: 'var(--ff-warning)' }} />
              Values that conflict should be reviewed before they are used on a sensitive form.
            </div>
          </div>
        ) : null}

        <div className="ff-row ff-between ff-mt-16" style={{ paddingTop: 12, borderTop: '1px solid var(--ff-border)' }}>
          <span className="ff-row ff-gap-4 ff-body-sm ff-muted"><LockKeyhole size={12} /> {field.sensitive ? 'Sensitive field · extra review required' : 'Standard field'}</span>
          <Button variant="danger" size="sm" icon={Trash2} onClick={() => setConfirmDelete(true)}>Delete value</Button>
        </div>
      </Modal>

      <ConfirmDialog
        open={confirmDelete}
        title="Delete this vault value?"
        description="This removes the value from FormFlow only. The source document and its original contents are unchanged."
        confirmLabel="Delete value"
        destructive
        loading={busy}
        onConfirm={async () => {
          setBusy(true);
          await onDelete();
          setBusy(false);
          setConfirmDelete(false);
          onClose();
        }}
        onClose={() => setConfirmDelete(false)}
      />
    </>
  );
}
