import { useRef, useState, type DragEvent } from 'react';
import { CloudUpload, File, FileCheck2, Trash2, UploadCloud } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { ProgressBar } from '@/components/ui/States';
import { useApp } from '@/context/AppContext';

interface UploadDocumentDialogProps {
  open: boolean;
  onClose: () => void;
}

const accepted = ['PDF', 'DOCX', 'TXT', 'JPG', 'PNG'];

export function UploadDocumentDialog({ open, onClose }: UploadDocumentDialogProps) {
  const { uploadDocuments } = useApp();
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const addFiles = (incoming: FileList | File[]) => {
    setFiles((current) => [...current, ...Array.from(incoming)]);
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer.files.length) addFiles(event.dataTransfer.files);
  };

  const submit = async () => {
    if (!files.length) return;
    setBusy(true);
    try {
      await uploadDocuments(files);
      setFiles([]);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    if (busy) return;
    setFiles([]);
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="Upload documents"
      description="Add files to your local vault. Document bytes and metadata are stored in IndexedDB on this device."
      wide
      footer={
        <>
          <Button onClick={close} disabled={busy}>Cancel</Button>
          <Button variant="primary" icon={UploadCloud} onClick={submit} disabled={!files.length} loading={busy}>
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
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(event) => event.key === 'Enter' && inputRef.current?.click()}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".pdf,.docx,.doc,.txt,.jpg,.jpeg,.png"
          hidden
          onChange={(event) => event.target.files && addFiles(event.target.files)}
        />
        <span className="ff-dropzone__icon"><CloudUpload size={22} strokeWidth={1.7} /></span>
        <div className="ff-h3">Drop files here or browse</div>
        <p className="ff-body-sm ff-muted">PDF, DOCX, TXT, JPG, or PNG · up to 20 MB each</p>
        <span className="ff-row ff-gap-4" style={{ marginTop: 7 }}>
          {accepted.map((format) => <span key={format} className="ff-tag">{format}</span>)}
        </span>
      </div>

      {files.length ? (
        <div className="ff-upload-list">
          <div className="ff-row ff-between ff-mb-8">
            <span className="ff-label">{files.length} {files.length === 1 ? 'file' : 'files'} ready</span>
            <button type="button" className="ff-link-button" onClick={() => setFiles([])} disabled={busy}>Clear</button>
          </div>
          {files.map((file, index) => (
            <div className="ff-upload-row" key={`${file.name}-${index}`}>
              <span className="ff-file-icon" data-kind={file.name.endsWith('.pdf') ? 'pdf' : file.name.match(/\.(jpg|jpeg|png)$/i) ? 'jpg' : file.name.endsWith('.txt') ? 'txt' : 'docx'}><File size={16} /></span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="ff-label ff-truncate">{file.name}</div>
                <div className="ff-body-sm ff-muted">{(file.size / 1000).toFixed(0)} KB</div>
              </div>
              <button type="button" className="ff-btn ff-btn--icon-sm" onClick={() => setFiles((current) => current.filter((_, i) => i !== index))} disabled={busy} aria-label={`Remove ${file.name}`}>
                <Trash2 size={15} />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {busy ? (
        <div style={{ marginTop: 14 }}>
          <ProgressBar value={100} label="Validating, checksumming, and storing document bytes locally..." />
        </div>
      ) : null}

      <div className="ff-note ff-mt-12">
        <strong>Local Vault Ingestion:</strong> Files are stored in IndexedDB on this device. FormFlow does not send document contents to a backend.
      </div>
    </Modal>
  );
}
