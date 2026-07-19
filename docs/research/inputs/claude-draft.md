# textTrends rewrite — Claude's independent research draft

## Framing

The original app's core insight is worth keeping as the spine: **narrative time as the
primary x-axis**. Most text tools treat a corpus as a bag of words; textTrends treats it
as a *sequence* — position within a book, across a series. Everything strong in the
rewrite should compound on that: trends, arcs, dispersion, co-occurrence *over position*.

Second framing decision: this is a *reading instrument*, not a dashboard. Tufte lens:
dense small multiples, sparklines in tables, direct labels, the source text itself as a
first-class display surface (KWIC, highlighted passages). The chart should always link
back to the evidence — click a spike, see the passages.

## Analyses (my priority take)

### Core (the spine)
- **Term/term-group frequency over narrative time** — the heritage feature. Smoothed
  density (kernel/window) per group, per book, per chapter. Must support regex/word
  boundaries/case options and term *groups* (aliases: "Jon", "Lord Snow").
- **Dispersion / barcode plots** — every occurrence as a tick on a strip. This is the
  honest, unsmoothed companion to the trend line; AntConc's most-loved view.
- **KWIC concordance** — click anything, see keyword-in-context lines, sortable by
  left/right context. The evidence layer under every chart.
- **Corpus overview stats** — tokens, types, sentences, TTR (and MTLD/MATTR for length
  robustness), hapax count, word/sentence-length distributions. Per book, comparable.
- **N-gram frequency tables** — top unigrams/bigrams/trigrams with stopword toggle,
  sparkline column showing each term's trend over narrative time (table+graphic hybrid).

### High value
- **Keyness between texts** — log-likelihood or log-odds w/ Dirichlet prior ("what makes
  book 3 lexically distinct from book 1?"). Great for series and for comparing corpora.
- **Collocations** — PMI/log-Dice around a node word, window-based. Pure counting, cheap.
- **Character tracking** — capitalized-token heuristics + user-curated alias sets get 90%
  of NER's value with zero model weight; mention arcs as small multiples per character.
- **Character co-occurrence networks** — edge = co-mention within window/paragraph.
  Prefer adjacency matrix (sortable, Tufte-friendly) over hairball node-link; maybe both.
- **Dialogue vs narration** — quote-detection heuristic; ratio over narrative time,
  who-speaks-when if attribution is feasible.
- **Readability / style over time** — sentence length, Flesch, punctuation rhythm as
  sparklines over narrative time. Style drift within a book is more interesting than one
  scalar.

### Stretch
- **Sentiment/emotion arcs** — lexicon-based (VADER/NRC) is cheap and famous (Vonnegut
  shapes) but noisy on fiction; ship with strong caveats or via optional small model
  (transformers.js) behind a lazy-loaded flag.
- **Stylometry** — function-word profiles, Burrows' Delta between books/chapters; niche
  but cheap and genuinely interesting for authorship/series questions.
- **Embeddings/semantic search** — transformers.js MiniLM is feasible but heavyweight;
  only as a lazy-loaded optional module, if at all in v1.

### Skip (for v1)
- Topic modeling (LDA in browser: slow, hard to make honest), word clouds (Tufte crime),
  POS-heavy analyses requiring big models, full NER models by default.

## Visualizations
- Small multiples with shared scales as the default idiom; one big chart only for the
  primary trends view.
- Barcode/dispersion strips aligned under trend charts and next to table rows.
- Sparklines inside every table (n-grams, characters, chapters).
- Chapter boundaries as light rules on every narrative-time axis; books as facets.
- Adjacency matrix for networks; arc diagram as secondary.
- Horizon charts if we need dozens of aligned series (many characters) in small space.
- Avoid: streamgraphs (baseline distortion), word clouds, pie anything, dual axes.

## App features
- **Corpus model**: ordered sequence of documents → chapters (regex/heuristic detection,
  user-correctable) → paragraphs/sentences/tokens with absolute positions. This index is
  the single source of truth; every analysis is a view over it.
- Formats: .txt (encoding detection), .md, .epub (zip+XHTML, keeps real chapter
  structure); .pdf probably out of scope for v1 (extraction quality).
- Sample corpora (public domain: LOTR is not PD — use Austen, Dickens, Sherlock Holmes
  via included files) for instant demo. Current app's S3 links to ASOIF/LOTR are a
  copyright liability; revisit.
- **State**: everything serializable — term groups, colors, view config — to URL hash
  (compressed) and/or downloadable JSON "workspace". Corpus cached in IndexedDB/OPFS so
  reload is instant.
- **Perf**: tokenize/index in a Web Worker (comlink), incremental per-file, positional
  inverted index for KWIC/collocations/dispersion. 5M chars is small for a decent index;
  target 50M+.
- Export: SVG/PNG per chart, CSV per table, whole-workspace JSON.
- Linked brushing: select a range in any narrative-time chart → concordance + all other
  charts highlight the same span.

## Stack instincts (to check against deps research)
- Vite + React + TypeScript, strict; zustand or jotai for state.
- Hand-rolled SVG charts in React (possibly with d3-scale/d3-shape as math-only deps) —
  Tufte-grade control, no charting-framework fights. Observable Plot is the fallback if
  hand-rolling is too slow to build.
- compromise or wink-nlp only if a concrete analysis needs it; core counting needs no NLP
  dep. transformers.js strictly lazy-loaded.
- fflate for epub unzip; DOMParser for XHTML.
