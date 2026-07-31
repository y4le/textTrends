import type { ProjectView } from './project-session.ts';

export interface ProjectSaveView {
  readonly kind: 'loading' | 'builtin' | 'user';
  readonly label: string;
  readonly canSave: boolean;
  readonly attention: boolean;
  readonly showCorpusPointer: boolean;
}

/** One presentation authority for project durability. Corpus and Findings may
 * place different controls, but they must describe the same projected state. */
export function projectSaveView(project: ProjectView | null): ProjectSaveView {
  if (project === null) {
    return {
      kind: 'loading',
      label: 'Project status is loading.',
      canSave: false,
      attention: false,
      showCorpusPointer: false,
    };
  }
  if (project.kind === 'builtin') {
    return {
      kind: 'builtin',
      label: 'Built-in corpus is read-only; research notes still save locally.',
      canSave: false,
      attention: false,
      showCorpusPointer: false,
    };
  }
  const base = {
    kind: 'user' as const,
    canSave: project.saveable,
    showCorpusPointer: project.dirty || project.save.phase !== 'idle',
  };
  switch (project.save.phase) {
    case 'saving':
      return {
        ...base,
        label: `Saving project as revision ${project.save.targetRevision}…`,
        attention: false,
      };
    case 'conflict':
      return {
        ...base,
        label: `Project conflict: the saved project moved to revision ${project.save.currentRevision}.`,
        attention: true,
      };
    case 'error':
      return {
        ...base,
        label: `Project save failed (${project.save.code}): ${project.save.message}`,
        attention: true,
      };
    case 'reconcile-required':
      return {
        ...base,
        label: 'Reconciling project state after a worker restart…',
        attention: false,
      };
    case 'idle':
    default:
      return {
        ...base,
        label: !project.baseRevision
          ? 'Imported project has not been saved.'
          : `Project revision ${project.baseRevision}${project.dirty
            ? ' has unsaved changes.'
            : ' is saved.'}`,
        attention: false,
      };
  }
}
