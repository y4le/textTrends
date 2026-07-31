import { CorpusInventory } from '../components/corpus/CorpusInventory.tsx';
import { ProjectPanel } from '../components/ProjectPanel.tsx';

/**
 * Corpus owns study composition, sources, document inventory, and structure.
 * The route heading lives outside this lazy body so navigation always has an
 * immediate, truthful landmark while the place chunk loads.
 */
export function CorpusPlace() {
  return (
    <>
      <ProjectPanel headingAs="h3" />
      <CorpusInventory showHeading={false} />
    </>
  );
}
