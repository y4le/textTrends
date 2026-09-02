export type EpubErrorCode = 'CAP_EXCEEDED' | 'INVALID_EPUB';

export class EpubError extends Error {
  readonly code: EpubErrorCode;

  constructor(
    code: EpubErrorCode,
    message: string,
    options: { readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'EpubError';
    this.code = code;
  }
}
