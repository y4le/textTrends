/**
 * The closed, typed failure for the extraction runtime. Only UNDERSTOOD domain
 * failures carry a code; a programming/validation fault stays a plain exception
 * the caller classifies by its own taxonomy (a RangeError → REQUEST_INVALID,
 * an otherwise-unrecognized fault → INTERNAL).
 *
 * - `DECODE_FAILED` — source bytes could not be decoded to text (a core
 *   `DecodeError`, or a markup adapter's source decode).
 * - `PARSE_FAILED`  — a malformed container/markup the parser rejected.
 * - `CAP_EXCEEDED`  — an adapter or the central output/resource limit tripped.
 */
export type ExtractionFailureCode = 'DECODE_FAILED' | 'PARSE_FAILED' | 'CAP_EXCEEDED';

export class ExtractionFailure extends Error {
  constructor(
    readonly code: ExtractionFailureCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ExtractionFailure';
  }
}
