import { KeynessPanel } from '../components/KeynessPanel.tsx';
import { MethodSummary } from '../components/MethodSummary.tsx';

/** Compare owns explicit A/B scope, rankings, and side-restricted evidence. */
export function ComparePlace() {
  return (
    <>
      <MethodSummary place="compare" />
      <KeynessPanel showHeading={false} />
    </>
  );
}
