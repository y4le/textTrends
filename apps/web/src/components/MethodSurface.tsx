import { lazy, Suspense, useEffect, useRef } from 'react';
import { usePresentation } from './PresentationProvider.tsx';
import { SheetFrame } from './SheetFrame.tsx';
import { sheetDetent, sheetSurface } from '../lib/sheet.ts';
import { useApp } from '../lib/store-instance.ts';
import type { Place } from '../lib/places.ts';

const MethodSummary = lazy(() =>
  import('./MethodSummary.tsx').then(({ MethodSummary: summary }) => ({ default: summary })),
);

function Summary({ place }: { readonly place: Place }) {
  return (
    <Suspense fallback={<p className="region-placeholder">loading Method…</p>}>
      <MethodSummary place={place} />
    </Suspense>
  );
}

export function MethodSurface({ place }: { readonly place: Place }) {
  const presentation = usePresentation();
  const layers = useApp((state) => state.layers);
  const replaceLayer = useApp((state) => state.replaceLayer);
  const setLayerUI = useApp((state) => state.setLayerUI);
  const popLayer = useApp((state) => state.popLayer);
  const topLayer = layers.at(-1);
  const surface = sheetSurface(topLayer);
  const detent = sheetDetent(topLayer);
  const wide = presentation.width === 'wide';
  const previousWidth = useRef(presentation.width);

  useEffect(() => {
    const movedToWide = previousWidth.current !== 'wide' && wide;
    previousWidth.current = presentation.width;
    if (!movedToWide || surface !== 'method') return undefined;
    const frame = requestAnimationFrame(() => {
      document.getElementById('method-open')?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [presentation.width, surface, wide]);

  if (!wide && surface === 'method' && topLayer?.kind === 'sheet') {
    return (
      <SheetFrame
        title="Method"
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
              'evidence-more',
              { detent },
            )}
          >
            Evidence
          </button>
        </div>
        <Summary place={place} />
      </SheetFrame>
    );
  }

  if (!wide) return null;

  return (
    <section
      id="method-open"
      className="method-region"
      aria-label="Method"
      tabIndex={-1}
    >
      <Summary place={place} />
    </section>
  );
}
