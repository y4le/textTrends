/**
 * Concordance is a source-context table, not a miniature chart. Its aligned mode
 * keeps every node on one locked vertical axis inside a single horizontal
 * port; reading mode trades that alignment for wrapped, complete context.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from 'react';
import { useApp } from '../lib/store-instance.ts';
import { fullTokensByDoc } from '../lib/doc-tokens.ts';
import {
  concordanceRows,
  CONTEXT_CHAR_CHOICES,
  nodeCenterOffset,
  type ConcordanceRowVM,
} from '../lib/concordance-view.ts';
import { DEFAULT_SERIES_STYLE, seriesColor } from '../lib/series-style.ts';
import { SeriesLineSample } from './chrome.tsx';
import { usePresentation } from './PresentationProvider.tsx';

export function KwicPanel({
  showHeading = true,
}: {
  readonly showHeading?: boolean;
}) {
  const kwic = useApp((state) => state.kwic);
  const project = useApp((state) => state.projectSession?.project ?? null);
  const snapshot = useApp((state) => state.snapshot);
  const inventory = useApp((state) => state.inventory);
  const trends = useApp((state) => state.trends);
  const corpusTokenCounts = useApp((state) => state.corpusTokenCounts);
  const scrub = useApp((state) => state.scrub);
  const series = useApp((state) => state.series);
  const enabled = useApp((state) => state.kwicEnabledSeries);
  const view = useApp((state) => state.concordanceView);
  const toggle = useApp((state) => state.toggleKwicSeries);
  const requestWindow = useApp((state) => state.requestConcordanceWindow);
  const setContext = useApp((state) => state.setConcordanceContext);
  const setReading = useApp((state) => state.setConcordanceReading);
  const openReader = useApp((state) => state.openReader);
  const presentation = usePresentation();

  const portRef = useRef<HTMLDivElement | null>(null);
  const nodeHeadingRef = useRef<HTMLTableCellElement | null>(null);

  const seriesById = useMemo(
    () => new Map(series.map((item) => [item.id, item])),
    [series],
  );
  const titleByDoc = useMemo(
    () => new Map((project?.data.docs ?? []).map((doc) => [doc.doc, doc.meta.title])),
    [project],
  );
  const labelOf = useCallback(
    (id: string) => seriesById.get(id)?.label ?? id,
    [seriesById],
  );
  const styleOf = useCallback(
    (id: string) => seriesById.get(id)?.style ?? DEFAULT_SERIES_STYLE,
    [seriesById],
  );
  const titleOf = useCallback(
    (doc: string) => titleByDoc.get(doc) ?? doc,
    [titleByDoc],
  );

  useEffect(() => {
    if (!scrub) return;
    requestWindow({ kind: 'position', doc: scrub.doc, token: scrub.token });
  }, [requestWindow, scrub]);

  const readyRows = kwic?.resident?.rows ?? [];
  const rows = useMemo(
    () => concordanceRows(readyRows, view.contextChars, labelOf, styleOf, titleOf),
    [readyRows, view.contextChars, labelOf, styleOf, titleOf],
  );
  const rowIdentity = rows.map((row) => row.key).join('\u001f');

  const recenter = useCallback(() => {
    const port = portRef.current;
    const node = nodeHeadingRef.current;
    if (!port || !node || view.reading !== 'aligned') return;
    const portRect = port.getBoundingClientRect();
    const nodeRect = node.getBoundingClientRect();
    const nodeLeftInContent = nodeRect.left - portRect.left + port.scrollLeft;
    port.scrollLeft = nodeCenterOffset(
      port.clientWidth,
      nodeLeftInContent,
      nodeRect.width,
    );
  }, [view.reading]);

  useLayoutEffect(() => {
    recenter();
  }, [recenter, rowIdentity, view.contextChars]);

  const scope = `${snapshot?.readyDocs.length ?? 0} ready book${snapshot?.readyDocs.length === 1 ? '' : 's'}`;
  const multipleBooks = (snapshot?.readyDocs.length ?? 0) > 1;
  const tokenCountsByDoc = new Map(
    (snapshot?.readyDocs ?? []).map((doc) => [
      doc,
      fullTokensByDoc(doc, { corpusTokenCounts, inventory, trends }),
    ]),
  );
  const tokenPosition = (row: ConcordanceRowVM) => {
    const total = tokenCountsByDoc.get(row.doc);
    return `${(row.pos + 1).toLocaleString()} / ${total?.toLocaleString() ?? '—'}`;
  };
  const sourcePosition = (row: ConcordanceRowVM) => multipleBooks
    ? `${row.title} · ${tokenPosition(row)}`
    : tokenPosition(row);
  if (series.length === 0) return null;

  const readerId = (row: ConcordanceRowVM) =>
    `kwic-reader-${encodeURIComponent(row.key)}`;

  const openRowReader = (row: ConcordanceRowVM) => {
    if (!kwic) return;
    openReader(
      {
        snapshot: kwic.snapshot,
        doc: row.doc,
        token: row.pos,
        from: 'kwic',
      },
      readerId(row),
    );
  };

  const resultBar = kwic?.resident && rows.length > 0 ? (
    <div className="kwic-result-bar">
      <p role="status">
        <strong className="selectable-stat">{rows.length} of {kwic.resident.total.toLocaleString()}</strong>
        {' '}occurrences · {scope}
      </p>
    </div>
  ) : null;

  const alignedTable = (total: number) => (
    <div
      ref={portRef}
      className="horizontal-data-port kwic-aligned-port"
      role="region"
      tabIndex={0}
      aria-label="Scrollable concordance table"
    >
      <table aria-label="Concordance" className="kwic-table">
        <caption className="kwic-caption">
          Concordance: {rows.length} of {total.toLocaleString()} occurrences in {scope}
        </caption>
        <colgroup>
          <col className="kwic-col-left" />
          <col className="kwic-col-node" />
          <col className="kwic-col-right" />
          <col className={`kwic-col-book${multipleBooks ? ' kwic-col-book-multiple' : ''}`} />
        </colgroup>
        <thead>
          <tr>
            <th className="kwic-left-heading" scope="col">left context</th>
            <th ref={nodeHeadingRef} className="kwic-node-heading" scope="col">node</th>
            <th scope="col">right context</th>
            <th scope="col">{multipleBooks ? 'book · token' : 'token'}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.key}
              data-series-label={row.label}
            >
              <td className="kwic-left-context source-text">
                <span aria-hidden="true">{row.leftShown}</span>
                <span className="visually-hidden">{row.leftFull}</span>
              </td>
              <td className="kwic-node source-text">
                <button
                  id={readerId(row)}
                  type="button"
                  onClick={() => openRowReader(row)}
                  title="Open this occurrence in the reader"
                  style={{ color: seriesColor(row.style) }}
                >
                  {row.nodeText}
                </button>
              </td>
              <td className="kwic-right-context source-text">
                <span aria-hidden="true">{row.rightShown}</span>
                <span className="visually-hidden">{row.rightFull}</span>
              </td>
              <td className="kwic-book" title={sourcePosition(row)}>
                <span className="kwic-book-content">
                  {multipleBooks && (
                    <>
                      <span className="kwic-book-title">{row.title}</span>
                      <span aria-hidden="true">·</span>
                    </>
                  )}
                  <span className="kwic-token-position">{tokenPosition(row)}</span>
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  const stackedRows = (total: number) => (
    <div
      ref={portRef}
      className="kwic-reading"
      role="region"
      tabIndex={0}
      aria-label="Concordance reading view"
    >
      <p role="note">Alignment is off in reading mode.</p>
      <p className="kwic-caption">
        Concordance: {rows.length} of {total.toLocaleString()} occurrences in {scope}
      </p>
      {rows.map((row) => (
        <div
          key={row.key}
          className="kwic-reading-row"
          data-series-label={row.label}
        >
          <p className="kwic-reading-source">
            <span style={{ color: seriesColor(row.style) }}>{row.label}</span>
            {' · '}{sourcePosition(row)}
          </p>
          <p className="kwic-reading-context source-text">
            {row.leftFull}{' '}
            <button
              id={readerId(row)}
              type="button"
              onClick={() => openRowReader(row)}
              title="Open this occurrence in the reader"
              style={{ color: seriesColor(row.style) }}
            >
              {row.nodeText}
            </button>
            {' '}{row.rightFull}
          </p>
        </div>
      ))}
    </div>
  );

  const skeleton = (
    <div aria-hidden="true" className="kwic-skeleton">
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index} style={{ maxWidth: `${70 - index * 4}%` }} />
      ))}
    </div>
  );

  const chips = (
    <div
      role="group"
      aria-label="Concordance terms"
      className="kwic-term-chips"
      data-compact={presentation.width === 'compact' || undefined}
    >
      <span>terms:</span>
      {series.map((item) => {
        const on = enabled.has(item.id);
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => toggle(item.id)}
            aria-pressed={on}
            title={on
              ? `hide “${item.label}” from the concordance`
              : `show “${item.label}” in the concordance`}
          >
            <SeriesLineSample style={item.style} emphasized={on} />
            {on ? '✓ ' : ''}{item.label}
          </button>
        );
      })}
    </div>
  );

  const controls = (
    <div className="kwic-controls" aria-label="Concordance display">
      <label>
        shown context
        <select
          aria-label="Shown context characters"
          value={view.contextChars}
          onChange={(event) => setContext(Number(event.currentTarget.value) as typeof view.contextChars)}
        >
          {CONTEXT_CHAR_CHOICES.map((chars) => (
            <option key={chars} value={chars}>{chars} characters</option>
          ))}
        </select>
      </label>
      <fieldset>
        <legend>reading</legend>
        <button
          type="button"
          aria-pressed={view.reading === 'aligned'}
          onClick={() => setReading('aligned')}
        >
          aligned
        </button>
        <button
          type="button"
          aria-pressed={view.reading === 'stacked'}
          onClick={() => setReading('stacked')}
        >
          wrapped
        </button>
      </fieldset>
    </div>
  );

  const status = kwic?.state.status ?? 'pending';
  let body: React.ReactNode = null;
  if (status === 'no-terms') {
    body = <p className="kwic-message">No concordance terms enabled.</p>;
  } else if (status === 'error') {
    const message = kwic?.state.status === 'error' ? kwic.state.message : 'unknown error';
    body = <p className="kwic-message kwic-error">concordance failed: {message}</p>;
  } else if (status === 'pending' && !kwic?.resident) {
    body = skeleton;
  } else if (kwic?.resident && rows.length === 0) {
    body = <p className="kwic-message">No occurrences of the enabled terms.</p>;
  } else if (kwic?.resident) {
    body = view.reading === 'aligned'
      ? alignedTable(kwic.resident.total)
      : stackedRows(kwic.resident.total);
  }

  return (
    <section
      aria-labelledby={showHeading ? 'concordance-heading' : undefined}
      aria-label={showHeading ? undefined : 'Concordance results'}
      className="kwic-panel"
    >
      {showHeading && <h2 id="concordance-heading">Concordance</h2>}
      {chips}
      {controls}
      {resultBar}
      {body}
    </section>
  );
}
