import { useEffect, useState } from 'react';
import { PLACE_HEADING, type Place } from '../lib/places.ts';
import { loadPlace, resolvedPlace } from './place-modules.ts';

export function PlaceLoading({ place }: { readonly place: Place }) {
  return <p style={{ color: 'var(--fg-muted)', fontSize: 'var(--text-sm)' }}>loading {PLACE_HEADING[place]}…</p>;
}

/** Keyed by place in App. Explicit module readiness keeps the external-store
 * navigation update off Suspense retry lanes, while warm visits render directly
 * from the module cache. Descendant Suspense and error boundaries stay in App. */
export function ActivePlace({ place }: { readonly place: Place }) {
  const [Component, setComponent] = useState(() => resolvedPlace(place));
  const [failure, setFailure] = useState<{ error: unknown } | null>(null);
  useEffect(() => {
    let live = true;
    void loadPlace(place).then(
      (loaded) => { if (live) setComponent(() => loaded); },
      (error: unknown) => { if (live) setFailure({ error }); },
    );
    return () => { live = false; };
  }, [place]);
  if (failure) throw failure.error;
  return Component ? <Component /> : <PlaceLoading place={place} />;
}
