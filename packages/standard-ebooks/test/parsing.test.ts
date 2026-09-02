import { describe, expect, it } from 'vitest';
import { ebookPathToRepositoryName } from '../src/index.js';

describe('Standard Ebooks repository names', () => {
  it('maps ebook URL paths to repository names (segments may contain underscores)', () => {
    expect(ebookPathToRepositoryName('/ebooks/mary-shelley/frankenstein')).toBe('mary-shelley_frankenstein');
    expect(ebookPathToRepositoryName('/ebooks/homer/the-odyssey/william-cullen-bryant')).toBe(
      'homer_the-odyssey_william-cullen-bryant',
    );
    expect(ebookPathToRepositoryName('/ebooks/leo-tolstoy/war-and-peace/louise-maude_aylmer-maude')).toBe(
      'leo-tolstoy_war-and-peace_louise-maude_aylmer-maude',
    );
    for (const bad of ['/ebooks/only-author', '/ebooks/a//b', '/other/a/b', 'a/b']) {
      expect(() => ebookPathToRepositoryName(bad)).toThrowError(/Not a Standard Ebooks ebook URL path/);
    }
  });

});
