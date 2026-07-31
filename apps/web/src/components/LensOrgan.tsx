import type { MouseEvent } from 'react';
import { LENS_PLACES, PLACE_HEADING, type Place } from '../lib/places.ts';
import { routeSearch } from '../lib/route.ts';
import { useApp } from '../lib/store-instance.ts';
import { usePresentation } from './PresentationProvider.tsx';

function hrefFor(place: Place): string {
  if (typeof location === 'undefined') return `?p=${place}`;
  return `${routeSearch(location.search, { place, evidence: 'none' })}${location.hash}`;
}

export function LensOrgan() {
  const place = useApp((state) => state.place);
  const readerOpen = useApp((state) => state.readerPlace !== null);
  const setPlace = useApp((state) => state.setPlace);
  const presentation = usePresentation();

  // On compact screens the full-height Reader owns navigation and the lower
  // safe area. Leaving the fixed Lens bar mounted would cover prose and steal
  // taps from the drawer.
  if (readerOpen && presentation.width === 'compact') return null;

  return (
    <nav className="lens-organ" aria-label="Analysis lenses">
      {LENS_PLACES.map((lens) => (
        <a
          key={lens}
          href={hrefFor(lens)}
          aria-current={place === lens ? 'page' : undefined}
          onClick={(event: MouseEvent<HTMLAnchorElement>) => {
            if (
              event.button !== 0
              || event.metaKey
              || event.ctrlKey
              || event.shiftKey
              || event.altKey
            ) return;
            event.preventDefault();
            setPlace(lens);
          }}
        >
          {PLACE_HEADING[lens]}
        </a>
      ))}
    </nav>
  );
}
