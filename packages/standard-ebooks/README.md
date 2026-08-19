# `@texttrends/standard-ebooks`

Browser-first TypeScript client for browsing the
[Standard Ebooks](https://standardebooks.org/) catalog and extracting analysis-ready text
from its EPUBs. It works in static webapps and Node without an application server.

## Monorepo boundary

This workspace owns Standard Ebooks HTTP/catalog policy, EPUB/archive parsing,
and its public types. Other textTrends packages consume only the export map in
`package.json` (`.`, `./extract`, and `./archive`); `src` is private to this
package. Keep its build, tests, and dependency declarations package-local so it
can evolve without leaking implementation details into the app or core.

## Install

```sh
pnpm add @texttrends/standard-ebooks
```

## Quick start

```ts
import { StandardEbooksClient } from '@texttrends/standard-ebooks';

const ebooks = new StandardEbooksClient();

const catalog = await ebooks.listEbooks();
const frankenstein = catalog.books.find(
  ({ name }) => name === 'mary-shelley_frankenstein',
);

if (frankenstein) {
  const book = await ebooks.downloadEbookText(frankenstein);

  console.log(book.metadata.fullTitle);
  console.log(book.text);     // Body matter, joined with blank lines
  console.log(book.sections); // Every spine document, in reading order
}
```

Use `catalogPages()` when the UI should render incrementally:

```ts
for await (const page of ebooks.catalogPages()) {
  renderBooks(page.books);
  showRateLimit(page.rateLimit);
}
```

`downloadEbookText()` accepts either a catalog entry or a repository name. It downloads the
official release EPUB by default and falls back to current repository XHTML when necessary.

```ts
const controller = new AbortController();
const book = await ebooks.downloadEbookText('mary-shelley_frankenstein', {
  partitions: ['frontmatter', 'bodymatter', 'backmatter'],
  signal: controller.signal,
});
```

`book.text` contains only the requested partitions. `book.sections` always contains every
spine document with its title, semantic types, source path, extracted text, and half-open
UTF-16 range in `book.text`; excluded sections have a `null` range. Inspect `book.source` and
`book.warnings` to detect a release fallback.

Use `{ source: 'repository' }` only when current, unreleased source is required. It makes one
request per spine document and is substantially more expensive than downloading the EPUB.

## Responsible use

- Cache catalog pages and extracted books; refresh on user action instead of polling.
- Prefer `catalogPages()` and stop when enough results have loaded.
- Do not prefetch every EPUB. Keep intentional batch downloads at low concurrency.
- Honor `page.rateLimit.remaining` and `resetAt`. On `RATE_LIMITED`, wait until reset instead
  of retrying immediately.
- Never bundle a GitHub token in a static app. Accept one from the user at runtime or use an
  authenticated server-side proxy.
- Use `AbortSignal` to cancel obsolete searches and downloads.

Standard Ebooks states that its editorial work is CC0 and its source texts are in the U.S.
public domain. Preserve `book.metadata.rights` and evaluate copyright in the user's country.

## Errors and development

Failures are `StandardEbooksError` instances with a stable `code`, including `RATE_LIMITED`,
`ABORTED`, `CAP_EXCEEDED`, `HTTP_ERROR`, and `INVALID_EPUB`.

```sh
pnpm install
pnpm check
pnpm test:live # Opt-in live Frankenstein integration test
```
