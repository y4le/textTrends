import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_NOTEBOOK, type WorkspaceV1 } from '@texttrends/core';
import {
  BrowserLocalLibrary,
  localFileIdentity,
} from '../src/lib/local-library.ts';

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
    views: {
      trend: {
        mode: 'series',
        bins: { mode: 'per-doc', count: 40 },
        measure: { kind: 'rate', denominator: 10_000, smoothing: 0, showRaw: true },
      },
      frequency: {
        minCount: 1,
        minDocFreq: 1,
        classes: ['lexical'],
        stoplistTopN: 0,
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
        stoplistTopN: 0,
        sort: { by: 'logRatio', dirA: -1, dirB: 1 },
        showConfidenceIntervals: false,
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
    expect(await reopened.loadWorkspace()).toEqual({ kind: 'ready', workspace: expected });
    expect(new TextDecoder().decode(await (await reopened.file(saved.id)).arrayBuffer())).toBe('workspace prose');
    await reopened.close();
  });

  it('distinguishes an absent workspace from a damaged one', async () => {
    const name = `local-library-${crypto.randomUUID()}`;
    const library = new BrowserLocalLibrary(name);
    expect(await library.loadWorkspace()).toEqual({ kind: 'absent' });
    await library.close();

    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction('workspace', 'readwrite');
      tx.objectStore('workspace').put({ schema: 'damaged' }, 'current');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    database.close();

    const reopened = new BrowserLocalLibrary(name);
    expect(await reopened.loadWorkspace()).toMatchObject({
      kind: 'corrupt',
      reason: expect.stringMatching(/workspace|schema/),
    });
    await reopened.close();
  });

  it('atomically removes every active document backed by a deleted file', async () => {
    const library = new BrowserLocalLibrary(`local-library-${crypto.randomUUID()}`);
    const saved = (await library.add([file('novel.txt', 'shared source')]))[0]!.item;
    const active = workspace(saved.id);
    if (active.corpus.kind !== 'library') throw new Error('fixture must be library-backed');
    await library.saveWorkspace({
      ...active,
      corpus: {
        kind: 'library',
        order: ['doc-1', 'doc-2'],
        docs: [
          active.corpus.docs[0]!,
          {
            ...active.corpus.docs[0]!,
            doc: 'doc-2',
            meta: { ...active.corpus.docs[0]!.meta, title: 'Second reading' },
          },
        ],
      },
      views: {
        ...active.views,
        compare: { ...active.views.compare, documentB: 'doc-2' },
      },
    });

    expect(await library.delete(saved.id)).toEqual({
      removedDocuments: ['doc-1', 'doc-2'],
    });
    expect(await library.list()).toEqual([]);
    const loaded = await library.loadWorkspace();
    expect(loaded.kind).toBe('ready');
    if (loaded.kind !== 'ready' || loaded.workspace.corpus.kind !== 'library') {
      throw new Error('workspace should remain library-backed');
    }
    expect(loaded.workspace.corpus).toEqual({ kind: 'library', order: [], docs: [] });
    expect(loaded.workspace.views.compare.documentA).toBeNull();
    expect(loaded.workspace.views.compare.documentB).toBeNull();
    await library.close();
  });

  it('clears every active library document together with the catalog', async () => {
    const library = new BrowserLocalLibrary(`local-library-${crypto.randomUUID()}`);
    const [first, second] = await library.add([
      file('first.txt', 'first'),
      file('second.txt', 'second'),
    ]);
    const active = workspace(first!.item.id);
    if (active.corpus.kind !== 'library') throw new Error('fixture must be library-backed');
    await library.saveWorkspace({
      ...active,
      corpus: {
        kind: 'library',
        order: ['doc-1', 'doc-2'],
        docs: [
          active.corpus.docs[0]!,
          { ...active.corpus.docs[0]!, doc: 'doc-2', library: second!.item.id },
        ],
      },
    });

    expect(await library.clear()).toEqual({
      removedDocuments: ['doc-1', 'doc-2'],
    });
    const loaded = await library.loadWorkspace();
    expect(loaded.kind === 'ready' ? loaded.workspace.corpus : null).toEqual({
      kind: 'library',
      order: [],
      docs: [],
    });
    expect(await library.list()).toEqual([]);
    await library.close();
  });

  it('deletes a source and resets an obsolete built-in workspace record', async () => {
    const name = `local-library-${crypto.randomUUID()}`;
    const library = new BrowserLocalLibrary(name);
    const saved = (await library.add([file('novel.txt', 'recoverable bytes')]))[0]!.item;
    await library.close();

    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction('workspace', 'readwrite');
      tx.objectStore('workspace').put({
        ...workspace(saved.id),
        corpus: { kind: 'builtin', id: 'builtin/sherlock' },
      }, 'current');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    database.close();

    const reopened = new BrowserLocalLibrary(name);
    expect(await reopened.delete(saved.id)).toEqual({ removedDocuments: [] });
    expect(await reopened.list()).toEqual([]);
    expect(await reopened.loadWorkspace()).toEqual({ kind: 'absent' });
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
