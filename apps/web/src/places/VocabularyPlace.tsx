// Passive timing marks are removed from the normal production build.
if (__TT_E2E__) performance.mark('tt:module:vocabulary');

import { FrequencyTable } from '../components/vocabulary/FrequencyTable.tsx';

/** Vocabulary owns ranked types and their distribution controls. */
export function VocabularyPlace() {
  if (__TT_E2E__) performance.mark('tt:render:vocabulary');
  return (
    <>
      <FrequencyTable showHeading={false} />
    </>
  );
}
