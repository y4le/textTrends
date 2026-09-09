// Passive timing marks are removed from the normal production build.
if (__TT_E2E__) performance.mark('tt:module:trends');

import { useApp } from '../lib/store-instance.ts';
import { TrendPanel } from '../components/TrendPanel.tsx';
import { TrendDistribution } from '../components/trends/TrendDistribution.tsx';

export function TrendsPlace() {
  if (__TT_E2E__) performance.mark('tt:render:trends');
  const series = useApp((state) => state.series);
  const trackTerm = () => {
    const openEntry = (attempt: number) => {
      const input = document.getElementById('term-inline-add-input');
      if (input instanceof HTMLInputElement) {
        input.focus({ preventScroll: true });
        return;
      }
      const control = document.getElementById('term-add');
      if (control instanceof HTMLButtonElement) {
        control.click();
        return;
      }
      if (attempt < 3) requestAnimationFrame(() => openEntry(attempt + 1));
    };
    openEntry(0);
  };

  return (
    <div className="analysis-stack">
      {series.length === 0
        ? (
            <section className="trend-empty-state" aria-labelledby="trend-empty-heading">
              <h2 id="trend-empty-heading">Start with a term</h2>
              <p>
                Trends follows the terms shown in your notebook across the active texts.
                Track one to draw its line and reading-strip marks.
              </p>
              <button type="button" onClick={trackTerm}>Track a term</button>
            </section>
          )
        : (
            <>
              <TrendPanel />
              <TrendDistribution />
            </>
          )}
    </div>
  );
}
