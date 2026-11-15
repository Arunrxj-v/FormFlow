import { useState } from 'react';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  Cloud,
  Copy,
  Download,
  ExternalLink,
  Eye,
  FileCheck2,
  FileText,
  Folder,
  History,
  Info,
  Link2Off,
  Loader2,
  Pencil,
  RefreshCw,
  Shield,
  Sparkles,
  Tag,
  Trash2,
} from 'lucide-react';
import { Badge, StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { useToast } from '@/context/ToastContext';
import { documentService as localDocumentService } from '@/services/documentService';
import type { VaultDocument } from '@/services/types';

interface DocumentInspectorProps {
  document: VaultDocument;
  onRemove: () => void;
  onRetry: () => void;
  onRename?: () => void;
  onUnlink: () => void;
  onOpenRecord: () => void;
}

type TabType = 'preview' | 'facts' | 'history';

export function DocumentInspector({
  document,
  onRemove,
  onRetry,
  onRename,
  onUnlink,
  onOpenRecord,
}: DocumentInspectorProps) {
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState<TabType>('preview');
  const [currentPage, setCurrentPage] = useState(1);
  const [downloading, setDownloading] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const totalPages = document.pageCount ?? 1;
  const isPdf = document.fileType === 'pdf';
  const entities = document.extractedEntities ?? [];
  const history = document.processingHistory ?? [];
  const rules = document.autofillRules ?? ['Personal document', 'Identity reference'];

  const handleDownload = async () => {
    setDownloading(true);
    try {
      await localDocumentService.download(document.id, document.name);
      toast({ tone: 'success', title: 'Original file saved', message: `${document.name} was downloaded from local storage.` });
    } catch (error) {
      toast({ tone: 'error', title: 'Download failed', message: error instanceof Error ? error.message : 'Original file is unavailable.' });
    } finally {
      setDownloading(false);
    }
  };

  const handleView = async () => {
    try {
      await localDocumentService.openInBrowser(document.id);
    } catch (error) {
      toast({ tone: 'error', title: 'Preview failed', message: error instanceof Error ? error.message : 'Original file is unavailable.' });
    }
  };

  const copyFact = (key: string, value: string) => {
    navigator.clipboard.writeText(value);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1500);
    toast({ tone: 'info', title: 'Copied to clipboard', message: `${value}` });
  };

  return (
    <aside className="ff-card ff-inspector" aria-label="Document details and preview">
      {/* Top Header */}
      <div className="ff-inspector__header">
        <div className="ff-row ff-gap-6" style={{ minWidth: 0 }}>
          <Info size={16} className="ff-primary" />
          <span className="ff-h3 ff-truncate" title={document.name}>{document.name}</span>
        </div>
        <div className="ff-row ff-gap-4">
          <a
            href="#"
            onClick={(event) => { event.preventDefault(); void handleView(); }}
            className="ff-btn ff-btn--secondary ff-btn--sm"
            style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11 }}
            title="Open original document from local storage"
          >
            <ExternalLink size={12} /> View
          </a>
          <StatusBadge status={document.status} />
        </div>
      </div>

      {document.status === 'failed' && (
        <div style={{ margin: '8px 0', padding: '8px 12px', background: 'var(--ff-danger-bg, #fef2f2)', border: '1px solid var(--ff-danger-border, #fecaca)', borderRadius: 6, color: 'var(--ff-danger, #b91c1c)', fontSize: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 2 }}>Processing failed</div>
          <div style={{ wordBreak: 'break-word' }}>{document.processingError || document.failureReason || 'Document could not be processed.'}</div>
          <div style={{ marginTop: 6, fontSize: 11 }}>Local document processing will be added in a later phase.</div>
        </div>
      )}

      {/* Tabs */}
      <div className="ff-tabs ff-mb-10" style={{ borderBottom: '1px solid var(--ff-border)' }}>
        <button
          type="button"
          className="ff-tab"
          data-active={activeTab === 'preview'}
          onClick={() => setActiveTab('preview')}
        >
          <Eye size={13} style={{ marginRight: 4, verticalAlign: -1 }} /> Preview
        </button>
        <button
          type="button"
          className="ff-tab"
          data-active={activeTab === 'facts'}
          onClick={() => setActiveTab('facts')}
        >
          <FileCheck2 size={13} style={{ marginRight: 4, verticalAlign: -1 }} /> Facts ({entities.length})
        </button>
        <button
          type="button"
          className="ff-tab"
          data-active={activeTab === 'history'}
          onClick={() => setActiveTab('history')}
        >
          <History size={13} style={{ marginRight: 4, verticalAlign: -1 }} /> Audit ({history.length})
        </button>
      </div>

      {/* TAB 1: Preview */}
      {activeTab === 'preview' && (
        <div>
          <div className="ff-doc-preview" style={{ position: 'relative' }}>
            <div className="ff-doc-preview__paper">
              {document.extractedText ? (
                <div style={{ fontSize: 9, lineHeight: 1.4, color: '#334155', maxHeight: 85, overflow: 'hidden' }}>
                  <div style={{ fontWeight: 600, color: 'var(--ff-primary)', marginBottom: 2 }}>
                    {document.name}
                  </div>
                  <div style={{ opacity: 0.85, whiteSpace: 'pre-line' }}>
                    {document.extractedText.slice(0, 240)}…
                  </div>
                </div>
              ) : null}
            </div>
            <div className="ff-doc-preview__seal" />
            <div className="ff-doc-preview__label">
              <span className="ff-row ff-gap-4">
                <Shield size={13} /> {document.source === 'legacy-import' ? 'Imported from legacy vault' : 'Stored locally'}
              </span>
              <div className="ff-row ff-gap-4">
                {totalPages > 1 && (
                  <button
                    type="button"
                    style={{ border: 0, background: 'rgba(255,255,255,0.2)', color: '#fff', borderRadius: 3, padding: '1px 3px' }}
                    disabled={currentPage <= 1}
                    onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                  >
                    <ChevronLeft size={12} />
                  </button>
                )}
                <span className="ff-code">Page {currentPage} of {totalPages}</span>
                {totalPages > 1 && (
                  <button
                    type="button"
                    style={{ border: 0, background: 'rgba(255,255,255,0.2)', color: '#fff', borderRadius: 3, padding: '1px 3px' }}
                    disabled={currentPage >= totalPages}
                    onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                  >
                    <ChevronRight size={12} />
                  </button>
                )}
              </div>
            </div>
          </div>

          <div className="ff-meta-block ff-mt-10">
            <span className="ff-uppercase" style={{ fontSize: 9 }}>File metadata</span>
            <dl className="ff-meta-grid ff-mt-8">
              <div><dt>File size</dt><dd>{document.sizeLabel}</dd></div>
              <div><dt>Uploaded date</dt><dd>{document.uploadedAt}</dd></div>
              <div><dt>MIME type</dt><dd className="ff-truncate">{document.mimeType}</dd></div>
              <div>
                <dt>Confidence</dt>
                <dd style={{ color: document.confidence && document.confidence >= 90 ? 'var(--ff-success)' : 'var(--ff-warning)', fontWeight: 600 }}>
                  {document.confidence ? `${document.confidence}%` : 'Pending'}
                </dd>
              </div>
              <div className="ff-meta-full">
                <dt>Local storage key</dt>
                <dd className="ff-row ff-gap-4" style={{ fontWeight: 500 }}>
                  <Folder size={12} className="ff-muted" />
                  <span className="ff-truncate" title="IndexedDB document blob">{`file_${document.id}`}</span>
                </dd>
              </div>
            </dl>
          </div>
        </div>
      )}

      {/* TAB 2: Facts & Entities */}
      {activeTab === 'facts' && (
        <div className="ff-scroll" style={{ maxHeight: 320, paddingRight: 2 }}>
          {entities.length > 0 ? (
            <div className="ff-stack ff-gap-6">
              <span className="ff-uppercase" style={{ fontSize: 9, color: 'var(--ff-text-secondary)' }}>
                Structured Values ({entities.length})
              </span>
              {entities.map((fact) => (
                <div
                  key={fact.key}
                  className="ff-row ff-between"
                  style={{
                    padding: '6px 8px',
                    borderRadius: 6,
                    background: 'var(--ff-surface-low)',
                    border: '1px solid var(--ff-border)',
                  }}
                >
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="ff-row ff-gap-4">
                      <span className="ff-label" style={{ fontSize: 10 }}>{fact.label}</span>
                      <span className="ff-code" style={{ fontSize: 9, color: 'var(--ff-text-secondary)' }}>
                        p.{fact.page ?? 1}
                      </span>
                    </div>
                    <div className="ff-body-sm ff-truncate" style={{ fontWeight: 500, marginTop: 1 }} title={fact.value}>
                      {fact.value}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="ff-btn ff-btn--icon-sm"
                    style={{ border: 0, background: 'transparent' }}
                    onClick={() => copyFact(fact.key, fact.value)}
                    title="Copy value"
                  >
                    {copiedKey === fact.key ? <Check size={13} style={{ color: 'var(--ff-success)' }} /> : <Copy size={13} />}
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="ff-note">No structured facts extracted yet. Click Reprocess to run extraction.</div>
          )}

          {document.extractedText && (
            <div className="ff-mt-10">
              <span className="ff-uppercase" style={{ fontSize: 9, color: 'var(--ff-text-secondary)' }}>Extracted Text</span>
              <pre
                style={{
                  fontSize: 10,
                  fontFamily: 'var(--ff-mono)',
                  padding: 8,
                  borderRadius: 6,
                  background: 'var(--ff-surface-low)',
                  border: '1px solid var(--ff-border)',
                  whiteSpace: 'pre-wrap',
                  maxHeight: 120,
                  overflowY: 'auto',
                  marginTop: 4,
                }}
              >
                {document.extractedText}
              </pre>
            </div>
          )}
        </div>
      )}

      {/* TAB 3: History & Audit */}
      {activeTab === 'history' && (
        <div className="ff-scroll" style={{ maxHeight: 320, paddingRight: 2 }}>
          {history.length > 0 ? (
            <div className="ff-stack ff-gap-8">
              {history.map((item) => (
                <div key={item.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <span style={{ marginTop: 2, color: 'var(--ff-primary)' }}><Clock size={13} /></span>
                  <div>
                    <div className="ff-label" style={{ fontSize: 11 }}>{item.action}</div>
                    <div className="ff-body-sm ff-muted" style={{ fontSize: 10 }}>{item.detail}</div>
                    <span className="ff-code ff-muted" style={{ fontSize: 9 }}>{item.timestamp}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="ff-note">No processing history recorded.</div>
          )}
        </div>
      )}

      {/* Linked Identity Profile */}
      <div className="ff-mt-10">
        <div className="ff-row ff-between">
          <span className="ff-uppercase" style={{ fontSize: 9 }}>Linked identity profile</span>
          {document.linkedRecordTitle && (
            <button type="button" className="ff-link-button" style={{ color: 'var(--ff-primary)', fontSize: 11 }} onClick={onOpenRecord}>
              Open Record
            </button>
          )}
        </div>
        {document.linkedRecordTitle ? (
          <div className="ff-linked-record ff-mt-4">
            <span className="ff-linked-record__icon"><FileText size={16} /></span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="ff-label ff-truncate">{document.linkedRecordTitle}</div>
              <div className="ff-body-sm ff-muted ff-truncate">{document.linkedRecordMeta}</div>
            </div>
          </div>
        ) : (
          <div className="ff-note ff-mt-4" style={{ fontSize: 10 }}>No profile record linked yet. Values are still available in the vault.</div>
        )}
      </div>

      {/* Browser Autofill Rules */}
      <div className="ff-mt-10">
        <div className="ff-row ff-gap-6"><Sparkles size={14} className="ff-primary" /><span className="ff-label">Browser autofill rules</span></div>
        <p className="ff-body-sm ff-muted" style={{ marginTop: 2, fontSize: 10 }}>Recommended when website form fields match:</p>
        <div className="ff-tag-row ff-mt-4">
          {rules.map((rule) => (
            <span key={rule} className="ff-tag">{rule}</span>
          ))}
        </div>
      </div>

      {/* Privacy Guarantee Notice */}
      <div className="ff-privacy-note ff-mt-10">
        <Shield size={15} style={{ flexShrink: 0, marginTop: 1 }} />
        <div>
          <div className="ff-label" style={{ fontSize: 10 }}>Strict document custody notice</div>
          <div className="ff-body-sm ff-muted" style={{ fontSize: 10, lineHeight: 1.4 }}>
            Original documents remain in local IndexedDB storage. Removing or modifying records in FormFlow never alters files outside FormFlow.
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="ff-inspector-actions ff-mt-12">
        <Button
          variant="primary"
          icon={Download}
          fullWidth
          loading={downloading}
          onClick={handleDownload}
        >
          Download Document
        </Button>
        <IconButton icon={Download} label="Download original document" onClick={handleDownload} />
        {onRename && (
          <IconButton icon={Pencil} label="Rename document" onClick={onRename} />
        )}
        {document.linkedRecordId && (
          <IconButton icon={Link2Off} label="Unlink from profile record" onClick={onUnlink} />
        )}
        <IconButton icon={Trash2} label="Remove document from FormFlow" onClick={onRemove} />
      </div>

      <div className="ff-row ff-gap-4 ff-mt-6 ff-body-sm ff-muted" style={{ fontSize: 10 }}>
        <Cloud size={12} /> {isPdf ? 'PDF document · local storage' : 'Document file · FormFlow vault'}
      </div>
    </aside>
  );
}
