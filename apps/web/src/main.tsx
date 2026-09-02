import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { PresentationProvider } from './components/PresentationProvider.tsx';
import { SeriesPaletteSync } from './components/SeriesPaletteSync.tsx';
import { GuideProvider } from './components/guide/GuideProvider.tsx';
import './lib/display-store.ts';
import './style/tokens.css';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root element');

createRoot(root).render(
  <StrictMode>
    <PresentationProvider>
      <SeriesPaletteSync />
      <GuideProvider>
        <App />
      </GuideProvider>
    </PresentationProvider>
  </StrictMode>,
);
