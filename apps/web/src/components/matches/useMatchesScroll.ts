import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AppState, KwicState, ScrubIntent, ScrubTarget } from '../../lib/app-state.ts';
import type { MatchesRowVM } from '../../lib/matches-view.ts';
import type { SequenceLayout } from '../../lib/trend-geometry.ts';
import {
  matchesLogicalAtScroll,
  matchesPhysicalExtent,
  matchesPrefetchRank,
  matchesScrollTop,
  matchesTargetAtLogical,
  matchesVisibleRanks,
  matchesWindowSize,
  globalTokenForTarget,
  logicalForGlobalToken,
} from '../../lib/matches-scroll.ts';

const SCROLL_TOLERANCE_PX = 0.75;
const ANNOUNCEMENT_INTERVAL_MS = 250;

interface SelfPublishedCursor {
  readonly doc: string;
  readonly token: number;
  readonly logical: number;
}

interface MatchesScrollOptions {
  readonly kwic: KwicState | null;
  readonly docs: readonly string[];
  readonly layout: SequenceLayout | null;
  readonly scrub: ScrubTarget | null;
  readonly rowHeight: number;
  readonly currentContextTokens: number;
  readonly rowAtRank: (rank: number) => MatchesRowVM | null;
  readonly titleOf: (doc: string) => string;
  readonly requestWindow: AppState['requestMatchesWindow'];
  readonly setScrub: AppState['setScrub'];
}

/** Owns viewport measurement, cursor synchronization and native-scroll fencing.
 * Column layout consumes the measured viewport without feeding back into it. */
export function useMatchesScroll({
  kwic, docs, layout, scrub, rowHeight, currentContextTokens,
  rowAtRank, titleOf, requestWindow, setScrub,
}: MatchesScrollOptions) {
  const resident = kwic?.resident ?? null;
  const total = resident?.total ?? 0;
  const hasGrid = resident !== null && total > 0;
  const portRef = useRef<HTMLDivElement | null>(null);
  const chRulerRef = useRef<HTMLSpanElement | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const resizeFrameRef = useRef<number | null>(null);
  const programmaticScrollRef = useRef<number | null>(null);
  const logicalRef = useRef(0);
  const selfPublishedRef = useRef<SelfPublishedCursor | null>(null);
  const appliedRevealRef = useRef<object | null>(null);
  const pendingRankRef = useRef<number | null>(null);
  const identityRef = useRef('');
  const announcementTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const announcementPendingRef = useRef('');
  const announcementAtRef = useRef(0);
  const lastScrollTopRef = useRef(0);
  const previousRowHeightRef = useRef(rowHeight);
  const [viewport, setViewport] = useState({ width: 0, height: 0, chPx: 0 });
  const [logical, setLogical] = useState(0);
  const [announcement, setAnnouncement] = useState('');

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
    const top = matchesScrollTop(bounded, total, rowHeight);
    if (Math.abs(port.scrollTop - top) <= SCROLL_TOLERANCE_PX) return;
    port.scrollTop = top;
    // Browsers may clamp or round a requested edge coordinate. Fence the
    // value the port actually accepted so that its ensuing scroll event is
    // not mistaken for user input and allowed to rewrite an external cursor.
    programmaticScrollRef.current = port.scrollTop;
    lastScrollTopRef.current = port.scrollTop;
  }, [rowHeight, total]);

  const requestRank = useCallback((rank: number, direction: -1 | 0 | 1) => {
    if (total <= 0) return;
    const bounded = Math.max(0, Math.min(total - 1, rank));
    const size = matchesWindowSize(viewport.height, rowHeight);
    const prefetchRank = matchesPrefetchRank(
      bounded + 0.5,
      total,
      viewport.height,
      resident,
      direction,
      rowHeight,
    );
    if (prefetchRank === null) return;
    const request = kwic?.request;
    if (
      kwic?.state.status === 'pending'
      && request?.anchor.kind === 'rank'
      && request.before === size.before
      && request.after === size.after
      && request.contextTokens === currentContextTokens
      && prefetchRank >= request.anchor.rank - request.before
      && prefetchRank <= request.anchor.rank + request.after
    ) return;
    requestWindow(
      { kind: 'rank', rank: prefetchRank },
      { ...size, contextTokens: currentContextTokens },
    );
  }, [
    currentContextTokens,
    kwic?.request,
    kwic?.state.status,
    requestWindow,
    resident,
    rowHeight,
    total,
    viewport.height,
  ]);

  const publishLogicalCursor = useCallback((
    nextLogical: number,
    intent: ScrubIntent = { kind: 'drift', origin: 'matches' },
  ) => {
    const target = matchesTargetAtLogical(nextLogical, resident);
    if (!target) return null;
    const cursor = { doc: target.doc, token: target.token };
    selfPublishedRef.current = { ...cursor, logical: nextLogical };
    if (scrub?.doc !== cursor.doc || scrub.token !== cursor.token) {
      setScrub(cursor, intent);
    }
    return cursor;
  }, [resident, scrub, setScrub]);

  const moveToRank = useCallback((rank: number, intent?: ScrubIntent) => {
    if (total <= 0) return;
    const bounded = Math.max(0, Math.min(total - 1, rank));
    const nextLogical = bounded + 0.5;
    const direction = Math.sign(nextLogical - logicalRef.current) as -1 | 0 | 1;
    pendingRankRef.current = rowAtRank(bounded) ? null : bounded;
    setLogicalPosition(nextLogical, true);
    const target = publishLogicalCursor(nextLogical, intent);
    if (target) announceRank(bounded, target);
    requestRank(bounded, direction);
  }, [announceRank, publishLogicalCursor, requestRank, rowAtRank, setLogicalPosition, total]);

  useLayoutEffect(() => {
    const port = portRef.current;
    if (!port || typeof ResizeObserver === 'undefined') return undefined;
    const measure = () => {
      resizeFrameRef.current = null;
      const rulerWidth = chRulerRef.current?.getBoundingClientRect().width ?? 0;
      const next = {
        width: port.clientWidth,
        height: port.clientHeight,
        chPx: rulerWidth > 0 ? rulerWidth / 10 : 0,
      };
      setViewport((current) => current.width === next.width
        && current.height === next.height
        && Math.abs(current.chPx - next.chPx) < 0.001
        ? current
        : next);
    };
    const observer = new ResizeObserver(() => {
      if (resizeFrameRef.current === null) resizeFrameRef.current = requestAnimationFrame(measure);
    });
    observer.observe(port);
    if (chRulerRef.current) observer.observe(chRulerRef.current);
    measure();
    return () => {
      observer.disconnect();
      if (resizeFrameRef.current !== null) cancelAnimationFrame(resizeFrameRef.current);
    };
  }, [hasGrid]);

  useLayoutEffect(() => {
    const previous = previousRowHeightRef.current;
    previousRowHeightRef.current = rowHeight;
    if (previous === rowHeight) return;
    const port = portRef.current;
    if (port === null || total <= 0) return;
    const top = matchesScrollTop(logicalRef.current, total, rowHeight);
    port.scrollTop = top;
    programmaticScrollRef.current = port.scrollTop;
    lastScrollTopRef.current = port.scrollTop;
  }, [rowHeight, total]);

  useEffect(() => {
    const identity = kwic ? `${kwic.snapshot}\u001f${kwic.trackKey}` : '';
    if (identityRef.current === identity) return;
    identityRef.current = identity;
    selfPublishedRef.current = null;
    appliedRevealRef.current = null;
    pendingRankRef.current = null;
    setLogicalPosition(0, true);
  }, [kwic?.snapshot, kwic?.trackKey, setLogicalPosition]);

  useEffect(() => {
    // A remount starts with zero geometry. Wait for the layout measurement
    // before requesting a window; otherwise it replaces a resident viewport
    // window with the smaller default window during navigation alone.
    if (!layout || total <= 0 || !kwic || viewport.height <= 0) return;
    const size = matchesWindowSize(viewport.height, rowHeight);
    const pendingRank = pendingRankRef.current;
    if (pendingRank !== null) {
      const row = rowAtRank(pendingRank);
      if (row) {
        const target = { doc: row.doc, token: row.pos };
        pendingRankRef.current = null;
        selfPublishedRef.current = { ...target, logical: pendingRank + 0.5 };
        if (scrub?.doc !== target.doc || scrub.token !== target.token) {
          setScrub(target, { kind: 'drift', origin: 'matches' });
        }
        setLogicalPosition(pendingRank + 0.5, true);
        announceRank(pendingRank, target);
        return;
      }
      // Hold the last exact scrub value only while some replacement window is
      // in flight. A settled error or superseding window that omitted this
      // rank must release the fence so authoritative scrub state can recover.
      if (kwic.state.status === 'pending') return;
      pendingRankRef.current = null;
    }

    if (resident?.revealRank !== null
      && resident?.revealRank !== undefined
      && appliedRevealRef.current !== resident) {
      appliedRevealRef.current = resident;
      setLogicalPosition(resident.revealRank + 0.5, true);
      return;
    }
    if (!scrub) {
      requestWindow(
        { kind: 'rank', rank: 0 },
        { ...size, contextTokens: currentContextTokens },
      );
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
      requestWindow(
        { kind: 'position', doc: scrub.doc, token: scrub.token },
        { ...size, contextTokens: currentContextTokens },
      );
    }
  }, [
    announceRank,
    currentContextTokens,
    docs,
    kwic,
    layout,
    requestWindow,
    resident,
    rowAtRank,
    rowHeight,
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
      lastScrollTopRef.current = port.scrollTop;
      return;
    }
    programmaticScrollRef.current = null;
    if (Math.abs(port.scrollTop - lastScrollTopRef.current) <= SCROLL_TOLERANCE_PX) return;
    lastScrollTopRef.current = port.scrollTop;
    if (scrollFrameRef.current !== null) return;
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      const livePort = portRef.current;
      if (!livePort || total <= 0) return;
      const nextLogical = matchesLogicalAtScroll(livePort.scrollTop, total, rowHeight);
      const direction = Math.sign(nextLogical - logicalRef.current) as -1 | 0 | 1;
      setLogicalPosition(nextLogical, false);
      const rank = Math.max(0, Math.min(total - 1, Math.floor(nextLogical)));
      const target = publishLogicalCursor(nextLogical);
      pendingRankRef.current = target === null ? rank : null;
      if (target) announceRank(rank, target);
      requestRank(rank, direction);
    });
  }, [announceRank, publishLogicalCursor, requestRank, rowHeight, setLogicalPosition, total]);

  const activeRank = total > 0
    ? Math.max(0, Math.min(total - 1, Math.floor(logical)))
    : -1;
  const visible = matchesVisibleRanks(logical, total, viewport.height, rowHeight);
  const physicalTop = matchesScrollTop(logical, total, rowHeight);
  const physicalExtent = matchesPhysicalExtent(total, rowHeight);
  const planeHeight = physicalExtent + viewport.height;

  return {
    portRef,
    chRulerRef,
    viewport,
    logical,
    activeRank,
    visible,
    physicalTop,
    physicalExtent,
    planeHeight,
    announcement,
    announce,
    onScroll,
    moveToRank,
  };
}
