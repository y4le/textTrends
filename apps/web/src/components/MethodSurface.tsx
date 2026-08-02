import { lazy, Suspense } from 'react';
import { SheetFrame } from './SheetFrame.tsx';
import { usePresentation } from './PresentationProvider.tsx';
import { TrendSettings } from './TrendSettings.tsx';
import { sheetDetent, sheetSurface } from '../lib/sheet.ts';
import { useApp } from '../lib/store-instance.ts';
import type { Place } from '../lib/places.ts';

const MethodSummary = lazy(() =>
  import('./MethodSummary.tsx').then(({ MethodSummary: summary }) => ({ default: summary })),
);

export function MethodSurface({ place }: { readonly place: Place }) {
  const presentation = usePresentation();
  const layers = useApp((state) => state.layers);
  const replaceLayer = useApp((state) => state.replaceLayer);
  const setLayerUI = useApp((state) => state.setLayerUI);
  const popLayer = useApp((state) => state.popLayer);
  const topLayer = layers.at(-1);
  const surface = sheetSurface(topLayer);
  const detent = sheetDetent(topLayer);
  const title = place === 'trends' ? 'Method & settings' : 'Method';

  if (surface !== 'method' || topLayer?.kind !== 'sheet') return null;

  return (
    <SheetFrame
      title={title}
      detent={detent}
      compact={presentation.width === 'compact'}
      onDetent={(next) => setLayerUI(topLayer.id, { detent: next })}
      onClose={popLayer}
    >
      <div className="sheet-surface-switch">
        <button
          id="evidence-more"
          type="button"
          onClick={() => replaceLayer(
            'sheet',
            Object.freeze({ surface: 'evidence' }),
            topLayer.returnFocusTo,
            { detent },
          )}
        >
          Evidence
        </button>
      </div>
      {place === 'trends' && <TrendSettings />}
      <Suspense fallback={<p className="region-placeholder">loading Method…</p>}>
        <MethodSummary place={place} />
      </Suspense>
    </SheetFrame>
  );
}
