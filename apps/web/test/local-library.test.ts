import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { openDB } from 'idb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_NOTEBOOK, hashSourceBytes, type WorkspaceV1 } from '@texttrends/core';
import {
  BrowserLocalLibrary,
  LOCAL_LIBRARY_DB_VERSION,
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

async function legacyDatabase(name: string) {
  const input = file('legacy.txt', 'legacy source bytes');
  const bytes = await input.arrayBuffer();
  const contentHash = await hashSourceBytes(new Uint8Array(bytes));
  const id = localFileIdentity('txt', contentHash);
  const record = { schema: 'texttrends/library-file/1', id, name: input.name, size: input.size,
    type: input.type, lastModified: input.lastModified, addedAt: 456, format: 'txt', contentHash, bytes };
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      const files = request.result.createObjectStore('files', { keyPath: 'id' });
      files.createIndex('addedAt', 'addedAt');
      files.put(record);
      files.put({ id: 'damaged', name: 'damaged.txt', bytes: new Uint8Array([9]).buffer });
      request.result.createObjectStore('workspace').put(workspace(id), 'current');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return { database, record, input };
}

describe('BrowserLocalLibrary', () => {
  it('upgrades v1 atomically while listing only metadata and preserving all source bytes', async () => {
    const name = `local-library-${crypto.randomUUID()}`;
    const legacy = await legacyDatabase(name);
    legacy.database.close();
    const library = new BrowserLocalLibrary(name);
    const inspection = await library.inspect();
    expect(inspection.items).toHaveLength(1);
    expect(inspection.damaged.map((item) => item.key)).toEqual(['damaged']);
    expect(await library.loadWorkspace()).toEqual({ kind: 'ready', workspace: workspace(legacy.record.id) });
    expect(new Uint8Array(await (await library.file(legacy.record.id)).arrayBuffer())).toEqual(new Uint8Array(legacy.record.bytes));
    const getAll = vi.spyOn(IDBObjectStore.prototype, 'getAll');
    try {
      await library.list();
      expect(getAll.mock.contexts.map((store) => store instanceof IDBObjectStore ? store.name : null)).toEqual(['files']);
    } finally { getAll.mockRestore(); }
    await library.close();
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = db.transaction(['files', 'bodies']);
    const records = await new Promise<object[]>((resolve) => { const read = tx.objectStore('files').getAll(); read.onsuccess = () => resolve(read.result); });
    expect(records.every((record) => !('bytes' in record))).toBe(true);
    const damaged = await new Promise<ArrayBuffer>((resolve) => { const read = db.transaction('bodies').objectStore('bodies').get('damaged'); read.onsuccess = () => resolve(read.result); });
    expect([...new Uint8Array(damaged)]).toEqual([9]);
    db.close();
  });

  it('reports a blocked upgrade and allows retry after the old connection closes', async () => {
    const name = `local-library-${crypto.randomUUID()}`;
    const legacy = await legacyDatabase(name);
    const library = new BrowserLocalLibrary(name);
    await expect(library.list()).rejects.toThrow(/Close other textTrends tabs/);
    legacy.database.close();
    expect(await library.list()).toHaveLength(1);
    await library.close();
  });

  it('rolls back a failed upgrade without removing the original inline bytes', async () => {
    const name = `local-library-${crypto.randomUUID()}`;
    const legacy = await legacyDatabase(name);
    legacy.database.close();
    const put = IDBObjectStore.prototype.put;
    const failBodies = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
      if (this.name === 'bodies') throw new DOMException('quota reached', 'QuotaExceededError');
      return put.apply(this, args);
    });
    const library = new BrowserLocalLibrary(name);
    try { await expect(library.list()).rejects.toThrow(/saved files are unchanged.*storage.*retry/); }
    finally { failBodies.mockRestore(); }
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    expect(db.objectStoreNames.contains('bodies')).toBe(false);
    const original = await new Promise<{ bytes: ArrayBuffer }>((resolve) => { const read = db.transaction('files').objectStore('files').get(legacy.record.id); read.onsuccess = () => resolve(read.result); });
    expect(new Uint8Array(original.bytes)).toEqual(new Uint8Array(legacy.record.bytes));
    db.close();
    expect(await library.list()).toHaveLength(1);
    await library.close();
  });

  it('reports a missing body and repairs it when the source is reimported', async () => {
    const name = `local-library-${crypto.randomUUID()}`;
    const library = new BrowserLocalLibrary(name);
    const input = file('repair.txt', 'repair body');
    const saved = (await library.add([input]))[0]!.item;
    await library.close();
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('bodies', 'readwrite'); tx.objectStore('bodies').delete(saved.id);
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
    });
    db.close();
    expect((await library.inspect()).damaged.map((item) => item.key)).toEqual([saved.id]);
    await expect(library.file(saved.id)).rejects.toThrow(/damaged/);
    await library.add([input]);
    expect(await library.list()).toEqual([expect.objectContaining({ id: saved.id })]);
    await library.close();
  });

  it('isolates damaged records by their actual key and repairs them on reimport', async () => {
    const name = `local-library-${crypto.randomUUID()}`;
    const library = new BrowserLocalLibrary(name);
    const healthyFile = file('healthy.txt', 'healthy text');
    const damagedFile = file('repair.txt', 'repairable text');
    const [healthy, damaged] = await library.add([healthyFile, damagedFile]);
    await library.close();
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction('files', 'readwrite');
      tx.objectStore('files').put({ id: damaged!.item.id });
      tx.objectStore('files').put({ id: 42 });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    database.close();
    expect(await library.list()).toEqual([healthy!.item]);
    expect((await library.inspect()).damaged.map((item) => item.key)).toEqual([42, damaged!.item.id]);
    await library.delete(42);
    expect((await library.add([damagedFile]))[0]!.added).toBe(true);
    expect((await library.inspect()).damaged).toEqual([]);
    expect(new TextDecoder().decode(await (await library.file(damaged!.item.id)).arrayBuffer())).toBe('repairable text');
    await library.close();
  });

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
      const request = indexedDB.open(name, LOCAL_LIBRARY_DB_VERSION);
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

  it('deletes a source without discarding an obsolete workspace record', async () => {
    const name = `local-library-${crypto.randomUUID()}`;
    const library = new BrowserLocalLibrary(name);
    const saved = (await library.add([file('novel.txt', 'recoverable bytes')]))[0]!.item;
    await library.close();

    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, LOCAL_LIBRARY_DB_VERSION);
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
    expect(await reopened.loadWorkspace()).toMatchObject({ kind: 'corrupt' });
    await reopened.close();
  });

  it.each(['delete', 'clear'] as const)('preserves damaged workspace intent through %s and later autosaves', async (action) => {
    const name = `local-library-${crypto.randomUUID()}`;
    const library = new BrowserLocalLibrary(name);
    const saved = (await library.add([file('novel.txt', 'saved source')]))[0]!.item;
    const database = await openDB(name, LOCAL_LIBRARY_DB_VERSION);
    const damaged = { ...workspace(saved.id), schema: 'future-workspace', recovery: 'authored intent' };
    await database.put('workspace', damaged, 'current');
    if (action === 'delete') await library.delete(saved.id);
    else await library.clear();
    expect(await database.get('workspace', 'current')).toEqual(damaged);

    const empty = { ...workspace(saved.id), corpus: { kind: 'library' as const, order: [], docs: [] } };
    await library.saveWorkspace(empty);
    await library.saveWorkspace(empty);
    expect(await library.loadWorkspace()).toEqual({ kind: 'ready', workspace: empty });
    expect(await library.quarantinedWorkspaceCount()).toBe(1);
    const records = await database.getAll('workspace');
    expect(records).toContainEqual({ value: damaged, savedAt: expect.any(Number), reason: expect.any(String) });
    database.close();
    await library.close();
  });

  it('does not replace damaged work when preserving its original record fails', async () => {
    const name = `local-library-${crypto.randomUUID()}`;
    const library = new BrowserLocalLibrary(name);
    await library.loadWorkspace();
    const database = await openDB(name, LOCAL_LIBRARY_DB_VERSION);
    const damaged = { schema: 'future', notebook: 'recoverable' };
    await database.put('workspace', damaged, 'current');
    const original = IDBObjectStore.prototype.put;
    const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      if (typeof key === 'string' && key.startsWith('damaged-workspace:')) {
        throw new DOMException('quota reached', 'QuotaExceededError');
      }
      return original.call(this, value, key);
    });
    try {
      await expect(library.saveWorkspace(workspace(`txt:${'a'.repeat(64)}`))).rejects.toThrow('quota reached');
      expect(await database.get('workspace', 'current')).toEqual(damaged);
    } finally {
      spy.mockRestore();
      database.close();
      await library.close();
    }
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
