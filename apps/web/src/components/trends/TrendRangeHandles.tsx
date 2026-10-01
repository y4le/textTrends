import type { RefObject } from 'react';
import type { ScrubTarget } from '../../lib/app-state.ts';

export interface TrendRangeHandleDrag {
  readonly pointerId: number;
  readonly edge: 'start' | 'end';
  readonly fixed: ScrubTarget;
  head: ScrubTarget;
  moved: boolean;
}

/** Range endpoint controls own capture and DOM events; ScrubSurface retains
 * the shared selection transaction and coordinates competing stage gestures. */
export function TrendRangeHandles({ specs, plotWidth, endpoints, dragRef,
  targetAt, boundTarget, onStart, onPreview, onCommit, onCancel,
}: {
  readonly specs: readonly { edge: 'start' | 'end'; x: number; top: number; bottom: number }[];
  readonly plotWidth: number;
  readonly endpoints: { start: ScrubTarget; end: ScrubTarget } | null;
  readonly dragRef: RefObject<TrendRangeHandleDrag | null>;
  readonly targetAt: (x: number, y: number) => ScrubTarget | null;
  readonly boundTarget: (edge: 'start' | 'end', fixed: ScrubTarget, raw: ScrubTarget) => ScrubTarget;
  readonly onStart: () => void;
  readonly onPreview: (fixed: ScrubTarget, head: ScrubTarget) => void;
  readonly onCommit: (fixed: ScrubTarget, head: ScrubTarget) => void;
  readonly onCancel: () => void;
}) {
  return <>
        {specs.map((handle) => {
          const preferredLeft = handle.edge === 'start' ? handle.x - 40 : handle.x - 4;
          const left = Math.max(0, Math.min(plotWidth - 44, preferredLeft));
          const top = handle.edge === 'start'
            ? handle.top
            : Math.max(handle.top, handle.bottom - 44);
          const markerLeft = Math.max(2, Math.min(42, handle.x - left));
          return (
            <button
              key={handle.edge}
              type="button"
              className={`trend-range-handle trend-range-handle-${handle.edge}`}
              data-range-handle={handle.edge}
              aria-label={`Drag active scope ${handle.edge}`}
              style={{ left, top }}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
              onPointerDown={(event) => {
                if (!event.isPrimary || event.button !== 0 || !endpoints) return;
                onStart();
                const head = endpoints[handle.edge];
                dragRef.current = {
                  pointerId: event.pointerId,
                  edge: handle.edge,
                  fixed: endpoints[handle.edge === 'start' ? 'end' : 'start'],
                  head,
                  moved: false,
                };
                event.currentTarget.dataset.dragging = 'true';
                try {
                  event.currentTarget.setPointerCapture(event.pointerId);
                } catch {
                  // Synthetic pointer events used by accessibility and browser
                  // regression tests have no native pointer to capture.
                }
                event.preventDefault();
                event.stopPropagation();
              }}
              onPointerMove={(event) => {
                const drag = dragRef.current;
                if (!drag || drag.pointerId !== event.pointerId) return;
                const raw = targetAt(event.clientX, event.clientY);
                if (raw) {
                  const head = boundTarget(drag.edge, drag.fixed, raw);
                  drag.head = head;
                  drag.moved = drag.moved
                    || head.doc !== endpoints?.[drag.edge].doc
                    || head.token !== endpoints?.[drag.edge].token;
                  if (drag.moved) {
                    onPreview(drag.fixed, head);
                  }
                }
                event.preventDefault();
                event.stopPropagation();
              }}
              onPointerUp={(event) => {
                const drag = dragRef.current;
                if (!drag || drag.pointerId !== event.pointerId) return;
                dragRef.current = null;
                delete event.currentTarget.dataset.dragging;
                if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                  event.currentTarget.releasePointerCapture(event.pointerId);
                }
                if (drag.moved) {
                  onCommit(drag.fixed, drag.head);
                } else {
                  onCancel();
                }
                event.preventDefault();
                event.stopPropagation();
              }}
              onPointerCancel={(event) => {
                if (dragRef.current?.pointerId !== event.pointerId) return;
                dragRef.current = null;
                delete event.currentTarget.dataset.dragging;
                onCancel();
                event.stopPropagation();
              }}
              onLostPointerCapture={(event) => {
                if (dragRef.current?.pointerId !== event.pointerId) return;
                dragRef.current = null;
                delete event.currentTarget.dataset.dragging;
                onCancel();
              }}
            >
              <span
                className="trend-range-handle-mark"
                style={{ left: markerLeft }}
                aria-hidden="true"
              />
            </button>
          );
        })}
  </>;
}
