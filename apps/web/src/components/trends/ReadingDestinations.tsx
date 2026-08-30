import { useMemo } from 'react';
import { seriesColor } from '../../lib/series-style.ts';
import type {
  DestinationFocusIntent,
  DestinationsState,
  SeriesIntent,
} from '../../lib/store.ts';
import { destinationCards } from '../../lib/trend-overview.ts';
import type { ReaderOpenIntent } from '../../lib/reader-intent.ts';

function DestinationMark({
  text,
  series,
}: {
  readonly text: string;
  readonly series: readonly SeriesIntent[];
}) {
  if (series.length === 0) return text;
  const names = series.map((item) => item.label).join(', ');
  const color = seriesColor(series[0]!.style);
  return (
    <mark
      className="destination-mark"
      title={`Matches ${names}`}
      style={{
        background: `color-mix(in srgb, ${color} 16%, transparent)`,
        borderBlockEndColor: color,
      }}
    >
      {text}
    </mark>
  );
}

export function ReadingDestinations({
  destinations,
  series,
  titleByDoc,
  focus,
  suspended,
  setFocus,
  openReader,
}: {
  readonly destinations: DestinationsState | null;
  readonly series: readonly SeriesIntent[];
  readonly titleByDoc: ReadonlyMap<string, string>;
  readonly focus: DestinationFocusIntent | null;
  readonly suspended: boolean;
  readonly setFocus: (value: readonly [string, string] | null) => void;
  readonly openReader: (intent: ReaderOpenIntent, returnFocusTo?: string) => void;
}) {
  const cards = useMemo(
    () => destinations?.state.status === 'ready'
      ? destinationCards(destinations.state.result, series, titleByDoc)
      : [],
    [destinations, series, titleByDoc],
  );
  const labelById = new Map(series.map((item) => [item.id, item.label]));
  const focusLabel = focus === null
    ? null
    : focus.seriesIds.map((id) => labelById.get(id) ?? id).join(' + ');
  const windowTokens = destinations?.state.status === 'ready'
    ? destinations.state.result.windowTokens
    : null;
  const windowDescription = windowTokens === null
    ? 'bounded token windows'
    : `windows of up to ${windowTokens.toLocaleString()} tokens`;
  const clearFocus = () => {
    const returnTo = document.querySelector<HTMLButtonElement>('.company-pair[aria-pressed="true"]');
    const fallback = document.getElementById('trend-destinations-heading');
    setFocus(null);
    requestAnimationFrame(() => {
      if (returnTo?.isConnected) {
        returnTo.focus({ preventScroll: true });
      } else if (fallback?.isConnected) {
        fallback.focus({ preventScroll: true });
      }
    });
  };

  return (
    <section
      className="trend-overview-panel destinations-panel"
      data-trend-overview-section="destinations"
      aria-labelledby="trend-destinations-heading"
    >
      <header className="destinations-header">
        <div>
          <h3 id="trend-destinations-heading" tabIndex={-1}>reading destinations</h3>
          <p>
            {focusLabel === null
              ? 'ranked passages · occurrence evidence · whole corpus'
              : `requiring ${focusLabel}`}
          </p>
        </div>
        {focus !== null && (
          <button type="button" className="trend-overview-action" onClick={clearFocus}>
            show all terms
          </button>
        )}
      </header>
      {destinations === null && suspended ? (
        <p className="trend-overview-status">whole-corpus analysis paused for the range comparison</p>
      ) : destinations === null || destinations.state.status === 'pending' ? (
        <p className="trend-overview-status" role="status">finding passages worth reading…</p>
      ) : destinations.state.status === 'error' ? (
        <p className="trend-overview-status" role="alert">Reading Destinations unavailable: {destinations.state.message}</p>
      ) : cards.length === 0 ? (
        <p className="trend-overview-status">
          {focusLabel === null
            ? 'No passage contains an occurrence of the tracked terms.'
            : `No ranked passage contains both ${focusLabel}.`}
        </p>
      ) : (
        <ol className="destination-list">
          {cards.map((card) => {
            const readId = `destination-read-${card.rank}`;
            const positiveCounts = card.counts.filter((count) => count.count > 0);
            return (
              <li key={card.key}>
                <article className="destination-card">
                  <header>
                    <span className="destination-rank" aria-hidden="true">{card.rank}</span>
                    <div>
                      <h4>{card.title}</h4>
                      <p>
                        indexed tokens {(card.tokens.start + 1).toLocaleString()}–{card.tokens.end.toLocaleString()}
                      </p>
                    </div>
                  </header>
                  <blockquote>
                    <span aria-hidden="true">…</span>
                    {card.segments.map((segment, index) => (
                      <DestinationMark key={index} text={segment.text} series={segment.series} />
                    ))}
                    <span aria-hidden="true">…</span>
                  </blockquote>
                  <div className="destination-evidence" role="group" aria-label="Occurrences in this passage">
                    {positiveCounts.map((count) => (
                      <span key={count.series.id}>
                        <i style={{ background: seriesColor(count.series.style) }} aria-hidden="true" />
                        {count.series.label} {count.count.toLocaleString()}
                      </span>
                    ))}
                    {card.marksTruncated && <span title="Only the first bounded set of highlights is shown">highlight cap reached</span>}
                  </div>
                  <footer>
                    <button
                      id={readId}
                      type="button"
                      className="trend-overview-action"
                      aria-label={`read from here · ${card.anchorSeries?.label ?? 'ranked occurrence'}`}
                      onClick={() => openReader({
                        snapshot: destinations.snapshot,
                        doc: card.doc,
                        token: card.anchorToken,
                        from: 'occurrence',
                        anchor: 'occurrence',
                      }, readId)}
                    >
                      read from here
                    </button>
                  </footer>
                </article>
              </li>
            );
          })}
        </ol>
      )}
      <p className="trend-overview-method-note">
        Destinations rank {windowDescription}, then show a shorter reading excerpt. Read opens the winning occurrence.
      </p>
    </section>
  );
}
