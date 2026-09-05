# textTrends

textTrends is a browser-local workbench for finding patterns in an ordered
collection of texts and opening the passages behind them. Track terms in
Trends, read their contexts in Matches, explore Vocabulary, compare texts or
ranges, and read through Read, Atlas, or Speed.

**Status: active pre-alpha.** One workspace is saved in this browser; imported
text and analysis are never uploaded. Prepared samples load from the app's
host. The optional Standard Ebooks catalog downloads source archives from
GitHub. There is no account, synchronization, result-download UI, or workspace
backup UI.

## Run locally

Requires Node 22.12+ and pnpm 10.19.0. All workspace packages are in this repo.

```sh
pnpm install
pnpm dev
```

Open the printed Vite URL under `/textTrends/`. In Inputs, choose **Import and
analyze** for a TXT, Markdown, HTML/XHTML, or EPUB file, then add a term to track.
PDF is not supported.

## Documentation

- [Follow a word into its source](docs/tutorial.md): a short first lesson with
  a reproducible text and result.
- [Work with texts and terms](docs/how-to.md): import, compose a corpus, find a
  passage, compare a range, and recover saved work.
- [Workbench reference](docs/reference.md): query syntax, controls, settings,
  storage, and limits.
- [Interpret the measurements](docs/explanation.md): what positions, rates,
  dispersion, and comparison evidence mean.
- [Develop and verify changes](docs/development.md): repository layout, checks,
  browser testing, corpus refresh, and deployment.
- [Internal design index](docs/design/README.md): current contracts,
  architecture, measurement evidence, and open work.
- [Corpus sources](text/README.md): editions, extraction, and provenance.

The repository includes private-use corpora and a common-word resource whose
redistribution provenance is unresolved. Repository licensing and the
[publication cut](docs/design/corpus-inventory.md) remain open; the current tree
is not a cleared public distribution.
