import { lazy, Suspense } from 'react';
import { useApp } from '../lib/store-instance.ts';

const TrendPanel = lazy(() =>
  import('../components/TrendPanel.tsx').then(({ TrendPanel: panel }) => ({ default: panel })),
);
const TrendDistribution = lazy(() =>
  import('../components/trends/TrendDistribution.tsx')
    .then(({ TrendDistribution: distribution }) => ({ default: distribution })),
);

export function TrendsPlace() {
  const series = useApp((state) => state.series);

  return (
    <div className="analysis-stack">
      {series.length > 0 && (
        <>
          <Suspense
            fallback={(
              <p style={{ color: 'var(--fg-muted)', fontSize: 'var(--text-sm)' }}>
                loading analysis view…
              </p>
            )}
          >
            <TrendPanel />
          </Suspense>
          <Suspense fallback={null}>
            <TrendDistribution />
          </Suspense>
        </>
      )}
    </div>
  );
}
