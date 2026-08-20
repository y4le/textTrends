import { useMemo } from 'react';
import type {
  CompanyState,
  DestinationFocusIntent,
  DestinationsState,
  SeriesIntent,
} from '../../lib/store.ts';
import type { ReaderOpenIntent } from '../../lib/reader-intent.ts';
import { companyPairs } from '../../lib/trend-overview.ts';
import { CompanyPanel } from './CompanyPanel.tsx';
import { ReadingDestinations } from './ReadingDestinations.tsx';

export function TrendOverview({
  company,
  destinations,
  series,
  titleByDoc,
  focus,
  pendingRange,
  setFocus,
  openReader,
}: {
  readonly company: CompanyState | null;
  readonly destinations: DestinationsState | null;
  readonly series: readonly SeriesIntent[];
  readonly titleByDoc: ReadonlyMap<string, string>;
  readonly focus: DestinationFocusIntent | null;
  readonly pendingRange: boolean;
  readonly setFocus: (value: readonly [string, string] | null) => void;
  readonly openReader: (intent: ReaderOpenIntent, returnFocusTo?: string) => void;
}) {
  const multiple = series.length > 1;
  const pairs = useMemo(
    () => company?.state.status === 'ready'
      ? companyPairs(company.state.result, series, focus)
      : [],
    [company, focus, series],
  );
  const showCompany = multiple
    && (company?.state.status !== 'ready' || pairs.length > 0);
  return (
    <section
      className="trend-organ trend-overview"
      data-trend-organ="overview"
      data-range-pending={pendingRange || undefined}
      aria-labelledby="trend-overview-heading"
    >
      <h2 id="trend-overview-heading" className="visually-hidden">Trends overview</h2>
      <p className="trend-organ-pending" role="status" aria-atomic="true">
        {pendingRange ? 'comparing selected range…' : ''}
      </p>
      <div className="trend-overview-grid" data-single={showCompany ? undefined : true}>
        {showCompany && (
          <CompanyPanel
            company={company}
            pairs={pairs}
            suspended={pendingRange}
            setFocus={setFocus}
          />
        )}
        <ReadingDestinations
          destinations={destinations}
          series={series}
          titleByDoc={titleByDoc}
          focus={focus}
          suspended={pendingRange}
          setFocus={setFocus}
          openReader={openReader}
        />
      </div>
    </section>
  );
}
