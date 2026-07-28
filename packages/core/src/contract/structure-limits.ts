/**
 * Structure authoring limits — provisional bounds that must hold BEFORE the
 * correction UI can add sections (commit 8b, planner ruling §5). They bound the
 * three things ingest caps do not: the section-table size, the number of
 * override changes, and the lineage-key length — persisted/authoring bounds on
 * record size, independent of validation cost (validateSectionTable's overlap
 * check is O(n log n); the cap is a contract on what may be stored, not a
 * performance guard).
 *
 * A section-count violation (detected or final) is CAP_EXCEEDED (via
 * `StructureCapError`); malformed/colliding edits and over-long keys/changes
 * are ordinary `StructureError` → REQUEST_INVALID. PROVISIONAL like the recipes
 * and ingest caps: the numbers graduate only via a benchmark-backed amendment.
 */
export const STRUCTURE_LIMITS_V0 = {
  schema: 'texttrends/structure-limits/0-provisional',
  /** Sections per detected OR final table, INCLUDING the root. */
  maxSectionsPerTable: 2048,
  /** Declarative changes in one override. */
  maxOverrideChanges: 4096,
  /** UTF-16 code units in a lineage key (`sec-…`, `user-…`). */
  maxLineageKeyUtf16: 128,
  /** UTF-16 code units in a section title (= `MAX_TITLE_LENGTH`). */
  maxTitleUtf16: 512,
} as const;

