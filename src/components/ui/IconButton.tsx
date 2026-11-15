import { forwardRef, type ButtonHTMLAttributes } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/utils/cn';

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LucideIcon;
  label: string;
  size?: 'sm' | 'md';
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon: Icon, label, size = 'md', className, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={props.type ?? 'button'}
      aria-label={label}
      title={label}
      className={cn(size === 'sm' ? 'ff-btn ff-btn--icon-sm' : 'ff-btn ff-btn--icon', className)}
      {...props}
    >
      <Icon size={size === 'sm' ? 16 : 17} strokeWidth={1.8} />
    </button>
  );
});
