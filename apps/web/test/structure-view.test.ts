import { describe, expect, it } from 'vitest';
import { ROOT_KEY, STRUCTURE_LIMITS_V0, type EditableSectionValue } from '@texttrends/core';
import {
  canAddSection,
  newDraftSection,
  normalizeLevels,
  provenanceLabel,
  rootSectionId,
  topLevelBoundaryTokens,
  type StructureRow,
} from '../src/lib/structure-view.ts';

/** Build a structure row. `parent === undefined` marks the root. */
function row(
  id: string,
  origin: StructureRow['section']['origin'],
  parent: string | undefined,
  level: number,
  tokenStart: number,
): StructureRow {
  return {
    section: {
      id,
      doc: 'd',
      origin,
      ...(parent === undefined ? {} : { parent }),
      level,
      chars: { start: tokenStart, end: tokenStart + 1 },
    },
    tokens: { start: tokenStart, end: tokenStart + 10 },
  };
}

describe('rootSectionId', () => {
  it('is the one parent-less row', () => {
    const rows = [row('root', 'fixed', undefined, 0, 0), row('a', 'heuristic', 'root', 1, 100)];
    expect(rootSectionId(rows)).toBe('root');
  });
  it('is null when there is no root (empty result)', () => {
    expect(rootSectionId([])).toBeNull();
  });
});

describe('topLevelBoundaryTokens', () => {
  it('returns direct-child chapter starts, excluding root and the token-0 edge', () => {
    const rows = [
      row('root', 'fixed', undefined, 0, 0),
      row('c1', 'heuristic', 'root', 1, 0), // starts at doc edge → excluded
      row('c2', 'heuristic', 'root', 1, 400),
      row('c3', 'source', 'root', 1, 900),
    ];
    expect(topLevelBoundaryTokens(rows)).toEqual([400, 900]);
  });

  it('uses PARENT topology, not level — a deep heading with level 1 is excluded', () => {
    const rows = [
      row('root', 'fixed', undefined, 0, 0),
      row('c1', 'heuristic', 'root', 1, 400),
      // A subsection whose display level was corrected to 1 but whose parent is
      // c1, not the root — it must NOT become a top-level boundary.
      row('sub', 'user', 'c1', 1, 600),
    ];
    expect(topLevelBoundaryTokens(rows)).toEqual([400]);
  });

  it('deduplicates equal boundary tokens and sorts ascending', () => {
    const rows = [
      row('root', 'fixed', undefined, 0, 0),
      row('c1', 'heuristic', 'root', 1, 900),
      row('c2', 'source', 'root', 1, 400),
      row('c3', 'source', 'root', 1, 400), // duplicate boundary
    ];
    expect(topLevelBoundaryTokens(rows)).toEqual([400, 900]);
  });

  it('is empty for a root-only (no chapters) document', () => {
    expect(topLevelBoundaryTokens([row('root', 'fixed', undefined, 0, 0)])).toEqual([]);
  });
});

describe('provenanceLabel', () => {
  it('names each origin honestly', () => {
    expect(provenanceLabel('source')).toBe('Markdown heading');
    expect(provenanceLabel('heuristic')).toBe('chapter heuristic');
    expect(provenanceLabel('user')).toBe('your correction');
    expect(provenanceLabel('fixed')).toBe('whole document');
  });
});

describe('normalizeLevels', () => {
  const r = (key: string, parent: string | undefined, level: number): EditableSectionValue => ({
    key,
    ...(parent === undefined ? {} : { parent }),
    level,
    chars: { start: 0, end: 1 },
  });

  it('derives level from the parent chain, ignoring the stale stored level', () => {
    // A subtree re-parented under a chapter, but with WRONG stored levels.
    const rows = [
      r(ROOT_KEY, undefined, 0),
      r('a', ROOT_KEY, 9),      // should be 1
      r('b', 'a', 9),           // should be 2 (child of a)
      r('c', 'b', 0),           // should be 3 (grandchild) — subtree normalized
    ];
    const levels = Object.fromEntries(normalizeLevels(rows).map((x) => [x.key, x.level]));
    expect(levels).toEqual({ root: 0, a: 1, b: 2, c: 3 });
  });

  it('collapses a row with a missing parent to level 0 (validator rejects it on apply)', () => {
    const rows = [r(ROOT_KEY, undefined, 0), r('x', 'ghost', 5)];
    expect(normalizeLevels(rows).find((x) => x.key === 'x')!.level).toBe(0);
  });
});

describe('canAddSection / newDraftSection', () => {
  it('permits adding below the section cap and refuses at it', () => {
    expect(canAddSection(0)).toBe(true);
    expect(canAddSection(STRUCTURE_LIMITS_V0.maxSectionsPerTable - 1)).toBe(true);
    expect(canAddSection(STRUCTURE_LIMITS_V0.maxSectionsPerTable)).toBe(false);
  });

  it('builds a fresh top-level placeholder with the allocated key retained', () => {
    const s = newDraftSection('user-DETERMINISTIC', 500);
    expect(s.key).toBe('user-DETERMINISTIC');
    expect(s.parent).toBe(ROOT_KEY);
    expect(s.chars).toEqual({ start: 0, end: 1 });
  });

  it('yields an empty range only for an empty document', () => {
    expect(newDraftSection('k', 0).chars).toEqual({ start: 0, end: 0 });
  });
});
