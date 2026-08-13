import { lazy, Suspense, useLayoutEffect } from 'react';
import { footerBlockSize, footerGeometryFor } from '../lib/footer-metrics.ts';
import { useApp } from '../lib/store-instance.ts';
import { usePresentation } from './PresentationProvider.tsx';

const QuerySurface = lazy(() =>
  import('./QuerySurface.tsx').then(({ QuerySurface: surface }) => ({ default: surface })),
);
const WorkbenchFooter = lazy(() =>
  import('./WorkbenchFooter.tsx').then(({ WorkbenchFooter: footer }) => ({ default: footer })),
);

function TermsRailFallback() {
  return (
    <aside className="query-region term-bar" aria-label="Terms">
      <strong className="term-bar-label">Terms</strong>
      <p className="region-placeholder">loading Terms…</p>
    </aside>
  );
}

/** Fixed layout host for the authored query state and transient reading
 * instrument. The two named asides remain independent accessibility regions;
 * this wrapper owns only viewport placement and the pre-mount reservation. */
export function WorkbenchDock({
  globalShortcuts,
  showTerms = true,
}: {
  readonly globalShortcuts: boolean;
  readonly showTerms?: boolean;
}) {
  const presentation = usePresentation();
  const seriesCount = useApp((state) => state.series.length);
  const documentCount = useApp(
    (state) => state.projectSession?.project.data.docs.length ?? 0,
  );
  const readingReserve = documentCount > 0
    ? footerBlockSize(
        footerGeometryFor(presentation.width, presentation.coarseAvailable),
        seriesCount,
      )
    : 0;

  useLayoutEffect(() => {
    document.documentElement.style.setProperty(
      '--reading-reserve-block-size',
      `${readingReserve}px`,
    );
    return () => {
      document.documentElement.style.removeProperty('--reading-reserve-block-size');
    };
  }, [readingReserve]);

  return (
    <div className="workbench-dock" data-terms={showTerms}>
      {showTerms && (
        <Suspense fallback={<TermsRailFallback />}>
          <QuerySurface />
        </Suspense>
      )}
      <Suspense fallback={null}>
        <WorkbenchFooter globalShortcuts={globalShortcuts} />
      </Suspense>
    </div>
  );
}
