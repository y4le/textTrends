import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_NOTEBOOK, type WorkspaceV1 } from '@texttrends/core';
import { BrowserLocalLibrary, localFileIdentity } from '../src/lib/local-library.ts';

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory() as unknown as typeof indexedDB;
});

function file(name: string, text: string) {
  const bytes = new TextEncoder().encode(text);
  return {
    name,
    size: bytes.byteLength,
    type: 'text/plain',
    lastModified: 123,
    arrayBuffer: async () => bytes.slice().buffer,
  };
}

function workspace(library: string): WorkspaceV1 {
  return {
    schema: 'texttrends/workspace/1',
    corpus: {
      kind: 'library',
      order: ['doc-1'],
      docs: [{
        doc: 'doc-1',
        library,
        meta: { title: 'Novel', language: 'en', tags: [] },
      }],
    },
    notebook: EMPTY_NOTEBOOK,
    active: [],
    kwicEnabled: [],
    views: {
      trend: {
        mode: 'series',
        focusedDoc: 'doc-1',
        bins: { mode: 'per-doc', count: 40 },
        measure: { kind: 'rate', denominator: 10_000, smoothing: 0, showRaw: true },
      },
      frequency: {
        minCount: 1,
        minDocFreq: 1,
        classes: ['lexical'],
        sort: { by: 'count', dir: -1 },
        pageSize: 100,
      },
      compare: {
        mode: 'documents',
        documentA: 'doc-1',
        documentB: null,
        restOn: 'b',
        minCountTotal: 1,
        minDocFreqTotal: 1,
        classes: ['lexical'],
        sort: { by: 'logRatio', dirA: -1, dirB: 1 },
        pageSize: 100,
      },
    },
  };
}

describe('BrowserLocalLibrary', () => {
  it('persists reusable file bytes and metadata across library instances', async () => {
    const name = `local-library-${crypto.randomUUID()}`;
    const first = new BrowserLocalLibrary(name);
    const saved = (await first.add([file('novel.txt', 'persistent prose')]))[0]!.item;
    await first.close();

    const reopened = new BrowserLocalLibrary(name);
    expect(await reopened.list()).toEqual([saved]);
    const loaded = await reopened.file(saved!.id);
    expect(loaded.name).toBe('novel.txt');
    expect(new TextDecoder().decode(await loaded.arrayBuffer())).toBe('persistent prose');
    await reopened.close();
  });

  it('deletes one item or clears the whole local library', async () => {
    const library = new BrowserLocalLibrary(`local-library-${crypto.randomUUID()}`);
    const added = await library.add([file('a.txt', 'a'), file('b.md', 'b')]);
    const a = added[0]!.item;
    const b = added[1]!.item;
    await library.delete(a!.id);
    expect((await library.list()).map((item) => item.id)).toEqual([b!.id]);
    await library.clear();
    expect(await library.list()).toEqual([]);
    await library.close();
  });

  it('deduplicates equal bytes within one format by their content hash', async () => {
    const library = new BrowserLocalLibrary(`local-library-${crypto.randomUUID()}`);
    const [first, duplicate] = await library.add([
      file('first.epub', 'same archive bytes'),
      file('second.epub', 'same archive bytes'),
    ]);
    expect(first!.added).toBe(true);
    expect(duplicate).toEqual({ item: first!.item, added: false });
    expect(await library.list()).toEqual([first!.item]);
    await library.close();
  });

  it('uses the format and source hash as the direct stable identity', async () => {
    const library = new BrowserLocalLibrary(`local-library-${crypto.randomUUID()}`);
    const saved = (await library.add([file('novel.txt', 'identity')]))[0]!.item;
    expect(saved.id).toBe(localFileIdentity('txt', saved.contentHash));
    expect(saved.id).not.toContain('source/');
    await library.close();
  });

  it('round-trips the current workspace independently of source bytes', async () => {
    const name = `local-library-${crypto.randomUUID()}`;
    const first = new BrowserLocalLibrary(name);
    const saved = (await first.add([file('novel.txt', 'workspace prose')]))[0]!.item;
    const expected = workspace(saved.id);
    await first.saveWorkspace(expected);
    await first.close();

    const reopened = new BrowserLocalLibrary(name);
    expect(await reopened.loadWorkspace()).toEqual(expected);
    expect(new TextDecoder().decode(await (await reopened.file(saved.id)).arrayBuffer())).toBe('workspace prose');
    await reopened.close();
  });

  it('rejects unsupported files before reading or storing any selection', async () => {
    const library = new BrowserLocalLibrary(`local-library-${crypto.randomUUID()}`);
    let reads = 0;
    await expect(library.add([{
      name: 'notes.pdf',
      size: 1,
      arrayBuffer: async () => {
        reads += 1;
        return new ArrayBuffer(1);
      },
    }])).rejects.toThrow(/unsupported file type/);
    expect(reads).toBe(0);
    expect(await library.list()).toEqual([]);
    await library.close();
  });
});
