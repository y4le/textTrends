import { describe, expect, it } from 'vitest';
import { inputResetCopy } from '../src/lib/input-reset-view.ts';

describe('inputResetCopy', () => {
  it.each([
    [1, 0, 'Clear all active inputs', 'Clear 1 active text?\n\nSaved texts will remain in the local library.', '1 active text cleared. Saved texts remain in the local library.'],
    [2, 0, 'Clear all active inputs', 'Clear 2 active texts?\n\nSaved texts will remain in the local library.', '2 active texts cleared. Saved texts remain in the local library.'],
    [0, 1, 'Clear all terms', 'Clear 1 term?', '1 term cleared.'],
    [0, 2, 'Clear all terms', 'Clear 2 terms?', '2 terms cleared.'],
    [2, 3, 'Clear all active inputs and terms', 'Clear 2 active texts and 3 terms?\n\nSaved texts will remain in the local library.', '2 active texts and 3 terms cleared. Saved texts remain in the local library.'],
    [0, 0, 'Clear all active inputs and terms', '', ''],
  ])('describes %i texts and %i terms precisely', (texts, terms, accessibleName, confirmation, notice) => {
    expect(inputResetCopy(texts, terms)).toEqual({ accessibleName, confirmation, notice });
  });
});
