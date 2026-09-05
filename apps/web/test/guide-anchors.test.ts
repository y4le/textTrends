import { describe, expect, it } from 'vitest';
import {
  GUIDE_ANCHOR_ATTRIBUTE,
  GUIDE_ANCHOR_IDS,
  guideAnchorProps,
  guideAnchorSelector,
  queryGuideAnchor,
} from '../src/lib/guide/anchors.ts';
import {
  GUIDE_OCCURRENCE_ACTIVATION_ATTRIBUTE,
  occurrenceActivationFor,
  occurrenceActivationProps,
  readOccurrenceActivation,
} from '../src/lib/guide/activation.ts';

function rootWith(...matches: readonly HTMLElement[]): Pick<ParentNode, 'querySelectorAll'> {
  return {
    querySelectorAll: () => ({
      length: matches.length,
      item: (index: number) => matches[index] ?? null,
    }),
  } as unknown as Pick<ParentNode, 'querySelectorAll'>;
}

describe('guide semantic anchors', () => {
  it('declares one unique id for each launch-tour surface', () => {
    expect(GUIDE_ANCHOR_IDS).toEqual([
      'terms-rail',
      'trend-plate',
      'dispersion-strip',
      'chart-cursor',
      'reader-prose',
      'reading-footer',
      'compare-sides',
    ]);
    expect(new Set(GUIDE_ANCHOR_IDS).size).toBe(GUIDE_ANCHOR_IDS.length);
  });

  it('builds stable props and one semantic selector', () => {
    for (const anchor of GUIDE_ANCHOR_IDS) {
      expect(guideAnchorProps(anchor)).toEqual({
        [GUIDE_ANCHOR_ATTRIBUTE]: anchor,
      });
      expect(guideAnchorSelector(anchor)).toBe(
        `[${GUIDE_ANCHOR_ATTRIBUTE}="${anchor}"]`,
      );
    }
  });

  it('accepts exactly one publisher and degrades duplicates like a miss', () => {
    const anchor = { id: 'one' } as HTMLElement;
    expect(queryGuideAnchor(rootWith(), 'trend-plate')).toBeNull();
    expect(queryGuideAnchor(rootWith(anchor), 'trend-plate')).toBe(anchor);
    expect(queryGuideAnchor(rootWith(anchor, { id: 'two' } as HTMLElement), 'trend-plate'))
      .toBeNull();
  });


});

describe('occurrence activation truth', () => {
  it.each([
    [{ coarse: false, barcodeInteractive: true }, 'available'],
    [{ coarse: true, barcodeInteractive: true }, 'coarse'],
    [{ coarse: false, barcodeInteractive: false }, 'minimized'],
    [{ coarse: true, barcodeInteractive: false }, 'minimized'],
  ] as const)('maps %o to %s', (input, expected) => {
    expect(occurrenceActivationFor(input)).toBe(expected);
    expect(occurrenceActivationProps(input)).toEqual({
      [GUIDE_OCCURRENCE_ACTIVATION_ATTRIBUTE]: expected,
    });
  });

  it('reads only declared values and treats a missing anchor as unknown', () => {
    const anchor = (value: string | null) => ({
      getAttribute: (name: string) =>
        name === GUIDE_OCCURRENCE_ACTIVATION_ATTRIBUTE ? value : null,
    });
    expect(readOccurrenceActivation(anchor('available'))).toBe('available');
    expect(readOccurrenceActivation(anchor('minimized'))).toBe('minimized');
    expect(readOccurrenceActivation(anchor('coarse'))).toBe('coarse');
    expect(readOccurrenceActivation(anchor('fine'))).toBe('unknown');
    expect(readOccurrenceActivation(null)).toBe('unknown');
  });
});
