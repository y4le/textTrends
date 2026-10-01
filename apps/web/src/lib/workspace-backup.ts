/** Portable v1 workspace container. ZIP32 with stored entries keeps source
 * bytes inspectable and bounds memory without a decompression trust boundary.
 * Worker artifacts are rebuilt; only source bytes and authored intent travel. */
import { exactRecord, hashSourceBytes, INGEST_CAPS_V0, isSourceFormat, parseWorkspace, type WorkspaceV1 } from '@texttrends/core';
import { Zip, ZipPassThrough } from 'fflate';
import type { LocalLibraryItem } from './local-library.ts';
import { parseBackupPreferences, type BackupPreferences } from './workspace-backup-preferences.ts';

export const BACKUP_SCHEMA = 'texttrends/workspace-backup/1' as const;
export const BACKUP_MAX_SOURCES = 1024;
export const BACKUP_MAX_SOURCE_BYTES = 256 * 1024 * 1024;
export const BACKUP_MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
export const BACKUP_MAX_FILE_BYTES = BACKUP_MAX_SOURCE_BYTES + BACKUP_MAX_MANIFEST_BYTES + 1024 * 1024;
const CHUNK_BYTES = 256 * 1024;
const HASH = /^[0-9a-f]{64}$/u;
const SOURCE_PATH = /^sources\/(txt|md|html|epub)\/[0-9a-f]{64}$/u;
const yieldTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export interface BackupManifest {
  readonly schema: typeof BACKUP_SCHEMA;
  readonly createdAt: number;
  readonly workspace: WorkspaceV1;
  readonly settings: BackupPreferences;
  readonly sources: readonly LocalLibraryItem[];
}
export interface PreparedBackup {
  readonly manifest: BackupManifest;
  readonly bodies: ReadonlyMap<string, Uint8Array<ArrayBuffer>>;
}
export type BackupProgress = (message: string) => void;
export const backupSourcePath = (item: LocalLibraryItem) => `sources/${item.format}/${item.contentHash}`;

export function parseBackupManifest(value: unknown): BackupManifest {
  if (!exactRecord(value, ['schema', 'createdAt', 'workspace', 'settings', 'sources']) || value.schema !== BACKUP_SCHEMA) {
    throw new Error('This is not a supported textTrends workspace backup (version 1).');
  }
  if (typeof value.createdAt !== 'number' || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0) throw new Error('The backup date is invalid.');
  if (!Array.isArray(value.sources) || value.sources.length > BACKUP_MAX_SOURCES) throw new Error(`A backup supports at most ${BACKUP_MAX_SOURCES} saved texts.`);
  const ids = new Set<string>();
  let total = 0;
  const sources = value.sources.map((source: unknown): LocalLibraryItem => {
    if (!exactRecord(source, ['id', 'name', 'size', 'type', 'lastModified', 'addedAt', 'format', 'contentHash'])
      || !isSourceFormat(source.format)
      || typeof source.contentHash !== 'string' || !HASH.test(source.contentHash)
      || source.id !== `${source.format}:${source.contentHash}`
      || typeof source.name !== 'string' || source.name.length === 0 || source.name.length > 4096
      || typeof source.type !== 'string' || source.type.length > 1024
      || typeof source.size !== 'number' || !Number.isSafeInteger(source.size) || source.size < 0 || source.size > INGEST_CAPS_V0.maxSourceBytesPerFile
      || typeof source.lastModified !== 'number' || !Number.isFinite(source.lastModified) || source.lastModified < 0
      || typeof source.addedAt !== 'number' || !Number.isFinite(source.addedAt) || source.addedAt < 0) {
      throw new Error('The backup contains invalid saved-text metadata.');
    }
    if (ids.has(source.id)) throw new Error('The backup contains duplicate saved texts.');
    ids.add(source.id);
    total += source.size;
    if (total > BACKUP_MAX_SOURCE_BYTES) throw new Error('The backup exceeds the 256 MiB source limit.');
    return { ...source } as unknown as LocalLibraryItem;
  });
  const workspace = parseWorkspace(value.workspace);
  if (workspace.corpus.docs.some((doc) => doc.warm !== undefined)) {
    throw new Error('Portable backups cannot contain disposable warm text hints.');
  }
  const byId = new Map(sources.map((source) => [source.id, source]));
  let activeBytes = 0;
  for (const doc of workspace.corpus.docs) {
    const source = byId.get(doc.library);
    if (source === undefined) throw new Error(`The backup is missing the source for “${doc.meta.title}”. Repair or remove the text before saving a complete backup.`);
    activeBytes += source.size;
  }
  if (activeBytes > INGEST_CAPS_V0.maxProjectSourceBytes) throw new Error('The active texts exceed the 128 MiB source limit.');
  const docIds = new Set(workspace.corpus.order);
  for (const id of [workspace.views.compare.documentA, workspace.views.compare.documentB]) {
    if (id !== null && !docIds.has(id)) throw new Error('The saved comparison refers to a text outside this workspace.');
  }
  return { schema: BACKUP_SCHEMA, createdAt: value.createdAt, workspace, settings: parseBackupPreferences(value.settings), sources };
}

export async function verifyBackupSources(backup: PreparedBackup, signal?: AbortSignal, progress?: BackupProgress): Promise<void> {
  if (backup.bodies.size !== backup.manifest.sources.length) throw new Error('The backup has missing or unexpected source files.');
  for (const [index, source] of backup.manifest.sources.entries()) {
    signal?.throwIfAborted();
    progress?.(`Checking text ${index + 1} of ${backup.manifest.sources.length}: ${source.name}`);
    const bytes = backup.bodies.get(source.id);
    if (bytes === undefined || bytes.byteLength !== source.size || await hashSourceBytes(bytes) !== source.contentHash) {
      throw new Error(`“${source.name}” is missing or damaged. No workspace was loaded.`);
    }
    await yieldTask();
  }
  signal?.throwIfAborted();
}

/** Hash while acquiring each body, then feed the ZIP in bounded, yielding
 * chunks. Blob parts avoid a second whole-archive concatenation. */
export async function writeBackup(
  input: BackupManifest,
  readSource: (id: string) => Promise<ArrayBuffer>,
  signal?: AbortSignal,
  progress?: BackupProgress,
): Promise<Blob> {
  const manifest = parseBackupManifest(input);
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  if (manifestBytes.length > BACKUP_MAX_MANIFEST_BYTES) throw new Error('The backup manifest exceeds 4 MiB.');
  const chunks: BlobPart[] = [];
  let failure: Error | null = null;
  const zip = new Zip((error, chunk) => {
    if (error) failure = error;
    else chunks.push(chunk as Uint8Array<ArrayBuffer>);
  });
  const append = async (name: string, bytes: Uint8Array) => {
    const entry = new ZipPassThrough(name);
    zip.add(entry);
    let offset = 0;
    do {
      signal?.throwIfAborted();
      const end = Math.min(offset + CHUNK_BYTES, bytes.length);
      entry.push(bytes.subarray(offset, end), end === bytes.length);
      if (failure) throw failure;
      await yieldTask();
      offset = end;
    } while (offset < bytes.length);
  };
  try {
    await append('manifest.json', manifestBytes);
    for (const [index, source] of manifest.sources.entries()) {
      signal?.throwIfAborted();
      progress?.(`Saving text ${index + 1} of ${manifest.sources.length}: ${source.name}`);
      const bytes = new Uint8Array(await readSource(source.id));
      if (bytes.length !== source.size || await hashSourceBytes(bytes) !== source.contentHash) {
        throw new Error(`“${source.name}” is missing or damaged. Reimport the original file before saving a complete backup.`);
      }
      await append(backupSourcePath(source), bytes);
    }
    signal?.throwIfAborted();
    zip.end();
    if (failure) throw failure;
    const blob = new Blob(chunks, { type: 'application/zip' });
    if (blob.size > BACKUP_MAX_FILE_BYTES) throw new Error('The workspace backup is too large.');
    return blob;
  } catch (error) {
    zip.terminate();
    throw error;
  }
}

export async function readBackup(file: Blob, signal?: AbortSignal, progress?: BackupProgress): Promise<PreparedBackup> {
  if (file.size < 22 || file.size > BACKUP_MAX_FILE_BYTES) throw new Error('The workspace file is empty or exceeds the 261 MiB file limit.');
  signal?.throwIfAborted();
  // Read the bounded central directory first. Scanning stored payload bytes
  // for local headers/data descriptors is ambiguous for nested ZIPs (EPUB).
  // This deliberately supports only the exact ZIP32 subset our writer emits.
  const footer = new DataView(await file.slice(-22).arrayBuffer());
  const count = footer.getUint16(10, true);
  const directorySize = footer.getUint32(12, true);
  const directoryStart = footer.getUint32(16, true);
  if (footer.getUint32(0, true) !== 0x06054b50 || footer.getUint32(4, true) !== 0
    || footer.getUint16(8, true) !== count || footer.getUint16(20, true) !== 0
    || directorySize + directoryStart !== file.size - 22 || directorySize > 256 * 1024
    || count < 1 || count > BACKUP_MAX_SOURCES + 1) {
    throw new Error('This workspace file is incomplete or uses an unsupported ZIP format.');
  }
  const directory = new Uint8Array(await file.slice(directoryStart, directoryStart + directorySize).arrayBuffer());
  const central = new DataView(directory.buffer);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const layout: { name: string; flags: number; crc: number; size: number; start: number }[] = [];
  const entries = new Map<string, Uint8Array<ArrayBuffer>>();
  const seen = new Set<string>();
  let total = 0;
  let position = 0;
  for (let index = 0; index < count; index++) {
    if (position + 46 > directory.length || central.getUint32(position, true) !== 0x02014b50) throw new Error('The backup directory is damaged.');
    const nameLength = central.getUint16(position + 28, true);
    const flags = central.getUint16(position + 8, true);
    const size = central.getUint32(position + 24, true);
    if (nameLength > 128 || position + 46 + nameLength > directory.length
      || central.getUint16(position + 30, true) !== 0 || central.getUint16(position + 32, true) !== 0
      || central.getUint16(position + 34, true) !== 0 || (flags & ~0x0808) !== 0) {
      throw new Error('The backup directory uses unsupported ZIP features.');
    }
    if (central.getUint16(position + 10, true) !== 0) throw new Error('Version 1 workspace backups require uncompressed ZIP entries.');
    if (central.getUint32(position + 20, true) !== size) throw new Error('The backup entry size is inconsistent.');
    const name = decoder.decode(directory.subarray(position + 46, position + 46 + nameLength));
    if (seen.has(name) || (name !== 'manifest.json' && !SOURCE_PATH.test(name))) {
      throw new Error('The backup contains duplicate or unexpected archive entries.');
    }
    seen.add(name);
    const limit = name === 'manifest.json' ? BACKUP_MAX_MANIFEST_BYTES : INGEST_CAPS_V0.maxSourceBytesPerFile;
    if (size > limit) throw new Error('An archive entry exceeds its size limit.');
    if (name !== 'manifest.json') total += size;
    if (total > BACKUP_MAX_SOURCE_BYTES) throw new Error('The backup exceeds its source size limit.');
    layout.push({ name, size, flags, crc: central.getUint32(position + 16, true), start: central.getUint32(position + 42, true) });
    position += 46 + nameLength;
  }
  if (position !== directory.length) throw new Error('The backup directory contains unexpected data.');
  let expectedStart = 0;
  for (const entry of layout) {
    signal?.throwIfAborted();
    // The name allowlist above is ASCII, so code units equal ZIP name bytes.
    const headerEnd = entry.start + 30 + entry.name.length;
    const bodyEnd = headerEnd + entry.size;
    const end = bodyEnd + ((entry.flags & 8) !== 0 ? 16 : 0);
    if (entry.start !== expectedStart || end > directoryStart) throw new Error('The backup contains overlapping or out-of-bounds entries.');
    const headerBytes = new Uint8Array(await file.slice(entry.start, headerEnd).arrayBuffer());
    const header = new DataView(headerBytes.buffer);
    if (header.getUint32(0, true) !== 0x04034b50 || header.getUint16(6, true) !== entry.flags
      || header.getUint16(8, true) !== 0 || header.getUint16(26, true) !== entry.name.length
      || header.getUint16(28, true) !== 0 || decoder.decode(headerBytes.subarray(30)) !== entry.name) {
      throw new Error('The backup entry header disagrees with its directory.');
    }
    if ((entry.flags & 8) !== 0) {
      const descriptor = new DataView(await file.slice(bodyEnd, end).arrayBuffer());
      if (descriptor.getUint32(0, true) !== 0x08074b50 || descriptor.getUint32(4, true) !== entry.crc
        || descriptor.getUint32(8, true) !== entry.size || descriptor.getUint32(12, true) !== entry.size) {
        throw new Error('The backup entry descriptor is damaged.');
      }
    } else if (header.getUint32(14, true) !== entry.crc || header.getUint32(18, true) !== entry.size || header.getUint32(22, true) !== entry.size) {
      throw new Error('The backup entry size or checksum is inconsistent.');
    }
    const bytes = new Uint8Array(entry.size);
    // Reuse fflate's incremental CRC implementation without emitting an archive.
    const checksum = new ZipPassThrough(entry.name);
    checksum.ondata = () => {};
    let offset = 0;
    do {
      signal?.throwIfAborted();
      const next = Math.min(offset + CHUNK_BYTES, entry.size);
      progress?.(`Reading workspace file: ${Math.round((headerEnd + next) / file.size * 100)}%`);
      const chunk = new Uint8Array(await file.slice(headerEnd + offset, headerEnd + next).arrayBuffer());
      if (chunk.length !== next - offset) throw new Error('The backup source is truncated.');
      bytes.set(chunk, offset);
      checksum.push(chunk, next === entry.size);
      offset = next;
      await yieldTask();
    } while (offset < entry.size);
    if ((checksum.crc >>> 0) !== entry.crc) throw new Error(`The backup entry “${entry.name}” is damaged (checksum mismatch).`);
    entries.set(entry.name, bytes);
    expectedStart = end;
  }
  if (expectedStart !== directoryStart) throw new Error('The backup contains unexpected data before its directory.');
  const manifestBytes = entries.get('manifest.json');
  if (!manifestBytes) throw new Error('The workspace manifest is missing.');
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)); }
  catch { throw new Error('The workspace manifest is damaged.'); }
  const manifest = parseBackupManifest(value);
  if (entries.size !== manifest.sources.length + 1) throw new Error('The backup has missing or unexpected source files.');
  const bodies = new Map<string, Uint8Array<ArrayBuffer>>();
  for (const source of manifest.sources) {
    const body = entries.get(backupSourcePath(source));
    if (!body) throw new Error(`The backup is missing “${source.name}”.`);
    bodies.set(source.id, body);
  }
  const backup = { manifest, bodies };
  await verifyBackupSources(backup, signal, progress);
  return backup;
}
