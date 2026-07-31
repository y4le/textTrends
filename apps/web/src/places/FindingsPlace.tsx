import { MethodSummary } from '../components/MethodSummary.tsx';
import { PinnedPane } from '../components/PinnedPane.tsx';
import { ResearchPanel } from '../components/ResearchPanel.tsx';

export function FindingsPlace() {
  return (
    <>
      <MethodSummary place="findings" />
      <ResearchPanel />
      <PinnedPane />
    </>
  );
}
