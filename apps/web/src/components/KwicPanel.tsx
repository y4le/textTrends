/**
 * Concordance is a source-context table, not a miniature chart. Its aligned mode
 * keeps every node on one locked vertical axis inside a single horizontal
 * port; reading mode trades that alignment for wrapped, complete context.
 */

import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
} from 'react';
import { useApp } from '../lib/store-instance.ts';
import { kwicCaptionText } from '../lib/barcode-view.ts';
import { fullTokensByDoc } from '../lib/doc-tokens.ts';
import {
  concordanceMethodLine,
  concordanceRows,
  CONTEXT_CHAR_CHOICES,
  nodeCenterOffset,
  type ConcordanceRowVM,
} from '../lib/concordance-view.ts';
import { DEFAULT_SERIES_STYLE, seriesColor } from '../lib/series-style.ts';
import { SeriesLineSample } from './chrome.tsx';
import { usePresentation } from './PresentationProvider.tsx';
import { useRowNavigation } from './useRowNavigation.ts';

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
  const selection = useApp((state) => state.linkedSelection);
  const series = useApp((state) => state.series);
  const enabled = useApp((state) => state.kwicEnabledSeries);
  const view = useApp((state) => state.concordanceView);
  const toggle = useApp((state) => state.toggleKwicSeries);
  const setSort = useApp((state) => state.setConcordanceSort);
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

  const readyRows = kwic?.state.status === 'ready' ? kwic.state.rows : [];
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

  const caption = kwicCaptionText(
    kwic?.center ?? null,
    rows[0]?.pos ?? null,
    titleOf,
  );
  const scope = selection
    ? selection.ranges.length === 1
      ? `selected range in ${titleOf(selection.ranges[0]!.doc)}`
      : `selected range across ${selection.ranges.length} books`
    : `${snapshot?.readyDocs.length ?? 0} ready book${snapshot?.readyDocs.length === 1 ? '' : 's'}`;
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
  const rowNavigation = useRowNavigation({
    keys: rows.map((row) => row.key),
    label: 'Concordance occurrence',
    portRef,
    onFocusKey: () => {
      if (view.reading === 'aligned') requestAnimationFrame(recenter);
    },
  });
  const activeIndex = rowNavigation.activeKey === null
    ? -1
    : rows.findIndex((row) => row.key === rowNavigation.activeKey);

  if (series.length === 0) return null;

  const activate = (index: number) => {
    rowNavigation.activateIndex(index, false);
  };

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

  const resultBar = kwic?.state.status === 'ready' && rows.length > 0 ? (
    <div className="kwic-result-bar">
      <p role="status">
        <strong className="selectable-stat">{rows.length} of {kwic.state.total.toLocaleString()}</strong>
        {' '}occurrences · {scope}
      </p>
      <div className="kwic-result-actions" aria-label="Occurrence navigation">
        <button
          type="button"
          onClick={() => activate(activeIndex < 0 ? rows.length - 1 : activeIndex - 1)}
          disabled={activeIndex === 0}
        >
          previous
        </button>
        <output className="selectable-stat" aria-live="polite">
          {activeIndex < 0 ? '—' : activeIndex + 1} / {rows.length}
        </output>
        <button
          type="button"
          onClick={() => activate(activeIndex < 0 ? 0 : activeIndex + 1)}
          disabled={activeIndex === rows.length - 1}
        >
          next
        </button>
        {view.reading === 'aligned' && (
          <button type="button" onClick={recenter}>
            recenter node
          </button>
        )}
      </div>
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
          Concordance ({caption}): {rows.length} of {total.toLocaleString()} occurrences in {scope}
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
              data-row-navigation-row
              data-active={row.key === rowNavigation.activeKey || undefined}
              data-series-label={row.label}
            >
              <td className="kwic-left-context source-text">
                <span aria-hidden="true">{row.leftShown}</span>
                <span className="visually-hidden">{row.leftFull}</span>
              </td>
              <td className="kwic-node source-text">
                <button
                  {...rowNavigation.controlProps(row.key)}
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
        Concordance ({caption}): {rows.length} of {total.toLocaleString()} occurrences in {scope}
      </p>
      {rows.map((row) => (
        <div
          key={row.key}
          className="kwic-reading-row"
          data-row-navigation-row
          data-active={row.key === rowNavigation.activeKey || undefined}
          data-series-label={row.label}
        >
          <p className="kwic-reading-source">
            <span style={{ color: seriesColor(row.style) }}>{row.label}</span>
            {' · '}{sourcePosition(row)}
          </p>
          <p className="kwic-reading-context source-text">
            {row.leftFull}{' '}
            <button
              {...rowNavigation.controlProps(row.key)}
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
        order
        <select
          aria-label="Concordance order"
          value={view.sort}
          onChange={(event) => setSort(event.currentTarget.value as typeof view.sort)}
        >
          <option value="proximity">nearest position</option>
          <option value="L1">first left word</option>
          <option value="R1">first right word</option>
          <option value="R2">second right word</option>
        </select>
      </label>
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
  } else if (status === 'pending') {
    body = skeleton;
  } else if (kwic?.state.status === 'ready' && rows.length === 0) {
    body = <p className="kwic-message">No occurrences of the enabled terms.</p>;
  } else if (kwic?.state.status === 'ready') {
    body = view.reading === 'aligned'
      ? alignedTable(kwic.state.total)
      : stackedRows(kwic.state.total);
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
      <p className="kwic-method">{concordanceMethodLine(view.sort, view.contextChars)}</p>
      {resultBar}
      {body}
      <span className="visually-hidden" role="status" aria-live="polite">
        {rowNavigation.status}
      </span>
    </section>
  );
}
