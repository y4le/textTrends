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
  RSVP_MAX_WPM,
  RSVP_MIN_WPM,
  RSVP_REST_CUE_MIN_MS,
  RSVP_RHYTHM_PRESETS,
  RSVP_WPM_STEP,
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
  readonly onOpenSettings: (returnFocus: HTMLElement, restSummary: string) => void;
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

const RSVP_PACE_HELP_ID = 'reader-rsvp-pace-help';

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
  onOpenSettings,
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
  const [settingStatus, setSettingStatus] = useState('');
  const [phase, setPhase] = useState<PlaybackPhase>({
    frameKey: '',
    kind: 'word',
    startedAt: 0,
  });
  const resumeAfterEdit = useRef(false);
  const editingPaceRef = useRef(false);
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
    setSettingStatus('previous frame');
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
      <header className="reader-rsvp-topbar">
        <button
          ref={exitRef}
          className="reader-rsvp-exit"
          type="button"
          data-rsvp-control="true"
          aria-label="Return to Reader"
          aria-keyshortcuts={shortcutAria(['reader-rsvp-toggle', 'rsvp-exit'])}
          onClick={exit}
          onKeyDown={stopControlSpace}
        >
          <span aria-hidden="true">←</span>{' '}Reader
        </button>
        <div className="reader-rsvp-identity">
          <h2 id="reader-title">
            <span className="visually-hidden">Reader: </span>{title}
          </h2>
          <p className="reader-position" aria-hidden="true">
            token {(cursor + 1).toLocaleString()}
            {' · '}{progress?.percent ?? 0}%
            {' · '}{mode.wpm.toLocaleString()} WPM
          </p>
          <p className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
            {settingStatus === '' ? stableStatus : `${stableStatus} ${settingStatus}.`}
          </p>
          {restSummary !== '' && <p className="visually-hidden">{restSummary}</p>}
        </div>
        <button
          id="reader-rsvp-settings-open"
          className="reader-rsvp-settings-open"
          type="button"
          data-rsvp-control="true"
          aria-label="Open Speed settings"
          onClick={(event) => {
            onPublish(cursor);
            onSetPlaying(false);
            onOpenSettings(event.currentTarget, restSummary);
          }}
          onKeyDown={stopControlSpace}
        >
          <span className="reader-rsvp-settings-label">settings</span>
          <span className="reader-rsvp-settings-icon" aria-hidden="true">⋯</span>
        </button>
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
        <nav className="reader-rsvp-transport" aria-label="Speed reading transport">
          <button
            className="reader-rsvp-previous"
            type="button"
            data-rsvp-control="true"
            aria-label="Previous frame"
            disabled={!canGoBack}
            onClick={goBack}
            onKeyDown={stopControlSpace}
          >
            <span aria-hidden="true">⟲</span>{' '}
            <span className="reader-rsvp-previous-label">frame</span>
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
          >
            <span aria-hidden="true">−</span>
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
              aria-describedby={RSVP_PACE_HELP_ID}
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
          >
            <span aria-hidden="true">+</span>
          </button>
        </nav>
        <div className="reader-rsvp-shape" aria-label="Speed frame shape">
          <fieldset className="reader-rsvp-words" data-rsvp-control="true">
            <legend className="visually-hidden">
              {presentation.width === 'compact'
                ? 'Words at once (maximum; 3 is limited to 2 on this narrow screen)'
                : 'Words at once (maximum)'}
            </legend>
            <span className="reader-rsvp-words-caption" aria-hidden="true">
              frame
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
                      onPublish(cursor);
                      onSetPlaying(false);
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
          <label className="reader-rsvp-preset" data-rsvp-control="true">
            <span>rhythm</span>
            <select
              data-rsvp-control="true"
              aria-label="Rhythm preset"
              value={preset}
              onChange={(event) => {
                const value = event.currentTarget.value;
                if (value === 'custom') return;
                onPublish(cursor);
                onSetPlaying(false);
                updatePacing(
                  RSVP_RHYTHM_PRESETS[value as RsvpRhythmPreset],
                  `rhythm preset ${value}`,
                );
              }}
              onKeyDown={stopControlSpace}
            >
              <option value="natural">Natural</option>
              <option value="even">Even</option>
              <option value="study">Study</option>
              <option value="custom" disabled>Custom</option>
            </select>
          </label>
        </div>
      </div>
    </div>
  );
}
