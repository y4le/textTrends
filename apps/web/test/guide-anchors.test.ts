import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GUIDE_ACTIVE_ANCHOR_ATTRIBUTE,
  GUIDE_ANCHOR_ATTRIBUTE,
  GUIDE_ANCHOR_IDS,
  guideAnchorProps,
  guideAnchorSelector,
  queryGuideAnchor,
  type GuideAnchorId,
} from '../src/lib/guide/anchors.ts';
import {
  GUIDE_OCCURRENCE_ACTIVATION_ATTRIBUTE,
  occurrenceActivationFor,
  occurrenceActivationProps,
  readOccurrenceActivation,
} from '../src/lib/guide/activation.ts';

const WEB = join(__dirname, '..');

function walkTsx(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files.push(...walkTsx(path));
    else if (name.endsWith('.tsx')) files.push(path);
  }
  return files;
}

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

  it('gives every declared id an explicit root-active CSS rule', () => {
    const css = readFileSync(join(WEB, 'src/style/tokens.css'), 'utf8');
    for (const anchor of GUIDE_ANCHOR_IDS) {
      expect(css).toContain(
        `#root[${GUIDE_ACTIVE_ANCHOR_ATTRIBUTE}='${anchor}'] [${GUIDE_ANCHOR_ATTRIBUTE}='${anchor}']`,
      );
    }
  });

  it('keeps publishers confined to their semantic owners', () => {
    const owners: Readonly<Record<GuideAnchorId, readonly string[]>> = {
      'terms-rail': [
        'src/components/QuerySurface.tsx',
        'src/components/WorkbenchDock.tsx',
      ],
      'trend-plate': ['src/components/TrendPanel.tsx'],
      'dispersion-strip': ['src/components/TrendPanel.tsx'],
      'chart-cursor': ['src/components/TrendPanel.tsx'],
      'reader-prose': [
        'src/components/ReaderDrawer.tsx',
        'src/App.tsx',
      ],
      'reading-footer': ['src/components/WorkbenchFooter.tsx'],
      'compare-sides': ['src/components/compare/ComparePanel.tsx'],
    };
    const actual = Object.fromEntries(
      GUIDE_ANCHOR_IDS.map((anchor) => [anchor, new Set<string>()]),
    ) as Record<GuideAnchorId, Set<string>>;
    for (const file of walkTsx(join(WEB, 'src'))) {
      const source = readFileSync(file, 'utf8');
      const owner = relative(WEB, file).split(sep).join('/');
      for (const match of source.matchAll(/guideAnchorProps\('([^']+)'\)/g)) {
        const anchor = match[1] as GuideAnchorId;
        if (anchor in actual) actual[anchor].add(owner);
      }
    }
    for (const anchor of GUIDE_ANCHOR_IDS) {
      expect([...actual[anchor]].sort()).toEqual([...owners[anchor]].sort());
    }
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
