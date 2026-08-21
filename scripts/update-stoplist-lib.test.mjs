import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import {
  isMatchableReferenceWord,
  renderStoplistModule,
  stoplistFromRanking,
} from './update-stoplist-lib.mjs';

describe('ranked stoplist generator', () => {
  it('selects the first unique entries that can be emitted as lexical tokens', () => {
    const result = stoplistFromRanking(
      "The\n's\nAlpha\nalpha\ntwo words\n42\nDON’T\nbeta\n",
      { size: 3 },
    );
    assert.deepEqual(result.entries, ['the', 'alpha', "don't"]);
    assert.equal(result.boundarySourceRank, 7);
    assert.equal(result.skippedBeforeBoundary, 3);
    assert.equal(result.duplicateEntries, 1);
    const module = renderStoplistModule(result);
    assert.match(module, /'the'/u);
    assert.match(module, /STOPLIST_EN_WORDS/u);
  });

  it('recognizes default-segmenter keys and rejects unreachable entries', () => {
    assert.equal(isMatchableReferenceWord("don't"), true);
    assert.equal(isMatchableReferenceWord('two words'), false);
    assert.equal(isMatchableReferenceWord('good-bye'), false);
    assert.equal(isMatchableReferenceWord('42'), false);
  });

  it('rejects invalid sizes and undersized rankings', () => {
    assert.throws(() => stoplistFromRanking('one\n', { size: 0 }), /positive/u);
    assert.throws(() => stoplistFromRanking('one\n', { size: 2 }), /only 1/u);
  });

  it('keeps the checked-in worker module synchronized with the locked ranking', async () => {
    const ranking = await readFile(
      new URL('../text/other/wordlists/common_words.txt', import.meta.url),
      'utf8',
    );
    const module = await readFile(
      new URL('../packages/core/src/ops/stoplist-en-data.ts', import.meta.url),
      'utf8',
    );
    assert.equal(module, renderStoplistModule(stoplistFromRanking(ranking)));
  });
});
