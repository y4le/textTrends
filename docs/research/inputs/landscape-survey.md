# Research input: analyses & visualization landscape survey

*Produced by a Claude research agent with web verification, 2026-07-19. Condensed; full
citations at end.*

## Survey of existing tools

**Voyant Tools** — the incumbent. ~28 linked-panel tools. Worth stealing: Trends
(term frequency over segments — poor labeling, arbitrary segmentation in Voyant's
version), Contexts/KWIC (its best design decision is linked panels: click a chart term →
concordance), Reader+MicroSearch (document minimap = dispersion barcode fused with
scrollbar — underrated), TermsBerry (frequency+co-occurrence hover grid; good idea, weak
honeycomb rendering), Bubblelines (right idea — per-document dispersion — wrong mark),
and the tabular workhorses (Summary, Documents, Phrases, Collocates, Correlations).
Gimmicks to skip: Cirrus (word cloud), Knots, Dreamscape, Mandala, TextualArc, Veliza (an
ELIZA chatbot), ScatterPlot (PCA of terms), StreamGraph, in-browser LDA Topics, RezoViz.
Dated overall: Java server dependency, ExtJS chrome, byte-count segmentation with no
narrative structure, no series alignment, legends and rainbow palettes, painful export.
Enduring strengths: zero-install ingestion, linked panels, stopword handling.

**Google Books Ngram Viewer** — one thing done clearly: multi-series lines,
direct-labeled at line ends, smoothing control, and a query mini-language
(`(Frodo+Sam)/hobbit`, wildcards, POS suffixes). Steal the query composition and the
smoothing slider. Its axis is calendar time; textTrends' narrative time is the
differentiator.

**AntConc / LancsBox** — desktop corpus-linguistics standards. KWIC with multi-level
context sorting (L1/R1/R2…), the **Plot barcode dispersion view** (the most
Tufte-compatible visualization in the field), Clusters/N-grams, Collocates (MI,
log-likelihood), Keyword lists (keyness vs a reference corpus). LancsBox adds GraphColl
and proper dispersion stats (Gries' DP, Cohen's d). Severe UX debt; steal the rigor,
beat the presentation and linking.

**Lexos** — steal the explicit *scrubbing* stage (Gutenberg header removal,
consolidation rules, stopwords as a visible, editable step) and rolling-window (not
fixed-bin) frequency. Skip dendrogram-first output and clouds.

**Storywrangler** — rank-based time series (plotting rank stabilizes magnitude
differences) and rank divergence between periods/corpora ("what changed between Book 1
and Book 5?").

**Research to mine**: Vonnegut story shapes → Jockers' syuzhet (2015) → Reagan et al.
"emotional arcs" (2016, hedonometer). Design around the criticisms (Swafford, Schmidt,
Underwood): lexicon sentiment is noisy and blind to irony/negation; Jockers' low-pass
Fourier filter forced periodic arcs (artifacts — use LOESS/rolling mean); the arc is
*emotional vocabulary density*, not "plot" — label honestly. Character networks: Elson/
Dames/McKeown (ACL 2010); Bostock's reorderable Les Mis adjacency matrix is the
canonical rendering; BookNLP's feature list (mention arcs, quote attribution) is the
target to approximate, not the dependency. Dialogue: quote-mark extraction + nearest-
name+speech-verb attribution is feasible client-side; full attribution is research-grade.
Stylometry: Burrows' Delta; Evert et al. 2017 → Cosine Delta most robust. Dispersion:
Gries' DP (2008/2020) outperforms Juilland's D (Biber et al. 2016).

## Catalog of analyses (feasibility: [JS] pure counting / [JS+lex] bundled lexicon / [SM] small in-browser model / [ML] heavy — skip)

- **Lexical stats**: TTR + MTLD/MATTR (length-corrected; raw TTR is length-confounded),
  hapax/dis legomena, word/sentence length distributions, vocabulary growth (Heaps),
  Zipf rank-frequency (curiosity), rolling MTLD over narrative time. All [JS].
- **Frequency & dispersion**: term-group rolling-window frequency over narrative time
  (the core), dispersion barcodes, Gries' DPnorm per term (sort any list by "clumpiness";
  high-frequency+high-DP finds scene-specific vocabulary automatically), rank
  trajectories across books (bump chart), Poisson-surprise burst detection. All [JS].
- **N-grams & collocations**: repeated phrases with dispersion, collocates by log-Dice
  (preferable default; PMI over-rewards rare pairs) with MI/LL available, KWIC with
  positional sorting, word trees. All [JS].
- **Comparison/keyness**: log-likelihood + log-ratio effect size, TF-IDF per chapter
  ("what is this chapter about"), vocabulary overlap + rank divergence. All [JS].
- **Readability**: Flesch-Kincaid etc. — of limited absolute literary insight; *over
  narrative time / across a series* is the interesting frame. [JS].
- **Stylometry**: function-word profiles, Burrows'/Cosine Delta between books, rolling
  Delta within a text (stylistic drift), punctuation profiles. [JS]. POS-ratio profiles
  (adjective/adverb density over time) [SM].
- **Narrative**: character mention arcs (= term groups + user-curated aliases — [JS];
  NER as a *suggester* [SM]; full coreference [ML] — skip), co-occurrence networks
  [JS], interaction timelines [JS], dialogue vs narration ratio via quote heuristics
  [JS] with attribution heuristic [JS/SM], sentiment arcs [JS+lex] with transformer
  option [ML, optional lazy], character-conditioned sentiment ("emotional weather around
  Snape") [JS+lex] — cheap composition, distinctive.
- **Structure**: chapter/paragraph/sentence rhythm, POV-per-chapter (mention dominance),
  text heatmaps (source text tinted by any signal). [JS].

**~85% of the value is pure-JS arithmetic over a tokenized stream.** Only auto-NER
suggestions, POS ratios, and transformer sentiment need models.

## Visualization mapping

| Analysis | Form |
|---|---|
| Term trends | Direct-labeled multi-line (≤5-6 series), chapter boundaries as light rules; no legends |
| Many series | Small multiples, shared scales; horizon charts past ~15 rows (toggle, not default) |
| Dispersion | Barcode strips; double as click-to-concordance navigation and minimaps |
| Per-chapter stats | **Sparkline tables** — the signature surface; nothing in Voyant/AntConc has this |
| Character networks | Reorderable adjacency matrix default; node-link only <~20 nodes |
| Interactions over time | Storyline-lite bands (xkcd 657 simplified; true layout is NP-hard — approximate) |
| Sentiment | Smoothed line + faint raw scatter behind it (the honest answer to the syuzhet critique) |
| Keyness | Diverging dot plot, words label themselves; never a cloud |
| Source text | Text heatmaps — direct labeling in its purest form |

Reject: word clouds, streamgraphs (wobbling inner baselines; even Byron & Wattenberg
frame them aesthetically), pies, 3D, dual axes, force hairballs, rainbow palettes.
Interaction doctrine: linked brushing is the one interaction that matters — brush any
timeline → every panel filters; click any mark → its KWIC lines.

## Killer features (ranked by distinctiveness × feasibility × delight)

1. **Narrative-time alignment across a series** — no existing tool has it. "Show me
   *winter* across all five books, aligned." Requires first-class chapter/book structure
   at ingest. This is the identity of the app.
2. **Universal chart↔concordance linking** — every mark is a set of text positions.
3. **Term groups as first-class shareable objects** — aliases, wildcards, Ngram-style
   arithmetic, NER-assisted suggestions, URL-serialized.
4. **The character sheet** — mention arc, barcode, top collocates ("what verbs does she
   get?"), co-mention partners, sentiment-in-vicinity, dialogue share. Trivial pieces,
   unprecedented composition.
5. **Two-text dueling view** — keyness, overlap, Delta, rhythm side by side.
6. **The book dashboard** — auto-generated dense one-pager on ingest: chapter strip,
   vocabulary growth, rhythm sparkline, arc, per-chapter TF-IDF labels, bursts. Instant
   gratification before any term group is defined.
7. **Emotional arc with receipts** — click a trough → the sentences that drove it.

Privacy is itself a feature: nothing leaves the machine — Voyant can't claim it.

## Sources

Voyant tool docs · Programming Historian (AntConc) · Gries 2020 (dispersion) · Jockers
syuzhet + Schmidt critique · Reagan et al. 2016 · Storywrangler (Sci Adv) · Lexos ·
Bostock Les Mis matrix · Heer et al. "Sizing the Horizon" · Evert et al. 2017 (Delta) ·
MTLD (McCarthy & Jarvis 2010) · winkNLP · BookNLP · CEUR "Distinguishing Narration and
Speech".
