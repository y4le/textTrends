import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import type { RsvpState } from '../lib/interaction.ts';
import { rsvpCursorStep, rsvpNeedsContinuation } from '../lib/rsvp-playback.ts';
import {
  RSVP_MAX_WPM,
  RSVP_MIN_WPM,
  RSVP_WPM_INPUT_ID,
  RSVP_WPM_STEP,
  rsvpHoldMs,
  rsvpWordFrame,
} from '../lib/rsvp.ts';
import { shortcutAria, shortcutMatches } from '../lib/shortcuts.ts';
import type { ReaderPageResultV1 } from '../shared/analysis-contract.ts';
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
  readonly onSetWpm: (wpm: number) => void;
  readonly onPublish: (token: number) => void;
  readonly onSeek: (token: number) => void;
  readonly onExit: (token: number) => void;
  readonly onRetry: () => void;
  readonly onOpenShortcuts: () => void;
}

function contains(page: ReaderPageResultV1, token: number): boolean {
  return token >= page.tokens.start
    && token < page.tokens.end;
}

function stopControlSpace(event: KeyboardEvent<HTMLElement>): void {
  if (event.key === ' ') event.stopPropagation();
}

export function RsvpReader({
  title,
  mode,
  source,
  onSetPlaying,
  onSetWpm,
  onPublish,
  onSeek,
  onExit,
  onRetry,
  onOpenShortcuts,
}: RsvpReaderProps) {
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
  const resumeAfterEdit = useRef(false);
  const editingPaceRef = useRef(false);
  const requestedSource = useRef<string | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const playRef = useRef<HTMLButtonElement | null>(null);
  const exitRef = useRef<HTMLButtonElement | null>(null);
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;

  useEffect(() => {
    if (source.status !== 'ready' || source.page.doc !== mode.doc) return;
    if (!contains(source.page, cursorRef.current)) return;
    setResident(source.page);
  }, [mode.doc, source]);

  useEffect(() => {
    if (!editingPace) setPaceDraft(String(mode.wpm));
  }, [editingPace, mode.wpm]);

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
      ? rsvpWordFrame(resident, relative)
      : null,
    [relative, resident],
  );

  useEffect(() => {
    if (!resident || !frame || completed) return;
    const key = `${resident.doc}:${resident.tokens.start}:${resident.tokens.end}`;
    if (
      requestedSource.current !== key
      && rsvpNeedsContinuation(resident, cursor, mode.wpm)
    ) {
      requestedSource.current = key;
      onSeek(cursor);
    }
  }, [completed, cursor, frame, mode.wpm, onSeek, resident]);

  useEffect(() => {
    if (!mode.playing || !resident || !frame || completed) return undefined;
    const timer = window.setTimeout(() => {
      const step = rsvpCursorStep(resident, cursor);
      if (step.kind === 'next') {
        setCursor(step.token);
        onPublish(step.token);
        return;
      }
      onPublish(cursor);
      onSetPlaying(false);
      if (step.kind === 'document-end') {
        setCompleted(true);
      } else {
        onSeek(cursor);
      }
    }, rsvpHoldMs(mode.wpm, frame));
    return () => window.clearTimeout(timer);
  }, [completed, cursor, frame, mode.playing, mode.wpm, onPublish, onSeek, onSetPlaying, resident]);

  const exit = () => {
    onPublish(cursor);
    onExit(cursor);
  };
  const togglePlaying = () => {
    if (completed) return;
    onPublish(cursor);
    onSetPlaying(!mode.playing);
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
      if (Number.isFinite(parsed)) onSetWpm(parsed);
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
  const trapTab = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return;
    const controls = Array.from(
      shellRef.current?.querySelectorAll<HTMLElement>('[data-rsvp-control]:not(:disabled)') ?? [],
    );
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
  const stableStatus = completed
    ? 'End of document. Speed reading paused.'
    : source.status === 'error'
      ? 'Speed reading paused because the source failed.'
      : mode.playing
        ? `Speed reading playing at a set pace of ${mode.wpm} words per minute.`
        : `Speed reading paused at a set pace of ${mode.wpm} words per minute.`;

  return (
    <div ref={shellRef} className="reader-rsvp-shell" onKeyDown={trapTab}>
      <header className="reader-header">
        <div>
          <h2 id="reader-title" style={{ margin: 0, fontSize: 'var(--text-lg)' }}>
            <span className="visually-hidden">Reader: </span>{title}
          </h2>
          <p className="reader-position" aria-hidden="true">
            token {(cursor + 1).toLocaleString()} of {mode.docTokenCount.toLocaleString()}
            {' · '}{mode.wpm.toLocaleString()} WPM set pace
          </p>
          <p className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
            {stableStatus}
          </p>
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

      <section className="reader-rsvp-stage" aria-label="Speed reading word">
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

      <nav className="reader-rsvp-controls" aria-label="Speed reading controls">
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
          onClick={() => onSetWpm(mode.wpm - RSVP_WPM_STEP)}
          onKeyDown={stopControlSpace}
          style={SMALL_BUTTON_STYLE}
        >
          slower
        </button>
        <label
          className="reader-rsvp-pace"
          data-rsvp-control="true"
          htmlFor={RSVP_WPM_INPUT_ID}
        >
          <span>set pace</span>
          <input
            id={RSVP_WPM_INPUT_ID}
            data-rsvp-control="true"
            type="number"
            inputMode="numeric"
            min={RSVP_MIN_WPM}
            max={RSVP_MAX_WPM}
            step={RSVP_WPM_STEP}
            value={paceDraft}
            aria-label="Set pace in words per minute"
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
          onClick={() => onSetWpm(mode.wpm + RSVP_WPM_STEP)}
          onKeyDown={stopControlSpace}
          style={SMALL_BUTTON_STYLE}
        >
          faster
        </button>
      </nav>
    </div>
  );
}
