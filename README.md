# textTrends

textTrends is a local-first corpus reading workbench for studying narrative
position across a book or an ordered series. Imported text is extracted,
indexed, queried, and stored in the browser; it is not uploaded to an analysis
service.

The current workbench supports:

- TXT, Markdown, HTML/XHTML, and EPUB corpora, plus the bundled Sherlock
  Holmes corpus;
- a persistent local file catalog with ordered active corpora;
- vocabulary frequency, document dispersion, comparison, and keyness;
- term-group trends, exact-or-density dispersion barcodes, linked ranges, and
  a merged keyword-in-context concordance;
- a full-page canonical-text Reader with query highlights; and
- one durable workspace containing the active corpus, notebook, and
  analysis-view settings.

The optional Standard Ebooks catalog is the one deliberate content-network
path: opening the catalog loads a baked same-origin index, and adding a title
downloads its source archive from GitHub. User-imported books and analysis
results remain browser-local.

**Status: active rewrite.** The current architecture is functional and covered
by unit and browser suites, while publication hardening and a hermetic external
dependency remain open. See the [current roadmap](docs/design/current-roadmap.md)
for the shipped/in-progress/deferred boundary. The retained design documents
describe current contracts and decisions rather than implementation history.

## Repository layout

- `apps/web` — React workbench, browser persistence, worker adapter, and
  Playwright coverage
- `packages/core` — environment-independent indexing and analysis kernels
- `packages/extractors` — lazy TXT/Markdown/HTML/EPUB extraction boundary
- `packages/cli` — Node portability and benchmark harness
- `docs/design` — current contracts, decisions, benchmarks, and roadmap
- `text` — development corpora; read `text/README.md` before redistribution

The root workspace currently enrolls a sibling `../standard_ebooks` checkout.
That is an acknowledged clean-checkout blocker, not an implicit npm
dependency. See the roadmap before setting up CI or a public distribution.

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
