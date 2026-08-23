import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import type { RsvpState } from '../lib/interaction.ts';
import {
  rsvpBoundedFrameStart,
  rsvpCursorStep,
  rsvpNeedsContinuation,
  RSVP_LENGTH_EMPHASIS_STEP,
  RSVP_MAX_LENGTH_EMPHASIS,
  RSVP_MAX_PARAGRAPH_PAUSE_MS,
  RSVP_MAX_SENTENCE_PAUSE_MS,
  RSVP_MAX_WPM,
  RSVP_MIN_WPM,
  RSVP_PARAGRAPH_PAUSE_STEP_MS,
  RSVP_REST_CUE_MIN_MS,
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
import { shortcutAria, shortcutMatches } from '../lib/shortcuts.ts';
import type { ReaderPageResultV1 } from '../shared/analysis-contract.ts';
import { usePresentation } from './PresentationProvider.tsx';
import { SMALL_BUTTON_STYLE } from './chrome.tsx';

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
  readonly onOpenShortcuts: () => void;
}

interface PlaybackPhase {
  readonly frameKey: string;
  readonly kind: 'word' | 'rest';
  readonly startedAt: number;
}

type RhythmNumberKey = 'sentencePauseMs' | 'paragraphPauseMs' | 'lengthEmphasis';

const RSVP_PACE_HELP_ID = 'reader-rsvp-pace-help';
const RSVP_SENTENCE_REST_HELP_ID = 'reader-rsvp-sentence-rest-help';
const RSVP_PARAGRAPH_REST_HELP_ID = 'reader-rsvp-paragraph-rest-help';

const RHYTHM_NUMBER_LABEL: Readonly<Record<RhythmNumberKey, string>> = Object.freeze({
  sentencePauseMs: 'sentence rest',
  paragraphPauseMs: 'paragraph rest',
  lengthEmphasis: 'length emphasis',
});

const RHYTHM_NUMBER_UNIT: Readonly<Record<RhythmNumberKey, string>> = Object.freeze({
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
  onOpenShortcuts,
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
  const [rhythmDrafts, setRhythmDrafts] = useState<Record<RhythmNumberKey, string>>({
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
  const editingRhythmRef = useRef<RhythmNumberKey | null>(null);
  const requestedSource = useRef<string | null>(null);
  const nextFrameStart = useRef<number | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const playRef = useRef<HTMLButtonElement | null>(null);
  const exitRef = useRef<HTMLButtonElement | null>(null);
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;

  const effectiveWords = effectiveRsvpWordsPerFrame(
    mode.wordsPerFrame,
    presentation.width === 'compact',
  );
  const playbackPacing = useMemo<RsvpPacing>(() => ({
    wpm: mode.wpm,
    wordsPerFrame: effectiveWords,
    sentencePauseMs: mode.sentencePauseMs,
    paragraphPauseMs: mode.paragraphPauseMs,
    lengthEmphasis: mode.lengthEmphasis,
  }), [
    effectiveWords,
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
    setRhythmDrafts((current) => ({
      sentencePauseMs: editingRhythmRef.current === 'sentencePauseMs'
        ? current.sentencePauseMs
        : String(mode.sentencePauseMs),
      paragraphPauseMs: editingRhythmRef.current === 'paragraphPauseMs'
        ? current.paragraphPauseMs
        : String(mode.paragraphPauseMs),
      lengthEmphasis: editingRhythmRef.current === 'lengthEmphasis'
        ? current.lengthEmphasis
        : String(mode.lengthEmphasis),
    }));
  }, [mode.lengthEmphasis, mode.paragraphPauseMs, mode.sentencePauseMs]);

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
      ? rsvpFrameAt(resident, relative, effectiveWords)
      : null,
    [effectiveWords, relative, resident],
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
      ? rsvpPreviousFrameStart(resident, relative, effectiveWords)
      : relative,
    [effectiveWords, relative, resident],
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
  const finishRhythmEdit = (key: RhythmNumberKey, commit: boolean) => {
    if (editingRhythmRef.current !== key) return;
    editingRhythmRef.current = null;
    const parsed = rhythmDrafts[key].trim() === '' ? Number.NaN : Number(rhythmDrafts[key]);
    if (commit && Number.isFinite(parsed)) {
      const patch = { [key]: parsed } as Pick<RsvpPacing, RhythmNumberKey>;
      const bounded = clampRsvpPacing({ ...mode, ...patch });
      updatePacing(
        patch,
        `${RHYTHM_NUMBER_LABEL[key]} ${bounded[key]} ${RHYTHM_NUMBER_UNIT[key]}`,
      );
    } else {
      setRhythmDrafts((current) => ({ ...current, [key]: String(mode[key]) }));
    }
  };
  const handleRhythmNumberKeyDown = (
    event: KeyboardEvent<HTMLInputElement>,
    key: RhythmNumberKey,
  ) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      finishRhythmEdit(key, true);
      event.currentTarget.blur();
    } else if (event.key === 'Escape' || shortcutMatches(event, 'reader-rsvp-toggle')) {
      event.preventDefault();
      event.stopPropagation();
      exit();
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
            onClick={onOpenShortcuts}
            onKeyDown={stopControlSpace}
            style={SMALL_BUTTON_STYLE}
          >
            shortcuts
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
        <nav className="reader-rsvp-controls" aria-label="Speed reading controls">
          <button
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

        <details
          className="reader-rsvp-rhythm"
          data-rsvp-control="true"
          onToggle={(event) => {
            if (!event.currentTarget.open) return;
            onPublish(cursor);
            onSetPlaying(false);
          }}
        >
          <summary data-rsvp-control="true" onKeyDown={stopControlSpace}>rhythm</summary>
          <div className="reader-rsvp-rhythm-body">
            <p className="reader-rsvp-rhythm-note">
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
                  value={rhythmDrafts.sentencePauseMs}
                  aria-label="Sentence rest in milliseconds"
                  aria-describedby={RSVP_SENTENCE_REST_HELP_ID}
                  onFocus={(event) => {
                    editingRhythmRef.current = 'sentencePauseMs';
                    event.currentTarget.select();
                  }}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setRhythmDrafts((current) => ({ ...current, sentencePauseMs: value }));
                  }}
                  onKeyDown={(event) => handleRhythmNumberKeyDown(event, 'sentencePauseMs')}
                  onBlur={() => finishRhythmEdit('sentencePauseMs', true)}
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
                  value={rhythmDrafts.paragraphPauseMs}
                  aria-label="Paragraph rest in milliseconds"
                  aria-describedby={RSVP_PARAGRAPH_REST_HELP_ID}
                  onFocus={(event) => {
                    editingRhythmRef.current = 'paragraphPauseMs';
                    event.currentTarget.select();
                  }}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setRhythmDrafts((current) => ({ ...current, paragraphPauseMs: value }));
                  }}
                  onKeyDown={(event) => handleRhythmNumberKeyDown(event, 'paragraphPauseMs')}
                  onBlur={() => finishRhythmEdit('paragraphPauseMs', true)}
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
                  value={rhythmDrafts.lengthEmphasis}
                  aria-label="Length emphasis in percent"
                  onFocus={(event) => {
                    editingRhythmRef.current = 'lengthEmphasis';
                    event.currentTarget.select();
                  }}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setRhythmDrafts((current) => ({ ...current, lengthEmphasis: value }));
                  }}
                  onKeyDown={(event) => handleRhythmNumberKeyDown(event, 'lengthEmphasis')}
                  onBlur={() => finishRhythmEdit('lengthEmphasis', true)}
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
          </div>
        </details>
      </div>
    </div>
  );
}
