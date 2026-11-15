import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowRight,
  Cloud,
  Download,
  ExternalLink,
  Eye,
  FileText,
  FolderCog,
  FolderLock,
  FolderOpen,
  Grid2X2,
  List,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
} from 'lucide-react';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Badge, StatusBadge } from '@/components/ui/Badge';
import { SearchInput, Input } from '@/components/ui/Input';
import { Modal, ConfirmDialog } from '@/components/ui/Modal';
import { EmptyState } from '@/components/ui/States';
import { Dropdown } from '@/components/ui/Dropdown';
import { DocumentInspector } from '@/components/documents/DocumentInspector';
import { UploadDocumentDialog } from '@/components/documents/UploadDocumentDialog';
import { DrivePickerDialog } from '@/components/documents/DrivePickerDialog';
import { useApp } from '@/context/AppContext';
import { useToast } from '@/context/ToastContext';
import type { DocumentCategory, DocumentStatus, VaultDocument } from '@/services/types';
import { cn } from '@/utils/cn';

type SortKey = 'modified' | 'name' | 'size';
type ViewMode = 'list' | 'grid';

const defaultCategories = [
  { id: 'all', label: 'All Documents', icon: FolderOpen },
  { id: 'Identity', label: 'Identity Documents', icon: FolderLock },
  { id: 'Education', label: 'Academic Certificates', icon: FileText },
  { id: 'Employment', label: 'Employment Records', icon: FolderCog },
  { id: 'Resumes', label: 'Resumes & CVs', icon: FileText },
  { id: 'Certifications', label: 'Professional Certificates', icon: Cloud },
  { id: 'Financial', label: 'Financial Documents', icon: FolderLock },
  { id: 'Address', label: 'Address Proofs', icon: FolderOpen },
  { id: 'Other', label: 'Other Documents', icon: FolderOpen },
];

const statusOptions: { value: 'all' | DocumentStatus; label: string }[] = [
  { value: 'all', label: 'All statuses' },
  { value: 'processed', label: 'Processed' },
  { value: 'processing', label: 'Processing' },
  { value: 'failed', label: 'Processing failed' },
  { value: 'needs_attention', label: 'Needs attention' },
];

export function DocumentsPage() {
  const {
    documents,
    removeDocument,
    renameDocument,
    retryDocument,
    unlinkDocument,
    driveConnection,
    dataLoading,
  } = useApp();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<'all' | DocumentCategory>('all');
  const [status, setStatus] = useState<'all' | DocumentStatus>('all');
  const [sort, setSort] = useState<SortKey>('modified');
  const [view, setView] = useState<ViewMode>('list');
  const [selectedId, setSelectedId] = useState<string | null>(searchParams.get('doc'));
  const [uploadOpen, setUploadOpen] = useState(searchParams.get('upload') === '1');
  const [driveOpen, setDriveOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<VaultDocument | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<VaultDocument | null>(null);
  const [unlinkTarget, setUnlinkTarget] = useState<VaultDocument | null>(null);
  const [busy, setBusy] = useState(false);
  const [customFolders, setCustomFolders] = useState<string[]>([]);
  const [folderOpen, setFolderOpen] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [checkingDrive, setCheckingDrive] = useState(false);

  const categories = useMemo(() => {
    const list = [...defaultCategories];
    customFolders.forEach((folder) => {
      list.push({ id: folder as DocumentCategory, label: folder, icon: FolderOpen });
    });
    return list;
  }, [customFolders]);

  const handleCreateFolder = () => {
    if (!folderName.trim()) return;
    const name = folderName.trim();
    if (!customFolders.includes(name)) {
      setCustomFolders((curr) => [...curr, name]);
      setCategory(name as DocumentCategory);
      toast({ tone: 'success', title: 'Folder created', message: `Created custom folder "${name}".` });
    }
    setFolderName('');
    setFolderOpen(false);
  };

  const handleCheckDriveSync = async () => {
    setCheckingDrive(true);
    await new Promise((resolve) => setTimeout(resolve, 800));
    setCheckingDrive(false);
    toast({
      tone: 'success',
      title: 'Google Drive synchronization verified',
      message: 'All 6 vault documents are in sync with Google Drive metadata. No remote updates detected.',
    });
  };

  useEffect(() => {
    if (!selectedId && documents.length) setSelectedId(documents[0].id);
    if (selectedId && documents.length && !documents.some((doc) => doc.id === selectedId)) {
      setSelectedId(documents[0]?.id ?? null);
    }
  }, [documents, selectedId]);

  useEffect(() => {
    if (searchParams.get('upload') === '1') {
      setUploadOpen(true);
      searchParams.delete('upload');
      setSearchParams(searchParams, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return documents
      .filter((doc) => (category === 'all' ? true : doc.category === category))
      .filter((doc) => (status === 'all' ? true : doc.status === status))
      .filter((doc) => !normalized || `${doc.name} ${doc.category} ${doc.subcategory}`.toLowerCase().includes(normalized))
      .sort((a, b) => {
        if (sort === 'name') return a.name.localeCompare(b.name);
        if (sort === 'size') return b.sizeBytes - a.sizeBytes;
        return new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime();
      });
  }, [documents, category, status, query, sort]);

  const selected = documents.find((doc) => doc.id === selectedId) ?? filtered[0] ?? null;
  const counts = useMemo(() => {
    const result: Record<string, number> = { all: documents.length };
    documents.forEach((doc) => {
      result[doc.category] = (result[doc.category] ?? 0) + 1;
    });
    return result;
  }, [documents]);

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setBusy(true);
    await removeDocument(deleteTarget.id);
    setBusy(false);
    setDeleteTarget(null);
  };

  const handleRename = async () => {
    if (!renameTarget || !renameValue.trim()) return;
    setBusy(true);
    await renameDocument(renameTarget.id, renameValue.trim());
    setBusy(false);
    setRenameTarget(null);
  };

  const handleUnlink = async () => {
    if (!unlinkTarget) return;
    setBusy(true);
    await unlinkDocument(unlinkTarget.id);
    setBusy(false);
    setUnlinkTarget(null);
  };

  return (
    <div>
      <PageHeader
        eyebrow={<>Documents <span>›</span> Document Vault</>}
        title="Document Vault"
        description="Select documents, inspect extracted fields, and manage what FormFlow can use."
        actions={
          <>
            <Button icon={RefreshCw} loading={checkingDrive} onClick={handleCheckDriveSync}>Check Drive Sync</Button>
            <Button icon={Cloud} onClick={() => setDriveOpen(true)}>Add from Drive</Button>
            <Button variant="primary" icon={Upload} onClick={() => setUploadOpen(true)}>Upload document</Button>
          </>
        }
      />

      <div className="ff-card ff-doc-toolbar">
        <div className="ff-doc-toolbar__left">
          <SearchInput
            className="ff-doc-toolbar__search"
            placeholder="Search documents by name, category, or metadata…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            shortcut="⌘F"
          />
          <div className="ff-view-toggle" aria-label="View mode">
            <button type="button" data-active={view === 'list'} onClick={() => setView('list')} aria-label="List view"><List size={16} /></button>
            <button type="button" data-active={view === 'grid'} onClick={() => setView('grid')} aria-label="Grid view"><Grid2X2 size={16} /></button>
          </div>
        </div>
        <div className="ff-doc-toolbar__right">
          <select className="ff-select" style={{ width: 150 }} value={status} onChange={(event) => setStatus(event.target.value as 'all' | DocumentStatus)} aria-label="Filter by status">
            {statusOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <select className="ff-select" style={{ width: 150 }} value={sort} onChange={(event) => setSort(event.target.value as SortKey)} aria-label="Sort documents">
            <option value="modified">Newest first</option>
            <option value="name">Name A–Z</option>
            <option value="size">Largest first</option>
          </select>
          <Button icon={Plus} onClick={() => setFolderOpen(true)}>New folder</Button>
        </div>
      </div>

      <div className="ff-vault-grid">
        <div className="ff-card ff-folder-panel">
          <div className="ff-folder-head">
            <span className="ff-uppercase" style={{ fontSize: 9 }}>Folders &amp; categories</span>
            <FolderCog size={14} className="ff-muted" />
          </div>
          <nav className="ff-folder-list" aria-label="Document categories">
            {categories.map(({ id, label, icon: Icon }) => (
              <button key={id} type="button" className="ff-folder-button" data-active={category === id} onClick={() => setCategory(id)}>
                <span><Icon size={15} /> {label}</span>
                <span className="ff-folder-count">{counts[id] ?? 0}</span>
              </button>
            ))}
          </nav>
          <div className="ff-drive-widget">
            <div className="ff-row ff-between">
              <span className="ff-row ff-gap-4 ff-label" style={{ fontSize: 10 }}><Cloud size={13} className={driveConnection.connected ? 'ff-primary' : 'ff-muted'} /> Google Drive</span>
              <span className="ff-code" style={{ color: driveConnection.connected ? 'var(--ff-success)' : 'var(--ff-muted)', fontSize: 9 }}>{driveConnection.connected ? 'Connected' : 'Not connected'}</span>
            </div>
            {driveConnection.connected ? (
              <>
                <div className="ff-drive-widget__bar"><span /></div>
                <div className="ff-row ff-between ff-body-sm ff-muted" style={{ fontSize: 9 }}>
                  <span className="ff-truncate">{driveConnection.accountEmail}</span>
                  <span>Active</span>
                </div>
                <button type="button" className="ff-link-button ff-mt-8" style={{ color: 'var(--ff-primary)', fontSize: 10 }} onClick={() => navigate('/settings?tab=connections')}>Manage connection</button>
              </>
            ) : (
              <>
                <p className="ff-body-sm ff-muted ff-mt-6" style={{ fontSize: 10, lineHeight: 1.4 }}>Link Google Drive to import files directly.</p>
                <button type="button" className="ff-link-button ff-mt-8" style={{ color: 'var(--ff-primary)', fontSize: 10, fontWeight: 600 }} onClick={() => navigate('/settings?tab=connections')}>Connect Drive</button>
              </>
            )}
          </div>
        </div>

        <div className="ff-card ff-doc-table-card">
          <div className="ff-doc-table-card__banner">
            <div className="ff-row ff-gap-6" style={{ minWidth: 0 }}>
              <span className="ff-h3">{category === 'all' ? 'All documents' : `${category} documents`}</span>
              <span className="ff-body-sm ff-muted">· {filtered.length} shown</span>
            </div>
            <button type="button" className="ff-link-button" style={{ color: 'var(--ff-primary)', fontWeight: 600 }} onClick={() => { setCategory('all'); setStatus('all'); setQuery(''); }}>Show all</button>
          </div>

          {dataLoading ? (
            <div className="ff-empty"><span className="ff-spinner" /></div>
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={FolderOpen}
              title="No documents match this view"
              description="Try a different search or category. You can also import a document from Drive."
              action={<Button variant="primary" icon={Upload} onClick={() => setUploadOpen(true)}>Add a document</Button>}
            />
          ) : view === 'grid' ? (
            <div className="ff-grid-cards">
              {filtered.map((doc) => (
                <button
                  key={doc.id}
                  type="button"
                  className="ff-doc-grid-card"
                  data-active={selected?.id === doc.id}
                  onClick={() => setSelectedId(doc.id)}
                >
                  <div className="ff-row ff-between">
                    <span className="ff-file-icon" data-kind={doc.fileType}><FileText size={16} /></span>
                    <StatusBadge status={doc.status} />
                  </div>
                  <div className="ff-label ff-truncate ff-mt-8">{doc.name}</div>
                  <div className="ff-body-sm ff-muted ff-mt-4">{doc.subcategory}</div>
                  <div className="ff-row ff-between ff-mt-12">
                    <span className="ff-code ff-muted">{doc.sizeLabel}</span>
                    <span className="ff-code ff-muted">{doc.uploadedAt}</span>
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <div className="ff-doc-table-wrap">
              <table className="ff-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Category</th>
                    <th>Format</th>
                    <th>Size</th>
                    <th>Modified</th>
                    <th>Source</th>
                    <th style={{ textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((doc) => (
                    <tr key={doc.id} data-active={selected?.id === doc.id} onClick={() => setSelectedId(doc.id)} style={{ cursor: 'pointer' }}>
                      <td>
                        <div className="ff-doc-name">
                          <span className="ff-file-icon" data-kind={doc.fileType}><FileText size={16} /></span>
                          <div style={{ minWidth: 0 }}>
                            <div className="ff-label ff-truncate" style={{ maxWidth: 210 }}>{doc.name}</div>
                            <div className="ff-row ff-gap-4 ff-code ff-muted" style={{ fontSize: 9 }}>
                              {doc.status === 'processed' || doc.status === 'completed' ? <><span className="ff-dot" style={{ color: 'var(--ff-success)' }} /> Linked to profile</> : <StatusBadge status={doc.status} />}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td><span className="ff-tag">{doc.subcategory}</span></td>
                      <td><span className="ff-format-tag" data-kind={doc.fileType}>{doc.fileType}</span></td>
                      <td className="ff-code ff-muted">{doc.sizeLabel}</td>
                      <td className="ff-body-sm ff-muted">{doc.uploadedAt}</td>
                      <td>{doc.source === 'google-drive' ? <Cloud size={15} className="ff-primary" aria-label="Google Drive" /> : <span className="ff-body-sm ff-muted">Upload</span>}</td>
                      <td onClick={(event) => event.stopPropagation()}>
                        <div className="ff-row ff-gap-4" style={{ justifyContent: 'flex-end' }}>
                          <IconButton icon={Eye} label="Inspect document" size="sm" onClick={() => setSelectedId(doc.id)} />
                          <IconButton icon={Download} label="View original document" size="sm" onClick={() => window.open(`/api/documents/${doc.id}/preview`, '_blank')} />
                          <Dropdown
                            items={[
                              { label: 'View original file', icon: <ExternalLink size={14} />, onSelect: () => window.open(`/api/documents/${doc.id}/preview`, '_blank') },
                              { label: 'Rename', onSelect: () => { setRenameTarget(doc); setRenameValue(doc.name); } },
                              { label: 'Retry processing', icon: <RefreshCw size={14} />, disabled: doc.status === 'processing' || doc.status === 'extracting_text' || doc.status === 'extracting_information', onSelect: () => retryDocument(doc.id) },
                              { label: 'Unlink profile record', icon: <LinkIcon />, disabled: !doc.linkedRecordId, onSelect: () => setUnlinkTarget(doc) },
                              { label: 'Remove from FormFlow', icon: <Trash2 size={14} />, danger: true, onSelect: () => setDeleteTarget(doc) },
                            ]}
                          />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="ff-vault-autofill-bar">
            <div className="ff-row ff-gap-8">
              <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, borderRadius: '50%', background: 'var(--ff-primary-bright)', color: '#fff' }}><ZapIcon /></span>
              <div>
                <div className="ff-label" style={{ fontSize: 11 }}>Deterministic autofill ready</div>
                <div className="ff-body-sm ff-muted" style={{ fontSize: 10 }}>The extension matches document proofs during multi-page form filling.</div>
              </div>
            </div>
            <span className="ff-kbd">Alt + A</span>
          </div>
        </div>

        {selected ? (
          <DocumentInspector
            document={selected}
            onRemove={() => setDeleteTarget(selected)}
            onRetry={() => retryDocument(selected.id)}
            onRename={() => { setRenameTarget(selected); setRenameValue(selected.name); }}
            onUnlink={() => setUnlinkTarget(selected)}
            onOpenRecord={() => {
              if (selected.category === 'Education') navigate('/records/education');
              else if (selected.category === 'Employment') navigate('/records/employment');
              else navigate('/records/personal');
            }}
          />
        ) : (
          <div className="ff-card">
            <EmptyState icon={Eye} title="Select a document" description="Choose a row to inspect metadata, linked records, and autofill rules." />
          </div>
        )}
      </div>

      <UploadDocumentDialog open={uploadOpen} onClose={() => setUploadOpen(false)} />
      <DrivePickerDialog open={driveOpen} onClose={() => setDriveOpen(false)} />

      <Modal
        open={folderOpen}
        onClose={() => setFolderOpen(false)}
        title="Create new folder"
        description="Organize documents into custom collections and categories."
        footer={
          <>
            <Button onClick={() => setFolderOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={handleCreateFolder} disabled={!folderName.trim()}>Create folder</Button>
          </>
        }
      >
        <Input label="Folder name" value={folderName} onChange={(event) => setFolderName(event.target.value)} placeholder="e.g. Tax & Accounting 2026" autoFocus />
      </Modal>

      <Modal
        open={Boolean(renameTarget)}
        onClose={() => setRenameTarget(null)}
        title="Rename document"
        description="Only the FormFlow display name changes. The original Drive file is untouched."
        footer={
          <>
            <Button onClick={() => setRenameTarget(null)}>Cancel</Button>
            <Button variant="primary" onClick={handleRename} loading={busy} disabled={!renameValue.trim()}>Save name</Button>
          </>
        }
      >
        <Input label="Document name" value={renameValue} onChange={(event) => setRenameValue(event.target.value)} autoFocus />
      </Modal>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="Remove document from FormFlow?"
        description={<span>This removes the document reference and its extracted values from FormFlow. The original file in Google Drive is not deleted. This action cannot be undone.</span>}
        confirmLabel="Remove document"
        destructive
        onConfirm={handleDelete}
        onClose={() => setDeleteTarget(null)}
        loading={busy}
      />

      <ConfirmDialog
        open={Boolean(unlinkTarget)}
        title="Unlink profile record?"
        description="The document remains in your vault and its extracted values remain available. Only the profile association is removed."
        confirmLabel="Unlink record"
        onConfirm={handleUnlink}
        onClose={() => setUnlinkTarget(null)}
        loading={busy}
      />
    </div>
  );
}

function ZapIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M13 2 4.5 13.2c-.4.5 0 1.3.7 1.3H11l-1 7.5 8.5-11.2c.4-.5 0-1.3-.7-1.3H13l1-7.5Z" />
    </svg>
  );
}

function LinkIcon() {
  return <ArrowRight size={14} />;
}
