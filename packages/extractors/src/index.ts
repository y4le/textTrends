// @texttrends/extractors — source-extraction adapters for the transformed
// formats (EPUB, HTML). Each adapter turns source bytes into a `transformed`
// PreparedExtraction and routes it through @texttrends/core's ONE canonical
// artifact builder (`finalizeExtraction`); it never hand-assembles an artifact.
// The heavy parsers (parse5, the standard-ebooks zip/XML reader) are DYNAMICALLY
// imported so they stay lazy chunks — a txt/md user never loads them.
//
// Core stays zero-DOM / zero-archive-dependency; this package is where the
// runtime parsers live so both the web worker and a future Node CLI can share
// one extraction path.

export { extractEpubDocument } from './epub-extract.ts';
export { extractHtmlDocument } from './html-extract.ts';
export { TransformedExtractionError } from './transformed-extract.ts';
