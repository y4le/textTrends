import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReaderPageResultV1 } from '../../shared/analysis-contract.ts';
import type { AppState } from '../../lib/app-state.ts';
import type { ReaderPlace } from '../../lib/reader-intent.ts';
import { sameReaderPlace } from '../../lib/reader-intent.ts';
import { sliceReaderPage } from '../../lib/reader-view.ts';
import { advanceReaderFit, readerProbeRange, startReaderFit,
  type ReaderFitCursor, type ReaderFitSearch,
} from '../../lib/reader-fit.ts';
import { readerRailsFit } from '../../lib/reader-rail-fit.ts';

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

/** Own source probes, DOM/font measurement and publication of the fitted
 * range. Pointer intent and Reader command meaning remain with the view. */
export function useReaderProseFit({ place, result, presentedSeries, liveIdentityOf,
  setReaderVisibleRange, refitReaderAt,
}: {
  readonly place: ReaderPlace | null;
  readonly result: AppState['readerPage'];
  readonly presentedSeries: readonly { id: string; label: string }[];
  readonly liveIdentityOf: (id: string) => string | null;
  readonly setReaderVisibleRange: AppState['setReaderVisibleRange'];
  readonly refitReaderAt: AppState['refitReaderAt'];
}) {
  const paneRef = useRef<HTMLDivElement | null>(null);
  const layoutRef = useRef<HTMLElement | null>(null);
  const wideFitProbeRef = useRef<HTMLSpanElement | null>(null);
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

  return { paneRef, layoutRef, wideFitProbeRef, wideRails, current, ready,
    visualPage, fitSettled, probeRange, activeFit };
}
