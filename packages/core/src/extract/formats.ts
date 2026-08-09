/**
 * The closed, DATA-ONLY source-format catalog — the ONE authority for which
 * source formats exist and their environment-neutral metadata (filename
 * extensions, extraction kind, and descriptor source-kind). Every other format decision derives from here: filename →
 * format, the wire's membership check, the file-picker accept list, and
 * per-format recipe selection.
 *
 * It holds NO executable dispatch (the EPUB/HTML adapters live in
 * @texttrends/extractors) and NO recipe closures (core owns the default
 * recipes in extraction.ts). This keeps the catalog a plain, frozen data
 * contract the whole app — main thread, worker, and a future CLI — can share.
 */

export interface SourceFormatMetadata {
  /** Lower-case filename extensions (with the leading dot), unique
   *  case-insensitively across the WHOLE catalog. The first entry is canonical. */
  readonly extensions: readonly string[];
  /** Whether the indexed text IS the byte-decoded source (`literal`, txt/md) or
   *  is EXTRACTED from an archive/markup tree (`transformed`, epub/html). */
  readonly extractionKind: 'literal' | 'transformed';
  /** The `SourceDescriptor` discriminant this format produces. */
  readonly sourceKind: 'text' | 'container' | 'markup';
}

/** Freeze the catalog (records AND extension arrays) and assert every extension
 *  is unique case-insensitively — a collision would make filename → format
 *  ambiguous. A plain frozen object, never a Set (`Object.freeze(new Set())`
 *  does not disable `.add`). */
export function defineSourceFormats<T extends Record<string, SourceFormatMetadata>>(catalog: T): Readonly<T> {
  const seen = new Set<string>();
  for (const meta of Object.values(catalog)) {
    for (const ext of meta.extensions) {
      const key = ext.toLowerCase();
      if (seen.has(key)) throw new Error(`duplicate source-format extension '${ext}'`);
      seen.add(key);
    }
    Object.freeze(meta.extensions);
    Object.freeze(meta);
  }
  return Object.freeze(catalog);
}

export const SOURCE_FORMATS = defineSourceFormats({
  txt: { extensions: ['.txt'], extractionKind: 'literal', sourceKind: 'text' },
  md: { extensions: ['.md', '.markdown'], extractionKind: 'literal', sourceKind: 'text' },
  epub: { extensions: ['.epub'], extractionKind: 'transformed', sourceKind: 'container' },
  html: { extensions: ['.html', '.htm', '.xhtml'], extractionKind: 'transformed', sourceKind: 'markup' },
});

/** The closed set of supported formats — the discriminant of the recipe union
 *  and the SourceDescriptor. Derived from the catalog so the two cannot drift. */
export type SourceFormat = keyof typeof SOURCE_FORMATS;

/** The format ids as a readonly list (declaration order). */
export const SOURCE_FORMAT_IDS: readonly SourceFormat[] = Object.freeze(
  Object.keys(SOURCE_FORMATS) as SourceFormat[],
);

/** The membership predicate the wire boundary and any untrusted input use. */
export function isSourceFormat(value: unknown): value is SourceFormat {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(SOURCE_FORMATS, value);
}

/** The formats whose indexed text IS the byte-decoded source — DERIVED from
 *  the catalog's `extractionKind` (type and predicate alike), so a new format
 *  cannot drift between the two. */
export type LiteralSourceFormat = {
  [F in SourceFormat]: (typeof SOURCE_FORMATS)[F]['extractionKind'] extends 'literal' ? F : never;
}[SourceFormat];

export function isLiteralFormat(format: SourceFormat): format is LiteralSourceFormat {
  return SOURCE_FORMATS[format].extractionKind === 'literal';
}

/** Longest matching known extension so any hypothetical overlapping suffix is
 *  unambiguous. */
function matchedExtension(name: string): { format: SourceFormat; ext: string } | null {
  const lower = name.toLowerCase();
  let best: { format: SourceFormat; ext: string } | null = null;
  for (const format of SOURCE_FORMAT_IDS) {
    for (const ext of SOURCE_FORMATS[format].extensions) {
      if (lower.endsWith(ext) && (best === null || ext.length > best.ext.length)) {
        best = { format, ext };
      }
    }
  }
  return best;
}

/** The format whose extension the filename carries (case-insensitive), or null. */
export function sourceFormatForFilename(name: string): SourceFormat | null {
  return matchedExtension(name)?.format ?? null;
}

/** Strip a known source extension to derive a default title; returns the
 *  original name if no known extension matches or stripping would empty it. */
export function stripSourceExtension(name: string): string {
  const match = matchedExtension(name);
  if (match === null) return name;
  return name.slice(0, name.length - match.ext.length) || name;
}
