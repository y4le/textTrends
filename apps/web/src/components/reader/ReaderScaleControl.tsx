import { useApp } from '../../lib/store-instance.ts';

export function ReaderScaleControl() {
  const scale = useApp((state) => state.readerScale);
  const readyCount = useApp((state) => state.snapshot?.readyDocs.length ?? 0);
  const setScale = useApp((state) => state.setReaderScale);
  if (readyCount < 2) return null;

  return (
    <div className="reader-scale-control" role="group" aria-label="Reader scale">
      {(['read', 'atlas'] as const).map((value) => (
        <button
          key={value}
          type="button"
          aria-pressed={scale === value}
          onClick={() => setScale(value)}
        >
          {value === 'read' ? 'Read' : 'Atlas'}
        </button>
      ))}
    </div>
  );
}
