# textTrends rewrite — research synthesis

*2026-07-19. Synthesized from four parallel research streams: Codex (gpt-5.6-sol) via
parley, two Claude research agents (landscape survey, dependency survey — both
web-verified), and Claude's independent draft. Raw inputs preserved in
[`inputs/`](inputs/). This document is the reviewable proposal; nothing here is
committed until you sign off.*

---

## 1. Identity

All four streams converged on the same thesis independently:

> **textTrends is a local-first corpus reading workbench whose spine is narrative
> time.** Your texts stay on your device; every result traces back to passages in the
> text; every methodological choice is visible and saved.

Three commitments fall out of this:

- **Narrative time as the primary axis.** Most text tools treat a corpus as a bag of
  words; textTrends treats it as a *sequence* — position within a chapter, a book, a
  series. Narrative-time alignment across a series ("show me *winter* across all five
  books, aligned") is offered by none of the surveyed tools and is the identity
  feature.
- **Evidence, not just scores.** Every mark in every chart is a set of text positions.
  Click anything → keyword-in-context (KWIC) lines; brush any timeline → every panel
  filters to that span. A sentiment trough without its sentences is incomplete.
- **A reading instrument, not a dashboard.** Tufte throughout: sparkline tables, small
  multiples on shared scales, dispersion barcodes, direct labels, hairline rules, mono
  for data, one accent color. The source text itself is a first-class display surface.

Privacy as the *zero-install default* is ours alone among the surveyed tools: Voyant
does offer a local server mode, but it means installing and operating a Java/Docker
instance — textTrends is local-only in a browser tab, no server process, no upload.

## 2. Product principles

Distilled from Codex's report (the strongest framing of the four) plus the landscape
survey:

1. **Preprocessing is part of the result.** Never destructively clean text. Preserve
   source text and character offsets; store a versioned, reversible *recipe* (Unicode
   normalization, case folding, apostrophe/hyphen policy, stop list, analyzer version).
   Stop words affect ranked lists, never literal search or KWIC.
2. **Narrative time is three explicit coordinates**: relative position (percentile
   within a work — for comparing shapes), absolute token position, and declared ordered
   sequence across books. Equal-*token* bins by default (equal-character bins bias).
   Never silently stitch unrelated documents into a faux narrative.
3. **Raw data stays visible.** Raw counts beside rates per 10k tokens. Smoothing off by
   default; when on, keep a faint raw trace and name the method and window. Rolling
   mean/LOESS, never Fourier (the syuzhet lesson — low-pass filtering manufactures
   periodic "arcs").
4. **One selection model links the app.** Selecting a term, bin, document, entity, or
   matrix cell updates the same context pane and KWIC list. This is Voyant's one great
   lesson, done fast and universally.
5. **Language honesty.** The deterministic lexical core is Unicode/locale-aware
   (`Intl.Segmenter`). POS, NER, sentiment, readability are *language-pack* features —
   the UI disables what the active pack can't support rather than returning
   English-biased numbers.
6. **Results appear in tiers; nothing blocks on the full pipeline.** The user sees
   real data within seconds of dropping files — per-document stats stream in as each
   document is parsed, deeper analyses fill in behind them, and pending panels say
   what they're waiting on. No long ingest gap before the first chart.

## 3. Analyses

Analyses grouped by research priority; feasibility: nearly everything below Phase 4 is
pure-JS arithmetic over one positional index — **~85% of the value needs no ML at
all**. Note the delivered phasing was re-cut by the MVP decision (§8.6): the MVP pulls
forward a *bounded* character sheet (manually curated aliases; no wink pack) and the
emotional arc (which keeps its Experimental treatment even on the dashboard).

### Core (Phase 1 — the trustworthy lexical workbench)

| Analysis | Notes |
|---|---|
| Term-group frequency over narrative time | The heritage feature. Named groups OR-combining tokens, exact phrases, aliases, safe wildcards; per-query case/diacritic surface-form controls (lemma matching only when an active language pack provides lemmatization); regex opt-in and worker-isolated. Trend contract per §8.7: unsmoothed equal-token-bin rates by default, paired with the barcode; rolling mean/LOESS as a visibly parameterized optional overlay. |
| Dispersion barcode | Every occurrence as a tick on a strip (AntConc's best view). The honest, unsmoothed companion to every trend line; doubles as click-to-KWIC navigation and document minimap. |
| KWIC concordance + source reader | Fixed-width aligned contexts, sortable by L1/R1/R2… position, click-through to source with stable highlighting. The evidence layer under every chart. The table *is* the visualization. |
| Corpus inventory | Tokens, types, sentences, paragraphs; raw TTR and hapax counts (labeled as length-dependent); word/sentence/paragraph length distributions; vocabulary growth curve; frequency lists with document frequency, range, and dispersion columns. |
| Dispersion statistic | Gries' DP-norm per term — sortable on every word list; high-frequency + high-clumping automatically finds scene-specific vocabulary. |

### High value (Phase 2 — comparison & corpus linguistics)

| Analysis | Notes |
|---|---|
| Keyness (any A vs any B) | Log₂ ratio (0.5 continuity correction) as effect size **and** signed G² log-likelihood as evidence — they answer different questions; show both, plus counts and range. One-vs-rest and chapter-vs-chapter shortcuts. |
| Collocations | Window-based around a node; **log-Dice default** (PMI over-rewards rare pairs; offer MI/t-score for experts); L5…R5 positional profiles. |
| N-grams / repeated phrases | 2–5-grams with dispersion (a phrase used 40× in one chapter ≠ a stylistic tic); on-demand passes with min-count pruning, not precomputed. |
| Comparable vocabulary richness | MATTR (500-token window default) and MTLD — the length-robust measures; raw TTR stays descriptive only. Don't ship a dozen interchangeable indices. |
| Rank trajectories & bursts | Term rank per book across a series (bump chart); Poisson-surprise burst detection powering "notable moments." |
| Structure & rhythm | Sentence/paragraph length over narrative time, punctuation rates, chapter-length strips. Medians and tails, not just means. |

### Phase 3 — the English/literary pack (optional, lazy-loaded)

| Analysis | Notes |
|---|---|
| Entity registry & character tracking | The feature is a *reviewable registry*, not raw NER: suggested people/places from the NLP pack + user-curated alias groups ("Elizabeth"/"Lizzy"/"Miss Bennet"), merge/split/ignore, with surface-form evidence. Characters are term groups — the heritage feature *is* a character-arc tool. |
| Character co-occurrence | Edges from reviewed aliases within sentence/paragraph/window; reorderable adjacency matrix default (Bostock's Les Mis), ego node-link only for sparse selections. |
| The character sheet | Per character: mention arc, barcode, top collocates ("what verbs does she get?"), co-mention partners over time, dialogue share, sentiment-in-vicinity. Trivial pieces; a composition no tool offers. |
| Dialogue vs narration | Quote-pair heuristic with unmatched-quote rate as a confidence signal; % dialogue over narrative time. |
| Speaker attribution (tiered, reviewable) | Fully *automatic* attribution stays cut (needs coreference; research-grade). But a large share of fiction dialogue carries an explicit tag ("…," said Alice) attributable by a high-precision heuristic (speech verb + adjacent entity-registry name), and alternating two-party turns extend coverage. Design like the entity registry: auto-attribute with a confidence label, surface unattributed as a visible category (never silently guessed), let the user confirm/correct — corrections are evidence, not an edge case. |
| Character voice profiles | Falls out of attribution + keyness: per character — turn count and share of dialogue over narrative time, turn-length distribution, and *their* words (keyness of a character's attributed dialogue vs everyone else's: "what does Tyrion say that no one else does"). Voice keyness uses only confirmed/high-confidence turns and reports attribution coverage — a small error rate can otherwise manufacture a character's "distinctive" vocabulary. Joins the character sheet. |
| POS profiles | Adjective/adverb density over time, lexical density; worker-only, versioned tagset in provenance. |
| Readability | Flesch-Kincaid etc. — interesting *over narrative time / across a series*, not as an absolute score. English-pack only. |
| Stylometry | Function-word profiles; Burrows'/Cosine Delta distance matrix between books/chapters; rolling Delta within a text (stylistic drift). Cautious authorship language — edition/genre/period confound. |

### Phase 4 — experimental lab (visibly flagged, serialized with model/lexicon revision)

- **Sentiment/emotion arcs** — lexicon-based per-sentence scores aggregated in token
  windows; raw points behind the smoothed line; click a trough → the sentences that
  drove it ("receipts" — the honest answer to the syuzhet critique). Transformer
  sentiment as an optional slow lane. Noisy on fiction (irony, free indirect
  discourse); ship with caveats, never as core.
- **Segment similarity / recurring vocabularies** — capped TF-IDF matrix, deterministic
  clustering, representative passages. The modest honest version of "topics." No LDA.
- **Embeddings / semantic passage search** — transformers.js + MiniLM, dynamic import,
  bounded user-chosen scope, cached vectors. "Find passages like this one."
- **Near-duplicate/refrain detection** — MinHash/LSH over character shingles.
- **PDF ingestion** — pdf.js, second-class, with cleanup pass.

### Explicit cuts (consensus)

Word clouds, streamgraphs, pies/gauges, radar, 3D, force-directed hairballs, dual axes ·
in-browser LDA · full coreference and *opaque whole-corpus* speaker attribution (the
narrow reviewable-suggestion tier in Phase 3 is the permitted exception) · eager
whole-corpus embeddings · LLM interpretation or generated "themes" · OCR/DOCX · a plugin architecture
before the analyzer interface has two real implementations · dozens of redundant
metrics because formulas exist.

## 4. Visual grammar

Defaults, in order of preference: **tables first** (exact values) → **sparklines inside
tables** (the signature surface — nothing in Voyant/AntConc has it) → **small
multiples** on shared scales → **barcodes/rugs** for exact position → **direct-labeled
lines** (≤5–6 series, chapter boundaries as light rules, no legends ever) →
**dots/lollipops** for scalar comparison → **heatmaps** for bounded labeled matrices →
**ECDFs/compact histograms** for distributions → **adjacency matrices** before networks
→ horizon-chart toggle past ~15 aligned rows.

Color: most series gray; one accent marks the active selection; gray level, position,
and dash before additional hues; color never the sole encoding. Mono for token strings,
counts, and KWIC; proportional face for prose. Hover is supplementary — keyboard focus
and click expose the same information (accessibility is part of the evidence
environment).

**The axis is a place in the text.** Every narrative-time axis supports position →
passage: hovering (or keyboard-scrubbing) any x-position shows the raw text snippet at
that point — the `starts` offset array makes this a direct token-position → character-
offset → excerpt lookup, no search required. The snippet always shows the passage at
the selected token span — hits inside it are highlighted; if the span has no hit, the
nearest occurrence is offered *separately*, labeled with its distance, so evidence for
the indicated position is never silently swapped for evidence from elsewhere. Click
pins the snippet into the context pane (hover-only evidence is an anti-pattern), and
from there it opens the full reader. This generalizes chart↔KWIC linking from "marks are
clickable" to "the axis itself is readable."

Dense per-token strips render to 2D canvas with an SVG/HTML overlay for axes and labels;
everything else is hand-rolled SVG. Every chart has an exact-table fallback and SVG/CSV
export carrying its method metadata (denominator, window, corpus selection) — an export
without provenance is not reproducible.

## 5. App features

- **Corpus management**: drag/drop multi-file; explicit ordering into corpus → work →
  chapter/section; editable metadata (title, author, series position, tags, language);
  content-hash dedup; include/exclude without deleting. Chapter detection by evidence
  hierarchy: EPUB spine/nav & Markdown headings → user regex → conservative "Chapter
  XII" heuristics → fixed-token segments (labeled as artificial) — always previewed and
  user-correctable.
- **Formats**: .txt and .md core (encoding: BOM sniff → strict UTF-8 → windows-1252
  fallback, visible warnings); EPUB high-value (extract spine order + heading
  boundaries — real chapter structure for free; reject DRM; never mount book HTML);
  PDF stretch; OCR/DOCX cut.
- **Sample corpora**: bundle unencumbered public-domain texts (e.g. Austen, Dickens,
  Doyle — series where possible, since series alignment is the identity feature) as the
  default instant demo. The existing S3-hosted ASOIF/LOTR corpora stay available for
  now (owner decision 2026-07-19); revisit their standing before any public launch.
- **Term-group UX**: persistent query notebook; fast add from frequency table, KWIC, or
  reader selection; live per-group counts and sparklines; mute/solo/reorder; a method
  drawer showing normalization, denominator, bins, smoothing. Borrow Ngram Viewer's
  query legibility; skip a clever expression language in v1.
- **State & sharing**: two distinct products — (1) a compact versioned **share link**
  (groups, filters, view config, expected content hashes; never source text; recipient
  prompted to load matching files) and (2) a **portable project file** (ZIP: manifest,
  methods, groups, views, optionally sources — embedding sources is an explicit
  privacy/copyright choice). Zod-validated schemas with migrations.
- **Persistence — three storage classes**: (1) project metadata plus any source text
  the user chose to persist locally; (2) portable-project embedded sources (an explicit
  privacy/copyright opt-in); (3) derived indexes/annotations, content-hash-keyed.
  Only class 3 is evictable-and-recomputable, and "clear caches" touches only class 3;
  eviction is a mere performance event only while an available source remains. The UI
  shows storage per class, with "delete project/source" clearly separate.
- **Security**: never insert EPUB/HTML source as live HTML (detached parsing, text nodes
  only); treat project files, regex, and CSV cells as hostile input (formula-prefix
  neutralization); strict CSP; pinned model URLs with license/size disclosure before
  download.

## 6. Architecture

The center of gravity — unanimous across all four inputs:

```
ingest (stream, SHA-256) → parse (text + structure spans) → tokenize
(Intl.Segmenter, original offsets preserved) → index → aggregate → query → present

tokens:    Uint32Array — token IDs in corpus order     (1M tokens ≈ 4 MB)
starts:    Uint32Array — char offsets into source      (powers KWIC/reader)
vocab:     interned dictionary, Map + array
postings:  per-term sorted Uint32Array positions       (one counting-sort pass)
bounds:    document/chapter/sentence boundary indices
```

A few hundred lines, zero dependencies. KWIC = slice around postings; collocations =
window scan; narrative-time series = bucket positions against bounds; phrase queries =
postings intersection. Sizing and latency figures (tens of MB resident for a 5M-char
series; ms-scale interactive passes; the LOC estimate itself) are **hypotheses with
stated corpus/hardware assumptions, to be measured in Phase 0** against the benchmark
tiers — targets, not pre-validated claims. **Do not adopt a search engine** (minisearch/flexsearch/lunr) — they are
ranked-document-retrieval tools without positional postings; retrofitting KWIC through
highlight plugins means fighting the abstraction forever.

- All parsing/tokenization/analysis in a long-lived module **Web Worker**; typed arrays
  transfer zero-copy; job IDs + cancellation; kill-and-restart for runaway regex. No
  SharedArrayBuffer (GitHub Pages can't set COOP/COEP — architect around it).
- **Progressive pipeline (tiered results)**: **T0** — per-file byte/line counts and
  titles the moment files are read; **T1** — each document becomes fully queryable
  (tokens, index, inventory, trends, KWIC) as *its* index finishes, streaming in
  document order, charts widening as books land; **T2** — corpus-level aggregates
  (frequency lists, dispersion, vocabulary growth) recomputed incrementally per
  completed document; **T3** — lazy-pack annotations (POS, entities, attribution) fill
  in behind, per document, with panels showing what they await; **T4** — on-demand
  passes (n-grams, collocations, keyness) computed at request time against whatever is
  indexed. A recipe change invalidates token-derived indexes but not source extraction;
  a new term group queries the existing index. Partial results are first-class but
  honest: every result carries the exact indexed selection (content hashes) and a
  complete/partial flag; partial panels name the missing documents; dependent
  aggregates (keyness, dispersion, vocabulary growth) recompute as documents land; and
  exports either wait for completeness or are prominently marked partial with the same
  provenance. Warm reopen from IndexedDB skips to complete only when every required
  content-addressed artifact is present and compatible.
- **Budgets, benchmarked in CI**: 1M / 10M / 50M token tiers; main thread responsive
  throughout; cached project reopens without re-tokenizing; quadratic algorithms
  declare caps before running.
- Analysis math (DP, log-Dice, log ratio, G², MATTR, Delta) implemented as small pure
  TypeScript functions tested against published fixtures — these numbers are the
  product's meaning; no stats-package delegation.

## 7. Dependencies

Recommended stack — research-informed, with the contested calls resolved by the §8
operator decisions (not presented as four-stream consensus):

| Layer | Pick | Notes |
|---|---|---|
| Foundation | Vite + React 19 + TypeScript strict | Domain/analysis code framework-free |
| State | zustand (+ Zod at import/worker boundaries) | Corpus data never in React state |
| Viz | Hand-rolled SVG + d3-array/d3-shape/d3-scale (~28 kB) as pure math; 2D canvas for dense strips | Decided (§8.1) |
| Index/tokenize | Hand-rolled + `Intl.Segmenter` | The zero-dependency centerpiece |
| Virtualized lists | @tanstack/react-virtual | KWIC, large tables |
| EPUB | Spike (§8.8): @lingo-reader/epub-parser behind an adapter vs custom fflate + DOMParser extractor | epubjs rejected — reader-oriented, npm stale since 2023 (repo only minimally active) |
| Markdown | Same spike (§8.8): mdast-util-from-markdown vs ~30-line strip | Headings → chapter boundaries; AST favored for fidelity |
| NLP pack (lazy) | wink-nlp + eng-lite-web-model (~1 MB, cached) | Decided (§8.2) — no compromise alongside |
| Embeddings (lazy, experimental) | @huggingface/transformers v4 | Never in the initial bundle |
| PDF (lazy, stretch) | pdfjs-dist | Second-class input |
| Hashing | Web Crypto SHA-256 | No package |
| Testing | Vitest + Playwright + golden fixture corpora + benchmark harness | Published-value tests for all stats |

Baseline JS budget target: **~150–200 kB gzipped** before any lazy pack (hypothesis —
verified against a reproducible bundle in Phase 0).

Avoid (evidence corrected per review, July 2026): lunr, threads.js (dead) · epubjs
(reader-oriented, npm stale since 2023 — wrong tool for extraction, not literally dead:
its repo merged fixes in 2026) · Observable Plot (avoided by the §8.1 hand-rolled
decision — its npm line is 17 months stale but the repo saw 2026 activity, so the
decision rests on owning the visual system, not on staleness) · visx (v4.0.0 June 2026
supports React 18/19; avoided as a second visualization vocabulary we don't need, not
as unmaintained) · Recharts/nivo/Plotly/ECharts (wrong abstraction) · flexsearch/
minisearch as corpus engine · Tailwind/component frameworks (plain CSS custom
properties fit the design system) · Redux · SharedArrayBuffer/coi-serviceworker ·
multiple simultaneous NLP stacks.

## 8. Decisions (operator decisions, 2026-07-19)

Resolved by the project owner after reviewing the research — recorded as product
decisions with the reviewer's dissents noted, not as research consensus:

1. **Charting: fully hand-rolled SVG in React, d3 modules as pure math**
   (d3-scale/d3-shape/d3-array; no Observable Plot). The visual system is the product;
   linked brushing is the one interaction that matters. We own `<Axis>`, `<Sparkline>`,
   `<SmallMultiples>`, etc. *(Overrides Codex's recommendation of Observable Plot for
   conventional views. Fact check: Plot's npm line is stale but its repo saw 2026
   activity — the decision rests on owning the visual system and React-native linked
   brushing, not on staleness.)*
2. **English NLP pack: wink-nlp** (+ wink-eng-lite-web-model, lazy-loaded). One pack,
   one error profile, single-pass pipeline speed. No compromise alongside it; the
   entity registry's user-curation covers wink's weakness on invented names. Validate
   offsets against the core tokenizer on fiction fixtures before wiring in.
3. **Worker RPC: explicit typed message protocol** (no comlink). Progress streaming,
   cancellation, transferable buffers, and worker restart stay visible — discriminated
   unions over `postMessage`, ~100 lines, exemplary by design.
4. **IndexedDB: `idb`** (thin promise shim). Our access pattern is content-hash-keyed
   blobs, not queries; revisit only if migrations get hairy.
5. **URL state: nuqs.** Share links are a headline feature; typed parsers win.
6. **MVP scope: the killer features.** The first release is defined by the seven
   killer features (§9), not by the narrower "lexical workbench first" cut — the book
   dashboard and character sheet are the demo surface, so they move up. *(A product
   decision adopting the landscape survey's ranking, overriding Codex's narrower
   Phase 1 recommendation.)*
7. **Trend contract** *(adopted from the review, open to veto)*: exact positions are
   canonical; the default trend is an **unsmoothed equal-token-bin rate** paired with
   its dispersion barcode; rolling mean/LOESS is an optional overlay whose method,
   window, and edge treatment are named in the UI. Resolves the bins-vs-rolling
   contradiction between the research inputs.
8. **Parser spikes, not defaults**: EPUB (@lingo-reader/epub-parser behind an adapter
   vs a custom fflate + DOMParser extractor — judged on EPUB 2/3 fixtures, spine/nav/
   metadata fidelity, malformed-book handling, memory, XSS isolation, bundle size) and
   Markdown (mdast AST vs regex strip) are resolved by short spikes in Phase 2
   planning. No LOC estimates before the spike.
9. **Speaker attribution scope**: narrow, *reviewable* suggestions only — explicit
   speech-verb + registry-name rules first; alternating-turn propagation as a separate,
   lower-confidence tier; an explicit unattributed/abstain state; user corrections as
   first-class evidence. Opaque whole-corpus attribution and coreference stay cut.
10. **Portable core; TS-first; WASM only behind benchmark gates** *(Claude and Codex
    independently concurred, ~80% confidence each)*: the analysis engine lives in a
    platform-neutral `packages/core` (no DOM/worker/fs/framework imports) consumed by
    a Web Worker adapter in the app and an early Node CLI adapter (conformance
    fixtures, benchmarks, batch export). Segmentation is an *injected adapter*
    (`Intl.Segmenter` first) whose engine/version is recorded in provenance — browser
    and Node are conformance-tested, never assumed identical. Index buffers are
    immutable at the analysis boundary; operations are batched, numeric in/out — that
    boundary is the designed WASM seam. No Rust now: a WASM pass is added only when an
    optimized TS pass misses a written user-facing budget, profiling shows the pass
    dominates its path (≥~25%), and a vertical prototype wins ≥~2× end-to-end or
    ≥~30% peak memory on representative corpora (first candidates: n-grams,
    MinHash/LSH, clustering — never KWIC or basic counts). A full Rust core requires a
    product condition (standalone native CLI demand, persistent 50M-tier OOM after TS
    data-layout work, or several passes already in WASM) plus a successful end-to-end
    spike. Full analysis: `inputs/codex-wasm-consultation.md`.

## 9. Delivery phases (decided: killer-feature MVP)

**Phase 0 — analysis contract.** Schemas for source/structure/token/recipe/selection/
query/occurrence/result; offset and Unicode fixtures; benchmark tiers; method specs
with published-value tests *before UI work*.

**Phase 1 — MVP: the seven killer features**, on the substrate they require (TXT/MD
ingest with chapter review, positional index in a worker with tiered progressive
results, IndexedDB cache, KWIC + reader, frequency tables, project autosave, exports):

1. **Narrative-time alignment across a series** — aligned/faceted term-group trends
   with dispersion barcodes; the three time coordinates; chapter/book boundary rules.
2. **Universal chart↔concordance linking** — click any mark → KWIC; brush any span →
   every panel filters; axis-hover text snippets, pinnable.
3. **Term groups as first-class shareable objects** — aliases, phrases, wildcards;
   live counts and sparklines; nuqs share links.
4. **The book dashboard** — auto-generated on ingest: chapter strip, vocabulary
   growth, sentence-rhythm sparkline, per-chapter TF-IDF labels, burst annotations.
5. **The character sheet** — user-curated alias groups (registry UX; NER suggestions
   arrive with the wink pack later): mention arc, barcode, top collocates, co-mention
   partners, dialogue share via the quote heuristic.
6. **Two-text dueling view** — keyness (log ratio + G²), vocabulary overlap, length/
   rhythm comparison, side by side on shared scales.
7. **Emotional arc with receipts** — lexicon-based, raw points behind the smoothed
   line, click a trough → its sentences; visibly flagged as lexicon-derived.

*The MVP pulls keyness, TF-IDF, collocates, bursts, dispersion, and quote detection
forward from the old Phase 2–3. All are pure-JS passes over the index — no model or
dependency weight — but they are real machinery all the same: implementations with
published-value fixtures, and for the arc a licensed lexicon with validation and
provenance. The arc keeps its Experimental visual treatment even on the dashboard.*

**Phase 2 — corpus-linguistics depth.** Full collocation explorer (log-Dice, positional
profiles), n-gram browser, DP-sortable frequency lists, MATTR/MTLD, structure
distributions, rank trajectories, EPUB ingestion.

**Phase 3 — the wink English pack.** POS profiles, readability, NER suggestions into
the entity registry, co-occurrence adjacency matrices, reviewable speaker attribution +
character voice profiles, stylometry (Delta, rolling Delta).

**Phase 4 — experimental lab.** Segment clustering, embeddings/semantic passage search,
near-duplicates, PDF, transformer sentiment slow lane.

## 10. What we beat

- **Voyant**: linked views done fast and universally, no server, method provenance,
  fewer-but-better forms instead of a 28-tool zoo.
- **AntConc**: its evidentiary rigor (KWIC sorting, keyness, dispersion) with modern
  linked visual comparison, persistence, and zero install.
- **Ngram Viewer**: its query/method legibility, plus exact hits, your own corpora, and
  structural boundaries.
- **Lexos**: its explicit workflow, made non-destructive and reversible.
- **All of the surveyed tools**: narrative-time alignment across a series — the
  feature none of them offer.
