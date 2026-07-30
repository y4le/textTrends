import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { PresentationProvider } from './components/PresentationProvider.tsx';
import './style/tokens.css';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root element');

createRoot(root).render(
  <StrictMode>
    <PresentationProvider>
      <App />
    </PresentationProvider>
  </StrictMode>,
);
