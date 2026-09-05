import { RE2JS } from 're2js';

/** Lazy, linear-time matching for Vocabulary. Never execute a user pattern
 * with the host's backtracking RegExp engine. RE2JS.test is an unanchored,
 * capture-free search, so it avoids allocating a Matcher per vocabulary key. */
export function compileFrequencyPattern(source: string): { test(input: string): boolean } {
  try {
    return RE2JS.compile(RE2JS.translateRegExp(source));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new RangeError(`Unsupported regular expression: ${reason}. Lookaround and backreferences are not supported.`);
  }
}
