import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCircle2,
  Copy,
  ExternalLink,
  FileText,
  FolderLock,
  FolderOpen,
  Globe2,
  History,
  KeyRound,
  Loader2,
  LockKeyhole,
  Pencil,
  Search,
  Settings,
  Shield,
  ShieldCheck,
  Sparkles,
  User,
  Zap,
} from 'lucide-react';
import { MESSAGE, type MatchSuggestion, type ScanPayload } from '@shared/messages';
import { VAULT_SESSION_KEY } from '@shared/constants';
import type { Collection, FormHistoryItem, Preferences, VaultField, VaultProfile, VaultRecord } from '@shared/types';

interface VaultStatus {
  exists: boolean;
  unlocked: boolean;
  encrypted: boolean;
  requiresEncryptionMigration: boolean;
  createdAt?: string;
}

interface PopupState {
  version: string;
  vaultStatus: VaultStatus;
  preferences: Preferences;
  history: FormHistoryItem[];
}

interface VaultSummary {
  vault: VaultRecord | null;
  profile: VaultProfile;
  fields: VaultField[];
  collections: Collection[];
  documentCount: number;
}

type TabMode = 'autofill' | 'documents' | 'profile';
type View = 'main' | 'settings' | 'history' | 'complete';

const fallbackState: PopupState = {
  version: '2.0.0',
  vaultStatus: { exists: false, unlocked: false, encrypted: false, requiresEncryptionMigration: false },
  preferences: {
    confirmBeforeAutofill: true,
    requireSensitiveReview: true,
    allowLongAnswers: true,
    autoDownloadFiles: false,
    productNotifications: false,
    activityNotifications: true,
    compactMode: false,
    autoLockMinutes: 15,
    ocrLanguage: 'eng',
  },
  history: [],
};

function send<T>(operation: string, payload: Record<string, unknown> = {}): Promise<T> {
  const requestId = `popup_${crypto.randomUUID()}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The extension service did not respond in time.')), 10_000);
    chrome.runtime.sendMessage({ protocol: 1, requestId, operation, payload }, (response: { ok?: boolean; data?: T; error?: string } | undefined) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message ?? 'Extension messaging failed.'));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error ?? 'Extension request failed.'));
        return;
      }
      resolve(response.data as T);
    });
  });
}

export function Popup() {
  const [state, setState] = useState<PopupState>(fallbackState);
  const [summary, setSummary] = useState<VaultSummary | null>(null);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [view, setView] = useState<View>('main');
  const [activeTab, setActiveTab] = useState<TabMode>('autofill');
  const [scan, setScan] = useState<ScanPayload | null>(null);
  const [tabTitle, setTabTitle] = useState('');
  const [tabUrl, setTabUrl] = useState('');
  const [scanning, setScanning] = useState(false);
  const [filling, setFilling] = useState(false);
  const [error, setError] = useState('');
  const [matches, setMatches] = useState<MatchSuggestion[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [overrides, setOverrides] = useState<Record<number, string>>({});
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [sensitiveApproved, setSensitiveApproved] = useState(false);
  const [result, setResult] = useState<{ filled: number; failed: number; skipped: Array<{ index: number; reason: string }> } | null>(null);
  const [collectionId, setCollectionId] = useState('all');
  const [profileSearch, setProfileSearch] = useState('');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [unlocking, setUnlocking] = useState(false);

  const hostname = useMemo(() => {
    if (!tabUrl) return 'Current page';
    try {
      return new URL(tabUrl).hostname;
    } catch {
      return tabUrl;
    }
  }, [tabUrl]);

  const locked = !state.vaultStatus.unlocked;
  const missingVault = !state.vaultStatus.exists;
  const migrationRequired = state.vaultStatus.requiresEncryptionMigration;

  const loadState = useCallback(async () => {
    try {
      const next = await send<PopupState>(MESSAGE.GET_STATE);
      setState(next);
      return next;
    } catch (err) {
      setState(fallbackState);
      setError(err instanceof Error ? err.message : 'Could not read extension state.');
      return fallbackState;
    }
  }, []);

  const loadSummary = useCallback(async () => {
    try {
      const data = await send<VaultSummary>(MESSAGE.VAULT_SUMMARY);
      setSummary(data);
      setCollections(data.collections);
      return data;
    } catch {
      setSummary(null);
      setCollections([]);
      return null;
    }
  }, []);

  const scanPage = useCallback(async (nextCollectionId = collectionId) => {
    setScanning(true);
    setError('');
    setResult(null);
    try {
      const data = await send<{ tab: { url: string; title: string }; scan: ScanPayload; matches: MatchSuggestion[]; collections: Collection[] }>(
        MESSAGE.GET_FORM_SUGGESTIONS,
        { collectionId: nextCollectionId },
      );
      setScan(data.scan);
      setMatches(data.matches);
      setTabTitle(data.tab.title || data.scan.title);
      setTabUrl(data.tab.url || data.scan.url);
      setCollections(data.collections);
      setSelected(data.matches.filter((match) => match.value && !match.needsReview && !match.conflict && !match.unsupported).map((match) => match.index));
      setOverrides({});
      setSensitiveApproved(false);
    } catch (err) {
      setScan(null);
      setMatches([]);
      setSelected([]);
      setError(err instanceof Error ? err.message : 'Unable to scan this page.');
    } finally {
      setScanning(false);
    }
  }, [collectionId]);

  useEffect(() => {
    void (async () => {
      const next = await loadState();
      if (next.vaultStatus.unlocked) {
        await loadSummary();
        await scanPage('all');
      }
    })();
  }, [loadState, loadSummary, scanPage]);

  // Keep the popup in sync with vault locks initiated by the dashboard,
  // the background alarm, or another extension page.
  useEffect(() => {
    if (typeof chrome === 'undefined' || !chrome.storage?.onChanged) return;
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'session' || !(VAULT_SESSION_KEY in changes)) return;
      if (!changes[VAULT_SESSION_KEY]?.newValue) {
        setSummary(null);
        setCollections([]);
        setMatches([]);
        setSelected([]);
        setScan(null);
        setResult(null);
        setError('');
        setState((current) => ({
          ...current,
          vaultStatus: { ...current.vaultStatus, unlocked: false },
          history: [],
        }));
        return;
      }
      void (async () => {
        const next = await loadState();
        if (next.vaultStatus.unlocked) await loadSummary();
      })();
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, [loadState, loadSummary]);

  useEffect(() => {
    if (!state.vaultStatus.unlocked) return;
    void scanPage(collectionId);
  }, [collectionId]); // eslint-disable-line react-hooks/exhaustive-deps

  const unlock = async () => {
    setError('');
    setUnlocking(true);
    try {
      await send(MESSAGE.VAULT_UNLOCK, { passphrase });
      setPassphrase('');
      const next = await loadState();
      if (next.vaultStatus.unlocked) {
        await loadSummary();
        await scanPage(collectionId);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to unlock the vault.');
    } finally {
      setUnlocking(false);
    }
  };

  const lock = async () => {
    try {
      await send(MESSAGE.VAULT_LOCK);
      setSummary(null);
      setMatches([]);
      setSelected([]);
      setScan(null);
      await loadState();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to lock the vault.');
    }
  };

  const openDashboard = async () => {
    await send(MESSAGE.OPEN_DASHBOARD).catch(() => undefined);
  };

  const toggleSelectAll = () => {
    if (selected.length === matches.length) setSelected([]);
    else setSelected(matches.map((match) => match.index));
  };

  const toggleSelected = (index: number) => {
    setSelected((current) => (current.includes(index) ? current.filter((item) => item !== index) : [...current, index]));
  };

  const valueFor = (match: MatchSuggestion) => overrides[match.index] ?? match.value;
  const selectedMatches = matches.filter((match) => selected.includes(match.index));
  const sensitiveSelected = selectedMatches.some((match) => match.sensitive);

  const fillSelected = async () => {
    if (sensitiveSelected && state.preferences.requireSensitiveReview && !sensitiveApproved) {
      setError('Confirm that you reviewed the sensitive values before filling.');
      return;
    }
    setFilling(true);
    setError('');
    try {
      const fills = selectedMatches
        .filter((match) => valueFor(match).trim())
        .map((match) => ({ index: match.index, value: valueFor(match).trim() }));
      const data = await send<{ result: { filled: number; failed: number; skipped: Array<{ index: number; reason: string }> } }>(
        MESSAGE.FILL_ACTIVE_TAB,
        { fills },
      );
      setResult(data.result);
      setView('complete');
      await send(MESSAGE.RECORD_HISTORY, {
        website: tabTitle || hostname,
        url: tabUrl,
        detected: matches.length,
        filled: data.result.filled,
        skipped: matches.length - data.result.filled,
        status: data.result.failed ? 'Partially completed' : 'Completed',
      }).catch(() => undefined);
      await loadState();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Autofill failed.');
    } finally {
      setFilling(false);
    }
  };

  const copyProfileValue = (key: string, value: string) => {
    void navigator.clipboard.writeText(value);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1500);
  };

  const filteredVault = useMemo(() => {
    const list = summary?.fields ?? [];
    if (!profileSearch.trim()) return list;
    const query = profileSearch.toLowerCase();
    return list.filter((item) => item.label.toLowerCase().includes(query) || item.value.toLowerCase().includes(query));
  }, [profileSearch, summary]);

  const totalQuestions = scan?.fields?.length ?? matches.length;
  const matchedCount = matches.filter((match) => match.value && !match.needsReview && !match.conflict && !match.unsupported).length;
  const needReviewCount = matches.filter((match) => match.needsReview || match.conflict).length;
  const unsupportedCount = matches.filter((match) => match.unsupported).length;
  const vaultLabel = state.vaultStatus.unlocked ? 'Unlocked' : state.vaultStatus.exists ? 'Locked' : 'No vault';

  return (
    <div className="ffp">
      <header className="ffp-head">
        <div className="ffp-brand">
          <div className="ffp-logo"><Zap size={16} fill="currentColor" /></div>
          <div className="ffp-brand-info">
            <div className="ffp-brand-title">
              <span>FormFlow</span>
              <span className="ffp-brand-tag">v{state.version}</span>
            </div>
            <div className="ffp-host-chip">
              <span className={`ffp-dot ${state.vaultStatus.unlocked ? 'is-online' : ''}`} />
              <span>{hostname}</span>
            </div>
          </div>
        </div>
        <div className="ffp-head-actions">
          {state.vaultStatus.unlocked ? (
            <button type="button" className="ffp-head-btn" onClick={() => void lock()} title="Lock vault">
              <LockKeyhole size={15} />
            </button>
          ) : null}
          <button type="button" className={`ffp-head-btn ${view === 'history' ? 'is-active' : ''}`} onClick={() => setView(view === 'history' ? 'main' : 'history')} title="Autofill history">
            <History size={15} />
          </button>
          <button type="button" className={`ffp-head-btn ${view === 'settings' ? 'is-active' : ''}`} onClick={() => setView(view === 'settings' ? 'main' : 'settings')} title="Extension settings">
            <Settings size={15} />
          </button>
          <button type="button" className="ffp-avatar-btn" onClick={() => setActiveTab('profile')} title="View vault profile">
            {summary?.profile.email ? summary.profile.email.slice(0, 2).toUpperCase() : state.vaultStatus.unlocked ? 'UN' : 'LK'}
          </button>
        </div>
      </header>

      {view === 'history' ? (
        <>
          <div className="ffp-subhead">
            <button type="button" className="ffp-back" onClick={() => setView('main')}><ArrowLeft size={14} /> Back</button>
            <strong>Autofill history</strong>
          </div>
          <div className="ffp-body">
            {state.history.length ? state.history.map((item) => (
              <div key={item.id} className="ffp-card" style={{ padding: 8 }}>
                <div className="ffp-card-header">
                  <span className="ffp-card-title">{item.website}</span>
                  <span className="ffp-card-badge">{item.status}</span>
                </div>
                <div className="ffp-card-sub">
                  <span>{item.fieldsFilled} of {item.fieldsDetected} fields filled</span>
                  <span style={{ fontSize: 9 }}>{item.dateLabel}</span>
                </div>
              </div>
            )) : (
              <div className="ffp-center" style={{ padding: 24, color: 'var(--muted)' }}>No autofill history yet.</div>
            )}
          </div>
        </>
      ) : view === 'settings' ? (
        <>
          <div className="ffp-subhead">
            <button type="button" className="ffp-back" onClick={() => setView('main')}><ArrowLeft size={14} /> Back</button>
            <strong>Autofill safeguards</strong>
          </div>
          <div className="ffp-body">
            <div className="ffp-card">
              {([
                ['confirmBeforeAutofill', 'Confirm before autofill'],
                ['requireSensitiveReview', 'Review sensitive values'],
                ['allowLongAnswers', 'Allow grounded long answers'],
              ] as const).map(([key, label]) => (
                <label key={key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '7px 0', borderTop: '1px solid var(--border)', cursor: 'pointer' }}>
                  <span style={{ fontSize: 11, fontWeight: 500 }}>{label}</span>
                  <input
                    type="checkbox"
                    checked={state.preferences[key]}
                    onChange={(event) => {
                      const next = { ...state.preferences, [key]: event.target.checked };
                      setState({ ...state, preferences: next });
                      void send(MESSAGE.UPDATE_SETTINGS, { [key]: event.target.checked }).then(() => loadState());
                    }}
                  />
                </label>
              ))}
            </div>
            <div className="ffp-card">
              <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <span style={{ fontSize: 11, fontWeight: 500 }}>Auto-lock</span>
                <select
                  value={state.preferences.autoLockMinutes}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    setState({ ...state, preferences: { ...state.preferences, autoLockMinutes: value } });
                    void send(MESSAGE.UPDATE_SETTINGS, { autoLockMinutes: value }).then(() => loadState());
                  }}
                >
                  <option value={1}>1 minute</option>
                  <option value={5}>5 minutes</option>
                  <option value={15}>15 minutes</option>
                  <option value={30}>30 minutes</option>
                  <option value={0}>Manual only</option>
                </select>
              </label>
            </div>
            <div className="ffp-safeguard">
              <ShieldCheck size={14} style={{ color: 'var(--success)', flexShrink: 0 }} />
              <span>The vault key stays in this browser session and is cleared when the vault is locked.</span>
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
            <p style={{ fontSize: 11, color: 'var(--secondary)', marginTop: 4 }}>Populated {result?.filled ?? 0} approved fields on {hostname}.</p>
          </div>
          <div className="ffp-safeguard" style={{ textAlign: 'left', width: '100%' }}>
            <Shield size={14} style={{ color: 'var(--success)', flexShrink: 0 }} />
            <span>FormFlow never clicks submit. Review the page before submitting.</span>
          </div>
          <button type="button" className="ffp-btn-primary" onClick={() => setView('main')}>Done</button>
        </div>
      ) : (
        <>
          {activeTab === 'autofill' && (
            <div className="ffp-body">
              {missingVault ? (
                <div className="ffp-card ffp-center" style={{ padding: 22, gap: 8 }}>
                  <FolderLock size={24} style={{ color: 'var(--primary)' }} />
                  <strong style={{ fontSize: 12 }}>No local vault yet</strong>
                  <span style={{ fontSize: 10, color: 'var(--muted)', textAlign: 'center' }}>Create an encrypted vault in the FormFlow dashboard before filling forms.</span>
                  <button type="button" className="ffp-btn-primary" onClick={() => void openDashboard()}>Open dashboard</button>
                </div>
              ) : migrationRequired ? (
                <div className="ffp-card ffp-center" style={{ padding: 22, gap: 8 }}>
                  <Shield size={24} style={{ color: 'var(--warning)' }} />
                  <strong style={{ fontSize: 12 }}>Vault needs encryption</strong>
                  <span style={{ fontSize: 10, color: 'var(--muted)', textAlign: 'center' }}>Open the dashboard to protect the existing vault with a passphrase.</span>
                  <button type="button" className="ffp-btn-primary" onClick={() => void openDashboard()}>Open dashboard</button>
                </div>
              ) : locked ? (
                <div className="ffp-card ffp-center" style={{ padding: 22, gap: 8 }}>
                  <LockKeyhole size={24} style={{ color: 'var(--primary)' }} />
                  <strong style={{ fontSize: 12 }}>Vault locked</strong>
                  <span style={{ fontSize: 10, color: 'var(--muted)', textAlign: 'center' }}>Unlock the encrypted vault to scan and fill this page.</span>
                  <input
                    type="password"
                    value={passphrase}
                    onChange={(event) => setPassphrase(event.target.value)}
                    placeholder="Vault passphrase"
                    style={{ width: '100%', height: 30, fontSize: 11, padding: '0 8px', borderRadius: 5, border: '1px solid var(--border)' }}
                    onKeyDown={(event) => { if (event.key === 'Enter') void unlock(); }}
                  />
                  <button type="button" className="ffp-btn-primary" onClick={() => void unlock()} disabled={unlocking || !passphrase}>
                    {unlocking ? <Loader2 size={14} className="ffp-spin" /> : <KeyRound size={14} />} Unlock vault
                  </button>
                  {error ? <span style={{ fontSize: 10, color: 'var(--danger)' }}>{error}</span> : null}
                  <button type="button" className="ffp-action-link" onClick={() => void openDashboard()}>Open dashboard</button>
                </div>
              ) : (
                <>
                  <div className="ffp-card">
                    <div className="ffp-card-header">
                      <div className="ffp-card-title">
                        <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--success)' }} />
                        <span className="ff-truncate">{tabTitle || hostname}</span>
                      </div>
                      <span className="ffp-card-badge">{scan?.adapter || 'Form'}</span>
                    </div>
                    <div className="ffp-card-sub">
                      <span>{vaultLabel} · Review profile values before autofill</span>
                      <div className="ffp-links-row">
                        <button type="button" className="ffp-action-link" onClick={toggleSelectAll}>
                          {selected.length === matches.length ? 'Deselect all' : 'Select all'}
                        </button>
                      </div>
                    </div>
                  </div>

                  {scan?.isEditor && (
                    <div className="ffp-card ffp-editor-banner">
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                        <div className="ffp-editor-icon"><AlertTriangle size={18} /></div>
                        <div>
                          <h4 style={{ fontSize: 12, fontWeight: 700, margin: '0 0 4px 0', color: '#92400e' }}>Google Forms editor detected</h4>
                          <p style={{ fontSize: 11, margin: 0, color: '#78350f', lineHeight: 1.4 }}>{scan.editorMessage}</p>
                        </div>
                      </div>
                      <button type="button" className="ffp-btn-secondary" style={{ marginTop: 12, width: '100%' }} onClick={() => void send(MESSAGE.OPEN_TAB, { url: tabUrl.replace(/\/edit(\?|\/|$).*/i, '/viewform') })}>
                        <ExternalLink size={13} /> Open responder preview
                      </button>
                    </div>
                  )}

                  {scan && !scan.isEditor && totalQuestions > 0 && (
                    <div className="ffp-summary-bar">
                      <div className="ffp-summary-title"><strong>{scan.adapter || 'Form'} detected</strong><span>{totalQuestions} {totalQuestions === 1 ? 'question' : 'questions'} found</span></div>
                      <div className="ffp-summary-pills">
                        <span className="ffp-pill ffp-pill--success">{matchedCount} matched</span>
                        {needReviewCount > 0 ? <span className="ffp-pill ffp-pill--warning">{needReviewCount} need review</span> : null}
                        {unsupportedCount > 0 ? <span className="ffp-pill ffp-pill--neutral">{unsupportedCount} unsupported</span> : null}
                      </div>
                    </div>
                  )}

                  <div className="ffp-scope-bar">
                    <span style={{ color: 'var(--muted)', fontWeight: 600 }}>Collection:</span>
                    <select value={collectionId} onChange={(event) => setCollectionId(event.target.value)}>
                      <option value="all">All vault documents</option>
                      {collections.map((collection) => <option key={collection.id} value={collection.id}>{collection.name}</option>)}
                    </select>
                  </div>

                  {error ? <div className="ffp-safeguard" style={{ background: '#fef2f2', borderColor: '#fecaca', color: '#991b1b' }}><AlertTriangle size={14} /><span>{error}</span></div> : null}

                  {scanning ? (
                    <div className="ffp-center" style={{ padding: 24, gap: 8 }}><Loader2 size={20} className="ffp-spin" style={{ color: 'var(--primary)' }} /><span style={{ fontSize: 11, color: 'var(--secondary)' }}>Scanning page form fields…</span></div>
                  ) : matches.length > 0 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {matches.map((match) => {
                        const isChecked = selected.includes(match.index);
                        const currentValue = valueFor(match);
                        const isEditing = editingIndex === match.index;
                        const confidenceClass = match.confidence >= 90 ? 'is-high' : match.confidence >= 65 ? 'is-med' : 'is-low';
                        return (
                          <div key={match.index} className={`ffp-field-row ${isChecked ? 'is-selected' : ''}`}>
                            <div className="ffp-field-top">
                              <label className="ffp-field-main">
                                <input type="checkbox" className="ffp-checkbox" checked={isChecked} onChange={() => toggleSelected(match.index)} disabled={match.unsupported} />
                                <span className="ffp-field-name">{match.fieldLabel}{match.sensitive ? <span style={{ color: 'var(--warning)', marginLeft: 3 }}>•</span> : null}</span>
                              </label>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                {!isEditing ? <span className="ffp-field-value" title={currentValue}>{currentValue || <span style={{ color: match.needsReview ? 'var(--warning)' : 'var(--muted)', fontStyle: 'italic' }}>{match.unsupported ? 'unsupported' : match.value ? 'empty' : 'no match'}</span>}</span> : null}
                                {!match.unsupported ? <button type="button" style={{ border: 0, background: 'transparent', color: 'var(--muted)', padding: 0 }} onClick={() => setEditingIndex(isEditing ? null : match.index)} title="Edit suggestion"><Pencil size={11} /></button> : null}
                              </div>
                            </div>
                            {isEditing ? (
                              <div style={{ paddingLeft: 20 }}>
                                {match.options?.length ? (
                                  <select value={currentValue} onChange={(event) => setOverrides((current) => ({ ...current, [match.index]: event.target.value }))} style={{ width: '100%', height: 26, fontSize: 11, borderRadius: 4, border: '1px solid var(--primary-bright)' }}>
                                    <option value="">-- Choose option --</option>
                                    {match.options.map((option) => <option key={option} value={option}>{option}</option>)}
                                  </select>
                                ) : (
                                  <input type="text" value={currentValue} onChange={(event) => setOverrides((current) => ({ ...current, [match.index]: event.target.value }))} style={{ width: '100%', height: 24, fontSize: 11, padding: '0 6px', border: '1px solid var(--primary-bright)', borderRadius: 4, outline: 'none' }} autoFocus />
                                )}
                              </div>
                            ) : null}
                            <div className="ffp-field-meta">
                              <span className="ffp-source-chip" title={match.sourceDocumentName || 'Local vault'}>
                                <FileText size={9} /> {match.sourceDocumentName || (match.unsupported ? 'Unsupported' : 'Manual review')}
                              </span>
                              {!match.unsupported ? <span className={`ffp-conf-badge ${confidenceClass}`}>{match.confidence}%</span> : null}
                            </div>
                            {match.needsReview ? <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, color: 'var(--warning)', marginTop: 4, paddingLeft: 20 }}><AlertTriangle size={11} /> {match.reason}</div> : null}
                            {match.conflict && match.alternates?.length ? (
                              <div className="ffp-conflict-box">
                                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}><AlertTriangle size={11} /> Conflicting value in another document:</div>
                                <select value={currentValue} onChange={(event) => setOverrides((current) => ({ ...current, [match.index]: event.target.value }))}>
                                  <option value={match.value}>{match.value} ({match.sourceDocumentName})</option>
                                  {match.alternates.map((alternate) => <option key={`${alternate.sourceDocumentName}-${alternate.value}`} value={alternate.value}>{alternate.value} ({alternate.sourceDocumentName})</option>)}
                                </select>
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  ) : !scan?.isEditor ? (
                    <div className="ffp-card ffp-center" style={{ padding: 24 }}>
                      <Sparkles size={22} style={{ color: 'var(--primary)', marginBottom: 6 }} />
                      <span style={{ fontSize: 11, fontWeight: 600 }}>No form fields detected</span>
                      <span style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2 }}>Open a page with inputs or textareas to review suggestions.</span>
                      <button type="button" className="ffp-action-link" style={{ marginTop: 8 }} onClick={() => void scanPage(collectionId)}>Rescan page</button>
                    </div>
                  ) : null}

                  {sensitiveSelected ? (
                    <label className="ffp-safeguard" style={{ cursor: 'pointer' }}>
                      <input type="checkbox" checked={sensitiveApproved} onChange={(event) => setSensitiveApproved(event.target.checked)} />
                      <span>I reviewed the sensitive identification values for this form.</span>
                    </label>
                  ) : null}

                  {matches.length > 0 && !scan?.isEditor ? (
                    <button type="button" className="ffp-btn-primary" onClick={() => void fillSelected()} disabled={filling || selected.length === 0}>
                      {filling ? <><Loader2 size={14} className="ffp-spin" /> Filling approved fields…</> : <><Zap size={14} fill="currentColor" /> Fill {selected.length} approved fields</>}
                    </button>
                  ) : null}
                </>
              )}
            </div>
          )}

          {activeTab === 'documents' && (
            <div className="ffp-body">
              <div className="ffp-doc-card">
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text)' }}>Encrypted document vault</span>
                  <span style={{ fontSize: 10, color: 'var(--muted)' }}>{summary?.documentCount ?? 0} files</span>
                </div>
                <p style={{ fontSize: 10, color: 'var(--secondary)', margin: '8px 0' }}>
                  Document bytes and metadata stay in the extension-owned IndexedDB vault. The popup does not duplicate the vault.
                </p>
                <button type="button" className="ffp-btn-secondary" style={{ width: '100%' }} onClick={() => void openDashboard()}><FolderOpen size={13} /> Open document vault</button>
              </div>
            </div>
          )}

          {activeTab === 'profile' && (
            <div className="ffp-body">
              {locked ? (
                <div className="ffp-card ffp-center" style={{ padding: 22, gap: 6 }}>
                  <LockKeyhole size={22} style={{ color: 'var(--primary)' }} />
                  <span style={{ fontSize: 11, fontWeight: 600 }}>Vault locked</span>
                  <span style={{ fontSize: 10, color: 'var(--muted)' }}>Unlock in the Autofill tab to view profile values.</span>
                </div>
              ) : (
                <>
                  <div style={{ position: 'relative' }}>
                    <Search size={13} style={{ position: 'absolute', left: 8, top: 7, color: 'var(--muted)' }} />
                    <input type="text" placeholder="Search vault values…" value={profileSearch} onChange={(event) => setProfileSearch(event.target.value)} style={{ width: '100%', height: 28, padding: '0 8px 0 26px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', fontSize: 10, outline: 'none' }} />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                    {filteredVault.length ? filteredVault.map((item) => (
                      <div key={item.id} className="ffp-card" style={{ padding: '6px 10px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div style={{ fontSize: 9, color: 'var(--muted)' }}>{item.label}</div>
                          <div className="ff-truncate" style={{ fontSize: 11, fontWeight: 600, color: 'var(--text)' }}>{item.value}</div>
                          <div style={{ fontSize: 8, color: 'var(--secondary)' }}>Source: {item.source.documentName || 'Manual entry'}</div>
                        </div>
                        <button type="button" style={{ border: 0, background: 'transparent', color: 'var(--primary)', padding: 4 }} onClick={() => copyProfileValue(item.id, item.value)} title="Copy value">
                          {copiedKey === item.id ? <Check size={14} style={{ color: 'var(--success)' }} /> : <Copy size={14} />}
                        </button>
                      </div>
                    )) : <div className="ffp-center" style={{ padding: 24, color: 'var(--muted)' }}>No vault values found.</div>}
                  </div>
                </>
              )}
            </div>
          )}
        </>
      )}

      <nav className="ffp-nav">
        <button type="button" className={`ffp-nav-btn ${activeTab === 'autofill' && view === 'main' ? 'is-active' : ''}`} onClick={() => { setView('main'); setActiveTab('autofill'); }}><Zap size={14} fill="currentColor" /> Autofill</button>
        <button type="button" className={`ffp-nav-btn ${activeTab === 'documents' && view === 'main' ? 'is-active' : ''}`} onClick={() => { setView('main'); setActiveTab('documents'); }}><FolderLock size={14} /> Documents</button>
        <button type="button" className={`ffp-nav-btn ${activeTab === 'profile' && view === 'main' ? 'is-active' : ''}`} onClick={() => { setView('main'); setActiveTab('profile'); }}><User size={14} /> Profile</button>
      </nav>

      <div className="ffp-trust-bar">
        <div className="ffp-trust-bar-item"><ShieldCheck size={12} style={{ color: 'var(--success)' }} /><span style={{ fontWeight: 600 }}>Extension-owned vault</span></div>
        <div className="ffp-trust-bar-item"><Globe2 size={11} /><span>{state.vaultStatus.unlocked ? 'Unlocked' : state.vaultStatus.exists ? 'Locked' : 'No vault'} · {state.vaultStatus.encrypted ? 'Encrypted' : 'Unprotected'}</span></div>
      </div>
    </div>
  );
}
