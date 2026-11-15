import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  Badge,
  BookOpenCheck,
  Briefcase,
  Chrome,
  Cloud,
  FileText,
  FolderOpen,
  GraduationCap,
  ShieldCheck,
  Upload,
  Zap,
} from 'lucide-react';
import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge as BadgePill } from '@/components/ui/Badge';
import { useApp } from '@/context/AppContext';

export function OverviewPage() {
  const {
    user,
    documents,
    fields,
    activity,
    driveConnection,
    extensionConnection,
  } = useApp();
  const navigate = useNavigate();

  const personalFields = fields.filter((field) => field.category === 'personal' || field.category === 'contact');
  const personalComplete = personalFields.length > 0
    ? Math.round((personalFields.filter((field) => field.value).length / Math.max(1, personalFields.length)) * 100)
    : 0;
  const processedCount = documents.filter((doc) => doc.status === 'processed' || doc.status === 'completed').length;
  const filledCount = activity.filter((item) => item.type === 'form_filled').length;
  const recentDocuments = documents.slice(0, 4);
  const recentActivity = activity.slice(0, 4);
  const formEvents = activity.filter((item) => item.type === 'form_filled' || item.type === 'form_detected');

  const greeting = useMemo(() => {
    const hour = new Date().getHours();
    return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  }, []);

  return (
    <div>
      <section className="ff-card ff-dashboard-hero">
        <div className="ff-dashboard-hero__top">
          <div>
            <div className="ff-row ff-gap-8" style={{ marginBottom: 5 }}>
              <span className="ff-pill"><span className="ff-dot" style={{ color: 'var(--ff-success)' }} /> {user?.accountType || 'Personal Vault'}</span>
              <span className="ff-body-sm ff-muted">{driveConnection.connected ? 'Google Drive connected' : 'Local document vault'}</span>
            </div>
            <h1 className="ff-h1">{greeting}, {user?.firstName ?? user?.name?.split(' ')[0] ?? 'there'}</h1>
            <p className="ff-body-sm ff-muted" style={{ marginTop: 2 }}>
              {documents.length > 0
                ? 'Your vault is ready for form autofill. Review your documents or open the extension to fill a form.'
                : 'Welcome to FormFlow. Upload your first documents to extract structured facts and enable autofill.'}
            </p>
          </div>
          <div className="ff-row ff-gap-8">
            <Button icon={GraduationCap} onClick={() => navigate('/records/education')}>Add record</Button>
            <Button variant="primary" icon={Upload} onClick={() => navigate('/documents?upload=1')}>Upload document</Button>
          </div>
        </div>
        <div className="ff-dashboard-hero__stats">
          <div><div className="ff-stat-label">Personal info</div><div className="ff-stat-value">{personalFields.length > 0 ? `${personalComplete}% complete` : 'Not set'}</div></div>
          <div><div className="ff-stat-label">Vault fields</div><div className="ff-stat-value">{fields.length} extracted</div></div>
          <div><div className="ff-stat-label">Vault documents</div><div className="ff-stat-value">{processedCount} verified</div></div>
          <div><div className="ff-stat-label">Forms autofilled</div><div className="ff-stat-value">{filledCount} completed</div></div>
        </div>
      </section>

      <div className="ff-dashboard-grid">
        <div className="ff-dashboard-col">
          <Card>
            <CardHeader
              title={<span className="ff-row ff-gap-8">Recent vault documents <span className="ff-code ff-muted">{documents.length} files</span></span>}
              action={<button type="button" className="ff-link-button" style={{ color: 'var(--ff-primary)', fontSize: 11 }} onClick={() => navigate('/documents')}>View all <ArrowRight size={13} /></button>}
            />
            <div>
              {recentDocuments.length > 0 ? (
                recentDocuments.map((doc) => {
                  const Icon = doc.category === 'Education' ? GraduationCap : doc.category === 'Identity' ? Badge : doc.category === 'Employment' ? Briefcase : FileText;
                  return (
                    <div className="ff-list-row" key={doc.id}>
                      <button
                        type="button"
                        className="ff-row ff-gap-10"
                        style={{ minWidth: 0, border: 0, background: 'transparent', textAlign: 'left', padding: 0 }}
                        onClick={() => navigate(`/documents?doc=${doc.id}`)}
                      >
                        <span className="ff-list-row__icon"><Icon size={16} strokeWidth={1.8} /></span>
                        <span style={{ minWidth: 0 }}>
                          <span className="ff-list-row__title ff-truncate" style={{ display: 'block' }}>{doc.name}</span>
                          <span className="ff-list-row__meta"><span>{doc.category}</span><span className="ff-sep">·</span><span>{doc.sizeLabel}</span><span className="ff-sep">·</span><span>{doc.uploadedAt}</span></span>
                        </span>
                      </button>
                    </div>
                  );
                })
              ) : (
                <div style={{ padding: '24px 16px', textAlign: 'center' }} className="ff-body-sm ff-muted">
                  No documents in vault yet.{' '}
                  <button type="button" className="ff-link-button" style={{ color: 'var(--ff-primary)', fontWeight: 600 }} onClick={() => navigate('/documents?upload=1')}>
                    Upload your first document
                  </button>
                </div>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader
              title="Recent activity"
              action={<button type="button" className="ff-link-button" style={{ color: 'var(--ff-primary)', fontSize: 11 }} onClick={() => navigate('/history')}>View history <ArrowRight size={13} /></button>}
            />
            <div>
              {recentActivity.length > 0 ? (
                recentActivity.map((item) => (
                  <button type="button" className="ff-list-row" key={item.id} style={{ width: '100%', border: 0, background: 'transparent', textAlign: 'left' }}>
                    <span style={{ minWidth: 0 }}>
                      <span className="ff-list-row__title ff-truncate" style={{ display: 'block' }}>{item.title}</span>
                      <span className="ff-list-row__meta">{item.detail}</span>
                    </span>
                    <span className="ff-activity-timestamp">{item.relativeTime}</span>
                  </button>
                ))
              ) : (
                <div style={{ padding: '24px 16px', textAlign: 'center' }} className="ff-body-sm ff-muted">
                  No recent activity recorded. Uploaded documents and autofilled forms will appear here.
                </div>
              )}
            </div>
          </Card>
        </div>

        <div className="ff-dashboard-col">
          <Card className="ff-section-card">
            <div className="ff-row ff-between">
              <div className="ff-row ff-gap-8"><Cloud size={17} className={driveConnection.connected ? 'ff-primary' : 'ff-muted'} /><span className="ff-h3">Google Drive</span></div>
              <BadgePill tone={driveConnection.connected ? 'success' : 'neutral'}>{driveConnection.connected ? 'Connected' : 'Not connected'}</BadgePill>
            </div>
            {driveConnection.connected ? (
              <div className="ff-stack ff-gap-8 ff-mt-16">
                <div className="ff-info-pair"><span>Account</span><span className="ff-truncate">{driveConnection.accountEmail}</span></div>
                <div className="ff-info-pair"><span>Target folder</span><span className="ff-code">{driveConnection.targetFolder}</span></div>
                <div className="ff-info-pair"><span>Last sync</span><span>{driveConnection.lastSync}</span></div>
                <Button className="ff-mt-12" fullWidth onClick={() => navigate('/settings?tab=connections')}>Manage connection</Button>
              </div>
            ) : (
              <div className="ff-mt-12">
                <p className="ff-body-sm ff-muted">Connect your Google account to automatically import documents from Google Drive.</p>
                <Button className="ff-mt-12" fullWidth variant="primary" icon={Cloud} onClick={() => navigate('/settings?tab=connections')}>Connect Google Drive</Button>
              </div>
            )}
          </Card>

          <Card className="ff-section-card">
            <div className="ff-row ff-between">
              <div className="ff-row ff-gap-8"><Chrome size={17} className={extensionConnection.connected ? 'ff-primary' : 'ff-muted'} /><span className="ff-h3">Chrome extension</span></div>
              <BadgePill tone={extensionConnection.connected ? 'success' : 'neutral'}>
                {extensionConnection.connected ? 'Connected' : 'Not connected'}
              </BadgePill>
            </div>
            <div className="ff-stack ff-gap-8 ff-mt-16">
              <div className="ff-info-pair"><span>Status</span><span className="ff-row ff-gap-6">{extensionConnection.connected ? <><span className="ff-dot" style={{ color: 'var(--ff-success)' }} /> Active</> : <span className="ff-muted">Not detected</span>}</span></div>
              <div className="ff-info-pair"><span>Autofill shortcut</span><span className="ff-kbd">{extensionConnection.shortcut}</span></div>
              <div className="ff-info-pair"><span>Keylogging</span><span className="ff-muted">Disabled</span></div>
            </div>
            <Button className="ff-mt-12" fullWidth icon={BookOpenCheck} onClick={() => navigate('/extension')}>
              {extensionConnection.connected ? 'Extension settings' : 'Set up extension'}
            </Button>
          </Card>

          <Card className="ff-section-card" style={{ background: 'linear-gradient(135deg, #ffffff 0%, #f2f3ff 100%)' }}>
            <div className="ff-row ff-between">
              <div className="ff-row ff-gap-8">
                <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30, borderRadius: 8, background: 'var(--ff-primary-bright)', color: '#fff' }}><Zap size={16} /></span>
                <div><div className="ff-h3">Form intelligence</div><div className="ff-body-sm ff-muted">Review every suggestion first.</div></div>
              </div>
            </div>
            <div className="ff-stack ff-gap-8 ff-mt-16">
              <div className="ff-info-pair"><span>Available fields</span><span>{fields.length} values</span></div>
              <div className="ff-info-pair"><span>Documents ready</span><span>{processedCount} of {documents.length}</span></div>
              <div className="ff-info-pair"><span>Recent forms</span><span>{formEvents.length} events</span></div>
            </div>
            <Button className="ff-mt-12" fullWidth variant="dark" icon={FolderOpen} onClick={() => navigate('/documents')}>Open document vault</Button>
          </Card>

          <div className="ff-note" style={{ display: 'flex', gap: 9, alignItems: 'flex-start' }}>
            <ShieldCheck size={16} style={{ flex: '0 0 auto', color: 'var(--ff-success)' }} />
            <span><strong>Privacy by design.</strong> FormFlow does not submit forms without review and never alters your original files.</span>
          </div>
        </div>
      </div>
    </div>
  );
}
