import type { RefObject } from 'react';
import { shortcutAria } from '../../lib/shortcuts.ts';
import type { TrendLabelBand } from '../../lib/trend-geometry.ts';
import type { TrendView } from '../../lib/trend-view.ts';
import { nextTrendTitleFocus, resetTrendTitleGesture, trendTitleDown, trendTitleMove,
  trendTitleUp, type TrendTitleGesture, type TrendTitleEffect,
} from '../../lib/trend-title-gesture.ts';

const TREND_TITLE_ARIA_KEYS = shortcutAria([
  'trend-title-previous',
  'trend-title-next',
  'trend-title-first',
  'trend-title-last',
  'trend-title-select',
  'trend-title-extend',
]);

/** Whole-text controls own roving focus and title pointer events. Their
 * effects join the same selection transaction as plot and range gestures. */
export function TrendTitleControls({ labelBands, docs, docTokenCount, titleByDoc,
  plotW, trendView, hiddenTitles, titleFocusOrdinal, setTitleFocusOrdinal,
  titleControlRefs, titleKeyboardAnchor, gestureRef, targetAt,
  onStart, onEffect, onCommitRange, onClearPreview,
}: {
  readonly labelBands: readonly TrendLabelBand[];
  readonly docs: readonly string[];
  readonly docTokenCount: readonly number[];
  readonly titleByDoc: ReadonlyMap<string, string>;
  readonly plotW: number;
  readonly trendView: TrendView;
  readonly hiddenTitles: boolean;
  readonly titleFocusOrdinal: number;
  readonly setTitleFocusOrdinal: (ordinal: number) => void;
  readonly titleControlRefs: RefObject<Map<number, HTMLButtonElement>>;
  readonly titleKeyboardAnchor: RefObject<number | null>;
  readonly gestureRef: RefObject<TrendTitleGesture>;
  readonly targetAt: (x: number, y: number) => number | null;
  readonly onStart: () => void;
  readonly onEffect: (effect: TrendTitleEffect) => void;
  readonly onCommitRange: (anchor: number, head: number) => void;
  readonly onClearPreview: () => void;
}) {
  return (
      <div
        className="trend-title-controls"
        role="group"
        aria-label="Select whole texts"
        aria-describedby={hiddenTitles ? 'trend-hidden-title-note' : undefined}
        style={{
          width: plotW,
          height: labelBands.reduce(
            (maximum, band) => Math.max(maximum, band.focusTop + band.focusHeight),
            0,
          ),
        }}
      >
        {labelBands.map((band) => {
          const doc = docs[band.d];
          const title = doc ? titleByDoc.get(doc) ?? doc : '';
          const disabled = !doc || (docTokenCount[band.d] ?? 0) <= 0;
          const bandWidth = Math.max(0, band.right - band.left);
          // A by-book label is left-aligned. Keep its touch target around the
          // rendered title rather than blocking vertical page scroll across
          // the row's full width. Combined labels use pan-y below.
          const targetWidth = trendView === 'series'
            ? bandWidth
            : band.titlePainted
              ? Math.min(bandWidth, Math.max(44, title.length * 7 + 12))
              : bandWidth;
          return (
            <button
              key={doc ?? band.d}
              type="button"
              ref={(element) => {
                if (element) titleControlRefs.current.set(band.d, element);
                else titleControlRefs.current.delete(band.d);
              }}
              className="trend-title-control"
              data-trend-title-control={band.d}
              data-title-painted={String(band.titlePainted)}
              disabled={disabled}
              tabIndex={!disabled && band.d === titleFocusOrdinal ? 0 : -1}
              aria-keyshortcuts={TREND_TITLE_ARIA_KEYS}
              aria-label={`Text ${band.d + 1} of ${docs.length}: ${title} — select whole text`}
              title={title}
              style={{
                left: band.left,
                top: band.focusTop,
                width: targetWidth,
                height: band.focusHeight,
                pointerEvents: band.titlePainted ? undefined : 'none',
                touchAction: trendView === 'series' ? 'pan-y' : 'none',
              }}
              onFocus={() => setTitleFocusOrdinal(band.d)}
              onKeyDown={(event) => {
                if (event.ctrlKey || event.metaKey || event.altKey) return;
                const move = event.key === 'Home'
                  ? 'first'
                  : event.key === 'End'
                    ? 'last'
                    : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
                      ? 'previous'
                      : event.key === 'ArrowRight' || event.key === 'ArrowDown'
                        ? 'next'
                        : null;
                if (move === null) return;
                const enabled = docTokenCount.map((count) => count > 0);
                const next = nextTrendTitleFocus(band.d, move, enabled);
                if (next === null) return;
                event.preventDefault();
                event.stopPropagation();
                if (next !== band.d) {
                  setTitleFocusOrdinal(next);
                  titleControlRefs.current.get(next)?.focus();
                }
                if (event.shiftKey) {
                  if (next === band.d) return;
                  titleKeyboardAnchor.current ??= band.d;
                  onCommitRange(titleKeyboardAnchor.current, next);
                } else {
                  titleKeyboardAnchor.current = null;
                }
              }}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                // Direct pointers commit on pointerup. A zero-detail click is
                // keyboard or assistive-technology activation.
                if (event.detail === 0) {
                  titleKeyboardAnchor.current = null;
                  onCommitRange(band.d, band.d);
                }
              }}
              onDoubleClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
              onPointerDown={(event) => {
                if (!event.isPrimary || event.button !== 0 || disabled) return;
                onStart();
                titleKeyboardAnchor.current = null;
                setTitleFocusOrdinal(band.d);
                onClearPreview();
                const transition = trendTitleDown(
                  event.pointerId,
                  band.d,
                  event.clientX,
                  event.clientY,
                );
                gestureRef.current = transition.state;
                try {
                  event.currentTarget.setPointerCapture(event.pointerId);
                } catch {
                  // Synthetic PointerEvents do not create native capture state.
                }
                event.preventDefault();
                event.stopPropagation();
              }}
              onPointerMove={(event) => {
                const transition = trendTitleMove(gestureRef.current, {
                  pointerId: event.pointerId,
                  ordinal: targetAt(event.clientX, event.clientY),
                  clientX: event.clientX,
                  clientY: event.clientY,
                });
                gestureRef.current = transition.state;
                onEffect(transition.effect);
                if (transition.state.phase === 'pressed') {
                  event.preventDefault();
                  event.stopPropagation();
                }
              }}
              onPointerUp={(event) => {
                const moved = trendTitleMove(gestureRef.current, {
                  pointerId: event.pointerId,
                  ordinal: targetAt(event.clientX, event.clientY),
                  clientX: event.clientX,
                  clientY: event.clientY,
                });
                gestureRef.current = moved.state;
                onEffect(moved.effect);
                const transition = trendTitleUp(gestureRef.current, event.pointerId);
                gestureRef.current = transition.state;
                if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                  event.currentTarget.releasePointerCapture(event.pointerId);
                }
                onEffect(transition.effect);
                if (transition.effect.kind !== 'none') {
                  event.preventDefault();
                  event.stopPropagation();
                }
              }}
              onPointerCancel={(event) => {
                if (
                  gestureRef.current.phase !== 'pressed'
                  || gestureRef.current.pointerId !== event.pointerId
                ) return;
                const transition = resetTrendTitleGesture(gestureRef.current);
                gestureRef.current = transition.state;
                onEffect(transition.effect);
                event.stopPropagation();
              }}
              onLostPointerCapture={(event) => {
                if (
                  gestureRef.current.phase !== 'pressed'
                  || gestureRef.current.pointerId !== event.pointerId
                ) return;
                const transition = resetTrendTitleGesture(gestureRef.current);
                gestureRef.current = transition.state;
                onEffect(transition.effect);
              }}
            />
          );
        })}
      </div>
  );
}
