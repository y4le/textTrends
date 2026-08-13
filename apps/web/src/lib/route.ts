import { PLACES, type Place } from './places.ts';

export interface RouteV1 {
  /** Null means the URL does not choose a place. The store resolves the
   * corpus-aware boot default only after the workspace is attached. */
  readonly place: Place | null;
}

const placeSet = new Set<string>(PLACES);

function decoded(part: string): string | null {
  try {
    return decodeURIComponent(part.replaceAll('+', ' '));
  } catch {
    return null;
  }
}

function segments(search: string): readonly string[] {
  const query = search.startsWith('?') ? search.slice(1) : search;
  return query === '' ? [] : query.split('&');
}

function entry(segment: string): { readonly key: string | null; readonly value: string | null } {
  const equals = segment.indexOf('=');
  const rawKey = equals < 0 ? segment : segment.slice(0, equals);
  const rawValue = equals < 0 ? '' : segment.slice(equals + 1);
  return {
    key: decoded(rawKey),
    value: decoded(rawValue),
  };
}

function isPlace(value: unknown): value is Place {
  return typeof value === 'string' && placeSet.has(value);
}

function parsedPlace(value: unknown): Place | null {
  if (value === 'catalog') return 'inputs'; // legacy shared links
  return isPlace(value) ? value : null;
}

/**
 * Total route parsing for hand-edited and stale links. Duplicate owned keys
 * follow URLSearchParams' first-value rule; malformed encodings and unknown
 * enum values leave the place unresolved for the corpus-aware boot policy.
 */
export function parseRoute(search: string): RouteV1 {
  let place: Place | null = null;
  let sawPlace = false;
  for (const segment of segments(search)) {
    const item = entry(segment);
    if (item.key === 'p' && !sawPlace) {
      sawPlace = true;
      place = parsedPlace(item.value);
    }
  }
  return { place };
}

/**
 * Replace only the route keys the app owns. Foreign query segments are copied
 * byte-for-byte and in their original order; owned keys are emitted once in a
 * stable canonical order.
 */
export function routeSearch(search: string, next: RouteV1): string {
  const place = isPlace(next.place) ? next.place : null;
  const foreign = segments(search).filter((segment) => {
    const key = entry(segment).key;
    return key !== 'p';
  });
  const canonical = place === null ? foreign : [...foreign, `p=${place}`];
  return canonical.length === 0 ? '' : `?${canonical.join('&')}`;
}
