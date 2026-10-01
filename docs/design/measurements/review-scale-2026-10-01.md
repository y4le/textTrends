# Review validation and scale — October 1, 2026

Dated local evidence for the September review changes, on Linux aarch64 with
20 logical CPUs, Node 24.14.1 and pnpm 10.19.0. This records measurements and
their limits; the [analysis](../analysis-contract.md),
[application](../architecture/application-composition.md),
[Matches](../continuous-matches.md), [Reader](../spatial-reader.md),
[Speed](../rsvp-reader.md), and [statistics](../statistics.md) contracts own
behavior. Private-corpus work was excluded. No corpus refresh was executed.

## Verification

Final results and raw samples are recorded in
[review-scale-2026-10-01.json](review-scale-2026-10-01.json).

| Check | Result |
| --- | --- |
| All workspace type checks | Pass |
| Vitest | 1,870 pass, 1 skip; 163 suites pass, 1 skip |
| Node script checks | 71 pass |
| Complete public Chromium functional project | 255 pass, 2 gated skips |
| Complete compact WebKit project | 111 pass, 16 gated skips |
| Isolated Chromium benchmark project | 16 pass |

The final matrices run at code revision `c1a5dff`, in separate checkouts on
strict ports 43173 and 43273. After the initial matrix exposed an Inputs
readiness/click race, the owning regression passed 10/10 across engines and
failed 6/6 against the old layout. The formerly failing WebKit Compare case
also passed 10/10 after the setup gate and product layout fixes.

The final normal production build excludes the e2e facade and passes its
transitive startup gate: 24 unique static chunks, 154,467 gzip bytes against a
160,000-byte budget. The entry is 83,588 gzip bytes against 90,000. Emitted CSS
keeps native logical insets; the gate rejects list `:lang()` lowering that
Chromium discards.

The complete public browser matrix uses production-shaped builds, one worker,
zero retries, and the configured Chromium and compact WebKit projects. The two
cases loading private corpora are excluded by name. Recovery, lazy-region and
workspace-backup checks were also repeated after preserving App's reload-error
lifetime in the shell extraction.

```sh
pnpm typecheck
pnpm exec vitest run
node --test 'scripts/*.test.mjs'
pnpm --filter @texttrends/web exec playwright test \
  --project=chromium-functional --workers=1 --retries=0 \
  --grep-invert 'demos load as additive local texts|a one-shot demo URL clears active research state'
pnpm --filter @texttrends/web exec playwright test --project=webkit-compact --workers=1 --retries=0
pnpm --filter @texttrends/web e2e:bench
pnpm build
```

Browser timing gates run separately, with no functional/review browser jobs
active, one worker, zero retries and tracing disabled. Continuous Matches
samples 48 animation frames after a fresh off-window refill, requires no blank
rows, and rejects long tasks of 100 ms or more. Functional checks own geometry,
corpus endpoints, synchronization, and fresh-window correctness.

## Publication burst

The [measurement driver](../../../apps/web/bench/review-scale.mjs) runs the real
worker engine in-process with shipped caps, full validation, and an initially
empty in-memory artifact store. It records messages without Worker-thread
transport, structured cloning, IndexedDB I/O or browser rendering.

The fixture contains 256 documents, 33,984 tokens each: 8,699,904 tokens and
60,899,328 ASCII/UTF-16 units. Four disjoint vocabulary bands yield 135,936
types (derived from the generator); 64 document identities share each source.
Each source is one sentence, so this is a publication scaling probe rather than
representative sentence-level prose. Every byte ingest still extracts and
indexes cold. No cap override or validation bypass is used.

Source/spec creation, module loading, begin-generation and GC precede the
clock. `coldMs` covers concurrent cold ingest and a drain tick. The interval
from first compose progress to final publication includes overlapping extraction
and indexing; it is not a pure composition clock. Any error or incomplete
final publication fails the run. Final snapshot identities were compared
between baseline and candidate and agree.

| Fresh process | Publications | All docs ready | Cold ingest | First compose to final publication |
| --- | ---: | ---: | ---: | ---: |
| Baseline `4a1ebcb` | 256 | 256 | 159,578 ms | 155,919 ms |
| Candidate `ce3ec8c` | 2 | 256 | 5,766 ms | 2,039 ms |

Both produce snapshot
`d11fd1867422b0ab4a4fdec4b11b206f4701f5f81e7ccb940498225916176126`.
This is one cold run per revision. The elapsed comparison includes batching
and canonical serialization changes together; publication count is the direct
batching result. It is not a device-independent latency guarantee.

Run the committed driver against separate checkouts, sequentially in fresh
processes. The pre-batching/serialization baseline is `4a1ebcb`; candidate code
is `ce3ec8c`.
Install dependencies with the frozen lockfile and run `pnpm build:packages`
in each checkout first; the Node driver uses the packages' default exports.

```sh
node --expose-gc --experimental-transform-types \
  apps/web/bench/review-scale.mjs publication /path/to/baseline
node --expose-gc --experimental-transform-types \
  apps/web/bench/review-scale.mjs publication .
```

## Serialization and retained buffers

Canonical serialization uses a fresh array of 92,000 strings, five warmups and
21 samples. Each sample times only the serializer; byte-equivalent JSON is
checked afterwards. Baseline `4a1ebcb` predates the fast path. These results do
not imply the review's suggested eightfold whole-publication speedup.

The residency control builds 256 documents of 33,984 tokens, composes and binds
them, then keeps ready documents, the bound corpus and binding session live.
The `copy` control retains the original ready shards as well as binding-owned
copies; `adopt` replaces each ready reference with the corresponding owned
shard. Both use the same current code. ArrayBuffer residency is sampled after
two event-loop turns and forced GC. This is retained typed-buffer evidence,
not peak RSS, total JS memory or a browser-tier result.

| Serializer | Median | Minimum | Maximum |
| --- | ---: | ---: | ---: |
| Baseline | 22.45 ms | 18.45 ms | 29.46 ms |
| Candidate | 15.87 ms | 13.91 ms | 22.40 ms |

The median falls by 29.3%, with identical 1,644,891 UTF-16 units of JSON.
The copy control retains 243,622,131 ArrayBuffer bytes (232.3 MiB); adoption
retains 122,299,251 bytes (116.6 MiB), a 49.8% reduction. Each has all 256 ready
and bound documents alive at measurement. Buffer counts exclude ordinary
objects and strings, and this controlled fixture repeats a four-word source.

```sh
node --expose-gc --experimental-transform-types \
  apps/web/bench/review-scale.mjs canonical /path/to/baseline
node --expose-gc --experimental-transform-types \
  apps/web/bench/review-scale.mjs canonical .
node --expose-gc --experimental-transform-types \
  apps/web/bench/review-scale.mjs residency . copy
node --expose-gc --experimental-transform-types \
  apps/web/bench/review-scale.mjs residency . adopt
```

## Public EPUB calibration

Moby Dick was the largest stored extracted text among the checked-in Sherlock,
Austen and Classic Novels pools (1,196,000 UTF-8 bytes). Its current official
[Standard Ebooks EPUB](https://standardebooks.org/ebooks/herman-melville/moby-dick/downloads/herman-melville_moby-dick.epub?source=download)
was downloaded to a temporary file, without replacing checked-in corpus data.
The archive is 1,165,523 bytes, SHA-256
`5d9c3ddb9d4cda136605ebfd1415f22fa30fd312872346bd8dda6be4c4c47d82`.
The remote URL is mutable; this hash identifies the measured edition.

After importing the freshly built parser, loading bytes and GC, a child signals
its baseline RSS. The parent samples Linux `/proc/<pid>/status` every 2 ms from
that signal through extraction completion, including the child's final RSS.
This sampled peak can miss shorter spikes. Process-lifetime `maxRSS` is not used.
Section text retention is disabled, matching worker extraction.

The isolated sample extracts 145 sections and 1,177,693 UTF-16 units in 118.3 ms.
Baseline RSS is 60.7 MiB, sampled peak 123.5 MiB, growth 62.8 MiB, with 57
phase samples. It succeeds under the parser's built-in limits, with source
bytes and extracted text well below the worker's per-file and per-document
caps. This parser-only phase excludes worker indexing, transport, and project
admission.

```sh
pnpm build:packages
node --expose-gc apps/web/bench/review-scale.mjs epub . /tmp/moby-dick.epub
```

One public book's admission and resource sample do not establish support for
all EPUBs or formal browser memory tiers. Physical-device, screen-reader and
browser-tier validation remain in the [roadmap](../current-roadmap.md).
