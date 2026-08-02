import { projectSaveView } from '../../lib/project-save-view.ts';
import type { ProjectView } from '../../lib/project-session.ts';
import type { ResearchPersistenceState } from '../../lib/store.ts';

function researchLabel(state: ResearchPersistenceState): string {
  switch (state.phase) {
    case 'dirty': return 'research changes waiting to save';
    case 'saving': return 'saving research state…';
    case 'loading': return 'loading research state…';
    case 'saved': return 'research state saved locally';
    case 'conflict': return state.message;
    case 'error': return state.message;
    case 'idle':
    default: return 'research state not loaded';
  }
}

export function FindingsAttention({
  project,
  research,
  onReload,
  onOverwrite,
  onSaveProject,
}: {
  readonly project: ProjectView | null;
  readonly research: ResearchPersistenceState;
  readonly onReload: () => void;
  readonly onOverwrite: () => void;
  readonly onSaveProject: () => void;
}) {
  const projectView = projectSaveView(project);
  const researchNeedsAttention =
    research.phase === 'conflict' || research.phase === 'error';
  if (!projectView.attention && !researchNeedsAttention) return null;
  return (
    <section className="findings-attention" aria-label="Findings attention">
      <h3>Attention</h3>
      {researchNeedsAttention && (
        <>
          <p role="alert">{researchLabel(research)}</p>
          <div className="findings-record-actions">
            <button type="button" onClick={onReload}>
              {research.phase === 'conflict'
                ? 'reload other tab’s state'
                : 'retry research load'}
            </button>
            {research.phase === 'conflict' && (
              <button type="button" onClick={onOverwrite}>
                overwrite with this tab
              </button>
            )}
          </div>
        </>
      )}
      {projectView.attention && (
        <>
          <p role="alert">{projectView.label}</p>
          <button
            type="button"
            disabled={!projectView.canSave}
            onClick={onSaveProject}
          >
            retry Save project
          </button>
        </>
      )}
    </section>
  );
}

export function ResearchRecord({
  project,
  research,
  onSaveProject,
}: {
  readonly project: ProjectView | null;
  readonly research: ResearchPersistenceState;
  readonly onSaveProject: () => void;
}) {
  const projectView = projectSaveView(project);
  const researchAttention =
    research.phase === 'conflict' || research.phase === 'error';
  const researchRecordLabel = research.phase === 'conflict'
    ? `research conflict at revision ${research.currentRevision}; resolve in Attention above`
    : research.phase === 'error'
      ? 'research persistence error; resolve in Attention above'
      : researchLabel(research);
  const projectRecordLabel = projectView.attention
    ? 'project persistence needs attention; resolve in Attention above'
    : projectView.label;
  return (
    <section className="findings-group" aria-labelledby="findings-record-heading">
      <header className="findings-group-heading">
        <h3 id="findings-record-heading">Research and project record</h3>
        <span>local-first</span>
      </header>
      <dl className="findings-persistence-record">
        <div>
          <dt>research</dt>
          <dd
            role="status"
            data-attention={researchAttention || undefined}
          >
            {researchRecordLabel}
          </dd>
        </div>
        <div>
          <dt>project</dt>
          <dd
            role="status"
            data-attention={projectView.attention || undefined}
          >
            {projectRecordLabel}
          </dd>
        </div>
      </dl>
      <div className="findings-record-actions">
        {projectView.kind === 'user' && !projectView.attention && (
          <button
            type="button"
            disabled={!projectView.canSave}
            onClick={onSaveProject}
          >
            Save project
          </button>
        )}
      </div>
      <p className="findings-record-note">
        Research state saves separately from project files. Share links are
        source-free and omit saved excerpts.
      </p>
    </section>
  );
}
