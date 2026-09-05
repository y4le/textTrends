# `@texttrends/epub`

Provider-neutral EPUB parsing and text extraction for textTrends. The package
has no catalog or network behavior: it accepts EPUB bytes and returns metadata,
reading-order sections, and deterministic text ranges.

```ts
import { extractEpub } from '@texttrends/epub';

const book = extractEpub(bytes, { partitions: ['bodymatter'] });
```

`maxExtractedBytes` bounds decompressed OPF and XHTML data. Invalid archives
throw `EpubError` with `INVALID_EPUB`; size-limit failures use `CAP_EXCEEDED`.

This is a private workspace package. Build it from the repository root with
`pnpm build:packages` after `pnpm install`. Import only its declared root export.
The package returns section metadata; the app's [analysis contract](../../docs/design/analysis-contract.md)
joins selected text into one analytical document.

[Public types](src/types.ts) and [extraction options](src/ebook-text.ts) define
the package surface. [Development](../../docs/development.md) lists repository checks.
