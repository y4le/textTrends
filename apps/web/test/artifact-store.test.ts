import { describe, expect, it } from 'vitest';
import { InMemoryArtifactStore, type DocumentIndexCacheKey } from '../src/worker/store.ts';
import type { DocumentIndexV1 } from '@texttrends/core';

const KEY: DocumentIndexCacheKey = {
  schema: 'texttrends/document-index/1',
  text: 't1',
  recipe: 'r1',
  segmenter: 's1',
};

// The store treats shards as opaque values; a sentinel object suffices.
const SHARD = { schema: 'texttrends/document-index/1' } as unknown as DocumentIndexV1;

describe('InMemoryArtifactStore contract semantics', () => {
  it('distinguishes miss from hit for texts and shards', async () => {
    const store = new InMemoryArtifactStore();
    expect(await store.getText('t1')).toEqual({ kind: 'miss' });
    await store.putText('t1', 'hello');
    expect(await store.getText('t1')).toEqual({ kind: 'hit', value: 'hello' });
    expect(await store.getShard(KEY)).toEqual({ kind: 'miss' });
    await store.putShard(KEY, SHARD);
    const read = await store.getShard(KEY);
    expect(read.kind).toBe('hit');
  });

  it('deletes exactly the addressed record', async () => {
    const store = new InMemoryArtifactStore();
    const other: DocumentIndexCacheKey = { ...KEY, text: 't2' };
    await store.putShard(KEY, SHARD);
    await store.putShard(other, SHARD);
    await store.deleteShard(KEY);
    expect((await store.getShard(KEY)).kind).toBe('miss');
    expect((await store.getShard(other)).kind).toBe('hit');
    await store.putText('a', 'x');
    await store.putText('b', 'y');
    await store.deleteText('a');
    expect((await store.getText('a')).kind).toBe('miss');
    expect((await store.getText('b')).kind).toBe('hit');
  });

  it('every key component discriminates — including the artifact schema', async () => {
    const store = new InMemoryArtifactStore();
    await store.putShard(KEY, SHARD);
    for (const variant of [
      { ...KEY, schema: 'texttrends/document-index/2' as never },
      { ...KEY, text: 'tX' },
      { ...KEY, recipe: 'rX' },
      { ...KEY, segmenter: 'sX' },
    ]) {
      expect((await store.getShard(variant)).kind, JSON.stringify(variant)).toBe('miss');
    }
  });
});
