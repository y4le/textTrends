import { lazy, Suspense } from 'react';
import { TrendSettings } from './TrendSettings.tsx';
import type { Place } from '../lib/places.ts';
import { PLACE_HEADING } from '../lib/places.ts';
import { shortcutAria } from '../lib/shortcuts.ts';
import { UtilityPane } from './UtilityPane.tsx';

const MethodSummary = lazy(() =>
  import('./MethodSummary.tsx').then(({ MethodSummary: summary }) => ({ default: summary })),
);

export function MethodSurface({
  place,
  onClose,
}: {
  readonly place: Place;
  readonly onClose: () => void;
}) {
  const title = place === 'trends' ? 'Method & settings' : 'Method';

  return (
    <UtilityPane
      title={title}
      subtitle={`${PLACE_HEADING[place]} · Analysis assumptions, resident evidence, and export provenance.`}
      closeKeyshortcuts={shortcutAria(['reader-close'])}
      className="method-pane"
      onClose={onClose}
    >
      <div className="method-pane-columns" data-settings={place === 'trends' || undefined}>
        {place === 'trends' && <TrendSettings onApplied={onClose} />}
        <Suspense fallback={<p className="region-placeholder">loading Method…</p>}>
          <MethodSummary place={place} />
        </Suspense>
      </div>
    </UtilityPane>
  );
}
