import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import {
  COARSE_POINTER_QUERY,
  COMPACT_QUERY,
  DARK_SCHEME_QUERY,
  REDUCED_MOTION_QUERY,
  WIDE_QUERY,
  type Presentation,
} from '../lib/presentation.ts';
import { keyboardInsetFor } from '../lib/viewport-metrics.ts';

const DEFAULT_PRESENTATION: Presentation = {
  width: 'wide',
  pointer: 'fine',
  reducedMotion: false,
  colorScheme: 'dark',
};

const PresentationContext = createContext<Presentation>(DEFAULT_PRESENTATION);

function subscribeToQuery(query: string, onChange: () => void): () => void {
  const media = window.matchMedia(query);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

function queryMatches(query: string): boolean {
  return window.matchMedia(query).matches;
}

/**
 * One primitive snapshot per media feature keeps useSyncExternalStore's
 * snapshots referentially stable. Width, pointer, and motion remain separate
 * inputs: a wide coarse-pointer tablet is not collapsed into "mobile".
 */
function useMediaQuery(query: string, serverFallback: boolean): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => subscribeToQuery(query, onChange),
    [query],
  );
  const getSnapshot = useCallback(() => queryMatches(query), [query]);
  return useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => serverFallback,
  );
}

export function PresentationProvider({ children }: { readonly children: ReactNode }) {
  const compact = useMediaQuery(COMPACT_QUERY, false);
  const wide = useMediaQuery(WIDE_QUERY, true);
  const coarse = useMediaQuery(COARSE_POINTER_QUERY, false);
  const reducedMotion = useMediaQuery(REDUCED_MOTION_QUERY, false);
  const darkScheme = useMediaQuery(DARK_SCHEME_QUERY, true);

  useEffect(() => {
    const visual = window.visualViewport;
    if (!visual) return undefined;

    let frame: number | null = null;
    let lastInset = -1;
    const publish = () => {
      frame = null;
      const inset = keyboardInsetFor({
        innerHeight: window.innerHeight,
        visualHeight: visual.height,
        offsetTop: visual.offsetTop,
        scale: visual.scale,
      });
      if (inset === lastInset) return;
      lastInset = inset;
      document.documentElement.style.setProperty('--keyboard-inset', `${inset}px`);
    };
    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(publish);
    };

    visual.addEventListener('resize', schedule);
    visual.addEventListener('scroll', schedule);
    window.addEventListener('orientationchange', schedule);
    publish();
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      visual.removeEventListener('resize', schedule);
      visual.removeEventListener('scroll', schedule);
      window.removeEventListener('orientationchange', schedule);
      document.documentElement.style.removeProperty('--keyboard-inset');
    };
  }, []);

  const presentation = useMemo<Presentation>(() => ({
    width: compact ? 'compact' : wide ? 'wide' : 'regular',
    pointer: coarse ? 'coarse' : 'fine',
    reducedMotion,
    colorScheme: darkScheme ? 'dark' : 'light',
  }), [coarse, compact, darkScheme, reducedMotion, wide]);

  return (
    <PresentationContext.Provider value={presentation}>
      {children}
    </PresentationContext.Provider>
  );
}

export function usePresentation(): Presentation {
  return useContext(PresentationContext);
}
