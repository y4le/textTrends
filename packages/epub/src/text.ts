import { EpubError } from './errors.js';

/** Strict UTF-8 decoding for EPUB package and XHTML documents. */
export function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new EpubError('INVALID_EPUB', `${label} is not valid UTF-8`, { cause: error });
  }
}
