# Responsive Compare implementation decision

Status: preimplementation decision record for the Compare half of Stage 5 in
`docs/design/workbench-ux.md`.

This record incorporates the repository-grounded Claude Opus architecture
consultation `art_sha256_ec6b1bfdd522c5da352af9c26ed66934e39d94186fe431ff0723acbf4438e2d0`.

## Product and contract law

Compare owns an explicit A/B corpus comparison. A linked Trends range never
changes either side. It uses the delivered `keyness-g2-2x2/1` worker contract
and `log-ratio-halves/1` effect without changing either worker or durable
research schema.

The contract returns two independently sorted, independently paged
projections:

- side A contains only rows whose log-ratio is greater than zero;
- side B contains only rows whose log-ratio is less than zero;
- a row whose log-ratio is exactly zero belongs to neither projection;
- per-side `total` and page offsets therefore remain distinct.

The UI must not interleave or reorder those projections into a fake monotone
list. It renders two labelled rank rowgroups, A above B, against one shared
zero line and one shared page-local log-ratio scale. Vertical order is rank
within a projection. Horizontal geometry is effect direction and magnitude.

`rangeA` and `rangeB` are document frequencies in corpus-linguistic
terminology. The UI calls them “documents A” and “documents B.” Existing TSV
column names `range_A` and `range_B` remain stable.

No confidence intervals are available. Small-side warnings, the missing-zero
projection rule, the page-local display normalization, and the linked-range
exception remain visible in Compare and Method. Method records the general
display rule, not the ephemeral numeric maximum for the current pages; the
caption owns that exact live value. A zero-token side and an overlapping side
remain honest errors rather than empty plots.

## Live and durable view isomorphism

The current live `KeynessViewV1` can express a side-B sort field and page size
that `keyness-view/1` cannot persist. This phase removes that invalid state.
The live shape becomes:

```ts
interface KeynessViewV1 {
  schema: 'texttrends/keyness-view/1';
  mode: 'documents' | 'document-rest';
  documentA: string | null;
  documentB: string | null;
  restOn: 'a' | 'b';
  minCountTotal: number;
  minDocFreqTotal: number;
  classes: readonly FrequencyTokenClassV1[];
  sort: {
    by: KeynessSortFieldV1;
    dirA: 1 | -1;
    dirB: 1 | -1;
  };
  pageLimit: number;
  offsetA: number;
  offsetB: number;
}
```

There is one shared filter, sort field, and page size. Directions and page
offsets remain independent. The durable record already carries the shared
field, shared page size, and both directions. It deliberately does not carry
offsets, so save/reload restores both offsets to zero. Serialization selects
no arbitrary “A” value, and restore injects the durable record without
inventing a B value. Tests prove round-trip equivalence modulo offsets.

Changing the shared sort field preserves both directions verbatim. The active
summary always states both directions, so Apply has no hidden secondary
effect.

## Store commands and query budget

The per-side filter/sort-field/page-size commands are replaced by:

```ts
interface KeynessSettingsInputV1 {
  minCountTotal: number;
  minDocFreqTotal: number;
  classes: readonly FrequencyTokenClassV1[];
  sortBy: KeynessSortFieldV1;
  pageLimit: number;
}

applyKeynessSettings(input: KeynessSettingsInputV1): void;
setKeynessDirection(side: 'a' | 'b'): void;
setKeynessPage(side: 'a' | 'b', offset: number): void;
```

`applyKeynessSettings` validates the exact worker bounds, publishes one
complete live view, resets both offsets, and issues exactly two keyness-table
queries and zero inventory queries. It retains side evidence because side
membership did not change.

`setKeynessDirection` toggles only that side, resets only its offset, and
issues one query. `setKeynessPage` preserves the 5,000-row refusal rule and
issues one query. Mode, document, and Swap changes continue to reset both
offsets, clear side evidence, and rerun both tables and both side inventories.
The reshaped intent key includes the shared filter and sort field, that side's
direction and page, the side selections, and the projection side. It continues
to reject superseded results independently: a stale side-A result cannot land
while a current side-B result does.

Applying shared settings or toggling either durable direction dirties research.
Paging does not, because offsets are deliberately transient. Opening, closing,
or transforming presentation does not dirty research.

## Responsive information order

DOM and reading order are:

1. comparison mode, side A, 44px Swap, and side B;
2. both side summaries, with selected-class tokens/documents and whole-side
   types/sentences named as distinct denominator groups;
3. per-side small-sample warnings and the standing uncertainty warning;
4. the complete active-settings summary and one 44px sort/filter disclosure;
5. the signed axis;
6. Method through the existing governed surface.

Comparison controls wrap vertically at compact width without changing the
semantic view. Selects and text inputs use at least 16px text and all primary
controls meet the 44px touch floor. No swipe changes sides.

The settings disclosure creates a governed row-detail target at every width.
Compact renders the controlled draft in `FormLayer`; regular and wide render
the same target-gated form in flow. Draft edits and width transforms issue no
query. Apply issues the two-table budget, closes, and restores focus. Cancel
discards without a query. Escape/Back closes while preserving the mounted
session draft.

## One semantic signed-axis table

The axis itself is the exact semantic table; there is no duplicate
`role="img"` chart and no duplicate wide numeric table. It declares three
columns:

```text
term | log₂ ratio | side
```

It contains two named `tbody` rowgroups. Each row has one term disclosure,
exact signed log-ratio text, and side A/B. An `aria-hidden` bar shares the
value cell; CSS places positive values right of the 50% zero line and negative
values left. Headers are not interactive. `aria-sort` is omitted because A
and B may have different directions; the caption and each rowgroup name state
the shared field, that side's direction, rank window, and total.
Both named `tbody` elements remain mounted while either side is pending or
errored. An unready side contains one non-data status row spanning all three
columns; it never borrows or repeats the ready side's rows.

The two independent pager groups sit after the table, not inside either
`tbody`. Each is a `role="group"` named “Side A pagination” or “Side B
pagination,” and contains that side's 44px Previous/Next actions, page label,
and its own reachable 5,000-row bounded-window status. Page size is shared and
therefore appears only in settings, never in either pager.

Scale is:

```text
max(1, every absolute log-ratio on both ready current pages)
```

It is explicitly page-local and stated in the caption. The caption and bars
derive from the same scale helper so they cannot disagree. The floor prevents
a small-effect page from filling the entire width. When only one side is
ready, the scale is labelled provisional and may rescale once the second side
lands. A pure geometry helper clamps bar ratios and is unit-tested.

The table remains one DOM at all widths. At compact width, headers remain
visually hidden but semantically present and the decorative bar is not
rendered: each row is exactly `term … signed value · side ▸`. The term column
may ellipsize; signed value, side, and the 44px disclosure may not. This
preserves the signed analytical value and three-column semantics without
pretending that a legible two-sided axis fits at 320px. The zero-centred bar
and visible zero line begin at regular width. At regular and wide width the
table port always carries its named focusable region contract and may scroll
internally when needed; compact has no horizontal table port or axis scroll
target.

## Row detail and governed history

The row-detail target domain gains:

```ts
{ surface: 'compare-settings' }
{ surface: 'compare-row', side: 'a' | 'b', typeId: number, key: string }
```

Stable controls are:

```text
compare-settings
compare-row-<side>-<typeId>
```

The key never enters an id. The parser rejects arrays, foreign surfaces,
invalid sides, negative or non-safe integer type IDs, and empty keys.
Push-first/lateral-replace uses the existing `rowDetailWrite` law.

One row detail follows its primary row and exposes all row facts:

- term and class;
- count A and count B;
- rate A and rate B per 10,000;
- log-ratio and signed G²;
- documents A and documents B;
- the active combined-count, combined-documents, and class filters;
- one verb: show evidence, explicitly restricted to the row's projection
  side.

Compare deliberately does not duplicate “add as term.” Query authoring remains
owned by Queries/Vocabulary.

Pending and error tables retain a row target. A ready result stales the target
only when that same side omits its `{typeId,key}`. Snapshot loss or an
undefined comparison stales settings and rows. Stale targets use the existing
admission-reporting focus-override pop to land on
`place-compare-heading` exactly once. Swap requires no exception: the old-side
target becomes stale when the inverted result is ready.

When an Evidence sheet sits above a Compare row layer, the rendered target is
the topmost row-detail in the stack so the detail remains mounted beneath the
sheet. New row-detail writes are allowed only when that row layer is the
actual top layer. The shared row-detail projection adopts the same rendering
law for Vocabulary in this phase; both places keep their additive detail
mounted under a governed sheet without allowing writes through it.

## Governed comparison evidence

The delivered side-restricted 50-row KWIC store/worker contract remains.
Evidence gains a deliberate comparison-occurrences region rather than a
second store or worker result.

The old Compare component no longer renders the occurrence list.
`EvidenceSurface` renders it inside its shared body, above recent retained
evidence, so the same content naturally appears in the compact Evidence sheet
and wide Evidence rail. Its accessible region name permanently includes:

```text
Occurrences of “term” restricted to side A/B: resolved side label
```

The named internal port contains exact book/left/node/right rows. Each row
offers:

- inspect, which moves the governed current-passage line through
  `showEvidenceAt`;
- Read, which opens Reader with the truthful existing `kwic` origin.

The occurrence region heading also owns a 44px dismiss action wired to
`closeKeynessEvidence`; dismissal supersedes the occurrence lane and removes
only comparison evidence. Row-level inspect and Read controls follow the
dense-evidence exemption rather than inflating every KWIC row to 44px; the
region-level dismiss and sheet controls retain the touch floor.

`openKeynessEvidence` becomes admission-reporting. It returns true only after
the side selection and evidence group validate and the new occurrence request
is admitted; every failure clears any prior comparison evidence and returns
false. The Compare row action promotes the existing Evidence sheet only after
a true admission. Compact and regular open it at the tall detent so the
50-row list is usable, returning focus to the row disclosure on Back. Wide
needs no sheet because the Evidence rail is resident.

Settings changes retain evidence because side selection is unchanged.
Mode/document/Swap changes clear it. Snapshot replacement must supersede the
evidence lane and clear the state; rendering additionally requires the
evidence snapshot to equal the live snapshot. Stale occurrence rows can never
remain in the always-visible shell.

Retained evidence can legitimately outlive its axis row after a class/filter
change: its side selection and snapshot still make the occurrences true even
when the new projection omits the term. That asymmetry is deliberate. A row
detail is stale when its row disappears; admitted occurrence evidence remains
as explicitly labelled retained evidence until side/snapshot change or user
closure.

## Component boundaries

- `compare-view.ts`: total target guards, ids, stale law, side labels, settings
  draft/validation/summary, and axis geometry.
- `compare/ComparePanel.tsx`: store composition, layers, responsive
  presentation, and comparison controls.
- `compare/CompareSettings.tsx`: controlled domain form only.
- `compare/SignedAxis.tsx`: the semantic axis, rowgroups, pagination, and
  additive detail.
- `compare/CompareRowDetail.tsx`: exact row facts and the one evidence verb.
- `evidence/ComparisonOccurrences.tsx`: exact governed occurrence list owned
  and lazy-loaded by `EvidenceSurface`, including its dismiss action.
- `provenance.ts`, its tests, and `MethodSummary`: the shared sort field and
  both directions, missing-zero rule, page-local display-normalization rule,
  and linked-range exception.
- the shared row-detail projection: topmost row-detail rendering under a
  sheet for both Compare and Vocabulary.
- `FormLayer`, `SheetFrame`, `bounded-page-view.ts`, and worker contracts
  remain domain-free and reused.

The old monolithic `KeynessPanel.tsx` is removed after its ownership is
exhausted.

## Acceptance

### Unit and state

- live/durable view round-trip is equal modulo offsets;
- target parser, ids, and stale law cover hostile inputs, pending, error,
  ready-present, ready-omitted, no snapshot, and undefined comparison;
- side labels cover both modes and both `restOn` values;
- geometry covers both signs, clamping, and the scale floor;
- settings validation and summary name the shared field, both directions,
  filters, classes, and page size;
- shared Apply resets offsets, issues two keyness queries and zero inventory
  queries; invalid input issues none;
- direction and page issue only their side; the bounded window is refused;
- a superseded result for one side is rejected without disturbing a current
  result for the other;
- Apply and direction dirty durable research; paging and presentation do not;
- provenance names the shared sort field, both directions, missing-zero
  projection, page-local display normalization, and linked-range exception;
- snapshot replacement supersedes and clears comparison evidence.

### Chromium functional

- one three-column axis table has two named rowgroups; A values are positive,
  B values negative, exact signed text matches detail, and the page-local
  scale is captioned;
- comparison definition, both summaries, all warnings, and settings precede
  the plot in DOM order;
- shared Apply produces exactly two keyness and zero inventory queries;
- independent directions/pages query one side and leave the other page label;
- each side owns a separately named pager and separately reachable
  5,000-row bounded-window message outside the table;
- row detail exposes every fact and one side-restricted evidence verb;
- Swap inverts a known term and stale-pops an open old-side detail once;
- comparison evidence appears only in governed Evidence with a persistent
  side label, inspect, Read, and a dismiss action that removes it;
- with a Vocabulary detail open, promoting the Evidence sheet from
  `evidence-more` keeps that detail mounted beneath a peek, non-modal sheet
  and inert at half/tall; Back pops only the sheet, leaves the row target and
  its own `vocabulary-row-<typeId>` focus return intact, and restores focus to
  the invoking `evidence-more` control;
- zero-token-side errors leave settings reachable;
- linked Trends range remains query-independent;
- save/reload restores shared sort field, page size, and both directions while
  resetting offsets.

### Real WebKit compact project

Bind `compact-compare.spec.ts` into `webkit-compact` and repeat at 320/390:

- no body overflow or axis scroll trap;
- compact rows are exactly term, signed value, side, and disclosure with no
  decorative bar; regular width restores the shared zero-centred geometry;
- occurrence rows retain the dense-evidence action exemption while their
  dismiss and sheet controls meet the 44px floor;
- 44px Swap, settings disclosure, pagination, and detail actions;
- inert full-height settings with 16px inputs, focus containment, sticky
  actions, Back/Escape/draft/focus laws, and zero-query transforms;
- 390→1440→390 retains the settings draft without semantic work;
- Evidence sheet promotion and Back return to the row disclosure.

Production build, bundle contract, full functional suite, and full viewport
suite remain commit gates.

## Delivery boundaries

1. Reshape the live state and commands first, including `provenance.ts`,
   `MethodSummary`, persistence/query-dirty tests, the reshaped intent-key
   supersession test, and nested-default freezing.
2. Build the axis, responsive settings, details, and Evidence ownership on the
   normalized state, including admission-gated tall-sheet promotion, shared
   row-detail projection, and the comparison-occurrences lazy-chunk/bundle
   contract.
3. Rewrite the existing slice-4 journey while retaining sign inversion and
   linked-brush independence.

Each boundary receives a full staged-tree Opus review before commit.
