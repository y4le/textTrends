import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROUTE,
  parseRoute,
  routeSearch,
  type RouteV1,
} from '../src/lib/route.ts';

describe('parseRoute', () => {
  it('is total and admits only the route enumerations', () => {
    const hostile = [
      '',
      '?',
      '?p=',
      '?p=unknown&e=modal',
      '?p=%',
      '?p=trends&p=corpus&e=reader&e=sheet',
      '?p=<script>&e=reader%00&term=Holmes',
      'not even a query',
    ];
    for (const search of hostile) {
      expect(() => parseRoute(search)).not.toThrow();
      expect(['corpus', 'trends', 'concordance', 'vocabulary', 'compare', 'findings'])
        .toContain(parseRoute(search).place);
      expect(['none', 'sheet', 'reader']).toContain(parseRoute(search).evidence);
    }
    expect(parseRoute('?p=trends&p=corpus&e=reader&e=sheet')).toEqual({
      place: 'trends',
      evidence: 'reader',
    });
    expect(parseRoute('?p=<script>&e=modal')).toEqual(DEFAULT_ROUTE);
  });
});

describe('routeSearch', () => {
  it('preserves foreign segments byte-for-byte and in order', () => {
    expect(routeSearch(
      '?utm=a+b&x=%2f&p=corpus&x=two%20words&e=sheet&blank',
      { place: 'compare', evidence: 'reader' },
    )).toBe('?utm=a+b&x=%2f&x=two%20words&blank&p=compare&e=reader');
  });

  it('writes a stable minimal owned form and is idempotent', () => {
    const routes: readonly RouteV1[] = [
      { place: 'trends', evidence: 'none' },
      { place: 'corpus', evidence: 'sheet' },
      { place: 'findings', evidence: 'reader' },
    ];
    for (const route of routes) {
      const once = routeSearch('?foreign=%2F&p=bad&e=bad', route);
      expect(routeSearch(once, route)).toBe(once);
      expect(parseRoute(once)).toEqual(route);
    }
    expect(routeSearch('', DEFAULT_ROUTE)).toBe('?p=trends');
    expect(routeSearch('?e=sheet', DEFAULT_ROUTE)).toBe('?p=trends');
  });

  it('cannot serialize hostile runtime values through owned keys', () => {
    const hostile = {
      place: 'Holmes & p=findings',
      evidence: 'reader&note=secret',
    } as unknown as RouteV1;
    const search = routeSearch('?term=kept%20foreign', hostile);
    expect(search).toBe('?term=kept%20foreign&p=trends');
    expect(search).not.toContain('Holmes');
    expect(search).not.toContain('secret');
  });
});
