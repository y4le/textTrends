# Continuous Reader and the document Atlas

**Status:** implemented; reading-cursor and Speed-entry amendment shipped
**Date:** 2026-09-01
**Scope:** Reader product model, document comparison, navigation, state,
rendering architecture, accessibility, performance gates, and delivery plan

**Accepted amendment, pending implementation:** compact/regular Read will
replace the persistent header, ruler, page/reference row, and analytical footer
with the bar, controls sheet, and dedicated progress rail defined in
[reader-chrome-spike.md](reader-chrome-spike.md). Until those implementation
commits land, the layout and acceptance clauses below continue to describe the
shipped Reader.

## Summary

TextTrends should have one full-viewport Reader with two semantic scales:

- **Read** presents authenticated, selectable prose at a stable reading
  measure.
- **Atlas** places complete text extents next to one another as categorical
  columns, with shown terms painted at their within-text positions.

The same exact `{ document, token }` position connects the scales. In Read, a
person may also tap a source word to move the visible reading cursor before
starting Speed reading. A person can move from evidence to prose, pull back to
compare term distribution across
texts, pan horizontally when the corpus is wider than the viewport, choose a
new position, and return to prose without creating a second reading cursor.

Atlas is the principled form of the original pannable and zoomable proposal. It
keeps the useful spatial comparison while rejecting a free two-dimensional
page canvas:

- the sources do not contain stable printed pages;
- arbitrary zoom produces unreadable microtext rather than another useful
  representation;
- horizontal movement has meaning between declared texts, not inside prose;
- complete source text cannot safely remain in the DOM; and
- bitmap prose would break selection, copy, native find, and accessibility.

Atlas therefore contains occurrence and density evidence, document extent,
position, and identity—never fake pages or decorative source texture. It is a
comparison instrument, not tiny prose.

## Product decision

### One Reader, two named scales

Read and Atlas live in the existing governed Reader layer. They are not
workbench places, nested dialogs, or browser-history entries. Back and Escape
close Reader from either scale. `Ctrl+O` and `Ctrl+I` continue to own the
session-only reading-position history.

There is no Overview scale and no Flow scale. “Overview” already names a
different Trends concept in this product, while Flow adds a third state without
a source-authored boundary. The Reader vocabulary is exactly **Read** and
**Atlas**.

Scale changes are semantic re-projections, not literal camera dollies. Motion
may provide a short continuity cue, but it is bounded, interruptible, and
removed under reduced motion. No transition animates through intervening
texts.

### The two axes are meaningful

In Atlas:

- x is categorical declared document order; and
- y is the document-local token position.

Horizontal pan and snap are available only on the document ruler and Atlas.
Read never intercepts a horizontal gesture: prose remains a stable vertical
reading surface with the current screenful controls and edge taps.

The Atlas is allowed to overflow horizontally because adjacency itself is the
comparison. At two or a handful of texts, columns should sit together for
immediate inspection. At a 66- or 256-text corpus, the same layout becomes a
bounded, snapping horizontal strip rather than squeezing columns into
meaninglessness.

### Full extent does not mean full text residency

Every Atlas column represents the complete authenticated token extent of one
text. It does not render the complete source string. The visible marks come
from the same full-corpus occurrence authority as Trends, Matches, the footer,
and Reader highlights.

Read continues to render real source DOM. During the first Atlas programme it
retains the proven browser-fitted page transport. Continuous prose is a later
substitution of that transport, not a prerequisite for Atlas and not something
the Atlas should quietly smuggle in.

## Experience model

```text
READ
┌────────────────────────────────────────────────────────────────────┐
│ Pride and Prejudice                         Read | Atlas  help back │
├────────────────────────────────────────────────────────────────────┤
│ ‹ text 1   [ Pride and Prejudice · 42% ]   text 3 ›                │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│          It is a truth universally acknowledged, that a            │
│          single [man] in possession of a good [fortune]…           │
│                                                                    │
├────────────────────────────────────────────────────────────────────┤
│ previous reference  ← screenful      screenful →  next reference  │
├────────────────────────────────────────────────────────────────────┤
│ Terms · all-text trend · progress · dispersion (existing footer)  │
└────────────────────────────────────────────────────────────────────┘

ATLAS — Equal
┌────────────────────────────────────────────────────────────────────┐
│ Pride and Prejudice                         Read | Atlas  help back │
├────────────────────────────────────────────────────────────────────┤
│ ‹ [Pride and Prejudice] [Persuasion] [Emma] [Sense…] ›             │
│                                             Equal | To scale       │
├────────────────────────────────────────────────────────────────────┤
│   Pride and       Persuasion          Emma           Sense and     │
│   Prejudice                                           Sensibility  │
│  ┌─────────┐     ┌─────────┐       ┌─────────┐      ┌─────────┐    │
│  │  ▌  ▌   │     │ ▌       │       │   ▌ ▌   │      │ ▓▓      │    │
│  │    ━━━  │     │   ▌     │       │ ▌       │      │   ▓▓    │    │
│  │ ▌       │     │      ▌  │       │      ▌  │      │ ▓       │    │
│  │   ▌   ▌ │     │ ▌       │       │ ▌  ▌    │      │     ▓▓  │    │
│  └─────────┘     └─────────┘       └─────────┘      └─────────┘    │
│  122k tokens      84k tokens        158k tokens     110k tokens    │
├────────────────────────────────────────────────────────────────────┤
│ Terms · all-text trend · progress · dispersion (unchanged)        │
└────────────────────────────────────────────────────────────────────┘
```

The ruler is contextual, not a second minimap. In Read it communicates the
active text, within-text position, and dedicated previous/next-text movement.
In Atlas it becomes the categorical text axis and keeps the active column in
view. The footer remains the corpus-wide concatenated-token axis and the
visible query key. These are different projections of one occurrence
authority.

## Position and state contract

### One token-authored position

The active position is snapshot-bound and exact even when its semantic origin
is approximate:

```ts
interface ReaderPosition {
  readonly snapshot: string;
  readonly doc: string;
  readonly token: number;
  readonly anchor: 'occurrence' | 'position';
}

type ReaderScale = 'read' | 'atlas';
type AtlasNormalization = 'equal' | 'to-scale';
```

`anchor` describes the evidence claim, not numeric precision:

- `occurrence` means a real shared-cache occurrence was selected; and
- `position` means a raw location or density bucket midpoint was selected.

A density bucket can supply an exact numeric midpoint while remaining an
approximate evidential destination. Reader and Matches must never relabel it as
an occurrence.

The existing Reader layer target remains the durable identity within the open
layer. The shared `scrub` cursor remains the single published reading position.
`readerCursorToken` is a narrow Read presentation cursor used to render the
selected source word and choose Speed's start token; setting it also publishes
the same token to `scrub`, so it is not an independent analytical position.
Atlas retains it only while the authenticated Read page is resident. Pixel
scroll offsets, column mount windows, canvas dimensions, and animation progress
are component state only.

Scale is transient presentation state and is not written to workspace or
browser history. External occurrence evidence always opens or retargets exact
Read; raw and density-derived positions open Read without an occurrence claim.
Atlas normalization is a separate device-local preference with **Equal** as
its default; it must use its own versioned storage record rather than extending
the strict `texttrends/display/1` schema. It deliberately does not mutate the
workspace-owned Trends view: the labels share an analytical vocabulary, while
the Atlas choice controls the legibility of one device's spatial presentation
and remains visible whenever Atlas is open.

### State transitions

| Intent | Destination | Exactness | Scale after action |
| --- | --- | --- | --- |
| Matches row, Find hit, exact barcode mark | requested text/token | occurrence | Read |
| Raw footer position or density bucket | requested text/token | position | Read |
| Read → Atlas | current active text/token | preserved | Atlas |
| Atlas → Read control or Enter | active text/token | preserved | Read |
| Atlas exact mark activation | mark text/token | occurrence | Read |
| Atlas density band activation | bucket midpoint | position | Read |
| Atlas body click/tap | nearest valid token | position | remain Atlas |
| `w` / `b` | previous/next exact shown-term occurrence | occurrence | preserve scale |
| previous/next text | same relative position in adjacent text | position | preserve scale |
| Home / End | real active-text boundary | position | preserve scale |
| visible Speed entry | selected/authenticated Read token | preserved; starts paused | RSVP from Read only |
| Shift+S entry | selected/authenticated Read token | preserved; starts playing unless reduced motion | RSVP from Read only |

A column body click selects and stays in Atlas so a person can compare before
committing. Double activation or Enter descends to Read at that position.
Exact visible marks may descend directly because their evidence claim is
unambiguous.

Previous and next text are dedicated actions and visible controls. At Read they
do not repurpose screenful keys. `[` and `]` are the proposed Reader shortcuts;
the central shortcut registry, Help, and `aria-keyshortcuts` are the only
authority.
The target token preserves relative position:

```text
target = round((current token / max(1, current text tokens - 1))
               * max(0, target text tokens - 1))
```

The result is explicitly a position, not an occurrence. Empty texts are
skipped. At corpus edges the control reports the edge without moving.

### Existing reading behavior remains stable

At Read scale, `h`, `l`, Left, Right, Page Up, Page Down, and coarse-pointer
edge taps retain browser-fitted screenful navigation. Home and End retain real
text boundaries. `w` and `b` retain exact full-corpus occurrence stepping.
At a text edge, fitted screenful navigation retains its existing rollover: a
forward turn enters the next readable text at its start, while a backward turn
enters the prior text on its last fitted page. That boundary landing is
deliberately different from the relative-position previous/next-text command.

Switching to Atlas does not issue a Reader source query. Returning to Read may
reuse the still-authenticated resident page when it covers the active token;
otherwise it requests the normal bounded `reader-page/1` slice around that
token. No Atlas action weakens snapshot or matching-identity guards.

## Ruler contract

The Read ruler appears for one or more ready texts because it now owns the
visible Speed entrance as well as position. Previous/next-text controls and the
text ordinal appear only when at least two ready texts are available. The
Read/Atlas scale control likewise appears only when Atlas is available. Atlas
remains a comparison instrument, so a one-text corpus stays in Read. The scale
control has one home in the persistent Reader header. The ruler occupies a
stable chrome band between that header and content.

At Read scale it shows:

- previous and next text controls;
- the active title, ordinal, token count, and percentage;
- a thin within-text position indicator; and
- a visible Speed control that enters paused at the selected/current token.

At Atlas scale it shows:

- declared-order text buttons with capped, ellipsized visible titles and full
  accessible names;
- one roving tab stop, owned by the active text;
- horizontal drag/scroll and proximity snap;
- the Equal/To scale control; and
- active-text scroll-into-view after keyboard or occurrence movement.

Arrow keys inside the focused ruler move ruler focus; Enter activates the
focused text at the current relative position. The global `[` and `]` commands
move immediately. Focus movement alone never publishes the shared cursor.

The 320 CSS-pixel layout may collapse visible titles to identity and ordinal,
but it must not remove the header scale control, previous/next text access,
Back, or the compressed analytical footer. In a short viewport the ruler first
drops secondary metadata and its scrolling title list, then becomes one compact
active-identity band with previous/next controls. Its targets follow the
existing height-qualified policy, except Reader ruler controls now retain a
44px block target in compact and short viewports so the Speed entrance remains
touchable. Analytical content and the footer's separate density-specific target
ladder remain unchanged.

## Atlas geometry and normalization

### Equal — rate comparison

Equal is the default. Every nonempty text receives the same visual height and
maps its own range `[0, docTokenCount)` to the full column. The same vertical
fraction therefore means the same relative position. This is the document
analogue of the existing equal-scale Trends presentation.

Equal answers: “where in each text does this term tend to appear?”

### To scale — count comparison

To scale uses one shared vertical domain `[0, maxDocTokenCount)`. Shorter texts
end early and leave an explicit empty tail. A pointer in that tail has no token
target. Token counts remain printed beneath titles so the height difference is
legible rather than decorative.

To scale answers: “where are these occurrences in comparable token units, and
how long are the texts?”

There is no Combined Atlas mode. Combined is a concatenated corpus projection;
the existing footer already supplies it. Adding it to the Atlas would erase the
side-by-side comparison that justifies the surface.

### Column layout

Column width has a legible minimum and a bounded comfortable maximum. A small
corpus expands columns only until comparison is comfortable; a large corpus
overflows the Atlas scroller. CSS scroll snap aligns document boundaries.

Do not allocate one corpus-wide canvas. At the 256-text ingest cap its bitmap
would exceed practical browser dimensions. Render lightweight DOM column
shells for the declared order, and allocate DPR-aware canvases only for the
visible range plus bounded overscan. Focused and active columns remain mounted.

The canvas backing size follows `cssSize × devicePixelRatio`; drawing geometry
is snapped to device pixels. Theme and series-style changes repaint resident
canvases without querying analysis.

## Highlight and interaction contract

### One occurrence authority

Atlas consumes the resident full-corpus `dispersion/1` result. It never
rematches prose and never issues a query during resize, pan, normalization, or
scale changes.

The current pipeline already provides, per shown track:

- exact CSR `docOffsets`, document-local `starts`, and `spanTokens` at or below
  50,000 occurrences; or
- honest density `counts` over shared document-local bucket geometry above
  that threshold.

`barcodeTracks` already projects those arrays into per-document token-space
segments, and `projectedBarcodeTracks` already caches the projection by
resident result identity. Its input order is the dispersion CSR axis and must
remain exactly `snapshot.readyDocs`, because that is the selection order used
by the worker. Atlas first projects on that axis, then maps declared-order
columns to `segmentsByDocOrdinal` by document identity. It never passes declared
order into `barcodeTracks`; doing so could silently move every occurrence into
the wrong column. The painter and hit tester reuse this identity-safe projection
and the established snap authority rather than fork the meaning of a token or
occurrence.

Representation is selected per track across the whole corpus, never per
column. A term therefore cannot be exact in one text and silently become
density in another.

### Visual encoding

Each shown term owns a narrow vertical rail within every text column, using the
same authored series color and style vocabulary as the rest of the product.
Exact occurrences paint as token-position ticks with their true span. Density
paints as counted bands whose opacity is count-derived. Empty buckets paint
nothing.

Exact vectors may contain more marks than the device has distinguishable rows.
Painting therefore accumulates into device rows with a bounded, sum-preserving
projection instead of issuing tens of thousands of canvas calls. The source
representation remains exact; the visual disclosure says when marks are
compressed. Exact pointer targets are offered only while the painted ticks are
distinguishable. Otherwise activation selects a position and does not fabricate
an occurrence.

The worker's 4,096 density-bucket budget is shared token-proportionally across
the corpus. Approximate resolution is about 2,048, 205, 62, and 16 bands per
text for 2, 20, 66, and 256 **similarly sized** texts, but real corpora can be
far more uneven. In the shipped 66-text Bible, short texts receive about three
bands while the longest receive more than 200. Equal makes both columns full
height; To scale makes the shortest extents only a few pixels. The modes answer
different questions, and neither creates missing resolution.

Density disclosure is therefore per column and per density track, not one
global number. A coarse rail names its actual band count and exact transported
total in visible or accessible text. Eight to twelve bands are labelled
“coarse density”; below an eight-band legibility floor the rail also uses a
plainly hatched “very coarse density” treatment rather than large blocks that
imply precision. The column stays navigable, but a density band remains an
approximate position and never an occurrence.

This is acceptable for a disclosed first Atlas only if the canonical Bible and
Quran comparisons remain useful in direct testing; density applies only above
50,000 corpus occurrences, but its uneven resolution is an explicit product
gate. If those corpora fail, stop and design a bounded windowed `atlas/1`
projection. Do not widen, interpolate, or invent detail on the main thread.

### Pointer and keyboard

- Horizontal wheel/trackpad motion scrolls the ruler or Atlas only.
- Vertical wheel input moves the active position within the active Atlas text;
  it never scrolls the outer page.
- One-finger horizontal touch drag pans Atlas; ordinary touch tap selects.
- Browser pinch and `Ctrl/Cmd`+wheel remain browser zoom.
- Pinch-to-change-scale is not part of the first implementation.
- Atlas exposes one focusable control, not thousands of occurrence targets.
- Left/Right select adjacent texts; Up/Down move a small relative step;
  Page Up/Page Down move a larger relative step; Home/End choose true text
  bounds; Enter descends to Read.
- `w` and `b` provide exact keyboard evidence walking at both scales.

Hover may expose a local label but never publishes the shared cursor. Only a
committed active-column position may move `scrub`, the footer, Matches, or
position history.

Left/Right are scale-dependent only because Atlas has no prose screenful. At
Read they remain screenful keys; at Atlas they operate the categorical x-axis.
The dedicated `[`/`]` text commands retain one meaning at both scales. Reader
shortcut help therefore gains the current scale as an input and shows only the
truthful scale-specific labels and bindings.

## Resident data and query lifecycle

Atlas has no dedicated analysis query lifecycle in the first implementation.

The store already issues one full-ready-corpus `dispersion/1` request for all
active tracks with the trend burst. Find owns the equivalent single-track
dispersion result. Atlas chooses the same effective projection as Reader:

- ordinary interaction: full-corpus `state.dispersion` in current series order;
- Find: `interaction.find.dispersion` and the Find series only; and
- linked range: ignored for the base Atlas, because a transient selection must
  not narrow the meaning of complete text columns.

Document extents come from the existing `corpusTokenCounts` /
`corpusInventory` resolution path. Declared column order comes from project
order filtered by ready snapshot membership, with the existing ready-order
fallback; mark projection remains on the independent `snapshot.readyDocs` CSR
axis and joins columns by document id.

The invariant is directional and testable: Read → Atlas, changing
normalization, resizing, hovering, and horizontally panning post **zero worker
queries**. Atlas never issues trend, dispersion, or inventory analysis for its
own presentation. Atlas → Read may issue the ordinary bounded `reader-page/1`
source request when the active token is outside the retained page; that fetch
is required for authenticated prose and is not an Atlas analysis lane.

Committing an Atlas position also updates the shared footer. When the retained
footer passage does not cover it, the existing latest-pending, single-flight
footer-passage lane may issue `reader-page/1`. Hover and horizontal pan never do
this. Wheel and repeated-key position movement are frame-coalesced, publish one
settled position/announcement, and feed only that established bounded lane.

Atlas exploration uses the existing `reader` position-history origin and the
continuous-settle path, not a new history type. Repeated column/body selections
amend one provisional tail after the 400ms quiet period; they do not append one
jump per column. Exact occurrence activation or descent to Read hardens the
settled destination through the existing discrete-jump contract. None of this
enters browser history.

No active terms is a first-class state. Atlas still shows text extents and the
active position with “No terms shown.” Reading and text navigation never depend
on notebook contents.

## Read transport and the continuous programme

### Why continuous Read is separate

The current `reader-page/1` result supplies authenticated paragraph and
sentence boundaries only for a bounded resident slice. A continuous reader
needs a document-scale height index, stable bidirectional source windows,
measurement compensation above the anchor, focus pinning, and faithful
selection across window seams. Whether the worker must expose a small
paragraph outline remains an unresolved source-data decision.

That work replaces rather than extends:

- the browser page fitter;
- the bounded `readerWalk` boundary list;
- fitted previous/next navigation;
- edge-tap geometry; and
- much of the Reader, RSVP, resize, and position-history browser contract.

It must not be folded into the additive Atlas programme.

### Continuous Read gate

Continuous Read begins only after:

1. Atlas has shipped and proven the shared token-authored position;
2. a paragraph-outline versus estimated-height decision is recorded;
3. deep-jump, resize-anchor, memory-residency, and long-task baselines exist;
4. cross-window selection and native find behavior have an acceptance plan;
5. the fitted Reader remains available until the substitute passes its complete
   functional, accessibility, compact, and performance suite.

The eventual transport uses bounded source windows keyed by snapshot, text,
token range, and captured track identity. It fetches the destination first,
deduplicates overlap, evicts distant unfocused windows, and compensates height
corrections above the exact anchor. Pixel offsets never become durable state.

## Reference prose is later and asymmetric

The user value behind side-by-side prose is real, but it follows continuous
Read and a residency benchmark. A future wide-screen reference presentation
may show an active text beside one referenced text when two 32em measures fit.

It is deliberately asymmetric:

- only the active text publishes the cursor and owns navigation;
- the reference never moves the active position;
- scrolling is not locked;
- explicit “align at this same term” may create an exact comparison; and
- standard and compact layouts remain single-column.

Reference prose is not part of the initial Atlas implementation and does not
justify loading a second fitted source page today.

## Loading, staleness, and failure

- **Dispersion pending:** column identity, extents, and active position remain;
  mark rails show a bounded loading state. Old marks never appear under a new
  snapshot or track identity.
- **Dispersion failure:** navigation and Read remain available; Atlas says term
  distribution is unavailable and offers the existing analysis retry path.
- **Density:** every affected column names each track's actual band resolution
  and total; eight to twelve bands say “coarse density,” and below eight bands
  say “very coarse density.” A bucket is never named as an occurrence.
- **Missing token extents:** the affected column is unavailable rather than
  assigned a fabricated length.
- **Snapshot replacement:** scale may remain, but active text/token and every
  mark projection are revalidated. Invalid Reader layers close through the
  current governed path.
- **Worker restart:** authenticated same-snapshot columns may remain frozen and
  nonactionable; new-snapshot evidence never mixes with them.
- **Out-of-order delivery:** existing snapshot and track-identity leases remain
  the authority. Atlas owns no bypass.

## Accessibility and responsive behavior

At Read, the source remains linear selectable DOM with native copy and find.
Existing highlighted occurrences retain their names and provenance.

At Atlas:

- the entire plane is one keyboard control with a concise description of
  active title, ordinal, token/percentage, normalization, shown terms, and
  exact or density status;
- each committed column description includes per-shown-term exact totals or
  density totals and actual band counts, so distribution comparison has a
  non-visual reading rather than only a route to individual occurrences;
- the document ruler uses roving focus rather than placing every title in the
  Tab order;
- term pixels and density bands are not individual focus targets;
- exact `w`/`b`, ruler navigation, and Enter-to-Read provide equivalent source
  access;
- one polite live region announces committed text/position/scale changes; and
- switching scale moves focus to the destination surface, never an unmounted
  canvas or `body`.

All animation becomes an immediate state change under reduced motion. Smooth
scroll-into-view is disabled, while the layout-neutral destination underline
and background remain. Font-weight emphasis remains excluded because it can
change Reader layout.

The complete surface must retain the existing 320 CSS-pixel floor, safe-area
handling, height-qualified short-viewport control policy, coarse-pointer target
ladder, and no page-level horizontal overflow. Atlas overflow belongs to its
named scroller, not the document.

## Execution plan and commit boundaries

Every implementation commit is staged with exact paths, previewed, reviewed by
the pinned Opus reviewer, corrected, tested, and only then committed. A review
never includes unrelated workspace changes.

### 1. Record the unified contract

Rewrite this document. Review for removed Overview/Flow/texture claims,
truthful staging, footer/Atlas distinction, density disclosure, and explicit
continuous-Read gates.

### 2. Extract declared ready-text order

Move the existing declared-order, ready-membership, fallback-order, and
zero-token-skip policy out of the store into a pure module. Unit-test it and
delegate the existing adjacent-text behavior without changing Reader.

### 3. Make anchor and scale policy explicit

Add the occurrence-versus-position claim, scale vocabulary, normalization
preference, entry policy, and scale-preserving retarget policy in pure modules
and state actions. Audit every Reader entrance. Existing external entrances
must default to Read; internal `w`/`b` and history moves preserve scale.

### 4. Add the contextual ruler

Build the conditional ruler, dedicated previous/next-text controls and `[`/`]`
shortcuts, relative-position transfer, roving focus, compact fallback, and
stable scroll-into-view. Preserve current screenful and reference controls.

### 5. Prove Atlas data gates and build pure projection

Before rendering:

- prove expected density bands per text at 2/20/66/256 similarly sized texts
  **and** across the shipped uneven Bible and Quran corpora both separately and
  loaded together, including each configuration's minimum/median/maximum bands
  per text and counts at/below the coarse thresholds;
- assert dispersion is resident and snapshot-matched when Reader opens;
- assert Read → Atlas posts zero worker queries, Atlas presentation changes
  post no analysis queries, and Atlas → Read issues only the expected source
  request when the resident page does not cover the target; and
- unit-test Equal/To scale math, empty-tail rejection, device-row accumulation,
  sum preservation, mount-window bounds, and transposed hit testing.

If density or residency fails the written gates, stop before UI work.

### 6. Render the Atlas

Add the horizontally snapping column strip, bounded visible canvas window,
active position, scale and normalization controls, exact/approximate descent,
loading/error/no-term states, live theme repaint, and focused-column retention.

### 7. Complete input and accessibility

Add one-control keyboard operation, focus handoff, scale-aware Reader Help,
reduced-motion behavior, RSVP refusal outside Read, touch scroll/tap
differentiation, and non-chatty settled announcements.

### 8. Verify and record what shipped

Run the full unit/type/build suite and functional plus compact WebKit Reader
regressions. Add a dated product-decision entry and update the roadmap only for
features that actually shipped, including review request and receipt ids.

## Acceptance gates

### Source and navigation

- Read ↔ Atlas ↔ Read preserves the same snapshot, text, and token.
- Read → Atlas, normalization, resize, hover, and pan issue zero worker
  queries. Atlas → Read may issue only the ordinary authenticated source fetch;
  committed Atlas positions may use the existing bounded footer-passage lane.
- Exact Atlas marks descend as occurrences; density and body positions do not.
- `w`/`b` remain exact full-corpus navigation and preserve scale.
- `[`/`]` follow declared ready-text order at relative positions.
- External occurrence evidence enters exact Read; raw/density positions retain
  their position claim.
- Back/Escape and `Ctrl+O`/`Ctrl+I` retain current ownership.
- Read prose taps update the exact cursor without a worker query or page turn;
  native selection and blank-gutter paging keep their existing ownership.
- RSVP can be entered only from authenticated Read, starts at the explicit
  cursor when present, and returns to the same visible token.

### Visual truth

- Equal gives equal-height relative-position columns.
- To scale uses a shared token domain and rejects the empty tail.
- Every exact occurrence span or density count comes from resident
  snapshot-matched analysis.
- Density band sums remain the exact transported totals.
- One track uses one representation across all columns.
- Density resolution and totals are disclosed per column/track; eight to
  twelve bands say “coarse density” and fewer than eight receive the “very
  coarse density” treatment.
- No terms, pending, error, and coarse density are visibly distinct.

### Corpus size and performance

- 2 and 20 texts compare without forced document-level compression.
- 66 and 256 texts scroll and snap with a bounded canvas mount count.
- The Bible and Quran fixtures, separately and loaded together, report useful,
  truthful min/median/max density resolution and coarse-column counts under
  both normalizations before Atlas ships.
- 66 texts × five exact tracks record Atlas-attributable tasks from 50 ms and
  gate at the repository's existing 100 ms long-task failure threshold during
  first paint or a horizontal fling.
- DPR changes, theme changes, and resize repaint without queries or stale ink.
- No canvas dimension depends on total corpus width.

### Accessibility and viewport

- Atlas contributes one Tab stop; the ruler contributes one roving Tab stop.
- Every pointer action has a visible keyboard path.
- Focus survives scale changes and column virtualization.
- Live announcements name committed changes once.
- Browser zoom is never intercepted.
- 320px WebKit has no page-level overflow and retains ruler, scale, Back, and
  the compressed footer.
- Reader ruler and Speed controls remain at least 44 CSS pixels in compact and
  short viewports.

### Regression

- Existing Reader page fitting, edge taps, source selection, highlighted
  provenance, Find, RSVP, position history, worker restart, and footer tests
  remain green with Read as the entry scale.
- Existing cross-text fitted-page rollover keeps its start/last-page boundary
  semantics and remains distinct from relative-position text stepping.
- No test is made green by deleting an existing behavior assertion.

## Stop and re-plan conditions

Stop at a commit boundary if:

1. the 4,096-bucket density projection is not honestly useful on the uneven
   Bible and Quran fixtures separately or loaded together, even with
   per-column coarse disclosure;
2. Read → Atlas or Atlas presentation requires a worker query, or Atlas needs
   a dedicated analysis lane rather than the named source-fetch exemptions;
3. existing barcode token/snap authority cannot be generalized without a
   second implementation;
4. canvas mount-window reduction still produces Atlas-attributable 100ms long
   tasks;
5. ruler plus footer cannot meet the 320px contract;
6. snapshot or track-identity fencing would need a weaker exception;
7. source texture, Flow, Combined Atlas, per-pixel focus targets, or camera
   history re-enters the design; or
8. continuous Read work becomes urgent before its data contract is decided.

The fallback for failed density resolution is a separately reviewed bounded
`atlas/1` operation over a visible document window, with pinned rows per text,
fresh transferable arrays, normal query-lane cancellation, and a small
main-thread LRU. It is not pre-implemented “just in case.”

## Non-goals

- A two-dimensional infinite canvas.
- Free horizontal pan inside prose.
- Arbitrary continuous zoom or pinch interception.
- Microscopic source text, source texture, or bitmap prose.
- Synthetic page rectangles, numbers, counts, or printed-page claims.
- A Flow or Combined Atlas scale.
- A duplicate term legend or corpus minimap.
- Per-mark DOM or accessibility targets in Atlas.
- A Reader-local term filter or intensity control.
- Camera movements in browser history or workspace state.
- Continuous Read in the initial Atlas programme.
- Two-column reference prose before continuous Read and a residency benchmark.
- A new pan/zoom or chart dependency before code-native geometry proves
  insufficient.

## Collaboration provenance

This contract was synthesized by the primary Codex agent after repository
inspection and iterative read-only consultations with an explicitly pinned
Claude Opus planner through Parley. Opus materially changed the proposal in
three ways: document comparison replaced a current-text Overview, source
texture and Flow were removed, and Atlas moved ahead of continuous prose once
that dependency disappeared.

The implementation plan was grounded in the current store, Reader, dispersion,
barcode, shortcut, layer/history, responsive, and test architecture.

- Holistic product consultation: `req_consult_00b5a832cfc582d4`
- Execution architecture consultation: `req_consult_e80609919b55dfd9`
- Execution architecture artifact:
  `art_sha256_2a3b060638e624f2d23eed5dba6c5662208858d230c11987f5402859a0a71494`
