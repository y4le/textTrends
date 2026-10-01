import { useCallback, useEffect, useRef, useState } from 'react';
export const FOOTER_SHUTTLE_ARIA_INTERVAL_MS = 1_000;
/** Owns the shuttle animation loop and its slower accessibility publication. */
export function useFooterShuttle<S>(scrub: S, rate: number | null, advance: (at: number) => boolean) {
  const latest = useRef(advance); latest.current = advance;
  const frame = useRef<number | null>(null);
  const ariaLatest = useRef(scrub);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const active = useRef(false);
  const [ariaScrub, setAriaScrub] = useState(scrub);
  const stop = useCallback(() => {
    if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null; }
  }, []);
  const start = useCallback(() => {
    if (frame.current !== null) return;
    const tick = (at: number) => {
      frame.current = null;
      if (latest.current(at)) frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
  }, []);
  useEffect(() => {
    ariaLatest.current = scrub;
    if (rate === null) {
      if (timer.current !== null) { clearTimeout(timer.current); timer.current = null; }
      if (active.current) setAriaScrub(scrub);
      active.current = false;
      return;
    }
    if (!active.current) setAriaScrub(scrub);
    active.current = true;
    timer.current ??= setTimeout(() => {
      timer.current = null; setAriaScrub(ariaLatest.current);
    }, FOOTER_SHUTTLE_ARIA_INTERVAL_MS);
  }, [scrub, rate]);
  useEffect(() => () => { stop(); if (timer.current !== null) clearTimeout(timer.current); timer.current = null; }, [stop]);
  return { ariaScrub, start, stop };
}
