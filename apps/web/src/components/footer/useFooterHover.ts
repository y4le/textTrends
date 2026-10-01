import { useCallback, useEffect, useRef } from 'react';

type Position = { readonly doc: string; readonly token: number };
export const FOOTER_HOVER_DWELL_MS = 120;
/** Owns hover dwell and the coalesced pointer sample, including teardown. */
export function useFooterHover(onSample: (position: Position) => void) {
  const latest = useRef(onSample); latest.current = onSample;
  const sample = useRef<Position | null>(null);
  const frame = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ready = useRef(false);
  const cancelSample = useCallback(() => {
    sample.current = null;
    if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null; }
  }, []);
  const schedule = useCallback((position: Position) => {
    sample.current = position;
    frame.current ??= requestAnimationFrame(() => {
      frame.current = null;
      if (sample.current) latest.current(sample.current);
    });
  }, []);
  const clear = useCallback(() => {
    ready.current = false;
    if (timer.current !== null) { clearTimeout(timer.current); timer.current = null; }
    cancelSample();
  }, [cancelSample]);
  const enter = useCallback((position: Position | null) => {
    clear(); sample.current = position;
    timer.current = setTimeout(() => {
      timer.current = null; ready.current = true;
      if (sample.current) schedule(sample.current);
    }, FOOTER_HOVER_DWELL_MS);
  }, [clear, schedule]);
  useEffect(() => clear, [clear]);
  return { sample, ready, schedule, enter, clear, cancelSample };
}
