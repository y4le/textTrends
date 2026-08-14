import { describe, expect, it, vi } from 'vitest';
import type { BuildGeneration, ProjectDocId } from '../src/contract/brands.ts';
import { DEFAULT_INDEX_RECIPE } from '../src/contract/recipes.ts';
import { createDocumentIndex, tokenEndChar } from '../src/index/build.ts';
import {
  inventory,
  inventoryTransferBuffers,
  INVENTORY_MAX_MATTR_WINDOW,
  INVENTORY_MAX_RHYTHM_BINS_PER_DOC,
  type InventoryDocumentInputV1,
  type InventoryRequestV1,
} from '../src/ops/inventory.ts';
import { documentTermCounts } from '../src/ops/term-counts.ts';
import { trend } from '../src/ops/trend.ts';
import { segment } from '../src/segment/intl.ts';
import { composeSnapshot, makeReadyDocument } from '../src/snapshot/compose.ts';
import { resolveSelection, type ResolvedSelection } from '../src/snapshot/selection.ts';

const GEN = 'inventory' as BuildGeneration;
const REQUEST: InventoryRequestV1 = {
  method: 'inventory/1',
  rhythmBinsPerDoc: 2,
  mattrWindow: 3,
};

async function fixture(
  texts: readonly [string, string][],
  expected = texts.map(([doc]) => doc),
) {
  const shards = new Map<string, Awaited<ReturnType<typeof createDocumentIndex>>>();
  const ready = new Map();
  for (const [doc, text] of texts) {
    const shard = await createDocumentIndex(
      text,
      await segment(text, 'en'),
      DEFAULT_INDEX_RECIPE,
    );
    shards.set(doc, shard);
    ready.set(
      doc as ProjectDocId,
      await makeReadyDocument(
        doc as ProjectDocId,
        shard,
      ),
    );
  }
  const snapshot = await composeSnapshot(
    GEN,
    expected.map((doc) => doc as ProjectDocId),
    ready,
  );
  return { snapshot, shards };
}

function inputsFor(
  world: Awaited<ReturnType<typeof fixture>>,
  selection: ResolvedSelection,
): InventoryDocumentInputV1[] {
  return selection.spec.docs.map((doc) => {
    const ref = world.snapshot.docs.find((candidate) => candidate.doc === doc)!;
    const shard = world.shards.get(doc)!;
    return {
      ref,
      shard,
      counts: documentTermCounts(
        world.snapshot,
        ref,
        shard,
        selection.rangesByDoc.get(doc) ?? null,
      ),
    };
  });
}

describe('inventory/1', () => {
  it('pins totals, start-token ownership with full unit lengths, and missing docs', async () => {
    const world = await fixture(
      [
        ['a', 'One two three. Four five.\n\nSix seven eight nine.'],
        ['b', 'Ten eleven. Twelve thirteen fourteen.'],
      ],
      ['a', 'b', 'missing'],
    );
    const selection = await resolveSelection(world.snapshot, {
      docs: ['a', 'b'] as ProjectDocId[],
      ranges: [
        {
          doc: 'a' as ProjectDocId,
          tokens: { start: 1 as never, end: 6 as never },
        },
      ],
    });
    const inputs = inputsFor(world, selection);
    const aShard = world.shards.get('a')!;
    const result = await inventory(
      world.snapshot,
      selection,
      inputs,
      REQUEST,
      async () => {},
    );

    expect(result.method).toBe('inventory/1');
    expect(result.selection).toBe(selection.hash);
    expect(result.order).toEqual(['a', 'b']);
    expect(result.missingDocs).toEqual(['missing']);
    expect(result.totals).toMatchObject({
      selectedDocs: 2,
      expectedDocs: 3,
      missingDocs: 1,
      tokens: 10,
      lexicalTokens: 10,
      numeralTokens: 0,
      sentences: 4,
      paragraphs: 2,
    });

    const a = result.documents[0]!;
    expect(a.selectedTokens).toBe(5);
    expect(a.fullTokens).toBe(9);
    // Sentence starts are 0,3,5. Range [1,6) owns starts 3 and 5, while
    // their FULL lengths remain 2 and 4.
    expect(a.sentences).toBe(2);
    expect(a.sentenceMean).toBe(3);
    expect(a.sentenceMedian).toBe(3);
    expect(a.sentenceP90).toBe(4);
    // Paragraph starts are 0 and 5; only the second is owned, full length 4.
    expect(a.paragraphs).toBe(1);
    expect(a.paragraphMean).toBe(4);
    expect(a.charsUtf16).toBe(
      tokenEndChar(aShard, 5) - (aShard.startsUtf16[1] as number),
    );
  });

  it('uses trend/1-identical equal-token geometry and selected denominators', async () => {
    const world = await fixture([
      ['a', 'one two three four five'],
      ['b', 'six seven eight'],
    ]);
    const selection = await resolveSelection(world.snapshot, {
      docs: ['a', 'b'] as ProjectDocId[],
      ranges: [{
        doc: 'a' as ProjectDocId,
        tokens: { start: 1 as never, end: 4 as never },
      }],
    });
    const result = await inventory(
      world.snapshot,
      selection,
      inputsFor(world, selection),
      { ...REQUEST, rhythmBinsPerDoc: 4 },
      async () => {},
    );
    const baseline = trend(
      world.snapshot,
      selection,
      {
        snapshot: world.snapshot.id,
        selection: selection.hash,
        docOrdinal: new Uint32Array(),
        pos: new Uint32Array(),
        spanTokens: new Uint32Array(),
        memberOffsets: Uint32Array.of(0),
        memberOrdinals: new Uint32Array(),
      },
      { coordinate: 'document-relative', bins: { mode: 'per-doc', count: 4 } },
    );
    expect([...result.rhythm!.docOrdinal]).toEqual([...baseline.docOrdinal]);
    expect([...result.rhythm!.binIndex]).toEqual([...baseline.binIndex]);
    expect([...result.rhythm!.binStartToken]).toEqual([...baseline.binStartToken]);
    expect([...result.rhythm!.binTokens]).toEqual([...baseline.binTokens]);
  });

  it('keeps trend/1 snapshot ordinals when a selection omits an earlier document', async () => {
    const world = await fixture([
      ['a', 'one two three'],
      ['b', 'four five six'],
    ]);
    const selection = await resolveSelection(world.snapshot, {
      docs: ['b'] as ProjectDocId[],
    });
    const result = await inventory(
      world.snapshot,
      selection,
      inputsFor(world, selection),
      { ...REQUEST, rhythmBinsPerDoc: 4 },
      async () => {},
    );
    const baseline = trend(
      world.snapshot,
      selection,
      {
        snapshot: world.snapshot.id,
        selection: selection.hash,
        docOrdinal: new Uint32Array(),
        pos: new Uint32Array(),
        spanTokens: new Uint32Array(),
        memberOffsets: Uint32Array.of(0),
        memberOrdinals: new Uint32Array(),
      },
      { coordinate: 'document-relative', bins: { mode: 'per-doc', count: 4 } },
    );
    expect([...result.rhythm!.docOrdinal]).toEqual([1, 1, 1, 1]);
    expect([...result.rhythm!.docOrdinal]).toEqual([...baseline.docOrdinal]);
  });

  it('computes MATTR independently per selected run and never bridges a gap', async () => {
    const world = await fixture([['a', 'a b a c c']]);
    const selection = await resolveSelection(world.snapshot, {
      docs: ['a'] as ProjectDocId[],
      ranges: [
        { doc: 'a' as ProjectDocId, tokens: { start: 0 as never, end: 2 as never } },
        { doc: 'a' as ProjectDocId, tokens: { start: 3 as never, end: 5 as never } },
      ],
    });
    const result = await inventory(
      world.snapshot,
      selection,
      inputsFor(world, selection),
      {
        method: 'inventory/1',
        rhythmBinsPerDoc: 0,
        mattrWindow: 3,
      },
      async () => {},
    );
    expect(result.rhythm).toBeNull();
    expect(result.documents[0]!.mattr).toBe(0.75); // (1×2 + 0.5×2) / 4
    expect(result.documents[0]!.mattrIsPlainTtr).toBe(true);
  });

  it('checkpoints, rejects every request cap, and transfers only fresh result buffers', async () => {
    const world = await fixture([['a', 'one two three four']]);
    const selection = await resolveSelection(world.snapshot, {
      docs: ['a'] as ProjectDocId[],
    });
    const inputs = inputsFor(world, selection);
    const checkpoint = vi.fn(async () => {});
    const result = await inventory(
      world.snapshot,
      selection,
      inputs,
      REQUEST,
      checkpoint,
    );
    expect(checkpoint).toHaveBeenCalled();
    const transfers = inventoryTransferBuffers(result);
    expect(transfers.length).toBeGreaterThan(0);
    expect(transfers).not.toContain(inputs[0]!.counts.typeIds.buffer);
    expect(transfers).not.toContain(inputs[0]!.counts.counts.buffer);

    const invalid = [
      { ...REQUEST, rhythmBinsPerDoc: INVENTORY_MAX_RHYTHM_BINS_PER_DOC + 1 },
      { ...REQUEST, rhythmBinsPerDoc: -1 },
      { ...REQUEST, mattrWindow: 0 },
      { ...REQUEST, mattrWindow: INVENTORY_MAX_MATTR_WINDOW + 1 },
    ];
    for (const request of invalid) {
      await expect(inventory(
        world.snapshot,
        selection,
        inputs,
        request,
        async () => {},
      )).rejects.toThrow(RangeError);
    }
  });
});
