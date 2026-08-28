import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { fetchDemoCorpus } from '../src/lib/demo-corpora.ts';
import {
  BUILTIN_QURAN_ID,
  BUILTIN_SHERLOCK_ID,
  demoCorpusFixtures,
  FEATURED_DEMO_IDS,
} from '../src/lib/project.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function serveCorpusBytes(transform?: (bytes: Uint8Array) => Uint8Array): void {
  globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'https://example.test');
    const relative = decodeURIComponent(url.pathname.split('/corpora/')[1]!);
    const path = fileURLToPath(new URL(`../public/corpora/${relative}`, import.meta.url));
    const source = new Uint8Array(await readFile(path));
    const bytes = transform?.(source) ?? source;
    return new Response(new Uint8Array(bytes).buffer, { status: 200 });
  }) as typeof fetch;
}

describe('fetchDemoCorpus', () => {
  it.each(FEATURED_DEMO_IDS)('fetches and verifies every %s text against its checked-in manifest', async (id) => {
    serveCorpusBytes();
    const fixtures = demoCorpusFixtures(id);
    const demo = await fetchDemoCorpus(id);

    expect(demo.files).toHaveLength(fixtures.length);
    expect(demo.files.map((file) => file.name)).toEqual(fixtures.map((document) => `${document.title}.txt`));
    expect(demo.files.map((file) => file.size)).toEqual(fixtures.map((document) => document.bytes));
    expect(await demo.files[0]!.arrayBuffer()).not.toBe(await demo.files[0]!.arrayBuffer());
  });

  it('keeps real commas literal in Quran asset requests', async () => {
    serveCorpusBytes();
    await fetchDemoCorpus(BUILTIN_QURAN_ID);

    const requested = vi.mocked(globalThis.fetch).mock.calls.map(([input]) => String(input));
    expect(requested.some((url) => url.includes(','))).toBe(true);
    expect(requested.every((url) => !url.includes('%2C'))).toBe(true);
  });

  it('rejects a damaged response before returning a partial acquisition', async () => {
    serveCorpusBytes((bytes) => bytes.slice(0, -1));
    await expect(fetchDemoCorpus(BUILTIN_SHERLOCK_ID)).rejects.toThrow(/wrong size/);
  });

  it('rejects a same-length substitution by content hash', async () => {
    serveCorpusBytes((bytes) => {
      const changed = bytes.slice();
      changed[0] = changed[0]! ^ 1;
      return changed;
    });
    await expect(fetchDemoCorpus(BUILTIN_SHERLOCK_ID)).rejects.toThrow(/wrong content/);
  });

  it('forwards caller cancellation to every in-flight fetch', async () => {
    const observed: AbortSignal[] = [];
    globalThis.fetch = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal;
      if (!signal) throw new Error('demo fetch must carry an abort signal');
      observed.push(signal);
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }) as typeof fetch;
    const controller = new AbortController();
    const loading = fetchDemoCorpus(BUILTIN_SHERLOCK_ID, controller.signal);
    controller.abort(new DOMException('test cancellation', 'AbortError'));
    await expect(loading).rejects.toThrow(/test cancellation/);
    expect(observed).toHaveLength(demoCorpusFixtures(BUILTIN_SHERLOCK_ID).length);
    expect(observed.every((signal) => signal.aborted)).toBe(true);
  });
});
