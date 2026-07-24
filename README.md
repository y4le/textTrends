# textTrends

A local-first corpus reading workbench: analyze and visualize large bodies of text —
novels, series, any corpus — across many dimensions, entirely in your browser. Nothing
you load ever leaves your machine.

The spine of the app is **narrative time**: position within a chapter, a book, a
series. Term-group trends, dispersion barcodes, keyword-in-context concordance,
comparison and keyness, character sheets — every chart links back to the passages that
produced it.

**Status: total rewrite in progress.** The previous app is preserved on the
[`legacy`](../../tree/legacy) branch and still serves at
[lordchair.github.io/textTrends](http://lordchair.github.io/textTrends/).

## Repository layout

- `docs/research/` — the research stage: synthesized findings, decisions, and the raw
  research inputs (start with `synthesis.md`)
- `docs/design/` — design-stage contracts (start with `analysis-contract.md`)
- `packages/core` — the analysis engine: environment-agnostic TypeScript (tokenizer,
  positional index, analysis passes)
- `packages/extractors` — transformed-format extraction (epub, html): the lazy-loaded
  parsers and the one `extractSource` runtime, outside core by design
- `packages/cli` — Node benchmark/portability harness over the core (a real
  distributable CLI comes later)
- `apps/web` — the webapp: React + hand-rolled SVG, Vite
- `text/` — sample corpora (see `text/README.md` for provenance)

## Development

```sh
pnpm install
pnpm dev        # run the webapp
pnpm test       # run all workspace tests
pnpm typecheck  # strict TS across the workspace
```
