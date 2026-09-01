import type { ReaderProgress } from '../../lib/reader-progress.ts';

export function ReaderProgressRail({
  progress,
  accessibleName,
  className,
}: {
  readonly progress: ReaderProgress | null;
  readonly accessibleName?: string;
  readonly className?: string;
}) {
  const percent = progress?.fraction === undefined ? 0 : progress.fraction * 100;
  const classes = ['reader-progress-rail', className].filter(Boolean).join(' ');
  return (
    <span
      className={classes}
      role={progress === null ? undefined : 'progressbar'}
      aria-label={progress === null ? undefined : accessibleName ?? progress.label}
      aria-valuemin={progress === null ? undefined : 0}
      aria-valuemax={progress === null ? undefined : 100}
      aria-valuenow={progress?.percent}
      aria-valuetext={progress === null ? undefined : `${progress.percent} percent`}
      data-reader-progress={progress?.fraction}
    >
      <span
        className="reader-progress-fill"
        style={{ inlineSize: `${percent}%` }}
        aria-hidden="true"
      />
      {progress !== null && (
        <span
          className="reader-progress-cursor"
          style={{
            insetInlineStart: `clamp(0px, calc(${percent}% - 1px), calc(100% - 2px))`,
          }}
          aria-hidden="true"
        />
      )}
    </span>
  );
}
