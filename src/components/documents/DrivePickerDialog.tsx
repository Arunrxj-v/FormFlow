import { useEffect, useState } from 'react';
import { Check, Cloud, FileCheck2, Loader2 } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { Badge } from '@/components/ui/Badge';
import { Skeleton } from '@/components/ui/States';
import { useApp } from '@/context/AppContext';
import { googleDriveService } from '@/services/googleDriveService';
import type { DriveFile } from '@/services/types';

interface DrivePickerDialogProps {
  open: boolean;
  onClose: () => void;
}

export function DrivePickerDialog({ open, onClose }: DrivePickerDialogProps) {
  const { addDriveDocuments, driveConnection } = useApp();
  const [files, setFiles] = useState<DriveFile[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    if (!open || !driveConnection.connected) return;
    setLoading(true);
    setSelected([]);
    googleDriveService.listFiles().then((next) => {
      setFiles(next);
      setLoading(false);
    });
  }, [open, driveConnection.connected]);

  const toggle = (id: string) => {
    setSelected((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  };

  const importFiles = async () => {
    if (!selected.length) return;
    setImporting(true);
    await addDriveDocuments(files.filter((file) => selected.includes(file.id)));
    setImporting(false);
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={() => !importing && onClose()}
      title="Add from Google Drive"
      description="Choose the files FormFlow may use. FormFlow requests only file-specific access."
      wide
      footer={
        <>
          <Button onClick={onClose} disabled={importing}>Cancel</Button>
          <Button variant="primary" icon={Cloud} onClick={importFiles} disabled={!selected.length} loading={importing}>
            Add {selected.length || ''} {selected.length === 1 ? 'file' : 'files'}
          </Button>
        </>
      }
    >
      <div className="ff-row ff-between ff-mb-12">
        <div className="ff-row ff-gap-8">
          <span className="ff-connection-icon"><span className="ff-google-mark">G</span></span>
          <div>
            <div className="ff-label">{driveConnection.connected ? (driveConnection.accountName || 'Google Drive') : 'Google Drive'}</div>
            <div className="ff-body-sm ff-muted">{driveConnection.connected ? `${driveConnection.accountEmail} · file-scoped access` : 'Not connected'}</div>
          </div>
        </div>
        <Badge tone={driveConnection.connected ? 'success' : 'neutral'}>{driveConnection.connected ? 'Connected' : 'Not connected'}</Badge>
      </div>

      {!driveConnection.connected ? (
        <div style={{ padding: '36px 16px', textAlign: 'center' }} className="ff-stack ff-gap-8">
          <div className="ff-h3">Google Drive is not connected</div>
          <p className="ff-body-sm ff-muted" style={{ maxWidth: 400, margin: '0 auto' }}>
            Link your Google account with minimal file-level permission to pick and ingest documents directly from your Drive.
          </p>
          <div className="ff-row ff-gap-8 ff-mt-12" style={{ justifyContent: 'center' }}>
            <Button variant="primary" icon={Cloud} onClick={() => { onClose(); window.location.href = '/settings?tab=connections'; }}>
              Connect Google Drive
            </Button>
          </div>
        </div>
      ) : loading ? (
        <div className="ff-stack ff-gap-8">{Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} height={48} />)}</div>
      ) : files.length === 0 ? (
        <div style={{ padding: '32px 16px', textAlign: 'center' }} className="ff-body-sm ff-muted">
          No eligible documents found in your connected Drive.
        </div>
      ) : (
        <div className="ff-drive-file-list ff-scroll" style={{ maxHeight: 360 }}>
          {files.map((file) => {
            const isSelected = selected.includes(file.id);
            return (
              <label key={file.id} className="ff-drive-file" data-selected={isSelected}>
                <Checkbox checked={isSelected} onChange={() => toggle(file.id)} />
                <span className="ff-file-icon" data-kind={file.fileType}><FileCheck2 size={16} /></span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span className="ff-label ff-truncate" style={{ display: 'block' }}>{file.name}</span>
                  <span className="ff-body-sm ff-muted">{file.sizeLabel} · {file.modifiedAt}</span>
                </span>
                {isSelected ? <Check size={15} className="ff-primary" /> : null}
              </label>
            );
          })}
        </div>
      )}

      <div className="ff-note ff-mt-12">
        <strong>Permission scope:</strong> FormFlow uses file-specific access which limits permissions strictly to files you choose. Revoke access at any time in Settings.
      </div>
      {importing ? <div className="ff-row ff-gap-6 ff-mt-12 ff-body-sm ff-muted"><Loader2 size={14} className="ff-spin" /> Ingesting and processing document facts…</div> : null}
    </Modal>
  );
}
