/**
 * Ingest caps — contract §12.9 (concrete provisional values). ONE shared
 * constant, checked BOTH main-side before transfer (File.size, document count
 * — reject before reading) and worker-side (received byte length, decoded
 * UTF-16 length, cumulative project totals over the generation's declared
 * docs). A violation is CAP_EXCEEDED, never an OOM-shaped INTERNAL error.
 *
 * The project byte cap closes the transfer-guard gap: without it, 128
 * individually-legal 32 MiB files could be read and transferred before any
 * text total constrains them.
 *
 * Byte caps vs text caps — what `byteLength` actually bounds: for byte-decoded
 * formats (txt/md) and single-document markup (html), the extracted UTF-16
 * length is at most `byteLength` (decoding and tag/entity stripping never
 * expand beyond the source bytes), so a byte sum soundly bounds undetermined
 * text. For COMPRESSED CONTAINERS (epub) it does NOT: decompression can yield
 * text far larger than the archive, so the source-byte caps are only a
 * transfer / zip-bomb guard there. The AUTHORITATIVE per-document and project
 * text caps are therefore enforced worker-side on ACTUAL decoded lengths at
 * ingest/publish (an over-large doc fails with CAP_EXCEEDED and degrades to a
 * missing doc; prior docs stand). A fresh import's preflight, which lacks a
 * decoded length and falls back to `byteLength`, is thus a best-effort early
 * guard — exact for txt/md/html, an underestimate for a fresh epub — never the
 * final authority.
 *
 * PROVISIONAL, like the recipes: the schema graduates only via an amendment;
 * the numbers are grounded in benchmarks.md (2026-07-19/20).
 */
export const INGEST_CAPS_V0 = {
  schema: 'texttrends/ingest-caps/0-provisional',
  maxSourceBytesPerFile: 32 * 1024 * 1024, // 32 MiB
  maxProjectSourceBytes: 128 * 1024 * 1024, // 128 MiB — transfer guard
  maxTextUtf16PerDoc: 32 * 1024 * 1024, // 32M code units
  // 128 preserves canonical 66-book Bible and 114-surah Quran corpora.
  maxDocsPerProject: 128,
  maxProjectTextUtf16: 64 * 1024 * 1024, // 64M code units
  /** The total DECOMPRESSED archive bytes a container extractor (epub) may read
   *  — a zip-bomb guard on INPUT, distinct from the output text cap. A compressed
   *  container inflates well past its source byteLength, so this is its own named
   *  unit (was a hidden `maxTextUtf16PerDoc * 4`). HTML/txt/md do not consume it. */
  maxArchiveInflatedBytesPerDoc: 128 * 1024 * 1024, // 128 MiB
} as const;

export type IngestCapsV0 = typeof INGEST_CAPS_V0;
