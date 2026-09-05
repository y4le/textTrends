import { describe, expect, it } from 'vitest';
import { compileFrequencyPattern } from '../src/ops/frequency-pattern.ts';

describe('bounded vocabulary patterns', () => {
  it.each(['^Al(?:pha|pine)$', 'pha', '[a-z]+', '^a{1,3}$', '\\p{L}+', '\\u{1F600}', '^.$', '(a+)+$', '\\bword\\b'])('preserves boolean Unicode search for %s', (source) => {
    const pattern = compileFrequencyPattern(source);
    const native = new RegExp(source, 'u');
    for (const key of ['Alpha', 'Alpine', 'alphabet', 'aaa', 'καλημέρα', '😀', 'a😀b', 'word', 'words', 'a!']) {
      expect(pattern.test(key), `${source} on ${key}`).toBe(native.test(key));
    }
  });

  it.each(['(?=a)', '(?<=a)b', '(a)\\1', 'a{1001}'])('rejects unsupported syntax as an ordinary query error: %s', (source) => {
    expect(() => compileFrequencyPattern(source)).toThrow(RangeError);
    expect(() => compileFrequencyPattern(source)).toThrow(/Unsupported regular expression/);
  });

  it('documents RE2 whitespace semantics without pretending to use native RegExp', () => {
    const pattern = compileFrequencyPattern('^\\s$');
    expect(pattern.test(' ')).toBe(true);
    expect(pattern.test('\t')).toBe(true);
    expect(pattern.test('\u00a0')).toBe(false);
  });

  it('handles nested quantifiers and long nonmatches without backtracking', () => {
    const pattern = compileFrequencyPattern('^(a+)+$');
    expect(pattern.test('a'.repeat(10_000) + '!')).toBe(false);
    expect(pattern.test('a'.repeat(10_000))).toBe(true);
  });
});
