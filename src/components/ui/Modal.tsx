import { useEffect, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { createPortal } from 'react-dom';
import { cn } from '@/utils/cn';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}

export function Modal({ open, onClose, title, description, children, footer, wide }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  if (!open) return null;
  return createPortal(
    <div className="ff-overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className={cn('ff-modal', wide && 'ff-modal--wide')} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : 'Dialog'}>
        <div className="ff-modal__header">
          <div>
            <div className="ff-h2">{title}</div>
            {description ? <div className="ff-body-sm ff-muted" style={{ marginTop: 3 }}>{description}</div> : null}
          </div>
          <button type="button" className="ff-btn ff-btn--icon-sm" onClick={onClose} aria-label="Close dialog">
            <X size={17} />
          </button>
        </div>
        <div className="ff-modal__body">{children}</div>
        {footer ? <div className="ff-modal__footer">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onClose: () => void;
  loading?: boolean;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  destructive,
  onConfirm,
  onClose,
  loading,
}: ConfirmDialogProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <button type="button" className="ff-btn" onClick={onClose} disabled={loading}>
            Cancel
          </button>
          <button
            type="button"
            className={cn('ff-btn', destructive ? 'ff-btn--danger' : 'ff-btn--primary')}
            onClick={onConfirm}
            disabled={loading}
          >
            {loading ? <span className="ff-spinner ff-spinner--light" /> : null}
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className="ff-body-sm ff-muted" style={{ lineHeight: 20 }}>{description}</div>
    </Modal>
  );
}
