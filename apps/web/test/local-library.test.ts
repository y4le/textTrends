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
    const [saved] = await first.add([file('novel.txt', 'persistent prose')]);
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
    const [a, b] = await library.add([file('a.txt', 'a'), file('b.md', 'b')]);
    await library.delete(a!.id);
    expect((await library.list()).map((item) => item.id)).toEqual([b!.id]);
    await library.clear();
    expect(await library.list()).toEqual([]);
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
