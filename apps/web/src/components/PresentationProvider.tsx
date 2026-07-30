import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import {
  COARSE_POINTER_QUERY,
  COMPACT_QUERY,
  REDUCED_MOTION_QUERY,
  WIDE_QUERY,
  type Presentation,
} from '../lib/presentation.ts';

const DEFAULT_PRESENTATION: Presentation = {
  width: 'wide',
  pointer: 'fine',
  reducedMotion: false,
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

  const presentation = useMemo<Presentation>(() => ({
    width: compact ? 'compact' : wide ? 'wide' : 'regular',
    pointer: coarse ? 'coarse' : 'fine',
    reducedMotion,
  }), [coarse, compact, reducedMotion, wide]);

  return (
    <PresentationContext.Provider value={presentation}>
      {children}
    </PresentationContext.Provider>
  );
}

export function usePresentation(): Presentation {
  return useContext(PresentationContext);
}
