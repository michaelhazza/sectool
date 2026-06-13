import { useState } from 'react';
import { Sidebar, MobileTopbar, MobileBottomNav } from './components/Sidebar.js';
import { PortfolioOverview } from './screens/PortfolioOverview.js';
import { RunReport } from './screens/RunReport.js';
import { FindingDetail } from './screens/FindingDetail.js';
import { Fixes } from './screens/Fixes.js';
import { Trends } from './screens/Trends.js';
import { TargetsSafety } from './screens/TargetsSafety.js';

type Screen = 'portfolio' | 'runReport' | 'fixes' | 'trends' | 'targets';

interface AppState {
  screen: Screen;
  findingFingerprint?: string | undefined;
}

export function App() {
  const [state, setState] = useState<AppState>({ screen: 'portfolio' });

  function navigate(screen: Screen) {
    setState({ screen });
  }

  function navigateToFinding(fingerprint: string) {
    setState({ screen: 'runReport', findingFingerprint: fingerprint });
  }

  function backFromFinding() {
    setState({ screen: 'runReport' });
  }

  const screenContent = (() => {
    if (state.screen === 'runReport' && state.findingFingerprint) {
      return <FindingDetail fingerprint={state.findingFingerprint} onBack={backFromFinding} />;
    }
    switch (state.screen) {
      case 'portfolio':
        return <PortfolioOverview onNavigateToRunReport={() => navigate('runReport')} />;
      case 'runReport':
        return <RunReport onNavigateToFinding={navigateToFinding} />;
      case 'fixes':
        return <Fixes />;
      case 'trends':
        return <Trends />;
      case 'targets':
        return <TargetsSafety />;
    }
  })();

  return (
    <div className="app-shell">
      <Sidebar active={state.screen} onNavigate={navigate} />
      <MobileTopbar onMenuOpen={() => {}} />
      <main className="main-content">
        {screenContent}
      </main>
      <MobileBottomNav active={state.screen} onNavigate={navigate} />
    </div>
  );
}
