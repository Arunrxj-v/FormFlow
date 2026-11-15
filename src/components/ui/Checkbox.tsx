import type { InputHTMLAttributes, ReactNode } from 'react';

interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: ReactNode;
}

export function Checkbox({ label, id, ...props }: CheckboxProps) {
  const inputId = id ?? props.name;
  return (
    <label htmlFor={inputId} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
      <input id={inputId} type="checkbox" className="ff-checkbox" {...props} />
      {label ? <span className="ff-body-sm">{label}</span> : null}
    </label>
  );
}
