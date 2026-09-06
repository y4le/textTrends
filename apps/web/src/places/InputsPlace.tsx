import { BookAnalysis } from '../components/catalog/BookAnalysis.tsx';
import { ProjectPanel } from '../components/ProjectPanel.tsx';
import { WorkspaceFiles } from '../components/WorkspaceFiles.tsx';

/** Inputs owns acquisition, active-text order, and per-text analysis. */
export function InputsPlace() {
  return (
    <>
      <ProjectPanel />
      <WorkspaceFiles />
      <BookAnalysis />
    </>
  );
}
