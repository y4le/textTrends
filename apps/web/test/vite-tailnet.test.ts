import { describe, expect, it } from 'vitest';
import { restoreTailnetRequestUrl } from '../vite-tailnet';

describe('Tailnet Vite path restoration', () => {
  it.each([
    ['/', '/textTrends/'],
    ['/@vite/client', '/textTrends/@vite/client'],
    ['/@fs/home/yale/app.ts?direct', '/textTrends/@fs/home/yale/app.ts?direct'],
    ['/node_modules/.vite/deps/react.js?v=1', '/textTrends/node_modules/.vite/deps/react.js?v=1'],
    ['/textTrends', '/textTrends/'],
    ['/textTrends?open=1', '/textTrends/?open=1'],
    ['/textTrends/src/main.tsx?t=1', '/textTrends/src/main.tsx?t=1'],
    ['/textTrendsX', '/textTrends/textTrendsX'],
    ['?direct', '/textTrends/?direct'],
  ])('restores %s as %s', (requestUrl, expected) => {
    expect(restoreTailnetRequestUrl(requestUrl, '/textTrends')).toBe(expected);
  });

  it('is idempotent for already-restored requests', () => {
    const restored = '/textTrends/@vite/client?direct';
    expect(restoreTailnetRequestUrl(restored, '/textTrends')).toBe(restored);
    expect(restoreTailnetRequestUrl(
      restoreTailnetRequestUrl('/@vite/client?direct', '/textTrends'),
      '/textTrends',
    )).toBe(restored);
  });
});
