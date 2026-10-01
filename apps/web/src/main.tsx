import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary, ReloadAppContext } from './components/ErrorBoundary.tsx';
import { PresentationProvider } from './components/PresentationProvider.tsx';
import { SeriesPaletteSync } from './components/SeriesPaletteSync.tsx';
import { GuideProvider } from './components/guide/GuideProvider.tsx';
import './lib/display-store.ts';
import { shutdownAppForReload } from './lib/store-instance.ts';
// Styles are eager and ordered: feature slices retain their shared overrides.
import './style/tokens.css';
import './style/reader.css';
import './style/query-scope.css';
import './style/inputs.css';
import './style/analysis-views.css';
import './style/dock-settings.css';
import './style/terms.css';
import './style/trends.css';
import './style/footer.css';
import './style/footer-passage.css';
import './style/compact-navigation.css';
import './style/recovery.css';

const preserveBeforeReload = () => shutdownAppForReload({ preserveWorkspace: true });

const root = document.getElementById('root');
if (!root) throw new Error('missing #root element');

createRoot(root).render(
  <StrictMode>
    <ReloadAppContext.Provider value={preserveBeforeReload}>
      <ErrorBoundary>
        <PresentationProvider>
          <SeriesPaletteSync />
          <GuideProvider>
            <App />
          </GuideProvider>
        </PresentationProvider>
      </ErrorBoundary>
    </ReloadAppContext.Provider>
  </StrictMode>,
);
