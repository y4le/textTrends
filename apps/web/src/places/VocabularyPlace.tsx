import { FrequencyTable } from '../components/vocabulary/FrequencyTable.tsx';

/** Vocabulary owns ranked types and their distribution controls. */
export function VocabularyPlace() {
  return (
    <>
      <FrequencyTable showHeading={false} />
    </>
  );
}
