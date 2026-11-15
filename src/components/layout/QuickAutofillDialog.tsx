import { useNavigate } from 'react-router-dom';
import { ArrowUpRight, Chrome, FileCheck2, MousePointerClick, ShieldCheck } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { useApp } from '@/context/AppContext';
import { APP_VERSION } from '@shared/constants';

interface QuickAutofillDialogProps {
  open: boolean;
  onClose: () => void;
}

export function QuickAutofillDialog({ open, onClose }: QuickAutofillDialogProps) {
  const navigate = useNavigate();
  const { vaultStatus } = useApp();
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Quick Autofill"
      description="Autofill happens in the browser tab, with your review before anything is filled."
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button
            variant="primary"
            icon={ArrowUpRight}
            onClick={() => {
              onClose();
              navigate('/extension');
            }}
          >
            Extension setup
          </Button>
        </>
      }
    >
      <div className="ff-autofill-dialog">
        <div className="ff-autofill-dialog__status">
          <span className={`ff-status-dot ${vaultStatus?.unlocked ? 'is-online' : ''}`} />
          <div>
            <div className="ff-label">{vaultStatus?.unlocked ? 'Encrypted vault unlocked' : 'Vault locked'}</div>
            <div className="ff-body-sm ff-muted">Extension v{APP_VERSION} · local-only autofill</div>
          </div>
        </div>
        <div className="ff-steps-compact">
          <div><MousePointerClick size={17} /><span>Open the form you want to fill in Chrome.</span></div>
          <div><Chrome size={17} /><span>Open FormFlow from the extensions toolbar.</span></div>
          <div><FileCheck2 size={17} /><span>Review matched fields, then approve autofill.</span></div>
          <div><ShieldCheck size={17} /><span>FormFlow never submits the form for you.</span></div>
        </div>
        <div className="ff-note">
          Install and load the unpacked extension from extension/dist in Chrome to enable active form detection and autofill.
        </div>
      </div>
    </Modal>
  );
}
