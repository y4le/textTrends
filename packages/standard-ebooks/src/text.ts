import { StandardEbooksError } from './errors.js';

/**
 * Strict UTF-8 decode of exact bytes. Lives apart from `http.ts` so the EPUB
 * extraction graph (the `/extract` subpath) never transitively imports the
 * catalog HTTP client — extraction is pure and network-free.
 */
export function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new StandardEbooksError('INVALID_RESPONSE', `${label} is not valid UTF-8`, {
      cause: error,
    });
  }
}
