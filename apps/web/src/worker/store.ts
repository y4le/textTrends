/**
 * ArtifactStore — the injected storage seam (Phase 1 plan §b, M5 consult).
 * The worker engine is tested against the in-memory implementation; the
 * IndexedDB implementation lives behind the same interface. Everything stored
 * is content-addressed and recomputable.
 *
 * Boundary semantics (Codex M5 consult):
 * - Keys are STRUCTURED and carry the artifact schema — a future
 *   DocumentIndexV2 with identical input identities must occupy a different
 *   key, not silently overwrite a v1 record.
 * - Reads distinguish miss / hit / corrupt. A corrupt read is a storage-
 *   envelope failure the caller must be able to repair with an EXACT delete,
 *   or the same warning would recur on every reopen.
 * - getShard returns `unknown`: the store validates only its own envelope;
 *   the ENGINE is the authority for artifact ABI/semantic admission, and the
 *   type must not claim more trust than the boundary has earned.
 */

import type { DocumentIndexV1 } from '@texttrends/core';

/** Identity tuple for a cached document index. `segmenter` is the canonical
 *  hex hash of the fingerprint, never the fingerprint object. */
export interface DocumentIndexCacheKey {
  readonly schema: 'texttrends/document-index/1';
  readonly text: string;
  readonly recipe: string;
  readonly segmenter: string;
}

/** Identity of a cached extraction artifact (§12.1): source bytes under an
 *  extraction recipe → text + candidates + evidence. */
export interface ExtractionCacheKey {
  readonly schema: 'texttrends/extraction/1';
  readonly source: string;
  readonly recipe: string;
}

/** Identity of a cached structure artifact (§12.2): the four base identities
 *  that determine the section table (the no-override case is the hash of the
 *  canonical empty override — never a missing component). */
export interface StructureCacheKey {
  readonly schema: 'texttrends/structure/2';
  readonly text: string;
  readonly candidates: string;
  readonly recipe: string;
  readonly override: string;
}

export type CacheRead<T> =
  | { readonly kind: 'miss' }
  | { readonly kind: 'hit'; readonly value: T }
  | { readonly kind: 'corrupt'; readonly reason: string };

/**
 * Class-3 disposable artifact storage (content-addressed, recomputable).
 * getShard/getExtraction/getStructure return `unknown`: the store validates
 * only its own envelope; the ENGINE is the authority for artifact ABI.
 */
export interface ArtifactStore {
  getText(hash: string): Promise<CacheRead<string>>;
  putText(hash: string, text: string): Promise<void>;
  deleteText(hash: string): Promise<void>;

  getShard(key: DocumentIndexCacheKey): Promise<CacheRead<unknown>>;
  putShard(key: DocumentIndexCacheKey, shard: DocumentIndexV1): Promise<void>;
  deleteShard(key: DocumentIndexCacheKey): Promise<void>;

  getExtraction(key: ExtractionCacheKey): Promise<CacheRead<unknown>>;
  putExtraction(key: ExtractionCacheKey, artifact: unknown): Promise<void>;
  deleteExtraction(key: ExtractionCacheKey): Promise<void>;

  getStructure(key: StructureCacheKey): Promise<CacheRead<unknown>>;
  putStructure(key: StructureCacheKey, artifact: unknown): Promise<void>;
  deleteStructure(key: StructureCacheKey): Promise<void>;

  close(): void;
}

/** Canonical internal encodings of the structured keys — implementation
 *  details of THIS store, not second key specifications. */
const shardKey = (k: DocumentIndexCacheKey): string =>
  JSON.stringify([k.schema, k.text, k.recipe, k.segmenter]);
const extractionKey = (k: ExtractionCacheKey): string =>
  JSON.stringify([k.schema, k.source, k.recipe]);
const structureKey = (k: StructureCacheKey): string =>
  JSON.stringify([k.schema, k.text, k.candidates, k.recipe, k.override]);

export class InMemoryArtifactStore implements ArtifactStore {
  private readonly texts = new Map<string, string>();
  private readonly shards = new Map<string, DocumentIndexV1>();
  private readonly extractions = new Map<string, unknown>();
  private readonly structures = new Map<string, unknown>();

  private static read<T>(map: Map<string, T>, key: string): CacheRead<T> {
    const value = map.get(key);
    return value === undefined ? { kind: 'miss' } : { kind: 'hit', value };
  }

  getText(hash: string): Promise<CacheRead<string>> {
    return Promise.resolve(InMemoryArtifactStore.read(this.texts, hash));
  }
  putText(hash: string, text: string): Promise<void> {
    this.texts.set(hash, text);
    return Promise.resolve();
  }
  deleteText(hash: string): Promise<void> {
    this.texts.delete(hash);
    return Promise.resolve();
  }

  getShard(key: DocumentIndexCacheKey): Promise<CacheRead<unknown>> {
    return Promise.resolve(InMemoryArtifactStore.read(this.shards, shardKey(key)));
  }
  putShard(key: DocumentIndexCacheKey, shard: DocumentIndexV1): Promise<void> {
    this.shards.set(shardKey(key), shard);
    return Promise.resolve();
  }
  deleteShard(key: DocumentIndexCacheKey): Promise<void> {
    this.shards.delete(shardKey(key));
    return Promise.resolve();
  }

  getExtraction(key: ExtractionCacheKey): Promise<CacheRead<unknown>> {
    return Promise.resolve(InMemoryArtifactStore.read(this.extractions, extractionKey(key)));
  }
  putExtraction(key: ExtractionCacheKey, artifact: unknown): Promise<void> {
    this.extractions.set(extractionKey(key), artifact);
    return Promise.resolve();
  }
  deleteExtraction(key: ExtractionCacheKey): Promise<void> {
    this.extractions.delete(extractionKey(key));
    return Promise.resolve();
  }

  getStructure(key: StructureCacheKey): Promise<CacheRead<unknown>> {
    return Promise.resolve(InMemoryArtifactStore.read(this.structures, structureKey(key)));
  }
  putStructure(key: StructureCacheKey, artifact: unknown): Promise<void> {
    this.structures.set(structureKey(key), artifact);
    return Promise.resolve();
  }
  deleteStructure(key: StructureCacheKey): Promise<void> {
    this.structures.delete(structureKey(key));
    return Promise.resolve();
  }

  close(): void {
    // Nothing to release; memory is reclaimed with the worker.
  }
}
