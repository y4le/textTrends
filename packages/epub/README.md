# `@texttrends/epub`

Provider-neutral EPUB parsing and text extraction for textTrends. The package
has no catalog or network behavior: it accepts EPUB bytes and returns metadata,
reading-order sections, and deterministic text ranges.

```ts
import { extractEpub } from '@texttrends/epub';

const book = extractEpub(bytes, { partitions: ['bodymatter'] });
```

The v2 text policy uses declared front/body/back partitions when present.
When no spine document declares body matter, a body-matter selection includes
linear unclassified documents while excluding declared front/back matter. XHTML named entities decode before serialization;
table cells and disclosure headings retain word boundaries. Hidden elements,
iframe content, and navigation markers are excluded. Preformatted line breaks
survive while ordinary source wrapping collapses to spaces.

`maxExtractedBytes` bounds decompressed OPF and XHTML data (default 32 MiB).
ZIP32 stored/deflated members are checked incrementally against declared size,
remaining budget, and CRC; unsupported encryption/ZIP64 and duplicate requested
members fail. Repeated resolved spine paths fail before chapter inflation.

The lazy extraction pipeline holds one chapter's source and DOM at a time.
`maxTextUtf16` bounds selected output (default 32M units); uncertain fallback
content is retained within that cap and discarded once declared body matter
appears. `retainSectionText: false` leaves each section's `text` empty while
keeping metadata and ranges, avoiding a second retained copy in the worker.
DOM parsing defaults to 8 MiB per XML document, 100,000 `<` characters per
document, and 400,000 across the book. Optional parsing limits can reduce these
bounds. These conservative counts include comments and CDATA. Serializers use
an iterative walk, so deep nesting does not overflow the JavaScript stack. Invalid archives
and XML error/fatal diagnostics (including unknown entities)
throw `EpubError` with `INVALID_EPUB`; parser warnings remain accepted; size-limit failures use `CAP_EXCEEDED`.

This is a private workspace package. Build it from the repository root with
`pnpm build:packages` after `pnpm install`. Import only its declared root export.
The package returns section metadata; the app's [analysis contract](../../docs/design/analysis-contract.md)
joins selected text into one analytical document.

[Public types](src/types.ts) and [extraction options](src/ebook-text.ts) define
the package surface. [Development](../../docs/development.md) lists repository checks.

XML admission also caps each tag at 65,536 UTF-16 units, each tag at 256
attributes, and each document at 50,000 attributes before DOM construction.
This bounds the parser's quadratic attribute lookup; quoted values, comments
and CDATA do not count as attributes; bare attribute names count toward the limit.
