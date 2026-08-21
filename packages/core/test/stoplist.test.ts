import { describe, expect, it } from 'vitest';
import type { CorpusSnapshotId } from '../src/contract/brands.ts';
import { DEFAULT_INDEX_RECIPE } from '../src/contract/recipes.ts';
import { tokenKey } from '../src/index/build.ts';
import { foldKey } from '../src/resolve/fold.ts';
import type { CorpusSnapshotV1 } from '../src/snapshot/compose.ts';
import { STOPLIST_EN_WORDS } from '../src/ops/stoplist-en-data.ts';
import {
  buildStoplistRanks,
  validateStoplistRanks,
} from '../src/ops/stoplist.ts';
import { STOPLIST_MAX_TOP_N } from '../src/ops/stoplist-contract.ts';

const snapshot = (keys: readonly string[], id = 'snapshot') => ({
  id: id as CorpusSnapshotId,
  vocabulary: { keys },
}) as CorpusSnapshotV1;

describe('bundled common-word reference', () => {
  it('is complete, normalized, unique, and follows the locked ranking', () => {
    expect(STOPLIST_EN_WORDS).toHaveLength(STOPLIST_MAX_TOP_N);
    expect(STOPLIST_EN_WORDS.slice(0, 5)).toEqual(['the', 'a', 'and', 'to', 'i']);
    expect(new Set(STOPLIST_EN_WORDS).size).toBe(STOPLIST_MAX_TOP_N);
    for (const entry of STOPLIST_EN_WORDS) {
      expect(foldKey(tokenKey(entry, DEFAULT_INDEX_RECIPE), {
        case: 'folded',
        diacritics: 'sensitive',
      }, 'en')).toBe(entry);
    }
  });

  it('case-folds under English without folding diacritics', () => {
    const value = snapshot(['the', 'The', 'î', 'I', 'quokka']);
    const ranks = buildStoplistRanks(value);
    expect(ranks.ranks[0]).toBe(1);
    expect(ranks.ranks[1]).toBe(1);
    expect(ranks.ranks[2]).toBe(0);
    expect(ranks.ranks[3]).toBeGreaterThan(0);
    expect(ranks.ranks[4]).toBe(0);
    expect(() => validateStoplistRanks(snapshot(['the'], 'other'), ranks))
      .toThrow(/different snapshot/u);
  });
});
