import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowUpRight, CheckCircle2, Clock, Download, ExternalLink, FileText, History, Search, ShieldCheck, Trash2, XCircle } from 'lucide-react';
import { PageHeader } from '@/components/ui/PageHeader';
import { Card, CardHeader } from '@/components/ui/Card';
import { Badge, StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { SearchInput } from '@/components/ui/Input';
import { Modal, ConfirmDialog } from '@/components/ui/Modal';
import { EmptyState, Skeleton } from '@/components/ui/States';
import { useToast } from '@/context/ToastContext';
import { historyService } from '@/services/historyService';
import type { FormHistoryItem } from '@/services/types';

export function HistoryPage() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [items, setItems] = useState<FormHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('All');
  const [selected, setSelected] = useState<FormHistoryItem | null>(null);
  const [clearOpen, setClearOpen] = useState(false);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    historyService.list().then((next) => { setItems(next); setLoading(false); });
  }, []);

  const filtered = useMemo(() => items.filter((item) => {
    const matchesQuery = `${item.website} ${item.url}`.toLowerCase().includes(query.toLowerCase());
    const matchesStatus = status === 'All' || item.status === status;
    return matchesQuery && matchesStatus;
  }), [items, query, status]);

  const totalFields = items.reduce((sum, item) => sum + item.fieldsFilled, 0);
  const completed = items.filter((item) => item.status === 'Completed').length;
  const avgTime = items.length
    ? `${Math.round(items.reduce((sum, item) => sum + (parseInt(item.duration) || 0), 0) / items.length)}s`
    : '0s';

  const exportCsv = () => {
    const header = ['Website', 'URL', 'Date', 'Status', 'Detected', 'Filled', 'Review', 'Duration'];
    const rows = filtered.map((item) => [item.website, item.url, item.dateLabel, item.status, item.fieldsDetected, item.fieldsFilled, item.fieldsReview, item.duration]);
    const csv = [header, ...rows].map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'formflow-autofill-history.csv';
    anchor.click();
    URL.revokeObjectURL(url);
    toast({ tone: 'success', title: 'History exported', message: `${filtered.length} history records written to CSV.` });
  };

  return (
    <div>
      <PageHeader
        eyebrow={<>Activity <span>›</span> Autofill history</>}
        title="Autofill History"
        description="A reviewable record of every form the extension detected. Values are never submitted without your action."
        actions={
          <>
            <Button icon={Download} onClick={exportCsv} disabled={!filtered.length}>Export CSV</Button>
            <Button variant="danger" icon={Trash2} onClick={() => setClearOpen(true)} disabled={!items.length}>Clear history</Button>
          </>
        }
      />

      <div className="ff-stat-grid ff-mb-16">
        <Card className="ff-stat-card"><span className="ff-stat-card__icon"><History size={16} /></span><div><div className="ff-stat-card__label">Forms detected</div><div className="ff-stat-card__value">{items.length}</div></div></Card>
        <Card className="ff-stat-card"><span className="ff-stat-card__icon"><CheckCircle2 size={16} /></span><div><div className="ff-stat-card__label">Completed reviews</div><div className="ff-stat-card__value">{completed}</div></div></Card>
        <Card className="ff-stat-card"><span className="ff-stat-card__icon"><ArrowUpRight size={16} /></span><div><div className="ff-stat-card__label">Fields filled</div><div className="ff-stat-card__value">{totalFields}</div></div></Card>
        <Card className="ff-stat-card"><span className="ff-stat-card__icon"><Clock size={16} /></span><div><div className="ff-stat-card__label">Avg. review time</div><div className="ff-stat-card__value">{avgTime}</div></div></Card>
      </div>

      <Card>
        <div className="ff-history-toolbar">
          <div style={{ flex: 1, minWidth: 220 }}><SearchInput value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search website or URL…" /></div>
          <div className="ff-tabs" role="tablist" aria-label="Filter by status">
            {['All', 'Completed', 'Partially completed', 'Cancelled'].map((option) => (
              <button key={option} type="button" className="ff-tab" data-active={status === option} onClick={() => setStatus(option)}>{option}</button>
            ))}
          </div>
        </div>

        {loading ? (
          <div style={{ padding: 16 }}><Skeleton height={160} /></div>
        ) : filtered.length ? (
          <div className="ff-history-list">
            {filtered.map((item) => (
              <button type="button" className="ff-history-row" key={item.id} onClick={() => setSelected(item)}>
                <span className="ff-history-row__icon" data-status={item.status}>
                  {item.status === 'Completed' ? <CheckCircle2 size={16} /> : item.status === 'Cancelled' ? <XCircle size={16} /> : <Clock size={16} />}
                </span>
                <span className="ff-history-row__main">
                  <span className="ff-label">{item.website}</span>
                  <span className="ff-body-sm ff-muted ff-truncate">{item.url}</span>
                </span>
                <span className="ff-history-row__date">{item.dateLabel}</span>
                <span className="ff-history-row__count">{item.fieldsFilled}/{item.fieldsDetected} fields</span>
                <StatusBadge status={item.status} />
                <ArrowUpRight size={14} className="ff-muted" />
              </button>
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState icon={History} title="No completed autofill operations" description="Forms filled using the FormFlow extension will appear in this reviewable audit log." />
        ) : (
          <EmptyState icon={Search} title="No matching activity" description="Try a different website name or status filter." action={<Button onClick={() => { setQuery(''); setStatus('All'); }}>Reset filters</Button>} />
        )}
      </Card>

      <div className="ff-note ff-mt-12" style={{ display: 'flex', gap: 8 }}>
        <ShieldCheck size={15} style={{ flex: '0 0 auto', color: 'var(--ff-success)' }} />
        <span>FormFlow records field counts and document names for your review. It does not store the contents of third-party forms or submit them for you.</span>
      </div>

      <Modal
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        title={selected?.website}
        description={selected?.url}
        footer={<><Button onClick={() => setSelected(null)}>Close</Button><Button variant="primary" icon={ExternalLink} onClick={() => { setSelected(null); toast({ tone: 'info', title: 'Demo destination', message: 'The extension review flow is available from the Extension page.' }); navigate('/extension'); }}>Open extension review</Button></>}
      >
        {selected ? (
          <div className="ff-stack ff-gap-12">
            <div className="ff-row ff-between"><span className="ff-body-sm ff-muted">Status</span><StatusBadge status={selected.status} /></div>
            <div className="ff-row ff-between"><span className="ff-body-sm ff-muted">Detected / filled</span><span className="ff-label">{selected.fieldsDetected} / {selected.fieldsFilled}</span></div>
            <div className="ff-row ff-between"><span className="ff-body-sm ff-muted">Needed review</span><span className="ff-label">{selected.fieldsReview}</span></div>
            <div className="ff-row ff-between"><span className="ff-body-sm ff-muted">Duration</span><span className="ff-label">{selected.duration}</span></div>
            <div className="ff-row ff-between"><span className="ff-body-sm ff-muted">Date</span><span className="ff-label">{selected.dateLabel}</span></div>
            <div>
              <div className="ff-uppercase ff-mb-8" style={{ fontSize: 9 }}>Documents used</div>
              {selected.documentsUsed.length ? selected.documentsUsed.map((name) => (
                <div className="ff-row ff-gap-6 ff-body-sm" key={name} style={{ padding: '6px 0', borderTop: '1px solid var(--ff-border)' }}><FileText size={13} className="ff-muted" /> {name}</div>
              )) : <div className="ff-note">No documents were used for this attempt.</div>}
            </div>
            <div className="ff-note"><Badge tone="warning">Demo record</Badge> This entry is illustrative and does not represent a real submission.</div>
          </div>
        ) : null}
      </Modal>

      <ConfirmDialog
        open={clearOpen}
        title="Clear all autofill history?"
        description="This clears the autofill history recorded in your account. Vault documents and extracted values are not affected."
        confirmLabel="Clear history"
        destructive
        loading={clearing}
        onConfirm={async () => {
          setClearing(true);
          await historyService.clear();
          setItems([]);
          setClearing(false);
          setClearOpen(false);
          toast({ tone: 'success', title: 'History cleared' });
        }}
        onClose={() => setClearOpen(false)}
      />
    </div>
  );
}
