import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/utils/cn';

export type ButtonVariant = 'primary' | 'dark' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: LucideIcon;
  trailingIcon?: LucideIcon;
  loading?: boolean;
  fullWidth?: boolean;
  children?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    icon: Icon,
    trailingIcon: TrailingIcon,
    loading,
    fullWidth,
    className,
    disabled,
    children,
    ...props
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={props.type ?? 'button'}
      className={cn(
        'ff-btn',
        variant !== 'secondary' && `ff-btn--${variant}`,
        size !== 'md' && `ff-btn--${size}`,
        fullWidth && 'ff-btn--full',
        className,
      )}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? <span className="ff-spinner ff-spinner--light" aria-hidden /> : Icon ? <Icon size={16} strokeWidth={1.8} /> : null}
      {children}
      {TrailingIcon ? <TrailingIcon size={15} strokeWidth={1.8} /> : null}
    </button>
  );
});
