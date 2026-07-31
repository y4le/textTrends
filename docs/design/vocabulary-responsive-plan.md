# Responsive Vocabulary implementation decision

Status: preimplementation decision record for Stage 4 of
`docs/design/workbench-ux.md`.

## Product law

Vocabulary remains the canonical home for ranked types, frequency filters,
per-type statistics, focused-book section summaries, and chapter labels. It
does not duplicate Corpus inventory or Concordance evidence.

The frequency result contract is `freq-list/1`
(`packages/core/src/ops/frequency.ts`). A row truthfully contains only:

- exact type key and token class;
- count and rate per 10,000 selected-class tokens;
- selected-document frequency;
- DP and normalized DP when the selected document parts make them defined.

The contract does not contain a per-book vector, a sparkline, or a first
occurrence. This phase must not derive or imply those values. “Concordance”
will newly configure the exact case-sensitive notebook term and route to the
canonical Concordance place only on success; “read first occurrence” waits for
a real occurrence contract. A future per-type distribution needs a worker
result, method/provenance text, transfer tests, and a bounded representation.
This decision supersedes the unsupported distribution/first-occurrence
promises in the governing document; that document is amended in the same
change.

## Responsive information hierarchy

All widths retain one semantic frequency table and the same `FrequencyViewV1`.
Presentation changes never alter page size, filters, sort, offset, selection,
or issue worker queries.

### Compact (below 600px)

Above the table:

1. a one-line active-view summary: sort direction/measure, prefix or “any
   start”, minimum count, minimum documents, token classes, and rows/page;
2. one 44px “sort and filter” control;
3. the existing truthful result summary, including matching-type total,
   selected-class token denominator, and selected-document-part definition.

The table keeps one DOM and one header model. At compact width it follows and
strengthens the delivered Corpus precedent: table, rowgroup, row, columnheader,
rowheader, and cell roles are explicit; every cell carries its stable
`aria-colindex`; the table declares `aria-colcount="7"`; the header stays in
the accessibility tree through a
visually-hidden treatment; and visually omitted cells use `display:none`.
Their facts remain reachable through the adjacent row detail. CSS reduces
every primary row to:

```text
term                                   current sorted measure  ▸
```

Compact column headers remain semantic text with `aria-sort`, but their
wide-only sort buttons are not mounted inside the clipped header. The one
visible compact sorting affordance is the 44px sort/filter disclosure; keyboard
focus never enters clipped controls.

Identity may ellipsize; the measure may not. The visible quantitative measure
is `frequencyView.sort.by` for count, docs, DP, or DPnorm. Alphabetical (`key`)
sorting falls back to count at the right, so the row never repeats term as a
fake “measure”. Direction and the alphabetical-sort/count-display distinction
are stated in the active-view summary. Each numeric cell has a stable field
class and the one visible cell is stamped `data-current-measure`; CSS does not
try to infer dynamic sort state. The other cells are removed from compact
visual/accessibility layout and their exact values remain in the detail.

Activating the term toggles an additive detail row immediately after its
primary row. Exactly one detail may be open. It contains a compact `dl` with
all seven row facts and two verbs:

- add exact;
- concordance.

The detail explicitly describes unavailable DP values as unavailable; it does
not render zero. It does not fabricate a per-book distribution.

Sort/filter opens the shared full-height `FormLayer`. Inputs are at least
16px, actions and checkboxes meet the 44px touch floor, Apply/Cancel are
sticky above the virtual keyboard, and neither the document nor body
overflows horizontally. The form drafts prefix, minimums, classes, sort
field/direction, and page size. Apply validates, installs one complete view
with one frequency query, discards the superseded draft, pops the filter
layer, and restores focus to `vocabulary-filter`. Cancel discards and performs
the same pop/focus return without a query. Escape/Back closes without applying
and preserves the session-local draft for reopening.

Pagination remains below the table with 44px Previous/Next controls and the
bounded-window message. It does not silently reduce the semantic page size for
mobile.

### Regular and wide

The complete seven-column numeric table remains in flow:

`term | count | docs | DP | DPnorm | rate/10k | class`.

Headers remain sortable and expose correct `aria-sort`. The delivered
always-visible wide filter form is replaced by the same “sort and filter”
disclosure used at compact width. Opening it creates a `vocab-filter` layer at
every width; regular/wide render that target-gated form in flow, while compact
uses `FormLayer`. It edits the same parent-owned draft and applies the same
atomic view command. Apply/Cancel pop and restore focus only while that target
is active. A row uses the same disclosure button and additive detail as
compact, so actions have one canonical DOM location rather than a second
wide-only action column.

Focused-book section profile and chapter labels remain below the frequency
catalog. Their ownership and query behavior do not change. Their compact
presentation does: the section strip is clipped within a 100%-wide named
figure while its complete text remains in the accessible label, and the exact
five-column table receives a named horizontal data port. Chapter labels wrap.
This makes the whole Vocabulary place satisfy the no-body-overflow gate.

## Governed layers and focus

The delivered row-detail discriminants gain total domain parsers:

```ts
{ surface: 'vocab-filter' }
{ surface: 'vocab-row', typeId: number, key: string }
```

The stable controls are:

```text
vocabulary-filter
vocabulary-row-<typeId>
```

`typeId` must be a non-negative safe integer and `key` must be non-empty.
The parser rejects arrays, foreign discriminants, missing fields, and invalid
numbers. The key is retained as an identity echo, not put into a DOM id.

Opening the first detail pushes; opening a lateral filter or another term
replaces the current row-detail depth through `rowDetailWrite`. Back closes
one layer and restores the exact invoking control. Only the top row-detail
layer is an active Vocabulary target. A `vocab-row` remains provisionally
valid through pending and error states; it is re-evaluated only when the next
ready result arrives. If that ready result omits the same `{typeId,key}`, or
the snapshot disappears, the component focuses `place-vocabulary-heading`
and pops exactly once through a ref-guarded stale-target effect. The governed
pop accepts that surviving heading as an explicit focus override and reports
whether the traversal was accepted; the guard latches only after acceptance,
so an already-pending traversal cannot permanently strand the stale target.

`vocab-filter` remains valid while the snapshot exists and the target is the
top row-detail on Vocabulary. It is not invalidated by frequency pending or
error because semantic `FrequencyViewV1` still exists. A place transition
begins a fresh in-memory layer stack, as required by the layer invariant, while
the previous browser-history entry retains the Vocabulary row/filter layer.
Browser Back restores that entry and layer; navigation-bar return creates a new
place entry and does not. Because `ActivePlace` unmounts Vocabulary during the
transition, the layer but not an unapplied draft survives Back. Draft
preservation is scoped to viewport transforms and close/reopen while
Vocabulary remains mounted.

During a frequency pending/error state the target remains in the governed
stack, but the current table/detail may be temporarily absent. A subsequent
ready result either restores the detail or proves it stale.

On compact width, `vocab-filter` renders in `FormLayer`. On regular/wide it
renders in flow. Keeping the target while the viewport transforms preserves
history depth, draft, and focus without semantic work. `vocab-row` is always
an in-flow additive detail; compact page content is not modal merely because a
row is expanded.

## State and component boundaries

- `FrequencyTable` owns presentation-only drafts and open-target composition.
  Drafts are not added to the store or research persistence.
- `FrequencyFilters` is a controlled, domain-specific form. It owns no store,
  history, portal, or viewport logic.
- `FrequencyRowDetail` renders exact row facts and invokes existing semantic
  actions.
- `FormLayer` remains domain-free.
- A small `vocabulary-view.ts` helper owns target guards, stable ids,
  active-view summary, current-measure formatting, and filter validation so
  the component cannot drift from the sort contract. The neutral
  `bounded-page-view.ts` owns the shared 5,000-row page label/window rule used
  by both Vocabulary and Compare. The frequency helpers move out of the
  residual `corpus-dashboard-view.ts`.
- The store gains one atomic frequency-view action for minimums, prefix,
  classes, sort, and page limit. It validates with the existing frequency
  bounds, resets offset to zero, publishes one `FrequencyViewV1`, and calls
  `runFrequency()` exactly once. The component still pre-validates and owns
  the visible error; an invalid draft calls no store action and issues no
  query. The now-unused granular prefix/filter/classes/page-size actions are
  removed, while header sort and pagination actions remain. Applying a new
  semantic view dirties durable research through the existing subscription;
  opening, closing, and transforming presentation does not. Existing
  focused-document, linked-selection, notebook, and section-profile semantics
  remain unchanged.
- `store.test.ts` replaces its direct granular filter/page-size calls with the
  atomic action and retains the out-of-window pagination refusal test.

The existing exact-term laws remain:

- add exact creates a token member with case-sensitive and
  diacritics-sensitive matching;
- duplicate/cap refusal stays visible at the invoking Vocabulary action;
- Concordance reuses/reactivates the same identity and enables it for KWIC.
  New in this phase, success pushes the canonical Concordance place at every
  width from inside the store action, the only authority that knows whether
  mutation succeeded. Failure stays in Vocabulary with its refusal visible. If a
  `vocab-row` is open, the new place starts a fresh in-memory stack while the
  prior browser-history entry retains the row layer. Browser Back (not a fresh
  navigation-bar visit) restores Vocabulary with the detail intact and focuses
  the Vocabulary place heading, matching the delivered `setPlace` focus law;
- presentation transforms issue no query and do not dirty research.

## Acceptance

### Unit

- total guards for both targets and hostile shapes;
- stable ids never contain the type key;
- every sort field maps to the correct visible label/value, including null DP;
- active-view summary names direction, classes, prefix, minimums, and page
  size;
- atomic view apply trims/NFC-normalizes prefix, validates minimums/classes/
  page limit, resets offset, and issues exactly one query;
- invalid drafts surface the component error and issue zero queries;
- row-detail write remains push-first/lateral-replace.

### Chromium functional

- the wide table retains all seven columns, sortable headers, exact values,
  one additive detail, and the existing exact-term actions;
- at 320px and 390px the same `aria-colcount="7"` table exposes one term plus
  its current sorted measure with stable `aria-colindex`, one expanded detail,
  no body overflow, and honest unavailable DP; tabbing from sort/filter lands
  on the first visible term rather than a clipped header control;
- compact sort/filter is a named inert modal with 16px inputs, 44px actions,
  sticky Apply/Cancel, focus containment, Back/Escape, and focus return;
- changing drafts causes zero queries; Apply causes exactly one frequency
  query, closes, restores focus, and updates the summary/measure; Cancel
  closes, restores focus, and causes zero;
- 390→1440→390 while the filter is open retains every draft, changes portal
  to in-flow and back, toggles inert correctly, and issues zero queries;
- at wide width the filter disclosure remains reachable, opens the target-gated
  in-flow form, and Apply/Cancel pop only that active target;
- first row/filter pushes, lateral row/filter changes replace, Back restores
  the invoking control, pending/error retain the row target, and a subsequent
  ready result that omits it stale-pops exactly once to the surviving
  Vocabulary heading; the next Back leaves Vocabulary rather than proving a
  double-pop;
- pagination and the 5,000-row bounded-window message remain reachable;
- update `resume.spec.ts` to expand a row before invoking its now-detail-owned
  add-exact action;
- notebook duplicate/cap refusal retains its existing exact identity behavior;
  successful Concordance routing is explicitly new and Back restores the open
  Vocabulary detail (but not an unapplied draft), while refusal does not route;
- focused section profile and chapter labels still render below the catalog.
  A many-section fixture proves the strip and exact-value port cannot overflow
  the body; the complete exact values live in the adjacent named disclosure
  rather than the strip's compact count label.

### Real WebKit compact project

Bind a bounded `compact-vocabulary.spec.ts` into the real WebKit project and
repeat the 320/390 semantic-table, overflow, modal, draft-resize, touch target,
Back/focus, and zero-query presentation assertions. Production build,
functional suite, viewport suite, and bundle contract remain commit gates.
