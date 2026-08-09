import { BookAnalysis } from '../components/catalog/BookAnalysis.tsx';
import { ProjectPanel } from '../components/ProjectPanel.tsx';

/** Catalog owns acquisition, active-file order, per-book analysis, and structure. */
export function CatalogPlace() {
  return (
    <>
      <ProjectPanel headingAs="h3" />
      <BookAnalysis />
    </>
  );
}
