/**
 * ArtifactStore — the injected storage seam (Phase 1 plan §b). The worker
 * engine is tested against the in-memory implementation; the IndexedDB
 * implementation arrives in the next milestone behind the same interface.
 * Everything stored is content-addressed and recomputable.
 */

import type { DocumentIndexV1 } from '@texttrends/core';

export interface ArtifactStore {
  getText(hash: string): Promise<string | undefined>;
  putText(hash: string, text: string): Promise<void>;
  getShard(textHash: string, recipeHash: string, segmenterProbe: string): Promise<DocumentIndexV1 | undefined>;
  putShard(textHash: string, recipeHash: string, segmenterProbe: string, shard: DocumentIndexV1): Promise<void>;
}

export class InMemoryArtifactStore implements ArtifactStore {
  private readonly texts = new Map<string, string>();
  private readonly shards = new Map<string, DocumentIndexV1>();

  getText(hash: string): Promise<string | undefined> {
    return Promise.resolve(this.texts.get(hash));
  }
  putText(hash: string, text: string): Promise<void> {
    this.texts.set(hash, text);
    return Promise.resolve();
  }
  getShard(textHash: string, recipeHash: string, probe: string): Promise<DocumentIndexV1 | undefined> {
    return Promise.resolve(this.shards.get(`${textHash}/${recipeHash}/${probe}`));
  }
  putShard(textHash: string, recipeHash: string, probe: string, shard: DocumentIndexV1): Promise<void> {
    this.shards.set(`${textHash}/${recipeHash}/${probe}`, shard);
    return Promise.resolve();
  }
}
