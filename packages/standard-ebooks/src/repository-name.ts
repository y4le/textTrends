import { StandardEbooksError } from './errors.js';

/** GitHub repository-name grammar for Standard Ebooks source repositories. */
export const REPOSITORY_NAME = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u;

export function validateRepositoryName(value: string): string {
  if (!REPOSITORY_NAME.test(value)) {
    throw new StandardEbooksError(
      'INVALID_REPOSITORY',
      `Invalid Standard Ebooks repository name: ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/**
 * Map a Standard Ebooks ebook URL path to its GitHub source repository name:
 * `/ebooks/homer/the-odyssey/william-cullen-bryant` →
 * `homer_the-odyssey_william-cullen-bryant` (the documented slash-to-
 * underscore convention). A segment may itself contain `_` — multiple
 * translators share one segment, e.g. `louise-maude_aylmer-maude` — so the
 * mapping is not reversible; callers wanting certainty should confirm the
 * derived repository identifies as this path (its OPF `dc:identifier`).
 */
export function ebookPathToRepositoryName(path: string): string {
  const withoutPrefix = path.startsWith('/ebooks/') ? path.slice('/ebooks/'.length) : null;
  const segments = withoutPrefix === null ? [] : withoutPrefix.split('/');
  if (segments.length < 2 || segments.some((segment) => segment === '')) {
    throw new StandardEbooksError(
      'INVALID_REPOSITORY',
      `Not a Standard Ebooks ebook URL path: ${JSON.stringify(path)}`,
    );
  }
  return validateRepositoryName(segments.join('_'));
}
