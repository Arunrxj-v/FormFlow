import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  BookOpen,
  ChevronRight,
  LogOut,
  Menu,
  Plus,
  Search,
  Settings,
  User,
} from 'lucide-react';
import { useApp } from '@/context/AppContext';
import { Button } from '@/components/ui/Button';

interface TopbarProps {
  onOpenMobileNav: () => void;
  onOpenSearch: () => void;
  onQuickAutofill: () => void;
}

const labels: Record<string, string> = {
  dashboard: 'Overview',
  documents: 'Document Vault',
  history: 'Form history',
  settings: 'Settings',
  extension: 'Extension setup',
  collections: 'Collections',
  'demo-form': 'Demo form',
  records: 'My information',
  personal: 'Personal Profile',
  addresses: 'Addresses',
  education: 'Education',
  employment: 'Employment',
  skills: 'Skills & Certifications',
};

export function Topbar({ onOpenMobileNav, onOpenSearch, onQuickAutofill }: TopbarProps) {
  const { user, lockVault, vaultStatus } = useApp();
  const navigate = useNavigate();
  const location = useLocation();
  const [profileOpen, setProfileOpen] = useState(false);
  const profileRef = useRef<HTMLDivElement>(null);

  const segments = location.pathname.split('/').filter(Boolean);
  const currentLabel = labels[segments[segments.length - 1] ?? 'dashboard'] ?? 'Workspace';

  useEffect(() => {
    if (!profileOpen) return;
    const onClick = (event: MouseEvent) => {
      if (!profileRef.current?.contains(event.target as Node)) setProfileOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [profileOpen]);

  const handleLock = () => {
    setProfileOpen(false);
    void lockVault();
    navigate('/unlock');
  };

  return (
    <header className="ff-topbar">
      <div className="ff-topbar__left">
        <button type="button" className="ff-btn ff-btn--icon ff-mobile-menu" onClick={onOpenMobileNav} aria-label="Open navigation">
          <Menu size={19} />
        </button>
        <div className="ff-breadcrumb">
          <button type="button" onClick={() => navigate('/dashboard')}>FormFlow</button>
          <ChevronRight size={14} />
          <span>{currentLabel}</span>
        </div>
        <div className={vaultStatus?.unlocked ? 'ff-connection-pill' : 'ff-connection-pill ff-connection-pill--muted'}>
          <span className="ff-dot" />
          <span>{vaultStatus?.unlocked ? 'Local vault unlocked' : 'Local vault locked'}</span>
        </div>
      </div>

      <div className="ff-topbar__right">
        <button type="button" className="ff-topbar__search" onClick={onOpenSearch}>
          <Search size={15} />
          <span>Search fields, records</span>
          <kbd className="ff-kbd">/</kbd>
        </button>
        <Button variant="primary" size="sm" icon={Plus} onClick={onQuickAutofill}>
          Quick Autofill
        </Button>
        <div className="ff-profile-menu-wrap" ref={profileRef}>
          <button
            type="button"
            className="ff-avatar ff-avatar--button"
            onClick={() => setProfileOpen((current) => !current)}
            aria-label="Open account menu"
            aria-expanded={profileOpen}
          >
            {user?.avatarInitials ?? 'FF'}
          </button>
          {profileOpen ? (
            <div className="ff-menu ff-profile-menu" role="menu">
              <div className="ff-profile-menu__identity">
                <div className="ff-avatar ff-avatar--sm">{user?.avatarInitials ?? 'FF'}</div>
                <div style={{ minWidth: 0 }}>
                  <div className="ff-label ff-truncate">{user?.name}</div>
                  <div className="ff-body-sm ff-muted ff-truncate">{user?.email}</div>
                  <div className="ff-demo-chip">{user?.accountType || 'Personal Vault'}</div>
                </div>
              </div>
              <div className="ff-menu__sep" />
              <button type="button" className="ff-menu__item" onClick={() => { setProfileOpen(false); navigate('/records/personal'); }}>
                <User size={15} /> Personal profile
              </button>
              <button type="button" className="ff-menu__item" onClick={() => { setProfileOpen(false); navigate('/settings'); }}>
                <Settings size={15} /> Settings
              </button>
              <button type="button" className="ff-menu__item" onClick={() => { setProfileOpen(false); navigate('/extension'); }}>
                <BookOpen size={15} /> Extension setup
              </button>
              <div className="ff-menu__sep" />
              <button type="button" className="ff-menu__item ff-menu__item--danger" onClick={handleLock}>
                <LogOut size={15} /> Lock vault
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}
