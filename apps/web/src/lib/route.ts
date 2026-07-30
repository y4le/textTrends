import {
  DEFAULT_PLACE,
  PLACES,
  type Place,
} from './places.ts';

export const EVIDENCE_TIERS = ['none', 'sheet', 'reader'] as const;
export type EvidenceTier = (typeof EVIDENCE_TIERS)[number];

export interface RouteV1 {
  readonly place: Place;
  readonly evidence: EvidenceTier;
}

export const DEFAULT_ROUTE: RouteV1 = Object.freeze({
  place: DEFAULT_PLACE,
  evidence: 'none',
});

const placeSet = new Set<string>(PLACES);
const evidenceSet = new Set<string>(EVIDENCE_TIERS);

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

function isEvidenceTier(value: unknown): value is EvidenceTier {
  return typeof value === 'string' && evidenceSet.has(value);
}

/**
 * Total route parsing for hand-edited and stale links. Duplicate owned keys
 * follow URLSearchParams' first-value rule; malformed encodings and unknown
 * enum values quietly fall back to the canonical defaults.
 */
export function parseRoute(search: string): RouteV1 {
  let place: Place = DEFAULT_PLACE;
  let evidence: EvidenceTier = 'none';
  let sawPlace = false;
  let sawEvidence = false;
  for (const segment of segments(search)) {
    const item = entry(segment);
    if (item.key === 'p' && !sawPlace) {
      sawPlace = true;
      if (isPlace(item.value)) place = item.value;
    } else if (item.key === 'e' && !sawEvidence) {
      sawEvidence = true;
      if (isEvidenceTier(item.value)) evidence = item.value;
    }
  }
  return { place, evidence };
}

/**
 * Replace only the route keys the app owns. Foreign query segments are copied
 * byte-for-byte and in their original order; owned keys are emitted once in a
 * stable canonical order. `e=none` is represented by absence.
 */
export function routeSearch(search: string, next: RouteV1): string {
  const place = isPlace(next.place) ? next.place : DEFAULT_PLACE;
  const evidence = isEvidenceTier(next.evidence) ? next.evidence : 'none';
  const foreign = segments(search).filter((segment) => {
    const key = entry(segment).key;
    return key !== 'p' && key !== 'e';
  });
  const canonical = [...foreign, `p=${place}`];
  if (evidence !== 'none') canonical.push(`e=${evidence}`);
  return `?${canonical.join('&')}`;
}
