import { useEffect, useRef, useState } from 'react';
import { type TrendRowSizing } from '../../lib/trend-row-size.ts';
import {
  beginTrendRowDetent,
  moveTrendRowDetent,
  stepTrendRowPitch,
  type TrendRowDetentState,
} from '../../lib/trend-row-detent.ts';
import { shortcutAria } from '../../lib/shortcuts.ts';

export function TrendRowResizeHandle({
  sizing,
  trackCount,
  legendTrackCount,
  occurrenceInteractive,
  coarse,
  onPreview,
  onCommit,
  onCancel,
}: {
  readonly sizing: TrendRowSizing;
  readonly trackCount: number;
  readonly legendTrackCount: number;
  readonly occurrenceInteractive: boolean;
  readonly coarse: boolean;
  readonly onPreview: (target: number | null) => void;
  readonly onCommit: (target: number | null) => void;
  readonly onCancel: () => void;
}) {
  const [resizing, setResizing] = useState(false);
  const [focused, setFocused] = useState(false);
  const [detentHint, setDetentHint] = useState<'hide' | 'restore' | null>(null);
  const resizeFrame = useRef<number | null>(null);
  const pendingTarget = useRef<number | null>(null);
  const keyboardTarget = useRef<number | null>(null);
  const drag = useRef<{
    readonly pointerId: number;
    readonly startY: number;
    readonly startPitch: number;
    detent: TrendRowDetentState;
    lastTarget: number;
    moved: boolean;
  } | null>(null);

  useEffect(() => () => {
    if (resizeFrame.current !== null) cancelAnimationFrame(resizeFrame.current);
    document.documentElement.removeAttribute('data-trend-row-resizing');
  }, []);

  const setResizeActive = (active: boolean) => {
    setResizing(active);
    if (active) document.documentElement.setAttribute('data-trend-row-resizing', 'true');
    else document.documentElement.removeAttribute('data-trend-row-resizing');
  };
  const commitPendingTarget = () => {
    if (resizeFrame.current !== null) {
      cancelAnimationFrame(resizeFrame.current);
      resizeFrame.current = null;
    }
    const pending = pendingTarget.current;
    pendingTarget.current = null;
    if (pending !== null) onPreview(pending);
  };
  const scheduleTarget = (next: number) => {
    pendingTarget.current = next;
    if (drag.current) { drag.current.lastTarget = next; drag.current.moved = true; }
    resizeFrame.current ??= requestAnimationFrame(() => {
      resizeFrame.current = null;
      const pending = pendingTarget.current;
      pendingTarget.current = null;
      if (pending !== null) onPreview(pending);
    });
  };
  const finishResize = (pointerId: number) => {
    const active = drag.current;
    if (active?.pointerId !== pointerId) return;
    commitPendingTarget();
    drag.current = null;
    setResizeActive(false);
    setDetentHint(null);
    if (active.moved) onCommit(active.lastTarget);
  };
  const stateText = `${sizing.rowPitch} pixels per text · ${
    sizing.titlesPainted ? 'titles shown' : 'titles hidden'
  }${trackCount > 0 && !sizing.barcodeVisible
    ? ' · occurrence rows hidden · smallest row'
    : trackCount > 0 && sizing.rowPitch === sizing.inkPitch
      ? ' · occurrence rows minimized · smallest row with occurrence rows'
    : ''}`;
  const valuetext = detentHint === 'hide'
    ? `${sizing.inkPitch} pixels per text · keep dragging up to hide ${trackCount} occurrence row${trackCount === 1 ? '' : 's'}`
    : detentHint === 'restore'
      ? `${sizing.minPitch} pixels per text · keep dragging down to restore occurrence rows`
      : stateText;
  const commitKeyboardTarget = () => {
    const pending = keyboardTarget.current;
    keyboardTarget.current = null;
    if (pending !== null) onCommit(pending);
  };

  const resizeByKeyboard = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const direction = event.key === 'ArrowDown' || event.key === 'PageDown'
      ? 1
      : event.key === 'ArrowUp' || event.key === 'PageUp'
        ? -1
        : 0;
    if (direction === 0 && !['Home', 'End', 'Enter', 'Escape'].includes(event.key)) return;
    if (event.key === 'Escape' && drag.current === null) return;
    event.preventDefault();
    setFocused(true);
    if (event.key === 'Escape') {
      const active = drag.current;
      if (active) {
        if (resizeFrame.current !== null) cancelAnimationFrame(resizeFrame.current);
        resizeFrame.current = null;
        pendingTarget.current = null;
        drag.current = null;
        if (event.currentTarget.hasPointerCapture(active.pointerId)) {
          event.currentTarget.releasePointerCapture(active.pointerId);
        }
        onCancel();
        setResizeActive(false);
        setDetentHint(null);
      }
      return;
    }
    if (event.key === 'Enter') {
      keyboardTarget.current = null;
      onCommit(null);
      return;
    }
    const step = event.shiftKey
      ? 1
      : event.key === 'PageUp' || event.key === 'PageDown'
        ? 32
        : 8;
    const currentPitch = keyboardTarget.current ?? sizing.rowPitch;
    const next = event.key === 'Home'
      ? sizing.minPitch
      : event.key === 'End'
        ? sizing.maxPitch
        : stepTrendRowPitch(
            currentPitch,
            direction as -1 | 1,
            step,
            sizing,
          );
    keyboardTarget.current = next;
    onPreview(next);
  };

  return (
    <div
      className="trend-row-resize-handle"
      role="separator"
      aria-label="Resize trend rows"
      aria-orientation="horizontal"
      aria-controls="reading-position-scrubber"
      aria-valuemin={sizing.minPitch}
      aria-valuemax={sizing.maxPitch}
      aria-valuenow={sizing.rowPitch}
      aria-valuetext={valuetext}
      aria-describedby={legendTrackCount > 0 && !sizing.barcodeVisible
        ? 'trend-hidden-barcode-note'
        : legendTrackCount > 0 && !occurrenceInteractive
          ? 'trend-mini-barcode-note'
          : undefined}
      aria-keyshortcuts={shortcutAria([
        'trend-rows-step',
        'trend-rows-fine',
        'trend-rows-page',
        'trend-rows-limits',
        'trend-rows-reset',
      ])}
      tabIndex={0}
      data-resizing={resizing || undefined}
      data-titles-painted={sizing.titlesPainted}
      data-row-phase={sizing.phase}
      data-barcode-visible={sizing.barcodeVisible}
      data-barcode-interactive={occurrenceInteractive}
      style={{ '--trend-row-resize-target': coarse ? '44px' : '24px' } as React.CSSProperties}
      onDoubleClick={() => { onCommit(null); }}
      onKeyDown={resizeByKeyboard}
      onKeyUp={(event) => {
        if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) {
          commitKeyboardTarget();
        }
      }}
      onFocus={(event) => {
        setFocused(event.currentTarget.matches(':focus-visible'));
      }}
      onBlur={() => {
        setFocused(false);
        commitKeyboardTarget();
      }}
      onPointerDown={(event) => {
        if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
        event.preventDefault();
        setFocused(false);
        commitKeyboardTarget();
        event.currentTarget.focus();
        drag.current = {
          pointerId: event.pointerId,
          startY: event.clientY,
          startPitch: sizing.rowPitch,
          detent: beginTrendRowDetent(sizing.rowPitch, sizing.minPitch, event.clientY),
          lastTarget: sizing.rowPitch,
          moved: false,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        setResizeActive(true);
      }}
      onPointerMove={(event) => {
        const active = drag.current;
        if (active?.pointerId !== event.pointerId) return;
        event.preventDefault();
        const requestedPitch = Math.max(
          sizing.minPitch,
          Math.min(
            sizing.maxPitch,
            Math.round(active.startPitch + event.clientY - active.startY),
          ),
        );
        const transition = moveTrendRowDetent(active.detent, {
          clientY: event.clientY,
          requestedPitch,
          minPitch: sizing.minPitch,
          inkPitch: sizing.inkPitch,
          coarse,
        });
        active.detent = transition.state;
        active.lastTarget = transition.pitch;
        setDetentHint(transition.hint);
        scheduleTarget(transition.pitch);
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        finishResize(event.pointerId);
      }}
      onPointerCancel={(event) => { finishResize(event.pointerId); }}
      onLostPointerCapture={(event) => { finishResize(event.pointerId); }}
    >
      <span className="trend-row-resize-mark" aria-hidden="true" />
      {(resizing || focused) && <span className="trend-row-resize-readout">{valuetext}</span>}
    </div>
  );
}
