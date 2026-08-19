import {
  BUILTIN_ASOIF_ID,
  BUILTIN_LOTR_ID,
  BUILTIN_SHERLOCK_ID,
  type BuiltinCorpusId,
} from './project.ts';

export const DEMO_QUERY_PARAMETER = 'demo';

const DEMO_BY_SLUG: Readonly<Record<string, BuiltinCorpusId>> = Object.freeze({
  sherlock: BUILTIN_SHERLOCK_ID,
  asoif: BUILTIN_ASOIF_ID,
  lotr: BUILTIN_LOTR_ID,
});

export interface DemoBootRequest {
  readonly slug: string;
  readonly id: BuiltinCorpusId | null;
}

function decoded(value: string): string | null {
  try {
    return decodeURIComponent(value.replaceAll('+', ' '));
  } catch {
    return null;
  }
}

function querySegments(search: string): readonly string[] {
  const query = search.startsWith('?') ? search.slice(1) : search;
  return query === '' ? [] : query.split('&');
}

function segmentEntry(segment: string): { readonly key: string | null; readonly value: string | null } {
  const equals = segment.indexOf('=');
  const rawKey = equals < 0 ? segment : segment.slice(0, equals);
  const rawValue = equals < 0 ? '' : segment.slice(equals + 1);
  return { key: decoded(rawKey), value: decoded(rawValue) };
}

/** Parse the first owned demo parameter. The allowlist is deliberately closed:
 * no query value is ever turned into an asset path. */
export function parseDemoBootRequest(search: string): DemoBootRequest | null {
  for (const segment of querySegments(search)) {
    const entry = segmentEntry(segment);
    if (entry.key !== DEMO_QUERY_PARAMETER) continue;
    const slug = entry.value ?? '';
    return { slug, id: DEMO_BY_SLUG[slug.toLowerCase()] ?? null };
  }
  return null;
}

/** Consume every owned demo parameter before the ordinary route layer writes.
 * Foreign query bytes, the hash, and the current history state are preserved. */
export function consumeDemoBootRequest(target: Pick<Window, 'history' | 'location'>): DemoBootRequest | null {
  const request = parseDemoBootRequest(target.location.search);
  if (request === null) return null;
  const foreign = querySegments(target.location.search)
    .filter((segment) => segmentEntry(segment).key !== DEMO_QUERY_PARAMETER);
  const url = new URL(target.location.href);
  url.search = foreign.length === 0 ? '' : `?${foreign.join('&')}`;
  target.history.replaceState(target.history.state, '', url.href);
  return request;
}
