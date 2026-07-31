import type { MouseEvent } from 'react';
import { LENS_PLACES, PLACE_HEADING, type Place } from '../lib/places.ts';
import { routeSearch } from '../lib/route.ts';
import { useApp } from '../lib/store-instance.ts';

function hrefFor(place: Place): string {
  if (typeof location === 'undefined') return `?p=${place}`;
  return `${routeSearch(location.search, { place, evidence: 'none' })}${location.hash}`;
}

export function LensOrgan() {
  const place = useApp((state) => state.place);
  const setPlace = useApp((state) => state.setPlace);

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
