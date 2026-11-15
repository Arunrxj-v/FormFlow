import type { ReactNode } from 'react';
import { FileCheck2, LockKeyhole, ScanSearch, ShieldCheck } from 'lucide-react';
import { Logo } from '@/components/brand/Logo';

interface AuthLayoutProps {
  title: string;
  subtitle: string;
  children: ReactNode;
  footer?: ReactNode;
}

export function AuthLayout({ title, subtitle, children, footer }: AuthLayoutProps) {
  return (
    <div className="ff-auth-page">
      <section className="ff-auth-panel">
        <div className="ff-auth-card">
          <div className="ff-auth-brand"><Logo /></div>
          <h1 className="ff-auth-title">{title}</h1>
          <p className="ff-auth-subtitle">{subtitle}</p>
          {children}
          {footer ? <div className="ff-auth-footer">{footer}</div> : null}
          <p className="ff-auth-legal">
            FormFlow is a document-powered form assistant. It never submits forms for you.
          </p>
        </div>
      </section>
      <aside className="ff-auth-aside" aria-label="FormFlow overview">
        <div style={{ position: 'relative', zIndex: 1 }}>
          <Logo />
        </div>
        <div className="ff-auth-aside__content">
          <span className="ff-auth-aside__eyebrow"><ShieldCheck size={12} /> Precision vault</span>
          <h2>Your documents, ready for the next form.</h2>
          <p>
            Connect the documents you choose. FormFlow extracts the details you approve and makes them
            available when a form needs them — with review before every fill.
          </p>
          <div className="ff-auth-features">
            <div className="ff-auth-feature">
              <span className="ff-auth-feature__icon"><ScanSearch size={14} /></span>
              Field detection with explicit source attribution
            </div>
            <div className="ff-auth-feature">
              <span className="ff-auth-feature__icon"><FileCheck2 size={14} /></span>
              Review matched values before autofill
            </div>
            <div className="ff-auth-feature">
              <span className="ff-auth-feature__icon"><LockKeyhole size={14} /></span>
              Google Drive access limited to files you select
            </div>
          </div>
        </div>
        <div className="ff-auth-quote">
          FormFlow never asks for your Google password, never silently submits a form, and never
          shares your vault without your approval. All data remains securely stored in your local vault.
        </div>
      </aside>
    </div>
  );
}
