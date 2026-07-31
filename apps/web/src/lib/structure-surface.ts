export interface StructureEditorTarget {
  readonly surface: 'structure-editor';
  readonly doc: string;
}

/** Total parser for the presentation-only chapter editor target. */
export function structureEditorTarget(value: unknown): StructureEditorTarget | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.surface !== 'structure-editor'
    || typeof candidate.doc !== 'string'
    || candidate.doc === ''
  ) {
    return null;
  }
  return { surface: 'structure-editor', doc: candidate.doc };
}

export function structureEditControlId(doc: string): string {
  return `structure-edit-${encodeURIComponent(doc)}`;
}
