import { BookAnalysis } from '../components/catalog/BookAnalysis.tsx';
import { ProjectPanel } from '../components/ProjectPanel.tsx';

/** Inputs owns acquisition, active-text order, and per-text analysis. */
export function InputsPlace() {
  return (
    <>
      <ProjectPanel headingAs="h3" />
      <BookAnalysis />
    </>
  );
}
