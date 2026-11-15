import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/utils/cn';

type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'primary' | 'solid';

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  dot?: boolean;
  children: ReactNode;
}

export function Badge({ tone = 'neutral', dot = true, className, children, ...props }: BadgeProps) {
  return (
    <span className={cn('ff-badge', tone !== 'neutral' && `ff-badge--${tone}`, !dot && 'ff-badge--plain', className)} {...props}>
      {children}
    </span>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const tone: BadgeTone =
    status === 'processed' || status === 'completed' || status === 'Completed'
      ? 'success'
      : status === 'processing' || status === 'extracting_text' || status === 'extracting_information' || status === 'Partially completed'
        ? 'primary'
        : status === 'failed' || status === 'Failed'
          ? 'danger'
          : status === 'needs_attention' || status === 'Cancelled'
            ? 'warning'
            : 'neutral';
  const label =
    status === 'needs_attention'
      ? 'Needs attention'
      : status === 'extracting_text'
        ? 'Extracting text'
        : status === 'extracting_information'
          ? 'Extracting fields'
          : status === 'processing'
            ? 'Processing'
            : status === 'processed' || status === 'completed' || status === 'Completed'
              ? 'Processed'
              : status === 'queued' || status === 'uploaded'
                ? 'Queued'
                : status === 'failed' || status === 'Failed'
                  ? 'Processing failed'
                  : status;
  return <Badge tone={tone}>{label}</Badge>;
}
