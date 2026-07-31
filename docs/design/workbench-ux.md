# Cross-device workbench UX and information architecture

*Final product-design authority for organizing the textTrends corpus,
analysis, evidence, catalog, and research-state surfaces. Developed from the
owner-approved workbench direction and two Claude Opus consultations through
Parley. Implementation is pending.*

**STATUS: ADOPTED DESIGN (2026-07-30).**

## Authority and scope

This document governs the application shell and the presentation contracts
shared by desktop, tablet, and phone. It does not change the mathematical,
worker, persistence, or evidence contracts already adopted in:

- `docs/research/synthesis.md`;
- `docs/design/linked-selection-plan.md`;
- `docs/design/corpus-dashboard-plan.md`;
- `docs/design/keyness-plan.md`; and
- `docs/design/research-state-plan.md`.

The first information-architecture consultation is Parley request
`req_consult_26725b1a96acef6b`, artifact
`art_sha256_60dcab231a2d73dbf5e54c1016c0166b6f40b4a581e50522a331bb905697236a`.
The compact/mobile ruling is Parley request
`req_consult_9624a6ff56e2dec2`, artifact
`art_sha256_d56cad3e874ec5c8c2527d65ce56732d2c206ea2283db3c0dc24bb9257fa1ee2`.
Both used an explicit Claude Opus model pin with fallback disabled. The mobile
ruling corrects the initial consultation where compact/touch use exposes a
weakness; those corrections are controlling here.

“Responsive” in this document does not mean fitting the desktop interface
into fewer pixels. The semantic state and analytical truth are shared across
devices, but each presentation class has its own composition, navigation,
touch, density, and reading contracts. Phone portrait is a primary supported
environment.

## Product proposition

textTrends is a local-first corpus reading workbench whose spine is narrative
time. Its interface must make four things continuously intelligible:

1. **Corpus:** what texts are being studied.
2. **Scope:** what exact material the displayed numbers describe.
3. **Analysis:** what question and method produced the current display.
4. **Evidence:** which passages support the display.

The governing composition is:

> One visible scope, one primary analytical plate, and one persistent path
> from every mark to its textual evidence.

This is a reading instrument, not a generic dashboard. Tables, sparklines,
small multiples, dispersion rugs, direct labels, and source prose remain the
visual grammar. The shell supplies the missing spatial model; it does not
replace the successful analytical displays.

## Current-state diagnosis

The current visual grammar is already strong. The trend chart, dispersion
barcode, exact totals, KWIC alignment, restrained palette, and method labels
feel like parts of one instrument.

The current shell is not an information architecture. `App.tsx` renders
features in implementation order:

```text
header
query focus
query notebook
research/share
trend and barcode
pins
concordance
structure
corpus overview and vocabulary
keyness
project and catalog
reader overlay
```

That creates five product failures:

1. Corpus creation and the catalog—the beginning of a new user’s task—are at
   the bottom of the page.
2. Query focus, concordance membership, analysis membership, document focus,
   linked range, keyness sides, pin focus, and reader position have no shared
   statement of context.
3. Panels can simultaneously describe different scopes without one
   persistent place explaining the difference.
4. Every display is resident at maximum density, so attention has no clear
   destination.
5. Evidence scrolls away from the chart that produced it.

At phone width, the existing full page becomes many viewports tall. Tables are
compressed into miniature columns, and the chart declares
`touch-action: none`, which prevents the chart region from participating
safely in ordinary page scrolling. Mobile therefore requires an interaction
redesign, not media-query polish.

## Goals and non-goals

### Goals

- Give every delivered feature a findable, stable home.
- Preserve query, scope, evidence, and method context while changing analyses.
- Make focus and computational scope impossible to confuse.
- Make every analytical mark operable without hover.
- Give phones complete research workflows, not read-only summaries.
- Preserve full numerical truth when columns or charts change form.
- Reuse the current domain, worker, store, and component boundaries where
  possible.
- Mount only the active analytical place and retain current bundle and query
  budgets.

### Non-goals

- A card-grid dashboard or cover-art catalog.
- A plugin-style menu of every possible future analysis.
- Different analytical semantics on different screen sizes.
- Gesture-only commands, hover-only evidence, or long-press-only actions.
- A mobile “More” dumping ground containing important analyses.
- Miniature desktop tables with illegible type.
- One state variable that makes focus, scope, comparison sides, and evidence
  synonyms.
- A rewrite of working analysis operations.

## Canonical information architecture

There are six canonical **places**. A place is a stable analytical or research
destination, not a transient panel.

| Place | Question | Canonical home, delivered or designed |
|---|---|---|
| **Corpus** | What texts make up this study? | project creation/opening, source repair, Standard Ebooks catalog, document order and metadata, structure, corpus inventory, focused-book sheet |
| **Trends** | Where do tracked terms occur over narrative time? | query groups, trend, chapter marks, dispersion barcode, linked range, exact totals |
| **Concordance** | What passages contain the tracked terms? | full KWIC table, term membership, occurrence navigation |
| **Vocabulary** | What words characterize this scope? | frequency, document range, dispersion, corpus vocabulary growth, per-type and per-section labels |
| **Compare** | What distinguishes explicit side A from side B? | keyness selectors, summaries, A-key/B-key rankings, side-restricted evidence |
| **Findings** | What has the researcher kept or shared? | pins and capacity, named ranges, notes, mismatch review, research save/export, source-free sharing/import, conflict handling, method/provenance log |

The table assigns both existing surfaces and new compositions required by this
design; it is not a claim that every named composition is already implemented.
Migration stages below distinguish moves of delivered behavior from new shell
and presentation work.

Ownership follows the grain of the data:

- per-book rows and their complete richness/rhythm statistics belong to
  **Corpus**;
- per-type and per-section rows belong to **Vocabulary**; and
- the focused-book sheet re-presents the current book’s slice and links into
  filtered Vocabulary views; it does not create a second canonical home.

Labels are nouns a researcher can recognize. “Dueling keyness” becomes
**Compare · key terms A vs B**. “Corpus overview” is separated into Corpus
(what is in the study) and Vocabulary (what is in its words).

**Read** is a mode rather than a seventh place. The same reader state can be
shown as a passage peek, a study view, or a full reading surface. Every reader
presentation retains a visible return path to the originating place.

The six places are canonical on every device. They are not, however, six
equal tabs: four are analytical lenses, while Corpus defines the study and
Findings records it. Two navigation organs expose that real hierarchy at
every width.

### Scope organ

The persistent top organ contains statements that are also navigation:

- the corpus/completeness statement opens **Corpus**;
- the Findings count opens **Findings**; and
- an active range statement opens range editing, with an adjacent clear
  action.

### Lens organ

The lens organ contains exactly:

```text
Trends · Concordance · Vocabulary · Compare
```

It is top-right on regular/wide layouts, bottom-docked in compact portrait,
and a left rail in compact landscape. All four labels remain complete. There
is no More menu, hamburger, overflow-scrolling place strip, place sheet, or
swipe-between-places gesture.

The route model is:

| State | URL carrier | Values |
|---|---|---|
| Place | `?p=` | `corpus`, `trends`, `concordance`, `vocabulary`, `compare`, `findings` |
| Evidence presentation | `?e=` | `none`, `sheet`, `reader` |
| Analytical/share state | `#s=` | existing versioned source-free payload |

The query string carries only enumerated presentation routes, never corpus
text, terms, ranges, pins, notes, or other user content. Those remain in the
privacy-preserving fragment where the share contract admits them.

## Persistent regions

Four region contracts surround the active place.

### Scope bar

The Scope bar answers “what are these numbers over?” It includes:

- corpus name;
- ready and expected document count;
- documents in computational scope;
- active linked range, if any;
- token count for the current scope when known;
- partial/missing state;
- pins or anchors needing review; and
- an explicit exception when the active place ignores part of global scope.

Examples:

```text
Sherlock Holmes · all 6 books · 461,992 tokens · no range · 6/6 ready
```

```text
The Hound · chapter VII · tokens 12,430–14,570 · 2,140 tokens  × clear
```

```text
Compare uses declared sides A and B · the active trend range does not apply
```

Scope changes are announced through one polite live region. Focus and hover
changes are not announced there.

### Query surface

The query notebook is the persistent unit of inquiry. It supplies the
interactive key for query colors and dash patterns and exposes:

- focused group;
- count/status;
- active/muted state;
- concordance membership;
- solo projection;
- editing; and
- explicit addition of a term or member.

The primary row action is **focus**. Secondary state-changing controls are
available through the row disclosure and remain keyboard accessible. This
preserves the correct orthogonal semantics without presenting three equally
prominent controls per term.

### Evidence surface

The Evidence surface holds the current passage, evidence-specific scope,
pin/read actions, and recent retained evidence. It never changes
computational scope merely because a passage or pin was opened.

Evidence and Findings expose pin capacity as `n of 8 pinned`. At capacity,
Pin remains visible but unavailable with its reason and a direct
**manage pins** route, rather than failing after activation.

Concordance remains a canonical place because aligned KWIC needs full
analytical width. The Evidence surface may show a short preview of the
selected row, not a second competing concordance.

### Method summary

Every place has one method summary in a consistent location. It names the
method and the parameters necessary to interpret the visible display:

- denominator;
- bins/window/smoothing;
- token classes;
- filters and sort;
- comparison sides;
- completeness and missing documents; and
- uncertainty or known limitations.

Activating it opens one complete provenance view containing recipe and
content identities. Governed copy actions for resident result tables reuse the
same provenance object. A file-download export remains deferred and must not
be implied by copy UI. Method information must not be implemented as unrelated
notes scattered across panels.

## Selection law

Every interaction belongs to one of three tiers.

### Scope

Scope is what numbers are computed over. A Scope action is explicit, always
rendered in the Scope bar, and may issue new queries. Evidence never silently
changes scope.

### Focus

Focus is what is emphasized within the current scope. It is cheap,
reversible, and does not change denominators. It may issue only the bounded
detail query needed to inspect the focused object.

### Evidence

Evidence is the passage, KWIC row, pin, or reader position currently being
inspected. Evidence follows focus where useful, but does not change scope.

The phrase “one linked selection model” means a consistent path to evidence,
not that every analysis consumes every selection. In particular, Compare
continues to use explicit sides and never adopts a trend brush.

### Exact interaction rules

| Action | Tier | Required result |
|---|---|---|
| Open another corpus/project | Scope | replace snapshot; load that project’s research record; clear snapshot-bound live range; revalidate its durable anchors; retain place if valid |
| Activate a book title | Focus | focus book, structure, and book sheet; do not change any denominator |
| Activate **only this book** | Scope | compute linked analyses over the book; expose one-step **all books** |
| Activate a query row | Focus | emphasize its marks and evidence; leave scope unchanged |
| Change shown/in-concordance/solo controls | Explicit query intent | preserve their existing independent semantics |
| Commit a trend range | Scope | show exact document/token range with clear and name actions; linked analyses follow |
| Activate a vocabulary row | Focus/Evidence | show row detail and evidence; only **add as term** mutates notebook |
| Activate a keyness row | Focus/Evidence | show side-restricted evidence labeled side A/B; global scope unchanged |
| Activate a pin | Evidence | show retained passage; nothing else moves |
| Activate **return to this** on a pin | Explicit restoration | restore the pin’s recorded place/scope/focus after preview |
| Select a catalog row | Focus | preview metadata; no download |
| Activate **add** in catalog | Corpus mutation | show download/extract/index progress; do not navigate unless this is the first ready book in an empty corpus |

## Wide workbench

At wide measures the shell uses the printed-page analogy directly:

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ textTrends   Sherlock Holmes ▸       Trends Concordance Vocabulary Compare   │
│ SCOPE  all 6 books · 461,992 tokens · 6/6 ready       method ▸  Findings 3 ▸ │
├──────────────┬────────────────────────────────────────┬──────────────────────┤
│ QUERIES      │ ACTIVE PLACE                           │ EVIDENCE             │
│ ━ Holmes     │ title and contextual controls          │ current passage      │
│ ┄ Moriarty   │                                        │ pin · read           │
│              │ one primary analytical plate           ├──────────────────────┤
│ add term…    │                                        │ recent pins/ranges   │
│              │ exact/supporting values                │                      │
├──────────────┴────────────────────────────────────────┴──────────────────────┤
│ METHOD  rate/10k · equal-token bins · unsmoothed · complete              ▸   │
└──────────────────────────────────────────────────────────────────────────────┘
```

The Query and Evidence regions may collapse, but their collapsed controls
remain visible. There is only one nesting level: persistent regions and the
active place. A place may contain a table body with its own scroll, but not
accordions inside panels inside drawers.

The reader has three named wide-screen presentations: **peek** replaces the
Evidence region, **study** replaces the active plate, and **full** replaces
both. It never overlays a second evidence rail.

Layout and input modality are orthogonal. Compact/regular/wide composition is
selected by available width; coarse/fine pointer contracts control targets
and gestures. A wide touch tablet uses the wide composition with 44-pixel
touch targets and touch range handles.

## Compact workbench

Compact presentation has one primary vertical scroll owner: the active place.
The Scope organ addresses Corpus/Findings at the top; the Lens organ addresses
the four analytical places at the thumb-reachable bottom edge.

```text
┌──────────────────────────────────────────────┐
│ Sherlock Holmes · 6 books ▸           ⚑ 3 ▸  │ Scope organ
├──────────────────────────────────────────────┤
│ TERMS [━━Holmes 1938][┄┄Moriarty 36][ + ]    │ Query key
├──────────────────────────────────────────────┤
│                                              │
│            active analytical plate           │ One scroller
│                                              │
├──────────────────────────────────────────────┤
│ Hound · 68% · token 40,712                   │ Evidence line
│ …upon the moor, and the hound had gone…      │
│ [pin] [read ▸]                     [more ▾]  │
├──────────────────────────────────────────────┤
│ method  rate/10k · 40 bins · complete     ▸  │
├──────────────────────────────────────────────┤
│ Trends   Concordance   Vocabulary   Compare  │ Lens organ
└──────────────────────────────────────────────┘
```

The Lens organ respects `safe-area-inset-bottom`. It is replaced, rather than
stacked, by editor Apply/Cancel controls and full-reader navigation. At
320-pixel width its four columns are proportioned to the complete labels, and
every target is at least 44 by 52 CSS pixels. Under enlarged system text the
organ may become a direct 2×2 grid and grow vertically; all four places remain
visible, labeled, and one tap away. Disabled lenses remain visible with a
reason in their place; they do not disappear.

In compact landscape, height rather than width is scarce. The four-item Lens
organ moves to a 96-pixel left rail, while Method folds into the Scope organ.
No orientation is required or forced.

### Compact Scope bar

The Scope organ may add a second range row but remains sticky and readable.
It prioritizes:

1. corpus/document scope;
2. active range and clear action;
3. readiness/partial state; and
4. Findings count and place-specific exception.

Its full provenance opens on activation. It never truncates away an active
range or a “range ignored here” clause.

### Compact query key and editor

Places whose marks use query encodings show a single horizontally scrollable
Terms row below the Scope organ. It is the compact interactive legend, is
height-locked to 48 pixels, and never wraps. Its internal scroll must not
create body horizontal overflow. Activating a term focuses it; `[+]` opens
quick add; the row disclosure opens the full-height group editor.

Group/member editing is a focused form with sticky Apply/Cancel actions.
Reordering always has visible Move up/Move down actions; drag reordering may
be additive but never required. Drafts survive a virtual-keyboard resize and
require confirmation before destructive dismissal.

## Compact evidence and sheet contract

Evidence has a strict three-tier promotion ladder:

1. **Evidence line:** always-present, two-line in-flow passage and explicit
   Pin/Read/More actions.
2. **Evidence surface:** one component rendered as bottom sheet on compact,
   docked strip on regular, and margin on wide.
3. **Reader:** the only full-viewport evidence surface.

The compact Evidence sheet has `peek` 28dvh, `half` 58dvh, and `tall` 88dvh
detents plus closed. It never reaches 100dvh, which is reserved for Reader. At
peek it is non-modal and the Scope and Lens organs and place remain
interactive. At half/tall it makes those underlying regions inert, applies a
subtle scrim, and owns one internal vertical scroll. Its header and visible
close/expansion buttons remain reachable at every detent, so close or Back
restores the underlying organs without a reload. Dragging the 44-pixel header
is optional. Detents remain under `prefers-reduced-motion`; only animated
travel between them is disabled.

Only one sheet exists. Evidence and Method content replace one another rather
than stacking. Form editors are dedicated full-height surfaces and also
replace, rather than cover, the sheet.

Browser Back and external-keyboard Escape unwind the most recently entered
layer. A representative nested stack is:

```text
Reader → prior Evidence state → range mode off → row detail closed → prior place
```

Place change, row-detail expansion, range-mode entry, sheet open, and Reader
open each push an app-owned history entry. Row detail and range mode may use
`history.state` without adding user content to the URL. Detent changes do not
create entries, and changing the selected row while the row-detail layer is
already open replaces that layer’s state rather than pushing again. Thus
neither action adds Back presses. Escape and visible close consume the same
app-owned top entry as Back; they do not maintain a second navigation stack.
Closing restores the prior sheet detent/scroll and the exact invoking control
when it still exists; otherwise focus returns to the place heading.

`?p=` and `?e=` deep-link the place and evidence tier. Sheet detent, scroll
position, open row disclosure, and focus-ring presentation are never shared
or persisted as research semantics.

## Regular and tablet workbench

Regular width (600–1023 CSS pixels) uses two regions: Query rail plus active
place. The Lens organ moves to the top-right strip. Evidence is a reserved
two-line strip that expands upward using the same Evidence component and
detent model. Tablet portrait therefore does not inherit the phone Lens dock
merely because its pointer is coarse.

Wide layout begins at 1024 pixels when the active place retains a useful
measure beside both rails. Wide coarse-pointer devices use the three-region
composition with 44-pixel targets, range handles, explicit Pin, and all other
touch contracts. Layout follows width; targets and gestures follow pointer.

## Place contracts

### Corpus

#### Empty state

Corpus is the onboarding surface. It presents three full-width actions:

```text
Browse Standard Ebooks
Choose files from this device
Open a saved project
```

The local-first/privacy statement is concise and adjacent: source text stays
on the device unless the user explicitly downloads or exports it. Mobile does
not mention drag-and-drop as the primary action; file picker and platform
document providers are first-class.

#### Catalog

The catalog is a searchable bibliographic list grouped by series. Search and
active selection remain visible while scrolling. Selecting a row expands a
metadata preview. Adding is explicit; multi-select and **add series** use a
sticky action bar.

The list reports that browsing uses the baked snapshot while adding a book
downloads its source. An added row shows:

```text
downloading → extracting → indexing → ready
```

If the corpus was empty, the first ready book is focused and the app opens
Trends with “add a term to begin.” Otherwise adding never changes place.

#### Nonempty corpus and book sheet

The corpus inventory is a list/table hybrid. Compact rows show title,
readiness, tokens, and a small rhythm mark. Its expanded/detail form owns the
complete delivered per-book statistics, including richness and rhythm.
Activating the title focuses the book and opens its object sheet; a separate
**only this book** action changes scope.

The book sheet composes inventory, structure, vocabulary growth, and rhythm
in that order, then links to the book-filtered per-type/per-section labels in
Vocabulary. These are focused slices of the canonical Corpus/Vocabulary
surfaces, not duplicate result ownership. Structure editing opens a dedicated
form surface on compact screens instead of placing small inputs inside the
list.

### Trends

Trends retains exactly the current **series** and **by book** modes at every
width. Compact does not invent a third chart or silently change modes. It
changes geometry only: a bounded chart height, heavier series strokes, book
boundaries rather than dense interior ticks, and 28-pixel shared-scale rows
for by-book small multiples. Direct labels are used where they fit; the Terms
row supplies the interactive legend on compact.

The delivered **mark top-level chapters** toggle belongs with Trends because
it changes chart-axis annotation. It remains reachable beside trend mode on
every presentation and persists through the existing trend-view record; it
is not stranded in Corpus when only the active place is mounted.

The dispersion barcode remains directly below the chart on the same x scale.
If vertical room forces a choice, the barcode outranks the totals list: it is
the only whole-corpus macro view that remains legible at phone width.

The compact exact-totals table initially shows book, count, and rate for the
focused query. Other query columns are available through row/query
selection, never discarded. The complete accessible table remains in the DOM
or an equivalent table view.

### Concordance

Concordance owns the center/plate because KWIC is a primary visualization.
Compact keeps, rather than approximates, the alignment that gives KWIC its
meaning. One horizontal context port wraps the whole row body. Every row
shares its scroll offset, and the node column starts centered at one fixed x:

```text
◀──────── shared context pan ────────▶
 whether  │ Holmes │ had reached…
 where was│ Holmes │ ? The moor…
 sound of │ Holmes │ ’s voice…
```

The port—not each row—may pan horizontally and contains its own overscroll.
The page body never scrolls horizontally. A visible recenter action returns
the node column to its initial x. A stacked “reading mode” is available for
switch/low-vision use and states that alignment is off. Assistive technology
always receives the full strings. Activating a row updates the Evidence line;
activating its node opens Reader.

A result-control bar remains above the table, with sticky summary text naming
served scope and count. It mirrors query membership and adds the already
protocol-supported L1/R1/R2 sort choices through a select or single-row
control rather than a wide header; this is new UI over the existing KWIC
operation, not a claim about the current panel. A context-width control may
trim rendered context only within the context tokens already served; it
cannot widen beyond the result contract without an explicit re-query and
Method update. Previous/next occurrence controls are visible and have
keyboard equivalents.

### Vocabulary

Compact **single-measure ranking tables** follow one row-line/detail law. The
row line contains identity at left and exactly one measure at right: the
current sort column. Changing sort changes that visible measure. This governs
Vocabulary and any future ranking with one selected measure. It does not
govern object inventories, Trends’ fixed count/rate evidence pair, aligned
KWIC, or Compare’s signed analytical plot; each has its place-specific
contract. Data is never truncated; identity may ellipsize. Every other exact
value appears in the one-row-at-a-time detail and in the designed copy/export
result.

For Vocabulary:

```text
term                                      current sorted measure ▸
```

Activating one row expands exactly one detail containing rate, DP/DPnorm,
class, and the verbs:

```text
add as term · concordance
```

The delivered `freq-list/1` row has no per-book vector or occurrence anchor.
Per-book distribution/sparkline and “read first occurrence” are therefore
deferred until a bounded, provenance-visible worker contract supplies them;
the UI never derives or implies those absent facts.

Sort/filter controls open a focused sheet while their active values remain
summarized above the list. Page size and filters retain their semantic values
across viewport changes; compact presentation must not silently request a
different analysis.

A future compact distribution strip or ECDF may index the sorted table only
after that bounded contract exists. It never replaces exact rows.

### Compare

The comparison definition and both side summaries remain visible before any
ranking. A and B are rendered as two independently ranked and paged rowgroups
on one signed, zero-centered log-ratio axis:

```text
               B ◀─────┼─────▶ A
moor               ┼────▉  +3.1  A ▸
hound              ┼───▉   +2.9  A ▸
Watson        ▉────┼         −1.8 B ▸
Mrs.           ▉──┼         −1.4 B ▸
```

Compare adopts the contract that `keyness-view/1` can round-trip: one shared
filter, one shared sort field, and one shared page size, with independent
per-side sort directions, ranking projections, and page offsets. This
replaces the delivered panel’s per-side sort-field and page-size controls,
whose side-B values are not durable today; it does not change the persistence
schema. The display preserves each projection's own rank order and page
window; it does not interleave them into a false global rank. Both rowgroups
share one page-local scale, stated in the caption. The signed axis always
encodes log-ratio, even when the shared ordering field is G² or a count; the
current field and both directions are stated above it. Exact row detail
exposes both counts/rates, both document frequencies, G², filters, and
**show evidence**. Terms with exactly zero log-ratio are in neither delivered
projection. Thus the plot is not governed by the single-measure ranking law.
Each side's pager follows the shared table as a separately named control
group. At compact width, the same table retains term, exact signed value,
side, and disclosure but omits decorative bar geometry; the shared
zero-centred bars begin where regular width can render them legibly.

Compare's side-restricted KWIC is a deliberate occurrence-list responsibility
inside the governed Evidence surface, alongside rather than replacing the
current-passage pipeline. Its accessible name carries a persistent
`side A only` or `side B only` scope label, and its rows can inspect the
governed passage or open Reader.

Swap A/B is a visible 44-pixel action, never a swipe gesture. The Scope bar
states that a linked trend range is not used. Small-side and uncertainty
warnings appear before the rankings and inside the Method summary.

### Findings

Findings is a research log, not a card feed. It groups:

- named ranges;
- pins and notes;
- anchors needing review;
- share and governed Method copy actions;
- incoming share preview;
- research/project save status;
- research save/conflict state; and
- a current-state method/provenance register.

Rows use citation-like document/position labels and retained query identity.
Activating a row opens additive detail. Saved ranges offer **preview passage**
and the explicit scope action **use as linked range**. Pins offer **show current
passage** and **open in Reader**. General **Return to this** remains deferred:
the current durable contract does not record place, focus, reader cursor, or
live selection, so claiming to restore them would be false.

Share import remains a two-step preview/replace action. On compact screens the
preview is a full-height review surface with sticky Cancel/Replace actions.
CAS conflict actions, Reload and Overwrite, remain explicit and at least 44
pixels high. The pins group always shows capacity; at `8 of 8`, each new-pin
entry point routes here to manage or remove retained evidence.

### Reader

The reader is proportional-type prose with data/method metadata in mono. It
has three widths on wide screens and one full-screen compact presentation.

Compact reader chrome contains:

- Back to the exact originating place/action;
- book/chapter and position;
- query-highlight key;
- previous/next page; and
- evidence actions.

The Lens organ is replaced by reader navigation. Page text is the only
primary scroll owner. Native text selection and browser zoom are not blocked.
Closing returns focus to the invoking KWIC row, pin, passage action, or stable
barcode return target. For coarse-pointer barcode use, that target is the
Evidence line’s barcode-derived **Read** action. After a fine-pointer canvas
click, it is the stepper for the clicked track because the canvas point itself
is not focusable.

## Touch and gesture contract

No analytical action depends on hover or long press.

### General

- Tap focuses or activates the named primary action.
- A visible disclosure opens secondary row actions.
- Vertical one-finger movement scrolls the active place by default,
  including when started over a chart.
- Horizontal page-body scrolling is forbidden.
- Long press is left to the browser for text selection and platform behavior.
- Pinch and double tap remain browser zoom; the app does not intercept them.
- Every custom gesture has an adjacent button or keyboard equivalent.
- Tap reads or focuses; it never creates a durable pin. Pin is always an
  explicit labeled action on every pointer class.

### Trend inspection

The current blanket `touch-action: none` is forbidden.

In ordinary mode the chart uses vertical-pan-compatible touch behavior:

- tap sets the reading cursor and updates the Evidence line, never Pin;
- horizontal movement scrubs the cursor with existing animation-frame
  coalescing while the browser retains vertical pan;
- visible previous/next controls step occurrences;
- keyboard arrows retain exact stepping; and
- ordinary vertical movement scrolls the page.

Free dragging on the chart does not create a range on compact touch screens.
The user first activates **select range**. Range mode then provides:

1. a visible start marker at the reading cursor;
2. an end marker set by tap;
3. two 44-pixel drag handles;
4. token-step buttons for precision;
5. Cancel and **use range** actions; and
6. a live textual range summary.

Only the handles capture horizontal pointer movement. The chart outside the
handles continues to allow vertical page scroll. The existing same-document
range rule remains. The compact UI adds visible feedback when the underlying
clamp refuses a cross-book endpoint, rather than leaving the refusal silent.
Range queries issue only on **use range**, never per pointer frame.

### Barcode

The barcode retains its dense macro form: each delivered track is 7 pixels
high with a 2-pixel gap, so total strip height varies with track count.
Enlarging each track into a nominal touch target would destroy the display.
On coarse pointers the strip is read-only analytical ink, not a set of tiny
hit targets. Its dedicated, at-least-48-pixel occurrence stepper is the touch
control: it selects a term and steps exact occurrences or honestly labeled
density buckets into the Evidence line; the line’s explicit **Read** action
opens Reader.

On fine pointers, the delivered canvas click remains: it resolves the clicked
track and document/token position, centers the related evidence, and may open
Reader for an exact occurrence. It is a click action, not nonexistent
hover/focus behavior. Density interaction repeats the current “nearest
occurrence to this bucket” language and never presents a bucket as one hit.

### Sheets and rows

Sheet handles may support dragging, but expand/collapse/close buttons are
always visible. Table/list rows use tap to focus or expand; actions inside the
expanded row are separate controls. Horizontal swipe does not delete, pin,
swap sides, or change place.

## Responsive invariants

### Semantic state is device-independent

Viewport changes never alter:

- canonical place or route;
- corpus/project or snapshot;
- query notebook or active/KWIC membership;
- persisted trend view: mode, chapter/section marks, and focused document;
- linked committed range;
- inventory/keyness filters, sort, or semantic page size;
- comparison sides;
- durable pins/selections;
- method/recipe;
- research revision/conflict state; or
- reader place/page.

All state admitted to a share fragment must encode byte-identically at 320
and 1600 pixels. Durable private state intentionally excluded from sharing,
including pins, is separately invariant; the share codec does not redefine
its durability.

`focusedDoc` remains Focus-tier behavior—activating it changes no
denominator—but is nevertheless durable in `trend-view/1`. “Cheap and
reversible” does not mean “ephemeral.”

### Presentation state may adapt

The shell may change:

- rail versus sheet presentation;
- query-key wrapping/scroll;
- evidence detent;
- row-line/detail versus exact grid;
- keyness axis alone versus axis plus numeric tables;
- chart encoding/label placement;
- shared KWIC context-port offset;
- open row detail; and
- reader width.

These fields are ephemeral and excluded from research autosave/share unless a
future design explicitly promotes one.

### Live viewport changes

When the viewport class changes:

- full reader remains open and changes width only;
- a form editor remains open with its draft and actions;
- Evidence margin becomes Inspect sheet, or vice versa, retaining target;
- a committed range is unchanged;
- a range preview is reprojected from token anchors and remains in range mode;
- keyness retains both side computations and the signed axis;
- scroll restoration targets the active object, not a raw pixel offset; and
- focus moves only when its current control no longer exists, then lands on
  the equivalent transformed control.

Orientation is never forced. Phone landscape uses the available region class
but preserves the same state.

The implementation uses one component tree with a density/layout context,
not separately mounted “mobile” and “desktop” applications. The only
alternate renderers are the keyness axis versus optional wide numeric tables
and viewport-sized row virtualization; neither owns semantic state.

## Visual and typographic grammar

Tufte inspiration is a positive grammar, not a list of prohibitions.

- Prefer tables, sparklines, small multiples, rugs, direct labels, and
  evidence prose.
- Use direct labels where marks have natural termini. Else use the persistent
  interactive query key; compact Trends always uses the Terms row because
  there is no honest right-edge label rail.
- Reject decorative cards: shadows, radii, gratuitous padding, and one datum
  per container. Permit standardized semantic frames and subtle region tints.
- Density belongs inside a coherent display, not uniformly across the entire
  application.
- Reserve mono for tokens, counts, offsets, KWIC, and method metadata.
  Ordinary controls and explanatory prose use the proportional UI face.
- Keep one primary accent hue while using channel as well as color:
  focus=stroke, scope=tint, stale=hatch/dash plus text, partial=word label,
  error=accent plus explicit message.
- Strengthen structural rules enough to remain visible; the current dark
  `--rule` and `--rule-strong` values are too faint to carry grouping alone.
- Do not reduce compact body/control text to the current `--text-xs` scale.
  Inputs use at least 16 CSS pixels to avoid platform zoom surprises; dense
  evidence remains readable under system text scaling.
- Compact series strokes are heavier than wide strokes, while retaining the
  same hues, dash patterns, order, and emphasis semantics.

Every figure has an exact table or accessible numerical alternative. On
compact screens that alternative may be a separately activated view, but it
is never omitted.

## Accessibility and mobile-browser contract

- Primary controls and custom interactive targets are at least 44 by 44 CSS
  pixels, including chart handles. Dense barcode tracks are analytical ink on
  coarse pointers; their separate occurrence stepper is at least 48 pixels
  high.
- The viewport meta tag never disables user scaling.
- At effective layout widths down to 320 CSS pixels, the shell supports 200%
  browser zoom and enlarged system text without hiding actions or creating
  body horizontal scroll. The Lens organ may use its direct 2×2 large-text
  form; it never hides labels behind another surface.
- Sticky chrome and sheets respect all `safe-area-inset-*` values.
- The viewport opts into `viewport-fit=cover` only together with those safe
  area protections.
- Full-height surfaces use dynamic viewport units with a tested fallback;
  the virtual keyboard must not cover the active input or Apply/Cancel.
- Reduced motion removes animated sheet travel and animated state
  transitions; the named Evidence detents and their direct controls remain.
- Light and dark modes preserve non-color encodings and structural contrast.
- Place, Scope, main analysis, Evidence, Queries, and Method have proper
  landmarks/headings.
- Visual KWIC clipping does not truncate accessible context.
- Screen readers receive chart summaries, exact tables, scope changes,
  progressive readiness, and error/conflict messages.
- External keyboard support on mobile matches desktop where keys exist.
- Exact query/member inputs disable automatic capitalization, correction, and
  spellcheck; an operating system must not silently change a case-sensitive
  term.
- The browser Back action and focus-return rules are tested, not left to
  incidental DOM behavior.
- App suspension may pause indexing. On resume, the existing progressive
  state is reconciled and the UI says what remains; it never claims
  background work continued.
- IndexedDB/storage failures remain visible without disabling in-memory
  analysis.

## Performance and local-first constraints

The shell must improve, not weaken, the performance architecture.

- Only the active place is mounted; place modules are lazy where needed.
- Place/evidence routing is a small History API reader/writer over `?p=` and
  `?e=`. No router, sheet, gesture, or UI-kit dependency is added for the
  shell.
- Query and Evidence transformations do not duplicate corpus data in React
  state.
- Viewport and orientation changes are presentation-only and issue no
  analysis query.
- Table virtualization may be used for long rendered results, but it cannot
  change server/worker paging or accessible row truth.
- Evidence-line updates use the existing bounded passage/KWIC scheduling and
  never query per raw touch frame.
- Compact encodings consume existing result contracts; no separate “mobile
  result” operation is introduced.
- Initial-entry and lazy-chunk bundle gates remain in force.
- Catalog browsing remains baked/local; source download behavior stays
  explicit.
- Source text is never inserted as live markup on any device.

## Cross-device acceptance

Width and input are independent axes:

- `compact`: below 600 CSS pixels;
- `regular`: 600–1023 pixels;
- `wide`: at least 1024 pixels; and
- `coarse`/`fine` pointer contracts selected independently.

Thus a wide touch tablet uses wide composition with coarse-pointer target and
gesture rules.

### Required environment matrix

At minimum, the shell is exercised at:

| Class | Viewport examples | Primary input |
|---|---|---|
| Small phone portrait | 320×568, 360×800 | touch |
| Current phone portrait | 390×844, 430×932 | touch |
| Phone landscape | 844×390 | touch |
| Tablet portrait | 768×1024 | touch + keyboard |
| Tablet landscape / compact laptop | 1024×768 | touch/pointer + keyboard |
| Wide desktop | 1440×900 and ≥1500 width | pointer + keyboard |

Mobile Chromium and WebKit are release gates for the compact shell. Desktop
Chromium remains the existing full functional/benchmark gate. The matrix also
includes light/dark, reduced motion, 200% zoom/text scaling, and at least one
screen-reader-oriented semantic audit.

Every viewport asserts:

- no body horizontal overflow;
- no clipped primary action;
- no pointer/touch scroll trap;
- tap on a chart reads but never increases the pin count;
- Scope and current place remain directly reachable, or recoverable through
  the visible close/Back control while a modal layer intentionally makes them
  inert;
- exact values remain reachable;
- Back unwinds the correct layer; and
- resizing/rotating does not alter semantic state or issue analysis work.

### End-to-end research journeys

1. **Onboard from the catalog:** start empty, search Standard Ebooks, preview a
   series, add books, observe progressive readiness, and arrive at Trends
   without losing access to Corpus or silently capitalizing an exact query.
2. **Import local sources:** choose multiple files, inspect order/metadata,
   correct structure, persist when requested, reload, and resume.
3. **Trace to evidence:** add two query groups, focus one, inspect compact
   trends/barcode, toggle chapter marks, enter range mode, commit a range,
   open passage evidence, pin it, promote the reader, and Back through each
   entered layer to the invoking chart control.
4. **Use Concordance:** switch place, change query membership/sort, step
   occurrences, open a complete passage, and prove the committed scope still
   applies.
5. **Investigate vocabulary:** filter/sort, expand a row, inspect its
   distribution and evidence, add it as an exact term, and verify the list
   keeps its place.
6. **Compare explicit sides:** configure A/B, inspect the shared signed axis,
   expand exact values from both sides, swap, open side-restricted evidence,
   exercise independent per-side page offsets, save/reload the shared sort
   field, shared page size, and per-side directions, and prove a live trend
   range is visibly ignored rather than silently consumed.
7. **Retain and share:** name a range, add a pin note, reload, preview a
   source-free share, replace after confirmation, and resolve a real two-tab
   research conflict with explicit Reload/Overwrite. Fill all eight pin slots,
   verify every Pin entry point reports capacity and routes to Findings, then
   remove one and retain new evidence.
8. **Transform in place:** with reader, range mode, query draft, Evidence, and
   Compare exercised in separate runs, resize or rotate across presentation
   classes and prove the complete persisted trend view, focus return, query
   counts, Method text, private durable state, and the share fragment remain
   truthful; the fragment itself remains byte-identical.
9. **Audit and restore:** open the complete Method/provenance view, copy a
   governed result with that provenance, show the current passage from a pin,
   create an anchor mismatch through source replacement, and resolve it from
   Findings without losing the current project.

## Migration plan

Every stage ships independently and preserves the current evidence and query
contracts.

### Stage 0 — semantic context before layout

- Derive one Scope view model.
- Add Scope bar and unified Method summary to the current page.
- Add reusable governed result-copy actions backed by the same provenance
  object as Method.
- Split book focus from explicit document scope.
- Give each future place a proper heading.
- Make tap read without pinning; make Pin an explicit action everywhere.
- Replace `touch-action: none` with `pan-y` plus governed range handles.
- Add safe-area/`viewport-fit=cover`, 44-pixel coarse targets, 16-pixel exact
  inputs with autocorrection disabled, visible structural rules, and
  `pagehide`/resume reconciliation before claiming compact support.

### Stage 1 — canonical places and URL/history

- Introduce the six-place state, Scope and Lens organs, and `?p=`/`?e=`
  History API routing.
- Group existing components by place without changing their operations.
- Mount only the active place.
- Keep a temporary “long page” escape hatch during migration.
- Establish app-owned history entries and focus return for place, row detail,
  range mode, sheet, and Reader.

### Stage 2 — responsive workbench regions

- Move Notebook into wide Query rail and compact Query sheet/key.
- Move current passage and pins into the governed Evidence
  line/sheet/strip/margin component.
- Make reader replace regions at its three widths.
- Add safe-area, dynamic-viewport, and virtual-keyboard handling.

### Stage 3 — compact Trends and Concordance

- Implement compact geometry for the existing series/by-book modes.
- Keep mode, focused document, and the delivered chapter-mark toggle together
  in Trends and preserve the complete trend-view record across transforms.
- Implement explicit touch range mode, 44-pixel handles, and the dedicated
  occurrence stepper while retaining the dense barcode as macro ink.
- Give Concordance the full plate and its shared context port with locked node
  alignment.
- Add the protocol-supported L1/R1/R2 sort control and rendered-context trim,
  with explicit re-query if a future control widens served context.
- Add mobile Chromium/WebKit browser acceptance and scroll-trap assertions.

### Stage 4 — Corpus and Vocabulary

- Decompose the current Project panel: put project creation/opening and source
  repair with Catalog, Structure, inventory, and book sheet in Corpus.
- Ship empty-corpus three-action onboarding.
- Keep complete per-book statistics in Corpus; split per-type/per-section
  Vocabulary surfaces from the current dashboard and link focused slices
  rather than duplicating ownership.
- Add compact vocabulary row detail; defer its distribution index until the
  frequency contract supplies a bounded per-book vector.

### Stage 5 — Compare and Findings

- Move keyness into Compare with the shared signed axis, plus optional wide
  numeric tables.
- Replace the delivered per-side sort-field/page-size controls with the one
  shared sort field and page size that `keyness-view/1` persists; retain
  per-side direction and page offset, and verify save/reload round-tripping.
- Route side evidence to the governed Evidence surface.
- Split ResearchPanel into margin/sheet evidence actions and Findings; put
  research/project save status, rather than project opening, in
  Findings.
- Add the current-state method/provenance register and visible `n of 8 pinned` capacity state,
  including **manage pins** routing from every at-cap entry point.
- Add full share-preview and conflict compact flows.

### Stage 6 — removal and hardening

- Complete keyboard, screen-reader, zoom, reduced-motion, orientation, and
  suspension acceptance.
- Run full functional Playwright, mobile WebKit/Chromium journeys, serial
  benchmarks, production build, and bundle contract.
- Delete the long-page escape hatch only after every delivered surface has a
  canonical place and cross-device journey.

## Completion criteria

The workbench redesign is complete only when:

1. all six places are directly findable on every supported presentation;
2. Scope, active place, Queries, Evidence, and Method always have governed
   access;
3. phone users can complete every research journey above without a desktop;
4. focus and scope are visibly and behaviorally distinct;
5. Compare’s scope exception cannot be missed;
6. every mark still reaches exact passage evidence;
7. no compact display changes analytical semantics or hides exact values;
8. no supported viewport has body horizontal overflow or a chart scroll trap;
9. Back, focus return, rotation, zoom, and virtual keyboard behavior pass;
10. local-first persistence, sharing, bundle, performance, and cancellation
    gates remain green.
