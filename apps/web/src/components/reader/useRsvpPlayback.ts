/** Browser playback lifetime for one keyed Speed session. Playing and pacing
 * remain store-owned inputs; the hook owns source residency, timers, cursor,
 * continuation and passage history. Pure frame/rhythm rules live in @texttrends/rsvp.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  rsvpBoundedFrameStart, rsvpCursorStep, rsvpNeedsContinuation,
  rsvpContextPageToken, rsvpFrameAt, rsvpFrameTiming, rsvpPausedContext,
  rsvpSpanAt, rsvpSpanPlan, type RsvpPacing,
} from '@texttrends/rsvp';
import type { RsvpState } from '../../lib/interaction.ts';
import type { ReaderPageResultV1 } from '../../shared/analysis-contract.ts';

export type RsvpReaderSource =
  | { readonly status: 'pending' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly page: ReaderPageResultV1 };

interface PlaybackPhase {
  readonly frameKey: string;
  readonly kind: 'word' | 'rest';
  readonly startedAt: number;
}

function contains(page: ReaderPageResultV1, token: number): boolean {
  return token >= page.tokens.start && token < page.tokens.end;
}

function clockNow(): number {
  return typeof performance === 'undefined' ? 0 : performance.now();
}

interface PlaybackOptions {
  mode: RsvpState;
  source: RsvpReaderSource;
  playbackPacing: RsvpPacing;
  onSetPlaying(playing: boolean): void;
  onPublish(token: number): void;
  onSeek(token: number, intent?: 'continuation'): void;
}

export function useRsvpPlayback({
  mode, source, playbackPacing, onSetPlaying, onPublish, onSeek,
}: PlaybackOptions) {
  const effectiveWords = playbackPacing.wordsPerFrame;
  const initial = source.status === 'ready'
    && source.page.doc === mode.doc
    && contains(source.page, mode.startToken)
    ? source.page
    : null;
  const [resident, setResident] = useState<ReaderPageResultV1 | null>(initial);
  const [cursor, setCursor] = useState(mode.startToken);
  const [completed, setCompleted] = useState(false);
  const [phase, setPhase] = useState<PlaybackPhase>({
    frameKey: '',
    kind: 'word',
    startedAt: 0,
  });
  const requestedSource = useRef<string | null>(null);
  const nextFrameStart = useRef<number | null>(null);
  const passageHistory = useRef<{ back: number[]; forward: number[] }>({
    back: [],
    forward: [],
  });
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;

  useEffect(() => {
    if (source.status !== 'ready' || source.page.doc !== mode.doc) return;
    if (!contains(source.page, cursor)) return;
    setResident(source.page);
  }, [cursor, mode.doc, source]);

  useEffect(() => {
    const pauseWhenHidden = () => {
      if (!document.hidden) return;
      onPublish(cursorRef.current);
      onSetPlaying(false);
    };
    document.addEventListener('visibilitychange', pauseWhenHidden);
    return () => document.removeEventListener('visibilitychange', pauseWhenHidden);
  }, [onPublish, onSetPlaying]);

  useEffect(() => {
    if (source.status !== 'error') return;
    onPublish(cursorRef.current);
    onSetPlaying(false);
  }, [onPublish, onSetPlaying, source.status]);

  const relative = resident ? cursor - resident.tokens.start : -1;
  const frame = useMemo(
    () => resident && relative >= 0 && relative < resident.tokens.end - resident.tokens.start
      ? rsvpFrameAt(resident, relative, {
          wordsPerFrame: effectiveWords,
          charLimit: mode.frameCharLimit,
        })
      : null,
    [effectiveWords, mode.frameCharLimit, relative, resident],
  );
  const span = useMemo(
    () => resident && relative >= 0 && relative < resident.tokens.end - resident.tokens.start
      ? rsvpSpanAt(resident, relative)
      : null,
    [relative, resident],
  );
  const spanStartToken = span?.startToken ?? -1;
  const spanPlan = useMemo(
    () => resident && spanStartToken >= resident.tokens.start
      ? rsvpSpanPlan(resident, spanStartToken - resident.tokens.start, playbackPacing)
      : null,
    [playbackPacing, resident, spanStartToken],
  );
  const timing = useMemo(
    () => frame && spanPlan ? rsvpFrameTiming(spanPlan, frame) : null,
    [frame, spanPlan],
  );
  const passageContext = useMemo(
    () => resident && frame && source.status !== 'error'
      ? rsvpPausedContext(resident, frame)
      : null,
    [frame, resident, source.status],
  );
  const pausedContext = !mode.playing && !completed ? passageContext : null;
  const canGoWordBack = cursor > 0;
  const canGoWordForward = cursor < mode.docTokenCount - 1;
  const previousPassageToken = passageContext === null
    ? null
    : rsvpContextPageToken(passageContext, cursor, mode.docTokenCount, -1);
  const nextPassageToken = passageContext === null
    ? null
    : rsvpContextPageToken(passageContext, cursor, mode.docTokenCount, 1);
  const canGoPassageBack = passageHistory.current.back.length > 0
    || previousPassageToken !== null;
  const canGoPassageForward = passageHistory.current.forward.length > 0
    || nextPassageToken !== null;
  const frameKey = frame
    ? `${frame.startToken}:${frame.words.map((word) => word.token).join(',')}:${frame.text}`
    : '';

  useEffect(() => {
    if (frameKey === '' || !frame || !timing) {
      nextFrameStart.current = null;
      return;
    }
    // Pausing and resuming both restart the displayed frame. This is the
    // forgiving recovery path and prevents paused wall time counting as read.
    const now = clockNow();
    const plannedStart = mode.playing ? nextFrameStart.current : null;
    nextFrameStart.current = null;
    setPhase({
      frameKey,
      kind: 'word',
      startedAt: plannedStart === null
        ? now
        : rsvpBoundedFrameStart(plannedStart, now, timing.wordMs, frame.words.length),
    });
  }, [frame, frameKey, mode.playing, timing]);

  useEffect(() => {
    if (!resident || !frame || completed) return;
    const key = `${resident.doc}:${resident.tokens.start}:${resident.tokens.end}`;
    if (
      requestedSource.current !== key
      && rsvpNeedsContinuation(resident, cursor, playbackPacing)
    ) {
      requestedSource.current = key;
      onSeek(Math.max(cursor, resident.tokens.end - 1), 'continuation');
    }
  }, [completed, cursor, frame, onSeek, playbackPacing, resident]);

  useEffect(() => {
    if (
      !mode.playing
      || !resident
      || !frame
      || !timing
      || completed
      || phase.frameKey !== frameKey
    ) return undefined;

    const advance = (scheduledDeadline: number) => {
      const step = rsvpCursorStep(resident, cursor, frame.words.length);
      if (step.kind === 'next') {
        passageHistory.current = { back: [], forward: [] };
        nextFrameStart.current = scheduledDeadline;
        setCursor(step.token);
        onPublish(step.token);
        return;
      }
      nextFrameStart.current = null;
      onPublish(cursor);
      onSetPlaying(false);
      if (step.kind === 'document-end') {
        setCompleted(true);
      } else {
        onSeek(Math.max(cursor, resident.tokens.end - 1), 'continuation');
      }
    };
    const duration = phase.kind === 'word' ? timing.wordMs : timing.pauseMs;
    const scheduledDeadline = phase.startedAt + duration;
    const remaining = Math.max(0, scheduledDeadline - clockNow());
    const timer = window.setTimeout(() => {
      if (phase.kind === 'word' && timing.pauseMs > 0) {
        setPhase({
          frameKey,
          kind: 'rest',
          startedAt: phase.startedAt + timing.wordMs,
        });
      } else {
        advance(scheduledDeadline);
      }
    }, remaining);
    return () => window.clearTimeout(timer);
  }, [
    completed,
    cursor,
    frame,
    frameKey,
    mode.playing,
    onPublish,
    onSeek,
    onSetPlaying,
    phase,
    resident,
    timing,
  ]);

  const moveToToken = useCallback((
    token: number,
    retainPassageHistory = false,
  ) => {
    if (!Number.isSafeInteger(token) || token < 0 || token >= mode.docTokenCount) return false;
    if (!retainPassageHistory) passageHistory.current = { back: [], forward: [] };
    requestedSource.current = null;
    nextFrameStart.current = null;
    onSetPlaying(false);
    setCompleted(false);
    setCursor(token);
    onPublish(token);
    if (resident === null || !contains(resident, token)) onSeek(token);
    return true;
  }, [mode.docTokenCount, onPublish, onSeek, onSetPlaying, resident]);
  const moveWord = useCallback((direction: -1 | 1) => {
    const next = cursor + direction;
    if (next < 0 || next >= mode.docTokenCount) return false;
    return moveToToken(next);
  }, [cursor, mode.docTokenCount, moveToToken]);
  const movePassage = (direction: -1 | 1) => {
    if (passageContext === null) return false;
    const history = passageHistory.current;
    const remembered = direction === -1 ? history.back.pop() : history.forward.pop();
    const target = remembered
      ?? (direction === -1 ? previousPassageToken : nextPassageToken);
    if (target !== null) {
      if (direction === -1) history.forward.push(cursor);
      else history.back.push(cursor);
      return moveToToken(target, true);
    }
    return false;
  };
  return {
    resident, cursor, completed, frame, spanPlan, timing, phase, frameKey,
    pausedContext, canGoWordBack, canGoWordForward, canGoPassageBack,
    canGoPassageForward, moveToToken, moveWord, movePassage,
  };
}
