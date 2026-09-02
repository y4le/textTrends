/**
 * Lazy full-document reader. Every mounted string is a React text node sliced
 * from authenticated worker text; source HTML is never interpreted.
 */

import type { ReaderPageMarkV1, ReaderPageResultV1 } from '../shared/analysis-contract.ts';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useApp } from '../lib/store-instance.ts';
import type { ReaderVisibleRangeV1 } from '../lib/store.ts';
import { findScope } from '../lib/interaction.ts';
import { groupIdentity, groupTitle } from '../lib/notebook.ts';
import { trackLegend, type TrackLegendEntry } from '../lib/track-legend.ts';
import { segmentMarks, type MarkSegment } from '../lib/marks-view.ts';
import { readerRangeLabel, readerSelectionChars, sliceReaderPage } from '../lib/reader-view.ts';
import {
  advanceReaderFit,
  readerProbeRange,
  startReaderFit,
  type ReaderFitCursor,
  type ReaderFitSearch,
} from '../lib/reader-fit.ts';
import { sameReaderPlace } from '../lib/reader-intent.ts';
import { DEFAULT_SERIES_STYLE, seriesColor } from '../lib/series-style.ts';
import { SMALL_BUTTON_STYLE } from './chrome.tsx';
import { RsvpReader, type RsvpReaderSource } from './RsvpReader.tsx';
import { ReaderAtlas } from './reader/ReaderAtlas.tsx';
import { guideAnchorProps } from '../lib/guide/anchors.ts';
import { readerCursorChars, readerTokenAtChar } from '../lib/reader-cursor.ts';
import { readerTapIntent } from '../lib/reader-tap.ts';
import { hitsSourceToken, proseCharOffsetAtPoint } from './reader/prose-cursor.ts';
import { ReaderControlBar } from './reader/ReaderControlBar.tsx';
import { ReaderFindBar } from './reader/ReaderFindBar.tsx';
import { ReaderWideRails } from './reader/ReaderWideRails.tsx';
import { readerRailsFit } from '../lib/reader-rail-fit.ts';

interface ReaderProsePointer {
  readonly id: number;
  readonly pointerType: string;
  readonly x: number;
  readonly y: number;
  readonly time: number;
  readonly target: EventTarget | null;
  readonly selectionOpen: boolean;
  readonly sourceToken: boolean;
  readonly geometry: string;
}

function isReaderMarkTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[data-reader-mark]') !== null;
}

function isInteractiveReaderTarget(target: EventTarget | null): boolean {
  return target instanceof Element
    && target.closest('button, a, input, select, textarea, [role="button"]') !== null;
}

function settledReaderGeometry(
  pane: HTMLElement,
  visible: ReaderVisibleRangeV1 | null,
): string | null {
  if (
    pane.hasAttribute('data-reader-fitting')
    || visible === null
    || !visible.geometry.startsWith(`${pane.clientWidth}x${pane.clientHeight}:`)
  ) return null;
  return visible.geometry;
}

function ReaderProse({
  page,
  snapshot,
  legend,
}: {
  page: ReaderPageResultV1;
  snapshot: string;
  legend: readonly TrackLegendEntry[];
}) {
  const selection = useApp((state) => state.linkedSelection);
  const scrub = useApp((state) => state.scrub);
  const setReadingCursor = useApp((state) => state.setReadingCursor);
  const centerKwicAt = useApp((state) => state.centerKwicAt);
  const selected = readerSelectionChars(page, selection, snapshot);
  const cursor = readerCursorChars(
    page,
    scrub?.doc === page.doc ? scrub.token : page.anchor?.token ?? null,
  );
  const styleOf = new Map(legend.map((entry) => [entry.seriesId, entry.style]));
  const labelOf = new Map(legend.map((entry) => [entry.seriesId, entry.label]));
  const boundaries = [
    ...(selected ? [selected.start, selected.end] : []),
    ...(cursor ? [cursor.start, cursor.end] : []),
  ];
  const segments = segmentMarks(
    page.text.length,
    page.marks.map((mark) => ({
      value: mark.seriesId,
      start: mark.charsUtf16.start,
      end: mark.charsUtf16.end,
    })),
    boundaries,
  );
  const coveringMark = (segment: MarkSegment<string>): ReaderPageMarkV1 | null =>
    page.marks.find(
      (mark) =>
        mark.seriesId === segment.values[0]
        && mark.charsUtf16.start <= segment.start
        && mark.charsUtf16.end >= segment.end,
    ) ?? null;

  return (
    <div
      className="source-text"
      data-reader-page={`${page.tokens.start}:${page.tokens.end}`}
      data-reader-anchor={page.anchor?.token}
      style={{
        fontFamily: 'var(--font-serif)',
        fontSize: '1.05rem',
        lineHeight: 1.75,
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
      }}
    >
      {segments.map((segment, index) => {
        const mark = coveringMark(segment);
        const inSelection =
          selected !== null
          && segment.start >= selected.start
          && segment.end <= selected.end;
        const inCursor = cursor !== null
          && segment.start >= cursor.start
          && segment.end <= cursor.end;
        const color = mark
          ? seriesColor(styleOf.get(mark.seriesId) ?? DEFAULT_SERIES_STYLE)
          : undefined;
        const text = page.text.slice(segment.start, segment.end);
        if (!mark) {
          return (
            <span
              key={index}
              data-reader-offset={segment.start}
              data-reader-cursor={inCursor || undefined}
              data-reader-cursor-start={inCursor && segment.start === cursor?.start || undefined}
              data-reader-selection={inSelection || undefined}
              style={{
                background: inSelection
                  ? 'color-mix(in srgb, var(--accent) 16%, transparent)'
                  : undefined,
              }}
            >
              {text}
            </span>
          );
        }
        const clippedStart = mark.clippedStart && segment.start === mark.charsUtf16.start;
        const clippedEnd = mark.clippedEnd && segment.end === mark.charsUtf16.end;
        return (
          <span
            key={index}
            role="button"
            tabIndex={0}
            aria-label={`Find ${labelOf.get(mark.seriesId) ?? mark.seriesId} reference in Matches`}
            title={[
              'Show this full reference in Matches',
              clippedStart ? 'continues from previous page' : '',
              clippedEnd ? 'continues on next page' : '',
            ].filter(Boolean).join(' · ')}
            onClick={() => {
              setReadingCursor(mark.tokens.start);
              centerKwicAt(mark.seriesId, page.doc, mark.tokens.start, {
                kind: 'occurrence',
                groupId: mark.groupId,
                members: mark.members,
              });
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              setReadingCursor(mark.tokens.start);
              centerKwicAt(mark.seriesId, page.doc, mark.tokens.start, {
                kind: 'occurrence',
                groupId: mark.groupId,
                members: mark.members,
              });
            }}
            data-reader-mark={mark.seriesId}
            data-reader-offset={segment.start}
            data-reader-cursor={inCursor || undefined}
            data-reader-cursor-start={inCursor && segment.start === cursor?.start || undefined}
            data-reader-selection={inSelection || undefined}
            style={{
              background: inSelection
                ? `color-mix(in srgb, ${color} 30%, var(--accent) 16%)`
                : `color-mix(in srgb, ${color} 20%, transparent)`,
              borderBottom: `2px solid ${color}`,
              borderLeft: clippedStart ? `2px dashed ${color}` : undefined,
              borderRight: clippedEnd ? `2px dashed ${color}` : undefined,
              cursor: 'pointer',
            }}
          >
            {text}
          </span>
        );
      })}
    </div>
  );
}

interface ActiveReaderFit {
  readonly key: string;
  readonly cursor: ReaderFitCursor;
  readonly search: ReaderFitSearch;
  readonly settledCount: number | null;
  readonly saturated: boolean;
}

const INITIAL_FIT_TOKENS = 128;

function readerSourceKey(page: ReaderPageResultV1): string {
  return `${page.doc}:${page.tokens.start}:${page.tokens.end}:${page.anchor?.token ?? '-'}`;
}

function ReaderProseDrawer({
  onOpenControls,
  onOpenFind,
  onOpenHelp,
  onOpenSettings,
  onCloseFind,
  onAnnounce,
}: {
  readonly onOpenControls: (returnFocus: HTMLElement) => void;
  readonly onOpenFind: () => void;
  readonly onOpenHelp: () => void;
  readonly onOpenSettings: (returnFocus: HTMLElement) => void;
  readonly onCloseFind: () => void;
  readonly onAnnounce: (message: string) => void;
}) {
  const place = useApp((state) => state.readerPlace);
  const result = useApp((state) => state.readerPage);
  const navigation = useApp((state) => state.readerNavigation);
  const publishedVisibleRange = useApp((state) => state.readerVisibleRange);
  const notebook = useApp((state) => state.notebook);
  const styles = useApp((state) => state.styles);
  const project = useApp((state) => state.projectSession?.project ?? null);
  const navigateReader = useApp((state) => state.navigateReader);
  const setReaderVisibleRange = useApp((state) => state.setReaderVisibleRange);
  const refitReaderAt = useApp((state) => state.refitReaderAt);
  const retryReader = useApp((state) => state.retryReader);
  const setReadingCursor = useApp((state) => state.setReadingCursor);
  const interaction = useApp((state) => state.interaction);
  const scopedFind = findScope(interaction);
  const findMode = scopedFind !== null;
  const find = scopedFind?.find ?? null;
  const findQuery = find?.query ?? null;
  const presentedSeries = findMode
    ? findQuery === null
      ? []
      : [{ id: findQuery.seriesId, label: findQuery.label, style: findQuery.style }]
    : notebook.groups.map((group) => ({
        id: group.id,
        label: groupTitle(group),
        style: styles.get(group.id) ?? group.style,
      }));
  const liveIdentityOf = (id: string): string | null => {
    if (findQuery?.seriesId === id) return findQuery.identity;
    if (findMode) return null;
    const group = notebook.groups.find((candidate) => candidate.id === id);
    return group ? groupIdentity(group) : null;
  };
  const paneRef = useRef<HTMLDivElement | null>(null);
  const layoutRef = useRef<HTMLElement | null>(null);
  const wideFitProbeRef = useRef<HTMLSpanElement | null>(null);
  const prosePointer = useRef<ReaderProsePointer | null>(null);
  const sourceRef = useRef<{ readonly key: string; readonly page: ReaderPageResultV1 } | null>(null);
  const visibleRef = useRef<{ readonly start: number; readonly end: number } | null>(null);
  const lastPaneSize = useRef<string | null>(null);
  const fitSeed = useRef(INITIAL_FIT_TOKENS);
  const publishedFit = useRef<string | null>(null);
  const refitAttempt = useRef<string | null>(null);
  const [layoutEpoch, setLayoutEpoch] = useState(0);
  const [wideRails, setWideRails] = useState(false);
  const [reflow, setReflow] = useState<{
    readonly sourceKey: string;
    readonly token: number;
  } | null>(null);
  const [fit, setFit] = useState<ActiveReaderFit | null>(null);

  const current = place && result && sameReaderPlace(result.place, place) ? result : null;
  const ready = current?.state.status === 'ready' ? current.state.page : null;
  const trackKey = JSON.stringify(current?.tracks.map((track) => {
    const live = presentedSeries.find((candidate) => candidate.id === track.seriesId);
    return [
      track.seriesId,
      track.identity,
      live?.label ?? null,
      liveIdentityOf(track.seriesId),
    ];
  }) ?? []);
  const sourceKey = ready ? `${readerSourceKey(ready)}:${trackKey}` : null;
  sourceRef.current = ready && sourceKey ? { key: sourceKey, page: ready } : null;
  const fitCursor: ReaderFitCursor | null = ready && place
    ? reflow?.sourceKey === sourceKey
      && reflow.token >= ready.tokens.start
      && reflow.token < ready.tokens.end
      ? { kind: 'from', token: reflow.token }
      : place.cursor
    : null;
  const fitKey = ready && current && fitCursor
    ? `${current.snapshot}:${sourceKey}:${fitCursor.kind}:${fitCursor.token}:${layoutEpoch}`
    : null;
  const freshFit = ready && fitKey && fitCursor
    ? {
        key: fitKey,
        cursor: fitCursor,
        search: startReaderFit(
          fitCursor.kind === 'from'
            ? ready.tokens.end - Math.max(ready.tokens.start, fitCursor.token)
            : fitCursor.kind === 'before'
              ? Math.min(ready.tokens.end, fitCursor.token) - ready.tokens.start
              : ready.tokens.end - ready.tokens.start,
          fitSeed.current,
        ),
        settledCount: null,
        saturated: false,
      } satisfies ActiveReaderFit
    : null;
  const activeFit = fit?.key === fitKey ? fit : freshFit;
  const probeCount = activeFit?.settledCount ?? activeFit?.search.probe ?? null;
  const probeRange = ready && activeFit && probeCount !== null
    ? readerProbeRange(ready, activeFit.cursor, probeCount)
    : null;
  const visualPage = ready && probeRange ? sliceReaderPage(ready, probeRange) : null;
  const fitSettled = activeFit?.settledCount !== null
    && activeFit?.settledCount !== undefined
    && activeFit.settledCount === probeCount;

  useLayoutEffect(() => {
    const layout = layoutRef.current;
    const probe = wideFitProbeRef.current;
    if (!layout || !probe) return undefined;
    let frame = 0;
    let live = true;
    const measure = () => {
      if (!live) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!live) return;
        const next = readerRailsFit(
          layout.clientWidth,
          probe.getBoundingClientRect().width,
        );
        setWideRails((current) => current === next ? current : next);
      });
    };
    const observer = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(measure);
    observer?.observe(layout);
    observer?.observe(probe);
    measure();
    void document.fonts?.ready.then(measure);
    return () => {
      live = false;
      observer?.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);

  useLayoutEffect(() => {
    if (!ready || !current || !fitKey || !activeFit || !probeRange || !visualPage) return;
    if (fit?.key !== fitKey) {
      publishedFit.current = null;
      setFit(activeFit);
      return;
    }
    if (activeFit.settledCount === null) {
      const pane = paneRef.current;
      const pageElement = pane?.querySelector<HTMLElement>('[data-reader-page]');
      if (!pane || !pageElement) return;
      const paneRect = pane.getBoundingClientRect();
      const pageRect = pageElement.getBoundingClientRect();
      const paddingBottom = Number.parseFloat(getComputedStyle(pane).paddingBottom) || 0;
      const advanced = advanceReaderFit(
        activeFit.search,
        pageRect.bottom <= paneRect.bottom - paddingBottom + 0.5,
      );
      if (advanced.done) {
        fitSeed.current = advanced.count;
        setFit({
          ...activeFit,
          settledCount: advanced.count,
          saturated: advanced.saturated,
        });
      } else {
        setFit({ ...activeFit, search: advanced.search });
      }
      return;
    }
    if (!fitSettled) return;
    visibleRef.current = probeRange;
    const pane = paneRef.current;
    if (!pane) return;
    const geometry = `${pane.clientWidth}x${pane.clientHeight}:${layoutEpoch}:${trackKey}`;
    const publication = `${fitKey}:${probeRange.start}:${probeRange.end}:${geometry}`;
    if (publishedFit.current === publication) return;
    publishedFit.current = publication;
    setReaderVisibleRange({
      snapshot: current.snapshot,
      doc: ready.doc,
      tokens: probeRange,
      geometry,
    });
  }, [
    activeFit,
    current,
    fit,
    fitKey,
    fitSettled,
    layoutEpoch,
    probeRange,
    ready,
    setReaderVisibleRange,
    trackKey,
    visualPage,
  ]);

  useEffect(() => {
    if (
      !fitSettled
      || !activeFit?.saturated
      || !ready
      || !place
      || !probeRange
      || probeRange.end !== ready.tokens.end
      || ready.tokens.end === ready.docTokenCount
      || (place.cursor.kind === 'from' && place.cursor.token === probeRange.start)
    ) return;
    const key = `${fitKey}:${probeRange.start}`;
    if (refitAttempt.current === key) return;
    refitAttempt.current = key;
    refitReaderAt(probeRange.start);
  }, [activeFit, fitKey, fitSettled, place, probeRange, ready, refitReaderAt]);

  useLayoutEffect(() => {
    const pane = paneRef.current;
    if (!pane || typeof ResizeObserver === 'undefined') return undefined;
    lastPaneSize.current = `${pane.clientWidth}x${pane.clientHeight}`;
    let frame = 0;
    const remeasure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const size = `${pane.clientWidth}x${pane.clientHeight}`;
        if (lastPaneSize.current === size) return;
        lastPaneSize.current = size;
        const source = sourceRef.current;
        const visible = visibleRef.current;
        if (source && visible && visible.start >= source.page.tokens.start
          && visible.start < source.page.tokens.end) {
          setReflow({ sourceKey: source.key, token: visible.start });
        }
        setLayoutEpoch((epoch) => epoch + 1);
      });
    };
    const observer = new ResizeObserver(remeasure);
    observer.observe(pane);
    // A sibling layout effect publishes the Reader footer reservation on the
    // opening commit. Sample once after all layout effects so that same-commit
    // custom-property change cannot leave the first fitted page one dock delta
    // taller than its actual pane.
    remeasure();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);

  useEffect(() => {
    if (document.fonts?.status !== 'loading') return undefined;
    let live = true;
    void document.fonts.ready.then(() => {
      if (!live) return;
      const source = sourceRef.current;
      const visible = visibleRef.current;
      if (source && visible) setReflow({ sourceKey: source.key, token: visible.start });
      setLayoutEpoch((epoch) => epoch + 1);
    });
    return () => { live = false; };
  }, []);

  if (!place) return null;
  const title =
    project?.data.docs.find((entry) => entry.doc === place.doc)?.meta.title
    ?? place.doc;
  const legend = trackLegend(
    current?.tracks ?? [],
    liveIdentityOf,
    presentedSeries,
  );
  const hasStaleMarks = legend.some((entry) => entry.stale);
  const turnPage = (direction: -1 | 1) => {
    const cursor = direction === -1 ? navigation?.previous : navigation?.next;
    if (cursor) {
      onAnnounce('');
      navigateReader(cursor);
    }
  };
  const onProsePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    prosePointer.current = null;
    const primary = event.isPrimary
      && (event.pointerType !== 'mouse' || event.button === 0);
    if (!primary) return;
    const geometry = settledReaderGeometry(event.currentTarget, publishedVisibleRange);
    const source = event.currentTarget.querySelector<HTMLElement>('[data-reader-page]');
    if (geometry === null || source === null) return;
    prosePointer.current = {
      id: event.pointerId,
      pointerType: event.pointerType,
      x: event.clientX,
      y: event.clientY,
      time: event.timeStamp,
      target: event.target,
      selectionOpen: window.getSelection()?.isCollapsed === false,
      sourceToken: hitsSourceToken(source, event.clientX, event.clientY),
      geometry,
    };
  };
  const onProsePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const down = prosePointer.current;
    prosePointer.current = null;
    if (down === null) return;
    const pane = event.currentTarget;
    const source = pane.querySelector<HTMLElement>('[data-reader-page]');
    const rect = pane.getBoundingClientRect();
    const intent = readerTapIntent({
      primary: down.id === event.pointerId
        && down.pointerType === event.pointerType
        && event.isPrimary
        && (event.pointerType !== 'mouse' || event.button === 0),
      movedPx: Math.hypot(event.clientX - down.x, event.clientY - down.y),
      elapsedMs: event.timeStamp - down.time,
      selectionOpen: down.selectionOpen || window.getSelection()?.isCollapsed === false,
      onInteractiveTarget: isInteractiveReaderTarget(down.target)
        || isInteractiveReaderTarget(event.target),
      onMarkTarget: isReaderMarkTarget(down.target) || isReaderMarkTarget(event.target),
      onSourceToken: down.sourceToken
        || (source !== null && hitsSourceToken(source, event.clientX, event.clientY)),
      edgePaging: event.pointerType === 'touch',
      xWithinPane: event.clientX - rect.left,
      paneWidth: rect.width,
      canPagePrevious: navigation?.previous != null,
      canPageNext: navigation?.next != null,
      geometrySettled: down.geometry === settledReaderGeometry(pane, publishedVisibleRange),
    });
    if (intent === 'page-previous' || intent === 'page-next') {
      event.preventDefault();
      turnPage(intent === 'page-previous' ? -1 : 1);
      return;
    }
    if (intent !== 'cursor' || source === null || visualPage === null) return;
    const char = proseCharOffsetAtPoint(source, event.clientX, event.clientY);
    const token = char === null ? null : readerTokenAtChar(visualPage, char);
    if (token === null) return;
    setReadingCursor(token);
    const chars = readerCursorChars(visualPage, token);
    const word = chars === null ? '' : visualPage.text.slice(chars.start, chars.end);
    onAnnounce(
      `Reading position: ${word === '' ? '' : `“${word}”, `}token ${(token + 1).toLocaleString()}`,
    );
  };

  return (
    <section
      ref={layoutRef}
      className="reader-read-layout"
      data-reader-layout={wideRails ? 'rails' : 'bar'}
    >
      <span ref={wideFitProbeRef} className="reader-wide-fit-probe" aria-hidden="true" />
      <h2 id="reader-title" className="visually-hidden">Reader: {title}</h2>
      <p
        className="reader-position visually-hidden"
        role="status"
        aria-atomic="true"
        aria-busy={!fitSettled || undefined}
      >
        {fitSettled && visualPage
          ? readerRangeLabel(visualPage)
          : ready
            ? 'fitting page…'
            : 'loading source text…'}
      </p>
      {(hasStaleMarks || ready?.marksTruncated) && (
        <div className="reader-feedback" role="status" aria-label="Reader mark notices">
          {hasStaleMarks && (
            <span>Query changed; marked text retains the query that opened Reader.</span>
          )}
          {ready?.marksTruncated && (
            <span>Some query marks were omitted from this bounded source window.</span>
          )}
        </div>
      )}
      <div
        {...guideAnchorProps('reader-prose')}
        ref={paneRef}
        className="reader-prose-pane"
        data-reader-fitting={!fitSettled || undefined}
        data-reader-saturated={activeFit?.saturated || undefined}
        onPointerDown={onProsePointerDown}
        onPointerUp={onProsePointerUp}
        onPointerCancel={() => { prosePointer.current = null; }}
      >
        <div
          aria-busy={current?.state.status === 'pending' || !fitSettled || undefined}
        >
          {!current || current.state.status === 'pending' ? (
            <div aria-label="Loading reader page" style={{ minHeight: '12em', opacity: 0.45 }}>
              {Array.from({ length: 7 }, (_, index) => (
                <div
                  key={index}
                  style={{
                    height: '1em',
                    margin: '0.65em 0',
                    width: `${92 - (index % 3) * 8}%`,
                    background: 'var(--rule)',
                  }}
                />
              ))}
            </div>
          ) : current.state.status === 'error' ? (
            <p role="alert" style={{ color: 'var(--accent-text)' }}>
              reader failed: {current.state.message}{' '}
              <button type="button" onClick={retryReader} style={SMALL_BUTTON_STYLE}>retry</button>
            </p>
          ) : visualPage ? (
            <ReaderProse
              page={visualPage}
              snapshot={current.snapshot}
              legend={legend}
            />
          ) : (
            <div aria-label="Fitting reader page" style={{ minHeight: '12em' }} />
          )}
        </div>
      </div>

      {wideRails && (
        <ReaderWideRails
          legend={findMode ? [] : legend}
          showProgress={!findMode}
          showReference={!findMode}
          onOpenFind={onOpenFind}
          onOpenSettings={onOpenSettings}
          onOpenHelp={onOpenHelp}
          onAnnounce={onAnnounce}
        />
      )}
      {findMode ? <ReaderFindBar onClose={onCloseFind} /> : !wideRails && (
        <ReaderControlBar
          title={title}
          onOpenControls={onOpenControls}
          onAnnounce={onAnnounce}
        />
      )}
    </section>
  );
}

export function ReaderDrawer({
  onOpenHelp,
  onOpenSettings,
  onOpenSpeedSettings,
  onOpenControls,
  onOpenFind,
  onCloseFind,
  onAnnounce,
}: {
  readonly onOpenHelp: () => void;
  readonly onOpenSettings: (returnFocus: HTMLElement) => void;
  readonly onOpenSpeedSettings: (returnFocus: HTMLElement, restSummary: string) => void;
  readonly onOpenControls: (returnFocus: HTMLElement) => void;
  readonly onOpenFind: () => void;
  readonly onCloseFind: () => void;
  readonly onAnnounce: (message: string) => void;
}) {
  const interaction = useApp((state) => state.interaction);
  const place = useApp((state) => state.readerPlace);
  const result = useApp((state) => state.readerPage);
  const project = useApp((state) => state.projectSession?.project ?? null);
  const setPlaying = useApp((state) => state.setRsvpPlaying);
  const setPacing = useApp((state) => state.setRsvpPacing);
  const publish = useApp((state) => state.publishRsvpPosition);
  const seek = useApp((state) => state.rsvpSeek);
  const exit = useApp((state) => state.exitRsvp);
  const retry = useApp((state) => state.retryReader);
  const readerScale = useApp((state) => state.readerScale);

  if (
    interaction.kind !== 'rsvp'
    || place === null
    || place.snapshot !== interaction.rsvp.snapshot
    || place.doc !== interaction.rsvp.doc
  ) return readerScale === 'atlas' ? (
    <ReaderAtlas
      onOpenHelp={onOpenHelp}
      onOpenSettings={onOpenSettings}
      onAnnounce={onAnnounce}
    />
  ) : (
    <ReaderProseDrawer
      onOpenControls={onOpenControls}
      onOpenFind={onOpenFind}
      onOpenHelp={onOpenHelp}
      onOpenSettings={onOpenSettings}
      onCloseFind={onCloseFind}
      onAnnounce={onAnnounce}
    />
  );

  const current = result && sameReaderPlace(result.place, place) ? result : null;
  const source: RsvpReaderSource = !current || current.state.status === 'pending'
    ? { status: 'pending' }
    : current.state.status === 'error'
      ? { status: 'error', message: current.state.message }
      : { status: 'ready', page: current.state.page };
  const title = project?.data.docs.find((entry) => entry.doc === place.doc)?.meta.title
    ?? place.doc;
  const mode = interaction.rsvp;
  return (
    <RsvpReader
      key={`${mode.snapshot}:${mode.doc}:${mode.startToken}`}
      title={title}
      mode={mode}
      source={source}
      onSetPlaying={setPlaying}
      onSetPacing={setPacing}
      onPublish={publish}
      onSeek={seek}
      onExit={exit}
      onRetry={retry}
      onOpenSettings={onOpenSpeedSettings}
    />
  );
}
