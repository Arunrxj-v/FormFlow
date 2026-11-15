import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  BookOpenCheck,
  Check,
  FileText,
  FolderCog,
  Layers3,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  UsersRound,
} from 'lucide-react';
import { PageHeader } from '@/components/ui/PageHeader';
import { Card, CardHeader } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import { Modal, ConfirmDialog } from '@/components/ui/Modal';
import { EmptyState, Skeleton } from '@/components/ui/States';
import { useApp } from '@/context/AppContext';
import { useToast } from '@/context/ToastContext';
import { collectionService } from '@/services/collectionService';
import type { Collection } from '@/services/types';
import { cn } from '@/utils/cn';

interface CollectionForm {
  name: string;
  description: string;
  notes: string;
  documentIds: string[];
}

const blank: CollectionForm = { name: '', description: '', notes: '', documentIds: [] };

export function CollectionsPage() {
  const { documents, fields } = useApp();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [collections, setCollections] = useState<Collection[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<CollectionForm | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Collection | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    collectionService.list().then((next) => {
      setCollections(next);
      setSelectedId(next[0]?.id ?? null);
      setLoading(false);
    });
  }, []);

  const selected = collections.find((collection) => collection.id === selectedId) ?? collections[0] ?? null;
  const selectedDocs = documents.filter((doc) => selected?.documentIds.includes(doc.id));
  const selectedFields = useMemo(() => {
    if (!selected) return [];
    return fields.filter((field) => selected.documentIds.includes(field.source.documentId));
  }, [fields, selected]);

  const openCreate = () => { setEditingId(null); setForm({ ...blank }); };
  const openEdit = (collection: Collection) => {
    setEditingId(collection.id);
    setForm({ name: collection.name, description: collection.description, notes: collection.notes, documentIds: [...collection.documentIds] });
  };

  const save = async () => {
    if (!form?.name.trim()) {
      toast({ tone: 'error', title: 'Give the collection a name' });
      return;
    }
    setBusy(true);
    if (editingId) {
      const updated = await collectionService.update(editingId, form);
      if (updated) setCollections((current) => current.map((collection) => (collection.id === updated.id ? updated : collection)));
      toast({ tone: 'success', title: 'Collection updated' });
    } else {
      const created = await collectionService.create(form);
      setCollections((current) => [created, ...current]);
      setSelectedId(created.id);
      toast({ tone: 'success', title: 'Collection created', message: 'Select it in the extension to scope retrieval.' });
    }
    setBusy(false);
    setForm(null);
    setEditingId(null);
  };

  const remove = async () => {
    if (!deleteTarget) return;
    setBusy(true);
    await collectionService.remove(deleteTarget.id);
    const next = collections.filter((collection) => collection.id !== deleteTarget.id);
    setCollections(next);
    if (selectedId === deleteTarget.id) setSelectedId(next[0]?.id ?? null);
    setBusy(false);
    setDeleteTarget(null);
    toast({ tone: 'success', title: 'Collection deleted', message: 'Documents and vault values remain unchanged.' });
  };

  const toggleDoc = (id: string) => {
    if (!form) return;
    setForm({ ...form, documentIds: form.documentIds.includes(id) ? form.documentIds.filter((docId) => docId !== id) : [...form.documentIds, id] });
  };

  return (
    <div>
      <PageHeader
        eyebrow={<>Workspace <span>›</span> Collections</>}
        title="Collections"
        description="Group documents and context for a specific kind of application. Collections scope what the extension retrieves."
        actions={<Button variant="primary" icon={Plus} onClick={openCreate}>New collection</Button>}
      />

      <div className="ff-collection-layout">
        <div className="ff-collection-grid">
          {loading ? Array.from({ length: 3 }).map((_, index) => <Card key={index}><Skeleton height={120} /></Card>) : collections.length === 0 ? (
            <div style={{ gridColumn: '1 / -1' }}>
              <Card style={{ padding: '40px 24px', textAlign: 'center' }}>
                <div style={{ display: 'inline-flex', padding: 14, borderRadius: '50%', background: 'var(--ff-surface-subtle)', marginBottom: 16 }}>
                  <FolderCog size={28} className="ff-primary" />
                </div>
                <div className="ff-h3">No collections created</div>
                <p className="ff-body-sm ff-muted" style={{ maxWidth: 440, margin: '8px auto 20px', lineHeight: 1.5 }}>
                  Collections let you group documents and personal values for specific form applications (e.g. job applications, university portals, visa requests).
                </p>
                <Button variant="primary" icon={Plus} onClick={openCreate}>Create collection</Button>
              </Card>
            </div>
          ) : collections.map((collection) => {
            const docCount = documents.filter((doc) => collection.documentIds.includes(doc.id)).length;
            return (
              <Card key={collection.id} className={cn('ff-collection-card')} data-active={selected?.id === collection.id} onClick={() => setSelectedId(collection.id)}>
                <div className="ff-row ff-between ff-mb-12">
                  <span className="ff-collection-icon"><FolderCog size={18} /></span>
                  <div className="ff-row ff-gap-2" onClick={(event) => event.stopPropagation()}>
                    <IconButton icon={Pencil} label={`Edit ${collection.name}`} size="sm" onClick={() => openEdit(collection)} />
                    <IconButton icon={Trash2} label={`Delete ${collection.name}`} size="sm" onClick={() => setDeleteTarget(collection)} />
                  </div>
                </div>
                <div className="ff-h3">{collection.name}</div>
                <p className="ff-body-sm ff-muted" style={{ marginTop: 4, minHeight: 34 }}>{collection.description}</p>
                <div className="ff-row ff-gap-4 ff-mt-12" style={{ flexWrap: 'wrap' }}>
                  <span className="ff-pill">{docCount} documents</span>
                  <span className="ff-pill">{fields.filter((field) => collection.documentIds.includes(field.source.documentId)).length} values</span>
                </div>
                <div className="ff-row ff-between ff-mt-12 ff-body-sm ff-muted" style={{ fontSize: 10 }}>
                  <span>Updated {collection.updatedAt}</span>
                  <ArrowRight size={13} />
                </div>
              </Card>
            );
          })}
          <button type="button" className="ff-collection-add" onClick={openCreate}>
            <Plus size={20} />
            <span>Create a focused collection</span>
          </button>
        </div>

        <div className="ff-dashboard-col" style={{ position: 'sticky', top: 72 }}>
          {selected ? (
            <>
              <Card className="ff-inspector-panel">
                <div className="ff-row ff-between ff-mb-12">
                  <div className="ff-row ff-gap-6"><Layers3 size={16} className="ff-primary" /><span className="ff-h3">Collection context</span></div>
                  <Badge tone="primary">Extension scope</Badge>
                </div>
                <div className="ff-h3">{selected.name}</div>
                <p className="ff-body-sm ff-muted ff-mt-4">{selected.description}</p>
                <div className="ff-stack ff-gap-8 ff-mt-16">
                  <div className="ff-info-pair"><span>Documents</span><span>{selectedDocs.length}</span></div>
                  <div className="ff-info-pair"><span>Retrievable values</span><span>{selectedFields.length}</span></div>
                  <div className="ff-info-pair"><span>Created</span><span>{selected.createdAt}</span></div>
                </div>
                <div className="ff-mt-16">
                  <div className="ff-uppercase ff-mb-8" style={{ fontSize: 9 }}>Documents</div>
                  {selectedDocs.length ? selectedDocs.map((doc) => (
                    <button type="button" key={doc.id} className="ff-source-option" onClick={() => navigate(`/documents?doc=${doc.id}`)}>
                      <span className="ff-file-icon"><FileText size={14} /></span>
                      <span style={{ flex: 1, textAlign: 'left', minWidth: 0 }}><span className="ff-label ff-truncate" style={{ display: 'block' }}>{doc.name}</span><span className="ff-body-sm ff-muted">{doc.category}</span></span>
                      <ArrowRight size={13} className="ff-muted" />
                    </button>
                  )) : <div className="ff-note">No documents assigned yet. Edit the collection to add them.</div>}
                </div>
                {selected.notes ? <div className="ff-note ff-mt-12"><strong>Context note:</strong> {selected.notes}</div> : null}
                <Button fullWidth className="ff-mt-12" icon={Pencil} onClick={() => openEdit(selected)}>Edit collection</Button>
              </Card>

              <Card className="ff-section-card">
                <div className="ff-row ff-gap-8"><Sparkles size={16} className="ff-primary" /><span className="ff-h3">Retrieval preview</span></div>
                <p className="ff-body-sm ff-muted ff-mt-8">Only these values are offered when this collection is selected.</p>
                <div className="ff-stack ff-gap-4 ff-mt-12">
                  {selectedFields.slice(0, 6).map((field) => (
                    <div className="ff-info-pair" key={field.id}><span className="ff-truncate" style={{ maxWidth: 150 }}>{field.label}</span><span className="ff-code ff-muted">{field.source.documentName}</span></div>
                  ))}
                </div>
              </Card>
            </>
          ) : null}

          <Card className="ff-section-card" style={{ background: 'var(--ff-surface-low)' }}>
            <div className="ff-row ff-gap-8"><BookOpenCheck size={16} className="ff-primary" /><div><div className="ff-h3">How collections work</div><div className="ff-body-sm ff-muted">Shared documents, no duplicates. A file can belong to several collections, and you choose the context before filling.</div></div></div>
          </Card>
        </div>
      </div>

      <Modal
        open={Boolean(form)}
        onClose={() => { setForm(null); setEditingId(null); }}
        title={editingId ? 'Edit collection' : 'New collection'}
        description="Collections reference existing vault documents. They do not duplicate files or values."
        wide
        footer={<><Button onClick={() => { setForm(null); setEditingId(null); }} disabled={busy}>Cancel</Button><Button variant="primary" onClick={save} loading={busy}>{editingId ? 'Save changes' : 'Create collection'}</Button></>}
      >
        {form ? (
          <div className="ff-stack ff-gap-12">
            <Input label="Collection name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="e.g. Visa application" autoFocus />
            <Input label="Description" value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} placeholder="What this collection is used for" />
            <div className="ff-field">
              <label className="ff-field__label">Documents</label>
              <div className="ff-check-list">
                {documents.map((doc) => (
                  <button type="button" className="ff-check-row" key={doc.id} data-selected={form.documentIds.includes(doc.id)} onClick={() => toggleDoc(doc.id)}>
                    <span className="ff-check-box">{form.documentIds.includes(doc.id) ? <Check size={12} /> : null}</span>
                    <span style={{ flex: 1, textAlign: 'left' }}><span className="ff-label">{doc.name}</span><span className="ff-body-sm ff-muted" style={{ display: 'block' }}>{doc.category} · {doc.status}</span></span>
                  </button>
                ))}
              </div>
            </div>
            <div className="ff-field">
              <label className="ff-field__label" htmlFor="collection-notes">Context notes</label>
              <textarea id="collection-notes" className="ff-textarea" value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} placeholder="Optional context for matching, e.g. use the latest degree certificate." />
            </div>
          </div>
        ) : null}
      </Modal>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="Delete this collection?"
        description="The collection grouping is removed. Its documents and vault values remain available."
        confirmLabel="Delete collection"
        destructive
        loading={busy}
        onConfirm={remove}
        onClose={() => setDeleteTarget(null)}
      />
    </div>
  );
}
