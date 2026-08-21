# textTrends

textTrends is a local-first corpus reading workbench for studying narrative
position across a book or an ordered series. Imported text is extracted,
indexed, queried, and stored in the browser; it is not uploaded to an analysis
service.

The current workbench supports:

- TXT, Markdown, HTML/XHTML, and EPUB corpora, plus the bundled Sherlock
  Holmes and Jane Austen corpora;
- a persistent local file catalog with ordered active corpora;
- vocabulary frequency, document dispersion, comparison, and keyness;
- term-group trends, exact-or-density dispersion barcodes, linked ranges, and
  merged keyword matches shown in context;
- a full-page canonical-text Reader with query highlights; and
- one durable workspace containing the active corpus, notebook, and
  analysis-view settings.

The optional Standard Ebooks catalog is the one deliberate content-network
path: opening the catalog loads a baked same-origin index, and adding a title
downloads its source archive from GitHub. User-imported books and analysis
results remain browser-local.

**Status: active rewrite.** The current architecture is functional and covered
by unit and browser suites, while publication hardening remains open. See the
[current roadmap](docs/design/current-roadmap.md)
for the shipped/in-progress/deferred boundary. The retained design documents
describe current contracts and decisions rather than implementation history.

## Repository layout

- `apps/web` — React workbench, browser persistence, worker adapter, and
  Playwright coverage
- `packages/core` — environment-independent indexing and analysis kernels
- `packages/extractors` — lazy TXT/Markdown/HTML/EPUB extraction boundary
- `packages/standard-ebooks` — browser-first Standard Ebooks archive and
  extraction client
- `packages/cli` — Node portability and benchmark harness
- `docs/design` — current contracts, decisions, benchmarks, and roadmap
- `text` — development corpora; read `text/README.md` before redistribution

Every workspace dependency is contained in this repository, so a clean
checkout is sufficient for local development and CI.
`packages/standard-ebooks` remains an independent package boundary: consumers
use only its declared `.`, `./extract`, and `./archive` exports, never its
`src` internals.

Pushes to `master` run the full CI suite and, after it passes, publish the web
app to GitHub Pages. Pull requests run the same checks without deploying.

## Development

Requires Node 22.12+ and pnpm 10.19.

```sh
pnpm install
pnpm dev
pnpm typecheck
pnpm test
pnpm build
pnpm --filter @texttrends/web e2e:functional
pnpm --filter @texttrends/web e2e:viewport
```

Run the occurrence stress harness with:

```sh
node --expose-gc packages/cli/src/main.ts bench-occurrences text/ASOIF
```

It exercises both successful near-cap construction and typed cap rejection.
On Linux it also samples child-process RSS only during those phases; elsewhere
the output marks the memory gate untested. Benchmark methodology and promotion
thresholds live in `docs/design/benchmarks.md`.
