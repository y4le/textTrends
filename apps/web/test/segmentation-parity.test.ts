import { describe, expect, it } from 'vitest';
import {
  createDocumentIndex,
  DEFAULT_INDEX_RECIPE,
  segment,
} from '@texttrends/core';
import { createRsvpSource } from '@texttrends/rsvp/source';

const TITLES = [
  'Mr', 'Mrs', 'Ms', 'Mx', 'Messrs', 'Mmes', 'Mme', 'Mlle',
  'Dr', 'Prof', 'Rev', 'Fr', 'Hon',
  'Capt', 'Cmdr', 'Col', 'Cpl', 'Gen', 'Lt', 'Maj', 'Sgt', 'Adm',
  'Gov', 'Sen', 'Rep',
] as const;

const POLICY_CORPUS = [
  ...TITLES.map((title) => `I met ${title}. Smith yesterday. Then we left.`),
  ...[' ', '\u00a0', '\u202f', '\u2009', '\u3000', '\t']
    .map((separator) => `I met Mr.${separator}Smith yesterday. Then we left.`),
  ...['\n', '\r\n', '\n\n', '\u0085', '\u2028', '\u2029']
    .map((separator) => `Mr.${separator}Jones went home.`),
  'I could not reach Mr. Then I gave up.',
  'Ask Mr. Then leave.',
  'We met Dr. Next sentence here.',
  'He is a Jr. Next sentence here.',
  'He is retiring as Sr. Next sentence here.',
  'Turn left on Main St. Then walk north.',
  'Item No. Then the next line.',
  'MR. JONES went home. Next one.',
  'Ask mr. Then leave.',
  'I met Dmr. Jones yesterday. Then left.',
  'Ask Mr.',
  'Ask Mr. ',
] as const;

describe('sentence segmentation parity', () => {
  it('keeps the fingerprinted core and standalone RSVP title policies aligned', async () => {
    for (const text of POLICY_CORPUS) {
      const shard = await createDocumentIndex(
        text,
        await segment(text, 'en'),
        DEFAULT_INDEX_RECIPE,
      );
      const standalone = createRsvpSource(text, { locale: 'en' });
      expect(standalone.sentenceBounds, text).toEqual(Array.from(shard.sentenceBounds));
    }
  });
});
