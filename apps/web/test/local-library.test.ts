import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { BrowserLocalLibrary } from '../src/lib/local-library.ts';

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

  it('lazily hashes version-1 records and consolidates existing duplicates', async () => {
    const name = `local-library-${crypto.randomUUID()}`;
    const bytes = new TextEncoder().encode('legacy duplicate').buffer;
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore('files', { keyPath: 'id' });
        store.createIndex('addedAt', 'addedAt');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction('files', 'readwrite');
      const store = tx.objectStore('files');
      for (const [id, name, addedAt] of [['old-a', 'first.txt', 1], ['old-b', 'second.txt', 2]] as const) {
        store.put({
          schema: 'texttrends/local-file/1',
          id,
          name,
          size: bytes.byteLength,
          type: 'text/plain',
          lastModified: 0,
          addedAt,
          bytes: bytes.slice(0),
        });
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    database.close();

    const library = new BrowserLocalLibrary(name);
    const items = await library.list();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ name: 'first.txt', format: 'txt' });
    const duplicate = await library.add([file('third.txt', 'legacy duplicate')]);
    expect(duplicate).toEqual([{ item: items[0], added: false }]);
    await library.close();
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
