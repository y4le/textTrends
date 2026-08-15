import { describe, expect, it } from 'vitest';
import {
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
      expect([null, 'inputs', 'trends', 'matches', 'vocabulary', 'compare'])
        .toContain(parseRoute(search).place);
    }
    expect(parseRoute('?p=trends&p=catalog&foreign=reader')).toEqual({ place: 'trends' });
    expect(parseRoute('?p=<script>&foreign=modal')).toEqual({ place: null });
    expect(parseRoute('?p=corpus')).toEqual({ place: null });
    expect(parseRoute('?p=catalog')).toEqual({ place: 'inputs' });
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
      { place: 'inputs' },
      { place: 'compare' },
    ];
    for (const route of routes) {
      const once = routeSearch('?foreign=%2F&p=bad', route);
      expect(routeSearch(once, route)).toBe(once);
      expect(parseRoute(once)).toEqual(route);
    }
    expect(routeSearch('', { place: null })).toBe('');
    expect(routeSearch('?foreign=sheet', { place: null })).toBe('?foreign=sheet');
  });

  it('cannot serialize hostile runtime values through owned keys', () => {
    const hostile = {
      place: 'Holmes & p=unknown',
    } as unknown as RouteV1;
    const search = routeSearch('?term=kept%20foreign', hostile);
    expect(search).toBe('?term=kept%20foreign');
    expect(search).not.toContain('Holmes');
    expect(search).not.toContain('secret');
  });
});
