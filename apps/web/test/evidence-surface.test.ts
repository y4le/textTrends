import { describe, expect, it } from 'vitest';
import { evidenceSurfaceView } from '../src/lib/evidence-surface.ts';
import type { PassageBlockState } from '../src/lib/pins.ts';

function block(overrides: Partial<PassageBlockState> = {}): PassageBlockState {
  return {
    snapshot: 'snapshot-1',
    tracks: [],
    result: {
      doc: 'doc-1',
      centerToken: 9,
      tokens: { start: 8, end: 11 },
      docCharsUtf16: { start: 0, end: 18 },
      text: 'before\nWOLF after',
      tokenStartsUtf16: [0, 7, 12],
      tokenEndsUtf16: [6, 11, 17],
      centerCharsUtf16: { start: 7, end: 11 },
      marks: [],
      truncatedByCharCap: false,
    },
    ...overrides,
  } as PassageBlockState;
}

describe('evidence surface view', () => {
  const titleByDoc = new Map([['doc-1', 'The Hound']]);

  it('is explicit when no evidence target exists', () => {
    expect(evidenceSurfaceView({
      scrub: null,
      passage: block(),
      snapshot: 'snapshot-1',
      titleByDoc,
      tokenCount: 90,
    })).toEqual({
      kind: 'empty',
      message: 'Move the reading cursor or choose an occurrence to inspect passage evidence.',
    });
  });

  it('does not expose a stale snapshot, document, or non-containing block', () => {
    for (const [snapshot, scrub] of [
      ['snapshot-2', { doc: 'doc-1', token: 9 }],
      ['snapshot-1', { doc: 'doc-2', token: 9 }],
      ['snapshot-1', { doc: 'doc-1', token: 20 }],
    ] as const) {
      const view = evidenceSurfaceView({
        scrub,
        passage: block(),
        snapshot,
        titleByDoc,
        tokenCount: null,
      });
      expect(view.kind).toBe('loading');
    }
  });

  it('publishes exact caption, safe text, and anchor for a serving block', () => {
    expect(evidenceSurfaceView({
      scrub: { doc: 'doc-1', token: 9 },
      passage: block(),
      snapshot: 'snapshot-1',
      titleByDoc,
      tokenCount: 90,
    })).toEqual({
      kind: 'ready',
      doc: 'doc-1',
      title: 'The Hound',
      token: 9,
      tokenCount: 90,
      caption: 'The Hound · token 10 of 90',
      text: 'before WOLF after',
      anchorCharsUtf16: { start: 7, end: 11 },
      truncated: false,
    });
  });
});
