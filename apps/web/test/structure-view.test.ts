import { describe, expect, it } from 'vitest';
import {
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
