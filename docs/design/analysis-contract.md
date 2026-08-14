# Analysis contract

This document describes the current semantic boundary. The TypeScript types
and validators in `packages/core` and `apps/web/src/shared` are the executable
authority when this summary and the code disagree.

## Product boundary

textTrends analyzes an ordered corpus of documents. A document is the only
content division carried through extraction, indexing, snapshots, queries, and
persistence. The system does not infer, save, edit, query, or display a
hierarchy inside a document.

That boundary is intentional. Plain-text sources do not provide dependable
internal divisions, and format-specific divisions would make the same analysis
behave differently solely because of its container.

## Identity pipeline

Every derived value is tied to the input and recipe that produced it:

```text
source bytes + extraction recipe
    -> source hash + extraction artifact + verified text hash

verified text + index recipe + segmenter fingerprint
    -> document index + index artifact hash

ordered ready document indexes + generation
    -> immutable corpus snapshot
```

Stored hashes are assertions, not trusted labels. Durable admission and warm
cache admission recompute or validate the identities they depend on. A partial
snapshot contains ready documents in declared order and explicitly names
missing documents.

Snapshot identity includes the generation, declared order, each ready
document's index identity and corpus-axis token geometry, and the merged
vocabulary identity. Reordering or replacing a document therefore produces a
new snapshot.

## Sources and extraction

Supported inputs are TXT, Markdown, HTML/XHTML, and EPUB.

- TXT and Markdown preserve the decoded source as indexed text. Markdown is a
  literal text format; markup is not interpreted as document metadata.
- HTML is parsed inertly with the pinned HTML5 parser and serialized to plain
  reading text. Scripts and styles do not enter the result.
- EPUB follows the pinned reading-order and partition policy, extracts the
  selected XHTML bodies, and joins their text into one document. The source
  descriptor may report how many container documents were read, but this is
  extraction provenance rather than an analyzable hierarchy.

Extraction produces one `texttrends/extraction/1` artifact containing source,
recipe, text, descriptor, length, and decode evidence. The canonical text is a
separate storage value keyed by its text hash.

Decoder behavior is deterministic: BOM-declared Unicode wins, otherwise
strict UTF-8 is attempted before the pinned Windows-1252 fallback. Ill-formed
UTF-16 and decoder replacement output are rejected. Newline normalization is
currently disabled and therefore part of the recipe identity.

## Index and coordinates

Each document index owns token classes, character starts and lengths,
vocabulary, postings, sentence spans, and paragraph spans. Token position is a
zero-based half-open coordinate within a document; user-facing positions are
rendered one-based. Character positions are UTF-16 offsets into canonical
extracted text.

The corpus snapshot adds a declared-sequence token base for each ready
document. Analyses use either document-relative or declared-sequence
coordinates explicitly; they never infer a coordinate from presentation.

A linked selection is transient, snapshot-bound intent made of ordered,
non-overlapping document token ranges. It scopes selected trend and dispersion
overlays plus the selection-following inventory and frequency work used by
Vocabulary and contextual Method surfaces. A separate full-corpus inventory
resident supplies stable text facts and Inputs provenance; a linked selection
never cancels or relabels that baseline. Continuous `concordance-window`, Reader
paging, and exact occurrence stepping always use canonical full-corpus
coordinates and are never clipped or reissued by that analytical selection.

## Worker generation

The browser worker owns artifact admission, indexing, snapshot publication,
query execution, and durable project admission. The main thread owns the
working project and presentation state.

The per-document cold build phases are:

```text
decode -> extract -> segment -> index -> compose
```

Transformed formats perform their internal parsing in the extract phase. A
warm hit may compose directly from verified text and an admitted index. If an
index is missing or corrupt while text is valid, it is rebuilt from text
without returning to the source container.

Generation publication is monotone: ready sets grow in declared order, stale
jobs cannot publish into a newer generation, and every query result is bound
to the snapshot against which it ran.

## Query operations

The wire protocol has a closed query union:

- `trend` — equal-token-bin counts or rates for one term group;
- `dispersion` — bounded exact positions or honest density buckets for shown
  groups;
- `concordance-window` — exact bounded windows plus an optional sparse rank
  axis over enabled tracks in canonical full-corpus reading order;
- `inventory` — corpus and per-document measurements plus sentence rhythm;
- `freq-list` — bounded frequency, document-frequency, dispersion, and lexical
  diversity ranking;
- `keyness` — explicit disjoint A/B comparison using log ratio and G²; and
- `reader-page` — bounded directional source slices with occurrence marks;
  the browser derives visual pages from actual layout; and
- `occurrence-step` — one exact previous/next full-corpus occurrence stop.

Each operation owns a versioned method record, exact runtime validation,
bounded output, deterministic tie rules, explicit missing-document behavior,
and cancellation checkpoints appropriate to its loops. There is no generic
statistics operation and no unbounded occurrence transport.

## Persistence

Persistence has two owners:

1. `texttrends-library` stores content-addressed source files and exactly one
   current workspace. File deletion and workspace reconciliation share an
   atomic transaction, so deleting an active source removes every document
   backed by it. Workspace writes are last-write-wins; there is no multi-tab
   edit or conflict model.
2. `texttrends-artifacts-provisional-db3` stores disposable verified text and
   document indexes. It can always be discarded and rebuilt from library or
   bundled source bytes.

The workspace stores corpus references and order, document metadata, notebook
groups, and analysis-view settings. Reader position, linked selection, current
passage, and navigation history are transient.

Pre-alpha schemas are deliberately strict. Unsupported old records fail
cleanly instead of being silently upgraded or partially interpreted.

## Trust boundaries

- Runtime validators accept `unknown`, require exact dense shapes, and reject
  unexpected fields at protocol and persistence boundaries.
- Canonical recipes are copied into owned, frozen records before hashing.
- Transferred typed arrays are validated after receipt and are never reused as
  mutable cache authority.
- Cached artifacts are shallow-checked by storage adapters and deeply admitted
  by the engine or core validator.
- Missing library sources are reconciled before a workspace opens. Artifact
  persistence failures degrade analysis safely and surface bounded warnings.

## Change rule

Any change that alters extracted text, token geometry, query meaning, durable
shape, or result ordering must change the responsible recipe, method, schema,
or database identity. Presentation-only changes must not issue analysis work
or mutate the durable workspace.
