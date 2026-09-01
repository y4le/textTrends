import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { RsvpState } from '../lib/interaction.ts';
import {
  rsvpBoundedFrameStart,
  rsvpCursorStep,
  rsvpNeedsContinuation,
  RSVP_FRAME_CHAR_LIMIT_STEP,
  RSVP_LENGTH_EMPHASIS_STEP,
  RSVP_MAX_FRAME_CHAR_LIMIT,
  RSVP_MAX_LENGTH_EMPHASIS,
  RSVP_MAX_PARAGRAPH_PAUSE_MS,
  RSVP_MAX_SENTENCE_PAUSE_MS,
  RSVP_MAX_WPM,
  RSVP_MIN_EXPOSURE_MS,
  RSVP_MIN_FRAME_CHAR_LIMIT,
  RSVP_MIN_WPM,
  RSVP_PARAGRAPH_PAUSE_STEP_MS,
  RSVP_REST_CUE_MIN_MS,
  RSVP_REST_FLOOR_CROSSOVER_WPM,
  RSVP_RHYTHM_PRESETS,
  RSVP_RHYTHM_RESET,
  RSVP_SENTENCE_PAUSE_STEP_MS,
  RSVP_WPM_STEP,
  clampRsvpPacing,
  effectiveRsvpWordsPerFrame,
  rsvpFrameAt,
  rsvpFrameTiming,
  rsvpPausedContext,
  rsvpPreviousFrameStart,
  rsvpPresetSelection,
  rsvpSpanAt,
  rsvpSpanPlan,
  type RsvpPacing,
  type RsvpRhythmPreset,
} from '@texttrends/rsvp';
import { RSVP_WPM_INPUT_ID } from '../lib/rsvp-ui.ts';
import { readerProgress } from '../lib/reader-progress.ts';
import { shortcutAria, shortcutMatches } from '../lib/shortcuts.ts';
import type { ReaderPageResultV1 } from '../shared/analysis-contract.ts';
import { usePresentation } from './PresentationProvider.tsx';
import { SMALL_BUTTON_STYLE } from './chrome.tsx';
import { ReaderProgressRail } from './reader/ReaderProgressRail.tsx';

export type RsvpReaderSource =
  | { readonly status: 'pending' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly page: ReaderPageResultV1 };

export interface RsvpReaderProps {
  readonly title: string;
  readonly mode: RsvpState;
  readonly source: RsvpReaderSource;
  /** Playback effects depend on these bare, store-lifetime-stable actions. */
  readonly onSetPlaying: (playing: boolean) => void;
  readonly onSetPacing: (patch: Partial<RsvpPacing>) => void;
  readonly onPublish: (token: number) => void;
  readonly onSeek: (token: number) => void;
  readonly onExit: (token: number) => void;
  readonly onRetry: () => void;
  readonly onOpenHelp: () => void;
}

interface PlaybackPhase {
  readonly frameKey: string;
  readonly kind: 'word' | 'rest';
  readonly startedAt: number;
}

interface StagePointer {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly time: number;
  readonly target: EventTarget | null;
}

type NumberSettingKey =
  | 'frameCharLimit'
  | 'sentencePauseMs'
  | 'paragraphPauseMs'
  | 'lengthEmphasis';

const RSVP_PACE_HELP_ID = 'reader-rsvp-pace-help';
const RSVP_HIGH_SPEED_HELP_ID = 'reader-rsvp-high-speed-help';
const RSVP_MULTI_WORD_HINT_WPM = 1_200;
const RSVP_FRAME_CHAR_LIMIT_HELP_ID = 'reader-rsvp-frame-char-limit-help';
const RSVP_FRAME_GROUP_HEADING_ID = 'reader-rsvp-frame-group-heading';
const RSVP_RHYTHM_GROUP_HEADING_ID = 'reader-rsvp-rhythm-group-heading';
const RSVP_SENTENCE_REST_HELP_ID = 'reader-rsvp-sentence-rest-help';
const RSVP_PARAGRAPH_REST_HELP_ID = 'reader-rsvp-paragraph-rest-help';

const NUMBER_SETTING_LABEL: Readonly<Record<NumberSettingKey, string>> = Object.freeze({
  frameCharLimit: 'character limit',
  sentencePauseMs: 'sentence rest',
  paragraphPauseMs: 'paragraph rest',
  lengthEmphasis: 'length emphasis',
});

const NUMBER_SETTING_UNIT: Readonly<Record<NumberSettingKey, string>> = Object.freeze({
  frameCharLimit: 'characters',
  sentencePauseMs: 'milliseconds',
  paragraphPauseMs: 'milliseconds',
  lengthEmphasis: 'percent',
});

function contains(page: ReaderPageResultV1, token: number): boolean {
  return token >= page.tokens.start && token < page.tokens.end;
}

function stopControlSpace(event: KeyboardEvent<HTMLElement>): void {
  if (event.key === ' ') event.stopPropagation();
}

function clockNow(): number {
  return typeof performance === 'undefined' ? 0 : performance.now();
}

export function RsvpReader({
  title,
  mode,
  source,
  onSetPlaying,
  onSetPacing,
  onPublish,
  onSeek,
  onExit,
  onRetry,
  onOpenHelp,
}: RsvpReaderProps) {
  const presentation = usePresentation();
  const initial = source.status === 'ready'
    && source.page.doc === mode.doc
    && contains(source.page, mode.startToken)
    ? source.page
    : null;
  const [resident, setResident] = useState<ReaderPageResultV1 | null>(initial);
  const [cursor, setCursor] = useState(mode.startToken);
  const [completed, setCompleted] = useState(false);
  const [editingPace, setEditingPace] = useState(false);
  const [paceDraft, setPaceDraft] = useState(String(mode.wpm));
  const [settingDrafts, setSettingDrafts] = useState<Record<NumberSettingKey, string>>({
    frameCharLimit: String(mode.frameCharLimit),
    sentencePauseMs: String(mode.sentencePauseMs),
    paragraphPauseMs: String(mode.paragraphPauseMs),
    lengthEmphasis: String(mode.lengthEmphasis),
  });
  const [settingStatus, setSettingStatus] = useState('');
  const [phase, setPhase] = useState<PlaybackPhase>({
    frameKey: '',
    kind: 'word',
    startedAt: 0,
  });
  const resumeAfterEdit = useRef(false);
  const editingPaceRef = useRef(false);
  const editingSettingRef = useRef<NumberSettingKey | null>(null);
  const requestedSource = useRef<string | null>(null);
  const nextFrameStart = useRef<number | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const playRef = useRef<HTMLButtonElement | null>(null);
  const exitRef = useRef<HTMLButtonElement | null>(null);
  const stagePointer = useRef<StagePointer | null>(null);
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;

  const effectiveWords = effectiveRsvpWordsPerFrame(
    mode.wordsPerFrame,
    presentation.width === 'compact',
  );
  const frameLimitInert = effectiveWords === 1;
  const playbackPacing = useMemo<RsvpPacing>(() => ({
    wpm: mode.wpm,
    wordsPerFrame: effectiveWords,
    frameCharLimit: mode.frameCharLimit,
    sentencePauseMs: mode.sentencePauseMs,
    paragraphPauseMs: mode.paragraphPauseMs,
    lengthEmphasis: mode.lengthEmphasis,
  }), [
    effectiveWords,
    mode.frameCharLimit,
    mode.lengthEmphasis,
    mode.paragraphPauseMs,
    mode.sentencePauseMs,
    mode.wpm,
  ]);

  useEffect(() => {
    if (source.status !== 'ready' || source.page.doc !== mode.doc) return;
    if (!contains(source.page, cursorRef.current)) return;
    setResident(source.page);
  }, [mode.doc, source]);

  useEffect(() => {
    if (!editingPace) setPaceDraft(String(mode.wpm));
  }, [editingPace, mode.wpm]);

  useEffect(() => {
    setSettingDrafts((current) => ({
      frameCharLimit: editingSettingRef.current === 'frameCharLimit'
        ? current.frameCharLimit
        : String(mode.frameCharLimit),
      sentencePauseMs: editingSettingRef.current === 'sentencePauseMs'
        ? current.sentencePauseMs
        : String(mode.sentencePauseMs),
      paragraphPauseMs: editingSettingRef.current === 'paragraphPauseMs'
        ? current.paragraphPauseMs
        : String(mode.paragraphPauseMs),
      lengthEmphasis: editingSettingRef.current === 'lengthEmphasis'
        ? current.lengthEmphasis
        : String(mode.lengthEmphasis),
    }));
  }, [mode.frameCharLimit, mode.lengthEmphasis, mode.paragraphPauseMs, mode.sentencePauseMs]);

  useEffect(() => {
    setSettingStatus('');
  }, [mode.playing]);

  useEffect(() => {
    if (settingStatus === '') return undefined;
    const timer = window.setTimeout(() => setSettingStatus(''), 2_000);
    return () => window.clearTimeout(timer);
  }, [settingStatus]);

  useEffect(() => {
    playRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (completed) exitRef.current?.focus({ preventScroll: true });
  }, [completed]);

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
  const previousRelative = useMemo(
    () => resident
      && relative >= 0
      && relative < resident.tokens.end - resident.tokens.start
      ? rsvpPreviousFrameStart(resident, relative, {
          wordsPerFrame: effectiveWords,
          charLimit: mode.frameCharLimit,
        })
      : relative,
    [effectiveWords, mode.frameCharLimit, relative, resident],
  );
  const pausedContext = useMemo(
    () => resident && frame && source.status !== 'error' && !mode.playing && !completed
      ? rsvpPausedContext(resident, frame)
      : null,
    [completed, frame, mode.playing, resident, source.status],
  );
  const canGoBack = resident !== null
    && previousRelative >= 0
    && previousRelative < relative;
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
      onSeek(cursor);
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
        onSeek(cursor);
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

  const exit = () => {
    setSettingStatus('');
    onPublish(cursor);
    onExit(cursor);
  };
  const togglePlaying = () => {
    if (completed) return;
    onPublish(cursor);
    onSetPlaying(!mode.playing);
  };
  const stageControlAt = (target: EventTarget | null) =>
    target instanceof Element && target.closest('[data-rsvp-control]') !== null;
  const handleStagePointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    stagePointer.current = null;
    if (!event.isPrimary || event.button !== 0 || stageControlAt(event.target)) return;
    stagePointer.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      time: event.timeStamp,
      target: event.target,
    };
  };
  const handleStagePointerUp = (event: ReactPointerEvent<HTMLElement>) => {
    const down = stagePointer.current;
    stagePointer.current = null;
    if (
      down === null
      || down.id !== event.pointerId
      || !event.isPrimary
      || event.timeStamp - down.time > 500
      || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 8
      || stageControlAt(down.target)
      || stageControlAt(event.target)
    ) return;
    event.preventDefault();
    togglePlaying();
  };
  const goBack = () => {
    if (!resident || !canGoBack) return;
    const next = resident.tokens.start + previousRelative;
    onSetPlaying(false);
    setCompleted(false);
    setCursor(next);
    onPublish(next);
    setSettingStatus('back one frame');
  };
  const beginPaceEdit = () => {
    if (editingPaceRef.current) return;
    editingPaceRef.current = true;
    resumeAfterEdit.current = mode.playing;
    setEditingPace(true);
    setPaceDraft(String(mode.wpm));
    onPublish(cursor);
    onSetPlaying(false);
  };
  const finishPaceEdit = (commit: boolean) => {
    if (!editingPaceRef.current) return;
    editingPaceRef.current = false;
    if (commit) {
      const parsed = paceDraft.trim() === '' ? Number.NaN : Number(paceDraft);
      if (Number.isFinite(parsed)) onSetPacing({ wpm: parsed });
    } else {
      setPaceDraft(String(mode.wpm));
    }
    setEditingPace(false);
    if (resumeAfterEdit.current && !completed) onSetPlaying(true);
    resumeAfterEdit.current = false;
  };
  const handlePaceKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      finishPaceEdit(true);
      playRef.current?.focus({ preventScroll: true });
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      resumeAfterEdit.current = false;
      exit();
    } else if (shortcutMatches(event, 'reader-rsvp-toggle')) {
      event.preventDefault();
      event.stopPropagation();
      resumeAfterEdit.current = false;
      exit();
    }
  };
  const updatePacing = (patch: Partial<RsvpPacing>, status: string) => {
    onSetPacing(patch);
    setSettingStatus(status);
  };
  const finishNumberSettingEdit = (key: NumberSettingKey, commit: boolean) => {
    if (editingSettingRef.current !== key) return;
    editingSettingRef.current = null;
    if (key === 'frameCharLimit' && frameLimitInert) {
      setSettingDrafts((current) => ({
        ...current,
        frameCharLimit: String(mode.frameCharLimit),
      }));
      return;
    }
    const parsed = settingDrafts[key].trim() === '' ? Number.NaN : Number(settingDrafts[key]);
    if (commit && Number.isFinite(parsed)) {
      const patch = { [key]: parsed } as Pick<RsvpPacing, NumberSettingKey>;
      const bounded = clampRsvpPacing({ ...mode, ...patch });
      updatePacing(
        patch,
        `${NUMBER_SETTING_LABEL[key]} ${bounded[key]} ${NUMBER_SETTING_UNIT[key]}`,
      );
    } else {
      setSettingDrafts((current) => ({ ...current, [key]: String(mode[key]) }));
    }
  };
  const handleNumberSettingKeyDown = (
    event: KeyboardEvent<HTMLInputElement>,
    key: NumberSettingKey,
  ) => {
    if (event.key === 'Escape' || shortcutMatches(event, 'reader-rsvp-toggle')) {
      event.preventDefault();
      event.stopPropagation();
      exit();
    } else if (key === 'frameCharLimit' && frameLimitInert) {
      if (event.key !== 'Tab') {
        event.preventDefault();
        event.stopPropagation();
      }
    } else if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      finishNumberSettingEdit(key, true);
      event.currentTarget.blur();
    } else {
      stopControlSpace(event);
    }
  };
  const selectPreset = (preset: RsvpRhythmPreset) => {
    updatePacing(RSVP_RHYTHM_PRESETS[preset], `rhythm preset ${preset}`);
  };
  const resetRhythm = () => {
    updatePacing(RSVP_RHYTHM_RESET, 'rhythm reset to Natural at 300 words per minute');
  };
  const trapTab = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return;
    const controls = Array.from(
      shellRef.current?.querySelectorAll<HTMLElement>(
        '[data-rsvp-control]:is(button,input,select,summary,[tabindex]):not(:disabled)',
      ) ?? [],
    ).filter((control) => {
      const details = control.closest('details');
      return details === null
        || details.open
        || control.tagName === 'SUMMARY';
    });
    if (controls.length === 0) return;
    const first = controls[0]!;
    const last = controls.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  const wordsStatus = effectiveWords > 1 ? ` with ${effectiveWords} words at once` : '';
  const restSummary = spanPlan !== null
    && spanPlan.boundary !== 'window'
    && spanPlan.restMs < spanPlan.configuredRestMs
    ? `${spanPlan.boundary} rest ${spanPlan.configuredRestMs} ms (${spanPlan.restMs} ms here)`
    : '';
  const highSpeedNote = [
    mode.wpm > RSVP_MULTI_WORD_HINT_WPM && effectiveWords === 1
      ? 'Showing 2 or 3 words at once keeps each frame on screen longer.'
      : '',
    mode.wpm === RSVP_MAX_WPM
      ? `Boundary rests are zero at this pace to preserve the ${RSVP_MIN_EXPOSURE_MS} ms word floor.`
      : mode.wpm > RSVP_REST_FLOOR_CROSSOVER_WPM
        ? `Boundary rests may be capped by the ${RSVP_MIN_EXPOSURE_MS} ms word floor.`
        : '',
  ].filter(Boolean).join(' ');
  const stableStatus = completed
    ? 'End of document. Speed reading paused.'
    : source.status === 'error'
      ? 'Speed reading paused because the source failed.'
      : mode.playing
        ? `Speed reading playing at ${mode.wpm} words per minute including rests${wordsStatus}.`
        : `Speed reading paused at ${mode.wpm} words per minute including rests${wordsStatus}.`;
  const restCue = phase.frameKey === frameKey
    && phase.kind === 'rest'
    && (timing?.pauseMs ?? 0) >= RSVP_REST_CUE_MIN_MS;
  const preset = rsvpPresetSelection(mode);
  const progress = readerProgress(cursor, mode.docTokenCount, title);

  return (
    <div ref={shellRef} className="reader-rsvp-shell" onKeyDown={trapTab}>
      <header className="reader-header">
        <div>
          <h2 id="reader-title" style={{ margin: 0, fontSize: 'var(--text-lg)' }}>
            <span className="visually-hidden">Reader: </span>{title}
          </h2>
          <p className="reader-position" aria-hidden="true">
            token {(cursor + 1).toLocaleString()} of {mode.docTokenCount.toLocaleString()}
            {' · '}{mode.wpm.toLocaleString()} WPM pace
            {effectiveWords > 1 ? ` · ${effectiveWords} words at once` : ''}
            {restSummary === '' ? '' : ` · ${restSummary}`}
          </p>
          <p className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
            {settingStatus === '' ? stableStatus : `${stableStatus} ${settingStatus}.`}
          </p>
          {restSummary !== '' && <p className="visually-hidden">{restSummary}</p>}
        </div>
        <div className="reader-header-actions">
          <button
            type="button"
            data-rsvp-control="true"
            aria-keyshortcuts={shortcutAria(['show-help'])}
            onClick={onOpenHelp}
            onKeyDown={stopControlSpace}
            style={SMALL_BUTTON_STYLE}
          >
            help
          </button>
          <button
            ref={exitRef}
            type="button"
            data-rsvp-control="true"
            aria-keyshortcuts={shortcutAria(['reader-rsvp-toggle', 'rsvp-exit'])}
            onClick={exit}
            onKeyDown={stopControlSpace}
            style={SMALL_BUTTON_STYLE}
          >
            return to Reader
          </button>
        </div>
      </header>

      <section
        className="reader-rsvp-stage"
        data-rsvp-words={effectiveWords}
        data-rsvp-rest={restCue ? 'true' : undefined}
        aria-label="Speed reading word"
        onPointerDown={handleStagePointerDown}
        onPointerUp={handleStagePointerUp}
        onPointerCancel={() => { stagePointer.current = null; }}
      >
        <div className="reader-rsvp-word" aria-hidden="true">
          {frame ? (
            <>
              <span className="reader-rsvp-before">{frame.before}</span>
              <span className="reader-rsvp-anchor">{frame.anchor}</span>
              <span className="reader-rsvp-after">{frame.after}</span>
            </>
          ) : (
            <span className="reader-rsvp-loading">loading source text…</span>
          )}
        </div>
        <div className="reader-rsvp-context-slot">
          {pausedContext && (
            <div
              className="reader-rsvp-context"
              data-rsvp-control="true"
              role="note"
              aria-label="Paused sentence context"
              tabIndex={0}
              onKeyDown={stopControlSpace}
            >
              {pausedContext.leadingEllipsis && '… '}
              {pausedContext.before}
              <mark>{pausedContext.current}</mark>
              {pausedContext.after}
              {pausedContext.trailingEllipsis && ' …'}
            </div>
          )}
        </div>
        {source.status === 'error' && (
          <p className="reader-rsvp-error" role="alert">
            reader failed: {source.message}{' '}
            <button
              type="button"
              data-rsvp-control="true"
              onClick={onRetry}
              onKeyDown={stopControlSpace}
              style={SMALL_BUTTON_STYLE}
            >
              retry
            </button>
          </p>
        )}
      </section>

      <div className="reader-rsvp-controls-region">
        <ReaderProgressRail
          className="reader-rsvp-progress"
          progress={progress}
          accessibleName={`Position in ${title}`}
        />
        <nav className="reader-rsvp-controls" aria-label="Speed reading controls">
          <button
            className="reader-rsvp-back"
            type="button"
            data-rsvp-control="true"
            disabled={!canGoBack}
            onClick={goBack}
            onKeyDown={stopControlSpace}
            style={SMALL_BUTTON_STYLE}
          >
            back
          </button>
          <button
            className="reader-rsvp-toggle"
            ref={playRef}
            type="button"
            data-rsvp-control="true"
            disabled={completed}
            aria-pressed={mode.playing}
            aria-keyshortcuts={shortcutAria(['rsvp-toggle-play'])}
            onClick={togglePlaying}
            onKeyDown={stopControlSpace}
            style={SMALL_BUTTON_STYLE}
          >
            {completed ? 'completed' : mode.playing ? 'pause' : 'play'}
          </button>
          <button
            className="reader-rsvp-slower"
            type="button"
            data-rsvp-control="true"
            aria-label={`Slower, ${RSVP_WPM_STEP} words per minute`}
            aria-keyshortcuts={shortcutAria(['rsvp-pace-down'])}
            onClick={() => onSetPacing({ wpm: mode.wpm - RSVP_WPM_STEP })}
            onKeyDown={stopControlSpace}
            style={SMALL_BUTTON_STYLE}
          >
            slower
          </button>
          <label className="reader-rsvp-pace" data-rsvp-control="true" htmlFor={RSVP_WPM_INPUT_ID}>
            <span className="reader-rsvp-pace-caption">
              <span>pace</span>
              <span id={RSVP_PACE_HELP_ID}>including rests</span>
            </span>
            <input
              id={RSVP_WPM_INPUT_ID}
              data-rsvp-control="true"
              type="number"
              inputMode="numeric"
              min={RSVP_MIN_WPM}
              max={RSVP_MAX_WPM}
              step={RSVP_WPM_STEP}
              value={paceDraft}
              aria-label="Pace in words per minute"
              aria-describedby={highSpeedNote === ''
                ? RSVP_PACE_HELP_ID
                : `${RSVP_PACE_HELP_ID} ${RSVP_HIGH_SPEED_HELP_ID}`}
              aria-keyshortcuts={shortcutAria(['rsvp-pace-editor'])}
              onFocus={(event) => {
                beginPaceEdit();
                event.currentTarget.select();
              }}
              onChange={(event) => setPaceDraft(event.currentTarget.value)}
              onKeyDown={handlePaceKeyDown}
              onBlur={() => finishPaceEdit(false)}
            />
            <span>WPM</span>
          </label>
          <button
            className="reader-rsvp-faster"
            type="button"
            data-rsvp-control="true"
            aria-label={`Faster, ${RSVP_WPM_STEP} words per minute`}
            aria-keyshortcuts={shortcutAria(['rsvp-pace-up'])}
            onClick={() => onSetPacing({ wpm: mode.wpm + RSVP_WPM_STEP })}
            onKeyDown={stopControlSpace}
            style={SMALL_BUTTON_STYLE}
          >
            faster
          </button>
          <fieldset className="reader-rsvp-words" data-rsvp-control="true">
            <legend className="visually-hidden">
              {presentation.width === 'compact'
                ? 'Words at once (maximum; 3 is limited to 2 on this narrow screen)'
                : 'Words at once (maximum)'}
            </legend>
            <span className="reader-rsvp-words-caption" aria-hidden="true">
              words at once
              <span>
                {presentation.width === 'compact' ? 'max · 3 becomes 2 here' : 'maximum'}
              </span>
            </span>
            <span className="reader-rsvp-words-options">
              {[1, 2, 3].map((value) => (
                <label className="reader-rsvp-words-option" key={value} data-rsvp-control="true">
                  <input
                    data-rsvp-control="true"
                    type="radio"
                    name="reader-rsvp-words-at-once"
                    value={value}
                    checked={mode.wordsPerFrame === value}
                    aria-label={`${value} ${value === 1 ? 'word' : 'words'} at once`}
                    onChange={() => {
                      updatePacing(
                        { wordsPerFrame: value },
                        `${effectiveRsvpWordsPerFrame(value, presentation.width === 'compact')} words at once`,
                      );
                    }}
                    onKeyDown={stopControlSpace}
                  />
                  <span aria-hidden="true">{value}</span>
                </label>
              ))}
            </span>
          </fieldset>
        </nav>
        {highSpeedNote !== '' && (
          <p id={RSVP_HIGH_SPEED_HELP_ID} className="reader-rsvp-speed-note">
            {highSpeedNote}
          </p>
        )}

        <details
          className="reader-rsvp-rhythm"
          data-rsvp-control="true"
          onToggle={(event) => {
            if (!event.currentTarget.open) return;
            onPublish(cursor);
            onSetPlaying(false);
          }}
        >
          <summary data-rsvp-control="true" onKeyDown={stopControlSpace}>frame &amp; rhythm</summary>
          <div className="reader-rsvp-rhythm-body">
            <section
              className="reader-rsvp-settings-group reader-rsvp-frame-settings"
              aria-labelledby={RSVP_FRAME_GROUP_HEADING_ID}
            >
              <h3 id={RSVP_FRAME_GROUP_HEADING_ID}>frame</h3>
              <p className="reader-rsvp-settings-note">
                Frames stop at the word limit, the character limit, or punctuation — whichever
                comes first. Spaces and punctuation count, and a single long word is always shown whole.
              </p>
              <label data-rsvp-control="true">
                <span className="reader-rsvp-setting-label">
                  character limit
                  <span id={RSVP_FRAME_CHAR_LIMIT_HELP_ID}>
                    {frameLimitInert ? 'applies with 2+ words' : 'per frame · at most'}
                  </span>
                </span>
                <span className="reader-rsvp-setting-input">
                  <input
                    data-rsvp-control="true"
                    type="number"
                    inputMode="numeric"
                    min={RSVP_MIN_FRAME_CHAR_LIMIT}
                    max={RSVP_MAX_FRAME_CHAR_LIMIT}
                    step={RSVP_FRAME_CHAR_LIMIT_STEP}
                    value={settingDrafts.frameCharLimit}
                    readOnly={frameLimitInert}
                    aria-disabled={frameLimitInert || undefined}
                    aria-label="Frame character limit in characters"
                    aria-describedby={RSVP_FRAME_CHAR_LIMIT_HELP_ID}
                    onFocus={(event) => {
                      editingSettingRef.current = 'frameCharLimit';
                      event.currentTarget.select();
                    }}
                    onChange={(event) => {
                      if (frameLimitInert) return;
                      const value = event.currentTarget.value;
                      setSettingDrafts((current) => ({ ...current, frameCharLimit: value }));
                    }}
                    onKeyDown={(event) => handleNumberSettingKeyDown(event, 'frameCharLimit')}
                    onBlur={() => finishNumberSettingEdit('frameCharLimit', true)}
                  />
                  <span>chars</span>
                </span>
              </label>
            </section>

            <section
              className="reader-rsvp-settings-group reader-rsvp-rhythm-settings"
              aria-labelledby={RSVP_RHYTHM_GROUP_HEADING_ID}
            >
              <h3 id={RSVP_RHYTHM_GROUP_HEADING_ID}>rhythm</h3>
              <p className="reader-rsvp-settings-note">
                Rest values are maxima taken from the current sentence&rsquo;s time.
                {restSummary === '' ? '' : ` Current ${restSummary}.`}
              </p>
              <label data-rsvp-control="true">
                <span>rhythm preset</span>
                <select
                  data-rsvp-control="true"
                  aria-label="Rhythm preset"
                  value={preset}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    if (value !== 'custom') selectPreset(value as RsvpRhythmPreset);
                  }}
                  onKeyDown={stopControlSpace}
                >
                  <option value="natural">Natural</option>
                  <option value="even">Even</option>
                  <option value="study">Study</option>
                  <option value="custom" disabled>Custom</option>
                </select>
              </label>

              <label data-rsvp-control="true">
                <span className="reader-rsvp-setting-label">
                  sentence rest
                  <span id={RSVP_SENTENCE_REST_HELP_ID}>at most · from sentence time</span>
                </span>
                <span className="reader-rsvp-setting-input">
                  <input
                    data-rsvp-control="true"
                    type="number"
                    inputMode="numeric"
                    min="0"
                    max={RSVP_MAX_SENTENCE_PAUSE_MS}
                    step={RSVP_SENTENCE_PAUSE_STEP_MS}
                    value={settingDrafts.sentencePauseMs}
                    aria-label="Sentence rest in milliseconds"
                    aria-describedby={RSVP_SENTENCE_REST_HELP_ID}
                    onFocus={(event) => {
                      editingSettingRef.current = 'sentencePauseMs';
                      event.currentTarget.select();
                    }}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setSettingDrafts((current) => ({ ...current, sentencePauseMs: value }));
                    }}
                    onKeyDown={(event) => handleNumberSettingKeyDown(event, 'sentencePauseMs')}
                    onBlur={() => finishNumberSettingEdit('sentencePauseMs', true)}
                  />
                  <span>ms</span>
                </span>
              </label>

              <label data-rsvp-control="true">
                <span className="reader-rsvp-setting-label">
                  paragraph rest
                  <span id={RSVP_PARAGRAPH_REST_HELP_ID}>at most · from sentence time</span>
                </span>
                <span className="reader-rsvp-setting-input">
                  <input
                    data-rsvp-control="true"
                    type="number"
                    inputMode="numeric"
                    min={mode.sentencePauseMs}
                    max={RSVP_MAX_PARAGRAPH_PAUSE_MS}
                    step={RSVP_PARAGRAPH_PAUSE_STEP_MS}
                    value={settingDrafts.paragraphPauseMs}
                    aria-label="Paragraph rest in milliseconds"
                    aria-describedby={RSVP_PARAGRAPH_REST_HELP_ID}
                    onFocus={(event) => {
                      editingSettingRef.current = 'paragraphPauseMs';
                      event.currentTarget.select();
                    }}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setSettingDrafts((current) => ({ ...current, paragraphPauseMs: value }));
                    }}
                    onKeyDown={(event) => handleNumberSettingKeyDown(event, 'paragraphPauseMs')}
                    onBlur={() => finishNumberSettingEdit('paragraphPauseMs', true)}
                  />
                  <span>ms</span>
                </span>
              </label>

              <label data-rsvp-control="true">
                <span>length emphasis</span>
                <span className="reader-rsvp-setting-input">
                  <input
                    data-rsvp-control="true"
                    type="number"
                    inputMode="numeric"
                    min="0"
                    max={RSVP_MAX_LENGTH_EMPHASIS}
                    step={RSVP_LENGTH_EMPHASIS_STEP}
                    value={settingDrafts.lengthEmphasis}
                    aria-label="Length emphasis in percent"
                    onFocus={(event) => {
                      editingSettingRef.current = 'lengthEmphasis';
                      event.currentTarget.select();
                    }}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setSettingDrafts((current) => ({ ...current, lengthEmphasis: value }));
                    }}
                    onKeyDown={(event) => handleNumberSettingKeyDown(event, 'lengthEmphasis')}
                    onBlur={() => finishNumberSettingEdit('lengthEmphasis', true)}
                  />
                  <span>%</span>
                </span>
              </label>

              <button
                type="button"
                data-rsvp-control="true"
                onClick={resetRhythm}
                onKeyDown={stopControlSpace}
                style={SMALL_BUTTON_STYLE}
              >
                reset
              </button>
            </section>
          </div>
        </details>
      </div>
    </div>
  );
}
