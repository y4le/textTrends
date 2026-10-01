import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { openDB } from 'idb';
import { hashSourceBytes, INGEST_CAPS_V0 } from '@texttrends/core';
import { BrowserLocalLibrary } from '../src/lib/local-library.ts';
import { emptyLibraryWorkspace } from '../src/lib/workspace-state.ts';
import { applyBackupPreferences, captureBackupPreferences, parseBackupPreferences } from '../src/lib/workspace-backup-preferences.ts';
import { BACKUP_SCHEMA, BACKUP_MAX_FILE_BYTES, backupSourcePath, parseBackupManifest, readBackup, writeBackup, type BackupManifest } from '../src/lib/workspace-backup.ts';

beforeEach(() => { globalThis.indexedDB = new IDBFactory() as unknown as typeof indexedDB; });

async function fixture() {
  const library = new BrowserLocalLibrary(`backup-source-${crypto.randomUUID()}`);
  const texts = ['écho\r\n\ufeffhello hello\n', '<html><body><p>Saved for later</p></body></html>'];
  const inputs = texts.map((text, index) => {
    const bytes = strToU8(text);
    return { name: index === 0 ? 'écho.txt' : 'later.html', size: bytes.length, type: index === 0 ? 'text/plain' : 'text/html', lastModified: 123, arrayBuffer: async () => bytes.slice().buffer };
  });
  const sources = (await library.add(inputs)).map((saved) => saved.item);
  const base = emptyLibraryWorkspace();
  const manifest: BackupManifest = {
    schema: BACKUP_SCHEMA, createdAt: 123,
    workspace: {
      ...base,
      corpus: { kind: 'library', order: ['stable-doc'], docs: [{ doc: 'stable-doc', library: sources[0]!.id, meta: { title: 'My title', author: 'A. Writer', year: 1923, language: 'fr', tags: ['research'] } }] },
      views: { ...base.views, trend: { mode: 'by-book-scaled', bins: { mode: 'per-doc', count: 32 }, measure: { kind: 'count' } }, compare: { ...base.views.compare, documentA: 'stable-doc' } },
    },
    settings: { ...captureBackupPreferences({ local: null, session: null }), display: { theme: 'dark', density: 'compact' } },
    sources,
  };
  const bodies = new Map(await Promise.all(sources.map(async (source) => [source.id, new Uint8Array(await (await library.file(source.id)).arrayBuffer())] as const)));
  return { library, manifest, bodies, inputs };
}

function archive(manifest: unknown, entries: Record<string, Uint8Array> = {}) {
  return new Blob([zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest)), ...entries }, { level: 0 }) as Uint8Array<ArrayBuffer>]);
}

describe('workspace backup', () => {
  it('preserves exact original bytes, inactive library texts, IDs, metadata, and settings in a fresh library', async () => {
    const source = await fixture();
    const file = await writeBackup(source.manifest, async (id) => source.bodies.get(id)!.slice().buffer);
    const backup = await readBackup(file);
    expect(backup.manifest).toEqual(source.manifest);
    expect(backup.bodies).toEqual(source.bodies);
    const target = new BrowserLocalLibrary('fresh');
    await target.restoreBackup(backup);
    expect(await target.loadWorkspace()).toEqual({ kind: 'ready', workspace: source.manifest.workspace });
    expect(await target.list()).toEqual(await source.library.list());
    for (const item of await target.list()) {
      expect(await hashSourceBytes(new Uint8Array(await (await target.file(item.id)).arrayBuffer()))).toBe(item.contentHash);
    }
    expect(await target.pendingBackupSettings()).toEqual(source.manifest.settings);
    await target.finishBackupSettings();
    expect(await target.pendingBackupSettings()).toBeUndefined();
  });

  it('round-trips an empty workspace', async () => {
    const manifest: BackupManifest = { schema: BACKUP_SCHEMA, createdAt: 0, workspace: emptyLibraryWorkspace(), settings: captureBackupPreferences({ local: null, session: null }), sources: [] };
    expect((await readBackup(await writeBackup(manifest, async () => { throw new Error('no source'); }))).manifest).toEqual(manifest);
  });

  it('preserves a damaged current record before a backup replaces the workspace', async () => {
    const source = await fixture();
    const name = `backup-target-${crypto.randomUUID()}`;
    const target = new BrowserLocalLibrary(name);
    await target.loadWorkspace();
    const database = await openDB(name);
    const damaged = { schema: 'future-workspace', notebook: 'recoverable intent' };
    await database.put('workspace', damaged, 'current');
    await target.restoreBackup({ manifest: source.manifest, bodies: source.bodies });
    expect(await target.loadWorkspace()).toEqual({ kind: 'ready', workspace: source.manifest.workspace });
    expect(await target.quarantinedWorkspaceCount()).toBe(1);
    expect(await database.getAll('workspace')).toContainEqual({
      value: damaged, savedAt: expect.any(Number), reason: expect.any(String),
    });
    database.close();
    await target.close();
    await source.library.close();
  });

  it('round-trips a binary EPUB containing ZIP signatures across read chunks', async () => {
    const source = await fixture();
    const binary = new Uint8Array(600_000);
    for (const offset of [0, 262_142, 524_287]) binary.set([0x50, 0x4b, 0x07, 0x08, 0x50, 0x4b, 0x03, 0x04], offset);
    const bytes = zipSync({ mimetype: strToU8('application/epub+zip'), 'OPS/chapter.xhtml': strToU8('<html><body>Text</body></html>'), 'OPS/binary.dat': binary }, { level: 0 });
    const hash = await hashSourceBytes(bytes);
    const item = { ...source.manifest.sources[0]!, id: `epub:${hash}`, contentHash: hash, name: 'nested.epub', format: 'epub' as const, size: bytes.length };
    const manifest = { ...source.manifest, sources: [item], workspace: { ...source.manifest.workspace, corpus: { ...source.manifest.workspace.corpus, docs: source.manifest.workspace.corpus.docs.map((doc) => ({ ...doc, library: item.id })) } } };
    const restored = await readBackup(await writeBackup(manifest, async () => bytes.slice().buffer));
    expect(restored.bodies.get(item.id)).toEqual(bytes);
  });

  it('refuses incomplete sources on save and load without silently dropping a document', async () => {
    const source = await fixture();
    expect(() => parseBackupManifest({ ...source.manifest, sources: [] })).toThrow(/missing the source.*My title/);
    await expect(writeBackup(source.manifest, async () => new ArrayBuffer(0))).rejects.toThrow(/missing or damaged/);
    await expect(readBackup(archive(source.manifest))).rejects.toThrow(/missing or unexpected/);
    const entries = Object.fromEntries(source.manifest.sources.map((item) => [backupSourcePath(item), source.bodies.get(item.id)!]));
    entries[backupSourcePath(source.manifest.sources[0]!)] = new Uint8Array(source.manifest.sources[0]!.size);
    await expect(readBackup(archive(source.manifest, entries))).rejects.toThrow(/écho.txt.*damaged/);
  });

  it('rejects incompatible manifests, dangling comparisons, and hostile entry names', async () => {
    const { manifest } = await fixture();
    expect(() => parseBackupManifest({ ...manifest, schema: 'texttrends/workspace-backup/99' })).toThrow(/supported/);
    expect(() => parseBackupManifest({ ...manifest, workspace: { ...manifest.workspace, active: ['missing'] } })).toThrow(/refer to notebook/);
    expect(() => parseBackupManifest({ ...manifest, workspace: { ...manifest.workspace, views: { ...manifest.workspace.views, compare: { ...manifest.workspace.views.compare, documentA: 'missing' } } } })).toThrow(/comparison refers/);
    await expect(readBackup(archive(manifest, { '../outside': strToU8('bad') }))).rejects.toThrow(/unexpected archive/);
    await expect(readBackup(archive(manifest, { '__proto__': strToU8('bad'), extra: strToU8('bad') }))).rejects.toThrow(/unexpected archive/);
  });

  it('rejects truncated, compressed, oversized, and duplicate-entry archives', async () => {
    const { manifest, bodies } = await fixture();
    const valid = await writeBackup(manifest, async (id) => bodies.get(id)!.slice().buffer);
    await expect(readBackup(valid.slice(0, valid.size - 1))).rejects.toThrow(/incomplete|unsupported/);
    await expect(readBackup(new Blob([zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest)) }, { level: 6 }) as Uint8Array<ArrayBuffer>]))).rejects.toThrow(/uncompressed ZIP/);
    const oversized = { size: BACKUP_MAX_FILE_BYTES + 1, slice: vi.fn() } as unknown as Blob;
    await expect(readBackup(oversized)).rejects.toThrow(/file limit/);
    expect(oversized.slice).not.toHaveBeenCalled();
    expect(() => parseBackupManifest({ ...manifest, sources: [{ ...manifest.sources[0], size: INGEST_CAPS_V0.maxSourceBytesPerFile + 1 }] })).toThrow(/metadata/);
    // Replace a same-length second path with the first in local and central
    // headers; the streaming reader must reject the duplicate before commit.
    const bytes = new Uint8Array(await archive({ ...manifest, sources: [] }, { [`sources/txt/${'a'.repeat(64)}`]: new Uint8Array(), [`sources/txt/${'b'.repeat(64)}`]: new Uint8Array() }).arrayBuffer());
    const second = strToU8(`sources/txt/${'b'.repeat(64)}`);
    const first = strToU8(`sources/txt/${'a'.repeat(64)}`);
    for (let i = 0; i <= bytes.length - second.length; i++) {
      if (second.every((value, j) => bytes[i + j] === value)) bytes.set(first, i);
    }
    await expect(readBackup(new Blob([bytes]))).rejects.toThrow(/duplicate/);
  });

  it('keeps all database stores unchanged when a late restore write fails', async () => {
    const incoming = await fixture();
    const target = new BrowserLocalLibrary('rollback');
    await target.add([incoming.inputs[0]!]);
    await target.saveWorkspace(emptyLibraryWorkspace());
    const before = await target.list();
    const put = IDBObjectStore.prototype.put;
    const fail = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
      if (this.name === 'workspace' && args[1] === 'restore-epoch') throw new DOMException('quota reached', 'QuotaExceededError');
      return put.apply(this, args);
    });
    try { await expect(target.restoreBackup(incoming)).rejects.toThrow(/quota/); }
    finally { fail.mockRestore(); }
    expect(await target.list()).toEqual(before);
    expect(await target.loadWorkspace()).toEqual({ kind: 'ready', workspace: emptyLibraryWorkspace() });
    expect(await target.pendingBackupSettings()).toBeUndefined();
    await target.saveWorkspace(emptyLibraryWorkspace());
  });

  it('keeps unrelated library files and fences saves, deletions, and restores from old tabs', async () => {
    const incoming = await fixture();
    const first = new BrowserLocalLibrary('shared');
    const old = new BrowserLocalLibrary('shared');
    const bytes = strToU8('unrelated');
    const existing = (await first.add([{ name: 'unrelated.txt', size: bytes.length, arrayBuffer: async () => bytes.slice().buffer }]))[0]!.item;
    await old.loadWorkspace();
    await first.restoreBackup(incoming);
    expect((await first.list()).map((item) => item.id)).toContain(existing.id);
    await expect(old.saveWorkspace(emptyLibraryWorkspace())).rejects.toThrow(/replaced in another tab/);
    await expect(old.delete(existing.id)).rejects.toThrow(/replaced in another tab/);
    await expect(old.restoreBackup(incoming)).rejects.toThrow(/replaced in another tab/);
    expect((await first.loadWorkspace())).toEqual({ kind: 'ready', workspace: incoming.manifest.workspace });
  });

  it('cancels before commit and permits a subsequent attempt', async () => {
    const incoming = await fixture();
    const target = new BrowserLocalLibrary('cancel');
    const abort = new AbortController();
    abort.abort();
    await expect(target.restoreBackup(incoming, abort.signal)).rejects.toThrow();
    expect(await target.loadWorkspace()).toEqual({ kind: 'absent' });
    await target.restoreBackup(incoming);
    expect((await target.list()).length).toBe(2);
  });
});

describe('portable settings', () => {
  function storage() {
    const values = new Map<string, string>();
    return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } } as Storage;
  }
  it('validates the entire settings record before applying anything and never copies arbitrary storage keys', () => {
    const local = storage();
    const session = storage();
    local.setItem('texttrends/guide/1', 'retained-guide');
    local.setItem('foreign-app', 'retained-foreign');
    const settings = captureBackupPreferences({ local, session }, { display: { theme: 'dark', density: 'compact' } });
    expect(() => applyBackupPreferences({ ...settings, speed: { wpm: -1 } }, { local, session })).toThrow(/speed/);
    expect(local.getItem('texttrends/display/1')).toBeNull();
    applyBackupPreferences(settings, { local, session });
    expect(captureBackupPreferences({ local, session })).toEqual(settings);
    expect(local.getItem('texttrends/guide/1')).toBe('retained-guide');
    expect(local.getItem('foreign-app')).toBe('retained-foreign');
    expect(() => parseBackupPreferences({ ...settings, 'foreign-app': 'bad' })).toThrow(/invalid/);
  });
  it('reports storage failures and can replay after a partial settings write', () => {
    const local = storage();
    const session = storage();
    const settings = captureBackupPreferences({ local, session }, { display: { theme: 'dark', density: 'compact' } });
    const fail = vi.spyOn(session, 'removeItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(() => applyBackupPreferences(settings, { local, session })).toThrow(/blocked/);
    fail.mockRestore();
    applyBackupPreferences(settings, { local, session });
    expect(captureBackupPreferences({ local, session })).toEqual(settings);
  });
});
