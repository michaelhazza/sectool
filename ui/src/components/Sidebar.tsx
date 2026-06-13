import { NAV_LABELS } from '../vocabulary.js';

type Screen = 'portfolio' | 'runReport' | 'fixes' | 'trends' | 'targets';

interface SidebarProps {
  active: Screen;
  onNavigate: (screen: Screen, params?: Record<string, string>) => void;
  criticalCount?: number;
  reopenedFixCount?: number;
}

const ShieldIcon = () => (
  <svg viewBox="0 0 20 20" fill="white" width="16" height="16">
    <path fillRule="evenodd" d="M2.166 4.999A11.954 11.954 0 0010 1.944 11.954 11.954 0 0017.834 5c.11.65.166 1.32.166 2.001 0 5.225-3.34 9.67-8 11.317C5.34 16.67 2 12.225 2 7c0-.682.057-1.35.166-2.001zm11.541 3.708a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
  </svg>
);

const HomeIcon = () => (
  <svg className="nav-item-icon" viewBox="0 0 20 20" fill="currentColor">
    <path d="M10.707 2.293a1 1 0 00-1.414 0l-7 7a1 1 0 001.414 1.414L4 10.414V17a1 1 0 001 1h2a1 1 0 001-1v-2a1 1 0 011-1h2a1 1 0 011 1v2a1 1 0 001 1h2a1 1 0 001-1v-6.586l.293.293a1 1 0 001.414-1.414l-7-7z" />
  </svg>
);

const FilterIcon = () => (
  <svg className="nav-item-icon" viewBox="0 0 20 20" fill="currentColor">
    <path fillRule="evenodd" d="M3 4a1 1 0 011-1h12a1 1 0 011 1v2a1 1 0 01-.293.707L13 10.414V15a1 1 0 01-.553.894l-4 2A1 1 0 017 17v-6.586L3.293 6.707A1 1 0 013 6V4z" clipRule="evenodd" />
  </svg>
);

const GearIcon = () => (
  <svg className="nav-item-icon" viewBox="0 0 20 20" fill="currentColor">
    <path fillRule="evenodd" d="M6.267 3.455a3.066 3.066 0 001.745-.723 3.066 3.066 0 013.976 0 3.066 3.066 0 001.745.723 3.066 3.066 0 012.812 2.812c.051.643.304 1.254.723 1.745a3.066 3.066 0 010 3.976 3.066 3.066 0 00-.723 1.745 3.066 3.066 0 01-2.812 2.812 3.066 3.066 0 00-1.745.723 3.066 3.066 0 01-3.976 0 3.066 3.066 0 00-1.745-.723 3.066 3.066 0 01-2.812-2.812 3.066 3.066 0 00-.723-1.745 3.066 3.066 0 010-3.976 3.066 3.066 0 00.723-1.745 3.066 3.066 0 012.812-2.812zm7.44 5.252a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
  </svg>
);

const TrendIcon = () => (
  <svg className="nav-item-icon" viewBox="0 0 20 20" fill="currentColor">
    <path d="M2 11a1 1 0 011-1h2a1 1 0 011 1v5a1 1 0 01-1 1H3a1 1 0 01-1-1v-5zM8 7a1 1 0 011-1h2a1 1 0 011 1v9a1 1 0 01-1 1H9a1 1 0 01-1-1V7zM14 4a1 1 0 011-1h2a1 1 0 011 1v12a1 1 0 01-1 1h-2a1 1 0 01-1-1V4z" />
  </svg>
);

const LockIcon = () => (
  <svg className="nav-item-icon" viewBox="0 0 20 20" fill="currentColor">
    <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
  </svg>
);

export function Sidebar({ active, onNavigate, criticalCount, reopenedFixCount }: SidebarProps) {
  function navBtn(screen: Screen) {
    return (cls: string) => (e: React.MouseEvent | React.KeyboardEvent) => {
      e.preventDefault();
      onNavigate(screen);
    };
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-logo">
        <div className="sidebar-logo-icon">
          <ShieldIcon />
        </div>
        <div>
          <div className="sidebar-logo-text">Audit Tool</div>
          <div className="sidebar-logo-sub">Breakout Solutions</div>
        </div>
      </div>
      <nav className="sidebar-nav">
        <div className="nav-section-label">Views</div>
        <button
          className={`nav-item${active === 'portfolio' ? ' active' : ''}`}
          onClick={navBtn('portfolio')('')}
        >
          <HomeIcon />
          {NAV_LABELS.portfolio}
          {typeof criticalCount === 'number' && criticalCount > 0 && (
            <span className="nav-badge">{criticalCount}</span>
          )}
        </button>
        <button
          className={`nav-item${active === 'runReport' ? ' active' : ''}`}
          onClick={navBtn('runReport')('')}
        >
          <FilterIcon />
          {NAV_LABELS.runReport}
        </button>
        <button
          className={`nav-item${active === 'fixes' ? ' active' : ''}`}
          onClick={navBtn('fixes')('')}
        >
          <GearIcon />
          {NAV_LABELS.fixes}
          {typeof reopenedFixCount === 'number' && reopenedFixCount > 0 && (
            <span className="nav-badge-fix">{reopenedFixCount}</span>
          )}
        </button>
        <button
          className={`nav-item${active === 'trends' ? ' active' : ''}`}
          onClick={navBtn('trends')('')}
        >
          <TrendIcon />
          {NAV_LABELS.trends}
        </button>
        <button
          className={`nav-item${active === 'targets' ? ' active' : ''}`}
          onClick={navBtn('targets')('')}
        >
          <LockIcon />
          {NAV_LABELS.targets}
        </button>
      </nav>
      <div className="sidebar-footer">
        Read-only view<br />
        v1 · localhost:4173
      </div>
    </aside>
  );
}

// Mobile top bar
interface MobileTopbarProps {
  onMenuOpen: () => void;
}

export function MobileTopbar({ onMenuOpen }: MobileTopbarProps) {
  return (
    <div className="mobile-topbar">
      <div className="mobile-topbar-logo">
        <div className="sidebar-logo-icon" style={{ width: 26, height: 26 }}>
          <ShieldIcon />
        </div>
        Audit Tool
      </div>
      <button className="mobile-menu-btn" onClick={onMenuOpen} aria-label="Open menu">
        <svg viewBox="0 0 20 20" fill="currentColor" width="20" height="20">
          <path fillRule="evenodd" d="M3 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 10a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 15a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" clipRule="evenodd" />
        </svg>
      </button>
    </div>
  );
}

// Mobile bottom nav (5 tabs)
interface MobileBottomNavProps {
  active: Screen;
  onNavigate: (screen: Screen) => void;
}

export function MobileBottomNav({ active, onNavigate }: MobileBottomNavProps) {
  return (
    <nav className="mobile-bottomnav" aria-label="Mobile navigation">
      <div className="mobile-bottomnav-inner">
        <button className={`mobile-nav-item${active === 'portfolio' ? ' active' : ''}`} onClick={() => onNavigate('portfolio')}>
          <svg viewBox="0 0 20 20" fill="currentColor"><path d="M10.707 2.293a1 1 0 00-1.414 0l-7 7a1 1 0 001.414 1.414L4 10.414V17a1 1 0 001 1h2a1 1 0 001-1v-2a1 1 0 011-1h2a1 1 0 011 1v2a1 1 0 001 1h2a1 1 0 001-1v-6.586l.293.293a1 1 0 001.414-1.414l-7-7z" /></svg>
          Overview
        </button>
        <button className={`mobile-nav-item${active === 'runReport' ? ' active' : ''}`} onClick={() => onNavigate('runReport')}>
          <svg viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M3 4a1 1 0 011-1h12a1 1 0 011 1v2a1 1 0 01-.293.707L13 10.414V15a1 1 0 01-.553.894l-4 2A1 1 0 017 17v-6.586L3.293 6.707A1 1 0 013 6V4z" clipRule="evenodd" /></svg>
          Findings
        </button>
        <button className={`mobile-nav-item${active === 'fixes' ? ' active' : ''}`} onClick={() => onNavigate('fixes')}>
          <svg viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M6.267 3.455a3.066 3.066 0 001.745-.723 3.066 3.066 0 013.976 0 3.066 3.066 0 001.745.723 3.066 3.066 0 012.812 2.812c.051.643.304 1.254.723 1.745a3.066 3.066 0 010 3.976 3.066 3.066 0 00-.723 1.745 3.066 3.066 0 01-2.812 2.812 3.066 3.066 0 00-1.745.723 3.066 3.066 0 01-3.976 0 3.066 3.066 0 00-1.745-.723 3.066 3.066 0 01-2.812-2.812 3.066 3.066 0 00-.723-1.745 3.066 3.066 0 010-3.976 3.066 3.066 0 00.723-1.745 3.066 3.066 0 012.812-2.812zm7.44 5.252a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" /></svg>
          Fixes
        </button>
        <button className={`mobile-nav-item${active === 'trends' ? ' active' : ''}`} onClick={() => onNavigate('trends')}>
          <svg viewBox="0 0 20 20" fill="currentColor"><path d="M2 11a1 1 0 011-1h2a1 1 0 011 1v5a1 1 0 01-1 1H3a1 1 0 01-1-1v-5zM8 7a1 1 0 011-1h2a1 1 0 011 1v9a1 1 0 01-1 1H9a1 1 0 01-1-1V7zM14 4a1 1 0 011-1h2a1 1 0 011 1v12a1 1 0 01-1 1h-2a1 1 0 01-1-1V4z" /></svg>
          Trends
        </button>
        <button className={`mobile-nav-item${active === 'targets' ? ' active' : ''}`} onClick={() => onNavigate('targets')}>
          <svg viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" /></svg>
          Targets
        </button>
      </div>
    </nav>
  );
}
