import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  Briefcase,
  Clock3,
  FileText,
  GraduationCap,
  Home,
  MapPin,
  Settings,
  Shield,
  SlidersHorizontal,
  User,
} from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { SearchInput } from '@/components/ui/Input';

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

const commands = [
  { label: 'Overview', hint: 'Workspace health and recent activity', to: '/dashboard', icon: Home, group: 'Navigate' },
  { label: 'Personal Profile', hint: 'Identity and contact details', to: '/records/personal', icon: User, group: 'My information' },
  { label: 'Addresses', hint: 'Permanent and current address', to: '/records/addresses', icon: MapPin, group: 'My information' },
  { label: 'Education', hint: 'Degrees and academic records', to: '/records/education', icon: GraduationCap, group: 'My information' },
  { label: 'Employment', hint: 'Roles, employers, and skills', to: '/records/employment', icon: Briefcase, group: 'My information' },
  { label: 'Document Vault', hint: 'Browse and inspect documents', to: '/documents', icon: FileText, group: 'Documents' },
  { label: 'Form history', hint: 'Autofill activity and outcomes', to: '/history', icon: Clock3, group: 'Activity' },
  { label: 'Autofill Settings', hint: 'Confirmation and notification preferences', to: '/settings?tab=preferences', icon: SlidersHorizontal, group: 'Settings' },
  { label: 'Privacy & Security', hint: 'Access, data, and account controls', to: '/settings?tab=privacy', icon: Shield, group: 'Settings' },
  { label: 'Account settings', hint: 'Profile, Google Drive, and extension', to: '/settings', icon: Settings, group: 'Settings' },
];

export function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (open) {
      setQuery('');
      window.setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  const results = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return commands.slice(0, 8);
    return commands.filter((command) => `${command.label} ${command.hint}`.toLowerCase().includes(normalized));
  }, [query]);

  const go = (to: string) => {
    onClose();
    navigate(to);
  };

  return (
    <Modal open={open} onClose={onClose} title="Quick search" description="Jump to a record, document, or setting.">
      <SearchInput
        ref={inputRef}
        placeholder="Search fields, records, and pages…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && results[0]) go(results[0].to);
        }}
      />
      <div className="ff-command-list ff-scroll">
        {results.length ? (
          results.map((command) => {
            const Icon = command.icon;
            return (
              <button key={`${command.group}-${command.label}`} type="button" className="ff-command-item" onClick={() => go(command.to)}>
                <span className="ff-command-item__icon"><Icon size={16} strokeWidth={1.8} /></span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span className="ff-label">{command.label}</span>
                  <span className="ff-body-sm ff-muted ff-truncate" style={{ display: 'block' }}>{command.hint}</span>
                </span>
                <span className="ff-code ff-subtle">{command.group}</span>
                <ArrowRight size={14} className="ff-subtle" />
              </button>
            );
          })
        ) : (
          <div className="ff-empty" style={{ padding: '28px 12px' }}>
            <div className="ff-h3">No matching destination</div>
            <p className="ff-body-sm ff-muted">Try “education”, “vault”, or “privacy”.</p>
          </div>
        )}
      </div>
      <div className="ff-command-footer">
        <span><kbd className="ff-kbd">↵</kbd> open first result</span>
        <span><kbd className="ff-kbd">esc</kbd> close</span>
      </div>
    </Modal>
  );
}
