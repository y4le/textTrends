import { describe, expect, it } from 'vitest';
import type {
  BuildGeneration,
  ProjectDocId,
  TextHash,
} from '../src/contract/brands.ts';
import { DEFAULT_INDEX_RECIPE } from '../src/contract/recipes.ts';
import type { IndexRecipeProvisional } from '../src/contract/recipes.ts';
import { createDocumentIndex } from '../src/index/build.ts';
import {
  anchorTokens,
  compileAnchors,
  COMPILE_ANCHOR_MAX_ITEMS,
} from '../src/ops/anchors.ts';
import { segment } from '../src/segment/intl.ts';
import { composeSnapshot, makeReadyDocument } from '../src/snapshot/compose.ts';
import { rootOnlyV2 } from './support/root-only-structure.ts';

const GEN = 'anchors' as BuildGeneration;

async function fixture(
  text = 'one  two three',
  recipe: IndexRecipeProvisional = DEFAULT_INDEX_RECIPE,
) {
  const doc = 'a' as ProjectDocId;
  const shard = await createDocumentIndex(
    text,
    await segment(text, 'en'),
    recipe,
  );
  const ready = await makeReadyDocument(doc, shard, rootOnlyV2(text, shard.text));
  const snapshot = await composeSnapshot(GEN, [doc], new Map([[doc, ready]]));
  return { doc, shard, snapshot, ref: snapshot.docs[0]! };
}

describe('durable character anchors', () => {
  it('round-trips a token range exactly through UTF-16 coordinates', async () => {
    const world = await fixture();
    const anchored = anchorTokens(
      world.snapshot,
      world.ref,
      world.shard,
      { start: 1, end: 3 },
    );
    expect(anchored.method).toBe('anchor-tokens/1');
    expect(anchored.anchor.chars).toEqual({ start: 5, end: 14 });
    const compiled = compileAnchors(
      world.snapshot,
      new Map([[world.doc, world.shard]]),
      [anchored.anchor],
    );
    expect(compiled.rows).toEqual([{
      status: 'ok',
      anchor: anchored.anchor,
      tokens: { start: 1, end: 3 },
    }]);
  });

  it('recompiles after a recipe-only change because TextHash is stable', async () => {
    const text = 'alpha 42';
    const dropNumerals: IndexRecipeProvisional = {
      ...DEFAULT_INDEX_RECIPE,
      numerals: {
        ...DEFAULT_INDEX_RECIPE.numerals,
        policy: 'drop',
      },
    };
    const first = await fixture(text);
    const second = await fixture(text, dropNumerals);
    const anchor = anchorTokens(
      first.snapshot,
      first.ref,
      first.shard,
      { start: 0, end: 2 },
    ).anchor;
    expect(first.shard.text).toBe(second.shard.text);
    expect(compileAnchors(
      second.snapshot,
      new Map([[second.doc, second.shard]]),
      [anchor],
    ).rows[0]).toMatchObject({
      status: 'ok',
      tokens: { start: 0, end: 1 },
    });
  });

  it('quarantines text mismatch and missing documents without guessing', async () => {
    const world = await fixture();
    const anchor = anchorTokens(
      world.snapshot,
      world.ref,
      world.shard,
      { start: 0, end: 1 },
    ).anchor;
    const mismatch = {
      ...anchor,
      text: 'f'.repeat(64) as TextHash,
    };
    const missing = { ...anchor, doc: 'missing' };
    const result = compileAnchors(
      world.snapshot,
      new Map([[world.doc, world.shard]]),
      [mismatch, missing],
    );
    expect(result.rows[0]).toMatchObject({
      status: 'text-mismatch',
      expected: mismatch.text,
      actual: world.shard.text,
    });
    expect(result.rows[1]).toMatchObject({ status: 'missing-doc' });
  });

  it('reports empty anchors and enforces the batch cap', async () => {
    const world = await fixture();
    const empty = {
      doc: world.doc,
      text: world.shard.text,
      chars: { start: 0, end: 0 },
    };
    expect(compileAnchors(
      world.snapshot,
      new Map([[world.doc, world.shard]]),
      [empty],
    ).rows[0]).toMatchObject({ status: 'empty' });
    expect(() => compileAnchors(
      world.snapshot,
      new Map([[world.doc, world.shard]]),
      Array.from({ length: COMPILE_ANCHOR_MAX_ITEMS + 1 }, () => empty),
    )).toThrow(/at most 64/);
  });
});
