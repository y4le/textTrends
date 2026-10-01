/** Browser persistence identities shared by the UI diagnostics and worker
 * adapter without creating a lib/ ↔ worker/ dependency. */
export const ARTIFACT_DB_NAME = 'texttrends-artifacts-provisional-db5';
export const ARTIFACT_DB_VERSION = 1;
/** Exact names owned by older layouts; never match arbitrary database prefixes. */
export const SUPERSEDED_ARTIFACT_DB_NAMES = Object.freeze([
  'texttrends-artifacts-index0-provisional-db1',
  'texttrends-artifacts-provisional-db2',
  'texttrends-artifacts-provisional-db3',
  'texttrends-artifacts-provisional-db4',
]);
export const ARTIFACT_DB_NAMES = Object.freeze([ARTIFACT_DB_NAME, ...SUPERSEDED_ARTIFACT_DB_NAMES]);

/** Historical durable stores, removed only by an explicit full reset. */
export const SUPERSEDED_DURABLE_DB_NAMES = Object.freeze([
  'texttrends-user-data',
  'texttrends-standard-ebooks-cache-v1',
  'texttrends-local-library',
]);
