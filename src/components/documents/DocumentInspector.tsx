import { useEffect, useState } from 'react';
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
import { DocumentStructureView } from '@/components/documents/DocumentStructureView';
import { useToast } from '@/context/ToastContext';
import { documentService as localDocumentService } from '@/services/documentService';
import type { DocumentTextResult, VaultDocument } from '@/services/types';

interface DocumentInspectorProps {
  document: VaultDocument;
  onRemove: () => void;
  onRetry: () => Promise<void> | void;
  onRename?: () => void;
  onUnlink: () => void;
  onOpenRecord: () => void;
}

type TabType = 'preview' | 'structure' | 'facts' | 'history';

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
  const [textResult, setTextResult] = useState<DocumentTextResult | null>(null);
  const [textLoading, setTextLoading] = useState(false);
  const [textError, setTextError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    let active = true;
    setCurrentPage(1);
    setTextResult(null);
    setTextError(null);
    if (document.extractedTextStatus !== 'extracted' && !document.ocrStatus) {
      setTextLoading(false);
      return () => { active = false; };
    }
    setTextLoading(true);
    void localDocumentService.getText(document.id, 400_000)
      .then((result) => {
        if (active) setTextResult(result);
      })
      .catch((error) => {
        if (active) setTextError(error instanceof Error ? error.message : 'Extracted text could not be loaded.');
      })
      .finally(() => {
        if (active) setTextLoading(false);
      });
    return () => { active = false; };
  }, [document.id, document.extractedTextStatus, document.extractedAt, document.modifiedAt]);

  const totalPages = document.pageCount ?? textResult?.pageCount ?? 1;
  const isPdf = document.fileType === 'pdf';
  const entities = document.extractedEntities ?? [];
  const history = document.processingHistory ?? [];
  const rules = document.autofillRules ?? ['Personal document', 'Identity reference'];
  const extractedText = textResult?.text ?? document.extractedText ?? '';
  const warnings = textResult?.warnings ?? document.extractionWarnings ?? [];
  const ocrRequired = Boolean(document.ocrRequired ?? textResult?.ocrRequired);
  const ocr = textResult?.ocr ?? null;
  const ocrStatus = ocr?.status ?? document.ocrStatus ?? 'not_required';
  const ocrConfidence = ocr?.averageConfidence ?? document.ocrConfidence;
  const ocrLanguage = ocr?.language ?? document.ocrLanguage;
  const ocrPagesCompleted = ocr?.pagesCompleted ?? document.ocrPagesCompleted;
  const ocrPagesTotal = ocr?.pagesAttempted ?? document.ocrPagesTotal;
  const ocrIncomplete = ocrStatus === 'failed' || ocrStatus === 'partial';
  const pageText = textResult?.pageTexts[currentPage - 1] ?? (currentPage === 1 ? extractedText : '');
  const extractionFailed = (document.status === 'failed' || document.extractedTextStatus === 'failed') && !ocrIncomplete;

  const handleRetry = async () => {
    setRetrying(true);
    try {
      await onRetry();
    } catch {
      // The app-level toast reports the failure; keep the inspector usable.
    } finally {
      setRetrying(false);
    }
  };

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

      {extractionFailed && (
        <div style={{ margin: '8px 0', padding: '8px 12px', background: 'var(--ff-danger-bg, #fef2f2)', border: '1px solid var(--ff-danger-border, #fecaca)', borderRadius: 6, color: 'var(--ff-danger, #b91c1c)', fontSize: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 2 }}>Processing failed</div>
          <div style={{ wordBreak: 'break-word' }}>{document.processingError || document.failureReason || 'Document could not be processed.'}</div>
          <Button
            variant="secondary"
            icon={RefreshCw}
            loading={retrying}
            onClick={() => void handleRetry()}
            style={{ marginTop: 7 }}
          >
            Retry local extraction
          </Button>
        </div>
      )}

      {!extractionFailed && ocrIncomplete && (
        <div style={{ margin: '8px 0', padding: '8px 12px', background: 'var(--ff-warning-bg, #fffbeb)', border: '1px solid var(--ff-warning-border, #fde68a)', borderRadius: 6, color: 'var(--ff-warning, #92400e)', fontSize: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 2 }}>
            {ocrStatus === 'partial' ? 'OCR partially completed' : 'OCR failed'}
          </div>
          <div>
            {ocrPagesCompleted !== undefined && ocrPagesTotal !== undefined
              ? `${ocrPagesCompleted} of ${ocrPagesTotal} required page${ocrPagesTotal === 1 ? '' : 's'} recognized${ocrLanguage ? ` with ${ocrLanguage}` : ''}. `
              : ''}
            Pages that require OCR are still marked for review. The original file and any existing extracted text remain intact.
          </div>
          <Button
            variant="secondary"
            icon={RefreshCw}
            loading={retrying}
            onClick={() => void handleRetry()}
            style={{ marginTop: 7 }}
          >
            Retry local OCR
          </Button>
        </div>
      )}

      {!extractionFailed && !ocrIncomplete && ocrRequired && (
        <div style={{ margin: '8px 0', padding: '8px 12px', background: 'var(--ff-warning-bg, #fffbeb)', border: '1px solid var(--ff-warning-border, #fde68a)', borderRadius: 6, color: 'var(--ff-warning, #92400e)', fontSize: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 2 }}>OCR required</div>
          <div>One or more pages contain little or no extractable text. Local OCR has not completed for these pages.</div>
          <Button
            variant="secondary"
            icon={RefreshCw}
            loading={retrying}
            onClick={() => void handleRetry()}
            style={{ marginTop: 7 }}
          >
            Run local OCR
          </Button>
        </div>
      )}

      {textError ? (
        <div className="ff-note" style={{ margin: '8px 0', color: 'var(--ff-danger)', fontSize: 11 }}>
          Extracted text could not be loaded: {textError}
        </div>
      ) : null}

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
          data-active={activeTab === 'structure'}
          onClick={() => setActiveTab('structure')}
        >
          <FileText size={13} style={{ marginRight: 4, verticalAlign: -1 }} /> Structure
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
              <div style={{ fontSize: 9, lineHeight: 1.4, color: '#334155', maxHeight: 110, overflow: 'hidden' }}>
                <div style={{ fontWeight: 600, color: 'var(--ff-primary)', marginBottom: 2 }}>
                  {document.name}
                </div>
                {textLoading ? (
                  <div className="ff-row ff-gap-4" style={{ opacity: 0.75 }}>
                    <Loader2 size={11} className="ff-spin" /> Loading extracted text…
                  </div>
                ) : pageText ? (
                  <div style={{ opacity: 0.88, whiteSpace: 'pre-line' }}>
                    {pageText.slice(0, 1_200)}{pageText.length > 1_200 ? '…' : ''}
                  </div>
                ) : (
                  <div style={{ opacity: 0.75 }}>
                    {ocrStatus === 'completed'
                      ? 'OCR completed, but no text was recognized on this page.'
                      : ocrIncomplete
                        ? 'OCR did not recognize text on this page.'
                        : 'No extracted text is available for this page.'}
                  </div>
                )}
              </div>
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
              <div><dt>Pages</dt><dd>{totalPages}</dd></div>
              <div><dt>MIME type</dt><dd className="ff-truncate">{document.mimeType}</dd></div>
              <div>
                <dt>Extraction</dt>
                <dd style={{ color: extractionFailed || ocrStatus === 'failed' ? 'var(--ff-danger)' : ocrIncomplete ? 'var(--ff-warning)' : 'var(--ff-success)', fontWeight: 600 }}>
                  {extractionFailed
                    ? 'Failed'
                    : ocrStatus === 'completed'
                      ? 'OCR completed'
                      : ocrStatus === 'partial'
                        ? 'OCR partial'
                        : ocrStatus === 'failed'
                          ? 'OCR failed'
                          : ocrRequired
                            ? 'OCR required'
                            : document.extractedTextStatus === 'extracted'
                              ? 'Extracted'
                              : 'Pending'}
                </dd>
              </div>
              {ocrLanguage ? (
                <div><dt>OCR language</dt><dd>{ocrLanguage}</dd></div>
              ) : null}
              {typeof ocrConfidence === 'number' ? (
                <div><dt>OCR confidence</dt><dd>{ocrConfidence}% average</dd></div>
              ) : null}
              {ocrPagesTotal !== undefined ? (
                <div><dt>OCR pages</dt><dd>{ocrPagesCompleted ?? 0} of {ocrPagesTotal} completed</dd></div>
              ) : null}
              <div><dt>Warnings</dt><dd>{warnings.length}</dd></div>
              <div><dt>Extracted</dt><dd>{document.extractedAt ? new Date(document.extractedAt).toLocaleString() : 'Not available'}</dd></div>
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

      {/* TAB 2: Structure */}
      {activeTab === 'structure' && (
        textLoading ? (
          <div className="ff-row ff-gap-4" style={{ opacity: 0.75, fontSize: 11 }}>
            <Loader2 size={12} className="ff-spin" /> Loading structured extraction…
          </div>
        ) : textResult?.structure ? (
          <DocumentStructureView structure={textResult.structure} />
        ) : (
          <div className="ff-note">
            No structured layout is available for this document. The plain-text preview and original file remain available.
          </div>
        )
      )}

      {/* TAB 3: Facts & Entities */}
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
            <div className="ff-note">No structured facts are extracted in Phase 4.1. Text extraction results are shown below; field extraction belongs to a later phase.</div>
          )}

          {warnings.length ? (
            <div className="ff-mt-10">
              <span className="ff-uppercase" style={{ fontSize: 9, color: 'var(--ff-text-secondary)' }}>Extraction warnings</span>
              <div className="ff-stack ff-gap-4" style={{ marginTop: 4 }}>
                {warnings.map((item, index) => (
                  <div key={`${item.code}-${item.page ?? 'doc'}-${index}`} className="ff-body-sm" style={{ color: 'var(--ff-warning, #92400e)' }}>
                    {item.page ? `Page ${item.page}: ` : ''}{item.message}
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {extractedText ? (
            <div className="ff-mt-10">
              <span className="ff-uppercase" style={{ fontSize: 9, color: 'var(--ff-text-secondary)' }}>
                {ocrStatus === 'completed' || ocrStatus === 'partial' ? 'Recognized Text (local OCR)' : 'Extracted Text'}
              </span>
              {typeof ocrConfidence === 'number' ? (
                <span className="ff-body-sm ff-muted" style={{ fontSize: 10, marginLeft: 6 }}>
                  {ocrConfidence}% average confidence{ocrLanguage ? ` · ${ocrLanguage}` : ''}
                </span>
              ) : null}
              <pre
                style={{
                  fontSize: 10,
                  fontFamily: 'var(--ff-mono)',
                  padding: 8,
                  borderRadius: 6,
                  background: 'var(--ff-surface-low)',
                  border: '1px solid var(--ff-border)',
                  whiteSpace: 'pre-wrap',
                  maxHeight: 160,
                  overflowY: 'auto',
                  marginTop: 4,
                }}
              >
                {extractedText}
              </pre>
            </div>
          ) : (
            <div className="ff-note" style={{ marginTop: 10 }}>
              {ocrIncomplete
                ? 'OCR did not recognize text. The original file is preserved and local OCR can be retried.'
                : ocrRequired
                  ? 'This document is marked OCR-required. No recognized text is available yet.'
                  : 'No extracted text is available.'}
            </div>
          )}
        </div>
      )}

      {/* TAB 4: History & Audit */}
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
        <IconButton icon={RefreshCw} label="Reprocess text extraction" onClick={() => void handleRetry()} />
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
