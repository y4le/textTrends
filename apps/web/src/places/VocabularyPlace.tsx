import { FrequencyTable } from '../components/vocabulary/FrequencyTable.tsx';
import { SectionProfile } from '../components/vocabulary/SectionProfile.tsx';

/** Vocabulary owns ranked types and their distribution controls. */
export function VocabularyPlace() {
  return (
    <>
      <FrequencyTable showHeading={false} />
      <SectionProfile />
    </>
  );
}
