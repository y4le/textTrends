import type { StructureState } from './store.ts';
import { topLevelBoundaryTokens } from './structure-view.ts';

export interface ChapterMarkView {
  readonly checked: boolean;
  readonly enabled: boolean;
  readonly reason: string | null;
  readonly bookLabel: string | null;
}

/**
 * Derive the chapter-mark control from the same echoed outline result the
 * chart consumes. The control must never promise marks the chart cannot draw.
 */
export function chapterMarkView(input: {
  readonly sectionMarks: boolean;
  readonly focusedDoc: string | null;
  readonly structure: StructureState | null;
  readonly titleByDoc: ReadonlyMap<string, string>;
  readonly readyDocs: readonly string[];
}): ChapterMarkView {
  const { sectionMarks, focusedDoc, structure, titleByDoc, readyDocs } = input;
  if (!focusedDoc) {
    return {
      checked: sectionMarks,
      enabled: false,
      reason: 'Chapter marks need a ready book with a detected outline.',
      bookLabel: null,
    };
  }

  const bookLabel = titleByDoc.get(focusedDoc) ?? focusedDoc;
  if (!readyDocs.includes(focusedDoc)) {
    return {
      checked: sectionMarks,
      enabled: false,
      reason: `Chapter marks need ${bookLabel} to be ready.`,
      bookLabel,
    };
  }

  if (!structure || structure.doc !== focusedDoc || structure.state.status === 'pending') {
    return {
      checked: sectionMarks,
      enabled: false,
      reason: `Reading the chapter outline for ${bookLabel}.`,
      bookLabel,
    };
  }

  if (structure.state.status === 'error') {
    return {
      checked: sectionMarks,
      enabled: false,
      reason: `The chapter outline for ${bookLabel} is unavailable.`,
      bookLabel,
    };
  }

  if (topLevelBoundaryTokens(structure.state.result.rows).length === 0) {
    return {
      checked: sectionMarks,
      enabled: false,
      reason: `No top-level chapters were detected in ${bookLabel}.`,
      bookLabel,
    };
  }

  return {
    checked: sectionMarks,
    enabled: true,
    reason: null,
    bookLabel,
  };
}
