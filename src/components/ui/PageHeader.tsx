import type { ReactNode } from 'react';

interface PageHeaderProps {
  eyebrow?: ReactNode;
  title: string;
  description?: string;
  actions?: ReactNode;
}

export function PageHeader({ eyebrow, title, description, actions }: PageHeaderProps) {
  return (
    <div className="ff-page-header">
      <div style={{ minWidth: 0 }}>
        {eyebrow ? <div className="ff-page-header__eyebrow">{eyebrow}</div> : null}
        <h1 className="ff-h1">{title}</h1>
        {description ? <p className="ff-body-sm ff-muted" style={{ marginTop: 3 }}>{description}</p> : null}
      </div>
      {actions ? <div className="ff-page-header__actions">{actions}</div> : null}
    </div>
  );
}
