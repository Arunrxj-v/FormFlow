import { AlertTriangle, FileText, LockKeyhole, Pencil, ShieldCheck, Trash2 } from 'lucide-react';
import type { VaultField } from '@/services/types';
import { Badge } from '@/components/ui/Badge';
import { IconButton } from '@/components/ui/IconButton';

interface FieldTableProps {
  fields: VaultField[];
  onEdit: (field: VaultField) => void;
  onDelete: (field: VaultField) => void;
  onResolve?: (field: VaultField) => void;
  onVerify?: (field: VaultField) => void;
  emptyLabel?: string;
}

export function FieldTable({ fields, onEdit, onDelete, onResolve, onVerify, emptyLabel = 'No extracted values in this category yet.' }: FieldTableProps) {
  if (!fields.length) {
    return <div className="ff-note">{emptyLabel}</div>;
  }
  return (
    <div className="ff-field-table">
      {fields.map((field) => (
        <div className="ff-field-row" key={field.id}>
          <div className="ff-field-row__label">
            <span className="ff-row ff-gap-4">
              {field.label}
              {field.sensitive ? <LockKeyhole size={11} className="ff-subtle" aria-label="Sensitive field" /> : null}
            </span>
          </div>
          <div className="ff-field-row__value">
            <span className="ff-row ff-gap-6">
              <span className="ff-truncate" style={{ maxWidth: 320 }}>{field.value}</span>
              {field.verificationStatus === 'user_verified'
                ? <Badge tone="success">Verified</Badge>
                : <Badge tone="neutral">Extracted</Badge>}
              {field.conflicts?.length ? <Badge tone="warning">Conflict</Badge> : null}
              {field.sensitive ? <Badge tone="neutral">Sensitive</Badge> : null}
            </span>
            <div className="ff-row ff-gap-6 ff-body-sm ff-muted" style={{ marginTop: 4, flexWrap: 'wrap' }}>
              <span className="ff-source-chip" title={field.source.documentName}>
                <FileText size={12} />
                <span>{field.source.documentName}{field.source.page ? ` · page ${field.source.page}` : ''}</span>
              </span>
              {field.extractionMethod === 'ai' ? <span className="ff-code">local AI</span> : null}
              {field.source.modelVersion ? <span className="ff-code ff-muted" title="Model version used for this candidate">{field.source.modelVersion.split(':').pop()}</span> : null}
              {field.source.blockId ? <span className="ff-code ff-muted">block {field.source.blockId}</span> : null}
            </div>
            {field.source.evidence ? (
              <div className="ff-body-sm ff-muted" style={{ marginTop: 4, fontStyle: 'italic' }}>
                “{field.source.evidence.length > 180 ? `${field.source.evidence.slice(0, 180)}…` : field.source.evidence}”
              </div>
            ) : null}
            {field.conflicts?.length ? (
              <div className="ff-conflict-banner">
                <AlertTriangle size={13} />
                <span>Another document contains a different value. Review before using this field.</span>
                {onResolve ? <button type="button" onClick={() => onResolve(field)}>Resolve</button> : null}
              </div>
            ) : null}
          </div>
          <div className="ff-field-row__source">
            <span className="ff-source-chip" title={field.source.documentName}>
              <FileText size={12} />
              <span>{field.source.documentName}</span>
            </span>
          </div>
          <div className="ff-row ff-gap-6" style={{ justifyContent: 'flex-end' }}>
            <span className="ff-confidence" title="Extraction confidence">
              <span className="ff-confidence__track"><span style={{ width: `${field.confidence}%` }} /></span>
              {field.confidence}%
            </span>
            {onVerify && field.verificationStatus !== 'user_verified' && !field.conflicts?.length ? (
              <IconButton icon={ShieldCheck} label={`Verify ${field.label}`} size="sm" onClick={() => onVerify(field)} />
            ) : null}
            <IconButton icon={Pencil} label={`Edit ${field.label}`} size="sm" onClick={() => onEdit(field)} />
            <IconButton icon={Trash2} label={`Delete ${field.label}`} size="sm" onClick={() => onDelete(field)} />
          </div>
        </div>
      ))}
      <div className="ff-row ff-gap-4 ff-body-sm ff-muted" style={{ padding: '8px 12px', background: 'var(--ff-surface-low)', fontSize: 10 }}>
        <ShieldCheck size={12} /> Source attribution is shown for every value. FormFlow does not silently choose between conflicting documents.
      </div>
    </div>
  );
}
