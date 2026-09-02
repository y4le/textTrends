export interface ReaderProgress {
  readonly token: number;
  readonly tokenCount: number;
  readonly fraction: number;
  readonly percent: number;
  readonly label: string;
}

export function readerProgress(
  token: number,
  tokenCount: number,
  title: string,
): ReaderProgress | null {
  if (
    !Number.isSafeInteger(token)
    || !Number.isSafeInteger(tokenCount)
    || tokenCount < 1
  ) return null;
  const clampedToken = Math.max(0, Math.min(tokenCount - 1, token));
  const fraction = tokenCount === 1 ? 0 : clampedToken / (tokenCount - 1);
  const percent = Math.round(fraction * 100);
  return {
    token: clampedToken,
    tokenCount,
    fraction,
    percent,
    label: `${title}, ${percent} percent`,
  };
}
