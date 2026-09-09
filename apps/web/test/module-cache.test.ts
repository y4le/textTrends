import { expect, it, vi } from 'vitest';
import { createModuleCache } from '../src/lib/module-cache.ts';

it('deduplicates concurrent loads and exposes a synchronous warm value', async () => {
  let finish!: (value: string) => void;
  const loader = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
  const cache = createModuleCache({ place: loader });
  const first = cache.load('place');
  expect(cache.load('place')).toBe(first);
  expect(cache.resolved('place')).toBeUndefined();
  await Promise.resolve();
  finish('loaded');
  expect(await first).toBe('loaded');
  expect(cache.resolved('place')).toBe('loaded');
  expect(await cache.load('place')).toBe('loaded');
  expect(loader).toHaveBeenCalledTimes(1);
});

it('evicts asynchronous rejection and synchronous loader failure for a later retry', async () => {
  const loader = vi.fn<() => Promise<string>>()
    .mockRejectedValueOnce(new Error('network'))
    .mockImplementationOnce(() => { throw new Error('loader'); })
    .mockResolvedValue('recovered');
  const cache = createModuleCache({ place: loader });
  await expect(cache.load('place')).rejects.toThrow('network');
  expect(cache.resolved('place')).toBeUndefined();
  await expect(cache.load('place')).rejects.toThrow('loader');
  expect(await cache.load('place')).toBe('recovered');
});
