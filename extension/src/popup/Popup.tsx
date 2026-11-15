import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCircle2,
  Copy,
  Download,
  ExternalLink,
  FileText,
  FolderLock,
  FolderOpen,
  Globe2,
  History,
  Loader2,
  Pencil,
  RefreshCw,
  Search,
  Settings,
  Shield,
  ShieldCheck,
  Sparkles,
  Upload,
  User,
  Zap,
} from 'lucide-react';
import {
  classifyField,
  generateGroundedAnswer,
  kindToVaultKey,
  matchOption,
  extractBranchFromDegree,
  type FieldKind,
} from '../lib/classifier';
import {
  demoCollections,
  demoVault,
  recommendDocumentsForUploadField,
  vaultForCollection,
  vaultRecord,
  type DemoCollection,
  type DemoVaultValue,
} from '../lib/vault';

interface ScanField {
  index: number;
  label: string;
  kind: FieldKind;
  confidence: number;
  sensitive: boolean;
  tag: string;
  type: string;
  questionType?: string;
  required: boolean;
  currentValue: string;
  options?: string[];
  unsupported?: boolean;
  unsupportedReason?: string;
}

interface ScanUploadField {
  index: number;
  label: string;
  name: string;
  id: string;
  accept: string;
  required: boolean;
}

interface ScanData {
  url: string;
  title: string;
  adapter?: string;
  isGoogleForms?: boolean;
  isEditor?: boolean;
  editorMessage?: string;
  fields: ScanField[];
  uploadFields?: ScanUploadField[];
  forms: number;
}

interface State {
  connection: { connected: boolean; accountEmail: string; version: string; lastSync: string };
  settings: { confirmBeforeAutofill: boolean; requireSensitiveReview: boolean; allowLongAnswers: boolean };
  history: Array<{ id: string; website: string; url: string; timestamp: string; detected: number; filled: number; skipped: number; status: string }>;
}

interface Match {
  field: ScanField;
  vault?: DemoVaultValue;
  value: string;
  source: string;
  confidence: number;
  conflict: boolean;
  unmatched: boolean;
  needReview: boolean;
  unsupported: boolean;
  unsupportedReason?: string;
}

type TabMode = 'autofill' | 'documents' | 'profile';
type View = 'main' | 'settings' | 'history' | 'complete';

const fallbackState: State = {
  connection: { connected: false, accountEmail: '', version: '1.4.0', lastSync: 'Not connected' },
  settings: { confirmBeforeAutofill: true, requireSensitiveReview: true, allowLongAnswers: true },
  history: [],
};

async function send<T>(message: unknown): Promise<T> {
  const response = (await chrome.runtime.sendMessage(message)) as { ok: boolean; data: T; error?: string };
  if (!response?.ok) throw new Error(response?.error ?? 'Extension request failed.');
  return response.data;
}

function buildMatches(fields: ScanField[], vault: DemoVaultValue[]): Match[] {
  const byKey = new Map(vault.map((item) => [item.key, item]));
  const record = vaultRecord(vault);

  return fields.map((field) => {
    if (field.unsupported) {
      return {
        field,
        value: '',
        source: '',
        confidence: 0,
        conflict: false,
        unmatched: true,
        needReview: false,
        unsupported: true,
        unsupportedReason: field.unsupportedReason || 'Unsupported field type',
      };
    }

    const key = kindToVaultKey[field.kind];
    let item = key ? byKey.get(key) : undefined;

    // Derived branch fallback if branch field but no explicit education.branch in vault
    if (!item && field.kind === 'branch' && record['education.branch']) {
      const branchVal = record['education.branch'];
      const degreeItem = byKey.get('education.degree');
      item = {
        key: 'education.branch',
        label: 'Branch / Major',
        value: branchVal,
        source: degreeItem?.sourceDocumentName || degreeItem?.source || 'Document Vault',
        confidence: degreeItem?.confidence || 92,
      };
    }

    // Derived semester fallback
    if (!item && field.kind === 'semester' && record['education.semester']) {
      const semVal = record['education.semester'];
      item = {
        key: 'education.semester',
        label: 'Semester',
        value: semVal,
        source: 'Document Vault',
        confidence: 90,
      };
    }

    // Grounded long answer for essay/motivation questions
    const generated = field.kind === 'longAnswer' ? generateGroundedAnswer(field.kind, record) : null;

    let valueToUse = item?.value ?? generated ?? '';
    let confidence = item?.confidence ?? (generated ? 75 : field.confidence);
    let needReview = false;

    // Predefined Option Matching (Radio buttons, checkboxes, dropdowns)
    if (field.options && field.options.length > 0 && item?.value) {
      const optMatch = matchOption(item.value, field.options, field.kind);
      if (optMatch) {
        valueToUse = optMatch.match;
        confidence = Math.min(confidence, optMatch.confidence);
      } else {
        // Vault has a value, but it does NOT match available options reliably!
        // Never fabricate an answer; prompt user for review
        valueToUse = '';
        confidence = 0;
        needReview = true;
      }
    }

    const unmatched = !valueToUse;

    return {
      field,
      vault: item,
      value: valueToUse,
      source: item?.sourceDocumentName || item?.source || (generated ? 'Document Vault' : ''),
      confidence,
      conflict: Boolean(item?.alternates?.length),
      unmatched,
      needReview,
      unsupported: false,
    };
  });
}

export function Popup() {
  const [state, setState] = useState<State>(fallbackState);
  const [vault, setVault] = useState<DemoVaultValue[]>([]);
  const [collections, setCollections] = useState<DemoCollection[]>(demoCollections);
  const [view, setView] = useState<View>('main');
  const [activeTab, setActiveTab] = useState<TabMode>('autofill');
  const [scan, setScan] = useState<ScanData | null>(null);
  const [tabTitle, setTabTitle] = useState('');
  const [tabUrl, setTabUrl] = useState('');
  const [scanning, setScanning] = useState(false);
  const [filling, setFilling] = useState(false);
  const [error, setError] = useState('');
  const [matches, setMatches] = useState<Match[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [overrides, setOverrides] = useState<Record<number, string>>({});
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [sensitiveApproved, setSensitiveApproved] = useState(false);
  const [result, setResult] = useState<{ filled: number; failed: number; skipped: Array<{ index: number; reason: string }> } | null>(null);
  const [collectionId, setCollectionId] = useState('all');
  const [downloadingDocs, setDownloadingDocs] = useState<Record<string, boolean>>({});
  const [downloadedDocs, setDownloadedDocs] = useState<Record<string, boolean>>({});
  const [profileSearch, setProfileSearch] = useState('');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const hostname = useMemo(() => {
    if (!tabUrl) return 'docs.google.com';
    try {
      const u = new URL(tabUrl);
      return u.hostname;
    } catch {
      return tabUrl;
    }
  }, [tabUrl]);

  const loadState = useCallback(async () => {
    try {
      const next = await send<State>({ type: 'GET_STATE' });
      setState(next);
    } catch {
      setState(fallbackState);
    }
  }, []);

  const loadVault = useCallback(async () => {
    try {
      const res = await send<{ vault: DemoVaultValue[]; collections: DemoCollection[]; user: any }>({
        type: 'GET_VAULT',
      });
      if (res?.vault && res.vault.length > 0) {
        setVault(res.vault);
        if (res.collections?.length) {
          setCollections([{ id: 'all', name: 'All vault documents', description: 'All', sources: [] }, ...res.collections]);
        }
      } else {
        // Trigger background sync with backend
        const syncRes = await send<{ synced: boolean; vault: DemoVaultValue[]; collections: DemoCollection[]; user: any }>({
          type: 'SYNC_VAULT',
        });
        if (syncRes?.vault?.length) {
          setVault(syncRes.vault);
          if (syncRes.collections?.length) {
            setCollections([{ id: 'all', name: 'All vault documents', description: 'All', sources: [] }, ...syncRes.collections]);
          }
        }
      }
    } catch {
      // Non-blocking
    }
  }, []);

  const scanPage = useCallback(async () => {
    setScanning(true);
    setError('');
    setResult(null);
    try {
      const data = await send<{ tab: { url: string; title: string }; scan: ScanData }>({ type: 'SCAN_ACTIVE_TAB' });
      setScan(data.scan);
      setTabTitle(data.tab.title || data.scan.title);
      setTabUrl(data.tab.url || data.scan.url);

      const scopedVault = vaultForCollection(collectionId, vault, collections);
      const nextMatches = buildMatches(data.scan.fields, scopedVault);
      setMatches(nextMatches);
      setSelected(
        nextMatches
          .filter((match) => !match.unmatched && !match.conflict && !match.needReview && !match.unsupported)
          .map((match) => match.field.index)
      );
      setOverrides({});
      setSensitiveApproved(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to scan this page.');
      setScan(null);
    } finally {
      setScanning(false);
    }
  }, [collectionId, vault, collections]);

  useEffect(() => {
    void loadState().then(() => {
      void loadVault().then(() => {
        void scanPage();
      });
    });
  }, [loadState, loadVault]);

  useEffect(() => {
    if (!scan) return;
    const scopedVault = vaultForCollection(collectionId, vault, collections);
    const nextMatches = buildMatches(scan.fields, scopedVault);
    setMatches(nextMatches);
    setSelected(
      nextMatches
        .filter((match) => !match.unmatched && !match.conflict && !match.needReview && !match.unsupported)
        .map((match) => match.field.index)
    );
  }, [collectionId, scan, vault, collections]);

  const toggleSelectAll = () => {
    if (selected.length === matches.length) {
      setSelected([]);
    } else {
      setSelected(matches.map((m) => m.field.index));
    }
  };

  const toggleSelected = (index: number) => {
    setSelected((curr) => (curr.includes(index) ? curr.filter((i) => i !== index) : [...curr, index]));
  };

  const valueFor = (match: Match) => overrides[match.field.index] ?? match.value;

  const selectedMatches = matches.filter((match) => selected.includes(match.field.index));
  const sensitiveSelected = selectedMatches.some((match) => match.field.sensitive || match.vault?.sensitive);

  const fillSelected = async () => {
    if (sensitiveSelected && state.settings.requireSensitiveReview && !sensitiveApproved) {
      setError('Please review and check the confirmation for sensitive identification values before filling.');
      return;
    }
    setFilling(true);
    setError('');
    try {
      const fills = selectedMatches
        .filter((match) => valueFor(match).trim())
        .map((match) => ({ index: match.field.index, value: valueFor(match).trim() }));

      const data = await send<{ result: { filled: number; failed: number; skipped: Array<{ index: number; reason: string }> } }>({
        type: 'FILL_ACTIVE_TAB',
        fills,
      });

      setResult(data.result);
      setView('complete');

      await send({
        type: 'RECORD_HISTORY',
        website: tabTitle || hostname,
        url: tabUrl,
        detected: matches.length,
        filled: data.result.filled,
        skipped: matches.length - data.result.filled,
        status: data.result.failed ? 'Partially completed' : 'Completed',
      });
      await loadState();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Autofill failed.');
    } finally {
      setFilling(false);
    }
  };

  const triggerDownloadAnimation = (docName: string) => {
    setDownloadingDocs((curr) => ({ ...curr, [docName]: true }));
    setTimeout(() => {
      setDownloadingDocs((curr) => ({ ...curr, [docName]: false }));
      setDownloadedDocs((curr) => ({ ...curr, [docName]: true }));
      setTimeout(() => {
        setDownloadedDocs((curr) => ({ ...curr, [docName]: false }));
      }, 2500);
    }, 750);
  };

  const copyProfileValue = (key: string, val: string) => {
    navigator.clipboard.writeText(val);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1500);
  };

  // Filtered vault values for Profile tab
  const filteredVault = useMemo(() => {
    const list = vault.length > 0 ? vault : demoVault;
    if (!profileSearch.trim()) return list;
    const q = profileSearch.toLowerCase();
    return list.filter((item) => item.label.toLowerCase().includes(q) || item.value.toLowerCase().includes(q));
  }, [profileSearch, vault]);

  const totalQuestions = scan?.fields?.length ?? matches.length;
  const matchedCount = matches.filter((m) => !m.unmatched && !m.needReview && !m.unsupported).length;
  const needReviewCount = matches.filter((m) => m.needReview || m.conflict).length;
  const unsupportedCount = matches.filter((m) => m.unsupported).length;

  return (
    <div className="ffp">
      {/* Top Header */}
      <header className="ffp-head">
        <div className="ffp-brand">
          <div className="ffp-logo">
            <Zap size={16} fill="currentColor" />
          </div>
          <div className="ffp-brand-info">
            <div className="ffp-brand-title">
              <span>FormFlow</span>
              <span className="ffp-brand-tag">v{state.connection.version}</span>
            </div>
            <div className="ffp-host-chip">
              <span className={`ffp-dot ${state.connection.connected ? 'is-online' : ''}`} />
              <span>{hostname}</span>
            </div>
          </div>
        </div>

        <div className="ffp-head-actions">
          <button
            type="button"
            className={`ffp-head-btn ${view === 'history' ? 'is-active' : ''}`}
            onClick={() => setView(view === 'history' ? 'main' : 'history')}
            title="Autofill History"
          >
            <History size={15} />
          </button>
          <button
            type="button"
            className={`ffp-head-btn ${view === 'settings' ? 'is-active' : ''}`}
            onClick={() => setView(view === 'settings' ? 'main' : 'settings')}
            title="Extension Settings"
          >
            <Settings size={15} />
          </button>
          <button
            type="button"
            className="ffp-avatar-btn"
            onClick={() => setActiveTab('profile')}
            title="View Profile Vault"
          >
            {state.connection.accountEmail ? state.connection.accountEmail.slice(0, 2).toUpperCase() : 'FF'}
          </button>
        </div>
      </header>

      {/* Main Body */}
      {view === 'history' ? (
        <>
          <div className="ffp-subhead">
            <button type="button" className="ffp-back" onClick={() => setView('main')}>
              <ArrowLeft size={14} /> Back
            </button>
            <strong>Form Autofill History</strong>
          </div>
          <div className="ffp-body">
            {state.history.length ? (
              state.history.map((item) => (
                <div key={item.id} className="ffp-card" style={{ padding: 8 }}>
                  <div className="ffp-card-header">
                    <span className="ffp-card-title">{item.website}</span>
                    <span className="ffp-card-badge">{item.status}</span>
                  </div>
                  <div className="ffp-card-sub">
                    <span>{item.filled} of {item.detected} fields filled</span>
                    <span style={{ fontSize: 9 }}>{item.timestamp}</span>
                  </div>
                </div>
              ))
            ) : (
              <div className="ffp-center" style={{ padding: 24, color: 'var(--muted)' }}>
                No recent autofills on record.
              </div>
            )}
          </div>
        </>
      ) : view === 'settings' ? (
        <>
          <div className="ffp-subhead">
            <button type="button" className="ffp-back" onClick={() => setView('main')}>
              <ArrowLeft size={14} /> Back
            </button>
            <strong>Autofill Safeguards</strong>
          </div>
          <div className="ffp-body">
            <div className="ffp-card">
              <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 0', cursor: 'pointer' }}>
                <span style={{ fontSize: 11, fontWeight: 500 }}>Confirm before autofill</span>
                <input
                  type="checkbox"
                  checked={state.settings.confirmBeforeAutofill}
                  onChange={(e) => void send({ type: 'UPDATE_SETTINGS', settings: { confirmBeforeAutofill: e.target.checked } }).then(loadState)}
                />
              </label>
              <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 0', borderTop: '1px solid var(--border)', cursor: 'pointer' }}>
                <span style={{ fontSize: 11, fontWeight: 500 }}>Require review for sensitive fields</span>
                <input
                  type="checkbox"
                  checked={state.settings.requireSensitiveReview}
                  onChange={(e) => void send({ type: 'UPDATE_SETTINGS', settings: { requireSensitiveReview: e.target.checked } }).then(loadState)}
                />
              </label>
              <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 0', borderTop: '1px solid var(--border)', cursor: 'pointer' }}>
                <span style={{ fontSize: 11, fontWeight: 500 }}>Allow grounded long answers</span>
                <input
                  type="checkbox"
                  checked={state.settings.allowLongAnswers}
                  onChange={(e) => void send({ type: 'UPDATE_SETTINGS', settings: { allowLongAnswers: e.target.checked } }).then(loadState)}
                />
              </label>
            </div>
            <div className="ffp-safeguard">
              <ShieldCheck size={14} style={{ color: 'var(--success)', flexShrink: 0 }} />
              <span>Zero-knowledge client mode: FormFlow never sends credentials or unencrypted forms to third-party servers.</span>
            </div>
          </div>
        </>
      ) : view === 'complete' ? (
        <div className="ffp-body ffp-center" style={{ gap: 12 }}>
          <div style={{ width: 44, height: 44, borderRadius: '50%', background: '#ecfdf5', color: 'var(--success)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <CheckCircle2 size={26} />
          </div>
          <div>
            <h3 style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>Autofill completed</h3>
            <p style={{ fontSize: 11, color: 'var(--secondary)', marginTop: 4 }}>
              Populated {result?.filled ?? selectedMatches.length} approved fields on {hostname}.
            </p>
          </div>
          <div className="ffp-safeguard" style={{ textAlign: 'left', width: '100%' }}>
            <Shield size={14} style={{ color: 'var(--success)', flexShrink: 0 }} />
            <span>FormFlow never clicks submit. Review all inputs on the page before submitting your application.</span>
          </div>
          <button type="button" className="ffp-btn-primary" onClick={() => setView('main')}>
            Done
          </button>
        </div>
      ) : (
        <>
          {/* TAB 1: AUTOFILL */}
          {activeTab === 'autofill' && (
            <div className="ffp-body">
              {/* Host Context Card */}
              <div className="ffp-card">
                <div className="ffp-card-header">
                  <div className="ffp-card-title">
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--success)' }} />
                    <span className="ff-truncate">{tabTitle || hostname}</span>
                  </div>
                  <span className="ffp-card-badge">
                    {scan?.adapter || 'Form'}
                  </span>
                </div>
                <div className="ffp-card-sub">
                  <span>Review profile values before autofill</span>
                  <div className="ffp-links-row">
                    <button type="button" className="ffp-action-link" onClick={toggleSelectAll}>
                      {selected.length === matches.length ? 'Deselect all' : 'Select all'}
                    </button>
                  </div>
                </div>
              </div>

              {/* Google Forms Editor Alert Banner */}
              {scan?.isEditor && (
                <div className="ffp-card ffp-editor-banner">
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                    <div className="ffp-editor-icon">
                      <AlertTriangle size={18} />
                    </div>
                    <div>
                      <h4 style={{ fontSize: 12, fontWeight: 700, margin: '0 0 4px 0', color: '#92400e' }}>
                        Google Forms Editor Detected
                      </h4>
                      <p style={{ fontSize: 11, margin: 0, color: '#78350f', lineHeight: 1.4 }}>
                        {scan.editorMessage || 'Google Forms editor detected. Open Preview or the responder link to fill the form.'}
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="ffp-btn-secondary"
                    style={{ marginTop: 12, width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                    onClick={() => {
                      const previewUrl = tabUrl.replace(/\/edit(\?|\/|$).*/i, '/viewform');
                      void send({ type: 'OPEN_TAB', url: previewUrl });
                    }}
                  >
                    <ExternalLink size={13} />
                    Open Responder Preview
                  </button>
                </div>
              )}

              {/* Scanning summary breakdown bar */}
              {scan && !scan.isEditor && totalQuestions > 0 && (
                <div className="ffp-summary-bar">
                  <div className="ffp-summary-title">
                    <strong>{scan.adapter || 'Form'} detected</strong>
                    <span>{totalQuestions} {totalQuestions === 1 ? 'question' : 'questions'} found</span>
                  </div>
                  <div className="ffp-summary-pills">
                    <span className="ffp-pill ffp-pill--success">{matchedCount} matched</span>
                    {needReviewCount > 0 && (
                      <span className="ffp-pill ffp-pill--warning">{needReviewCount} need review</span>
                    )}
                    {unsupportedCount > 0 && (
                      <span className="ffp-pill ffp-pill--neutral">{unsupportedCount} unsupported</span>
                    )}
                  </div>
                </div>
              )}

              {/* Collection Context Filter */}
              <div className="ffp-scope-bar">
                <span style={{ color: 'var(--muted)', fontWeight: 600 }}>Collection:</span>
                <select value={collectionId} onChange={(e) => setCollectionId(e.target.value)}>
                  {collections.map((col) => (
                    <option key={col.id} value={col.id}>
                      {col.name}
                    </option>
                  ))}
                </select>
              </div>

              {error && (
                <div className="ffp-safeguard" style={{ background: '#fef2f2', borderColor: '#fecaca', color: '#991b1b' }}>
                  <AlertTriangle size={14} />
                  <span>{error}</span>
                </div>
              )}

              {/* Form Fields List */}
              {scanning ? (
                <div className="ffp-center" style={{ padding: 24, gap: 8 }}>
                  <Loader2 size={20} className="ffp-spin" style={{ color: 'var(--primary)' }} />
                  <span style={{ fontSize: 11, color: 'var(--secondary)' }}>Analyzing page form fields…</span>
                </div>
              ) : matches.length > 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {matches.map((match) => {
                    const isChecked = selected.includes(match.field.index);
                    const currentVal = valueFor(match);
                    const isEditing = editingIndex === match.field.index;
                    const conf = match.confidence >= 90 ? 'is-high' : match.confidence >= 65 ? 'is-med' : 'is-low';

                    return (
                      <div key={match.field.index} className={`ffp-field-row ${isChecked ? 'is-selected' : ''}`}>
                        <div className="ffp-field-top">
                          <label className="ffp-field-main">
                            <input
                              type="checkbox"
                              className="ffp-checkbox"
                              checked={isChecked}
                              onChange={() => toggleSelected(match.field.index)}
                              disabled={match.unsupported}
                            />
                            <span className="ffp-field-name">
                              {match.field.label}
                              {match.field.required && <span style={{ color: 'var(--danger)', marginLeft: 3 }}>*</span>}
                            </span>
                          </label>

                          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            {!isEditing ? (
                              <span className="ffp-field-value" title={currentVal}>
                                {currentVal || (
                                  <span style={{ color: match.needReview ? 'var(--warning)' : 'var(--muted)', fontStyle: 'italic' }}>
                                    {match.unsupported ? 'unsupported' : match.needReview ? 'needs selection' : 'empty'}
                                  </span>
                                )}
                              </span>
                            ) : null}
                            {!match.unsupported && (
                              <button
                                type="button"
                                style={{ border: 0, background: 'transparent', color: 'var(--muted)', padding: 0 }}
                                onClick={() => setEditingIndex(isEditing ? null : match.field.index)}
                                title="Edit suggestion"
                              >
                                <Pencil size={11} />
                              </button>
                            )}
                          </div>
                        </div>

                        {/* Inline editing if clicked or options selector */}
                        {isEditing && (
                          <div style={{ paddingLeft: 20 }}>
                            {match.field.options && match.field.options.length > 0 ? (
                              <select
                                value={currentVal}
                                onChange={(e) => setOverrides((curr) => ({ ...curr, [match.field.index]: e.target.value }))}
                                style={{ width: '100%', height: 26, fontSize: 11, borderRadius: 4, border: '1px solid var(--primary-bright)' }}
                              >
                                <option value="">-- Choose option --</option>
                                {match.field.options.map((opt) => (
                                  <option key={opt} value={opt}>{opt}</option>
                                ))}
                              </select>
                            ) : (
                              <input
                                type="text"
                                value={currentVal}
                                onChange={(e) => setOverrides((curr) => ({ ...curr, [match.field.index]: e.target.value }))}
                                style={{
                                  width: '100%',
                                  height: 24,
                                  fontSize: 11,
                                  padding: '0 6px',
                                  border: '1px solid var(--primary-bright)',
                                  borderRadius: 4,
                                  outline: 'none',
                                }}
                                autoFocus
                              />
                            )}
                          </div>
                        )}

                        {/* Metadata: Source + Confidence */}
                        <div className="ffp-field-meta">
                          <span className="ffp-source-chip" title={match.source || 'Vault document'}>
                            <FileText size={9} /> {match.source || (match.unsupported ? 'Unsupported' : 'Manual review')}
                          </span>
                          {!match.unsupported && (
                            <span className={`ffp-conf-badge ${conf}`}>{match.confidence}%</span>
                          )}
                          {match.field.questionType && (
                            <span style={{ fontSize: 9, color: 'var(--muted)', background: 'var(--surface-container)', padding: '1px 5px', borderRadius: 4 }}>
                              {match.field.questionType}
                            </span>
                          )}
                        </div>

                        {/* Need Review Notice */}
                        {match.needReview && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, color: 'var(--warning)', marginTop: 4, paddingLeft: 20 }}>
                            <AlertTriangle size={11} /> Ambiguous choice. Click edit to choose from available options.
                          </div>
                        )}

                        {/* Conflict Selector if multiple sources */}
                        {match.conflict && match.vault?.alternates?.length && (
                          <div className="ffp-conflict-box">
                            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                              <AlertTriangle size={11} /> Conflicting value in another document:
                            </div>
                            <select
                              value={currentVal}
                              onChange={(e) => setOverrides((curr) => ({ ...curr, [match.field.index]: e.target.value }))}
                            >
                              <option value={match.vault.value}>{match.vault.value} ({match.vault.source})</option>
                              {match.vault.alternates.map((alt) => (
                                <option key={alt.source} value={alt.value}>{alt.value} ({alt.source})</option>
                              ))}
                            </select>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : !scan?.isEditor ? (
                <div className="ffp-card ffp-center" style={{ padding: 24 }}>
                  <Sparkles size={22} style={{ color: 'var(--primary)', marginBottom: 6 }} />
                  <span style={{ fontSize: 11, fontWeight: 600 }}>No form fields detected</span>
                  <span style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2 }}>
                    Open a page with inputs or textareas to review suggestions.
                  </span>
                  <button
                    type="button"
                    className="ffp-action-link"
                    style={{ marginTop: 8 }}
                    onClick={() => void scanPage()}
                  >
                    Rescan page
                  </button>
                </div>
              ) : null}

              {/* Safeguard Review Notice */}
              {sensitiveSelected && (
                <label className="ffp-safeguard" style={{ cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={sensitiveApproved}
                    onChange={(e) => setSensitiveApproved(e.target.checked)}
                  />
                  <span>I have verified the sensitive government identification and registration numbers for this form.</span>
                </label>
              )}

              {/* Submit / Fill Button */}
              {matches.length > 0 && !scan?.isEditor && (
                <button
                  type="button"
                  className="ffp-btn-primary"
                  onClick={fillSelected}
                  disabled={filling || selected.length === 0}
                >
                  {filling ? (
                    <>
                      <Loader2 size={14} className="ffp-spin" /> Filling approved fields…
                    </>
                  ) : (
                    <>
                      <Zap size={14} fill="currentColor" /> Fill {selected.length} Approved Fields
                    </>
                  )}
                </button>
              )}
            </div>
          )}

          {/* TAB 2: DOCUMENTS */}
          {activeTab === 'documents' && (
            <div className="ffp-body">
              <div className="ffp-card" style={{ background: 'var(--surface-low)' }}>
                <div className="ffp-card-header" style={{ marginBottom: 0 }}>
                  <div className="ffp-card-title">
                    <Globe2 size={14} style={{ color: 'var(--primary)' }} />
                    <span className="ff-truncate">{hostname}</span>
                  </div>
                  <span style={{ fontSize: 10, color: 'var(--secondary)' }}>Vault Documents</span>
                </div>
              </div>

              <div className="ffp-doc-card">
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text)' }}>Verified Credentials</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
                  <p style={{ fontSize: 10, color: 'var(--secondary)', margin: 0 }}>
                    Documents stored in your private FormFlow vault are used to verify and match form questions automatically.
                  </p>
                  <button
                    type="button"
                    style={{
                      height: 28,
                      borderRadius: 6,
                      border: '1px solid var(--border)',
                      background: 'var(--surface)',
                      fontSize: 11,
                      fontWeight: 600,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 6,
                      color: 'var(--primary)',
                      marginTop: 6,
                    }}
                    onClick={() => send({ type: 'OPEN_DASHBOARD', url: 'http://localhost:5173/documents' })}
                  >
                    <FolderOpen size={13} /> Open FormFlow Vault
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* TAB 3: PROFILE VAULT VIEWER */}
          {activeTab === 'profile' && (
            <div className="ffp-body">
              <div style={{ position: 'relative' }}>
                <Search size={13} style={{ position: 'absolute', left: 8, top: 7, color: 'var(--muted)' }} />
                <input
                  type="text"
                  placeholder="Search vault values…"
                  value={profileSearch}
                  onChange={(e) => setProfileSearch(e.target.value)}
                  style={{
                    width: '100%',
                    height: 28,
                    padding: '0 8px 0 26px',
                    borderRadius: 6,
                    border: '1px solid var(--border)',
                    background: 'var(--surface)',
                    fontSize: 10,
                    outline: 'none',
                  }}
                />
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                {filteredVault.length > 0 ? (
                  filteredVault.map((item) => (
                    <div
                      key={item.key}
                      className="ffp-card"
                      style={{ padding: '6px 10px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
                    >
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 9, color: 'var(--muted)' }}>{item.label}</div>
                        <div className="ff-truncate" style={{ fontSize: 11, fontWeight: 600, color: 'var(--text)' }}>
                          {item.value}
                        </div>
                        <div style={{ fontSize: 8, color: 'var(--secondary)' }}>
                          Source: {item.sourceDocumentName || item.source || 'Vault'}
                        </div>
                      </div>
                      <button
                        type="button"
                        style={{ border: 0, background: 'transparent', color: 'var(--primary)', padding: 4 }}
                        onClick={() => copyProfileValue(item.key, item.value)}
                        title="Copy to clipboard"
                      >
                        {copiedKey === item.key ? <Check size={14} style={{ color: 'var(--success)' }} /> : <Copy size={14} />}
                      </button>
                    </div>
                  ))
                ) : (
                  <div className="ffp-center" style={{ padding: 24, color: 'var(--muted)' }}>
                    No vault fields found.
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {/* Bottom Navigation Bar */}
      <nav className="ffp-nav">
        <button
          type="button"
          className={`ffp-nav-btn ${activeTab === 'autofill' && view === 'main' ? 'is-active' : ''}`}
          onClick={() => { setView('main'); setActiveTab('autofill'); }}
        >
          <Zap size={14} fill="currentColor" /> Autofill
        </button>
        <button
          type="button"
          className={`ffp-nav-btn ${activeTab === 'documents' && view === 'main' ? 'is-active' : ''}`}
          onClick={() => { setView('main'); setActiveTab('documents'); }}
        >
          <FolderLock size={14} /> Documents
        </button>
        <button
          type="button"
          className={`ffp-nav-btn ${activeTab === 'profile' && view === 'main' ? 'is-active' : ''}`}
          onClick={() => { setView('main'); setActiveTab('profile'); }}
        >
          <User size={14} /> Profile
        </button>
      </nav>

      {/* Bottom Trust & Security Banner */}
      <div className="ffp-trust-bar">
        <div className="ffp-trust-bar-item">
          <ShieldCheck size={12} style={{ color: 'var(--success)' }} />
          <span style={{ fontWeight: 600 }}>Zero-Custody Mode</span>
        </div>
        <div className="ffp-trust-bar-item">
          <RefreshCw size={11} />
          <span>{state.connection.connected ? `Vault Connected (${vault.length} fields)` : 'Local Vault'}</span>
        </div>
      </div>
    </div>
  );
}
