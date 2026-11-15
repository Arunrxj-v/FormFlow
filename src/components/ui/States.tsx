import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/utils/cn';

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cn('ff-empty', className)}>
      <div className="ff-empty__icon">
        <Icon size={21} strokeWidth={1.7} />
      </div>
      <div className="ff-h3">{title}</div>
      <p className="ff-body-sm ff-muted" style={{ maxWidth: 340 }}>{description}</p>
      {action ? <div style={{ marginTop: 8 }}>{action}</div> : null}
    </div>
  );
}

export function Spinner({ light, size = 16 }: { light?: boolean; size?: number }) {
  return (
    <span
      className={cn('ff-spinner', light && 'ff-spinner--light')}
      style={{ width: size, height: size }}
      aria-label="Loading"
      role="status"
    />
  );
}

export function Skeleton({ width, height = 12, radius = 6 }: { width?: number | string; height?: number; radius?: number }) {
  return <span className="ff-skeleton" style={{ display: 'block', width: width ?? '100%', height, borderRadius: radius }} />;
}

export function ProgressBar({ value, label }: { value: number; label?: string }) {
  return (
    <div>
      {label ? <div className="ff-label-sm ff-muted" style={{ marginBottom: 6 }}>{label}</div> : null}
      <div className="ff-progress" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}>
        <div className="ff-progress__bar" style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
      </div>
    </div>
  );
}
