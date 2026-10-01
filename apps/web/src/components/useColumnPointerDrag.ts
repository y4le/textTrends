import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';

export interface ColumnPointerDrag {
  readonly pointerId: number;
  readonly handle: HTMLDivElement;
  moved: boolean;
}

function capture(drag: ColumnPointerDrag, release: boolean): void {
  try {
    if (release) {
      if (drag.handle.hasPointerCapture(drag.pointerId)) drag.handle.releasePointerCapture(drag.pointerId);
    } else drag.handle.setPointerCapture(drag.pointerId);
  } catch { /* Synthetic events may not establish native capture. */ }
}

/** One pointer lifecycle for column previews. Geometry and preference policy
 * stay with each table. Latest callbacks prevent a query rerender from
 * cancelling an otherwise owned gesture. */
export function useColumnPointerDrag<D extends ColumnPointerDrag, C>(options: {
  readonly enabled: boolean;
  readonly create: (event: ReactPointerEvent<HTMLDivElement>, column: C) => D | null;
  readonly preview: (drag: D, event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly commit: (drag: D) => void;
  readonly restore: (drag: D) => void;
  readonly announce: (text: string) => void;
}) {
  const latest = useRef(options);
  latest.current = options;
  const dragRef = useRef<D | null>(null);
  const cancel = useCallback(() => {
    const drag = dragRef.current;
    if (drag === null) return false;
    dragRef.current = null;
    latest.current.restore(drag);
    capture(drag, true);
    return true;
  }, []);
  useEffect(() => () => { cancel(); }, [cancel]);
  useEffect(() => { if (!options.enabled) cancel(); }, [options.enabled, cancel]);

  const begin = (event: ReactPointerEvent<HTMLDivElement>, column: C) => {
    if (!latest.current.enabled || !event.isPrimary || event.button !== 0) {
      if (dragRef.current && dragRef.current.pointerId !== event.pointerId && cancel()) latest.current.announce('Column resize cancelled');
      return;
    }
    // A new primary press implies a prior native end was missed (for example
    // after capture failed). Retire the preview before accepting a fresh drag.
    if (dragRef.current !== null) cancel();
    const drag = latest.current.create(event, column);
    if (drag === null) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus({ preventScroll: true });
    dragRef.current = drag;
    capture(drag, false);
  };
  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation();
    latest.current.preview(drag, event);
  };
  const end = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation();
    dragRef.current = null;
    capture(drag, true);
    if (drag.moved) latest.current.commit(drag);
  };
  const cancelEvent = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation();
    if (cancel()) latest.current.announce('Column resize cancelled');
  };
  return { dragRef, cancel, begin, move, end, cancelEvent };
}
