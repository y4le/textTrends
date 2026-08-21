import { DEFAULT_INDEX_RECIPE, type IndexRecipeProvisional } from '../contract/recipes.ts';
import { tokenKey } from '../index/build.ts';
import { foldKey } from '../resolve/fold.ts';
import type { CorpusSnapshotV1 } from '../snapshot/compose.ts';
import { STOPLIST_EN_WORDS } from './stoplist-en-data.ts';
import { STOPLIST_MAX_TOP_N } from './stoplist-contract.ts';
import {
  validateStoplistRanks,
  type StoplistRanksV1,
} from './stoplist-ranks.ts';

const MATCH_MODE = { case: 'folded', diacritics: 'sensitive' } as const;
const LOCALE = 'en';

export function buildStoplistRanks(
  snapshot: CorpusSnapshotV1,
  recipe: IndexRecipeProvisional = DEFAULT_INDEX_RECIPE,
): StoplistRanksV1 {
  if (STOPLIST_EN_WORDS.length !== STOPLIST_MAX_TOP_N) {
    throw new RangeError('bundled common-word reference has the wrong size');
  }
  const rankByKey = new Map<string, number>();
  for (let index = 0; index < STOPLIST_EN_WORDS.length; index++) {
    const key = foldKey(tokenKey(STOPLIST_EN_WORDS[index]!, recipe), MATCH_MODE, LOCALE);
    if (!rankByKey.has(key)) rankByKey.set(key, index + 1);
  }
  const ranks = new Uint16Array(snapshot.vocabulary.keys.length);
  for (let typeId = 0; typeId < snapshot.vocabulary.keys.length; typeId++) {
    ranks[typeId] = rankByKey.get(
      foldKey(snapshot.vocabulary.keys[typeId]!, MATCH_MODE, LOCALE),
    ) ?? 0;
  }
  return {
    snapshot: snapshot.id,
    ranks,
    referenceWords: STOPLIST_EN_WORDS,
  };
}

export {
  STOPLIST_EN_WORDS,
  validateStoplistRanks,
  type StoplistRanksV1,
};
