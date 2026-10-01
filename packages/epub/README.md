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

`maxExtractedBytes` bounds decompressed OPF and XHTML data. Invalid archives
and XML error/fatal diagnostics (including unknown entities)
throw `EpubError` with `INVALID_EPUB`; parser warnings remain accepted; size-limit failures use `CAP_EXCEEDED`.

This is a private workspace package. Build it from the repository root with
`pnpm build:packages` after `pnpm install`. Import only its declared root export.
The package returns section metadata; the app's [analysis contract](../../docs/design/analysis-contract.md)
joins selected text into one analytical document.

[Public types](src/types.ts) and [extraction options](src/ebook-text.ts) define
the package surface. [Development](../../docs/development.md) lists repository checks.
