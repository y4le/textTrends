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
  ANY_COARSE_POINTER_QUERY,
  COARSE_POINTER_QUERY,
  COMPACT_QUERY,
  DARK_SCHEME_QUERY,
  REDUCED_MOTION_QUERY,
  WIDE_QUERY,
  type Presentation,
} from '../lib/presentation.ts';
import { keyboardInsetFor } from '../lib/viewport-metrics.ts';
import {
  getDisplayPreference,
  getServerDisplayPreference,
  subscribeDisplayPreference,
} from '../lib/display-store.ts';
import type { DisplayPreference } from '../lib/display-preference.ts';

const DEFAULT_PRESENTATION: Presentation = {
  width: 'wide',
  coarseAvailable: false,
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
 * snapshots referentially stable. Width, input, and motion remain separate
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
  const primaryCoarse = useMediaQuery(COARSE_POINTER_QUERY, false);
  const anyCoarse = useMediaQuery(ANY_COARSE_POINTER_QUERY, false);
  const reducedMotion = useMediaQuery(REDUCED_MOTION_QUERY, false);
  const darkScheme = useMediaQuery(DARK_SCHEME_QUERY, true);
  const displayPreference = useDisplayPreference();

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
    coarseAvailable: primaryCoarse || anyCoarse,
    reducedMotion,
    colorScheme: displayPreference.theme === 'system'
      ? darkScheme ? 'dark' : 'light'
      : displayPreference.theme,
  }), [
    anyCoarse,
    compact,
    darkScheme,
    displayPreference.theme,
    primaryCoarse,
    reducedMotion,
    wide,
  ]);

  return (
    <PresentationContext.Provider value={presentation}>
      {children}
    </PresentationContext.Provider>
  );
}

export function usePresentation(): Presentation {
  return useContext(PresentationContext);
}

export function useDisplayPreference(): DisplayPreference {
  return useSyncExternalStore(
    subscribeDisplayPreference,
    getDisplayPreference,
    getServerDisplayPreference,
  );
}
