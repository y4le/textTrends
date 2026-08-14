# Inputs workspace — shipped design and forward proposal

Status: core redesign shipped on 2026-08-13. This record combines the product
proposal, the architecture rulings made with Claude Opus before implementation,
and the follow-on opportunities that were deliberately kept out of the core
change.

## Product intent

Inputs is the composition surface for the analysis workbench. It is the first
standard tab, not a setup screen or modal precondition. An empty workspace opens
Inputs; a workspace with active texts opens Trends unless the URL explicitly
names another place. The empty workspace is valid and settled: it does not
secretly seed a demo or wait forever for a corpus that does not exist.

The surface answers three questions in order:

1. What texts are being analyzed, and in what order?
2. What other texts can be activated or acquired?
3. What is known about every active text and every active term?

## Shipped information architecture

The acquisition area contains four bounded cards:

1. **Active inputs** — the ordered analysis corpus. OS-file drops and saved
   texts can be added here. Pointer drag and keyboard-accessible up/down actions
   use the same ordering command. Removing a text does not delete its saved
   bytes from the local library. A confirmed **Clear all** action resets every
   active text and term together while retaining those saved bytes.
2. **Local library** — content-addressed browser-local storage. Files can be
   saved without activation, activated later, or deleted independently.
3. **Load from Standard Ebooks** — public-domain acquisition through the
   searchable catalog, saved locally before activation.
4. **Load demo** — prepared corpora acquired as ordinary local texts. Demo
   suggestions append terms without replacing authored terms; demo texts can be
   reordered, removed, and reactivated exactly like any other text.

The grid is three columns when space permits, two at intermediate widths, and
one on compact screens. Active inputs spans the full grid because corpus order
is the primary composition task. File selection remains a real focusable input;
all acquisition paths share one exclusive library-operation lane and report a
losing race in the card where it occurred. Reordering pauses while an import is
in flight, and pending or failed imports remain visible in Active inputs.

## Shipped text details

Text details sits directly below the four cards. It is intentionally a stable
full-corpus reference: a linked range selected in Trends may re-scope
Vocabulary, Concordance, and other analytical overlays, but it does not rewrite
the facts shown for an input text.

The summary exposes, for every active text:

- full token count;
- exact count and rate per 10,000 tokens for every active term;
- a sentence-rhythm mark;
- a deliberate action for using the whole text as the linked analysis scope.

The corpus row totals the same token and term measures. The header summarizes
text count, tokens, types, sentences, and paragraphs. All active term columns
remain present on compact screens inside a keyboard-focusable horizontal data
port; the page itself does not overflow.

Expanding a text adds:

- selected/full, lexical/numeral, and UTF-16 extents;
- types and hapax count;
- sentence and paragraph counts;
- sentence mean, median, and p90 length plus paragraph mean;
- TTR, explicitly labelled length-dependent, and MATTR;
- the complete active-term count/rate list;
- exact sentence-rhythm bins.

The focused text's Source details panel separately reports format, byte size,
detected encoding, replacement characters, and suspicious control-character
diagnostics.

Vocabulary growth is not attributed to a text from the resident corpus curve.
That curve accumulates vocabulary over the whole selection, so the text detail
states the limitation and relies on types, TTR, and MATTR for text-level lexical
description. Method provenance follows the same truth: Inputs reports the
full-corpus inventory even while another place owns a linked range. Trends TSV
exports include both a reader-facing title and stable `document_id`, since
titles are not unique identifiers. Other provenance prose currently favors
titles; pairing ids with titles in selection and Compare-side parameters is a
P1 follow-up below.

## Architecture rulings

The Opus consultation established these constraints before implementation:

- **One ordinary document model.** A demo is acquisition plus additive starter
  terms, never a special corpus object. Legacy built-in workspaces migrate in
  the background while retaining the notebook and authored view settings. The
  old built-in document ids are replaced by new local ids, so document focus
  and Compare sides are reconciled; the legacy schema stored no corpus order.
- **One library mutation owner.** Demo fetch/save/activation, Standard Ebooks,
  OS files, activation, and deletion coordinate through the same lease lane.
- **Two inventory residents.** `inventory` follows the linked selection for
  Vocabulary and Method. `corpusInventory` owns full-text facts for Inputs in a
  separate query lane. A range cannot cancel a baseline that is still landing;
  clearing the range reuses the authenticated resident result.
- **Snapshot-bounded identity.** Both residents are invalidated by snapshot
  identity, and late writes are fenced. Full token extents remain available to
  geometry and scope actions while a range result is visible.
- **Readable and joinable Trends rows.** UI prose uses titles, while each Trends
  result row retains its document id beside the title. Other id-bearing
  provenance parameters still need the same paired representation.
- **Native semantics first.** Reorder boundaries keep focus and announce the
  no-op; disabled state is truthful to assistive technology; live regions stay
  mounted; sticky/fixed chrome is handled with scroll padding rather than test
  bypasses.

## Next opportunities

The following are proposals, not claims about the shipped worker results.

### P1 — usability without new statistical semantics

- Add search, sort, and multi-select to Active inputs and Local library once a
  corpus grows beyond roughly 20 texts. Preserve declared order as the default;
  a temporary sort must never silently rewrite it. Reordering currently pauses
  while an import is in flight, so bulk/sort controls must expose that state.
- Add bulk activate, deactivate, and export actions with a reviewable selection
  count. Library deletion stays a separate, explicitly destructive action.
- Clarify Local library acquisition verbs: dropping currently saves without
  activation while its **Add files** control saves and activates. Separate
  **Save files** and **Add to active inputs** language before adding bulk paths.
- Add per-card progress with filename and phase for long EPUB imports and
  network acquisitions, while retaining the single-operation ownership rule.
- Report total local-library storage and approaching quota pressure. Partial
  commits after a quota failure remain visible and recoverable.
- Surface source-health diagnostics inside the expanded text detail, then add
  filters for encoding inference, replacements, extraction warnings, and
  missing metadata. These are diagnostics, not quality scores.
- Add a compact sticky first column or term chooser only after testing five-term
  tables at 320px. Every term must remain reachable by keyboard and exposed to
  assistive technology.
- Derive **new types introduced in declared order** from the resident cumulative
  growth samples at document boundaries. Label its order dependence explicitly;
  it is not a text-exclusive vocabulary count.
- Summarize active-term **document frequency** (text count and percentage with
  at least one occurrence) from the resident per-text term cells. Preserve the
  Vocabulary export's existing name rather than inventing “coverage.”
- Expose the already-resident per-bin sentence median beside the rhythm mean,
  so the rhythm detail does not rely on a lone average.
- Add a downloadable Text details TSV with one row per text/term and method
  fields, retaining both title and `document_id`.
- Pair ids with titles in selection and Compare-side provenance parameters;
  readable prose must not make two same-titled texts indistinguishable.

### P2 — bounded worker/result extensions

- Add token-length distribution and sentence-length quartiles. Sentence median
  and p90 already ship; new fields require a versioned inventory result change,
  tokenizer disclosure, bounded arrays, and fixtures.
- Add per-text vocabulary-growth curves only through per-text inventory queries
  or a bounded worker result that returns per-document curves. Do not slice the
  cumulative corpus curve and relabel it.
- Add shared and text-exclusive type counts only after the worker exposes the
  required per-document type-set evidence or bounded derived counts. They are
  not recoverable from the existing per-text totals.

### P3 — analysis that requires an explicit method decision

- Any lexical-overlap measure must compare a text with the **rest** of the
  corpus, not the corpus containing that text. It needs a named/versioned method,
  per-document type sets, hand-computed fixtures, and a warning that Jaccard-like
  measures remain sensitive to vocabulary size.
- Readability must follow the specified-only Flesch, Flesch–Kincaid, and ARI
  contracts in [statistics.md](statistics.md), including declared language,
  sentence/token rules, and fixtures. Unsupported languages show no score.
- Lexical-density or stopword measures require a versioned resource and
  transparent token-class policy. The current common-word list has unrecorded
  origin and unknown rights, an open blocker in
  [corpus-inventory.md](corpus-inventory.md); it cannot become method evidence.
- Automatic language detection may be offered as a suggestion with confidence
  and an override. It must not silently change tokenization or analysis.
- Distinctive vocabulary belongs on the existing Compare/keyness foundation;
  a per-text shortcut may configure that place, but Inputs should not duplicate
  a second statistical implementation.

## Explicit non-goals

- No implicit demo load, special demo ordering, or replacement of user terms.
- No range-scoped number presented as a full-text fact.
- No count without its denominator when texts of different lengths are compared.
- No readability, sentiment, language, or “quality” score without a named,
  versioned method and supported evidence.
- No new document-bearing result table may use a title as its sole identity;
  existing title-only provenance parameters are tracked as P1 debt above.
- No library deletion coupled to removing a text from active analysis.

## Acceptance signals for follow-on work

A future addition should preserve the current invariants and demonstrate:

- empty and non-empty default routing;
- no duplicate library writes under overlapping acquisition attempts;
- stable full-text details during a linked-range query;
- exact count/rate agreement between table, detail, and export;
- keyboard and pointer reorder parity with retained focus;
- no page-width overflow at 320px and usable access to every active term;
- provenance that names the method, selection, denominator, and completeness;
  document-bearing rows and parameters must pair readable titles with stable
  document identity.
