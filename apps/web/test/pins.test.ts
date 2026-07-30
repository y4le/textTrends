import { describe, expect, it } from 'vitest';
import type { PassageResult } from '@texttrends/core';
import {
  canReusePassage,
  evidenceFrom,
  passageContains,
  pinTrackLegend,
  samePinAnchor,
  sameTrackIdentities,
  type CapturedTrack,
  type PassageBlockState,
} from '../src/lib/pins.ts';

const TRACK: CapturedTrack = {
  seriesId: 'series:a',
  groupId: 'group:a',
  identity: 'identity:a',
  label: 'wolf',
  styleSlot: 2,
};

const passage = (): PassageResult => ({
  doc: 'doc:a',
  centerToken: 11,
  tokens: { start: 10, end: 13 },
  docCharsUtf16: { start: 100, end: 116 },
  text: 'one wolf sleeps',
  tokenStartsUtf16: [0, 4, 9],
  tokenEndsUtf16: [3, 8, 15],
  centerCharsUtf16: { start: 4, end: 8 },
  marks: [{
    seriesId: TRACK.seriesId,
    groupId: TRACK.groupId,
    tokens: { start: 11, end: 12 },
    charsUtf16: { start: 4, end: 8 },
  }],
  truncatedByCharCap: false,
});

describe('pin evidence primitives', () => {
  it('compares anchors by fields without delimiter-derived keys', () => {
    expect(samePinAnchor(
      { snapshot: 's', doc: 'a:b', token: 3 },
      { snapshot: 's', doc: 'a:b', token: 3 },
    )).toBe(true);
    expect(samePinAnchor(
      { snapshot: 's:a', doc: 'b', token: 3 },
      { snapshot: 's', doc: 'a:b', token: 3 },
    )).toBe(false);
  });

  it('uses half-open containment and rejects the wrong document', () => {
    const block = passage();
    expect(passageContains(block, 'doc:a', 10)).toBe(true);
    expect(passageContains(block, 'doc:a', 12)).toBe(true);
    expect(passageContains(block, 'doc:a', 13)).toBe(false);
    expect(passageContains(block, 'other', 11)).toBe(false);
  });

  it('copies evidence and derives a non-centred anchor span from token arrays', () => {
    const block = passage();
    const evidence = evidenceFrom(block, 12)!;
    expect(evidence.anchorCharsUtf16).toEqual({ start: 9, end: 15 });
    expect(evidence.tokenStartsUtf16).not.toBe(block.tokenStartsUtf16);
    expect(evidence.tokenEndsUtf16).not.toBe(block.tokenEndsUtf16);
    expect(evidence.marks).not.toBe(block.marks);
    expect(evidenceFrom(block, 13)).toBeNull();
  });

  it('reuses only matching snapshot, ordered track identities, and containment', () => {
    const held: PassageBlockState = {
      snapshot: 's1',
      tracks: [TRACK],
      result: passage(),
    };
    const anchor = { snapshot: 's1', doc: 'doc:a', token: 12 };
    expect(canReusePassage(held, anchor, 's1', [TRACK])).toBe(true);
    expect(canReusePassage(held, { ...anchor, snapshot: 's2' }, 's2', [TRACK])).toBe(false);
    expect(canReusePassage(held, anchor, 's2', [TRACK])).toBe(false);
    expect(canReusePassage(held, { ...anchor, token: 13 }, 's1', [TRACK])).toBe(false);
    expect(canReusePassage(held, anchor, 's1', [{ ...TRACK, identity: 'changed' }])).toBe(false);
    expect(sameTrackIdentities([TRACK], [TRACK, TRACK])).toBe(false);
    const second = { ...TRACK, seriesId: 'series:b', identity: 'identity:b' };
    expect(sameTrackIdentities([TRACK, second], [second, TRACK])).toBe(false);
  });

  it('uses live presentation only while matching identity remains current', () => {
    const liveSeries = [{ id: TRACK.seriesId, label: 'Wolf renamed', styleSlot: 4 }];
    expect(pinTrackLegend([TRACK], () => TRACK.identity, liveSeries)).toEqual([{
      seriesId: TRACK.seriesId,
      label: 'Wolf renamed',
      styleSlot: 4,
      stale: false,
    }]);
    expect(pinTrackLegend([TRACK], () => 'changed', liveSeries)).toEqual([{
      seriesId: TRACK.seriesId,
      label: 'wolf',
      styleSlot: 2,
      stale: true,
    }]);
    expect(pinTrackLegend([TRACK], () => null, [])).toEqual([{
      seriesId: TRACK.seriesId,
      label: 'wolf',
      styleSlot: 2,
      stale: true,
    }]);
  });
});
