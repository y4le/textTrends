import { FrequencyTable } from '../components/CorpusDashboard.tsx';
import { MethodSummary } from '../components/MethodSummary.tsx';

/** Vocabulary owns ranked types and their distribution controls. */
export function VocabularyPlace() {
  return (
    <>
      <MethodSummary place="vocabulary" />
      <FrequencyTable showHeading={false} />
    </>
  );
}
