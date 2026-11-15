import { forwardRef, useState, type InputHTMLAttributes } from 'react';
import { Eye, EyeOff, Search } from 'lucide-react';
import { cn } from '@/utils/cn';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  error?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, id, className, ...props },
  ref,
) {
  const inputId = id ?? props.name;
  return (
    <div className="ff-field">
      {label ? (
        <label className="ff-field__label" htmlFor={inputId}>
          {label}
        </label>
      ) : null}
      <input
        ref={ref}
        id={inputId}
        className={cn('ff-input', error && 'ff-input--error', className)}
        aria-invalid={Boolean(error)}
        {...props}
      />
      {error ? <span className="ff-field__error">{error}</span> : hint ? <span className="ff-field__hint">{hint}</span> : null}
    </div>
  );
});

export const PasswordInput = forwardRef<HTMLInputElement, InputProps>(function PasswordInput(
  { label, hint, error, id, className, ...props },
  ref,
) {
  const [visible, setVisible] = useState(false);
  const inputId = id ?? props.name;
  return (
    <div className="ff-field">
      {label ? (
        <label className="ff-field__label" htmlFor={inputId}>
          {label}
        </label>
      ) : null}
      <div className="ff-input-wrap">
        <input
          ref={ref}
          id={inputId}
          type={visible ? 'text' : 'password'}
          className={cn('ff-input', error && 'ff-input--error', className)}
          style={{ paddingRight: 38 }}
          aria-invalid={Boolean(error)}
          {...props}
        />
        <button
          type="button"
          className="ff-input-wrap__action"
          onClick={() => setVisible((current) => !current)}
          aria-label={visible ? 'Hide password' : 'Show password'}
          title={visible ? 'Hide password' : 'Show password'}
        >
          {visible ? <EyeOff size={16} strokeWidth={1.8} /> : <Eye size={16} strokeWidth={1.8} />}
        </button>
      </div>
      {error ? <span className="ff-field__error">{error}</span> : hint ? <span className="ff-field__hint">{hint}</span> : null}
    </div>
  );
});

interface SearchInputProps extends InputHTMLAttributes<HTMLInputElement> {
  shortcut?: string;
}

export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(function SearchInput(
  { className, shortcut, ...props },
  ref,
) {
  return (
    <div className={cn('ff-input-wrap', className)}>
      <Search size={16} strokeWidth={1.8} />
      <input ref={ref} className="ff-input" style={{ paddingRight: shortcut ? 40 : undefined }} {...props} />
      {shortcut ? <kbd className="ff-kbd" style={{ position: 'absolute', right: 7 }}>{shortcut}</kbd> : null}
    </div>
  );
});
