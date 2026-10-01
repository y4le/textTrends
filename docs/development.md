# Develop and verify changes

Use Node 24 and pnpm 10.19.0 from the repository root, matching CI. Compiled
packages support Node 22.12+, but direct `.ts` harness commands require native
type stripping (Node 22.18+ or Node 24).

```sh
pnpm install
pnpm dev
```

The app runs under `/textTrends/`; open the URL printed by Vite. Workspace
packages are local dependencies. Vite and Vitest resolve the workspace-only
`source` export condition for EPUB and Standard Ebooks, so targeted tests and
web builds use current TypeScript without needing a package rebuild. Native
Node scripts and package consumers use the compiled default exports; run
`pnpm build:packages` before those entry points. The dev launcher also builds
and watches the compiled exports for those consumers; Ctrl-C stops its server
and watcher together. No-emit typechecks use source; package emit builds use
default exports and TypeScript project references.

## Repository map

| Path | Responsibility |
| --- | --- |
| `apps/web` | React workbench, persistence, worker adapter, browser tests |
| `packages/core` | Portable extraction contracts, indexing, analysis kernels |
| `packages/epub` | Provider-neutral EPUB parsing and extraction |
| `packages/extractors` | Lazy TXT, Markdown, HTML, and EPUB dispatch |
| `packages/standard-ebooks` | Provider catalog, network, and source-archive policy |
| `packages/rsvp` | Framework-free Speed framing, pacing, source adaptation, playback planning |
| `packages/cli` | Node portability and benchmark harness |
| `scripts` | Corpus/catalog refresh, bundle checks, card generation, dev launcher |
| `text` | Development corpus sources and integrity manifests |
| `docs/design` | Internal contracts and decisions |

Consume package export maps; do not import another package's `src` internals.
[EPUB](../packages/epub/README.md) and
[Standard Ebooks](../packages/standard-ebooks/README.md) describe their APIs.
The [design index](design/README.md) maps implementation changes to contracts.

## Verify a change

```sh
pnpm test
pnpm build
pnpm e2e
```

`test:source` runs source-dependent suites without building compiled artifacts;
CI runs it first on a clean checkout to guard source resolution. `test` builds
compiled packages, runs script tests, then Vitest. `build` runs
recursive typechecks, produces the normal web bundle, and enforces its byte
budget and lazy-module boundaries. Use `pnpm typecheck` for a standalone type
check or `pnpm check:bundle` against an existing normal production build.

Install browser binaries before the first local browser run:

```sh
pnpm --filter @texttrends/web exec playwright install chromium webkit
```

On Linux, Playwright may also require its native browser dependencies.
The configured projects use a production-shaped e2e build and a separate
strict loopback port (43173 by default; override with `TT_E2E_PORT`). They never
reuse an existing dev server.

| Command | Coverage |
| --- | --- |
| `pnpm --filter @texttrends/web e2e:functional` | Chromium semantic browser suite |
| `pnpm --filter @texttrends/web e2e:viewport` | Compact WebKit filename allowlist |
| `pnpm --filter @texttrends/web e2e:bench` | Isolated Chromium timing suite without dependencies |
| `pnpm e2e` | Functional and WebKit projects, then the serial benchmark project |

Run browser commands sequentially in one checkout. Each rebuilds
`apps/web/dist`; concurrent production/browser builds can invalidate a run.
New compact specs must be included in `playwright.config.ts`'s explicit
WebKit allowlist. Normal production builds exclude the e2e protocol facade.

For docs-only changes, check relative links, code-path references, commands,
and `git diff --check`. Run behavioral suites when documented behavior is being
changed or needs verification; do not preserve incidental old test totals as
current project facts.

## Test through a tailnet URL

`pnpm dev:tailnet` uses the separately installed `tailnet-dev-host` launcher.
It keeps Vite on loopback and registers
`https://<tailnet-host>/textTrends/` as a path-scoped route. The launcher prints
the exact URL and removal command. Use that HTTPS URL for live reload; its HMR
configuration targets the tailnet endpoint. Other project routes can coexist.

## Measure performance

The Node harness runs directly from TypeScript:

```sh
node --expose-gc packages/cli/src/main.ts bench text/sherlock
node --expose-gc packages/cli/src/main.ts bench-occurrences text/ASOIF
node --expose-gc packages/cli/src/main.ts bench-company text/sherlock
node --expose-gc packages/cli/src/main.ts bench-destinations text/sherlock
```

For reproducible synthetic worker-engine tiers (Node 24), run:

```sh
node apps/web/bench/scale.mjs 1000000,10000000,50000000 /tmp/texttrends-scale.json
```

The parent records each product-cap admission and runs an explicitly labelled
engine-cap override when admission rejects a tier. This does not change product
limits. The [method and limitations](design/benchmarks.md#synthetic-engine-scale-september-8-2026)
explain the source fixture, cold ingest clock, warm query samples and RSS fields.

The occurrence harness measures successful near-cap construction and typed cap
rejection; phase-local RSS sampling requires Linux `/proc`. Use
[benchmark methodology and gates](design/benchmarks.md) before interpreting a
sample or proposing streaming/WASM work.

## Refresh acquired resources

These commands download source material and update checked-in data. Review
source text, integrity manifests, and generated modules together.

| Command | Resource |
| --- | --- |
| `pnpm update:sherlock-corpus` | Nine-volume Sherlock corpus |
| `pnpm update:austen-corpus` | Six Austen novels |
| `pnpm update:supplemental-corpus` | Ten Classic Novels |
| `pnpm update:demo-corpora -- <target>` | `bible`, `quran`, `political`, `shakespeare`, `inaugurals`, `darwin`, or `classics`; omit target for all seven |
| `pnpm update:se-catalog` | Baked Standard Ebooks catalog |
| `pnpm update:stoplist` | Bounded worker module from the locked common-word ranking; no network refresh |

[Corpus sources](../text/README.md) owns edition and extraction provenance.
[Publication constraints](design/corpus-inventory.md) also cover generated
resource derivatives. Card generation is described in
[the card contract](design/card-svg.md).

## Deployment

The workflow in `.github/workflows/ci.yml` checks pull requests and pushes to
`master`. Successful master checks, browser suites, and isolated benchmarks
permit deployment of the checked production artifact to GitHub Pages. Browser
jobs build their own e2e artifacts on isolated runners. The deployment base is
`/textTrends/`.

A cleared public release still needs the owner-led publication and licensing
cut in the [roadmap](design/current-roadmap.md); passing CI does not perform it.
