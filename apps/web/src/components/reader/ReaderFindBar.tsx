import { FindBar } from '../FindBar.tsx';
import { useApp } from '../../lib/store-instance.ts';
import { ReaderProgressRail } from './ReaderProgressRail.tsx';
import { useReaderChromeModel } from './useReaderChromeModel.ts';

export function ReaderFindBar({ onClose }: { readonly onClose: () => void }) {
  const closeReader = useApp((state) => state.closeReader);
  const seekReader = useApp((state) => state.seekReader);
  const { position, progress } = useReaderChromeModel();
  return (
    <div className="reader-find-takeover">
      <ReaderProgressRail
        className="reader-control-progress"
        progress={progress}
        accessibleName={position === null ? 'Reading position' : `Position in ${position.title}`}
        onSeek={seekReader}
      />
      <FindBar placement="reader" onClose={onClose} onExitReader={closeReader} />
    </div>
  );
}
