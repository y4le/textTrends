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

export type CacheRead<T> =
  | { readonly kind: 'miss' }
  | { readonly kind: 'hit'; readonly value: T }
  | { readonly kind: 'corrupt'; readonly reason: string };

export interface ArtifactStore {
  getText(hash: string): Promise<CacheRead<string>>;
  putText(hash: string, text: string): Promise<void>;
  deleteText(hash: string): Promise<void>;

  getShard(key: DocumentIndexCacheKey): Promise<CacheRead<unknown>>;
  putShard(key: DocumentIndexCacheKey, shard: DocumentIndexV1): Promise<void>;
  deleteShard(key: DocumentIndexCacheKey): Promise<void>;

  close(): void;
}

/** Canonical internal encoding of the structured key — an implementation
 *  detail of THIS store, not a second key specification. */
const shardKey = (k: DocumentIndexCacheKey): string =>
  JSON.stringify([k.schema, k.text, k.recipe, k.segmenter]);

export class InMemoryArtifactStore implements ArtifactStore {
  private readonly texts = new Map<string, string>();
  private readonly shards = new Map<string, DocumentIndexV1>();

  getText(hash: string): Promise<CacheRead<string>> {
    const text = this.texts.get(hash);
    return Promise.resolve(text === undefined ? { kind: 'miss' } : { kind: 'hit', value: text });
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
    const shard = this.shards.get(shardKey(key));
    return Promise.resolve(shard === undefined ? { kind: 'miss' } : { kind: 'hit', value: shard });
  }
  putShard(key: DocumentIndexCacheKey, shard: DocumentIndexV1): Promise<void> {
    this.shards.set(shardKey(key), shard);
    return Promise.resolve();
  }
  deleteShard(key: DocumentIndexCacheKey): Promise<void> {
    this.shards.delete(shardKey(key));
    return Promise.resolve();
  }

  close(): void {
    // Nothing to release; memory is reclaimed with the worker.
  }
}
