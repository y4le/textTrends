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
      '?p=unknown&foreign=modal',
      '?p=%',
      '?p=trends&p=catalog&foreign=reader',
      '?p=<script>&term=Holmes',
      'not even a query',
    ];
    for (const search of hostile) {
      expect(() => parseRoute(search)).not.toThrow();
      expect(['catalog', 'trends', 'concordance', 'vocabulary', 'compare'])
        .toContain(parseRoute(search).place);
    }
    expect(parseRoute('?p=trends&p=catalog&foreign=reader')).toEqual({ place: 'trends' });
    expect(parseRoute('?p=<script>&foreign=modal')).toEqual(DEFAULT_ROUTE);
    expect(parseRoute('?p=corpus')).toEqual(DEFAULT_ROUTE);
  });
});

describe('routeSearch', () => {
  it('preserves foreign segments byte-for-byte and in order', () => {
    expect(routeSearch(
      '?utm=a+b&x=%2f&p=catalog&x=two%20words&opaque=sheet&blank',
      { place: 'compare' },
    )).toBe('?utm=a+b&x=%2f&x=two%20words&opaque=sheet&blank&p=compare');
  });

  it('writes a stable minimal owned form and is idempotent', () => {
    const routes: readonly RouteV1[] = [
      { place: 'trends' },
      { place: 'catalog' },
      { place: 'compare' },
    ];
    for (const route of routes) {
      const once = routeSearch('?foreign=%2F&p=bad', route);
      expect(routeSearch(once, route)).toBe(once);
      expect(parseRoute(once)).toEqual(route);
    }
    expect(routeSearch('', DEFAULT_ROUTE)).toBe('?p=trends');
    expect(routeSearch('?foreign=sheet', DEFAULT_ROUTE)).toBe('?foreign=sheet&p=trends');
  });

  it('cannot serialize hostile runtime values through owned keys', () => {
    const hostile = {
      place: 'Holmes & p=unknown',
    } as unknown as RouteV1;
    const search = routeSearch('?term=kept%20foreign', hostile);
    expect(search).toBe('?term=kept%20foreign&p=trends');
    expect(search).not.toContain('Holmes');
    expect(search).not.toContain('secret');
  });
});
