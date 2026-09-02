import { describe, expect, it } from 'vitest';
import {
  readerEdgeWidth,
  readerTapIntent,
  type ReaderTapFacts,
} from '../src/lib/reader-tap.ts';

const stableTap: ReaderTapFacts = {
  primary: true,
  movedPx: 0,
  elapsedMs: 100,
  selectionOpen: false,
  onInteractiveTarget: false,
  onMarkTarget: false,
  onSourceToken: false,
  edgePaging: true,
  xWithinPane: 195,
  paneWidth: 390,
  canPagePrevious: true,
  canPageNext: true,
  geometrySettled: true,
};

describe('reader tap intent', () => {
  it('bounds the supplementary page-turn edge', () => {
    expect(readerEdgeWidth(100)).toBe(44);
    expect(readerEdgeWidth(390)).toBe(70.2);
    expect(readerEdgeWidth(1_440)).toBe(120);
  });

  it('gives painted source tokens precedence over edge paging', () => {
    expect(readerTapIntent({
      ...stableTap,
      xWithinPane: 4,
      onSourceToken: true,
    })).toBe('cursor');
    expect(readerTapIntent({
      ...stableTap,
      xWithinPane: 386,
      onSourceToken: true,
    })).toBe('cursor');
  });

  it('turns pages only from touch-eligible blank edge space', () => {
    expect(readerTapIntent({ ...stableTap, xWithinPane: 4 })).toBe('page-previous');
    expect(readerTapIntent({ ...stableTap, xWithinPane: 386 })).toBe('page-next');
    expect(readerTapIntent({ ...stableTap, xWithinPane: 195 })).toBe('none');
    expect(readerTapIntent({
      ...stableTap,
      edgePaging: false,
      xWithinPane: 386,
    })).toBe('none');
    expect(readerTapIntent({
      ...stableTap,
      canPageNext: false,
      xWithinPane: 386,
    })).toBe('none');
  });

  it('leaves marks and other interactive targets to their own action', () => {
    expect(readerTapIntent({
      ...stableTap,
      onMarkTarget: true,
      xWithinPane: 4,
    })).toBe('mark');
    expect(readerTapIntent({
      ...stableTap,
      onInteractiveTarget: true,
      xWithinPane: 386,
    })).toBe('mark');
  });

  it.each([
    ['non-primary input', { primary: false }],
    ['a drag', { movedPx: 8.01 }],
    ['a hold', { elapsedMs: 500.01 }],
    ['native selection', { selectionOpen: true }],
    ['mid-fit geometry', { geometrySettled: false }],
    ['a point before the pane', { xWithinPane: -0.01 }],
    ['a point after the pane', { xWithinPane: 390.01 }],
  ] as const)('ignores %s', (_label, override) => {
    expect(readerTapIntent({
      ...stableTap,
      ...override,
      onSourceToken: true,
    })).toBe('none');
  });
});
