import { useMemo, useRef, useState, type DragEvent } from 'react';
import { AlertTriangle, CloudUpload, File, FileCheck2, Loader2, Trash2, UploadCloud, XCircle } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { ProgressBar } from '@/components/ui/States';
import { useApp } from '@/context/AppContext';
import type { DocumentUploadProgress, DocumentUploadResult, VaultDocument } from '@/services/types';

interface UploadDocumentDialogProps {
  open: boolean;
  onClose: () => void;
}

type EntryStatus = 'queued' | 'processing' | 'stored' | 'duplicate' | 'failed' | 'cancelled';

interface FileEntry {
  file: File;
  status: EntryStatus;
  stage: string;
  progress: number;
  message?: string;
  document?: VaultDocument;
  existingName?: string;
}

const accepted = ['PDF', 'DOCX', 'TXT'];

function formatFileSize(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${bytes} B`;
}

function fileKind(name: string): 'pdf' | 'docx' | 'txt' | 'other' {
  const extension = name.split('.').pop()?.toLowerCase();
  if (extension === 'pdf' || extension === 'docx' || extension === 'txt') return extension;
  return 'other';
}

function entryTone(status: EntryStatus): { icon: typeof File; color: string } {
  if (status === 'stored') return { icon: FileCheck2, color: 'var(--ff-success)' };
  if (status === 'duplicate') return { icon: AlertTriangle, color: 'var(--ff-warning, #b45309)' };
  if (status === 'failed') return { icon: XCircle, color: 'var(--ff-danger)' };
  if (status === 'cancelled') return { icon: XCircle, color: 'var(--ff-muted)' };
  if (status === 'processing') return { icon: Loader2, color: 'var(--ff-primary)' };
  return { icon: File, color: 'var(--ff-text-secondary)' };
}

export function UploadDocumentDialog({ open, onClose }: UploadDocumentDialogProps) {
  const { uploadDocuments, cancelDocumentUpload } = useApp();
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [activeImportId, setActiveImportId] = useState<string | null>(null);
  const [summary, setSummary] = useState<DocumentUploadResult | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const addFiles = (incoming: FileList | File[]) => {
    const next = Array.from(incoming).map<FileEntry>((file) => ({
      file,
      status: 'queued',
      stage: 'Ready to validate',
      progress: 0,
    }));
    setEntries((current) => [...current, ...next]);
    setSummary(null);
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer.files.length) addFiles(event.dataTransfer.files);
  };

  const updateEntry = (index: number, patch: Partial<FileEntry>) => {
    setEntries((current) => current.map((entry, entryIndex) => (
      entryIndex === index ? { ...entry, ...patch } : entry
    )));
  };

  const onProgress = (event: DocumentUploadProgress) => {
    setActiveImportId(event.importId);
    const message = event.stage === 'completed'
      ? 'Stored'
      : event.stage === 'failed'
        ? event.message
        : event.message;
    updateEntry(event.fileIndex, {
      status: event.stage === 'failed' ? 'failed' : event.stage === 'cancelled' ? 'cancelled' : 'processing',
      stage: message,
      progress: event.progress,
      message: event.stage === 'failed' || event.stage === 'cancelled' ? event.message : undefined,
    });
  };

  const submit = async () => {
    if (!entries.length || busy) return;
    setBusy(true);
    setCancelling(false);
    setSummary(null);
    setEntries((current) => current.map((entry) => ({
      ...entry,
      status: 'queued',
      stage: 'Queued',
      progress: 0,
      message: undefined,
      document: undefined,
      existingName: undefined,
    })));
    try {
      const result = await uploadDocuments(entries.map((entry) => entry.file), { onProgress });
      setSummary(result);
      setEntries((current) => current.map((entry, index) => {
        const acceptedPosition = result.acceptedIndices.indexOf(index);
        const acceptedDocument = acceptedPosition >= 0 ? result.accepted[acceptedPosition] : undefined;
        if (acceptedDocument) {
          return {
            ...entry,
            status: 'stored',
            stage: acceptedDocument.ocrRequired ? 'Stored · OCR required' : 'Stored with extracted text',
            progress: 100,
            document: acceptedDocument,
          };
        }
        const duplicate = result.duplicates.find((item) => item.fileIndex === index);
        if (duplicate) {
          return {
            ...entry,
            status: 'duplicate',
            stage: 'Duplicate · existing document kept',
            progress: 100,
            existingName: duplicate.existingDocument.name,
            document: duplicate.existingDocument,
          };
        }
        const failure = result.rejected.find((item) => item.fileIndex === index);
        if (failure) {
          return {
            ...entry,
            status: 'failed',
            stage: 'Not imported',
            progress: 0,
            message: failure.message,
          };
        }
        return result.cancelled
          ? { ...entry, status: 'cancelled', stage: 'Cancelled', progress: 0 }
          : entry;
      }));
      if (result.accepted.length && !result.duplicates.length && !result.rejected.length && !result.cancelled) {
        setEntries([]);
        onClose();
      }
    } finally {
      setBusy(false);
      setCancelling(false);
      setActiveImportId(null);
    }
  };

  const cancel = async () => {
    if (!busy) {
      close();
      return;
    }
    setCancelling(true);
    await cancelDocumentUpload(activeImportId ?? undefined);
  };

  const close = () => {
    if (busy) {
      void cancel();
      return;
    }
    setEntries([]);
    setSummary(null);
    onClose();
  };

  const overallProgress = useMemo(() => {
    if (!entries.length) return 0;
    let total = 0;
    for (const entry of entries) {
      total += entry.status === 'stored' || entry.status === 'duplicate' ? 100 : entry.progress;
    }
    return total / entries.length;
  }, [entries]);

  const activeStage = entries.find((entry) => entry.status === 'processing')?.stage
    ?? (summary ? 'Import finished' : 'Waiting to process');

  return (
    <Modal
      open={open}
      onClose={close}
      title="Upload documents"
      description="Add PDF, DOCX, or TXT files. Original bytes and extracted text are encrypted locally before the import is reported complete."
      wide
      footer={
        <>
          <Button onClick={busy ? cancel : close} disabled={busy && cancelling} loading={cancelling}>
            {busy ? 'Cancel import' : 'Close'}
          </Button>
          <Button variant="primary" icon={UploadCloud} onClick={submit} disabled={!entries.length || busy} loading={busy}>
            Upload and extract
          </Button>
        </>
      }
    >
      <div
        className={`ff-dropzone ${dragging ? 'is-dragging' : ''}`}
        onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => !busy && inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(event) => event.key === 'Enter' && !busy && inputRef.current?.click()}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".pdf,.docx,.txt"
          hidden
          disabled={busy}
          onChange={(event) => {
            if (event.target.files) addFiles(event.target.files);
            event.target.value = '';
          }}
        />
        <span className="ff-dropzone__icon"><CloudUpload size={22} strokeWidth={1.7} /></span>
        <div className="ff-h3">Drop files here or browse</div>
        <p className="ff-body-sm ff-muted">PDF, DOCX, or TXT · up to 20 MB each</p>
        <span className="ff-row ff-gap-4" style={{ marginTop: 7 }}>
          {accepted.map((format) => <span key={format} className="ff-tag">{format}</span>)}
        </span>
      </div>

      {entries.length ? (
        <div className="ff-upload-list">
          <div className="ff-row ff-between ff-mb-8">
            <span className="ff-label">{entries.length} {entries.length === 1 ? 'file' : 'files'}</span>
            <button type="button" className="ff-link-button" onClick={() => { setEntries([]); setSummary(null); }} disabled={busy}>Clear</button>
          </div>
          {entries.map((entry, index) => {
            const tone = entryTone(entry.status);
            const Icon = tone.icon;
            const kind = fileKind(entry.file.name);
            return (
              <div className="ff-upload-row" key={`${entry.file.name}-${index}`} style={{ alignItems: 'flex-start' }}>
                <span className="ff-file-icon" data-kind={kind}><File size={16} /></span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="ff-row ff-between ff-gap-8">
                    <span className="ff-label ff-truncate" title={entry.file.name}>{entry.file.name}</span>
                    <span className="ff-row ff-gap-4 ff-code" style={{ color: tone.color, flex: '0 0 auto', fontSize: 11 }}>
                      <Icon size={13} className={entry.status === 'processing' ? 'ff-spin' : undefined} />
                      {entry.document?.ocrRequired ? 'OCR required' : entry.status === 'stored' ? 'Stored' : entry.status === 'duplicate' ? 'Duplicate' : entry.status === 'failed' ? 'Failed' : entry.status === 'cancelled' ? 'Cancelled' : 'Queued'}
                    </span>
                  </div>
                  <div className="ff-body-sm ff-muted">
                    {formatFileSize(entry.file.size)} · {entry.stage}
                    {entry.document?.pageCount ? ` · ${entry.document.pageCount} page${entry.document.pageCount === 1 ? '' : 's'}` : ''}
                    {entry.document?.ocrRequired ? ' · OCR not implemented' : ''}
                  </div>
                  {entry.existingName ? (
                    <div className="ff-body-sm" style={{ color: 'var(--ff-warning, #b45309)' }}>
                      Existing vault document: {entry.existingName}. Nothing was overwritten.
                    </div>
                  ) : null}
                  {entry.document?.extractionWarnings?.length ? (
                    <div className="ff-body-sm ff-muted">
                      {entry.document.extractionWarnings.length} extraction warning{entry.document.extractionWarnings.length === 1 ? '' : 's'} — inspect the document for details.
                    </div>
                  ) : null}
                  {entry.message ? (
                    <div className="ff-body-sm" style={{ color: 'var(--ff-danger)' }}>{entry.message}</div>
                  ) : null}
                  {entry.status === 'processing' ? (
                    <div style={{ marginTop: 5 }}>
                      <ProgressBar value={entry.progress} />
                    </div>
                  ) : null}
                </div>
                <button
                  type="button"
                  className="ff-btn ff-btn--icon-sm"
                  onClick={() => setEntries((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                  disabled={busy}
                  aria-label={`Remove ${entry.file.name}`}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            );
          })}
        </div>
      ) : null}

      {busy ? (
        <div style={{ marginTop: 14 }}>
          <ProgressBar value={overallProgress} label={activeStage} />
        </div>
      ) : null}

      {summary ? (
        <div className="ff-note ff-mt-12">
          <strong>Import complete:</strong> {summary.accepted.length} stored, {summary.duplicates.length} duplicate(s) skipped, {summary.rejected.length} failed{summary.cancelled ? ', cancelled' : ''}. No successful document was reported until its original file and extracted text were committed together.
        </div>
      ) : null}

      <div className="ff-note ff-mt-12">
        <strong>Local ingestion:</strong> Files never leave this browser. Text extraction runs in a dedicated worker, and OCR is not implemented in Phase 4.1. Scanned PDFs are stored with an OCR-required status.
      </div>
    </Modal>
  );
}
