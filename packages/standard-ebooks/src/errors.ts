export type StandardEbooksErrorCode =
  | 'ABORTED'
  | 'CAP_EXCEEDED'
  | 'HTTP_ERROR'
  | 'INVALID_EPUB'
  | 'INVALID_REPOSITORY'
  | 'INVALID_RESPONSE'
  | 'NETWORK_ERROR'
  | 'RATE_LIMITED';

export class StandardEbooksError extends Error {
  readonly code: StandardEbooksErrorCode;
  readonly status: number | null;
  readonly url: string | null;

  constructor(
    code: StandardEbooksErrorCode,
    message: string,
    options: { readonly status?: number; readonly url?: string; readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'StandardEbooksError';
    this.code = code;
    this.status = options.status ?? null;
    this.url = options.url ?? null;
  }
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof StandardEbooksError && error.code === 'ABORTED') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}
