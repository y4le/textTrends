import { KwicPanel } from '../components/KwicPanel.tsx';
import { MethodSummary } from '../components/MethodSummary.tsx';

export function ConcordancePlace() {
  return (
    <>
      <MethodSummary place="concordance" />
      <KwicPanel showHeading={false} />
    </>
  );
}
