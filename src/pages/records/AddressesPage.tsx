import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, Clipboard, FileText, MapPin, Navigation, ShieldCheck } from 'lucide-react';
import { PageHeader } from '@/components/ui/PageHeader';
import { Card, CardHeader } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { FieldTable } from '@/components/records/FieldTable';
import { FieldEditorDialog } from '@/components/records/FieldEditorDialog';
import { ConfirmDialog } from '@/components/ui/Modal';
import { useApp } from '@/context/AppContext';
import { useToast } from '@/context/ToastContext';
import type { VaultField } from '@/services/types';

const addressKeys = ['contact.addressLine1', 'contact.city', 'contact.state', 'contact.country', 'contact.postalCode'];

export function AddressesPage() {
  const { fields, updateField, deleteField, resolveConflict } = useApp();
  const { toast } = useToast();
  const [selected, setSelected] = useState<VaultField | null>(null);
  const [mode, setMode] = useState<'edit' | 'resolve'>('edit');
  const [editorOpen, setEditorOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<VaultField | null>(null);
  const [copied, setCopied] = useState(false);

  const addressFields = fields.filter((field) => addressKeys.includes(field.key));
  const value = (key: string) => fields.find((field) => field.key === key)?.value ?? '';
  const address = [value('contact.addressLine1'), value('contact.city'), value('contact.state'), value('contact.postalCode'), value('contact.country')].filter(Boolean).join(', ');
  const navigate = useNavigate();

  const copy = async () => {
    if (!address) return;
    await navigator.clipboard?.writeText(address);
    setCopied(true);
    toast({ tone: 'success', title: 'Address copied', message: 'Copied from your vault.' });
    window.setTimeout(() => setCopied(false), 1800);
  };

  const openEdit = (field: VaultField) => { setSelected(field); setMode('edit'); setEditorOpen(true); };
  const openResolve = (field: VaultField) => { setSelected(field); setMode('resolve'); setEditorOpen(true); };

  return (
    <div>
      <PageHeader
        eyebrow={<>My information <span>›</span> Addresses</>}
        title="Addresses"
        description="Address values extracted from your documents, with a visible source for every field."
        actions={address ? <Button icon={copied ? Check : Clipboard} onClick={copy}>{copied ? 'Copied' : 'Copy address'}</Button> : undefined}
      />

      <div className="ff-record-layout">
        <div className="ff-record-stack">
          {addressFields.length === 0 ? (
            <Card className="ff-section-card" style={{ padding: '40px 24px', textAlign: 'center' }}>
              <div style={{ display: 'inline-flex', padding: 14, borderRadius: '50%', background: 'var(--ff-surface-subtle)', marginBottom: 16 }}>
                <MapPin size={28} className="ff-primary" />
              </div>
              <div className="ff-h3">No saved addresses</div>
              <p className="ff-body-sm ff-muted" style={{ maxWidth: 440, margin: '8px auto 20px', lineHeight: 1.5 }}>
                Your address information will appear here once FormFlow processes identity or address documents such as passports, utility bills, or resumes.
              </p>
              <div className="ff-row ff-gap-8" style={{ justifyContent: 'center' }}>
                <Button variant="primary" icon={FileText} onClick={() => navigate('/documents?upload=1')}>Upload Document</Button>
                <Button onClick={() => navigate('/records/personal')}>Add Information</Button>
              </div>
            </Card>
          ) : (
            <>
              <Card>
                <CardHeader title="Permanent address" subtitle="Primary address used for form autofill" action={<Badge tone={address ? 'success' : 'neutral'}>{address ? 'Complete' : 'Incomplete'}</Badge>} />
                <div style={{ padding: '0 16px 16px' }}>
                  <div className="ff-address-map" aria-label="Stylized address map preview">
                    <div className="ff-address-map__grid" />
                    <div className="ff-address-map__pin"><MapPin size={20} /></div>
                    <div className="ff-address-map__card">
                      <div className="ff-label">{value('contact.addressLine1') || 'No street address'}</div>
                      <div className="ff-body-sm ff-muted">{value('contact.city') || 'City'}, {value('contact.state') || 'State'} {value('contact.postalCode')}</div>
                      <div className="ff-body-sm ff-muted">{value('contact.country') || 'Country'}</div>
                    </div>
                    <span className="ff-address-map__label"><Navigation size={12} /> Address preview</span>
                  </div>
                  <div className="ff-mt-12">
                    <FieldTable fields={addressFields} onEdit={openEdit} onDelete={setDeleteTarget} onResolve={openResolve} />
                  </div>
                </div>
              </Card>

              <Card>
                <CardHeader title="Address provenance" subtitle="Which documents contributed these values" />
                <div style={{ padding: '0 16px 16px' }}>
                  {addressFields.map((field) => (
                    <div className="ff-row ff-between ff-body-sm" key={field.id} style={{ padding: '9px 0', borderTop: '1px solid var(--ff-border)' }}>
                      <span className="ff-row ff-gap-6"><FileText size={13} className="ff-muted" /> {field.label}</span>
                      <span className="ff-row ff-gap-6"><span className="ff-code ff-muted">{field.source.documentName}</span><span className="ff-confidence"><span className="ff-confidence__track"><span style={{ width: `${field.confidence}%` }} /></span>{field.confidence}%</span></span>
                    </div>
                  ))}
                </div>
              </Card>
            </>
          )}
        </div>

        <div className="ff-dashboard-col">
          <Card className="ff-section-card">
            <div className="ff-row ff-gap-8"><ShieldCheck size={17} className="ff-primary" /><span className="ff-h3">Address privacy</span></div>
            <p className="ff-body-sm ff-muted ff-mt-8">Addresses can be sensitive. FormFlow only uses these values when you approve a suggested field in the extension.</p>
            <div className="ff-note ff-mt-12">The map is a visual preview only. No geolocation, Maps API, or address lookup is requested.</div>
          </Card>
          <Card className="ff-section-card">
            <div className="ff-row ff-gap-8"><MapPin size={17} className="ff-primary" /><span className="ff-h3">Address completeness</span></div>
            <div className="ff-stack ff-gap-8 ff-mt-12">
              <div className="ff-info-pair"><span>Address line</span><span>{value('contact.addressLine1') ? 'Ready' : 'Missing'}</span></div>
              <div className="ff-info-pair"><span>City / state</span><span>{value('contact.city') ? 'Ready' : 'Missing'}</span></div>
              <div className="ff-info-pair"><span>Postal code</span><span>{value('contact.postalCode') ? 'Ready' : 'Missing'}</span></div>
              <div className="ff-info-pair"><span>Country</span><span>{value('contact.country') ? 'Ready' : 'Missing'}</span></div>
            </div>
            <Button className="ff-mt-16" fullWidth onClick={copy} icon={Clipboard}>Copy formatted address</Button>
          </Card>
        </div>
      </div>

      <FieldEditorDialog
        field={selected}
        mode={mode}
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        onSave={async (next) => {
          if (!selected) return;
          if (mode === 'resolve') await resolveConflict(selected.id, next);
          else await updateField(selected.id, next);
        }}
        onDelete={async () => { if (selected) await deleteField(selected.id); }}
      />
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="Delete this address value?"
        description="This removes the value from FormFlow only. The source document remains unchanged."
        confirmLabel="Delete value"
        destructive
        onConfirm={async () => { if (deleteTarget) await deleteField(deleteTarget.id); setDeleteTarget(null); }}
        onClose={() => setDeleteTarget(null)}
      />
    </div>
  );
}
