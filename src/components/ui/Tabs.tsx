import type { ReactNode } from 'react';

interface TabItem {
  id: string;
  label: string;
  icon?: ReactNode;
  count?: number;
}

interface TabsProps {
  items: TabItem[];
  value: string;
  onChange: (id: string) => void;
  ariaLabel: string;
}

export function Tabs({ items, value, onChange, ariaLabel }: TabsProps) {
  return (
    <div className="ff-tabs" role="tablist" aria-label={ariaLabel}>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={value === item.id}
          data-active={value === item.id}
          className="ff-tab"
          onClick={() => onChange(item.id)}
        >
          {item.icon}
          {item.label}
          {typeof item.count === 'number' ? (
            <span style={{ marginLeft: 5, color: 'var(--ff-text-muted)', fontSize: 11 }}>{item.count}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
