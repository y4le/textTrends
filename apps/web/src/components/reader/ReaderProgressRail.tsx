import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import type { ReaderProgress } from '../../lib/reader-progress.ts';

interface ReaderProgressDrag {
  readonly pointerId: number;
}

const SEEK_PREVIEW_INTERVAL_MS = 100;
const SEEK_PREVIEW_EXPIRY_MS = 2_500;
const KEYBOARD_SEEK_IDLE_MS = 400;

export type ReaderSeekPhase = 'start' | 'preview' | 'commit';

export function ReaderProgressRail({
  progress,
  accessibleName,
  className,
  orientation = 'horizontal',
  onSeek,
}: {
  readonly progress: ReaderProgress | null;
  readonly accessibleName?: string;
  readonly className?: string;
  readonly orientation?: 'horizontal' | 'vertical';
  readonly onSeek?: (token: number, phase: ReaderSeekPhase) => void;
}) {
  const drag = useRef<ReaderProgressDrag | null>(null);
  const keyboardSeeking = useRef(false);
  const horizontalDirection = useRef<1 | -1>(1);
  const previewTokenRef = useRef<number | null>(null);
  const pendingSeek = useRef<number | null>(null);
  const seekTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keyboardCommitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPreviewAt = useRef(0);
  const lastProgress = useRef<ReaderProgress | null>(progress);
  const onSeekRef = useRef(onSeek);
  const [previewToken, setPreviewToken] = useState<number | null>(null);
  const [seeking, setSeeking] = useState(false);
  if (progress !== null) lastProgress.current = progress;
  onSeekRef.current = onSeek;
  const activeProgress = progress ?? (previewToken === null ? null : lastProgress.current);
  const seekable = activeProgress !== null && onSeek !== undefined;
  const shownToken = activeProgress === null
    ? 0
    : Math.max(
        0,
        Math.min(activeProgress.tokenCount - 1, previewToken ?? activeProgress.token),
      );
  const fraction = activeProgress === null || activeProgress.tokenCount === 1
    ? 0
    : shownToken / (activeProgress.tokenCount - 1);
  const percent = fraction * 100;
  const roundedPercent = Math.round(percent);
  const classes = ['reader-progress-rail', className].filter(Boolean).join(' ');

  useEffect(() => {
    if (
      drag.current === null
      && !keyboardSeeking.current
      && previewToken !== null
      && progress?.token === previewToken
    ) {
      previewTokenRef.current = null;
      setPreviewToken(null);
    }
  }, [previewToken, progress?.token]);

  useEffect(() => {
    if (seeking || previewToken === null || progress?.token === previewToken) return undefined;
    const expiry = setTimeout(() => {
      previewTokenRef.current = null;
      setPreviewToken(null);
    }, SEEK_PREVIEW_EXPIRY_MS);
    return () => clearTimeout(expiry);
  }, [previewToken, progress?.token, seeking]);

  const showToken = (token: number) => {
    previewTokenRef.current = token;
    setPreviewToken(token);
  };
  const schedulePreview = (token: number) => {
    pendingSeek.current = token;
    if (seekTimer.current !== null) return;
    const delay = Math.max(
      0,
      SEEK_PREVIEW_INTERVAL_MS - (performance.now() - lastPreviewAt.current),
    );
    seekTimer.current = setTimeout(() => {
      seekTimer.current = null;
      lastPreviewAt.current = performance.now();
      const pending = pendingSeek.current;
      pendingSeek.current = null;
      if (pending !== null) onSeekRef.current?.(pending, 'preview');
    }, delay);
  };
  const cancelScheduledPreview = () => {
    if (seekTimer.current !== null) clearTimeout(seekTimer.current);
    seekTimer.current = null;
    pendingSeek.current = null;
  };
  const cancelKeyboardCommit = () => {
    if (keyboardCommitTimer.current !== null) clearTimeout(keyboardCommitTimer.current);
    keyboardCommitTimer.current = null;
  };

  useEffect(() => () => {
    cancelScheduledPreview();
    cancelKeyboardCommit();
    const token = previewTokenRef.current;
    if ((drag.current !== null || keyboardSeeking.current) && token !== null) {
      onSeekRef.current?.(token, 'commit');
    }
  }, []);

  const tokenAtPointer = (event: PointerEvent<HTMLSpanElement>): number | null => {
    if (activeProgress === null) return null;
    const rect = event.currentTarget.getBoundingClientRect();
    const extent = orientation === 'vertical' ? rect.height : rect.width;
    if (extent <= 0) return null;
    const offset = orientation === 'vertical'
      ? event.clientY - rect.top
      : event.clientX - rect.left;
    const directedOffset = horizontalDirection.current === -1 ? extent - offset : offset;
    const pointerFraction = Math.max(0, Math.min(1, directedOffset / extent));
    return Math.round(pointerFraction * (activeProgress.tokenCount - 1));
  };
  const handlePointerDown = (event: PointerEvent<HTMLSpanElement>) => {
    if (!seekable || !event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) {
      return;
    }
    if (keyboardSeeking.current) {
      cancelKeyboardCommit();
      keyboardSeeking.current = false;
      const keyboardToken = previewTokenRef.current;
      if (keyboardToken !== null) onSeekRef.current?.(keyboardToken, 'commit');
    }
    horizontalDirection.current = orientation === 'horizontal'
      && getComputedStyle(event.currentTarget).direction === 'rtl'
      ? -1
      : 1;
    const token = tokenAtPointer(event);
    if (token === null) return;
    event.preventDefault();
    event.stopPropagation();
    drag.current = { pointerId: event.pointerId };
    setSeeking(true);
    showToken(token);
    onSeekRef.current?.(token, 'start');
    event.currentTarget.focus({ preventScroll: true });
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic pointer events do not always represent an active platform pointer.
    }
  };
  const handlePointerMove = (event: PointerEvent<HTMLSpanElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    const token = tokenAtPointer(event);
    if (token !== null) {
      showToken(token);
      schedulePreview(token);
    }
  };
  const finishPointer = (event: PointerEvent<HTMLSpanElement>, commit: boolean) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    const token = commit ? tokenAtPointer(event) : previewTokenRef.current;
    drag.current = null;
    setSeeking(false);
    cancelScheduledPreview();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (token === null) {
      previewTokenRef.current = null;
      setPreviewToken(null);
      return;
    }
    showToken(token);
    // A cancelled or lost pointer commits the last live preview so the Reader
    // and its position history cannot diverge after an interrupted gesture.
    onSeekRef.current?.(token, 'commit');
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (!seekable || activeProgress === null || drag.current !== null) return;
    const step = Math.max(1, Math.round((activeProgress.tokenCount - 1) / 100));
    const pageStep = Math.max(step, Math.round((activeProgress.tokenCount - 1) / 10));
    let token: number | null = null;
    switch (event.key) {
      case 'ArrowLeft':
      case 'ArrowUp':
        token = shownToken - step;
        break;
      case 'ArrowRight':
      case 'ArrowDown':
        token = shownToken + step;
        break;
      case 'PageDown':
        token = shownToken + pageStep;
        break;
      case 'PageUp':
        token = shownToken - pageStep;
        break;
      case 'Home':
        token = 0;
        break;
      case 'End':
        token = activeProgress.tokenCount - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    cancelKeyboardCommit();
    const bounded = Math.max(0, Math.min(activeProgress.tokenCount - 1, token));
    const phase = keyboardSeeking.current ? 'preview' : 'start';
    keyboardSeeking.current = true;
    setSeeking(true);
    showToken(bounded);
    if (phase === 'start') onSeekRef.current?.(bounded, phase);
    else schedulePreview(bounded);
  };
  const finishKeyboardSeek = () => {
    if (!keyboardSeeking.current) return;
    cancelKeyboardCommit();
    keyboardSeeking.current = false;
    setSeeking(false);
    cancelScheduledPreview();
    const token = previewTokenRef.current;
    if (token !== null) onSeekRef.current?.(token, 'commit');
  };
  const scheduleKeyboardCommit = () => {
    cancelKeyboardCommit();
    keyboardCommitTimer.current = setTimeout(() => {
      keyboardCommitTimer.current = null;
      finishKeyboardSeek();
    }, KEYBOARD_SEEK_IDLE_MS);
  };
  const handleKeyUp = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (!keyboardSeeking.current) return;
    switch (event.key) {
      case 'ArrowLeft':
      case 'ArrowUp':
      case 'ArrowRight':
      case 'ArrowDown':
      case 'PageDown':
      case 'PageUp':
      case 'Home':
      case 'End':
        event.preventDefault();
        event.stopPropagation();
        scheduleKeyboardCommit();
        break;
      default:
        break;
    }
  };

  return (
    <span
      className={classes}
      role={activeProgress === null ? undefined : seekable ? 'slider' : 'progressbar'}
      aria-label={activeProgress === null
        ? undefined
        : accessibleName ?? activeProgress.label}
      aria-valuemin={activeProgress === null ? undefined : seekable ? 1 : 0}
      aria-valuemax={activeProgress === null
        ? undefined
        : seekable ? activeProgress.tokenCount : 100}
      aria-valuenow={activeProgress === null
        ? undefined
        : seekable ? shownToken + 1 : activeProgress.percent}
      aria-valuetext={activeProgress === null
        ? undefined
        : seekable
          ? `Token ${(shownToken + 1).toLocaleString()} of ${activeProgress.tokenCount.toLocaleString()}, ${roundedPercent} percent`
          : `${activeProgress.percent} percent`}
      aria-orientation={seekable ? orientation : undefined}
      tabIndex={seekable ? 0 : undefined}
      data-reader-progress={activeProgress === null ? undefined : fraction}
      data-orientation={orientation}
      data-seekable={seekable || undefined}
      data-seeking={seeking || undefined}
      onPointerDown={seekable ? handlePointerDown : undefined}
      onPointerMove={seekable ? handlePointerMove : undefined}
      onPointerUp={seekable ? (event) => finishPointer(event, true) : undefined}
      onPointerCancel={seekable ? (event) => finishPointer(event, false) : undefined}
      onLostPointerCapture={seekable ? (event) => finishPointer(event, false) : undefined}
      onKeyDown={seekable ? handleKeyDown : undefined}
      onKeyUp={seekable ? handleKeyUp : undefined}
      onBlur={seekable ? finishKeyboardSeek : undefined}
    >
      <span
        className="reader-progress-fill"
        style={orientation === 'vertical'
          ? { blockSize: `${percent}%` }
          : { inlineSize: `${percent}%` }}
        aria-hidden="true"
      />
      {activeProgress !== null && (
        <span
          className="reader-progress-cursor"
          style={orientation === 'vertical'
            ? {
                insetBlockStart: `clamp(0px, calc(${percent}% - 1px), calc(100% - 2px))`,
              }
            : {
                insetInlineStart: `clamp(0px, calc(${percent}% - 1px), calc(100% - 2px))`,
              }}
          aria-hidden="true"
        />
      )}
    </span>
  );
}
