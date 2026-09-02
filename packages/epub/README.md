# `@texttrends/epub`

Provider-neutral EPUB parsing and text extraction for TextTrends. The package
has no catalog or network behavior: it accepts EPUB bytes and returns metadata,
reading-order sections, and deterministic text ranges.

```ts
import { extractEpub } from '@texttrends/epub';

const book = extractEpub(bytes, { partitions: ['bodymatter'] });
```

`maxExtractedBytes` bounds decompressed OPF and XHTML data. Invalid archives
throw `EpubError` with `INVALID_EPUB`; size-limit failures use `CAP_EXCEEDED`.
