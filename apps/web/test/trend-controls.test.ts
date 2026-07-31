import { describe, expect, it } from 'vitest';
import type { StructureQueryResultV1 } from '../src/shared/analysis-contract.ts';
import { chapterMarkView } from '../src/lib/trend-controls.ts';
import type { StructureState } from '../src/lib/store.ts';

const titles = new Map([['hound', 'The Hound of the Baskervilles']]);

function readyStructure(
  rows: StructureQueryResultV1['rows'],
  doc = 'hound',
): StructureState {
  return {
    doc,
    state: {
      status: 'ready',
      result: {
        doc,
        structure: `structure-${doc}`,
        index: `index-${doc}`,
        rows,
      },
    },
  };
}

const root = {
  section: {
    id: 'root',
    doc: 'hound',
    origin: 'fixed' as const,
    level: 0,
    chars: { start: 0, end: 1 },
  },
  tokens: { start: 0, end: 1_000 },
};

describe('chapterMarkView', () => {
  it('enables the existing preference only when the focused ready outline has a top-level boundary', () => {
    const view = chapterMarkView({
      sectionMarks: true,
      focusedDoc: 'hound',
      readyDocs: ['hound'],
      titleByDoc: titles,
      structure: readyStructure([
        root,
        {
          section: {
            id: 'chapter-2',
            doc: 'hound',
            origin: 'heuristic',
            parent: 'root',
            level: 1,
            chars: { start: 400, end: 401 },
          },
          tokens: { start: 400, end: 800 },
        },
      ]),
    });

    expect(view).toEqual({
      checked: true,
      enabled: true,
      reason: null,
      bookLabel: 'The Hound of the Baskervilles',
    });
  });

  it('keeps the persisted preference visible while explaining a pending outline', () => {
    const view = chapterMarkView({
      sectionMarks: true,
      focusedDoc: 'hound',
      readyDocs: ['hound'],
      titleByDoc: titles,
      structure: { doc: 'hound', state: { status: 'pending' } },
    });

    expect(view.checked).toBe(true);
    expect(view.enabled).toBe(false);
    expect(view.reason).toMatch(/reading the chapter outline/i);
  });

  it('does not claim a root-only outline can produce marks', () => {
    const view = chapterMarkView({
      sectionMarks: false,
      focusedDoc: 'hound',
      readyDocs: ['hound'],
      titleByDoc: titles,
      structure: readyStructure([root]),
    });

    expect(view.enabled).toBe(false);
    expect(view.reason).toMatch(/no top-level chapters/i);
  });

  it('rejects a stale outline for another document', () => {
    const view = chapterMarkView({
      sectionMarks: false,
      focusedDoc: 'hound',
      readyDocs: ['hound'],
      titleByDoc: titles,
      structure: readyStructure([
        {
          ...root,
          section: { ...root.section, doc: 'study' },
        },
        {
          section: {
            id: 'chapter-2',
            doc: 'study',
            origin: 'heuristic',
            parent: 'root',
            level: 1,
            chars: { start: 400, end: 401 },
          },
          tokens: { start: 400, end: 800 },
        },
      ], 'study'),
    });

    expect(view.enabled).toBe(false);
    expect(view.reason).toMatch(/reading the chapter outline/i);
  });

  it('explains the no-focus, not-ready, and failed-outline states', () => {
    expect(chapterMarkView({
      sectionMarks: false,
      focusedDoc: null,
      readyDocs: [],
      titleByDoc: titles,
      structure: null,
    })).toMatchObject({
      enabled: false,
      bookLabel: null,
      reason: expect.stringMatching(/ready book/i),
    });

    expect(chapterMarkView({
      sectionMarks: false,
      focusedDoc: 'unknown-doc',
      readyDocs: [],
      titleByDoc: titles,
      structure: null,
    })).toMatchObject({
      enabled: false,
      bookLabel: 'unknown-doc',
      reason: expect.stringMatching(/unknown-doc to be ready/i),
    });

    expect(chapterMarkView({
      sectionMarks: false,
      focusedDoc: 'hound',
      readyDocs: ['hound'],
      titleByDoc: titles,
      structure: {
        doc: 'hound',
        state: { status: 'error', message: 'corrupt outline' },
      },
    })).toMatchObject({
      enabled: false,
      bookLabel: 'The Hound of the Baskervilles',
      reason: expect.stringMatching(/outline.*unavailable/i),
    });
  });
});
