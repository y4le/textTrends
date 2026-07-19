# Research input: dependency landscape survey (verified July 2026)

*Produced by a Claude research agent with web verification of maintenance status,
2026-07-19. Condensed.*

## Recommended stack at a glance

| Layer | Pick | Approx cost (gz) |
|---|---|---|
| NLP core (tokens, sentences, POS, lemmas, sentiment) | wink-nlp + wink-eng-lite-web-model | ~1 MB model + 10 kB |
| Character/place suggestion | compromise (`.people()`) | ~75 kB |
| Readability | syllable + wooorm formula packages (or inline) | ~10 kB |
| Embeddings (optional, lazy) | @huggingface/transformers v4 + MiniLM-L6-v2 q8 | ~23 MB model, cached |
| Corpus index | Hand-rolled typed-array positional index + Intl.Segmenter | 0 deps, ~200 LOC |
| Fuzzy term search box | minisearch over the vocab list only | ~8 kB |
| Visualization | Hand-rolled SVG in React + d3-scale/d3-shape/d3-array as math; 2D canvas for dense strips | ~28–35 kB |
| EPUB | fflate + native DOMParser (hand-rolled OPF/spine, ~150 LOC) | ~8 kB |
| PDF | pdfjs-dist, lazy-chunked, second-class input | ~300 kB + 1 MB worker (lazy) |
| Workers | comlink + Vite module workers, Transferable buffers | ~1.1 kB |
| Caching | idb (IndexedDB), content-hash keyed, recomputable artifacts | ~1.2 kB |
| State | zustand; nuqs for URL state; wouter or no router | <10 kB total |

Avoid: epubjs (dead), lunr (dead), threads.js (dead), spaCy-via-Pyodide, Observable
Plot (stale + heavy), visx (shaky), Recharts/nivo, flexsearch, SharedArrayBuffer/
coi-serviceworker, d3-selection/d3-axis.

## Key findings

**NLP.** wink-nlp (v2.4.0 Jun 2025, ~650k tokens/s, single-pass tokens/sentences/POS/
lemmas/sentiment/NER; single-maintainer risk, English-only) is the core pipeline pick.
compromise (v14.15.1 Jun 2026, very active, ~75 kB) is better at person-name detection
in fiction — use for character *suggestions* only; its POS is mediocre. transformers.js
v4 (Feb 2026, WebGPU rewrite, active) strictly for optional lazy embeddings —
transformer NER/sentiment over a full corpus is 10–100× slower than wink. No credible
spaCy-in-WASM exists. Sentiment: wink's built-in per-sentence scores free; vader as
alternate lexicon; smoothing choice matters more than lexicon choice. Lemmas over stems
for UI-facing grouping.

**Indexing — the clearest call: hand-roll.** flexsearch/minisearch/orama/lunr are
document-retrieval engines; none exposes positional postings, which KWIC, ±N collocation
windows, narrative-time bucketing, and dispersion all require. The structure is ~200 LOC:
`tokens` Uint32Array (IDs in corpus order), `starts` Uint32Array (char offsets → raw
text, powers KWIC), `vocab` Map + array, per-term postings Uint32Arrays (one
counting-sort pass), `docBounds`. ~15–20 MB resident for 5M chars. Lives in a worker;
transfers zero-copy. Tokenizer: `Intl.Segmenter` (Baseline since 2024; handles
contractions, CJK; `isWordLike`); one-time 1–2 s index build in a worker, cached.

**Visualization.** Hand-rolled SVG in React + d3 submodules as pure math (d3-array 5 kB,
d3-shape 8 kB, d3-scale 16 kB ≈ 28 kB) — 2025/26 consensus best practice and the only
Tufte-grade option. Observable Plot: last release Feb 2025 (~17 mo stale; Observable
pivoted away), 130 kB, renders outside React's tree — awkward for linked brushing.
visx: Airbnb acknowledges reduced cadence, React 19 support languished — avoid. Dense
per-token strips: 2D canvas (d3 scales work identically), optional OffscreenCanvas;
hybrid canvas-marks + SVG-overlay pattern. @tanstack/react-virtual (~5 kB) for long
sparkline lists.

**Parsing.** EPUB: hand-roll on fflate (0.8.3 May 2026, active, ~8 kB) + DOMParser;
epubjs is dead (Sep 2023) and is a renderer, not an extractor; foliate-js is good
reference code but API-unstable — crib, don't depend. PDF: pdfjs-dist (6.1.200 Jun 2026)
only serious option; dynamic-import only; ship hyphenation/header-footer cleanup; mark
second-class. Markdown: ~30-line regex strip beats a parser for analysis. Encoding: BOM
sniff → TextDecoder utf-8 fatal → windows-1252 fallback covers ~99.9%; lazy chardet
(2.2.0 Jun 2026) only on failure.

**Perf infra.** comlink (4.4.2 Nov 2024 — "done not dead") + Vite module workers; always
`Comlink.transfer()` big buffers. threads.js abandoned. idb (~1.2 kB, v8) for
IndexedDB; content-hash keys; everything cached must be recomputable (eviction = perf
event, not data loss). OPFS: Chrome/Firefox fast path only (Safari writable-stream gaps,
7-day eviction). **SharedArrayBuffer: architect around not needing it** — GitHub Pages
cannot set COOP/COEP; coi-serviceworker costs a first-load reload; Transferables +
partitioned slices cover this workload. WASM not needed for the core pipeline.

**App shell.** zustand (~1.1 kB, React 19 fine): worker handlers call `store.setState`
directly; keep raw text/indexes out of React state entirely. nuqs (v2.9.0, very active,
plain-React adapter) for URL state. Router: possibly none, else wouter (~2.1 kB,
`useHashLocation` sidesteps Pages' 404-on-deep-link). Vite: `base`, `.nojekyll`, lazy
import() boundaries around transformers.js/pdfjs.

## Maintenance red flags (2025/26)

epubjs dead (Sep 2023) · lunr dead (2020) · Observable Plot stale (Feb 2025, company
pivoted) · visx reduced cadence, users migrating off · threads.js abandoned · comlink
slow but stable · `sentiment` (AFINN) 7 years untouched · wink-nlp healthy but
single-maintainer · flexsearch alive but churning API (moot — no positions).

**Baseline JS budget: ~150–200 kB gz** (React + zustand + nuqs + d3 math + fflate +
minisearch + compromise), plus ~1 MB wink model fetched once and cached; pdfjs and
transformers.js as lazy opt-in chunks.
