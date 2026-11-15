import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/utils/cn';

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  flat?: boolean;
  soft?: boolean;
}

export function Card({ children, className, flat, soft, ...props }: CardProps) {
  return (
    <div className={cn('ff-card', flat && 'ff-card--flat', soft && 'ff-card--soft', className)} {...props}>
      {children}
    </div>
  );
}

interface CardHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function CardHeader({ title, subtitle, action, className }: CardHeaderProps) {
  return (
    <div className={cn('ff-card-header', className)}>
      <div style={{ minWidth: 0 }}>
        <div className="ff-h3">{title}</div>
        {subtitle ? <div className="ff-body-sm ff-muted" style={{ marginTop: 2 }}>{subtitle}</div> : null}
      </div>
      {action}
    </div>
  );
}
