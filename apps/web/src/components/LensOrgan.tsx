import { useState, type MouseEvent } from 'react';
import { LENS_PLACES, PLACE_HEADING, type Place } from '../lib/places.ts';
import { routeSearch } from '../lib/route.ts';
import { useApp } from '../lib/store-instance.ts';
import { shortcutAria, shortcutMatches } from '../lib/shortcuts.ts';

function hrefFor(place: Place): string {
  if (typeof location === 'undefined') return `?p=${place}`;
  return `${routeSearch(location.search, { place })}${location.hash}`;
}

export function LensOrgan() {
  const place = useApp((state) => state.place);
  const setPlace = useApp((state) => state.setPlace);
  const [keyboardStatus, setKeyboardStatus] = useState('');

  return (
    <nav
      className="lens-organ"
      aria-label="Analysis lenses"
      onKeyDown={(event) => {
        const direction = shortcutMatches(event, 'focus-horizontal-previous')
          ? -1
          : shortcutMatches(event, 'focus-horizontal-next')
            ? 1
            : null;
        if (direction === null) return;
        const links = [...event.currentTarget.querySelectorAll<HTMLAnchorElement>('[data-lens]')];
        const current = links.indexOf((event.target as Element).closest<HTMLAnchorElement>('[data-lens]')!);
        if (current < 0 || links.length === 0) return;
        event.preventDefault();
        const next = Math.max(0, Math.min(links.length - 1, current + direction));
        const link = links[next]!;
        link.focus({ preventScroll: true });
        setKeyboardStatus(
          next === current
            ? `${direction === 1 ? 'last' : 'first'} analysis lens · ${link.textContent ?? ''}`
            : `${link.textContent ?? ''} · analysis lens ${next + 1} of ${links.length}`,
        );
      }}
    >
      {LENS_PLACES.map((lens) => (
        <a
          key={lens}
          data-lens={lens}
          href={hrefFor(lens)}
          aria-current={place === lens ? 'page' : undefined}
          aria-keyshortcuts={shortcutAria(['focus-horizontal-previous', 'focus-horizontal-next'])}
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
      <span className="visually-hidden" role="status" aria-live="polite">
        {keyboardStatus}
      </span>
    </nav>
  );
}
