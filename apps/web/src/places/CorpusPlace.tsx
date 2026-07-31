import { CorpusDashboard } from '../components/CorpusDashboard.tsx';
import { MethodSummary } from '../components/MethodSummary.tsx';
import { ProjectPanel } from '../components/ProjectPanel.tsx';
import { StructurePanel } from '../components/StructurePanel.tsx';

/**
 * Corpus owns study composition, sources, document inventory, and structure.
 * The route heading lives outside this lazy body so navigation always has an
 * immediate, truthful landmark while the place chunk loads.
 */
export function CorpusPlace() {
  return (
    <>
      <MethodSummary place="corpus" />
      <ProjectPanel headingAs="h3" />
      <CorpusDashboard showHeading={false} showVocabulary={false} />
      <StructurePanel headingAs="h3" />
    </>
  );
}
