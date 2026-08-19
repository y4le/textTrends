import type {
  CompanyState,
  DestinationFocusIntent,
  DestinationsState,
  SeriesIntent,
} from '../../lib/store.ts';
import type { ReaderOpenIntent } from '../../lib/reader-intent.ts';
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
  compare,
}: {
  readonly company: CompanyState | null;
  readonly destinations: DestinationsState | null;
  readonly series: readonly SeriesIntent[];
  readonly titleByDoc: ReadonlyMap<string, string>;
  readonly focus: DestinationFocusIntent | null;
  readonly pendingRange: boolean;
  readonly setFocus: (value: readonly [string, string] | null) => void;
  readonly openReader: (intent: ReaderOpenIntent, returnFocusTo?: string) => void;
  readonly compare: (
    snapshot: string,
    doc: string,
    tokens: { readonly start: number; readonly end: number },
  ) => void;
}) {
  const multiple = series.length > 1;
  return (
    <section
      className="trend-organ trend-overview"
      data-trend-organ="overview"
      data-range-pending={pendingRange || undefined}
      aria-labelledby="trend-overview-heading"
    >
      <header className="trend-organ-header">
        <div>
          <h2 id="trend-overview-heading">
            {multiple ? 'company & reading destinations' : 'where to read'}
          </h2>
          <p>whole-corpus orientation for the tracked {multiple ? 'terms' : 'term'} · plain-text analysis</p>
        </div>
        <p className="trend-organ-pending" role="status" aria-atomic="true">
          {pendingRange ? 'comparing selected range…' : ''}
        </p>
      </header>
      <div className="trend-overview-grid" data-single={multiple ? undefined : true}>
        {multiple && (
          <CompanyPanel
            company={company}
            series={series}
            focus={focus}
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
          compare={compare}
        />
      </div>
    </section>
  );
}
