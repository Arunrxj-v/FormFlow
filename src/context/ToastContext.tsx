import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';

type ToastTone = 'info' | 'success' | 'error';

interface ToastItem {
  id: number;
  tone: ToastTone;
  title: string;
  message?: string;
}

interface ToastContextValue {
  toast: (input: { tone?: ToastTone; title: string; message?: string }) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const counter = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const toast = useCallback(
    ({ tone = 'info', title, message }: { tone?: ToastTone; title: string; message?: string }) => {
      const id = ++counter.current;
      setToasts((current) => [...current.slice(-3), { id, tone, title, message }]);
      window.setTimeout(() => dismiss(id), 5000);
    },
    [dismiss],
  );

  const value = useMemo(() => ({ toast }), [toast]);
  const Icon = ({ tone }: { tone: ToastTone }) =>
    tone === 'success' ? <CheckCircle2 size={14} /> : tone === 'error' ? <AlertCircle size={14} /> : <Info size={14} />;

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="ff-toast-stack" aria-live="polite">
        {toasts.map((item) => (
          <div key={item.id} className={`ff-toast ff-toast--${item.tone}`} role={item.tone === 'error' ? 'alert' : 'status'}>
            <div className="ff-toast__icon">
              <Icon tone={item.tone} />
            </div>
            <div className="ff-toast__body">
              <div className="ff-toast__title">{item.title}</div>
              {item.message ? <div className="ff-toast__message">{item.message}</div> : null}
            </div>
            <button type="button" className="ff-btn ff-btn--icon-sm" onClick={() => dismiss(item.id)} aria-label="Dismiss notification">
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const value = useContext(ToastContext);
  if (!value) throw new Error('useToast must be used inside ToastProvider');
  return value;
}
