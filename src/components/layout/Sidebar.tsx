import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  BadgeCheck,
  BookOpen,
  Briefcase,
  ChevronDown,
  Cloud,
  FolderCog,
  FolderLock,
  Layers3,
  Home,
  LockKeyhole,
  MapPin,
  Shield,
  SlidersHorizontal,
  User,
  X,
  GraduationCap,
} from 'lucide-react';
import { Logo } from '@/components/brand/Logo';
import { useApp } from '@/context/AppContext';
import { cn } from '@/utils/cn';

interface SidebarProps {
  mobileOpen: boolean;
  onCloseMobile: () => void;
  onOpenSearch: () => void;
}

const informationLinks = [
  { to: '/records/personal', label: 'Personal Profile', icon: User },
  { to: '/records/addresses', label: 'Addresses', icon: MapPin },
  { to: '/records/education', label: 'Education', icon: GraduationCap },
  { to: '/records/employment', label: 'Employment', icon: Briefcase },
  { to: '/records/skills', label: 'Skills & Certifications', icon: BadgeCheck },
];

export function Sidebar({ mobileOpen, onCloseMobile, onOpenSearch }: SidebarProps) {
  const { user, driveConnection, logout } = useApp();
  const navigate = useNavigate();
  const location = useLocation();

  const handleSignOut = () => {
    logout();
    navigate('/login');
  };

  const settingsTab = new URLSearchParams(location.search).get('tab');

  return (
    <>
      {mobileOpen ? <button className="ff-sidebar-scrim" type="button" aria-label="Close navigation" onClick={onCloseMobile} /> : null}
      <aside className={cn('ff-sidebar', mobileOpen && 'ff-sidebar--open')} aria-label="Primary navigation">
        <div className="ff-sidebar__top ff-scroll">
          <div className="ff-sidebar__brand-row">
            <Logo />
            <button className="ff-btn ff-btn--icon-sm ff-sidebar__close" type="button" onClick={onCloseMobile} aria-label="Close navigation">
              <X size={18} />
            </button>
          </div>

          <button className="ff-quick-search" type="button" onClick={onOpenSearch}>
            <span><SearchIcon /> Quick Search</span>
            <kbd className="ff-kbd">⌘K</kbd>
          </button>

          <nav className="ff-nav">
            <NavLink to="/dashboard" className={({ isActive }) => cn('ff-nav__link', isActive && 'is-active')} onClick={onCloseMobile}>
              <Home size={18} strokeWidth={1.8} />
              <span>Overview</span>
            </NavLink>

            <div className="ff-nav__group">
              <span className="ff-nav__label">My information</span>
              {informationLinks.map(({ to, label, icon: Icon }) => (
                <NavLink key={to} to={to} className={({ isActive }) => cn('ff-nav__link', isActive && 'is-active')} onClick={onCloseMobile}>
                  <Icon size={18} strokeWidth={1.8} />
                  <span>{label}</span>
                </NavLink>
              ))}
            </div>

            <div className="ff-nav__group">
              <span className="ff-nav__label">Documents</span>
              <NavLink to="/documents" className={({ isActive }) => cn('ff-nav__link', isActive && 'is-active')} onClick={onCloseMobile}>
                <FolderLock size={18} strokeWidth={1.8} />
                <span>Document Vault</span>
              </NavLink>
              <NavLink to="/collections" className={({ isActive }) => cn('ff-nav__link', isActive && 'is-active')} onClick={onCloseMobile}>
                <Layers3 size={18} strokeWidth={1.8} />
                <span>Collections</span>
              </NavLink>
            </div>

            <div className="ff-nav__group">
              <span className="ff-nav__label">Integrations</span>
              <NavLink to="/settings?tab=connections" className={({ isActive }) => cn('ff-nav__link ff-nav__link--split', isActive && 'is-active')} onClick={onCloseMobile}>
                <span className="ff-nav__link-main"><Cloud size={18} strokeWidth={1.8} /> Google Drive</span>
                <span className={cn('ff-pill ff-pill--tiny', driveConnection.connected ? 'ff-pill--success' : '')}>
                  <span className="ff-dot" /> {driveConnection.connected ? 'Connected' : 'Off'}
                </span>
              </NavLink>
              <NavLink to="/extension" className={({ isActive }) => cn('ff-nav__link', isActive && 'is-active')} onClick={onCloseMobile}>
                <BookOpen size={18} strokeWidth={1.8} />
                <span>Extension setup</span>
              </NavLink>
            </div>

            <div className="ff-nav__group">
              <span className="ff-nav__label">Preferences</span>
              <NavLink
                to="/settings?tab=preferences"
                className={() => cn('ff-nav__link', location.pathname === '/settings' && settingsTab === 'preferences' && 'is-active')}
                onClick={onCloseMobile}
              >
                <SlidersHorizontal size={18} strokeWidth={1.8} />
                <span>Autofill Settings</span>
              </NavLink>
              <NavLink
                to="/settings?tab=privacy"
                className={() => cn('ff-nav__link', location.pathname === '/settings' && settingsTab === 'privacy' && 'is-active')}
                onClick={onCloseMobile}
              >
                <Shield size={18} strokeWidth={1.8} />
                <span>Privacy &amp; Security</span>
              </NavLink>
              <NavLink to="/history" className={({ isActive }) => cn('ff-nav__link', isActive && 'is-active')} onClick={onCloseMobile}>
                <LockKeyhole size={18} strokeWidth={1.8} />
                <span>Form history</span>
              </NavLink>
            </div>
          </nav>
        </div>

        <div className="ff-sidebar__account">
          <div className="ff-sidebar__account-card">
            <div className="ff-avatar">{user?.avatarInitials ?? (user?.name ? user.name[0]?.toUpperCase() : 'U')}</div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="ff-label ff-truncate">{user?.name ?? 'Vault Account'}</div>
              <div className="ff-body-sm ff-muted ff-truncate">{user?.email ?? 'Not signed in'}</div>
            </div>
            <ChevronDown size={16} className="ff-muted" />
          </div>
          <div className="ff-sidebar__account-meta">
            <span><span className="ff-dot" /> Vault synced</span>
            <button type="button" onClick={handleSignOut} className="ff-link-button">Sign out</button>
          </div>
        </div>
      </aside>
    </>
  );
}

function SearchIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.4-3.4" />
    </svg>
  );
}
