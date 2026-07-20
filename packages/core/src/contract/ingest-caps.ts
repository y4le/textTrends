/**
 * Ingest caps — contract §12.9 (concrete provisional values). ONE shared
 * constant, checked BOTH main-side before transfer (File.size, document count
 * — reject before reading) and worker-side (received byte length, decoded
 * UTF-16 length, cumulative project totals over the generation's declared
 * docs). A violation is CAP_EXCEEDED, never an OOM-shaped INTERNAL error.
 *
 * The project byte cap closes the transfer-guard gap: without it, 64
 * individually-legal 32 MiB files could be read and transferred before any
 * text total constrains them. Every supported encoding decodes to at most
 * `byteLength` UTF-16 units, so the byte sum is also a sound upper bound on
 * undetermined text lengths.
 *
 * PROVISIONAL, like the recipes: the schema graduates only via an amendment;
 * the numbers are grounded in benchmarks.md (2026-07-19/20).
 */
export const INGEST_CAPS_V0 = {
  schema: 'texttrends/ingest-caps/0-provisional',
  maxSourceBytesPerFile: 32 * 1024 * 1024, // 32 MiB
  maxProjectSourceBytes: 128 * 1024 * 1024, // 128 MiB — transfer guard
  maxTextUtf16PerDoc: 32 * 1024 * 1024, // 32M code units
  maxDocsPerProject: 64,
  maxProjectTextUtf16: 64 * 1024 * 1024, // 64M code units
} as const;

export type IngestCapsV0 = typeof INGEST_CAPS_V0;
