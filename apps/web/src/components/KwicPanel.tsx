/**
 * Continuous, corpus-order Concordance. The native scrollbar owns one capped
 * physical plane; a bounded fixed-height row overlay stays centered on the
 * shared reading cursor.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { useApp } from '../lib/store-instance.ts';
import { fullTokenCountsForDocs } from '../lib/doc-tokens.ts';
import {
  concordanceRows,
  CONTEXT_CHAR_CHOICES,
  nodeCenterOffset,
  type ConcordanceRowVM,
} from '../lib/concordance-view.ts';
import {
  CONCORDANCE_ROW_HEIGHT,
  concordanceLogicalAtScroll,
  concordancePhysicalExtent,
  concordanceScrollTop,
  concordanceVisibleRanks,
  concordanceWindowSize,
  globalTokenForLogical,
  globalTokenForTarget,
  logicalForGlobalToken,
  targetForGlobalToken,
} from '../lib/concordance-scroll.ts';
import { sequenceLayoutFor } from '../lib/footer-view.ts';
import {
  ROW_NAVIGATION_SHORTCUT_IDS,
  rowNavigationShortcut,
  rowNavigationTarget,
  visibleRowPageSize,
} from '../lib/row-navigation.ts';
import { shortcutAria, shortcutMatches } from '../lib/shortcuts.ts';
import { selectionContains } from '../lib/selection.ts';
import { DEFAULT_SERIES_STYLE, seriesColor } from '../lib/series-style.ts';
import { SeriesLineSample } from './chrome.tsx';
import { usePresentation } from './PresentationProvider.tsx';

const SCROLL_TOLERANCE_PX = 0.75;
const ANNOUNCEMENT_INTERVAL_MS = 250;
const ROW_ARIA_KEYS = shortcutAria(ROW_NAVIGATION_SHORTCUT_IDS);

interface SelfPublishedCursor {
  readonly doc: string;
  readonly token: number;
  readonly logical: number;
}

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
  const linkedSelection = useApp((state) => state.linkedSelection);
  const series = useApp((state) => state.series);
  const enabled = useApp((state) => state.kwicEnabledSeries);
  const view = useApp((state) => state.concordanceView);
  const toggle = useApp((state) => state.toggleKwicSeries);
  const requestWindow = useApp((state) => state.requestConcordanceWindow);
  const setContext = useApp((state) => state.setConcordanceContext);
  const setScrub = useApp((state) => state.setScrub);
  const openReader = useApp((state) => state.openReader);
  const presentation = usePresentation();

  const portRef = useRef<HTMLDivElement | null>(null);
  const nodeHeadingRef = useRef<HTMLDivElement | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const resizeFrameRef = useRef<number | null>(null);
  const programmaticScrollRef = useRef<number | null>(null);
  const logicalRef = useRef(0);
  const selfPublishedRef = useRef<SelfPublishedCursor | null>(null);
  const appliedRevealRef = useRef<object | null>(null);
  const pendingKeyboardRankRef = useRef<number | null>(null);
  const identityRef = useRef('');
  const announcementTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const announcementPendingRef = useRef('');
  const announcementAtRef = useRef(0);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [logical, setLogical] = useState(0);
  const [announcement, setAnnouncement] = useState('');

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

  const docs = snapshot?.readyDocs ?? [];
  const tokenCounts = useMemo(
    () => fullTokenCountsForDocs(docs, { corpusTokenCounts, inventory, trends }),
    [corpusTokenCounts, docs, inventory, trends],
  );
  const layout = useMemo(() => tokenCounts === null
    ? null
    : sequenceLayoutFor(docs, (doc) => tokenCounts[docs.indexOf(doc)]),
  [docs, tokenCounts]);
  const tokenCountsByDoc = useMemo(
    () => new Map(docs.map((doc, ordinal) => [doc, tokenCounts?.[ordinal] ?? null])),
    [docs, tokenCounts],
  );

  const resident = kwic?.resident ?? null;
  const hasGrid = resident !== null && resident.total > 0;
  const total = resident?.total ?? 0;
  const readyRows = resident?.rows ?? [];
  const rows = useMemo(
    () => concordanceRows(readyRows, view.contextChars, labelOf, styleOf, titleOf),
    [readyRows, view.contextChars, labelOf, styleOf, titleOf],
  );
  const rankedRows = useMemo(
    () => rows.map((row, index) => ({ row, rank: (resident?.firstRank ?? 0) + index })),
    [resident?.firstRank, rows],
  );
  const rowAtRank = useCallback(
    (rank: number) => rankedRows.find((item) => item.rank === rank)?.row ?? null,
    [rankedRows],
  );

  const multipleBooks = docs.length > 1;
  const scope = `${docs.length} ready book${docs.length === 1 ? '' : 's'}`;
  const tokenPosition = useCallback((row: ConcordanceRowVM) => {
    const count = tokenCountsByDoc.get(row.doc);
    return `${(row.pos + 1).toLocaleString()} / ${count?.toLocaleString() ?? '—'}`;
  }, [tokenCountsByDoc]);
  const sourcePosition = useCallback((row: ConcordanceRowVM) => multipleBooks
    ? `${row.title} · ${tokenPosition(row)}`
    : tokenPosition(row),
  [multipleBooks, tokenPosition]);

  const announce = useCallback((text: string) => {
    announcementPendingRef.current = text;
    const elapsed = performance.now() - announcementAtRef.current;
    if (elapsed >= ANNOUNCEMENT_INTERVAL_MS && announcementTimerRef.current === null) {
      announcementAtRef.current = performance.now();
      setAnnouncement(text);
      return;
    }
    if (announcementTimerRef.current !== null) return;
    announcementTimerRef.current = setTimeout(() => {
      announcementTimerRef.current = null;
      announcementAtRef.current = performance.now();
      setAnnouncement(announcementPendingRef.current);
    }, Math.max(0, ANNOUNCEMENT_INTERVAL_MS - elapsed));
  }, []);

  const announceRank = useCallback((rank: number, target: { readonly doc: string; readonly token: number }) => {
    announce(
      `Occurrence ${(rank + 1).toLocaleString()} of ${total.toLocaleString()}, `
      + `${titleOf(target.doc)}, token ${(target.token + 1).toLocaleString()}`,
    );
  }, [announce, titleOf, total]);

  const setLogicalPosition = useCallback((next: number, moveScroll: boolean) => {
    const bounded = Math.max(0, Math.min(total, next));
    logicalRef.current = bounded;
    setLogical(bounded);
    if (!moveScroll) return;
    const port = portRef.current;
    if (!port) return;
    const top = concordanceScrollTop(bounded, total);
    if (Math.abs(port.scrollTop - top) <= SCROLL_TOLERANCE_PX) return;
    programmaticScrollRef.current = top;
    port.scrollTop = top;
  }, [total]);

  const requestRank = useCallback((rank: number) => {
    if (total <= 0) return;
    const bounded = Math.max(0, Math.min(total - 1, rank));
    const size = concordanceWindowSize(viewport.height);
    const request = kwic?.request;
    if (
      kwic?.state.status === 'pending'
      && request?.anchor.kind === 'rank'
      && request.before === size.before
      && request.after === size.after
      && bounded >= request.anchor.rank - request.before
      && bounded <= request.anchor.rank + request.after
    ) return;
    requestWindow({ kind: 'rank', rank: bounded }, size);
  }, [kwic?.request, kwic?.state.status, requestWindow, total, viewport.height]);

  const publishLogicalCursor = useCallback((nextLogical: number) => {
    if (!layout || total <= 0) return null;
    const globalToken = globalTokenForLogical({
      docs,
      layout,
      totalRows: total,
      logical: nextLogical,
      axis: kwic?.axis ?? null,
      resident,
    });
    const target = globalToken === null ? null : targetForGlobalToken(docs, layout, globalToken);
    if (!target) return null;
    selfPublishedRef.current = { ...target, logical: nextLogical };
    if (scrub?.doc !== target.doc || scrub.token !== target.token) setScrub(target);
    return target;
  }, [docs, kwic?.axis, layout, resident, scrub, setScrub, total]);

  const moveToRank = useCallback((rank: number) => {
    if (total <= 0) return;
    const bounded = Math.max(0, Math.min(total - 1, rank));
    const nextLogical = bounded + 0.5;
    pendingKeyboardRankRef.current = rowAtRank(bounded) ? null : bounded;
    setLogicalPosition(nextLogical, true);
    const target = publishLogicalCursor(nextLogical);
    if (target) announceRank(bounded, target);
    requestRank(bounded);
  }, [announceRank, publishLogicalCursor, requestRank, rowAtRank, setLogicalPosition, total]);

  useLayoutEffect(() => {
    const port = portRef.current;
    if (!port || typeof ResizeObserver === 'undefined') return undefined;
    const measure = () => {
      resizeFrameRef.current = null;
      const next = { width: port.clientWidth, height: port.clientHeight };
      setViewport((current) => current.width === next.width && current.height === next.height
        ? current
        : next);
    };
    const observer = new ResizeObserver(() => {
      if (resizeFrameRef.current === null) resizeFrameRef.current = requestAnimationFrame(measure);
    });
    observer.observe(port);
    measure();
    return () => {
      observer.disconnect();
      if (resizeFrameRef.current !== null) cancelAnimationFrame(resizeFrameRef.current);
    };
  }, [hasGrid]);

  useEffect(() => {
    const identity = kwic ? `${kwic.snapshot}\u001f${kwic.trackKey}` : '';
    if (identityRef.current === identity) return;
    identityRef.current = identity;
    selfPublishedRef.current = null;
    appliedRevealRef.current = null;
    pendingKeyboardRankRef.current = null;
    setLogicalPosition(0, true);
  }, [kwic?.snapshot, kwic?.trackKey, setLogicalPosition]);

  useEffect(() => {
    if (!layout || total <= 0 || !kwic) return;
    const size = concordanceWindowSize(viewport.height);
    const pendingRank = pendingKeyboardRankRef.current;
    if (pendingRank !== null) {
      const row = rowAtRank(pendingRank);
      if (row) {
        const target = { doc: row.doc, token: row.pos };
        pendingKeyboardRankRef.current = null;
        selfPublishedRef.current = { ...target, logical: pendingRank + 0.5 };
        if (scrub?.doc !== target.doc || scrub.token !== target.token) setScrub(target);
        setLogicalPosition(pendingRank + 0.5, true);
        announceRank(pendingRank, target);
        return;
      }
    }

    if (resident?.revealRank !== null
      && resident?.revealRank !== undefined
      && appliedRevealRef.current !== resident) {
      appliedRevealRef.current = resident;
      setLogicalPosition(resident.revealRank + 0.5, true);
      return;
    }
    if (!scrub) {
      requestWindow({ kind: 'rank', rank: 0 }, size);
      return;
    }
    const selfPublished = selfPublishedRef.current;
    const nextLogical = selfPublished?.doc === scrub.doc && selfPublished.token === scrub.token
      ? selfPublished.logical
      : (() => {
          const globalToken = globalTokenForTarget(docs, layout, scrub);
          return globalToken === null ? logicalRef.current : logicalForGlobalToken({
            docs,
            layout,
            totalRows: total,
            globalToken,
            axis: kwic.axis,
            resident,
          });
        })();
    setLogicalPosition(nextLogical, true);
    if (selfPublished?.doc !== scrub.doc || selfPublished.token !== scrub.token) {
      requestWindow({ kind: 'position', doc: scrub.doc, token: scrub.token }, size);
    }
  }, [
    announceRank,
    docs,
    kwic,
    layout,
    requestWindow,
    resident,
    rowAtRank,
    scrub,
    setLogicalPosition,
    setScrub,
    total,
    viewport.height,
  ]);

  useEffect(() => () => {
    if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
    if (resizeFrameRef.current !== null) cancelAnimationFrame(resizeFrameRef.current);
    if (announcementTimerRef.current !== null) clearTimeout(announcementTimerRef.current);
  }, []);

  const onScroll = useCallback(() => {
    const port = portRef.current;
    if (!port) return;
    const expected = programmaticScrollRef.current;
    if (expected !== null && Math.abs(port.scrollTop - expected) <= SCROLL_TOLERANCE_PX) {
      programmaticScrollRef.current = null;
      return;
    }
    programmaticScrollRef.current = null;
    if (scrollFrameRef.current !== null) return;
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      const livePort = portRef.current;
      if (!livePort || total <= 0) return;
      const nextLogical = concordanceLogicalAtScroll(livePort.scrollTop, total);
      setLogicalPosition(nextLogical, false);
      const target = publishLogicalCursor(nextLogical);
      const rank = Math.max(0, Math.min(total - 1, Math.floor(nextLogical)));
      if (target) announceRank(rank, target);
      requestRank(rank);
    });
  }, [announceRank, publishLogicalCursor, requestRank, setLogicalPosition, total]);

  const activeRank = total > 0
    ? Math.max(0, Math.min(total - 1, Math.floor(logical)))
    : -1;
  const visible = concordanceVisibleRanks(logical, total, viewport.height);
  const renderedRows = rankedRows.filter(({ rank }) =>
    (rank >= visible.start && rank < visible.end) || rank === activeRank);
  const activeRowRendered = renderedRows.some(({ rank }) => rank === activeRank);
  const physicalTop = concordanceScrollTop(logical, total);
  const planeHeight = concordancePhysicalExtent(total) + viewport.height;

  const readerId = (row: ConcordanceRowVM) =>
    `kwic-reader-${encodeURIComponent(row.key)}`;
  const rowId = (rank: number) => `concordance-row-${rank}`;
  const openRowReader = (row: ConcordanceRowVM, rank: number) => {
    if (!kwic) return;
    moveToRank(rank);
    openReader(
      { snapshot: kwic.snapshot, doc: row.doc, token: row.pos, from: 'kwic' },
      'concordance-grid',
    );
  };

  const recenter = useCallback(() => {
    const port = portRef.current;
    const node = nodeHeadingRef.current;
    if (!port || !node) return;
    const portRect = port.getBoundingClientRect();
    const nodeRect = node.getBoundingClientRect();
    const nodeLeftInContent = nodeRect.left - portRect.left + port.scrollLeft;
    port.scrollLeft = nodeCenterOffset(port.clientWidth, nodeLeftInContent, nodeRect.width);
  }, []);

  useLayoutEffect(() => {
    recenter();
  }, [hasGrid, multipleBooks, recenter, view.contextChars]);

  const onGridKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (shortcutMatches(event, 'row-open')) {
      const row = rowAtRank(activeRank);
      if (row) {
        event.preventDefault();
        openRowReader(row, activeRank);
      }
      return;
    }
    const shortcut = rowNavigationShortcut(event);
    if (shortcut === null) return;
    event.preventDefault();
    if (shortcut === 'row-exit') {
      event.currentTarget.blur();
      announce('Concordance row navigation paused');
      return;
    }
    const pageSize = visibleRowPageSize(
      event.currentTarget.clientHeight,
      window.innerHeight,
      CONCORDANCE_ROW_HEIGHT,
    );
    const target = rowNavigationTarget(total, activeRank, shortcut, pageSize);
    if (target >= 0) moveToRank(target);
  };

  if (series.length === 0) return null;

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
    </div>
  );

  const status = kwic?.state.status ?? 'pending';
  let body: React.ReactNode;
  if (status === 'no-terms') {
    body = <p className="kwic-message">No concordance terms enabled.</p>;
  } else if (status === 'error' && resident === null) {
    const message = kwic?.state.status === 'error' ? kwic.state.message : 'unknown error';
    body = <p className="kwic-message kwic-error">concordance failed: {message}</p>;
  } else if (status === 'pending' && resident === null) {
    body = (
      <div aria-hidden="true" className="kwic-skeleton">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} style={{ maxWidth: `${70 - index * 4}%` }} />
        ))}
      </div>
    );
  } else if (resident && total === 0) {
    body = <p className="kwic-message">No occurrences of the enabled terms.</p>;
  } else {
    body = (
      <div className="kwic-grid-shell">
        <div
          ref={portRef}
          id="concordance-grid"
          className="kwic-virtual-grid horizontal-data-port"
          role="grid"
          tabIndex={0}
          aria-label="Concordance"
          aria-rowcount={total + 1}
          aria-activedescendant={activeRowRendered ? rowId(activeRank) : undefined}
          aria-keyshortcuts={ROW_ARIA_KEYS}
          data-logical-position={logical.toFixed(3)}
          data-multiple-books={multipleBooks || undefined}
          onScroll={onScroll}
          onKeyDown={onGridKeyDown}
        >
          <div className="kwic-grid-header" role="row">
            <div className="kwic-left-heading" role="columnheader">left context</div>
            <div ref={nodeHeadingRef} className="kwic-node-heading" role="columnheader">node</div>
            <div role="columnheader">right context</div>
            <div role="columnheader">{multipleBooks ? 'book · token' : 'token'}</div>
          </div>
          <div
            className="kwic-scroll-plane"
            role="rowgroup"
            style={{ height: `${Math.max(1, planeHeight)}px` }}
          >
            {renderedRows.map(({ row, rank }) => {
              const top = physicalTop
                + viewport.height / 2
                + (rank + 0.5 - logical) * CONCORDANCE_ROW_HEIGHT
                - CONCORDANCE_ROW_HEIGHT / 2;
              return (
                <div
                  key={row.key}
                  id={rowId(rank)}
                  className="kwic-virtual-row"
                  role="row"
                  aria-rowindex={rank + 2}
                  aria-selected={rank === activeRank || undefined}
                  data-series-label={row.label}
                  data-concordance-rank={rank}
                  data-linked-selection={selectionContains(linkedSelection, row.doc, row.pos) || undefined}
                  style={{ transform: `translate3d(0, ${top}px, 0)` }}
                  onPointerDown={(event) => {
                    if ((event.target as Element).closest('button, .source-text')) return;
                    portRef.current?.focus({ preventScroll: true });
                    moveToRank(rank);
                  }}
                >
                  <div className="kwic-left-context source-text" role="gridcell">
                    <span aria-hidden="true">{row.leftShown}</span>
                    <span className="visually-hidden">{row.leftFull}</span>
                  </div>
                  <div className="kwic-node source-text" role="gridcell">
                    <button
                      id={readerId(row)}
                      type="button"
                      tabIndex={-1}
                      onClick={() => openRowReader(row, rank)}
                      title="Open this occurrence in the reader"
                      style={{ color: seriesColor(row.style) }}
                    >
                      {row.nodeText}
                    </button>
                  </div>
                  <div className="kwic-right-context source-text" role="gridcell">
                    <span aria-hidden="true">{row.rightShown}</span>
                    <span className="visually-hidden">{row.rightFull}</span>
                  </div>
                  <div className="kwic-book" role="gridcell" title={sourcePosition(row)}>
                    <span className="kwic-book-content">
                      {multipleBooks && (
                        <>
                          <span className="kwic-book-title">{row.title}</span>
                          <span aria-hidden="true">·</span>
                        </>
                      )}
                      <span className="kwic-token-position">{tokenPosition(row)}</span>
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        <div
          className="kwic-now-line"
          aria-hidden="true"
          style={{ insetBlockStart: `${viewport.height / 2}px` }}
        />
      </div>
    );
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
      {resident && total > 0 && (
        <div className="kwic-result-bar">
          <p role="status">
            <strong className="selectable-stat">{total.toLocaleString()}</strong>
            {' '}occurrences · {scope}
            {status === 'pending' ? ' · loading nearby rows…' : ''}
            {status === 'error' ? ' · nearby rows failed to load' : ''}
          </p>
        </div>
      )}
      {body}
      <p className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
    </section>
  );
}
