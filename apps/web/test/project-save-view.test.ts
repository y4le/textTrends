import { describe, expect, it } from 'vitest';
import type { ProjectView } from '../src/lib/project-session.ts';
import { projectSaveView } from '../src/lib/project-save-view.ts';

const data = {
  id: 'p',
  order: [],
  docs: [],
  indexRecipe: {} as never,
  indexRecipeHash: 'sha256:index' as never,
};

function user(
  overrides: Partial<ProjectView> = {},
): ProjectView {
  return {
    kind: 'user',
    id: 'p',
    data,
    baseRevision: 2,
    dirty: false,
    save: { phase: 'idle' },
    saveable: true,
    ...overrides,
  };
}

describe('project save view', () => {
  it('distinguishes loading, read-only, saved, and dirty projects', () => {
    expect(projectSaveView(null)).toMatchObject({
      kind: 'loading',
      canSave: false,
    });
    expect(projectSaveView({
      ...user(),
      kind: 'builtin',
      baseRevision: null,
      saveable: false,
    })).toMatchObject({
      kind: 'builtin',
      label: expect.stringContaining('read-only'),
      showStatus: false,
    });
    expect(projectSaveView(user()).label).toBe('Project revision 2 is saved.');
    expect(projectSaveView(user({ dirty: true }))).toMatchObject({
      label: 'Project revision 2 has unsaved changes.',
      showStatus: true,
    });
    expect(projectSaveView(user({ baseRevision: 0 })).label)
      .toBe('Imported project has not been saved.');
  });

  it('surfaces save conflicts and errors as attention states', () => {
    expect(projectSaveView(user({
      save: { phase: 'conflict', currentRevision: 4 },
    }))).toMatchObject({
      attention: true,
      label: expect.stringContaining('revision 4'),
    });
    expect(projectSaveView(user({
      save: { phase: 'error', code: 'WRITE_FAILED', message: 'disk full' },
    }))).toMatchObject({
      attention: true,
      label: expect.stringContaining('disk full'),
    });
  });
});
