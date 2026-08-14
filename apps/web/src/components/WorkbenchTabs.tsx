import { useState, type MouseEvent } from 'react';
import { PLACE_HEADING, PLACES, type Place } from '../lib/places.ts';
import { routeSearch } from '../lib/route.ts';
import { useApp } from '../lib/store-instance.ts';
import { shortcutAria, shortcutMatches } from '../lib/shortcuts.ts';

function hrefFor(place: Place): string {
  if (typeof location === 'undefined') return `?p=${place}`;
  return `${routeSearch(location.search, { place })}${location.hash}`;
}

export function WorkbenchTabs() {
  const place = useApp((state) => state.place);
  const routeStatus = useApp((state) => state.routeStatus);
  const setPlace = useApp((state) => state.setPlace);
  const activeTextCount = useApp(
    (state) => state.projectSession?.project.data.order.length ?? 0,
  );
  const [keyboardStatus, setKeyboardStatus] = useState('');
  const visiblePlaces = PLACES.filter(
    (tab) => tab !== 'compare' || activeTextCount > 1,
  );

  return (
    <nav
      className="lens-organ"
      aria-label="Workbench sections"
      onKeyDown={(event) => {
        const direction = shortcutMatches(event, 'focus-horizontal-previous')
          ? -1
          : shortcutMatches(event, 'focus-horizontal-next')
            ? 1
            : null;
        if (direction === null) return;
        const links = [...event.currentTarget.querySelectorAll<HTMLAnchorElement>('[data-workbench-tab]')];
        const current = links.indexOf((event.target as Element).closest<HTMLAnchorElement>('[data-workbench-tab]')!);
        if (current < 0 || links.length === 0) return;
        event.preventDefault();
        const next = Math.max(0, Math.min(links.length - 1, current + direction));
        const link = links[next]!;
        link.focus({ preventScroll: true });
        setKeyboardStatus(
          next === current
            ? `${direction === 1 ? 'last' : 'first'} workbench section · ${link.textContent ?? ''}`
            : `${link.textContent ?? ''} · workbench section ${next + 1} of ${links.length}`,
        );
      }}
    >
      {visiblePlaces.map((tab) => (
        <a
          key={tab}
          data-workbench-tab={tab}
          href={hrefFor(tab)}
          aria-current={routeStatus === 'resolved' && place === tab ? 'page' : undefined}
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
            setPlace(tab);
          }}
        >
          {PLACE_HEADING[tab]}
        </a>
      ))}
      <span className="visually-hidden" role="status" aria-live="polite">
        {keyboardStatus}
      </span>
    </nav>
  );
}
