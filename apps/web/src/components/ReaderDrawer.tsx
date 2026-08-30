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
} from 'react';
import { useApp } from '../lib/store-instance.ts';
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
import { shortcutAria } from '../lib/shortcuts.ts';
import { RsvpReader, type RsvpReaderSource } from './RsvpReader.tsx';
import { ReaderRuler } from './reader/ReaderRuler.tsx';
import { ReaderAtlas } from './reader/ReaderAtlas.tsx';
import { ReaderScaleControl } from './reader/ReaderScaleControl.tsx';
import { guideAnchorProps } from '../lib/guide/anchors.ts';

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
  const centerKwicAt = useApp((state) => state.centerKwicAt);
  const selected = readerSelectionChars(page, selection, snapshot);
  const styleOf = new Map(legend.map((entry) => [entry.seriesId, entry.style]));
  const labelOf = new Map(legend.map((entry) => [entry.seriesId, entry.label]));
  const boundaries = [
    ...(selected ? [selected.start, selected.end] : []),
    ...(page.anchor ? [page.anchor.charsUtf16.start, page.anchor.charsUtf16.end] : []),
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
        const inAnchor =
          page.anchor !== null
          && segment.start >= page.anchor.charsUtf16.start
          && segment.end <= page.anchor.charsUtf16.end;
        const color = mark
          ? seriesColor(styleOf.get(mark.seriesId) ?? DEFAULT_SERIES_STYLE)
          : undefined;
        const text = page.text.slice(segment.start, segment.end);
        if (!mark) {
          return (
            <span
              key={index}
              data-reader-selection={inSelection || undefined}
              style={{
                background: inAnchor
                  ? 'color-mix(in srgb, var(--accent) 30%, transparent)'
                  : inSelection
                    ? 'color-mix(in srgb, var(--accent) 16%, transparent)'
                    : undefined,
                textDecorationLine: inAnchor ? 'underline' : undefined,
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
            onClick={() => centerKwicAt(mark.seriesId, page.doc, mark.tokens.start, {
              kind: 'occurrence',
              groupId: mark.groupId,
              members: mark.members,
            })}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              centerKwicAt(mark.seriesId, page.doc, mark.tokens.start, {
                kind: 'occurrence',
                groupId: mark.groupId,
                members: mark.members,
              });
            }}
            data-reader-mark={mark.seriesId}
            data-reader-selection={inSelection || undefined}
            style={{
              background: inAnchor
                ? 'color-mix(in srgb, var(--accent) 30%, transparent)'
                : inSelection
                  ? `color-mix(in srgb, ${color} 30%, var(--accent) 16%)`
                  : `color-mix(in srgb, ${color} 20%, transparent)`,
              borderBottom: `2px solid ${color}`,
              borderLeft: clippedStart ? `2px dashed ${color}` : undefined,
              borderRight: clippedEnd ? `2px dashed ${color}` : undefined,
              cursor: 'pointer',
              textDecorationLine: inAnchor ? 'underline' : undefined,
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
  onOpenHelp,
  onOpenSettings,
}: {
  readonly onOpenHelp: () => void;
  readonly onOpenSettings: (returnFocus: HTMLElement) => void;
}) {
  const place = useApp((state) => state.readerPlace);
  const result = useApp((state) => state.readerPage);
  const navigation = useApp((state) => state.readerNavigation);
  const notebook = useApp((state) => state.notebook);
  const styles = useApp((state) => state.styles);
  const project = useApp((state) => state.projectSession?.project ?? null);
  const closeReader = useApp((state) => state.closeReader);
  const navigateReader = useApp((state) => state.navigateReader);
  const setReaderVisibleRange = useApp((state) => state.setReaderVisibleRange);
  const refitReaderAt = useApp((state) => state.refitReaderAt);
  const retryReader = useApp((state) => state.retryReader);
  const occurrenceNavigation = useApp((state) => state.occurrenceNavigation);
  const stepOccurrence = useApp((state) => state.stepOccurrence);
  const series = useApp((state) => state.series);
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
  const sourceRef = useRef<{ readonly key: string; readonly page: ReaderPageResultV1 } | null>(null);
  const visibleRef = useRef<{ readonly start: number; readonly end: number } | null>(null);
  const lastPaneSize = useRef<string | null>(null);
  const fitSeed = useRef(INITIAL_FIT_TOKENS);
  const publishedFit = useRef<string | null>(null);
  const refitAttempt = useRef<string | null>(null);
  const [layoutEpoch, setLayoutEpoch] = useState(0);
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
  const hasPresentedTerms = findMode ? find !== null : series.length > 0;
  const occurrencePending = findMode
    ? find?.state.status === 'pending'
    : occurrenceNavigation?.state.status === 'pending';
  const occurrenceTitle = (direction: 'Previous' | 'Next') => {
    if (!hasPresentedTerms) return findMode ? 'No active Find query' : 'No active terms';
    return findMode
      ? `${direction} exact Find match`
      : `${direction} exact reference from any term`;
  };
  const turnPage = (direction: -1 | 1) => {
    const cursor = direction === -1 ? navigation?.previous : navigation?.next;
    if (cursor) navigateReader(cursor);
  };

  return (
    <>
      <header className="reader-header">
        <div>
          <h2 id="reader-title" style={{ margin: 0, fontSize: 'var(--text-lg)' }}>
            <span className="visually-hidden">Reader: </span>{title}
          </h2>
          <p
            className="reader-position"
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
        </div>
        <div className="reader-header-actions">
          <ReaderScaleControl />
          <button
            id="reader-settings-open"
            type="button"
            onClick={(event) => onOpenSettings(event.currentTarget)}
            style={SMALL_BUTTON_STYLE}
          >
            settings
          </button>
          <button
            type="button"
            aria-keyshortcuts={shortcutAria(['show-help'])}
            onClick={onOpenHelp}
            style={SMALL_BUTTON_STYLE}
          >
            help
          </button>
          <button type="button" onClick={closeReader} style={SMALL_BUTTON_STYLE}>
            back
          </button>
        </div>
      </header>
      <ReaderRuler />
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
            <ReaderProse page={visualPage} snapshot={current.snapshot} legend={legend} />
          ) : (
            <div aria-label="Fitting reader page" style={{ minHeight: '12em' }} />
          )}
        </div>
      </div>

      <nav
        className="reader-pages"
        aria-label="Reader navigation"
      >
        <button
          className="reader-occurrence-previous"
          type="button"
          aria-keyshortcuts={shortcutAria(['reader-occurrence-previous'])}
          disabled={!hasPresentedTerms || occurrencePending}
          onClick={() => stepOccurrence(-1)}
          title={occurrenceTitle('Previous')}
          style={{ ...SMALL_BUTTON_STYLE, opacity: hasPresentedTerms && !occurrencePending ? 1 : 0.45 }}
        >
          {findMode ? 'previous find match' : 'previous reference'}
        </button>
        <button
          className="reader-page-previous"
          type="button"
          aria-keyshortcuts={shortcutAria(['reader-page-previous'])}
          disabled={!navigation?.previous}
          onClick={() => turnPage(-1)}
          style={{ ...SMALL_BUTTON_STYLE, cursor: navigation?.previous ? 'pointer' : 'default', opacity: navigation?.previous ? 1 : 0.45 }}
        >
          ← previous
        </button>
        <button
          className="reader-page-next"
          type="button"
          aria-keyshortcuts={shortcutAria(['reader-page-next'])}
          disabled={!navigation?.next}
          onClick={() => turnPage(1)}
          style={{ ...SMALL_BUTTON_STYLE, cursor: navigation?.next ? 'pointer' : 'default', opacity: navigation?.next ? 1 : 0.45 }}
        >
          next →
        </button>
        <button
          className="reader-occurrence-next"
          type="button"
          aria-keyshortcuts={shortcutAria(['reader-occurrence-next'])}
          disabled={!hasPresentedTerms || occurrencePending}
          onClick={() => stepOccurrence(1)}
          title={occurrenceTitle('Next')}
          style={{ ...SMALL_BUTTON_STYLE, opacity: hasPresentedTerms && !occurrencePending ? 1 : 0.45 }}
        >
          {findMode ? 'next find match' : 'next reference'}
        </button>
      </nav>
    </>
  );
}

export function ReaderDrawer({
  onOpenHelp,
  onOpenSettings,
  onAnnounce,
}: {
  readonly onOpenHelp: () => void;
  readonly onOpenSettings: (returnFocus: HTMLElement) => void;
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
    <ReaderProseDrawer onOpenHelp={onOpenHelp} onOpenSettings={onOpenSettings} />
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
      onOpenHelp={onOpenHelp}
    />
  );
}
