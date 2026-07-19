# textTrends rewrite: proposed product, analysis, and technical scope

Research snapshot: 2026-07-19  
Scope: static, privacy-preserving web application; all corpus parsing and analysis happens in the browser.

## Executive recommendation

Build textTrends as a **local-first corpus reading workbench**, not as a gallery of NLP demos. Its identity should remain the thing the existing app gets right: named term groups traced through narrative time. The rewrite should make that workflow rigorous, then connect it to frequency lists, concordance, comparison, and close reading.

The first release should include:

1. Ordered, hierarchical corpora: corpus → work/book → chapter/section.
2. A versioned, reversible normalization and tokenization recipe.
3. Named term groups containing tokens, phrases, aliases, and constrained wildcards.
4. Raw and normalized frequencies, exact occurrence positions, dispersion, and linked KWIC.
5. Corpus/document statistics, frequency lists, vocabulary growth, and word n-grams.
6. Target-versus-reference comparison with log-ratio effect size and log-likelihood evidence.
7. Shareable analysis configuration, portable project files, CSV/JSON/SVG export, workers, and persistent caches.

The next layer should add lexical-diversity measures, collocation, structure/readability, an optional English POS/entity pack, character aliasing/co-occurrence, and stylometric comparison.

Sentiment, emotion, topic models, embeddings, semantic search, PDF, automatic speaker attribution, and unrestricted regex belong behind an **Experimental** label. They are feasible in-browser in some form, but their quality, cost, or interpretability is not good enough to define the product.

The strongest product promise is:

> Your texts stay on your device; every result can be traced back to occurrences in the text; every methodological choice is visible and saved.

That is more useful than trying to match Voyant tool-for-tool.

## Priority and feasibility vocabulary

- **Core**: required for a coherent first public release.
- **High-value**: materially expands scholarly use after the analysis kernel is stable.
- **Stretch**: opt-in, experimental, model-heavy, language-specific, or difficult to validate.
- **Client feasibility — easy**: linear-time JavaScript over a compact token index.
- **Client feasibility — moderate**: worker-only, careful memory limits, or language-specific heuristics.
- **Client feasibility — constrained**: large downloads, quadratic algorithms, browser capability variance, or unreliable source extraction.

## Product principles

### 1. Preserve evidence, not just scores

Every aggregate should lead back to a term occurrence, a KWIC row, a sentence, or a source section. A sentiment score without its sentences, a character edge without its co-occurring passages, or a keyword without counts in both corpora is incomplete.

### 2. Preprocessing is part of the result

Never destructively “clean” a text. Preserve source text and offsets. Store a recipe containing Unicode normalization, locale, case folding, apostrophe/hyphen policy, number policy, stop list, lemmatization state, and analyzer version. Show a small before/after preview. Stop words should affect ranked lists and matrices, never silently affect literal search or KWIC.

### 3. Narrative time is not one axis

Offer three explicit coordinates:

- **Relative position**: percentile within each work, best for comparing narrative shapes.
- **Absolute token position**: best for finding an occurrence and seeing scale.
- **Ordered sequence**: concatenated books/sections with visible boundaries, valid only when the user has declared an order.

Equal-token bins should be the default. Character offsets and equal-character chunks bias results when word and whitespace lengths vary. Never silently stitch unrelated documents into a faux narrative.

### 4. Raw data remains visible

Show raw counts beside rates per 10,000 tokens. Smoothing is off by default; when enabled, retain a faint raw trace, name the method and radius, and handle edges explicitly. Google Books Ngram Viewer usefully makes normalization and smoothing visible, but textTrends can do better by exposing the underlying passages.

### 5. One selection model links the app

Selecting a term, bin, document, entity, or matrix cell should update the same context pane and KWIC list. Voyant’s most important lesson is not its number of visualizations; it is the way views move between corpus overview and source context. Its default interface links Trends, Contexts, Reader, Summary, and other tools ([Voyant tutorial](https://docs.voyant-tools.org/docs/tutorial-tutorial.html)).

### 6. Language support must be honest

The deterministic lexical core can be Unicode- and locale-aware. POS, NER, sentiment, syllables, readability, and lemmatization are language-pack features. The UI should show the active language and disable unsupported analyses, not return English-biased numbers for every corpus.

## Analyses and appropriate visualizations

## Core analyses

### Corpus inventory and lexical profile

**Measures**

- Characters, tokens, word tokens, types, sentences, paragraphs, sections, and documents.
- Raw type/token ratio, hapax and dis legomena counts/shares, mean and median word length, sentence length, and paragraph length.
- Top terms and document frequency.
- Cumulative vocabulary growth and frequency-of-frequency table.

Raw TTR and hapax share are descriptive but strongly length-dependent. Label them as such. Do not call them general measures of “vocabulary quality.” The later MATTR layer is the comparable metric; the original MATTR paper specifically addresses TTR’s text-length problem ([Covington & McFall, 2010](https://doi.org/10.1080/09296171003643098)).

**Visualization**

- Dense sortable document table with inline bars and sparklines.
- Step line for cumulative vocabulary growth, with document/chapter boundary ticks.
- Log-log rank-frequency plot only in an expandable methods view; it is diagnostic, not a headline “Zipf score.”
- Tiny histograms or ECDFs for word, sentence, and paragraph length.

**Feasibility**: easy. Compute during ingestion. Exact definitions and handling of punctuation, contractions, numerals, and CJK segmentation must be inspectable.

### Term groups, frequency through narrative time, and dispersion

This remains the core textTrends workflow.

**Query model**

- A group has a name and OR-combines members.
- Members can be a token, an exact phrase, an alias, or a safe prefix/suffix wildcard.
- Phrase members are token sequences, not substring searches.
- Per-query controls: case-sensitive, diacritic-sensitive, surface form versus lemma when a language pack is active.
- Advanced regex is opt-in, worker-isolated, length-limited, cancellable, and never included in an automatically shared URL.
- Overlapping members are de-duplicated within a group by default, with an explicit “count overlaps” option.

**Measures**

- Count and rate per selected denominator.
- Exact positions and counts in equal-token bins.
- Range: number/share of documents or sections containing the group.
- Dispersion: deviation of proportions (DP) across equal-sized parts, accompanied by range. A common word confined to one chapter must not look equivalent to one spread through the book.
- Optional burst score or peak-bin share as a high-value follow-on.

**Visualization**

- A row per term group: direct label, count/rate, thin timeline sparkline, and a rug/barcode of exact hits.
- A larger focused line chart for one or a few selected groups, with document/chapter boundary rules and end labels.
- Small multiples when more than roughly four groups or texts are compared.
- Clicking a line segment or barcode region filters KWIC.

Do not preserve the old random rainbow palette. Keep most series gray, use one accent for the active selection, and use muted, accessible secondary strokes or dash patterns only when simultaneous comparison requires them.

**Feasibility**: easy after a positional index. Binning is an aggregation of exact positions, not the primary stored data.

### Frequency lists and document frequency

**Measures**

- Token count, relative frequency, document frequency, range, dispersion, rank, rank change, and optionally lemma.
- Stop list and minimum frequency are visible controls.
- Filter by token class: words, punctuation, numerals, POS when available.

**Visualization**

- Dense table, not a word cloud.
- One aligned in-cell bar for frequency and one small range/dispersion glyph.
- Rank-change slope marks when comparing two selections.
- A term click selects it globally and opens KWIC.

**Feasibility**: easy. Word clouds should be cut: area is hard to compare, arrangement is unstable, and long words receive accidental visual emphasis.

### Word n-grams and repeated phrases

**Measures**

- Contiguous word n-grams, default 2–5; configurable crossing of sentence and section boundaries.
- Count, relative frequency, document frequency, range, dispersion, and comparison effect.
- Character n-grams belong initially to stylometry rather than the general phrase browser.
- Precompute unigrams; compute larger n-grams on demand with minimum-count pruning.

**Visualization**

- Ranked table with aligned bars and miniature dispersion rugs.
- Comparison mode uses two counts and a centered rank-change or log-ratio mark.
- Click through to phrase KWIC.

**Feasibility**: easy to moderate. All possible 4- and 5-grams can consume substantial memory, so use on-demand passes and top-k heaps rather than retaining every rare gram.

### KWIC concordance and source reader

AntConc’s enduring strengths are concordance, concordance plots, clusters/n-grams, collocates, word lists, and keyword lists; textTrends should meet that evidence-first standard before adding glamorous NLP ([official AntConc page and manuals](https://www.laurenceanthony.net/software/antconc/index.html)).

**Features**

- Fixed-width, right-aligned left context; highlighted node; left-aligned right context.
- Sort by L1/L2/L3 and R1/R2/R3 context token, document, section, or narrative position.
- Adjustable token/sentence context.
- Metadata columns and a compact occurrence-position tick.
- Click a row to open source text with stable highlighting and surrounding paragraph.
- Export current concordance with query and method metadata.

**Visualization**

- The concordance table is the visualization. Do not decorate it.
- A slim corpus barcode above the table summarizes the current result.

**Feasibility**: easy with source offsets and row virtualization. Keep original source strings outside React state.

### Cross-text comparison and keyness/distinctiveness

Comparison should operate on any two selections in the hierarchy: one chapter versus another, one book versus the rest, tag-defined sets, or a target corpus versus a reference corpus.

**Measures**

- Frequencies and normalized rates in A and B.
- **Log2 ratio** with a 0.5 continuity correction as the primary effect size.
- **Signed G² log-likelihood** as evidence against equal relative frequency.
- Minimum total count and minimum document range filters.
- Optional Benjamini-Hochberg q values, but do not make a p-value the ranking or interpretation.
- TF-IDF is available for weighting a document-term matrix; it is not presented as a statistical keyness measure.

Rayson and Garside introduced the frequency-profile/log-likelihood workflow for corpus comparison ([ACL paper](https://aclanthology.org/W00-0901/)). Effect and evidence answer different questions: log-likelihood tends to favor frequent terms, while log ratio can exaggerate extremely rare terms. The interface should show both, plus counts and dispersion.

**Visualization**

- Diverging dot/lollipop plot on log2 ratio, sorted by effect or evidence.
- Dense table columns for A count/rate, B count/rate, log ratio, G², range, and an inline distribution rug.
- A two-column “key in A / key in B” view is more readable than a volcano plot for the default.
- Heatmap only when comparing many documents and a bounded set of top distinctive terms.

**Feasibility**: easy. Exact formulas should be implemented as small tested functions against published fixtures rather than delegated to a broad statistics package.

### Sentence, paragraph, and section structure

**Measures**

- Sentence and paragraph length distributions, punctuation rates, question/exclamation shares, direct-quotation share, and section length.
- Values over narrative position and by document.
- Means plus medians, quartiles, and tails; an average alone hides stylistic structure.

**Visualization**

- Aligned ECDF or compact histogram per document.
- Box/dot summaries in the document table.
- Small-multiple sparklines across narrative time.

**Feasibility**: easy for paragraphs, moderate for sentences because boundary detection is language- and abbreviation-sensitive. Keep the segmentation recipe visible.

## High-value analyses

### Comparable vocabulary richness

**Measures**

- Moving-average type/token ratio (MATTR), default 500-token window with alternatives.
- MTLD as a second robust measure after validation.
- Lexical density (content-word share) only when a POS pack is active.
- Vocabulary growth by standardized token samples for cross-text comparison.

**Visualization**

- MATTR sparkline over narrative position, plus median and interquartile band.
- Dot plot across documents with shared scales and sample/window size printed in the label.
- Rarefaction-style vocabulary-growth curves for comparable samples.

**Feasibility**: easy for MATTR, moderate for MTLD and POS-based density. Do not ship a dozen interchangeable diversity indices.

### Collocations

**Measures**

- Token-window and sentence-based co-occurrence around a node.
- Raw co-occurrence, left/right frequency, logDice as the default association score, plus t-score and MI for expert comparison.
- Minimum co-occurrence and document-range filters. MI’s attraction to rare accidents must be stated.
- Positional profiles by L5…R5 and optional POS-pattern filtering.

**Visualization**

- Ranked table with score, observed frequency, range, and a small left/right positional histogram.
- A centered position profile is more informative than a radial diagram.
- Clicking a collocate produces a two-node KWIC query.

**Feasibility**: easy to moderate over a positional index. Avoid a default force graph; it obscures counts and becomes a hairball.

### Readability

**Measures**

- English Flesch Reading Ease and Flesch–Kincaid grade, plus the underlying sentence length, word length, and syllable assumptions.
- Only compute on sufficiently large English selections.
- Prefer transparent component statistics over a menu of branded scores. Do not imply that literary complexity equals school grade.

**Visualization**

- Document table with score and inline position sparkline.
- Distribution of sentence lengths and long-sentence tail.
- Directly label reference bands, without gauges or speedometers.

**Feasibility**: moderate. Sentence and syllable errors compound. This is an English language-pack feature, not universal core.

### POS and grammatical profiles

**Measures**

- POS counts/shares, pronoun/person patterns, noun/verb/adjective/adverb balance, lexical density, and POS n-grams.
- Compare by text, section, or narrative bins.
- Preserve the analyzer’s tagset and version in project provenance.

**Visualization**

- Small-multiple proportion lines by POS class.
- Dot plot across texts.
- Heatmap for a bounded set of POS n-grams.
- Avoid 100% stacked areas for many classes; the moving baselines defeat comparison.

**Feasibility**: moderate and language-specific. Run in a worker and make it an explicit downloadable/lazy chunk.

### Named entities and character tracking

NER alone does not solve literary character tracking. The useful feature is a reviewable **entity registry**:

- Suggested people, places, and organizations from the NLP pack.
- User-created entities and aliases such as “Elizabeth,” “Lizzy,” and “Miss Bennet.”
- Merge/split, ignore, type correction, and exact surface-form evidence.
- Frequency, range, first/last appearance, and narrative-time profile.

**Visualization**

- Ranked entity table with a sparkline and barcode.
- Character-by-chapter heatmap for presence/intensity.
- Directly labeled character small multiples.

**Feasibility**: moderate. Rule/model suggestions will miss invented names and confuse titles; user correction is part of the design, not an edge case.

### Character/entity co-occurrence

**Measures**

- Co-occurrence within sentence, paragraph, rolling token window, or chapter.
- Raw edge count and normalized association; range across sections.
- Filters for minimum count, top N entities, and selected ego network.

**Visualization**

- Reorderable adjacency matrix is the default.
- A filtered ego network is secondary and only for sparse selections.
- An arc diagram can work for a single linear sequence with fewer than about 20 entities, but is otherwise decorative.

**Feasibility**: moderate. Compute edges from reviewed aliases, not raw capitalization.

### Dialogue versus narration

**Measures**

- Quoted-token share, quoted spans, turn-length distribution, quote density over narrative position, and punctuation within/outside quotes.
- Support locale-specific quote pairs and nested quotations.
- Report unmatched-quote rate as a confidence/quality signal.

**Visualization**

- Thin narration/dialogue proportion sparkline.
- Quote-span barcode.
- Turn-length distribution.

**Feasibility**: moderate as a transparent heuristic. **Cut automatic speaker attribution from the normal roadmap**; reliable quotation attribution needs syntax, coreference, and genre-specific rules.

### Stylometry and document similarity

**Measures**

- Standardized frequencies of common function words.
- Character 3–5-grams, punctuation habits, word/sentence length, and selected POS features.
- Burrows’s Delta for interpretable pairwise distance.
- Cosine similarity over TF-IDF for topical similarity.
- Deterministically seeded k-means and hierarchical clustering on explicitly selected, standardized features.
- PCA for inspection, not proof of authorship.

**Visualization**

- Distance matrix with clustered ordering.
- Dendrogram only for a manageable number of documents/segments.
- PCA scatterplot with direct labels and feature-loading table.
- Nearest-neighbor table with per-feature differences.

**Feasibility**: moderate. Hierarchical clustering is quadratic, so cap it (for example, 500–1,000 units) and offer k-means for larger segment sets. Authorship language must be cautious: edition, genre, period, and sample length are confounds.

Lexos is worth learning from here: its workflow explicitly scrubs and cuts texts, builds document-term matrices, finds top distinctive words, runs rolling-window analysis, and clusters texts ([Wheaton Lexomics FAQ](https://wheatoncollege.edu/academics/special-projects-initiatives/lexomics/faq/)). textTrends should improve on that by preserving reversible recipes and linking every segment back to a reader.

## Stretch/experimental analyses

### Sentiment and emotion arcs

**Recommendation**: ship only after a validation corpus and clear warnings.

- Score sentences, then aggregate fixed-token windows; never score arbitrary equal-character chunks.
- Preserve sentence scores and matched lexicon evidence.
- Show raw window points plus a user-controlled smooth line.
- Allow a user-supplied lexicon as a portable CSV rather than quietly bundling a questionably licensed emotion lexicon.

**Visualization**: small-multiple lines around a zero baseline, direct labels, and click-through sentences. Do not use a stacked emotion streamgraph: its shifting baseline hides comparison and the apparent “arc” invites over-interpretation.

**Feasibility**: moderate technically, weak semantically. Negation, irony, free indirect discourse, historical language, and character speech are fundamental failure modes.

### Topic-ish clustering

Prefer a modest claim: **segment similarity and recurring vocabularies**.

- Split at reviewed sections or fixed 500–1,000-token windows.
- Build a capped TF-IDF matrix.
- Cluster deterministically and show each cluster’s distinguishing terms and representative passages.
- NMF can be an experimental later option; do not lead with LDA or pretend cluster labels are discovered themes.

**Visualization**: segment-by-cluster heatmap, small-multiple prevalence lines, and top-term bars with representative passages. Avoid bubbles, word clouds, t-SNE, and UMAP as defaults.

**Feasibility**: moderate with vocabulary/segment caps. Algorithms are easy; stable, meaningful interpretation is not.

### Embeddings and semantic similarity

Potentially valuable tasks are:

- “Find passages like this one.”
- Nearest sections to a selected passage.
- Semantic expansion suggestions for a term group, requiring user confirmation.
- Semantic clustering over a bounded selection.

Use [Transformers.js](https://huggingface.co/docs/transformers.js/main/index) only as a dynamically imported experimental pack. It runs ONNX models in-browser using WASM and can opt into WebGPU; quantized dtypes reduce browser bandwidth and memory. The official WebGPU guidance still notes capability variation and recommends fallback paths ([WebGPU guide](https://huggingface.co/docs/transformers.js/en/guides/webgpu)).

**Visualization**: nearest-passage table with similarity and excerpt; matrix for a small selection. A 2-D embedding scatterplot is optional diagnostics and must state the projection.

**Feasibility**: constrained. Expect a separate model download, substantial RAM, warm-up time, and model licensing/revision provenance. Do not eagerly embed an entire corpus. Let the user choose a bounded scope, cache vectors, and provide cancel/delete controls.

### Near-duplicate passage and refrain detection

Character shingles plus MinHash/LSH can find repeated or lightly changed passages, refrains, boilerplate, and edition overlap.

**Visualization**: repeated-passage table and a sparse pairwise link list; an arc diagram only for a single work with few matches.

**Feasibility**: moderate, but lower priority than concordance and keyness.

## Visualization system

### Default visual grammar

- **Tables first** for exact values and rankings.
- **Sparklines** inside tables for position and change.
- **Small multiples** for more than a few terms or documents, on shared scales.
- **Rugs/barcodes** for exact occurrence position.
- **Lines** for rates across an ordered axis, with raw data retained when smoothed.
- **Dots/lollipops** for comparing scalar values.
- **Heatmaps** for bounded matrices where both axes have meaningful labels.
- **ECDFs/histograms** for sentence, paragraph, and turn-length distributions.
- **Adjacency matrices** before networks.
- **Direct labels** before legends; hairline rules and restrained annotation.

Use monospace for token strings, counts, formulas, query syntax, and KWIC; use a highly readable proportional face for explanation. Do not set all data labels in mono if it harms scanning. Color is never the sole encoding. The one accent color marks current focus; secondary comparisons use gray level, position, and dash before additional hues.

### Linked interaction

Brushing a timeline filters the same corpus selection used by every view. Selecting a table row highlights the series and opens KWIC. Hover is supplementary; keyboard focus and click must expose the same information. Preserve zoom and selection in serializable view state.

### Charts to reject by default

- Word clouds.
- Pie/donut charts and gauges.
- Streamgraphs.
- Radar charts.
- 3-D charts.
- Dense force-directed networks.
- Dense arc diagrams.
- Unlabeled dimensionality-reduction scatterplots.
- Animated transitions that delay comparison.

Network, arc, and projection views are not forbidden, but must earn their place with strict cardinality limits, labels, and an accompanying exact table.

## App feature set

## Corpus management

### Core

- Drag/drop and file-picker import of multiple files.
- Explicit reordering; multi-select; duplicate/content-hash detection.
- Hierarchy with corpus, work/book, chapter/section, and optional analytical segment.
- Editable metadata: title, author, date/year, language/locale, series position, tags, source note, and target/reference role.
- UTF-8 by default, BOM detection, explicit encoding override, and visible replacement-character warning.
- Batch metadata editing from filename patterns.
- Preserve original source, extracted text, structural offsets, and analysis recipe separately.
- Corpus tree supports include/exclude without deleting.

### Chapter/section detection

Use evidence in descending order:

1. EPUB spine/nav and Markdown heading AST.
2. Explicit user-supplied delimiter or regex.
3. Conservative headings such as “Chapter XII,” Markdown-style headings, or short title-like lines.
4. Fixed-token analytical segments, clearly distinguished from real chapters.

Always preview detected boundaries and allow split, merge, rename, and reorder. Heuristics must never silently redefine source structure.

### File formats

| Priority | Format | Recommendation |
|---|---|---|
| Core | Plain text | First-class; streaming decode, line-ending normalization, encoding warning. |
| Core | Markdown | Parse an AST to preserve headings and extract prose; decide visibly whether code, link destinations, front matter, and HTML count as text. |
| High-value | EPUB 2/3 | Extract metadata, spine order, nav, XHTML text, and heading boundaries. Reject DRM. Never mount book HTML; parse detached and consume text only. |
| High-value | HTML/XML | Optional clean text extraction with a user preview; do not market general TEI support until a real TEI profile exists. |
| Stretch | PDF | Use PDF.js text extraction, page boundaries, and a preview. Warn about columns, headers/footers, hyphenation, ligatures, reading order, and image-only pages. |
| Cut initially | Scanned PDF/OCR, DOCX, proprietary ebooks | Too much bundle/quality surface for the core. Add only from demonstrated demand. |

PDF is a page-description format, not a reliable narrative-text format. It should never be a launch requirement.

## Term-group definition UX

- Persistent left-side query notebook with named groups.
- Fast add from frequency table, KWIC, reader selection, or pasted newline/comma list.
- Suggestions show corpus count, document range, and representative surface forms.
- Clear syntax preview for exact token, quoted phrase, wildcard, and advanced regex.
- Alias/entity groups reuse the same underlying group abstraction.
- Per-group count and tiny occurrence sparkline update incrementally.
- Duplicate, reorder, mute, solo, rename, and export groups.
- A method drawer shows normalization, overlap behavior, denominator, bin count, and smoothing.

Google Books Ngram Viewer is a useful model for concise query composition, URL state, normalization, and explicit smoothing. It supports arithmetic-style composition and corpus selection and explains its moving-average behavior ([official Ngram documentation](https://books.google.com/ngrams/info)). textTrends should borrow that legibility, but avoid an overly clever expression language in v1.

## Cross-text comparison

- Any hierarchy node or tag-defined set can fill A or B.
- “One versus rest” and “each document versus corpus” shortcuts.
- Shared-scale small multiples by default.
- Explicit denominator, sample-size equalization option, and section/document range.
- Term-group timelines can compare relative position within works or a declared ordered series.
- Structural boundaries are always visible.
- Save named comparisons in the project.

## Shareable and serializable state

A static app cannot put a large private corpus into a normal share URL. Separate two products:

1. **Share link**: a versioned, compact analysis/view configuration containing group definitions, selected metadata filters, chart settings, and expected corpus content hashes. It excludes source text. The recipient is prompted to load matching files. Enforce a URL size limit; do not hide megabytes in a fragment.
2. **Portable project file**: a ZIP-based file such as project.texttrends containing a versioned JSON manifest, methods, metadata, groups, views, and optionally source text. Make “embed source texts” an explicit privacy/copyright choice. Derived caches can be omitted and rebuilt.

Validate imported state against a schema, migrate old schema versions, and preserve unknown future fields when practical. Include application version, analyzer versions, locale, content hashes, and timestamp. Human-readable JSON export is as important as convenient re-import.

## Export

### Core

- CSV/TSV for every table, with counts and method/provenance columns.
- JSON for structured analysis output and project manifests.
- SVG for plots, preserving text and direct labels.
- Portable project file.

### High-value

- High-resolution PNG generated from SVG/canvas on demand.
- A self-contained HTML/Markdown methods-and-figures report.
- Copy selected rows as TSV and copy a citation/method note.

CSV export must neutralize spreadsheet-formula prefixes. Export filenames should include analysis, selection, and date. A chart export without denominator, window/bin settings, and corpus selection is not reproducible.

## Performance and storage architecture

### Analysis pipeline

1. **Ingest**: stream or chunk source files; compute SHA-256.
2. **Parse**: obtain source text, metadata, and structural spans.
3. **Segment/tokenize**: preserve original character offsets and produce normalized token IDs.
4. **Index**: positional inverted index plus document/section boundaries.
5. **Aggregate**: corpus counts, document counts, and coarse multi-resolution bins.
6. **Query**: exact tokens and phrases from the index; on-demand passes for n-grams and advanced analyses.
7. **Present**: send compact result arrays to the UI, never the full token graph.

### Representation

- Intern normalized tokens into an integer dictionary.
- Store per-token original start/end offset, normalized token ID, document ID, and sentence/section boundary data in typed arrays where measurement shows a benefit.
- Store postings as sorted Uint32Array positions per document/term.
- Use prefix sums or multi-resolution count bins for immediate zoomed timelines.
- Keep original text in worker/IndexedDB storage and request only reader excerpts.
- Store analysis recipes and indexes under content hash + analyzer version + locale/options.

This supports phrase intersection, KWIC, and dispersion with one coherent index. Do **not** adopt MiniSearch or FlexSearch as the corpus engine: they are optimized for ranked document retrieval, not exact token positions, phrase concordance, overlapping groups, and narrative-time aggregation. They may be useful someday for searching project metadata, which does not justify a dependency now.

### Workers

- Parsing, tokenization, indexing, NLP, clustering, and regex run off the main thread.
- Start with one long-lived module worker and an explicit typed message protocol for progress, cancellation, errors, and transferable buffers.
- Use job IDs and AbortSignal-like cancellation semantics; terminate and recreate the worker for a runaway advanced regex.
- Add a small pool only after benchmarks show independent jobs benefit. Multiple full NLP workers can multiply model memory.

Web Workers exchange structured-clone data and transferable buffers; careless copying can double peak memory ([MDN worker guidance](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers), [structured clone](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Structured_clone_algorithm)).

Avoid SharedArrayBuffer in the baseline: it creates cross-origin-isolation header requirements that are awkward on arbitrary static hosts.

### Incremental behavior

- Show each document as parsed/indexed; allow queries against completed documents.
- Invalidate only affected documents when order/metadata changes.
- A normalization-recipe change invalidates token-derived indexes but not source extraction.
- A new term group queries the existing index; it does not re-tokenize.
- Cache expensive optional NLP annotations separately from the lexical index.
- Virtualize KWIC and large ranked tables.
- Cap chart points to the pixel budget by requesting appropriate aggregate bins, not by rendering tens of thousands of SVG marks.

### IndexedDB

Use IndexedDB for parsed texts, indexes, NLP annotations, project autosave, and cached model metadata. Use content-addressed records and schema migrations. Show storage use, last access, and “clear derived caches” separately from “delete project/source.”

[Dexie](https://dexie.org/docs/Dexie/Dexie) is a justified wrapper: it keeps schema/transaction code compact without imposing a remote data model. Ask for persistent storage when the user chooses to keep a large project, and gracefully handle quota eviction.

### Performance budgets

Set and continuously benchmark explicit targets rather than claiming “unlimited”:

- Main thread remains responsive during all ingestion/analysis.
- First document becomes inspectable before the whole corpus completes.
- Cached project reopens without re-tokenizing.
- Term/phrase queries return interactively after indexing.
- Initial engineering benchmark tiers: 1 million, 10 million, and 50 million word tokens on a mid-range laptop, with peak memory and cold/warm timings recorded.
- Algorithms with quadratic behavior declare caps before running.

Large-corpus support is a data-layout and lifecycle feature, not a WebGPU feature.

### Security and privacy

- No corpus upload, analytics payload, or remote model request without explicit disclosure.
- Never insert EPUB/Markdown/HTML source as live HTML; use detached parsing and text nodes.
- Treat project files, metadata, regex, SVG text, and CSV cells as hostile input.
- Content Security Policy should disallow arbitrary script and object embedding.
- Pin optional model URLs and revisions; display model license and size before download.
- Provide one-click deletion of project data and model caches.

## Dependency recommendations

Versions below are the current npm versions checked on 2026-07-19. Pin exact versions in the lockfile, use automated update PRs, and re-evaluate them at implementation time. Version currency is not a reason to introduce a dependency.

### Application foundation

| Dependency | Recommendation and tradeoff |
|---|---|
| [React 19.2.7](https://www.npmjs.com/package/react) + [react-dom 19.2.7](https://www.npmjs.com/package/react-dom) | Use. The app has enough linked interactive state to justify React, and the team already has historical React context. Keep analysis/domain code framework-free. |
| [TypeScript 7.0.2](https://www.npmjs.com/package/typescript) | Use in strict mode. Branded IDs, discriminated worker messages, versioned schemas, and exact result types will prevent expensive cross-layer mistakes. |
| [Vite 8.1.5](https://www.npmjs.com/package/vite) + [plugin-react 6.0.3](https://www.npmjs.com/package/@vitejs/plugin-react) | Use for a static build, module workers, code splitting, and a small configuration surface. Verify the hosting base path in CI. |
| [Zustand 5.0.14](https://www.npmjs.com/package/zustand) | Use narrowly for serializable UI/project coordination. Keep corpus text, token arrays, large results, and worker objects outside the store. React context plus reducers is viable, but linked selections and undoable project edits make a small external store worthwhile. |
| [Zod 4.4.3](https://www.npmjs.com/package/zod) | Use at import/worker boundaries for project manifests and external metadata. Do not validate every inner-loop token. |
| Plain CSS | Use custom properties, cascade layers, and a small set of layout primitives. No Tailwind or component framework is needed for a Tufte-like system. Native controls plus carefully built accessible composites keep the visual language coherent. |

### Visualization

| Dependency | Recommendation and tradeoff |
|---|---|
| [Observable Plot 0.6.17](https://www.npmjs.com/package/@observablehq/plot) | Primary library for conventional statistical views: lines, dots, cells, histograms, rules, and facets. Its mark composition and built-in faceting fit small multiples especially well ([Plot marks](https://observablehq.com/plot/features/marks), [facets](https://observablehq.com/plot/features/facets)). Wrap imperative output in a small React component. |
| [D3 7.9.0](https://www.npmjs.com/package/d3) | Use selected D3 modules for scales, shapes, hierarchy, brush/zoom, and bespoke layouts. Plot already depends on D3, so avoid parallel abstractions. Import submodules where it improves tree shaking. |
| Hand-rolled SVG/HTML | Preferred for sparklines, barcodes, inline bars, KWIC, direct labels, and adjacency matrices with simple geometry. These are product-specific and often clearer than coercing a chart framework. |
| [visx 4.0.0](https://www.npmjs.com/package/@visx/visx) | Do not adopt. It adds a second low-level React visualization vocabulary without solving the hard domain-specific views. |

Plot generates SVG and supports layered marks, axes, transforms, and facets; D3 supplies the lower-level scales and geometry ([D3 scale documentation](https://d3js.org/d3-scale)). This combination is smaller and more principled than Plotly/ECharts and less repetitive than building every statistical axis by hand.

### Tokenization, indexing, workers, and storage

| Dependency/API | Recommendation and tradeoff |
|---|---|
| [Intl.Segmenter](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/Segmenter) | Use as the default locale-aware word/sentence boundary primitive with a tested fallback and recorded locale/browser analyzer metadata. Build the app’s own normalization, offset map, dictionary, and postings. |
| Native module Worker | Use with an explicit typed protocol. It makes progress, cancellation, transfer ownership, and lifecycle visible. |
| [Comlink 4.4.2](https://www.npmjs.com/package/comlink) | Do not start with it. It is pleasant for RPC, but the important interface here is streaming progress, cancellation, buffer transfer, and worker restart. Reconsider only if the explicit protocol becomes boilerplate. |
| [Dexie 4.4.4](https://www.npmjs.com/package/dexie) | Use for IndexedDB schema, bulk operations, transactions, and migrations. |
| [TanStack React Virtual 3.14.6](https://www.npmjs.com/package/@tanstack/react-virtual) | Use for KWIC and very large result tables; it is small and headless. |
| Web Crypto SHA-256 | Use content hashes for identity/cache invalidation; no hashing package needed. |
| [fflate 0.8.3](https://www.npmjs.com/package/fflate) | Use for portable project ZIPs and, if needed, focused EPUB extraction. It supports streaming compression and is deliberately small ([official repository](https://github.com/101arrowz/fflate)). |

### Parsing

| Dependency | Recommendation and tradeoff |
|---|---|
| [mdast-util-from-markdown 2.0.3](https://www.npmjs.com/package/mdast-util-from-markdown) | Use directly, without the larger unified pipeline, to extract text and heading structure from Markdown deterministically. |
| [@lingo-reader/epub-parser 0.4.6](https://www.npmjs.com/package/@lingo-reader/epub-parser) | Provisional choice behind an adapter. It is current, browser-oriented, and exposes spine, TOC, metadata, and chapter HTML ([repository/API](https://github.com/hhk-png/lingo-reader)). Its community is small, it currently loads the file into memory, and its own docs warn that extracted HTML is unsafe. Run a fixture/security/bundle spike before committing. Consume detached text only. |
| [epubjs 0.3.93](https://www.npmjs.com/package/epubjs) | Do not choose for extraction. It is a mature reader/rendering library but brings functionality textTrends does not need and its npm release is old. A small focused fflate + DOMParser extractor is the fallback if lingo-reader fails the spike. |
| [pdfjs-dist 6.1.200](https://www.npmjs.com/package/pdfjs-dist) | Stretch-only. Use Mozilla PDF.js in its own lazy chunk/worker and present extracted-page previews. It solves PDF parsing, not OCR or correct reading order ([PDF.js](https://mozilla.github.io/pdf.js/)). |

### In-browser NLP

| Dependency | Recommendation and tradeoff |
|---|---|
| [wink-nlp 2.4.0](https://www.npmjs.com/package/wink-nlp) + [wink-eng-lite-web-model 1.8.1](https://www.npmjs.com/package/wink-eng-lite-web-model) | Recommended optional English pack for sentence boundaries, POS, rule/model NER, negation-aware sentiment, and custom entities. The official docs describe a single-pass pipeline and web models starting around 890 KB gzipped ([winkNLP](https://winkjs.org/wink-nlp.html), [models](https://winkjs.org/wink-nlp/language-models.html)). Validate offsets and accuracy on fiction fixtures; never replace the deterministic core tokenizer silently. |
| [compromise 14.16.0](https://www.npmjs.com/package/compromise) | Good alternative, not a second simultaneous NLP stack. It is actively maintained, client-oriented, roughly 250 KB minified, and offers tokenizer/POS/phrase tiers and plugins ([official repository](https://github.com/spencermountain/compromise)). Prefer it if custom rule patterns and entity correction outperform wink in a spike; prefer wink if the unified POS/NER/sentiment pipeline and model behavior are better. |
| [Transformers.js 4.2.0](https://www.npmjs.com/package/@huggingface/transformers) | Experimental dynamic import only for embeddings/semantic tasks. Never include it in the initial bundle or make WebGPU mandatory. |
| Custom language packs | Define an analyzer interface for tokenization, sentence segmentation, lemma, POS, entities, sentiment, syllables, and capability flags. This avoids coupling project files to one English package. |

Do not run wink and compromise over every corpus and expose conflicting results. Conduct a small evaluation using contemporary fiction, older fiction, dialogue, fantasy names, and non-English samples; pick one English pack and document its error profile.

### Math and clustering

Implement frequency, rates, MATTR, DP, logDice, log ratio, G², BH correction, cosine distance, and Burrows’s Delta as audited pure TypeScript with published test vectors. They are small and central to the product’s meaning.

For k-means, [ml-kmeans 7.0.1](https://www.npmjs.com/package/ml-kmeans) is a reasonable lazy dependency after validating deterministic seeding and matrix representation. Avoid a general statistics or linear-algebra bundle until PCA/NMF is actually scheduled. If PCA is added, isolate it behind the analysis interface and benchmark it; do not let a visualization requirement dictate the corpus data model.

### Testing and quality

- [Vitest 4.1.10](https://www.npmjs.com/package/vitest) for pure analysis, parser fixtures, property tests, cache migrations, and worker protocol tests.
- [Playwright 1.61.1](https://www.npmjs.com/package/playwright) for file import, keyboard interactions, static-host base paths, export, persistence, and Chromium/Firefox/WebKit parity.
- Golden fixture corpora with known tokens, offsets, phrase overlaps, Unicode, apostrophes, hyphens, CJK, RTL, chapter boundaries, and published statistical values.
- Benchmark harness committed with synthetic and public-domain corpora; record cold indexing, warm reopen, query latency, peak worker memory where observable, and export time.
- Accessibility checks plus manual keyboard/screen-reader review. SVG marks need useful accessible summaries; the exact table is the fallback for every chart.

## What to learn from and beat

### Voyant Tools

Voyant offers an enormous tool set—Trends, Contexts, Corpus Terms, Collocates, Phrases, Topics, correlations, networks, and more ([Voyant help index](https://docs.voyant-tools.org/docs/)). Learn from linked macro/micro views, low import friction, stop-word controls, and embeddable/shareable configurations.

Beat it with a coherent selection model, less panel chrome, local-only privacy, explicit method provenance, reversible preprocessing, consistent hierarchy, and fewer but better visual forms. Do not copy Cirrus/word-cloud primacy or the “tool zoo.”

### AntConc

Learn exact concordance practice, context sorting, concordance plots, collocation controls, clusters/n-grams, word lists, keyword lists, reference corpora, and the expectation that a statistic leads to source lines.

Beat it in cross-linked visual comparison, narrative-time small multiples, project persistence, local browser accessibility, and direct manipulation. Do not claim to beat it until KWIC sorting, phrase/wildcard behavior, encoding, export, and reproducibility are excellent.

### Google Books Ngram Viewer

Learn ruthless focus: a simple query, normalized series, visible corpus/period/smoothing controls, compositional operators, URL state, and an explanation of smoothing and data caveats ([official documentation](https://books.google.com/ngrams/info)).

Beat it for user corpora with exact hits, raw counts, structural boundaries, arbitrary metadata groups, comparison statistics, and KWIC. Never hide a minimum-frequency threshold or smoothing.

### Lexos

Learn the explicit workflow from load → scrub → cut → matrix → visualize/cluster, and its pedagogical explanation of analytical choices. Its documented feature set includes word/character n-grams, TF-IDF matrices, rolling windows, hierarchical/k-means clustering, and distinctive “top words” ([Wheaton overview](https://wheatoncollege.edu/academics/special-projects-initiatives/lexomics/introduction-lexomics/)).

Beat it with non-destructive recipes, a tighter reader/concordance loop, robust offline persistence, multi-resolution narrative timelines, and a simpler visual grammar. Avoid Voronoi/bubble/word-cloud detours.

## Recommended delivery sequence

### Phase 0 — analysis contract

- Define source, structure, token, normalization recipe, analyzer capability, selection, query, occurrence, and result schemas.
- Establish offset/Unicode fixtures and benchmark tiers.
- Write method specifications and published-value tests before UI work.

### Phase 1 — trustworthy lexical workbench

- TXT/Markdown, ordered hierarchy, metadata, chapter review.
- Worker tokenization/indexing and IndexedDB cache.
- Corpus inventory, frequency table, term groups, exact/phrase search, timelines/barcodes, KWIC/source reader.
- Project autosave, URL configuration, CSV/JSON/SVG/project export.

This is the minimum lovable replacement for the existing app.

### Phase 2 — comparison and corpus linguistics

- N-grams, dispersion, collocations.
- A/B comparison, log ratio + G², document range.
- MATTR/MTLD, structure distributions.
- EPUB after the parser spike.

### Phase 3 — optional English/literary pack

- POS, English readability, NER suggestions, entity/alias registry.
- Character timelines and adjacency matrices.
- Dialogue/narration heuristic.
- Stylometry and bounded clustering.

### Phase 4 — explicitly experimental lab

- Sentiment/emotion with evidence.
- TF-IDF segment clustering/NMF.
- Lazy embeddings and semantic passage search.
- PDF text extraction.
- Near-duplicate passages.

Experimental outputs should serialize their model/lexicon revision and remain visually distinct from deterministic lexical results.

## Explicit cuts

For clarity, I would not put the following on the normal roadmap:

- Word clouds, streamgraphs, decorative bubbles, radar charts, 3-D, and default force networks.
- Automatic “themes,” generated summaries, or LLM interpretation.
- Universal coreference or dialogue-speaker attribution.
- Sentiment as a core feature or a single authoritative “emotion arc.”
- Eager whole-corpus embeddings.
- PDF/OCR as a launch requirement.
- Full TEI, DOCX, and every ebook format before demonstrated demand.
- A public corpus hosting/upload service.
- A plugin architecture before the internal analyzer interface has at least two real implementations.
- Redux, a component design system, Plotly/ECharts, visx, MiniSearch/FlexSearch, and multiple NLP stacks.
- Dozens of readability, lexical diversity, association, and clustering metrics merely because formulas exist.

## Final judgment

The rewrite can be unusually strong if it resists breadth for breadth’s sake. The winning combination is:

- AntConc’s evidentiary discipline,
- Voyant’s linked overview-to-reading interaction,
- Google Ngram’s query and method legibility,
- Lexos’s explicit preprocessing/segmentation workflow,
- and a cleaner, local-first, Tufte-like presentation.

The architectural center should be a deterministic positional corpus index with stable source offsets and a versioned analysis recipe. Everything reliable—frequency, groups, narrative timelines, dispersion, n-grams, KWIC, collocation, keyness, structure, and many stylometric features—can be derived from that foundation efficiently in a browser. NLP and model features should enrich it without ever becoming the source of truth.
