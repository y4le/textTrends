// @texttrends/extractors — the source-extraction runtime for the transformed
// formats (EPUB, HTML). `extractSource` is the ONE entry point the web worker
// and a future Node CLI share: it dispatches literal vs. transformed by the core
// format catalog, runs the decode/extract phases with an awaitable
// ownership/cancellation gate, and holds every path to the per-document text
// cap, routing all output through @texttrends/core's canonical artifact builder.
// The heavy parsers (parse5, the standard-ebooks zip/XML reader) are DYNAMICALLY
// imported so they stay lazy chunks — a txt/md user never loads them.
//
// Core stays zero-DOM / zero-archive-dependency; this package is where the
// runtime parsers live.

export { extractSource, type ExtractionHooks, type ExtractionLimits } from './extract-source.ts';
export { ExtractionFailure, type ExtractionFailureCode } from './failure.ts';
