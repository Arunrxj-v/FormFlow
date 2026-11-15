import { Zap } from 'lucide-react';
import { APP_VERSION } from '@shared/constants';
import { cn } from '@/utils/cn';

interface LogoProps {
  size?: 'sm' | 'md' | 'lg';
  withWordmark?: boolean;
  className?: string;
}

export function Logo({ size = 'md', withWordmark = true, className }: LogoProps) {
  const dimension = size === 'sm' ? 24 : size === 'lg' ? 36 : 30;
  return (
    <div className={cn('ff-logo', className)}>
      <span className="ff-logo__mark" style={{ width: dimension, height: dimension, borderRadius: size === 'lg' ? 10 : 8 }}>
        <Zap size={dimension * 0.53} strokeWidth={2.4} fill="currentColor" />
      </span>
      {withWordmark ? (
        <span className="ff-logo__wordmark">
          FormFlow
          <span className="ff-logo__version">v{APP_VERSION}</span>
        </span>
      ) : null}
    </div>
  );
}
